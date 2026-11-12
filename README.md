# @wasm-gaming/rsdkv4-wasm

RSDKv4 (Retro Software Development Kit v4, Rubberduckycooly/mattConn decompilation)
compiled to WebAssembly, wrapped in a small JS SDK that conforms to the
[wasm-gaming engine contract](https://github.com/wasm-gaming/engine-specs).

**One WASM, two games.** The engine binary is game-agnostic. `Data.rsdk` is loaded
into the Emscripten filesystem *at runtime*, so the same `rsdkv4.wasm` runs both
**Sonic the Hedgehog** and **Sonic the Hedgehog 2** — the `Data.rsdk` you hand it
is what picks the game. (The old build baked `Data.rsdk` in with `--preload-file`
and had to be recompiled per game; this doesn't.)

## Install

```bash
npm install @wasm-gaming/rsdkv4-wasm
```

One dependency comes with it: `@wasm-gaming/engine-specs`, the engine contract. The
built SDK carries the contract's runtime beside it (`dist/rsdkv4/engine-specs.js`) and
imports it relatively, so the package loads from any static server — **no bundler and
no import map needed**. Serve `dist/rsdkv4/` as is and import `rsdkv4.sdk.js`.

## Contract surface

The SDK implements the [wasm-gaming engine contract](https://github.com/wasm-gaming/engine-specs)
1.0: a class with a static identity, configured by chaining, that opens a live session.

```js
import Rsdkv4SDK from '@wasm-gaming/rsdkv4-wasm';

Rsdkv4SDK.id;        // 'rsdkv4' — also this engine's folder in OPFS
Rsdkv4SDK.version;   // '0.3.0'

const play = await new Rsdkv4SDK()
  .config({ startMenu: 'host' })               // engine: who draws the start screens
  .assets({ data: () => fetchDataRsdk() })     // Data.rsdk — bytes, or a thunk called only on a miss
  .storage({ namespace: 'sonic-1' })           // → OPFS rsdkv4/sonic-1/
  .on('saves', ({ detail }) => paintSlots(detail))
  .on('error', ({ detail }) => report(detail))
  .mount(document.querySelector('#stage'))     // a <canvas> is used as is; anything else gets one inside
  .start({ slot: 0, player: 1 });              // session: slot 0 as Tails

await play.restart({ slot: 2 });
await play.destroy();                          // stops audio, flushes the save, releases the canvas
```

The four payloads, each read with `await sdk.config()` (a descriptor per key: value,
default, enum, description, `live`) and written with `sdk.config({ … })`:

| payload | keys |
| --- | --- |
| `config` (engine) | `startMenu` (`'native'` \| `'host'`), `devMenu`, `engineDebugMode`, `vsync`, `jsUrl`, `wasmUrl` |
| `options` (session) | `slot`, `player`, `stage`, `buttons` |
| `assets` | `data` (Data.rsdk, required), `settings` (settings.ini, optional — generated from `config` otherwise) |
| `storage` | `namespace`, `persist` (`'opfs'` \| `null`) |

Types: `Rsdkv4Config`, `Rsdkv4Options`, `Rsdkv4Assets`, `Rsdkv4Storage` and the full
spec as data in `RSDKV4_SPEC` ([src/rsdkv4.options.ts](src/rsdkv4.options.ts)). CI holds
the class to the contract with one line: `RSDKV4_ENGINE: EngineSDKConstructor<Rsdkv4Payloads>`.

Events: the contract's `start`, `error`, `exit`, `pause`, `resume`, plus `saves`
(the slots, emitted when `SData.bin` changed and was persisted).

`jsUrl` / `wasmUrl` default to `rsdkv4.js` / `rsdkv4.wasm` next to `rsdkv4.sdk.js`; a
host that serves them elsewhere sets them in `config`.

### Start menu — the host can own it

With `config({ startMenu: 'host' })` the engine's own save / character / options screens
are skipped and `play.game` exposes them as data (the `web_*` embind functions in
`WebGame.cpp`, mirroring `Debug.cpp` move for move, so a game started this way lands in
the state the native menu would have produced):

```js
play.game.type();             // 1 = Sonic 1, 2 = Sonic 2
play.game.players();          // ["SONIC", "TAILS", "KNUCKLES", "SONIC AND TAILS"]
play.game.saveSlots();        // [{ slot, empty, character, lives, score, emeralds, list, zone }]
play.game.start(0, 1);        // slot 0 as Tails — a slot with data resumes it
play.game.start(null, 0);     // no-save mode
play.game.deleteSave(2);
play.game.options();          // the GAME OPTIONS screen, as data
play.game.setOption('spindash', 1);
```

`start()` resolves only once `Engine::Init` has run, so all of the above is safe to call
the moment it does.

### Dev menu — the host owns the UI

The stage-select **UI is the host's**; the engine exposes the bridge as `play.devMenu`
(`getStageList()`, `loadStage(category, stage)`, `setPaused()`, `open()`). The engine
ships with `devMenu: false`, so the native in-canvas menu stays suppressed.

> ⚠️ A capture-phase listener on `window` that calls `stopPropagation()` also stops the
> bubble-phase listener SDL registers there — i.e. it takes the keyboard away from the
> game. Swallow only the keys you handle, and only while your overlay is open.

### Pausing has an owner

`play.pause(owner?)` / `play.resume(owner?)` — the **first** caller to pause owns it,
and only that owner's `resume()` lifts it, so a pause overlay can't resume a game a
start screen had already frozen. Pausing stops the audio too.

### Input

`play.input.claim(buttons)` / `play.input.release()` (same as `options({ buttons })`)
let a host drive the fourteen buttons instead of the engine reading the keyboard.

### Other niceties

- **Canvas id guard** — Emscripten's SDL2 port finds the canvas with
  `querySelector('#canvas')`, so the SDK gives the canvas that id.
- **Stale-engine self-heal** — fresh SDK against a browser-cached older wasm would make
  every getter answer "empty". The SDK checks the module for the bridges it needs and,
  if any are missing, refetches once past the HTTP cache and says so in the console.

## Filesystem (WASMFS / OPFS)

Built with **`-sWASMFS`**. WASMFS `/data` is the OPFS root, mounted when the page is
cross-origin isolated *and* the build can create the OPFS backend from the main thread;
otherwise it falls back to the in-memory backend so the engine still boots.

### Every file lives in the engine's own folder

```
OPFS root (= WASMFS /data)
└── rsdkv4/              ← Rsdkv4SDK.id, added by the SDK
    └── <namespace>/     ← storage({ namespace }), default "default"
        ├── Data.rsdk
        ├── settings.ini
        └── SData.bin
```

The host picks the namespace; **the engine owns the root**. No namespace can reach
another engine's files or climb out of `rsdkv4/`: segments are cleaned (`.` and `..`
dropped, characters outside `[A-Za-z0-9._-]` → `_`), and anything unusable becomes
`default`. `play.storagePath` gives the resolved path (`'rsdkv4/sonic-1'`), which is
also the OPFS path a host walks with `navigator.storage.getDirectory()`:

| host, from JS (OPFS API)        | engine, inside WASMFS              |
| ------------------------------- | ---------------------------------- |
| `rsdkv4/sonic-1/Data.rsdk`      | `/data/rsdkv4/sonic-1/Data.rsdk`   |

So a launcher can **install** a game by writing `Data.rsdk` into
`rsdkv4/<namespace>/` and later start it with `storage({ namespace })` and no
`assets.data` at all — the SDK finds the persisted copy and skips the copy. One ~40 MB
pack, not two, and the save lands next to it. `storagePath(engineId, namespace)` is
exported for hosts that need the path before a session exists.

**Upgrading from 0.2.x:** a namespace starting with `rsdkv4/` (the old convention,
e.g. `'rsdkv4/Sonic1'`) has the prefix stripped once, with a console warning, so its
files stay where they were — pass `'Sonic1'`. Files from the old top-level `default/`
folder (`Data.rsdk`, `settings.ini`, `SData.bin`) are **copied** into
`rsdkv4/default/` the first time the default namespace boots; the old folder is left
untouched, since other engines used `default/` too.

### Backend selection — `storage.persist`

- `undefined` (default) — **auto**: OPFS when cross-origin isolated *and* the build
  supports the mount, else in-memory.
- `'opfs'` — **ask for** OPFS; warn and fall back to in-memory if unavailable.
- `null` — force in-memory, and switch off the save mirror: nothing is kept.

### Save data survives even without the mount

On every build that can't mount OPFS the working dir is in-memory, so `SData.bin` would
die with the page. The host-side OPFS API has no such limitation, so the SDK mirrors that
one file itself: in before boot, out on pause, on `destroy()`, when the page is hidden,
and every 10 s — always to `rsdkv4/<namespace>/SData.bin`, and `saves` fires when it moved.

### Skip re-fetch when already persisted

Precedence for `Data.rsdk`: explicit bytes in `assets.data` → a copy already in
`rsdkv4/<namespace>/` → the `assets.data` thunk (called only on a miss). So a host can
hand over a thunk that downloads the pack and it only runs the first time.

## Build

All build logic lives in the **Makefile** (`package.json` has no scripts). WASM +
dist are built in CI and attached to a Release — **not** committed.

```bash
make build        # TypeScript (make build-sdk) + WASM (make build-wasm) → dist/
make build-sdk    # TypeScript only → dist/ (fast; no Docker)
make build-wasm   # local: runs scripts/build.sh inside emscripten/emsdk (Docker)
```

- `build-lib` compiles the SDK and options (`.js` + `.d.ts`) → `dist/rsdkv4/`.
- `build-specs` copies the contract's runtime to `dist/rsdkv4/engine-specs.js` and rewrites
  the SDK's import to it (`scripts/localize-specs.mjs`), so the package is self-contained.
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

The contract is the one dependency: `@wasm-gaming/engine-specs` (types from the package,
runtime copied into `dist/rsdkv4/`). `make test` type-checks the SDK and runs `tests/`
against the built package.

### dist/ layout

```
dist/
├── rsdkv4/               # the engine package (all rsdkv4.* artifacts)
│   ├── rsdkv4.js         # Emscripten ES6 factory
│   ├── rsdkv4.wasm
│   ├── rsdkv4.sdk.js     (+ .d.ts)
│   ├── rsdkv4.options.js (+ .d.ts)
│   └── engine-specs.js   # the contract's runtime, imported relatively by the SDK
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

Because [every file lives in the engine's own folder](#every-file-lives-in-the-engines-own-folder),
that folder *is* the engine's working dir: launching starts with `storage({ namespace: 'Sonic1' })` and
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
  [@wasm-gaming/engine-specs](https://github.com/wasm-gaming/engine-specs) 1.0 —
  `Rsdkv4SDK extends EngineSDKBase`. A host drives this engine exactly as it drives the
  others.
- **Works on its own.** Clone, `npm ci`, `make build-sdk test`: no other wasm-gaming
  repo needed. engine-specs is the one dependency, and its runtime ships inside
  `dist/rsdkv4/`, so the package needs no bundler or import map.
- **Ships none of the game.** The player provides `Data.rsdk`; it never leaves the
  browser and is never committed. Which pack the host hands over is what selects Sonic 1
  or Sonic 2.
- **The engine's own values are the SDK's only private vocabulary.** They live in
  [src/rsdkv4.options.ts](src/rsdkv4.options.ts) — `RSDKV4_SPEC`, the four payloads as
  data. Everything else is
  contract, documented once at the [contract
  reference](https://wasm-gaming.github.io/engine-specs/api-docs/).
- **The host owns the files; the SDK owns its folder.** Everything lives in
  `rsdkv4/<namespace>/` (WASMFS and OPFS alike): the engine adds `rsdkv4/`, the host only
  picks `<namespace>`. The SDK reads the pack and never writes it; what it does write —
  save data, `settings.ini` — lands in the same folder.
- **Persistence needs cross-origin isolation.** OPFS sync access exists only in workers,
  so the working dir falls back to in-memory WASMFS when the page isn't isolated (or when
  the build can't create the backend from the main thread — see the filesystem caveat).
- **Everything builds from the Makefile**, `package.json` has no scripts. `dist/` is both
  the npm artifact and the Pages site: demo at the root, `/craft`, `/vanilla`, and the API
  reference at `/api-docs`.
- **RECORD/ is the record.** Specs and decisions live in [RECORD/](RECORD/): `.WIP.md` append-only, `.completed.md` read-only.
- **The reference engine.** The other wasm-gaming engines migrate to this layout, and the
  [play.germade](https://github.com/jgermade/play.germade) launcher consumes it first — see
  [RECORD/2026-11-12.standalone-package-and-wasmfs-engine-namespace.WIP.md](RECORD/2026-11-12.standalone-package-and-wasmfs-engine-namespace.WIP.md).

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
