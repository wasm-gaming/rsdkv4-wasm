#!/usr/bin/env bash
set -euo pipefail

# Builds a GAME-AGNOSTIC RSDKv4 WASM. This script does NOT invoke Docker itself —
# it runs the build steps directly and expects an Emscripten SDK environment on
# PATH (emcc, make, git, python3, perl). Run it either:
#   - in CI, inside an `emscripten/emsdk` container job (see .github/workflows), or
#   - locally, via scripts/build-docker.sh (which runs this inside the container).
#
# Unlike the original per-game build, Data.rsdk / settings.ini are NOT baked in
# with --preload-file. The engine is built with -sINVOKE_RUN=0 and the FS/callMain
# runtime methods exported, so the JS SDK (src/rsdkv4.sdk.ts) writes the game data
# into the filesystem at runtime and then calls main(). One rsdkv4.wasm → Sonic 1
# AND Sonic 2.
#
# Filesystem: built with -sWASMFS (Emscripten's modern filesystem, not MEMFS). A
# small OPFS-mount helper (WebFS.cpp) lets the SDK back the game working dir with
# OPFS for persistence. NOTE: WASMFS's OPFS backend spawns a proxy worker, which it
# refuses to do from the main browser thread unless the build has ASYNCIFY or JSPI.
# The SDK mounts by calling into the module from the page (i.e. on the main thread),
# so with this build (single-threaded, no Asyncify) OPFS reports unsupported and the
# SDK uses the in-memory WASMFS backend. Enabling it means either -sASYNCIFY/-sJSPI
# here, or -pthread + doing the mount from the engine thread (interacts with SDL2 +
# emscripten_set_main_loop) — VERIFY with a real build before relying on it.
#
# Output: dist/rsdkv4/rsdkv4.js (ES6 factory, EXPORT_NAME=createRSDKv4) +
# dist/rsdkv4/rsdkv4.wasm. In CI these are attached to a GitHub Release.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$ROOT_DIR/.tmp/rsdkv4-wasm-build"
DIST_DIR="$ROOT_DIR/dist"

echo "Setting up workspace..."
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR" "$DIST_DIR"

echo "Cloning Sonic-Decompilation-WASM repository..."
git clone --depth=1 https://github.com/mattConn/Sonic-Decompilation-WASM.git "$WORK_DIR"

echo "Patching Makefile: runtime FS load (no --preload-file), WASMFS, modularized ES6 output..."
# - Drop the game-data preload; bump memory/stack as before.
# - INVOKE_RUN=0 + exported callMain/FS/ccall so the SDK mounts data before main().
# - WASMFS: modern filesystem (replaces MEMFS) + enables the OPFS backend used by
#   WebFS.cpp / web_mount_opfs.
# - MODULARIZE + EXPORT_ES6 so the SDK can `import createRSDKv4 from './rsdkv4.js'`.
# - Emit rsdkv4.js instead of index.html.
sed -i.bak \
  -e 's#-s TOTAL_MEMORY=60MB -s ALLOW_MEMORY_GROWTH=1#-s TOTAL_MEMORY=268435456 -s STACK_SIZE=5242880 -s INVOKE_RUN=0 -s WASMFS -s FORCE_FILESYSTEM=1 -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=createRSDKv4 -s "EXPORTED_RUNTIME_METHODS=[\x27callMain\x27,\x27FS\x27,\x27ccall\x27,\x27cwrap\x27]"#g' \
  -e 's#--preload-file Data.rsdk##g' \
  -e 's#wasm/index\.html#wasm/rsdkv4.js#g' \
  "$WORK_DIR/Makefile"

echo "Adding WebFS.cpp (OPFS-backed working dir helper for WASMFS)..."
cat << 'EOF' > "$WORK_DIR/RSDKv4/WebFS.cpp"
// Mounts an OPFS-backed directory at `path` under WASMFS, so the SDK can persist
// the game working dir (Data.rsdk / settings.ini) across reloads. Returns 0 on
// success. Requires -sWASMFS. OPFS sync access needs a worker/pthread environment
// + cross-origin isolation; on failure the SDK falls back to the default in-memory
// WASMFS backend, so callers must tolerate a non-zero return.
#include <emscripten/wasmfs.h>
#include <emscripten/emscripten.h>
#include <emscripten/threading.h>

// wasmfs_create_opfs_backend() spawns a proxy worker synchronously, which it
// cannot do from the main browser thread unless the build has Asyncify or JSPI —
// it *asserts* in that case, and a failed assert calls abort(), killing the whole
// module (no try/catch on the JS side can undo that). web_opfs_supported()
// mirrors the exact assertion condition (see emscripten's wasmfs/backends/
// opfs_backend.cpp) so the SDK can ask before it commits, and web_mount_opfs()
// re-checks so a direct caller gets -1 instead of a dead module.
extern "C" EMSCRIPTEN_KEEPALIVE
int web_opfs_supported(void)
{
    return !emscripten_is_main_browser_thread() || emscripten_has_asyncify();
}

extern "C" EMSCRIPTEN_KEEPALIVE
int web_mount_opfs(const char *path)
{
    if (!web_opfs_supported())
        return -1;

    backend_t opfs = wasmfs_create_opfs_backend();
    if (!opfs)
        return -1;
    return wasmfs_create_directory(path, 0777, opfs);
}
EOF

echo "Registering WebFS.cpp in the Makefile SOURCES list..."
python3 - "$WORK_DIR/Makefile" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

anchor = "          RSDKv4/Userdata.cpp      \\\n"
assert content.count(anchor) == 1, "expected exactly one Userdata.cpp SOURCES line"
content = content.replace(anchor, anchor + "          RSDKv4/WebFS.cpp        \\\n", 1)

with open(path, "w", encoding="utf-8") as f:
    f.write(content)
PYEOF

echo "Patching main.cpp to fix Emscripten initialization order..."
cat << 'EOF' > "$WORK_DIR/RSDKv4/main.cpp"
#include "RetroEngine.hpp"

#ifdef __EMSCRIPTEN__
#include "emscripten.h"

void main_loop()
{
    static bool init = false;
    if (!init) {
        Engine.Init();
        init = true;
    }
	Engine.Run();
}
#endif


int main(int argc, char *argv[])
{
    for (int i = 0; i < argc; ++i) {
        if (StrComp(argv[i], "UsingCWD"))
            usingCWD = true;
    }

    SDL_SetHint(SDL_HINT_WINRT_HANDLE_BACK_BUTTON, "1");
#ifdef __EMSCRIPTEN__
    SDL_Init(SDL_INIT_EVERYTHING);
	emscripten_set_main_loop(main_loop, 0, 1);
#else
    Engine.Init();
    Engine.Run();
#endif

    return 0;
}

#if RETRO_PLATFORM == RETRO_UWP
int __stdcall wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) { return SDL_WinRTRunApp(main, NULL); }
#endif
EOF

echo "Patching Audio.cpp to initialize audio explicitly..."
sed -i.bak 's/if ((audioDevice = SDL_OpenAudioDevice/SDL_InitSubSystem(SDL_INIT_AUDIO); if ((audioDevice = SDL_OpenAudioDevice/' "$WORK_DIR/RSDKv4/Audio.cpp"

echo "Patching Input.cpp to forcibly initialize controllers continuously with fallback mapping..."
perl -0777 -pi -e 's/void ProcessInput\(\)\n\{/void ProcessInput()\n{\n#if RETRO_USING_SDL2\n    for (int i = 0; i < SDL_NumJoysticks(); ++i) {\n        if (!SDL_GameControllerFromInstanceID(i)) {\n            if (!SDL_IsGameController(i)) {\n                char mapping[1024];\n                SDL_JoystickGUID guid = SDL_JoystickGetDeviceGUID(i);\n                char guid_str[33];\n                SDL_JoystickGetGUIDString(guid, guid_str, sizeof(guid_str));\n                snprintf(mapping, sizeof(mapping), "%s,Web Gamepad,a:b0,b:b1,x:b2,y:b3,back:b8,start:b9,leftstick:b10,rightstick:b11,leftshoulder:b4,rightshoulder:b5,dpup:b12,dpdown:b13,dpleft:b14,dpright:b15,leftx:a0,lefty:a1,rightx:a2,righty:a3,lefttrigger:b6,righttrigger:b7,", guid_str);\n                SDL_GameControllerAddMapping(mapping);\n            }\n            controllerInit(i);\n        }\n    }\n#endif/g' "$WORK_DIR/RSDKv4/Input.cpp"

echo "Adding WebDevMenu.cpp (embind bridge for the HTML dev-menu overlay)..."
cat << 'EOF' > "$WORK_DIR/RSDKv4/WebDevMenu.cpp"
// Bridges a subset of RSDKv4's native Dev Menu (normally opened via Escape,
// see RetroEngine.cpp's SDLK_ESCAPE handler and Debug.cpp's initDevMenu())
// to JS, so the SDK can replace the in-canvas menu screen with an HTML overlay.
#include "RetroEngine.hpp"
#include <emscripten/bind.h>
#include <sstream>

namespace {
std::string jsonEscape(const char *s)
{
    std::string out;
    for (const char *p = s; *p; ++p) {
        if (*p == '"' || *p == '\\')
            out += '\\';
        out += *p;
    }
    return out;
}
}

std::string web_devmenu_get_stage_list()
{
    std::ostringstream json;
    json << "[";
    for (int list = 0; list < STAGELIST_MAX; ++list) {
        if (list > 0)
            json << ",";
        json << "{\"name\":\"" << jsonEscape(stageListNames[list]) << "\",\"stages\":[";
        for (int i = 0; i < stageListCount[list]; ++i) {
            if (i > 0)
                json << ",";
            json << "{\"name\":\"" << jsonEscape(stageList[list][i].name) << "\"}";
        }
        json << "]}";
    }
    json << "]";
    return json.str();
}

void web_devmenu_load_stage(int listIdx, int stageIdx)
{
    if (listIdx < 0 || listIdx >= STAGELIST_MAX)
        return;
    if (stageIdx < 0 || stageIdx >= stageListCount[listIdx])
        return;

    activeStageList   = listIdx;
    stageListPosition = stageIdx;
    stageMode         = STAGEMODE_LOAD;
    Engine.gameMode   = ENGINE_MAINGAME;
    SetGlobalVariableByName("options.gameMode", 0);
    SetGlobalVariableByName("lampPostID", 0); // For S1
    SetGlobalVariableByName("starPostID", 0); // For S2
}

void web_devmenu_set_paused(bool paused)
{
    Engine.masterPaused = paused;
}

// --- audio ------------------------------------------------------------------
// masterPaused freezes the logic loop but not the audio callback, so pausing
// through the dev-menu bridge alone left music playing over the HTML overlay
// (and kept playing after the host tore the instance down).

void web_audio_set_paused(bool paused)
{
    if (paused)
        PauseSound();
    else
        ResumeSound();
}

void web_audio_stop()
{
    StopMusic();
    StopAllSfx();
}

EMSCRIPTEN_BINDINGS(web_devmenu)
{
    emscripten::function("web_devmenu_get_stage_list", &web_devmenu_get_stage_list);
    emscripten::function("web_devmenu_load_stage", &web_devmenu_load_stage);
    emscripten::function("web_devmenu_set_paused", &web_devmenu_set_paused);
    emscripten::function("web_audio_set_paused", &web_audio_set_paused);
    emscripten::function("web_audio_stop", &web_audio_stop);
}
EOF

echo "Registering WebDevMenu.cpp in the Makefile SOURCES list..."
python3 - "$WORK_DIR/Makefile" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

anchor = "          RSDKv4/Userdata.cpp      \\\n"
assert content.count(anchor) == 1, "expected exactly one Userdata.cpp SOURCES line"
content = content.replace(anchor, anchor + "          RSDKv4/WebDevMenu.cpp   \\\n", 1)

with open(path, "w", encoding="utf-8") as f:
    f.write(content)
PYEOF

echo "Adding WebGame.cpp (embind bridge for the HTML start-menu overlay)..."
cat << 'EOF' > "$WORK_DIR/RSDKv4/WebGame.cpp"
// Bridges RSDKv4's native Start Menu — Debug.cpp's STARTMENU_SAVESEL,
// STARTMENU_PLAYERSEL and STARTMENU_GAMEOPTS handlers — to JS, so a host can
// replace those in-canvas screens with its own UI.
//
// The save/player logic below mirrors Debug.cpp move for move: same globals, the
// same saveRAM layout, the same InitStartingStage() calls. A game started from
// HTML therefore lands in exactly the state the engine's own menu would produce.
#include "RetroEngine.hpp"
#include <emscripten/bind.h>
#include <sstream>
#include <string>

namespace {

// One save slot is 8 ints of saveRAM (Debug.cpp, STARTMENU_SAVESEL):
enum SaveField {
    SAVE_CHARACTER = 0, // 0 Sonic, 1 Tails, 2 Knuckles, 3 Sonic & Tails
    SAVE_LIVES,
    SAVE_SCORE,
    SAVE_BONUS,
    SAVE_ZONE,      // 1-based next zone; 0 = unused slot; >127 = special stage
    SAVE_EMERALDS,
    SAVE_SPECIALPOS,
};

std::string esc(const char *s)
{
    std::string out;
    for (const char *p = s; *p; ++p) {
        if (*p == '"' || *p == '\\')
            out += '\\';
        out += *p;
    }
    return out;
}

// Game options differ per game, exactly as initStartMenu()/STARTMENU_GAMEOPTS
// split them. `store` is the saveRAM cell the engine persists the value in.
struct GameOption {
    const char *key;
    const char *label;
    const char *global;
    int store;
    bool isEnum;
};

const GameOption S1_OPTIONS[] = {
    { "spindash", "Spindash", "options.spindash", 0x101, false },
    { "speedCap", "Ground speed cap", "options.speedCap", 0x102, false },
    { "airSpeedCap", "Air speed cap", "options.airSpeedCap", 0x103, false },
    { "spikeBehavior", "S1 spikes", "options.spikeBehavior", 0x104, false },
    { "shieldType", "Item type", "options.shieldType", 0x105, true },
    { "superStates", "Super forms", "options.superStates", 0x106, false },
};

const GameOption S2_OPTIONS[] = {
    { "airSpeedCap", "Air speed cap", "options.airSpeedCap", 0x101, false },
    { "tailsFlight", "Tails flight", "options.tailsFlight", 0x102, false },
    { "superTails", "Super Tails", "options.superTails", 0x103, false },
    { "spikeBehavior", "S1 spikes", "options.spikeBehavior", 0x104, false },
    { "shieldType", "Item type", "options.shieldType", 0x105, true },
};

const char *S1_ITEM_TYPES[] = { "S1", "S2", "S1+S3", "S2+S3" };
const char *S2_ITEM_TYPES[] = { "S2", "S2+S3", "RANDOM", "RANDOM+S3" };

const GameOption *optionTable(int *count)
{
    if (Engine.gameType == GAME_SONIC2) {
        *count = sizeof(S2_OPTIONS) / sizeof(S2_OPTIONS[0]);
        return S2_OPTIONS;
    }
    *count = sizeof(S1_OPTIONS) / sizeof(S1_OPTIONS[0]);
    return S1_OPTIONS;
}

} // namespace

// True once Engine::Init has run (first frame): before that there is no game
// config, no stage list and no saveRAM, so every getter below is meaningless.
bool web_engine_ready() { return Engine.initialised; }

// 1 = Sonic 1, 2 = Sonic 2, 0 = unknown (Engine::Init sniffs the window title).
int web_game_type() { return Engine.gameType; }

// Playable characters, from the pack's GameConfig player list.
std::string web_get_players()
{
    static TextMenu menu;
    SetupTextMenu(&menu, 0);
    LoadConfigListText(&menu, 0);

    std::ostringstream json;
    json << "[";
    for (int i = 0; i < menu.rowCount; ++i) {
        std::string name;
        for (int c = 0; c < menu.entrySize[i]; ++c) name += (char)menu.textData[menu.entryStart[i] + c];
        if (i)
            json << ",";
        json << "\"" << esc(name.c_str()) << "\"";
    }
    json << "]";
    return json.str();
}

// The four save slots. `zone` is a 0-based index into the stage list named by
// `list` (1 = regular, 3 = special), or -1 for an unused slot.
std::string web_get_save_slots()
{
    std::ostringstream json;
    json << "[";
    for (int slot = 0; slot < 4; ++slot) {
        const int base = slot << 3;
        const int zone = saveRAM[base + SAVE_ZONE];
        const bool special = zone > 127;
        if (slot)
            json << ",";
        json << "{\"slot\":" << slot << ",\"empty\":" << (zone ? "false" : "true")
             << ",\"character\":" << saveRAM[base + SAVE_CHARACTER]
             << ",\"lives\":" << saveRAM[base + SAVE_LIVES] << ",\"score\":" << saveRAM[base + SAVE_SCORE]
             << ",\"emeralds\":" << saveRAM[base + SAVE_EMERALDS]
             << ",\"list\":" << (zone ? (special ? STAGELIST_SPECIAL : STAGELIST_REGULAR) : -1)
             << ",\"zone\":" << (zone ? (special ? zone - 129 : zone - 1) : -1) << "}";
    }
    json << "]";
    return json.str();
}

void web_delete_save(int slot)
{
    if (slot < 0 || slot > 3)
        return;
    const int base = slot << 3;
    saveRAM[base + SAVE_CHARACTER] = 0;
    saveRAM[base + SAVE_LIVES]     = 3;
    saveRAM[base + SAVE_SCORE]     = 0;
    saveRAM[base + SAVE_BONUS]     = 50000;
    saveRAM[base + SAVE_ZONE]      = 0;
    saveRAM[base + SAVE_EMERALDS]  = 0;
    saveRAM[base + SAVE_SPECIALPOS] = 0;
    saveRAM[base + 7]              = 0;
    WriteSaveRAMData();
}

// Start a game the way the native menu does.
//   slot 0..3 with data  → continue that save (jumps to its zone)
//   slot 0..3 empty      → new game on that slot, as `player`
//   slot < 0             → no-save mode, as `player`
//
// The one deliberate difference from Debug.cpp: no-save mode does not write
// saveRAM. Upstream falls back to `savePos = 0` there and stamps slot 1 with a
// fresh game — surprising when the player explicitly asked not to save.
void web_start_game(int slot, int player)
{
    if (player < 0)
        player = 0;

    if (slot >= 0 && slot <= 3 && saveRAM[(slot << 3) + SAVE_ZONE]) {
        const int base = slot << 3;
        SetGlobalVariableByName("options.saveSlot", slot);
        SetGlobalVariableByName("options.gameMode", 1);
        SetGlobalVariableByName("options.stageSelectFlag", 0);
        SetGlobalVariableByName("player.lives", saveRAM[base + SAVE_LIVES]);
        SetGlobalVariableByName("player.score", saveRAM[base + SAVE_SCORE]);
        SetGlobalVariableByName("player.scoreBonus", saveRAM[base + SAVE_BONUS]);
        SetGlobalVariableByName("specialStage.emeralds", saveRAM[base + SAVE_EMERALDS]);
        SetGlobalVariableByName("specialStage.listPos", saveRAM[base + SAVE_SPECIALPOS]);
        SetGlobalVariableByName("stage.player2Enabled", saveRAM[base + SAVE_CHARACTER] == 3);
        SetGlobalVariableByName("lampPostID", 0); // For S1
        SetGlobalVariableByName("starPostID", 0); // For S2
        SetGlobalVariableByName("options.vsMode", 0);

        const int nextZone = saveRAM[base + SAVE_ZONE];
        if (nextZone > 127) {
            SetGlobalVariableByName("specialStage.nextZone", nextZone - 129);
            InitStartingStage(STAGELIST_SPECIAL, saveRAM[base + SAVE_SPECIALPOS], saveRAM[base + SAVE_CHARACTER]);
        }
        else {
            SetGlobalVariableByName("specialStage.nextZone", nextZone - 1);
            InitStartingStage(STAGELIST_REGULAR, nextZone - 1, saveRAM[base + SAVE_CHARACTER]);
        }
        return;
    }

    const bool saving = slot >= 0 && slot <= 3;
    if (saving) {
        const int base = slot << 3;
        saveRAM[base + SAVE_CHARACTER]  = player;
        saveRAM[base + SAVE_LIVES]      = 3;
        saveRAM[base + SAVE_SCORE]      = 0;
        saveRAM[base + SAVE_BONUS]      = 50000;
        saveRAM[base + SAVE_ZONE]       = 1;
        saveRAM[base + SAVE_EMERALDS]   = 0;
        saveRAM[base + SAVE_SPECIALPOS] = 0;
        saveRAM[base + 7]               = 0;
        SetGlobalVariableByName("options.gameMode", 1);
        SetGlobalVariableByName("options.stageSelectFlag", 0);
        SetGlobalVariableByName("options.saveSlot", slot);
    }
    else {
        SetGlobalVariableByName("options.gameMode", 0);
        SetGlobalVariableByName("options.saveSlot", 0);
    }

    SetGlobalVariableByName("player.lives", 3);
    SetGlobalVariableByName("player.score", 0);
    SetGlobalVariableByName("player.scoreBonus", 50000);
    SetGlobalVariableByName("specialStage.emeralds", 0);
    SetGlobalVariableByName("specialStage.listPos", 0);
    SetGlobalVariableByName("stage.player2Enabled", player == 3);
    SetGlobalVariableByName("lampPostID", 0); // For S1
    SetGlobalVariableByName("starPostID", 0); // For S2
    SetGlobalVariableByName("options.vsMode", 0);

    if (saving)
        WriteSaveRAMData();

    // Presentation/0 is the title screen: the engine's own new-game path goes
    // through it, and its script is what walks on into zone 1.
    InitStartingStage(STAGELIST_PRESENTATION, 0, player);
}

// The engine's GAME OPTIONS screen, as data.
std::string web_get_game_options()
{
    int count               = 0;
    const GameOption *table = optionTable(&count);
    const char **itemTypes  = Engine.gameType == GAME_SONIC2 ? S2_ITEM_TYPES : S1_ITEM_TYPES;

    std::ostringstream json;
    json << "[";
    for (int i = 0; i < count; ++i) {
        if (i)
            json << ",";
        json << "{\"key\":\"" << table[i].key << "\",\"label\":\"" << esc(table[i].label)
             << "\",\"value\":" << GetGlobalVariableByName(table[i].global) << ",\"type\":\""
             << (table[i].isEnum ? "enum" : "boolean") << "\"";
        if (table[i].isEnum) {
            json << ",\"values\":[";
            for (int v = 0; v < 4; ++v) {
                if (v)
                    json << ",";
                json << "\"" << esc(itemTypes[v]) << "\"";
            }
            json << "]";
        }
        json << "}";
    }
    json << "]";
    return json.str();
}

// Write-through, same as the engine's own options screen: global + saveRAM.
void web_set_game_option(std::string key, int value)
{
    int count               = 0;
    const GameOption *table = optionTable(&count);
    for (int i = 0; i < count; ++i) {
        if (key != table[i].key)
            continue;
        SetGlobalVariableByName(table[i].global, value);
        saveRAM[table[i].store] = value;
        WriteSaveRAMData();
        return;
    }
}

EMSCRIPTEN_BINDINGS(web_game)
{
    emscripten::function("web_engine_ready", &web_engine_ready);
    emscripten::function("web_game_type", &web_game_type);
    emscripten::function("web_get_players", &web_get_players);
    emscripten::function("web_get_save_slots", &web_get_save_slots);
    emscripten::function("web_delete_save", &web_delete_save);
    emscripten::function("web_start_game", &web_start_game);
    emscripten::function("web_get_game_options", &web_get_game_options);
    emscripten::function("web_set_game_option", &web_set_game_option);
}
EOF

echo "Registering WebGame.cpp in the Makefile SOURCES list..."
python3 - "$WORK_DIR/Makefile" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

anchor = "          RSDKv4/Userdata.cpp      \\\n"
assert content.count(anchor) == 1, "expected exactly one Userdata.cpp SOURCES line"
content = content.replace(anchor, anchor + "          RSDKv4/WebGame.cpp      \\\n", 1)

with open(path, "w", encoding="utf-8") as f:
    f.write(content)
PYEOF

echo "Patching RetroEngine.cpp for decoupled logic at 120Hz/30Hz..."
python3 - "$WORK_DIR/RSDKv4/RetroEngine.cpp" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

anchor = (
    "void RetroEngine::Run()\n"
    "{\n"
    "    uint frameStart, frameEnd = SDL_GetTicks();\n"
    "    float frameDelta = 0.0f;\n"
    "\n"
    "#ifndef __EMSCRIPTEN__\n"
    "    while (running) \n"
    "#endif\n"
    "    {\n"
)
replacement = (
    "void RetroEngine::Run()\n"
    "{\n"
    "#ifndef __EMSCRIPTEN__\n"
    "    uint frameStart, frameEnd = SDL_GetTicks();\n"
    "    float frameDelta = 0.0f;\n"
    "    while (running) \n"
    "#else\n"
    "    static unsigned long long curTicks = 0;\n"
    "    static unsigned long long prevTicks = 0;\n"
    "    unsigned long long targetFreq = SDL_GetPerformanceFrequency() / refreshRate;\n"
    "    if (running)\n"
    "#endif\n"
    "    {\n"
)
content = content.replace(anchor, replacement, 1)

anchor = (
    "        running = processEvents();\n"
    "#if !RETRO_USE_ORIGINAL_CODE\n"
    "        for (int s = 0; s < gameSpeed; ++s) {\n"
    "            ProcessInput();\n"
    "#endif\n"
    "\n"
    "#if !RETRO_USE_ORIGINAL_CODE\n"
    "            if (!masterPaused || frameStep) {\n"
    "#endif\n"
    "                ProcessNativeObjects();\n"
    "                FlipScreen();\n"
    "\n"
    "#if !RETRO_USE_ORIGINAL_CODE\n"
    "#if RETRO_USING_OPENGL && RETRO_USING_SDL2 && RETRO_HARDWARE_RENDER\n"
    "                if (s == gameSpeed - 1)\n"
    "                    SDL_GL_SwapWindow(Engine.window);\n"
    "#endif\n"
    "                frameStep = false;\n"
    "            }\n"
    "        }\n"
    "#endif\n"
)
replacement = (
    "#ifndef __EMSCRIPTEN__\n"
    "        running = processEvents();\n"
    "#if !RETRO_USE_ORIGINAL_CODE\n"
    "        for (int s = 0; s < gameSpeed; ++s) {\n"
    "            ProcessInput();\n"
    "#endif\n"
    "\n"
    "#if !RETRO_USE_ORIGINAL_CODE\n"
    "            if (!masterPaused || frameStep) {\n"
    "#endif\n"
    "                ProcessNativeObjects();\n"
    "                FlipScreen();\n"
    "\n"
    "#if !RETRO_USE_ORIGINAL_CODE\n"
    "#if RETRO_USING_OPENGL && RETRO_USING_SDL2 && RETRO_HARDWARE_RENDER\n"
    "                if (s == gameSpeed - 1)\n"
    "                    SDL_GL_SwapWindow(Engine.window);\n"
    "#endif\n"
    "                frameStep = false;\n"
    "            }\n"
    "        }\n"
    "#endif\n"
    "#else\n"
    "        int logicLoops = 0;\n"
    "        while (curTicks >= targetFreq && logicLoops < 4) {\n"
    "            curTicks -= targetFreq;\n"
    "            logicLoops++;\n"
    "            running = processEvents();\n"
    "            for (int s = 0; s < gameSpeed; ++s) {\n"
    "                ProcessInput();\n"
    "                if (!masterPaused || frameStep) {\n"
    "                    ProcessNativeObjects();\n"
    "                    frameStep = false;\n"
    "                }\n"
    "            }\n"
    "        }\n"
    "        FlipScreen();\n"
    "#endif\n"
)
content = content.replace(anchor, replacement, 1)

anchor = (
    "#if !RETRO_USE_ORIGINAL_CODE\n"
    "        frameStart = SDL_GetTicks();\n"
    "        frameDelta = frameStart - frameEnd;\n"
    "\n"
    "        if (frameDelta < 1000.0f / (float)refreshRate)\n"
    "            SDL_Delay(1000.0f / (float)refreshRate - frameDelta);\n"
    "\n"
    "        frameEnd = SDL_GetTicks();\n"
    "#endif\n"
)
replacement = (
    "#ifndef __EMSCRIPTEN__\n"
    "#if !RETRO_USE_ORIGINAL_CODE\n"
    "        frameStart = SDL_GetTicks();\n"
    "        frameDelta = frameStart - frameEnd;\n"
    "\n"
    "        if (frameDelta < 1000.0f / (float)refreshRate)\n"
    "            SDL_Delay(1000.0f / (float)refreshRate - frameDelta);\n"
    "\n"
    "        frameEnd = SDL_GetTicks();\n"
    "#endif\n"
    "#else\n"
    "        unsigned long long curTime = SDL_GetPerformanceCounter();\n"
    "        if (prevTicks == 0) prevTicks = curTime;\n"
    "        curTicks += (curTime - prevTicks);\n"
    "        prevTicks = curTime;\n"
    "        if (curTicks > targetFreq * 4) curTicks = targetFreq * 4;\n"
    "        if (curTicks + (targetFreq / 8) >= targetFreq && curTicks < targetFreq) curTicks = targetFreq;\n"
    "        if (curTicks < targetFreq) return;\n"
    "#endif\n"
)
content = content.replace(anchor, replacement, 1)

with open(path, "w", encoding="utf-8") as f:
    f.write(content)
PYEOF

echo "Building WASM (make wasm)..."
( cd "$WORK_DIR" && make wasm )

echo "Copying build output to $DIST_DIR/rsdkv4..."
mkdir -p "$DIST_DIR/rsdkv4"
cp "$WORK_DIR/wasm/rsdkv4.js" "$DIST_DIR/rsdkv4/rsdkv4.js"
cp "$WORK_DIR/wasm/rsdkv4.wasm" "$DIST_DIR/rsdkv4/rsdkv4.wasm"

echo "Build complete. Artifacts:"
ls -la "$DIST_DIR"
