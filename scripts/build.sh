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

# RSDKV4_WORKER=1 builds the *experimental* worker variant: main() on a pthread,
# picture on a transferred OffscreenCanvas. It is opt-in and lands in a separate
# output dir, so the shipped single-threaded build stays exactly as it is and the
# two can be served side by side (see the worker smoke test in SESSIONS/).
#
# Why this is not the default yet: OPFS's sync access handles only exist off the
# main thread, so the worker is what makes real persistence possible — but SDL's
# audio callback decodes Ogg by reading from the pack, and if SDL keeps invoking
# it on the browser thread that read happens where the file isn't. That is what
# the smoke test measures before any of this becomes the default.
WORKER="${RSDKV4_WORKER:-0}"

# RSDKV4_OFFSCREEN=1 additionally transfers the canvas to the engine thread.
# Off by default because it does not currently work with this engine, and the
# reason is structural rather than a flag away: RSDKv4 draws through SDL2, SDL2
# gets its GL context through EGL, and Emscripten's EGL is proxied to the main
# thread — where the element can no longer hand out a context once its control
# has been transferred away. It fails as
#
#   InvalidStateError: Cannot get context from a canvas that has transferred
#   its control to offscreen
#
# …raised inside __emscripten_receive_on_main_thread_js, which is the proxy hop
# itself. Making this work means getting SDL to create its context with
# emscripten_webgl_create_context() on the owning thread; until then the canvas
# stays on the main thread and GL calls are proxied to it (slower, but a
# picture). Kept as a switch so the next attempt starts from a measurement.
OFFSCREEN="${RSDKV4_OFFSCREEN:-0}"

# RSDKV4_NOAUDIO=1 builds with no audio at all — neither an SDL device nor the
# ring. Strictly a measurement build, for isolating what the rest of the engine
# does when audio is out of the picture. Never for a shipped one.
NOAUDIO="${RSDKV4_NOAUDIO:-0}"

if [ "$WORKER" = "1" ]; then
  OUT_NAME="rsdkv4-worker"
else
  OUT_NAME="rsdkv4"
fi

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

if [ "$WORKER" = "1" ] && [ "$NOAUDIO" != "1" ]; then
  echo "Patching Audio.cpp: engine-thread ring instead of an SDL audio device..."
  # SDL2's audio glue throws on a pthread (see WebAudio.cpp), so the worker build
  # never opens a device — it starts the ring and takes the *success* branch,
  # which matters: the failure branch returns before LoadGlobalSfx() and would
  # leave the game without a single sound effect loaded.
  python3 - "$WORK_DIR/RSDKv4/Audio.cpp" <<'PYEOF'
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

old = """    if ((audioDevice = SDL_OpenAudioDevice(nullptr, 0, &want, &audioDeviceFormat, SDL_AUDIO_ALLOW_FREQUENCY_CHANGE)) > 0) {
        audioEnabled = true;
        SDL_PauseAudioDevice(audioDevice, 0);
    }
    else {
        printLog("Unable to open audio device: %s", SDL_GetError());"""
new = """    if (web_audio_ring_init(AUDIO_FREQUENCY, AUDIO_CHANNELS)) {
        audioEnabled = true;
        audioDeviceFormat = want;
    }
    else {
        printLog("Unable to start the audio ring");"""
assert content.count(old) == 1, "the SDL2 audio-open block is not where the worker patch expects it"
content = content.replace(old, new, 1)

# The mixer is reached through the ring now, so Audio.cpp needs its declaration.
anchor = "#define AUDIO_FREQUENCY (44100)"
assert content.count(anchor) == 1, "audio format defines moved"
content = content.replace(anchor, "bool web_audio_ring_init(int freq, int channels); // WebAudio.cpp\n\n" + anchor, 1)

with open(path, "w", encoding="utf-8") as f:
    f.write(content)
PYEOF
fi

if [ "$WORKER" = "1" ] && [ "$OFFSCREEN" != "1" ]; then
  echo "Patching Drawing.cpp: software renderer (no GL context on the engine thread)..."
  # RSDKv4 renders in software — it only ever asks SDL for a streaming texture and
  # blits its own framebuffer into it — but SDL_RENDERER_ACCELERATED still routes
  # that through WebGL, and WebGL is where the worker experiment dies:
  #
  #   canvas transferred    → eglCreateContext is proxied to the main thread and
  #                           the element there can no longer give a context
  #   canvas not transferred → the context is created on the main thread and the
  #                           engine thread's own GL calls find GLctx undefined
  #                           ("Cannot read properties of undefined (createShader)")
  #
  # SDL_RENDERER_SOFTWARE takes GL out of the picture entirely: SDL puts the
  # pixels on the canvas through its 2D context, which is proxied whole rather
  # than per-GL-call. For a 320x240 framebuffer that is one blit per frame.
  sed -i.bak 's/SDL_CreateRenderer(Engine.window, -1, SDL_RENDERER_ACCELERATED)/SDL_CreateRenderer(Engine.window, -1, SDL_RENDERER_SOFTWARE)/' \
    "$WORK_DIR/RSDKv4/Drawing.cpp"
  grep -q "SDL_RENDERER_SOFTWARE" "$WORK_DIR/RSDKv4/Drawing.cpp" || { echo "renderer patch did not apply"; exit 1; }
fi

if [ "$WORKER" = "1" ]; then
  echo "Patching Makefile for the worker variant (pthread, offscreen=$OFFSCREEN)..."
  # -sPROXY_TO_PTHREAD moves main() — and with it emscripten_set_main_loop and
  # every fopen the engine does — off the browser thread. That alone is what the
  # experiment is about: it is where OPFS's sync access handles become reachable.
  # OFFSCREEN_FRAMEBUFFER lets the engine thread render into an FBO that is
  # blitted on the main thread, which is what makes a picture possible while the
  # canvas itself stays where SDL's proxied EGL can still reach it.
  python3 - "$WORK_DIR/Makefile" "$OFFSCREEN" <<'PYEOF'
import sys

path = sys.argv[1]
offscreen = sys.argv[2] == "1"
flags = " -pthread -s PROXY_TO_PTHREAD=1 -s PTHREAD_POOL_SIZE=4 -s OFFSCREEN_FRAMEBUFFER=1"
# The main-thread half of the audio ring. --js-library rather than EM_ASM because
# the JS needs `__proxy: 'sync'` to hop from the engine thread to the browser
# thread, and because a worklet's source is easier to keep readable in its own file.
flags += " --js-library RSDKv4/web_audio.js"

# The canvas transfer is switched off by dropping OFFSCREENCANVAS_SUPPORT, not by
# emptying the canvas list. Two traps live here, both paid for already:
#
#   - OFFSCREENCANVASES_TO_PTHREAD *defaults to* "#canvas", which is exactly the
#     id SDL2 looks for. Omitting the flag transfers the canvas anyway.
#   - Setting it empty is not "transfer nothing": emcc rejects the argument with
#     `error parsing "-s" setting: string index out of range`.
#
# With OFFSCREENCANVAS_SUPPORT off, the transfer code is not emitted at all, the
# canvas stays on the main thread where SDL's proxied EGL can still get a context
# from it, and GL reaches it through OFFSCREEN_FRAMEBUFFER.
if offscreen:
    flags += " -s OFFSCREENCANVAS_SUPPORT=1 -s OFFSCREENCANVASES_TO_PTHREAD='#canvas'"

with open(path, "r", encoding="utf-8") as f:
    lines = f.readlines()

hits = [i for i, l in enumerate(lines) if l.startswith("\tmkdir wasm; em++")]
assert len(hits) == 1, f"expected exactly one wasm recipe line, found {len(hits)}"
line = lines[hits[0]].rstrip("\n").rstrip() + flags

# Reaching an unexported runtime method does not return undefined — an assertions
# build traps the access and calls abort(), which kills the module for good. So a
# page that wants to see the thread pool has to be given PThread explicitly, and
# the list has to be rewritten whole (a second -s flag would replace it, taking
# callMain and FS with it).
old = "EXPORTED_RUNTIME_METHODS=['callMain','FS','ccall','cwrap']"
new = "EXPORTED_RUNTIME_METHODS=['callMain','FS','ccall','cwrap','PThread']"
assert old in line, "the exported-runtime-methods list is not where the worker patch expects it"
lines[hits[0]] = line.replace(old, new) + "\n"

with open(path, "w", encoding="utf-8") as f:
    f.writelines(lines)
PYEOF
fi

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

// Defined in WebDevMenu.cpp. Called from here because this is the one place we
// know we are on the engine's own thread: with -sPROXY_TO_PTHREAD that is a
// worker, without it the browser thread, and the difference is invisible from JS.
void web_note_engine_thread();

// Defined in WebAudio.cpp; a no-op unless this is a pthread build. It has to run
// on the engine thread, right here, because it calls the engine's own mixer.
void web_audio_pump();

void main_loop()
{
    static bool init = false;
    if (!init) {
        web_note_engine_thread();
        Engine.Init();
        init = true;
    }
	Engine.Run();
	web_audio_pump();
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

# The no-audio probe rewrites the line the patch above just produced, so it has
# to come after it.
if [ "$NOAUDIO" = "1" ]; then
  echo "Patching Audio.cpp: audio device never opened (measurement build)..."
  sed -i.bak 's/SDL_InitSubSystem(SDL_INIT_AUDIO); if ((audioDevice = SDL_OpenAudioDevice/if (false \&\& (audioDevice = SDL_OpenAudioDevice/' \
    "$WORK_DIR/RSDKv4/Audio.cpp"
  grep -q "if (false && (audioDevice" "$WORK_DIR/RSDKv4/Audio.cpp" || { echo "audio patch did not apply"; exit 1; }
fi

echo "Patching Input.cpp to forcibly initialize controllers continuously with fallback mapping..."
perl -0777 -pi -e 's/void ProcessInput\(\)\n\{/void ProcessInput()\n{\n#if RETRO_USING_SDL2\n    for (int i = 0; i < SDL_NumJoysticks(); ++i) {\n        if (!SDL_GameControllerFromInstanceID(i)) {\n            if (!SDL_IsGameController(i)) {\n                char mapping[1024];\n                SDL_JoystickGUID guid = SDL_JoystickGetDeviceGUID(i);\n                char guid_str[33];\n                SDL_JoystickGetGUIDString(guid, guid_str, sizeof(guid_str));\n                snprintf(mapping, sizeof(mapping), "%s,Web Gamepad,a:b0,b:b1,x:b2,y:b3,back:b8,start:b9,leftstick:b10,rightstick:b11,leftshoulder:b4,rightshoulder:b5,dpup:b12,dpdown:b13,dpleft:b14,dpright:b15,leftx:a0,lefty:a1,rightx:a2,righty:a3,lefttrigger:b6,righttrigger:b7,", guid_str);\n                SDL_GameControllerAddMapping(mapping);\n            }\n            controllerInit(i);\n        }\n    }\n#endif/g' "$WORK_DIR/RSDKv4/Input.cpp"

echo "Adding WebInput.cpp (host-driven input, and the jump key that pauses)..."
cat << 'EOF' > "$WORK_DIR/RSDKv4/WebInput.cpp"
// The two things this build does to ProcessInput. They are independent — either
// one works without the other — and they live together because both write
// inputDevice and both are called from the patch in Input.cpp.
//
// 1. web_input_fold_jump(): the retail bytecode inside Data.rsdk pauses on
//    button B as well as on start (only the script interpreter ever writes
//    ENGINE_INITPAUSE — Script.cpp → RetroGameLoop.cpp), and B is also a jump
//    button (Object.cpp: jumpPress = keyPress.C | keyPress.B | keyPress.A). So
//    on a keyboard the jump key `x` jumps AND opens the pause menu. The pack is
//    compiled and encrypted, so the fix is to stop feeding B.
//
// 2. web_input_take(): lets the host own the buttons outright — touch controls,
//    rebinding, netplay, tests — by pulling a bitmask from JS once per tick
//    instead of polling SDL.
#include "RetroEngine.hpp"
#include <emscripten.h>
#include <emscripten/bind.h>

// 0 = the engine polls SDL, 1 = the host is pulled. Flipped from JS by the SDK
// when it claims or releases input.
static int inputSource = 0;

// Bit i of the returned mask is inputDevice[i], in InputButtons order:
// up down left right A B C X Y Z L R start select. 0 means "everything up",
// which is also what the SDK returns while its read is failing — a repeated
// mask with a direction held would leave the character running on its own.
//
// The SDK installs the reader on the module object when it claims. Absent is
// not an error: the source can be flipped on before the reader lands, and a
// tick in between simply reads nothing.
EM_JS(int, web_input_pull, (), {
  var pull = typeof Module !== "undefined" && Module["__rsdkv4_input_pull"];
  return pull ? pull() | 0 : 0;
});

// Both are called from Input.cpp, which declares them itself: one file, two
// call sites, no header worth the name. Plain C++ linkage on both sides, as
// main.cpp ↔ WebDevMenu.cpp already does it — an `extern "C"` here and not
// there is exactly how that pairing turns into a link error.

// Fold B into A while a stage is running, so the jump key stops pausing.
//
// The ENGINE_MAINGAME guard is load-bearing. keyPress.B is "back" in the native
// dev menu (~10 sites in Debug.cpp) and in the pause menu (PauseMenu.cpp);
// clearing B unconditionally leaves both with no way out.
//
// Chosen over remapping the defaults because it costs no key — z, x and c all
// keep jumping, and the engine's key table is 1:1, so dropping B from it would
// leave only two — and because it covers the gamepad for free: B's contMapping
// is SDL_CONTROLLER_BUTTON_B, so the east button pauses today too.
//
// Known risk, accepted: a pack that used B for something else in-stage would
// lose it. Sonic 1 and Sonic 2 do not.
void web_input_fold_jump()
{
    if (Engine.gameMode != ENGINE_MAINGAME)
        return;

    inputDevice[INPUT_BUTTONA].press |= inputDevice[INPUT_BUTTONB].press;
    inputDevice[INPUT_BUTTONA].hold |= inputDevice[INPUT_BUTTONB].hold;
    inputDevice[INPUT_BUTTONB].press = false;
    inputDevice[INPUT_BUTTONB].hold  = false;
}

// Returns 1 when the host owns input and inputDevice has just been written from
// its mask — the caller then returns, and SDL is not polled at all this tick.
//
// Pull rather than push: the engine reads the host's state at the one moment it
// is about to use it, so there is no second sampler to add phase error, no
// write/poll race, and no coalescing of two changes inside one frame.
int web_input_take()
{
    if (inputSource != 1)
        return 0;

    const int mask = web_input_pull();
    bool anyDown   = false;

    for (int i = 0; i < INPUT_ANY; ++i) {
        if (mask & (1 << i)) {
            inputDevice[i].setHeld();
            anyDown = true;
        }
        else if (inputDevice[i].hold) {
            inputDevice[i].setReleased();
        }
    }

    // INPUT_ANY and the dim timer, kept in step with what the SDL paths do:
    // without this the screen would go on dimming under a claim, however busy
    // the player was.
    if (anyDown) {
        if (!inputDevice[INPUT_ANY].hold)
            inputDevice[INPUT_ANY].setHeld();
    }
    else if (inputDevice[INPUT_ANY].hold) {
        inputDevice[INPUT_ANY].setReleased();
    }

    if (inputDevice[INPUT_ANY].press || inputDevice[INPUT_ANY].hold || touches > 1)
        Engine.dimTimer = 0;
    else if (Engine.dimTimer < Engine.dimLimit)
        ++Engine.dimTimer;

    // The fold applies to a claiming host too: the bytecode's pause-on-B is the
    // pack's, not the keyboard's, so a host that maps a jump button onto B
    // would hit exactly the same thing.
    web_input_fold_jump();
    return 1;
}

// Claim (1) or release (0). Every button is cleared on the way through, in both
// directions: a button the losing side had down is otherwise still down in
// inputDevice, and the winning side never sees the release that would clear it.
void web_input_set_source(int source)
{
    const int next = source == 1 ? 1 : 0;
    if (next == inputSource)
        return;

    inputSource = next;
    for (int i = 0; i < INPUT_MAX; ++i) inputDevice[i].setReleased();
}

int web_input_get_source() { return inputSource; }

// What the engine has held right now, in the same bit order the pull uses — the
// read-back to the pull's write. A host can check that its claim is arriving, and
// a test can tell "the button never reached the engine" from "the game ignored
// it", which are otherwise the same silence.
int web_input_get_mask()
{
    int mask = 0;
    for (int i = 0; i < INPUT_ANY; ++i)
        if (inputDevice[i].hold)
            mask |= 1 << i;
    return mask;
}

// Which of RetroStates the engine is in — ENGINE_MAINGAME (1) while a stage runs,
// ENGINE_WAIT (3) while the pause menu is up. The one number that says whether an
// input did anything at all.
int web_engine_game_mode() { return Engine.gameMode; }

EMSCRIPTEN_BINDINGS(web_input)
{
    emscripten::function("web_input_set_source", &web_input_set_source);
    emscripten::function("web_input_get_source", &web_input_get_source);
    emscripten::function("web_input_get_mask", &web_input_get_mask);
    emscripten::function("web_engine_game_mode", &web_engine_game_mode);
}
EOF

echo "Registering WebInput.cpp in the Makefile SOURCES list..."
python3 - "$WORK_DIR/Makefile" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

anchor = "          RSDKv4/Userdata.cpp      \\\n"
assert content.count(anchor) == 1, "expected exactly one Userdata.cpp SOURCES line"
content = content.replace(anchor, anchor + "          RSDKv4/WebInput.cpp     \\\n", 1)

with open(path, "w", encoding="utf-8") as f:
    f.write(content)
PYEOF

echo "Patching Input.cpp: the host's claim, and folding B into A in-stage..."
# Runs after the controller patch above, which inserted its joystick scan at the
# very top of ProcessInput — the claim goes in front of that too, since a host
# that owns input owns the gamepad with it.
python3 - "$WORK_DIR/RSDKv4/Input.cpp" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

head = "void ProcessInput()\n{\n"
assert content.count(head) == 1, "expected exactly one ProcessInput definition"
content = content.replace(
    head,
    "// WebInput.cpp. Declared here rather than in a header: one file, one caller.\n"
    "int web_input_take();       // 1 = the host wrote inputDevice; do not poll SDL\n"
    "void web_input_fold_jump(); // B into A while a stage runs\n"
    "\n"
    + head
    + "    // The `return` is load-bearing. Falling through would reach the inputType\n"
    "    // autoswitch at the end of this function, which hands control back to SDL\n"
    "    // the moment a real key or pad button is touched.\n"
    "    if (web_input_take())\n"
    "        return;\n"
    "\n",
    1,
)

# …and the SDL paths get the fold on the way out. Anchored on the comment that
# follows the function, because the `#endif }` above it is not unique on its own.
tail = "#endif\n}\n#endif\n\n// Pretty much is this code in the original"
assert content.count(tail) == 1, "the end of ProcessInput is not where this patch expects it"
content = content.replace(
    tail,
    "#endif\n\n    web_input_fold_jump();\n}\n#endif\n\n// Pretty much is this code in the original",
    1,
)

with open(path, "w", encoding="utf-8") as f:
    f.write(content)
PYEOF

echo "Adding web_audio.js (main-thread half of the audio ring)..."
cat << 'EOF' > "$WORK_DIR/RSDKv4/web_audio.js"
// The main-thread half of the engine's audio ring. Linked with --js-library, and
// only into the worker build (see WebAudio.cpp for the engine-thread half).
//
// `__proxy: 'sync'` is Emscripten's own mechanism for "this call has to happen on
// the main thread": the engine calls web_audio_ring_start() from its pthread and
// lands here, on the browser thread, which is the only place an AudioContext
// exists at all. It is the same machinery SDL's video glue uses — the difference
// is that here it is deliberate and it is only used once, at startup, instead of
// on the audio path.
//
// After that nothing is proxied and nothing is posted per frame: the worklet
// reads the engine's ring straight out of shared memory with Atomics.
addToLibrary({
  $RSDKAudio: {
    context: null,
    node: null,
  },

  web_audio_ring_start__proxy: 'sync',
  web_audio_ring_start__sig: 'iiii',
  web_audio_ring_start__deps: ['$RSDKAudio'],
  web_audio_ring_start: (dataPtr, ctrlPtr, frames, freq) => {
    if (RSDKAudio.context) return 1;

    // The processor source, as text, because an AudioWorklet module has to be
    // fetched from a URL. `frames` is a power of two, so the ring wraps with a
    // mask; the cursors are monotonic int32 and compared as a difference, which
    // stays correct across their eventual wrap.
    const source = `
      class RsdkRing extends AudioWorkletProcessor {
        constructor(options) {
          super();
          const o = options.processorOptions;
          this.pcm = new Int16Array(o.buffer, o.dataPtr, o.frames * 2);
          this.ctrl = new Int32Array(o.buffer, o.ctrlPtr, 2);
          this.mask = o.frames - 1;
        }
        process(inputs, outputs) {
          const out = outputs[0];
          const left = out[0];
          const right = out[1] || out[0];
          const written = Atomics.load(this.ctrl, 0);
          let read = Atomics.load(this.ctrl, 1);
          for (let i = 0; i < left.length; i++) {
            // Underrun is silence, never a stale frame: a stalled engine should
            // go quiet rather than buzz.
            if (((written - read) | 0) > 0) {
              const base = ((read & this.mask) * 2) | 0;
              left[i] = this.pcm[base] / 32768;
              right[i] = this.pcm[base + 1] / 32768;
              read = (read + 1) | 0;
            } else {
              left[i] = 0;
              right[i] = 0;
            }
          }
          Atomics.store(this.ctrl, 1, read);
          return true;
        }
      }
      registerProcessor('rsdkv4-ring', RsdkRing);
    `;

    try {
      // Exactly the engine's rate, so nothing resamples on the way out.
      const context = new AudioContext({ sampleRate: freq });
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));

      context.audioWorklet
        .addModule(url)
        .then(() => {
          URL.revokeObjectURL(url);
          const node = new AudioWorkletNode(context, 'rsdkv4-ring', {
            numberOfInputs: 0,
            outputChannelCount: [2],
            processorOptions: { buffer: wasmMemory.buffer, dataPtr, ctrlPtr, frames },
          });
          node.connect(context.destination);
          RSDKAudio.node = node;
        })
        .catch((error) => err('rsdkv4: audio worklet failed: ' + error));

      RSDKAudio.context = context;

      // Autoplay policy: a context created without a gesture starts suspended and
      // stays that way until one arrives. The host can also call resume itself.
      const resume = () => { if (context.state !== 'running') context.resume(); };
      for (const type of ['pointerdown', 'keydown', 'touchstart']) {
        addEventListener(type, resume, { passive: true });
      }
      resume();
      return 1;
    } catch (error) {
      err('rsdkv4: could not start audio: ' + error);
      return 0;
    }
  },

  web_audio_ring_resume__proxy: 'async',
  web_audio_ring_resume__sig: 'vi',
  web_audio_ring_resume__deps: ['$RSDKAudio'],
  web_audio_ring_resume: (playing) => {
    if (!RSDKAudio.context) return;
    if (playing) RSDKAudio.context.resume();
    else RSDKAudio.context.suspend();
  },
});
EOF

echo "Adding WebAudio.cpp (engine-thread half of the audio ring)..."
cat << 'EOF' > "$WORK_DIR/RSDKv4/WebAudio.cpp"
// A PCM ring between the engine thread and an AudioWorklet on the main thread.
//
// SDL2's audio glue does not survive being run from a pthread: on the engine
// thread it reaches for a Module-side SDL2 object that only exists on the main
// thread, and throws before the engine can take a single frame. So the worker
// build takes audio out of SDL's hands rather than teaching SDL about threads.
//
//   engine thread   ProcessAudioPlayback() → this ring (int16 stereo)
//   audio thread    the worklet in web_audio.js drains it
//
// The engine's own audio state — music track, sfx channels — is only ever
// touched from the engine thread, and the pump below runs there too, so the
// mixing needs no locking whatsoever. The single boundary between threads is
// the ring, and it is a single-producer/single-consumer queue with two atomic
// cursors that JS reads with Atomics at the very same addresses.
#include "RetroEngine.hpp"

#ifdef __EMSCRIPTEN_PTHREADS__

#include <atomic>
#include <cstring>

extern "C" {
int web_audio_ring_start(int dataPtr, int ctrlPtr, int frames, int freq);
void web_audio_ring_resume(int playing);
}

namespace {

// Power of two: the ring wraps with a mask, here and in the worklet.
const int RING_FRAMES   = 8192; // ~186 ms at 44100 Hz
const int CHUNK_FRAMES  = 512;  // one ProcessAudioPlayback call
const int TARGET_FRAMES = 3072; // ~70 ms kept ahead of the worklet

int16_t ringData[RING_FRAMES * 2];

// [0] written, [1] read — in frames, monotonic, compared as a difference so the
// eventual int32 wrap is harmless. Plain 4-byte atomics because the worklet
// touches these exact addresses through an Int32Array.
std::atomic<int32_t> ringCursors[2];

bool ringReady = false;

} // namespace

// Called from InitAudioPlayback on the engine thread, in place of opening an SDL
// audio device. Returns false if the browser refused us a context, which leaves
// the engine muted but running.
bool web_audio_ring_init(int freq, int channels)
{
    (void)channels; // the ring is stereo, like the engine's mixer

    ringCursors[0].store(0, std::memory_order_relaxed);
    ringCursors[1].store(0, std::memory_order_relaxed);
    memset(ringData, 0, sizeof(ringData));

    ringReady = web_audio_ring_start((int)(intptr_t)ringData, (int)(intptr_t)ringCursors, RING_FRAMES, freq) == 1;
    return ringReady;
}

// One call per frame from the engine loop: top the ring up to TARGET_FRAMES.
// The worklet drains 44100 frames a second while this runs at the display's
// rate, so the buffer ahead is what covers the jitter between the two.
void web_audio_pump()
{
    if (!ringReady || !audioEnabled)
        return;

    int32_t written = ringCursors[0].load(std::memory_order_relaxed);

    for (;;) {
        const int32_t read     = ringCursors[1].load(std::memory_order_acquire);
        const int32_t buffered = written - read;

        if (buffered >= TARGET_FRAMES || RING_FRAMES - buffered < CHUNK_FRAMES)
            break;

        // The mixer returns early when there is nothing to play and leaves the
        // buffer untouched, so silence has to be the starting point — SDL used
        // to do this zeroing for it.
        int16_t chunk[CHUNK_FRAMES * 2];
        memset(chunk, 0, sizeof(chunk));
        ProcessAudioPlayback(nullptr, (Uint8 *)chunk, (int)sizeof(chunk));

        const int start = written & (RING_FRAMES - 1);
        const int first = (start + CHUNK_FRAMES > RING_FRAMES) ? RING_FRAMES - start : CHUNK_FRAMES;
        memcpy(&ringData[start * 2], chunk, first * 2 * sizeof(int16_t));
        if (first < CHUNK_FRAMES)
            memcpy(&ringData[0], &chunk[first * 2], (CHUNK_FRAMES - first) * 2 * sizeof(int16_t));

        written += CHUNK_FRAMES;
        ringCursors[0].store(written, std::memory_order_release);
    }
}

#else

bool web_audio_ring_init(int, int) { return false; }
void web_audio_pump() {}

#endif
EOF

echo "Registering WebAudio.cpp in the Makefile SOURCES list..."
python3 - "$WORK_DIR/Makefile" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

anchor = "          RSDKv4/Userdata.cpp      \\\n"
assert content.count(anchor) == 1, "expected exactly one Userdata.cpp SOURCES line"
content = content.replace(anchor, anchor + "          RSDKv4/WebAudio.cpp     \\\n", 1)

with open(path, "w", encoding="utf-8") as f:
    f.write(content)
PYEOF

echo "Adding WebDevMenu.cpp (embind bridge for the HTML dev-menu overlay)..."
cat << 'EOF' > "$WORK_DIR/RSDKv4/WebDevMenu.cpp"
// Bridges a subset of RSDKv4's native Dev Menu (normally opened via Escape,
// see RetroEngine.cpp's SDLK_ESCAPE handler and Debug.cpp's initDevMenu())
// to JS, so the SDK can replace the in-canvas menu screen with an HTML overlay.
#include "RetroEngine.hpp"
#include <emscripten/bind.h>
#include <emscripten/em_asm.h>
#include <emscripten/threading.h>
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

    // Silence the stage being left. A scene that plays its own music covers for
    // this by starting a new track, but the ones a pause menu warps to most —
    // the stage menu, level select — do not, so the previous zone's music kept
    // playing over them. InitStartingStage() does exactly this before a load.
    StopMusic();
    StopAllSfx();
    ReleaseStageSfx();

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

// --- input latency ----------------------------------------------------------
//
// Recorded by the engine thread the moment it pulls a keydown off SDL's queue.
// Compared against the timestamp of the dispatch on the page, this is the cost
// of getting a keypress from the browser to the engine — the number that
// decides whether running in a worker is worth it, and the one thing frames per
// second cannot tell you.
//
// performance.now() is relative to each context's own time origin, and a worker
// has a different one from the page, so the reading has to be absolute: adding
// timeOrigin puts both sides on the same epoch.
static double lastKeyMs   = 0;
static int lastKeyCounter = 0;

void web_note_key_arrival()
{
    lastKeyMs = EM_ASM_DOUBLE({ return performance.timeOrigin + performance.now(); });
    ++lastKeyCounter;
}

double web_last_key_ms() { return lastKeyMs; }

int web_key_counter() { return lastKeyCounter; }

// Frames since the current scene loaded (Scene.cpp bumps it once per logic
// frame; it resets on every scene load, and stands still outside a stage).
// Sampled twice from JS it gives the engine's real frame rate — which is the
// only honest way to ask whether the picture is keeping up once the engine
// runs on a thread the page cannot see.
int web_frame_count()
{
    return (int)Engine.frameCount;
}

// Where the engine loop actually runs, recorded by the loop itself.
//
// Asking this from JS can only ever describe the thread doing the asking, so
// main.cpp calls the recorder on its first frame and the page reads the answer
// out of shared memory afterwards: -1 not started, 0 on the browser thread,
// 1 off it. That single bit is what the whole worker experiment turns on.
static int engineThreadIsMain = -1;

void web_note_engine_thread() { engineThreadIsMain = emscripten_is_main_browser_thread() ? 1 : 0; }

int web_engine_off_main_thread() { return engineThreadIsMain < 0 ? -1 : (engineThreadIsMain ? 0 : 1); }

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
    emscripten::function("web_frame_count", &web_frame_count);
    emscripten::function("web_engine_off_main_thread", &web_engine_off_main_thread);
    emscripten::function("web_last_key_ms", &web_last_key_ms);
    emscripten::function("web_key_counter", &web_key_counter);
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

# Stamp the arrival of a keydown, here at the head of the case, where the engine
# has just taken it off SDL's queue and before any of its own handling runs.
# WebDevMenu.cpp keeps the timestamp; the page reads it and subtracts.
anchor = "            case SDL_KEYDOWN:\n"
assert content.count(anchor) == 1, "expected exactly one SDL_KEYDOWN case"
content = content.replace(anchor, anchor + "                web_note_key_arrival();\n", 1)

anchor = '#include "RetroEngine.hpp"'
assert content.count(anchor) >= 1, "RetroEngine.cpp does not include its own header"
content = content.replace(anchor, anchor + "\n\nvoid web_note_key_arrival(); // WebDevMenu.cpp", 1)

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

echo "Copying build output to $DIST_DIR/$OUT_NAME..."
mkdir -p "$DIST_DIR/$OUT_NAME"
cp "$WORK_DIR/wasm/rsdkv4.js" "$DIST_DIR/$OUT_NAME/rsdkv4.js"
cp "$WORK_DIR/wasm/rsdkv4.wasm" "$DIST_DIR/$OUT_NAME/rsdkv4.wasm"
# A pthread build also emits the worker bootstrap next to the module.
if [ "$WORKER" = "1" ] && [ -f "$WORK_DIR/wasm/rsdkv4.worker.js" ]; then
  cp "$WORK_DIR/wasm/rsdkv4.worker.js" "$DIST_DIR/$OUT_NAME/rsdkv4.worker.js"
fi

echo "Build complete. Artifacts:"
ls -la "$DIST_DIR"
