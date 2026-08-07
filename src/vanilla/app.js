// The UI — the part you are meant to rewrite.
//
// Nothing here knows how the engine works: it calls engine.js (the SDK layer)
// and storage.js (the player's game packs). No styling, no markup beyond the two
// divs in index.html, no helpers — every screen is a string written into #ui,
// and every interaction is one of the three delegated listeners at the bottom.
//
// The only rules worth keeping when you replace it are marked "SDK rule".
//
// Flow: library → boot → save select → playing (ESC = pause menu)

import * as engine from './engine.js'
import * as storage from './storage.js'

const ui = document.getElementById('ui')
const stage = document.getElementById('stage')

/** The running engine, or null on the library screen. */
let instance = null
/** 'start' | 'menu' | null — what #ui is currently showing on top of the game. */
let overlayMode = null

// --------------------------------------------------------------------- screens

async function showLibrary() {
  const games = await storage.list()
  ui.innerHTML = games
    .map(
      (game) => `<p>${game.title} (${game.year}) —
        ${game.installed ? `${(game.size / 1048576).toFixed(1)} MB` : 'no Data.rsdk yet'}
        <input type="file" accept=".rsdk" data-install="${game.id}">
        ${game.installed
          ? `<button data-play="${game.id}">Play</button>
             <button data-remove="${game.id}">Remove</button>`
          : ''}
      </p>`,
    )
    .join('')
}

async function play(id) {
  ui.textContent = 'Loading…'
  try {
    instance = await engine.boot({
      mount: stage,
      storageNamespace: storage.namespace(id),
      dataProvider: () => storage.readBytes(id),
      onError: console.error,
    })
  } catch (error) {
    console.error(error)
    ui.textContent = `Could not start: ${error.message}`
    return
  }
  // The engine booted with skipStartMenu, so something has to start a game.
  showSaveSelect()
}

/** Save select: a slot with a game continues it, an empty one needs a character. */
function showSaveSelect() {
  instance.pause(engine.PAUSE_OWNER.startScreen)
  overlayMode = 'start'

  const players = engine.characters(instance)
  const pick = (slot) =>
    `<select data-player="${slot}">
       ${players.map((name, i) => `<option value="${i}">${name}</option>`).join('')}
     </select>
     <button data-start="${slot}">Start</button>`

  ui.innerHTML =
    `<p>No save ${pick('none')}</p>` +
    engine
      .saveSlots(instance)
      .map((slot) =>
        slot.empty
          ? `<p>Save ${slot.slot + 1} — new game ${pick(slot.slot)}</p>`
          : `<p>Save ${slot.slot + 1} — ${slot.resumeStage ?? 'in progress'},
               ${slot.characterName}, ${slot.lives} lives, ${slot.score} pts,
               ${slot.emeralds} emeralds
               <button data-continue="${slot.slot}">Continue</button>
               <button data-erase="${slot.slot}">Erase</button></p>`,
      )
      .join('')
}

/** Pause menu: the engine's own game options, stage warps and the way out. */
function showMenu() {
  instance.pause(engine.PAUSE_OWNER.menu)
  overlayMode = 'menu'

  ui.innerHTML =
    `<p>
      <button data-action="resume">Resume</button>
      <button data-action="saves">Save select</button>
      <button data-action="exit">Exit</button>
    </p>` +
    `<p>${engine
      .quickWarps(instance)
      .map((warp, i) => `<button data-warp="${i}">${warp.label}</button>`)
      .join(' ')}</p>` +
    engine
      .gameOptions(instance)
      .map((option) =>
        option.type === 'boolean'
          ? `<p><label>
               <input type="checkbox" data-option="${option.key}" ${option.value ? 'checked' : ''}>
               ${option.label}</label></p>`
          : `<p><label>${option.label}
               <select data-option="${option.key}">
                 ${option.values
                   .map((v, i) => `<option value="${i}" ${i === option.value ? 'selected' : ''}>${v}</option>`)
                   .join('')}
               </select></label></p>`,
      )
      .join('')
}

function closeOverlay() {
  // SDK rule: resume under the owner that paused. The engine ignores a resume
  // from anyone else, which is what stops the pause menu from resuming a game
  // the save select is still holding.
  if (overlayMode === 'menu') instance.resume(engine.PAUSE_OWNER.menu)
  if (overlayMode === 'start') instance.resume(engine.PAUSE_OWNER.startScreen)
  overlayMode = null
  ui.innerHTML = ''
  // SDK rule: SDL reads the keyboard from the canvas, so hand focus back.
  engine.focusEngine()
}

function exit() {
  // SDK rule: destroy() before leaving, or the audio callback keeps mixing and
  // the save mirror keeps running behind the launcher.
  engine.shutdown(instance)
  instance = null
  overlayMode = null
  showLibrary()
}

// --------------------------------------------------------------------- events

ui.addEventListener('click', async (event) => {
  const target = event.target.dataset

  if (target.play) return play(target.play)
  if (target.remove) {
    await storage.remove(target.remove)
    return showLibrary()
  }

  if (target.action === 'resume') return closeOverlay()
  if (target.action === 'saves') {
    closeOverlay()
    return showSaveSelect()
  }
  if (target.action === 'exit') return exit()

  if (target.warp) {
    // Warping needs a running engine, so close (resume) first and load after.
    const warp = engine.quickWarps(instance)[target.warp]
    closeOverlay()
    return engine.warpTo(instance, warp.list, warp.stage)
  }

  if (target.erase) {
    engine.deleteSave(instance, Number(target.erase))
    return showSaveSelect() // re-read the slots; the pause stays where it is
  }

  // Starting resumes the engine on its own, so clear the mode first or
  // closeOverlay() would issue a second, stale resume.
  if (target.continue) {
    const slot = engine.saveSlots(instance).find((s) => s.slot === Number(target.continue))
    engine.startGame(instance, slot.slot, slot.character) // a save keeps its character
    overlayMode = null
    return closeOverlay()
  }
  if (target.start) {
    const player = Number(ui.querySelector(`select[data-player="${target.start}"]`).value)
    engine.startGame(instance, target.start === 'none' ? null : Number(target.start), player)
    overlayMode = null
    return closeOverlay()
  }
})

ui.addEventListener('change', async (event) => {
  const { install, option } = event.target.dataset

  if (install && event.target.files[0]) {
    await storage.install(install, event.target.files[0])
    showLibrary()
  } else if (option) {
    // Booleans come off the checkbox, enums as the chosen index.
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value
    engine.setGameOption(instance, option, value)
  }
})

// Escape toggles the pause menu. Capture + preventDefault so the key never
// reaches the canvas (SDL would hand it to the game). The save select keeps
// Escape to itself: it is the only way into a game, so it has no "cancel".
window.addEventListener(
  'keydown',
  (event) => {
    if (event.key !== 'Escape' || !instance) return
    event.preventDefault()
    if (overlayMode === 'start') return
    if (overlayMode === 'menu') closeOverlay()
    else showMenu()
  },
  true,
)

showLibrary()
