# @wasm-gaming/rsdkv4-wasm

RSDKv4 (Retro Software Development Kit v4, Rubberduckycooly/mattConn decompilation)
compiled to WebAssembly, wrapped in a small JS SDK that conforms to the
[wasm-gaming engine contract](https://github.com/wasm-gaming/engine-specs).

**One WASM, two games.** The engine binary is game-agnostic. `Data.rsdk` is loaded
into the Emscripten filesystem *at runtime*, so the same `rsdkv4.wasm` runs both
**Sonic the Hedgehog** and **Sonic the Hedgehog 2** — the `Data.rsdk` you hand it
is what picks the game. (The old build baked `Data.rsdk` in with `--preload-file`
and had to be recompiled per game; this doesn't.)

## Contract surface

```js
import { manifest, load } from '@wasm-gaming/rsdkv4-wasm';

const engine = await load({
  canvas,                       // an <canvas id="canvas">
  assets: { data: dataRsdkBytes /*, settings: iniBytes */ },
  storageNamespace: 'sonic1',   // carpeta por juego bajo /data (OPFS/WASMFS)
  onEvent: (e) => { /* 'ready' | 'error' | 'exit' */ },
  // Where the app placed the CI-built artifacts (defaults to package-relative):
  // jsUrl, wasmUrl,
});

engine.pause();
engine.resume();
engine.setInput('rsdkv4');
engine.purgeStorage();           // borra Data.rsdk/settings.ini de este namespace
engine.destroy();
```

- `manifest` — declarative `EngineManifest` (see [src/rsdkv4.manifest.ts](src/rsdkv4.manifest.ts)):
  required `data` asset (`/Data.rsdk`), optional `settings` asset (`/settings.ini`),
  `input: "rsdkv4"` preset, 16:9 video, no save-states.
- `load(config)` → `EngineInstance` (`start`/`pause`/`resume`/`reset`/`setInput`/`destroy`).
  `reset()` is unsupported by RSDKv4 — `destroy()` and `load()` again.

### Dev menu — the launcher owns the UI
The debug/stage-select **UI is the launcher's responsibility**, not the engine's.
The engine only exposes the raw bridge as `instance.devMenu` (backed by the
`web_devmenu_*` embind functions compiled into the WASM):

```js
const engine = await load({ canvas, assets: { data } });
engine.pause();                              // freeze while a menu is open
const categories = engine.devMenu.getStageList();   // [{ name, stages: [{ name }] }]
engine.devMenu.loadStage(0, 2);              // warp to category 0 / stage 2
engine.resume();
```

The launcher decides how Escape behaves and draws its own overlay. It should
intercept Escape in the **capture phase** if it wants to repurpose it (the engine
ships with `DevMenu=false`, so the native in-canvas menu stays suppressed).

> ⚠️ A capture-phase listener on `window` that calls `stopPropagation()` also
> stops the **bubble**-phase listener SDL registers there — i.e. it takes the
> keyboard away from the game. Swallow only the keys you actually handle, and
> only while your overlay is open. (This is exactly how the shared demo
> template's pause menu used to kill the d-pad; see
> [src/demo/components/esc-menu.html](src/demo/components/esc-menu.html).)

### Start menu — the host can own that too
`instance.game` exposes RSDKv4's Start Menu as data (the `web_*` embind functions
in `WebGame.cpp`), so a host can draw its own save / character / options screens
instead of the engine's in-canvas text menus. The logic mirrors
`Debug.cpp` move for move — same globals, same `saveRAM`, same
`InitStartingStage()` — so a game started this way lands in the state the native
menu would have produced.

```js
const engine = await load({ canvas, assets: { data },
  options: { skipStartMenu: true },     // hide the engine's own screens
});

engine.game.type();          // 1 = Sonic 1, 2 = Sonic 2
engine.game.players();       // ["SONIC", "TAILS", "KNUCKLES", "SONIC AND TAILS"]
engine.game.saveSlots();     // [{ slot, empty, character, lives, score, emeralds, list, zone }]
engine.game.start(0, 1);     // slot 0 as Tails — a slot with data resumes it
engine.game.start(null, 0);  // no-save mode
engine.game.deleteSave(2);

engine.game.options();               // the engine's GAME OPTIONS screen, as data
engine.game.setOption('spindash', 1); // written through to the game's save file
```

`load()` resolves only once `Engine::Init` has run, so all of the above is safe to
call the moment it returns. The demo's [start-screens.ts](src/demo/start-screens.ts)
is a worked example.

### Pausing has an owner
`pause(owner?)` / `resume(owner?)` — the **first** caller to pause owns it, and only
that owner's `resume()` lifts it. A pause overlay therefore can't resume a game a
start screen (or the host) had already frozen:

```js
engine.pause('menu');     // overlay opens
engine.resume('menu');    // …closes: only resumes if 'menu' was the one that paused
```

Pausing stops the **audio** too: `masterPaused` only freezes the logic loop, so
without that the music kept playing over the overlay — and `destroy()` kept
playing it after the host returned to its launcher.

### Options
Engine-specific options are described in [src/rsdkv4.options.ts](src/rsdkv4.options.ts)
(`Rsdkv4Options` type + `RSDKV4_OPTIONS_SCHEMA`, mirrored into
[src/rsdkv4.manifest.ts](src/rsdkv4.manifest.ts)'s `options`). When the host doesn't pass an explicit
`settings` asset, the SDK **generates `settings.ini` from `config.options`**
(`devMenu`, `engineDebugMode`, `vsync`, `skipStartMenu`,
`startingCategory/Scene/Player`).

> `startingCategory/Scene/Player` default to **255 = unset**, which is what the
> engine reads as "boot normally". Any other value — *including 0* — makes
> `Engine::Init` skip the start-menu flow and force that stage.

### Other niceties
- **Canvas id guard** — forces `canvas.id = "canvas"` because Emscripten's SDL2
  port locates the canvas via `querySelector('#canvas')`.
- **Stale-engine self-heal** — `rsdkv4.js`/`.wasm` are big and most static hosts
  send nothing but `Last-Modified`, so browsers keep a build for hours. Fresh SDK
  against a cached engine is a miserable failure mode: the bridges it calls
  aren't there and every getter quietly answers "empty" — no save slots, no
  characters, an empty pause menu. So `load()` checks the module for the bridges
  it needs and, if any are missing, refetches once with a cache-busting query and
  says so in the console. A healthy build loads the engine exactly once.

> Audio autoplay-unlock and the gamepad→keyboard translator are cross-cutting host
> concerns (the app's shared input script); the SDK only exposes the `input`
> preset name via the manifest and `setInput()`.

## Filesystem (WASMFS / OPFS)

Built with **`-sWASMFS`** — Emscripten's modern filesystem, replacing MEMFS. The
game working dir `/data` is mounted on **OPFS** (persistent) via the `WebFS.cpp`
`web_mount_opfs` helper when the page is **cross-origin isolated** *and* the wasm
build can create the OPFS backend from the main thread (see the caveat below —
today's build can't); otherwise it falls back to the WASMFS in-memory backend so
the engine still boots. `Data.rsdk`
and the generated `settings.ini` are written there and read via CWD (the engine
is booted with the `UsingCWD` arg).

### Backend selection — `config.persist`
- `undefined` (default) — **auto**: OPFS when cross-origin isolated *and* the build
  supports the mount, else in-memory.
- `'opfs'` — **ask for** OPFS; warn + fall back to in-memory if unavailable. (It
  can't be *forced*: a build that can't mount OPFS would abort the module, so the
  SDK checks first and falls back rather than trying.)
- `null` — **force the in-memory** WASMFS backend (the MEMFS-equivalent fallback;
  non-persistent).

(`'idbfs'` isn't supported under WASMFS and is treated as in-memory.)

### Per-game storage namespace — `config.storageNamespace`
- `undefined` (default) — uses `/data/default`.
- `'sonic1'` / `'sonic2'` (recommended) — keeps each game in its own folder,
  e.g. `/data/sonic1` and `/data/sonic2`.
- Supports nested paths like `'sonic1/profile-a'`.

This prevents cross-game reuse collisions and allows purging one game's files
without touching the others.

### `/data` *is* the OPFS root
`web_mount_opfs` mounts the backend returned by `wasmfs_create_opfs_backend()`,
whose root is `navigator.storage.getDirectory()`. So the WASM path `/data/<ns>/…`
and the OPFS path `<ns>/…` a host reaches from JS are **the same file**:

| host, from JS (OPFS API)     | engine, inside WASMFS         |
| ---------------------------- | ----------------------------- |
| `rsdkv4/Sonic1/Data.rsdk`    | `/data/rsdkv4/Sonic1/Data.rsdk` |

A launcher can therefore write a player's `Data.rsdk` straight into the folder the
engine will use as its working dir and then load with
`storageNamespace: 'rsdkv4/Sonic1'` and **no `assets.data` at all** — the SDK finds
the file already persisted and skips the copy. That is what this repo's demo does
(see [Try it locally](#try-it-locally)); it keeps one copy of a ~40 MB pack instead
of two, and the game's save data lands next to it in the same folder.

### Save data survives even without the mount
The engine writes its save file (`SData.bin`) into the working dir, which is
in-memory on every build that can't mount OPFS — so game saves would die with the
page and every slot would read "NEW GAME" forever. The *host* side of OPFS has no
such limitation (the plain async API works on any main thread), so the SDK
mirrors that one file itself: it copies any stored `SData.bin` into the working
dir before the engine boots, and copies it back out on pause, on `destroy()`, and
every 10s in between. Saves therefore persist per `storageNamespace` even while
the working dir does not. `persist: null` turns the mirror off with everything else.

### Skip re-fetch when already persisted
When the working dir is OPFS-backed, the SDK checks whether `/data/Data.rsdk`
(and `settings.ini`) already exist and **reuses them instead of re-downloading**.
Precedence for `Data.rsdk`: explicit `assets.data` → persisted OPFS copy → lazy
`dataProvider()` (called only on a miss). So a host can pass a `dataProvider` that
fetches the ROM and it will only run on first load / non-isolated pages:

```js
await load({
  canvas,
  assets: {},                                  // no eager 40 MB download
  storageNamespace: 'sonic1',                  // namespace-specific cache
  dataProvider: () => fetch('/Data.rsdk').then(r => r.arrayBuffer()),
});
```

To purge only one game's persisted files:

```js
const sonic2 = await load({
  canvas,
  assets: {},
  storageNamespace: 'sonic2',
  dataProvider: () => fetch('/sonic2/Data.rsdk').then(r => r.arrayBuffer()),
});

// Removes /data/sonic2/Data.rsdk and /data/sonic2/settings.ini only.
const purged = sonic2.purgeStorage();
console.log(purged); // { data: true|false, settings: true|false }
```

> Persistence doesn't engage with the current build (see the OPFS caveat below),
> so the skip-fetch benefit isn't real yet — every load fetches.

> ⚠️ **OPFS caveat:** OPFS sync-access handles only exist in Workers, so WASMFS's
> OPFS backend spawns a proxy worker — and it **refuses to do that from the main
> browser thread** unless the build has **`-sASYNCIFY`** or **`-sJSPI`**. It
> doesn't fail softly either: `wasmfs_create_opfs_backend()` asserts, and the
> failed assert `abort()`s the module, so there is nothing left to fall back with.
> The SDK mounts by calling into the module from the page (main thread) and this
> build has neither flag, so `web_opfs_supported()` (WebFS.cpp) reports 0 and the
> SDK never attempts the mount — COOP/COEP alone changes nothing. Making it real
> means either building with Asyncify/JSPI, or `-pthread` + performing the mount
> from the engine thread; both interact with SDL2 + `emscripten_set_main_loop` and
> must be validated with a real build.

## Build

All build logic lives in the **Makefile** (`package.json` has no scripts). WASM +
dist are built in CI and attached to a Release — **not** committed.

```bash
make build        # TypeScript (make build-sdk) + WASM (make build-wasm) → dist/
make build-sdk    # TypeScript only → dist/ (fast; no Docker)
make build-wasm   # local: runs scripts/build.sh inside emscripten/emsdk (Docker)
```

- `build-lib` compiles the SDK/options/manifest (`.js` + `.d.ts`) → `dist/rsdkv4/`.
- `build-manifest` serializes the typed manifest to `dist/manifest.json`.
- `build-demo` compiles `src/demo/{demo,library}.ts` → `dist/`, copies the shared
  demo template from `@wasm-gaming/engine-specs` → `dist/demo/`, overwrites its
  launcher with `src/demo/components/launcher.html` (the two-game one), copies
  `src/demo/index.html` → `dist/index.html`, seeds `dist/settings.ini`.
- **`scripts/build.sh`** does not call Docker — it runs the WASM build steps
  directly and expects an Emscripten SDK on PATH. In CI it runs inside an
  `emscripten/emsdk` container job; locally, **`scripts/build-docker.sh`** (what
  `make build-wasm` invokes) runs it inside that container for you. build.sh clones
  `mattConn/Sonic-Decompilation-WASM`, applies the engine
  patches (init order, audio init, controller init, decoupled 120/30Hz loop, the
  `WebDevMenu` embind bridge, the `WebFS` OPFS helper) and links with
  `-sWASMFS -sINVOKE_RUN=0 -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createRSDKv4`
  + `FS`/`callMain`/`ccall` exported, **without** `--preload-file`.

Contract types are resolved from the npm package `@wasm-gaming/engine-specs`
(installed via this project's devDependencies).

### dist/ layout

```
dist/
├── rsdkv4/               # the engine package (all rsdkv4.* artifacts)
│   ├── rsdkv4.js         # Emscripten ES6 factory
│   ├── rsdkv4.wasm
│   ├── rsdkv4.sdk.js     (+ .d.ts)
│   ├── rsdkv4.options.js (+ .d.ts)
│   └── rsdkv4.manifest.js(+ .d.ts)
├── manifest.json         # declarative manifest (artifacts → rsdkv4/rsdkv4.*)
├── index.html            # demo shell (import map → ./rsdkv4/rsdkv4.sdk.js)
├── demo.js               # window.SDK + window.rsdkv4Library
├── library.js            # the two-game OPFS library (src/demo/library.ts)
├── start-screens.js      # save-select screen (src/demo/start-screens.ts)
├── assets/               # demo artwork (game logos), from src/demo/assets/
├── demo/                 # shared template (engine-specs); launcher.html and
│                         #   esc-menu.html replaced by our own copies
├── settings.ini          # seeded from src/settings.default.ini if absent
└── Data.rsdk             # unused by the demo; kept for manual experiments
```

## Try it locally

```bash
make build      # produce dist/ (TypeScript + WASM)
make preview    # serves dist/ on :8024 with COOP/COEP
# open http://localhost:8024/
```

### The launcher is a two-game library

One WASM, two games — so the demo launcher is not a ROM picker but a shelf with
one slot per game. Drop **Sonic 1's** `Data.rsdk` on one slot and **Sonic 2's** on
the other (drag-and-drop or the file picker), pick a slot, press **Play**. Each
pack is stored once, in the browser, and never uploaded:

```
OPFS root
└── rsdkv4/
    ├── Sonic1/
    │   ├── Data.rsdk      ← what you dropped
    │   ├── settings.ini   ← written by the SDK on first launch
    │   └── …              ← that game's save data
    └── Sonic2/…
```

Because [`/data` is the OPFS root](#data-is-the-opfs-root), that folder *is* the
engine's working dir: launching loads with `storageNamespace: 'rsdkv4/Sonic1'` and
no assets, so nothing is copied or re-read. **Replace** swaps the pack; **Remove**
deletes only `Data.rsdk`, leaving settings and saves for when it comes back.

A page that isn't cross-origin isolated can't reach OPFS from WASM (see the caveat
above), so the SDK falls back to an in-memory working dir and pulls the bytes
through `dataProvider()` — the library serves them from the same stored copy, so
the games still launch. Saves still survive, through the
[save-data mirror](#save-data-survives-even-without-the-mount).

### The game's own menus, in HTML

Launching goes straight to a **save-select screen** — the demo's, not the engine's
(it boots with `skipStartMenu: true`). It is laid out like Sonic Mania's: a row of
portrait cards, status on top, character in the middle, chaos emeralds along the
bottom, `NO SAVE` first. File and character are the *same* choice: **←/→ picks the
file, ↑/↓ picks the player** (Sonic, Tails, Knuckles, Sonic & Tails) on any unused
file, Enter starts. A used file starts as the character it was saved with. Everything but the game logo
(`src/demo/assets/`) is drawn in CSS, and it drives the engine through
`instance.game`, so the resulting game is the same one the native text menus
would have started.

**Escape** opens the pause overlay, which pauses the engine *and its music* and
shows only what RSDKv4 can actually do live:

- **Jump to** — buttons for the title screen, the game's stage menu, level select
  and special stages 1-8. Each closes the overlay and warps straight away, so
  there is no "now press resume" step
- **Game options** — the engine's own GAME OPTIONS (spindash, speed caps, S1
  spikes, item box set, super forms), read and written through the same globals
  and save file the native screen uses

The pieces: [src/demo/library.ts](src/demo/library.ts) (storage),
[src/demo/start-screens.ts](src/demo/start-screens.ts) (save select),
[src/demo/components/launcher.html](src/demo/components/launcher.html) (the slots),
[src/demo/components/esc-menu.html](src/demo/components/esc-menu.html) (pause overlay),
[src/demo/index.html](src/demo/index.html) (wiring to `SDK.load`).

## Live demo (GitHub Pages)

The `pages` job in [.github/workflows/build.yml](.github/workflows/build.yml)
publishes `dist/` to GitHub Pages on pushes to `main` (and manual runs). No game
data ships with it, so the live demo opens on two empty slots — drop each game's
`Data.rsdk` once and they stay in that browser.

- **One-time setup:** repo *Settings → Pages → Build and deployment → Source =
  GitHub Actions*. The workflow also calls `actions/configure-pages` with
  `enablement: true`, so first deploy can bootstrap Pages automatically when the
  repo-level Pages site does not exist yet.
- **OPFS note:** OPFS stays off and the SDK uses the in-memory WASMFS backend —
  GitHub Pages can't set COOP/COEP headers, and this build couldn't mount OPFS
  even isolated (see the filesystem caveat above).

## Project Specs

What this project is, and the constraints that shape it.

- **A contract implementation, not a game.** The deliverable is one game-agnostic
  `rsdkv4.wasm` plus an SDK conforming to
  [@wasm-gaming/engine-specs](https://github.com/wasm-gaming/engine-specs) — `manifest`
  (Layer A) and `load()` (Layer B). A host drives this engine exactly as it drives the
  other eleven.
- **Ships none of the game.** The player provides `Data.rsdk`; it never leaves the
  browser and is never committed. Which pack the host hands over is what selects Sonic 1
  or Sonic 2.
- **The engine's own values are the SDK's only private vocabulary.** They live in
  [src/rsdkv4.options.ts](src/rsdkv4.options.ts) — seven keys, mirrored as JSON Schema in
  `manifest.options` — and in the extra fields of `Rsdkv4LoadConfig`. Everything else is
  contract, documented once at the [contract
  reference](https://wasm-gaming.github.io/engine-specs/api-docs/).
- **The host owns the files; the SDK owns its folder.** The SDK reads the pack and never
  writes it. What it does write — save data, `settings.ini` — lives under the host-chosen
  `storageNamespace`.
- **Persistence needs cross-origin isolation.** OPFS sync access exists only in workers,
  so the working dir falls back to in-memory WASMFS when the page isn't isolated (or when
  the build can't create the backend from the main thread — see the filesystem caveat).
- **Everything builds from the Makefile**, `package.json` has no scripts. `dist/` is both
  the npm artifact and the Pages site: demo at the root, `/craft`, `/vanilla`, and the API
  reference at `/api-docs`.
- **Sessions are the record.** Specs and decisions live in [SESSIONS/](SESSIONS/), append-only.
- **Where it is going:** contract 1.0 replaces `{ manifest, load }` with `EngineSDK` /
  `EnginePlay` classes. The six `docs/{SDK,PLAY}-*.md` documents describe that API for this
  engine, and the migration plan is
  [SESSIONS/2026-08-14_12h35.sdk-migration-to-contract-1.0.session.md](SESSIONS/2026-08-14_12h35.sdk-migration-to-contract-1.0.session.md).

## Todos

Contract 1.0 migration — blocked on `engine-specs` unless noted:

- [ ] **Worker smoke test** (not blocked, do first): `-pthread` + `-sPROXY_TO_PTHREAD` +
      `OffscreenCanvas`, then measure audio (SDL's callback decodes Ogg straight from the
      pack) and input latency. The async 1.0 API rests on this.
- [ ] Split `Rsdkv4Options` into `Rsdkv4Config` (engine) and `Rsdkv4Options` (session).
- [ ] Manifest to 1.0: `contractVersion`, `config`, no `mountPath`, `capabilities.saves`.
- [ ] Parse `SData.bin` from JS, so `sdk.saves()` reads slots without booting the wasm.
- [ ] `Rsdkv4Play` / `Rsdkv4SDK` classes; `create()` as the only engine-specific method.
- [ ] Migrate the three hosts: `src/vanilla`, `src/craft`, `src/demo` (~65 call sites).

Independent of the migration:

- [ ] `export default { manifest, load } satisfies EngineSDK` — nothing declares conformance today.
- [ ] Emit `{ type: 'exit' }` at the end of `destroy()`.
- [ ] Don't emit `ready` when the engine never came up: today `waitForEngine()` times out
      after 4 s, warns, and reports success anyway.
- [ ] `assertManifest(manifest)` in [scripts/emit-manifest.mjs](scripts/emit-manifest.mjs).
- [ ] End-to-end browser run from a real `Data.rsdk`.

## Status

- ✅ **TS build** — compiles clean; manifest validates against the contract.
- ✅ **WASM build** (`make build-wasm`) — produces a valid ~10 MB `dist/rsdkv4/rsdkv4.wasm`
  + ES6-factory glue with the intended flags/symbols (`-sWASMFS`, `web_mount_opfs`,
  the `web_devmenu_*` embind bridge, `callMain`/`FS`/`ccall`, no `--preload-file`).
- ⏳ **End-to-end runtime in a browser** (boot from a real `Data.rsdk`) — not yet
  verified.
- ⏳ **OPFS persistence** — not engaged: WASMFS's OPFS backend can't be created on
  the main browser thread without an Asyncify/JSPI build (see the caveat above),
  so the SDK detects that and falls back to the in-memory WASMFS backend.

## License

MIT for this wrapper. The RSDKv4 decompilation and Sonic game data have their own
licenses; game data (`Data.rsdk`) is user-provided and never distributed here.
