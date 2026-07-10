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

### Options
Engine-specific options are described in [src/rsdkv4.options.ts](src/rsdkv4.options.ts)
(`Rsdkv4Options` type + `RSDKV4_OPTIONS_SCHEMA`, mirrored into
[src/rsdkv4.manifest.ts](src/rsdkv4.manifest.ts)'s `options`). When the host doesn't pass an explicit
`settings` asset, the SDK **generates `settings.ini` from `config.options`**
(`devMenu`, `engineDebugMode`, `vsync`, `startingCategory/Scene/Player`).

### Other niceties
- **Canvas id guard** — forces `canvas.id = "canvas"` because Emscripten's SDL2
  port locates the canvas via `querySelector('#canvas')`.

> Audio autoplay-unlock and the gamepad→keyboard translator are cross-cutting host
> concerns (the app's shared input script); the SDK only exposes the `input`
> preset name via the manifest and `setInput()`.

## Filesystem (WASMFS / OPFS)

Built with **`-sWASMFS`** — Emscripten's modern filesystem, replacing MEMFS. The
game working dir `/data` is mounted on **OPFS** (persistent) via the `WebFS.cpp`
`web_mount_opfs` helper when the page is **cross-origin isolated**; otherwise it
falls back to the WASMFS in-memory backend so the engine still boots. `Data.rsdk`
and the generated `settings.ini` are written there and read via CWD (the engine
is booted with the `UsingCWD` arg).

### Backend selection — `config.persist`
- `undefined` (default) — **auto**: OPFS when cross-origin isolated, else in-memory.
- `'opfs'` — **force** OPFS; warn + fall back to in-memory if unavailable.
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

> Persistence only actually engages under cross-origin isolation (see the OPFS
> caveat below), so the skip-fetch benefit needs COOP/COEP + `-pthread` to be real.

> ⚠️ **OPFS caveat (unverified):** OPFS sync-access handles only exist in Workers,
> so Emscripten proxies them to a thread — reliable OPFS needs **`-pthread`** in
> the build plus **COOP/COEP** headers on the host. This build is single-threaded,
> so today OPFS persistence is best-effort and gated on `crossOriginIsolated`.
> Adding `-pthread` interacts with SDL2 + `emscripten_set_main_loop` and must be
> validated with a real build.

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
- `build-demo` compiles `src/demo/demo.ts` → `dist/demo.js`, copies
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
├── demo.js
├── settings.ini          # seeded from src/settings.default.ini if absent
└── Data.rsdk             # dev-provided (git-ignored)
```

## Try it locally

```bash
make build                           # produce dist/ (TypeScript + WASM)
cp /path/to/Data.rsdk dist/          # git-ignored dev file the demo auto-loads
cp /path/to/settings.ini dist/       # OPTIONAL — else seeded/generated
make preview                         # serves dist/ on :8080
# open http://localhost:8080/
```

The demo fetches `./Data.rsdk` (required) and, if present, `./settings.ini`
(optional) from `dist/`, mounting both into WASMFS. Without a `Data.rsdk` file the
demo shows a pick / drag-and-drop prompt; without a `settings.ini` file the SDK
synthesizes one from `config.options`.

## Live demo (GitHub Pages)

The `pages` job in [.github/workflows/build.yml](.github/workflows/build.yml)
publishes `dist/` to GitHub Pages on pushes to `main` (and manual runs). Since
`Data.rsdk` is git-ignored, the live demo opens on the pick / drag-and-drop
prompt — drop a `Data.rsdk` to boot.

- **One-time setup:** repo *Settings → Pages → Build and deployment → Source =
  GitHub Actions*. The workflow also calls `actions/configure-pages` with
  `enablement: true`, so first deploy can bootstrap Pages automatically when the
  repo-level Pages site does not exist yet.
- **OPFS note:** GitHub Pages can't set COOP/COEP headers, so the page isn't
  cross-origin isolated — OPFS stays off and the SDK uses the in-memory WASMFS
  backend (see the filesystem caveat above).

## Status

- ✅ **TS build** — compiles clean; manifest validates against the contract.
- ✅ **WASM build** (`make build-wasm`) — produces a valid ~10 MB `dist/rsdkv4/rsdkv4.wasm`
  + ES6-factory glue with the intended flags/symbols (`-sWASMFS`, `web_mount_opfs`,
  the `web_devmenu_*` embind bridge, `callMain`/`FS`/`ccall`, no `--preload-file`).
- ⏳ **End-to-end runtime in a browser** (boot from a real `Data.rsdk`) — not yet
  verified.
- ⏳ **OPFS persistence** — gated on `crossOriginIsolated`; almost certainly needs
  a `-pthread` build + COOP/COEP to actually engage (see the caveat above). Until
  then the SDK falls back to the in-memory WASMFS backend.

## License

MIT for this wrapper. The RSDKv4 decompilation and Sonic game data have their own
licenses; game data (`Data.rsdk`) is user-provided and never distributed here.
