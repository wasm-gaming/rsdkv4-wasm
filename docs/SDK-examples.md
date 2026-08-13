# RSDKv4 SDK — usage examples

Every example below is against the current API in
[`src/rsdkv4.sdk.ts`](../src/rsdkv4.sdk.ts). Where the SDK does something surprising,
the surprise is documented rather than hidden — those notes are marked **Gotcha**.

The SDK conforms to the [wasm-gaming engine contract](https://github.com/wasm-gaming/engine-specs):
it exports `manifest` (declarative) and `load(config)` (imperative). Everything under
`instance.game` and `instance.devMenu` is RSDKv4-specific extension, outside the contract.

---

## 1. Importing

The package is an ES module with three entry points:

```js
import sdk, { load, manifest } from '@wasm-gaming/rsdkv4-wasm'
import { DEFAULT_RSDKV4_OPTIONS, RSDKV4_UNSET } from '@wasm-gaming/rsdkv4-wasm/options'
// '@wasm-gaming/rsdkv4-wasm/manifest' → the serialized dist/manifest.json
```

In a no-build page, map the bare specifier to the built file:

```html
<script type="importmap">
  { "imports": { "@wasm-gaming/rsdkv4-wasm": "/rsdkv4/rsdkv4.sdk.js" } }
</script>
```

`rsdkv4.js` and `rsdkv4.wasm` are resolved relative to the SDK module, so they only need
to sit next to it. Override with `jsUrl` / `wasmUrl` when they don't.

## 2. Booting the engine

### The SDK owns the canvas (recommended)

```js
const instance = await sdk.load({
  attachTo: document.querySelector('#stage'),
  assets: { data: dataRsdkBytes },     // Uint8Array | ArrayBuffer | string
})
```

The SDK creates a `<canvas id="canvas">` inside `#stage` and keeps it scaled to the box
(424×240 base) across `resize` and fullscreen changes.

> **Gotcha** — `attachTo` must be a *container*, never a `<canvas>`. Passing a canvas makes
> the SDK append its own canvas *inside* it, where it is fallback content the browser never
> paints: the engine runs, invisibly.

### You own the canvas

```js
const instance = await sdk.load({
  canvasEl: document.querySelector('#my-canvas'),
  assets: { data: dataRsdkBytes },
})
```

Sizing is then entirely yours. The SDK still renames the element's `id` to `canvas` —
Emscripten's SDL2 port finds the render target with `document.querySelector('#canvas')`.

## 3. Supplying `Data.rsdk`

Precedence: **explicit asset → already persisted → lazy provider**. `load()` throws if all
three miss.

```js
// Eager: you already hold the bytes.
await sdk.load({ attachTo, assets: { data: bytes } })

// Lazy: only read on a cache miss — a pack already persisted is never re-read.
await sdk.load({
  attachTo,
  storageNamespace: 'rsdkv4/Sonic1',
  dataProvider: async () => {
    const file = await handleFromOpfs()      // a File / Blob
    return await file.arrayBuffer()
  },
})
```

> **Gotcha** — a provider must return `Uint8Array | ArrayBuffer | string`. A `File` or `Blob`
> is *not* accepted; call `.arrayBuffer()` on it.

`storageNamespace` is the per-game folder under `/data`, and it is case-sensitive: it has
to match the OPFS folder your launcher wrote (`rsdkv4/Sonic1` ≠ `rsdkv4/sonic1`).

## 4. Engine options → `settings.ini`

```js
await sdk.load({
  attachTo,
  assets: { data: bytes },
  options: {
    skipStartMenu: true,   // turn off the engine's own save/character/options screens
    devMenu: false,
    vsync: true,
    // startingCategory / startingScene / startingPlayer: 255 (RSDKV4_UNSET) = normal boot
  },
})
```

> **Gotcha** — options are only serialized when no `settings.ini` exists yet for that
> namespace. A file persisted by an earlier session wins, and your `options` are silently
> ignored. `instance.purgeStorage()` removes it so the next `load()` regenerates it.

Set `skipStartMenu: true` **only if you render the start screens yourself** from
`instance.game` (§6). Leave it off and the engine runs its own menus, which is a perfectly
good choice — then you never touch `instance.game` at all.

## 5. Lifecycle

```js
instance.start()          // contract no-op: load() already booted the engine. Takes no arguments.
instance.pause('menu')    // pause on behalf of an owner (default 'host'); stops audio too
instance.resume('menu')   // only the owner that paused can resume
instance.setInput(map)    // swap the key map (manifest.input is the default preset)
instance.destroy()        // stop the loop, silence audio, flush saves, remove the canvas
instance.reset()          // throws: RSDKv4 cannot reset in-process — destroy() and load() again
```

> **Gotcha** — `instance.start()` is the generic engine-contract lifecycle method and does
> nothing here. Starting a *game* is `instance.game.start(slot, player)` (§6). Since
> `start()` swallows any arguments, `instance.start(1, 2)` fails silently.

**Pause ownership.** The first caller to pause owns it, and only that owner's `resume()`
lifts it — so closing a pause overlay cannot resume a game that a start screen had frozen:

```js
const OWNER = { startScreen: 'start-screen', menu: 'menu' }

instance.pause(OWNER.startScreen)   // start screen freezes the engine
instance.resume(OWNER.menu)         // ignored: someone else holds the pause
instance.resume(OWNER.startScreen)  // lifts it
```

`instance.game.start()` clears any pause on its own — the overlay that called it is done.

Always `destroy()` before returning to a launcher screen: otherwise the audio callback
keeps mixing and the save-mirror timer keeps running.

## 6. `instance.game` — the engine's Start Menu as data

Available only after `load()` resolves (the engine reads its save file on the first frame).

```js
instance.game.type()        // 1 = Sonic 1, 2 = Sonic 2, 0 = unrecognised pack
instance.game.players()     // ['SONIC', 'TAILS', …] — from the pack's GameConfig, in engine order
instance.game.saveSlots()   // the four slots, exactly as the engine's own save select sees them
instance.game.start(slot, player)
instance.game.deleteSave(slot)
instance.game.options()     // the GAME OPTIONS screen as rows
instance.game.setOption(key, value)
```

### Starting a game

```js
instance.game.start(null, 0)   // play without saving, as players()[0]
instance.game.start(0, 1)      // slot 0: new game as players()[1], or continue what's there
```

| `slot` | `player` | result |
| --- | --- | --- |
| `null` | index | plays without saving, as that character |
| `0`–`3`, empty slot | index | new game in that slot, as that character |
| `0`–`3`, slot with data | *ignored* | continues the save with **its stored character** |

> **Gotcha** — `player` is a **numeric index** into `players()`, not a name. The SDK coerces
> with `player | 0`, so passing `'TAILS'` silently becomes `0` (Sonic).

> **Gotcha** — pass `null` for no-save, not `-1`. The SDK translates to the engine's `-1`
> itself; a stray `-1` in a slot variable reads as "no save" and quietly stops saving.

To change the character on a slot that already has a game, erase it first:

```js
instance.game.deleteSave(2)
instance.game.start(2, 1)   // now a new game as players()[1]
```

### Save slots

```js
for (const slot of instance.game.saveSlots()) {
  // { slot, empty, character, lives, score, emeralds, list, zone }
  // list: 1 = regular stage list, 3 = special, -1 when empty
  // zone: 0-based scene within `list` — index it against devMenu.getStageList()
}
```

Resolving the human-readable names:

```js
const lists = instance.devMenu.getStageList()
const players = instance.game.players()

const rows = instance.game.saveSlots().map((s) => ({
  ...s,
  characterName: players[s.character] ?? null,
  resumeStage: s.empty ? null : (lists[s.list]?.stages?.[s.zone]?.name ?? null),
}))
```

### Game options

Sonic 1 and Sonic 2 expose different rows, so render what comes back rather than a fixed
list. Values are numbers; booleans are `0` / `1`.

```js
for (const option of instance.game.options()) {
  // { key, label, value, type: 'boolean' | 'enum', values?: string[] }
}
instance.game.setOption('spindash', 1)
```

Writes go through to the engine's globals *and* its save file — the same path the native
menu takes.

## 7. `instance.devMenu` — stage list and warping

```js
const lists = instance.devMenu.getStageList()
// [{ name, stages: [{ name }] }] — 0 presentation, 1 regular, 2 bonus, 3 special

instance.devMenu.loadStage(1, 0)   // warp: category index, scene index
instance.devMenu.setPaused(true)   // legacy pause; always acts as owner 'host'
```

Warping needs a running engine: resume first, then load the stage.

## 8. Storage

```js
instance.persistent        // true when the working dir is really OPFS-backed
instance.storageNamespace  // echo of the config value, normalized
instance.purgeStorage()    // → { data: boolean, settings: boolean } for this namespace only
```

Save data (`SData.bin`) is mirrored to OPFS by the SDK itself — on pause, every 10 s, and on
`destroy()` — so saves survive a reload even when the working dir is the in-memory
fallback. Pass `persist: null` to keep nothing.

```js
await sdk.load({ attachTo, assets: { data }, persist: 'opfs' })  // force; warns if unavailable
await sdk.load({ attachTo, assets: { data }, persist: null })    // keep nothing
// persist omitted → auto: OPFS when the page is cross-origin isolated
```

## 9. Events

```js
await sdk.load({
  attachTo,
  assets: { data },
  onEvent(event) {
    if (event.type === 'ready') console.log('engine up')
    if (event.type === 'error') console.error(event.error)
  },
})
```

`ready` fires once the engine has run its first frame (getters are safe from then on);
`error` on an engine abort. The contract also defines `exit` and `frame` — this SDK does
not emit them yet.

## 10. A complete launcher

Reading the pack from OPFS, rendering the save select in HTML, and starting the game:

```js
import sdk from '@wasm-gaming/rsdkv4-wasm'

const OWNER = { startScreen: 'start-screen' }
let instance = null

async function play(gameId, mount) {
  instance = await sdk.load({
    attachTo: mount,
    storageNamespace: `rsdkv4/${gameId}`,
    dataProvider: async () => {
      const root = await navigator.storage.getDirectory()
      const dir = await (await root.getDirectoryHandle('rsdkv4')).getDirectoryHandle(gameId)
      const file = await (await dir.getFileHandle('Data.rsdk')).getFile()
      return await file.arrayBuffer()
    },
    options: { skipStartMenu: true },
    onEvent: (e) => { if (e.type === 'error') console.error(e.error) },
  })

  instance.start()                        // contract no-op, kept so hosts stay engine-agnostic
  instance.pause(OWNER.startScreen)       // freeze while the player picks a slot
  return { slots: instance.game.saveSlots(), players: instance.game.players() }
}

function startGame(slot, player) {
  instance.game.start(slot, player)       // resumes on its own
  document.getElementById('canvas')?.focus({ preventScroll: true })
}

function exit() {
  instance?.destroy()
  instance = null
}
```

> **Gotcha** — SDL reads the keyboard from the canvas. Any overlay that took focus has to
> hand it back (`#canvas.focus()`), or the player's arrows go nowhere.

## 11. Cross-origin isolation

OPFS-backed persistence needs the page to be cross-origin isolated (COOP/COEP). Without it
the engine still boots: the working dir falls back to in-memory WASMFS and the SDK mirrors
save data to OPFS from JS instead. `make preview` serves `dist/` with the headers;
`dist/coi.js` installs a service worker for static hosts that cannot send them.
