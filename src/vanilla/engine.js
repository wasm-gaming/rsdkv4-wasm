// The SDK layer — the only file in this demo that imports @wasm-gaming/rsdkv4-wasm.
//
// Everything the engine can do is re-exported here as plain functions over plain
// data, so app.js (the UI) can be deleted and rewritten from scratch without a
// single SDK call moving. If you are redesigning the interface, read this file
// once and then work only in app.js / index.html / style.css.
//
// ---------------------------------------------------------------------------
// The whole SDK surface, on one screen
// ---------------------------------------------------------------------------
//
//   import sdk from '@wasm-gaming/rsdkv4-wasm'
//   sdk.manifest                     // static description of the engine (see below)
//   const instance = await sdk.load(config)
//
// load(config) — the parts that matter for a host:
//
//   attachTo         HTMLElement   the SDK creates the <canvas> and appends it here,
//                                  then keeps it scaled to fit this box (resize +
//                                  fullscreen included). Alternative: canvasEl, if
//                                  you want to own the canvas — then sizing is yours.
//   storageNamespace string        folder under /data for this game's files
//                                  ("rsdkv4/Sonic1"). Keeps two games' saves apart.
//   dataProvider     () => bytes   lazy Data.rsdk; only called on a cache miss, so a
//                                  40 MB pack already in OPFS is never re-read.
//   assets.data      bytes         eager alternative to dataProvider.
//   options          Rsdkv4Options settings.ini in object form (see rsdkv4.options.ts):
//                                  skipStartMenu, devMenu, vsync, startingCategory…
//   persist          'opfs'|null|undefined   undefined = auto (OPFS when the page is
//                                  cross-origin isolated). null = keep nothing.
//   onEvent          (event) => {} 'ready' | 'error' from the engine.
//
// The instance:
//
//   start()                        contract no-op — the engine is already running
//                                  when load() resolves. Call it anyway.
//   pause(owner) / resume(owner)   see PAUSE_OWNER below — this is the one piece of
//                                  the API with a rule you can get wrong.
//   destroy()                      stops the loop, silences audio, flushes saves,
//                                  removes the canvas. Always call it before going
//                                  back to a launcher screen.
//   setInput(keyMap)               remap keys (manifest.input is the default preset).
//   persistent                     true when the working dir is really OPFS-backed.
//   storageNamespace               echo of the config value.
//   purgeStorage()                 delete this namespace's Data.rsdk + settings.ini.
//   game                           the engine's Start Menu as data — see below.
//   devMenu                        stage list + warp + pause.
//
// `game` and `devMenu` are RSDKv4-specific: they mirror exactly what the engine's
// own in-canvas menus do (same globals, same save file), which is what makes it
// safe to switch those menus off with `skipStartMenu` and draw them in HTML.

import sdk from '@wasm-gaming/rsdkv4-wasm'

/**
 * Static engine description: video.baseWidth/baseHeight (424×240), the default
 * key map, the assets it accepts, its options schema. Useful for a UI that wants
 * to show controls or aspect ratio without hard-coding them.
 */
export const manifest = sdk.manifest

/**
 * Who holds a pause.
 *
 * pause()/resume() take an owner string, and only the owner that paused can
 * resume. That exists because several things pause the same engine: the save
 * select screen, the pause menu, maybe the host itself. Without owners, closing
 * the pause menu would resume a game the save select was still holding, and the
 * player would hear the level start behind an overlay.
 *
 * The rule: whatever opens an overlay pauses under its own name and resumes
 * under the same name. `game.start()` clears any pause on its own, because at
 * that point the overlay that drove it is done.
 */
export const PAUSE_OWNER = {
  startScreen: 'start-screen',
  menu: 'menu',
}

/**
 * Boot the engine into `mount`.
 *
 * @param {object} config
 * @param {HTMLElement} config.mount        box the canvas is created in and scaled to
 * @param {string} config.storageNamespace  e.g. "rsdkv4/Sonic1"
 * @param {() => Promise<Uint8Array>} config.dataProvider  reads the stored Data.rsdk
 * @param {(error: Error) => void} [config.onError]
 * @returns {Promise<import('../rsdkv4/rsdkv4.sdk.js').Rsdkv4Instance>}
 */
export async function boot({ mount, storageNamespace, dataProvider, onError }) {
  const instance = await sdk.load({
    attachTo: mount,
    storageNamespace,
    dataProvider,

    // skipStartMenu turns off RSDKv4's own save-select / character-select /
    // options screens. Set it *only* because this demo draws those screens in
    // HTML (see app.js). Drop it and the engine runs its native menus instead —
    // which is a perfectly good UI decision too, and then you never need
    // `instance.game` at all.
    options: { skipStartMenu: true },

    onEvent(event) {
      if (event.type === 'error') onError?.(event.error)
    },
  })

  // Contract no-op for this engine; kept so host code stays engine-agnostic.
  instance.start()

  return instance
}

/**
 * Shut the engine down and let the page go back to a launcher screen.
 * Not calling this leaves the audio callback running and the save mirror armed.
 */
export function shutdown(instance) {
  instance?.destroy()
}

/**
 * Give keyboard focus back to the engine.
 *
 * SDL reads the keyboard from the canvas, which the SDK finds (and SDL requires
 * to be) `#canvas`. Any overlay that took focus has to hand it back on the way
 * out, or the player's arrows go nowhere. The SDK already does this on load and
 * on pointerdown; this is for closing an overlay with the keyboard.
 */
export function focusEngine() {
  document.getElementById('canvas')?.focus({ preventScroll: true })
}

// ---------------------------------------------------------------------------
// instance.game — the engine's Start Menu, as data
// ---------------------------------------------------------------------------

/** 1 = Sonic 1, 2 = Sonic 2, 0 = a pack the engine doesn't recognise. */
export function gameType(instance) {
  return instance.game.type()
}

/**
 * Playable characters from the pack's GameConfig, in engine order — the index is
 * what `startGame()` takes as `player` (0 Sonic, 1 Tails, 2 Knuckles, 3 Sonic &
 * Tails in the stock packs, but read it, don't assume it).
 *
 * An empty array means the loaded rsdkv4.wasm is older than this SDK (almost
 * always a cached copy); the SDK logs which bridge is missing.
 */
export function characters(instance) {
  return instance.game.players()
}

/**
 * The four save slots, exactly as the engine's own save select sees them, plus
 * two fields resolved here for convenience: `characterName` and `resumeStage`.
 *
 * Raw fields: { slot, empty, character, lives, score, emeralds, list, zone }.
 * `list` is an index into the stage lists (1 = regular, 3 = special) and `zone`
 * the scene inside it — which is why the human-readable name has to be looked up
 * in `stageList()`.
 */
export function saveSlots(instance) {
  const lists = stageList(instance)
  const players = characters(instance)

  return instance.game.saveSlots().map((slot) => ({
    ...slot,
    characterName: players[slot.character] ?? null,
    resumeStage: slot.empty || slot.list < 0
      ? null
      : (lists[slot.list]?.stages?.[slot.zone]?.name ?? null),
  }))
}

/**
 * Start a game the way the native menu would, and resume the engine.
 *
 * @param slot   0-3 to use that save file, or null to play without saving.
 *               A slot with data continues it (pass its own `character`);
 *               an empty slot starts a new game as `player`.
 * @param player index into `characters()`. Ignored when continuing a save.
 *
 * This also clears whatever pause was in place, so the overlay that called it
 * only has to remove itself from the DOM.
 */
export function startGame(instance, slot, player = 0) {
  instance.game.start(slot, player)
}

/** Wipe a slot back to "NEW GAME". */
export function deleteSave(instance, slot) {
  instance.game.deleteSave(slot)
}

/**
 * The engine's GAME OPTIONS screen as rows:
 *   { key, label, value, type: 'boolean' | 'enum', values?: string[] }
 * Sonic 1 and Sonic 2 expose different ones (spindash, speed cap, item boxes,
 * super forms…), so render whatever comes back rather than a fixed list.
 */
export function gameOptions(instance) {
  return instance.game.options()
}

/**
 * Write an option through to the engine and its save file — the same globals and
 * the same SData.bin the native menu writes. Values are numbers; booleans are 0/1.
 */
export function setGameOption(instance, key, value) {
  instance.game.setOption(key, typeof value === 'boolean' ? (value ? 1 : 0) : Number(value))
}

// ---------------------------------------------------------------------------
// instance.devMenu — stage list and warping
// ---------------------------------------------------------------------------

/**
 * Every stage the pack has, grouped the way RSDKv4 groups them:
 *   [{ name, stages: [{ name }] }]
 * Index 0 presentation (title screen, level select…), 1 regular, 2 bonus,
 * 3 special. Both indexes are what `warpTo()` takes.
 */
export function stageList(instance) {
  return instance.devMenu.getStageList()
}

/** Load a stage immediately. Needs the engine running (resume before warping). */
export function warpTo(instance, listIndex, stageIndex) {
  instance.devMenu.loadStage(listIndex, stageIndex)
}

/**
 * A short, useful warp list for a pause menu: the way out (title screen), the
 * game's own pickers, and the special stages.
 *
 * Each entry is found *by name* in the pack's real stage list, so a pack that
 * names things differently simply drops the entries it hasn't got instead of
 * warping somewhere random.
 *
 * @returns {Array<{ label: string, list: number, stage: number }>}
 */
export function quickWarps(instance) {
  const lists = stageList(instance)

  const byName = (listIndex, name) => {
    const stages = lists[listIndex]?.stages ?? []
    const stage = stages.findIndex((entry) => entry.name.trim().toUpperCase() === name)
    return stage < 0 ? null : { label: stages[stage].name, list: listIndex, stage }
  }

  const warps = [
    byName(0, 'TITLE SCREEN'),
    byName(1, 'STAGE MENU'),
    byName(0, 'LEVEL SELECT'),
  ].filter(Boolean)

  lists[3]?.stages?.forEach((_, index) => {
    warps.push({ label: `Special ${index + 1}`, list: 3, stage: index })
  })

  return warps
}
