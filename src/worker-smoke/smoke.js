// Worker smoke test — does RSDKv4 survive moving off the browser thread?
//
// The 1.0 contract is asynchronous because the engine is meant to live in a
// worker: that is the only place OPFS sync access handles exist, and therefore
// the only place the engine can read its pack straight from persistent storage.
// Before any of that gets designed in, three questions have to be answered with
// the game actually running:
//
//   1. Does it boot?    main() on a pthread, the loop running there, and the
//                       picture on an OffscreenCanvas transferred to it.
//   2. Does it sound?   SDL's audio callback decodes Ogg by *reading from the
//                       pack*. If SDL keeps invoking that callback on the
//                       browser thread, the read happens where the file isn't.
//   3. Does it answer?  DOM events cross from the main thread to the pthread's
//                       queue — one hop per event.
//
// The same game, two builds (`dist/rsdkv4` and `dist/rsdkv4-worker`), swapped
// with a dropdown. Everything this page can measure by itself, it measures; the
// rest is your ears and your thumbs.
//
// It boots the engine directly instead of through the SDK on purpose. What is
// under test is the engine, not the 0.1 API — and the questions above are asked
// of things the SDK deliberately hides (the Module handle, where the OPFS mount
// is refused, the frame counter). Nothing here is a template for a host: read
// src/vanilla for that.

import * as storage from '../vanilla/storage.js'

const stage = document.getElementById('stage')
const logEl = document.getElementById('log')

const BUILDS = {
  // `threads`: this build was linked with -pthread and exports PThread, so the
  // page may read the thread pool from it. The baseline has neither.
  worker: { dir: '../rsdkv4-worker', label: 'worker', threads: true },
  baseline: { dir: '../rsdkv4', label: 'baseline', threads: false },
}

/** Where the engine's working dir lives inside the module FS, as in the SDK. */
const WORK_ROOT = '/data'

let Module = null
/** True once a build that exports PThread has booted — see sampleEngine(). */
let threadsExported = false
/** Engine.frameCount at the previous sample, to derive a frame rate from it. */
let lastFrames = null
let lastSampleAt = 0
let keysSeen = 0
let sceneChanges = 0

// --------------------------------------------------------------------- readout

function row(listId, key, value, cls = '') {
  const list = document.getElementById(listId)
  let dd = list.querySelector(`[data-v="${key}"]`)
  if (!dd) {
    const dt = document.createElement('dt')
    dt.textContent = key
    dd = document.createElement('dd')
    dd.dataset.v = key
    list.append(dt, dd)
  }
  dd.textContent = String(value)
  dd.className = cls
}

const log = (message) => {
  logEl.textContent = `${new Date().toLocaleTimeString()}  ${message}\n${logEl.textContent}`.slice(0, 4000)
}

const yn = (value) => (value ? 'yes' : 'no')
const cls = (value) => (value ? 'ok' : 'bad')

// ----------------------------------------------------------------- environment
//
// A pthread build needs SharedArrayBuffer, and SharedArrayBuffer needs the page
// to be cross-origin isolated. If this section is red the worker build cannot
// even instantiate, and nothing below it means anything.

const hasSab = typeof SharedArrayBuffer !== 'undefined'
const canTransfer = typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function'
row('env', 'crossOriginIsolated', yn(self.crossOriginIsolated), cls(self.crossOriginIsolated))
row('env', 'SharedArrayBuffer', yn(hasSab), cls(hasSab))
row('env', 'OffscreenCanvas', yn(typeof OffscreenCanvas !== 'undefined'), cls(typeof OffscreenCanvas !== 'undefined'))
row('env', 'transferControl', yn(canTransfer), cls(canTransfer))
row('env', 'hardwareConcurrency', navigator.hardwareConcurrency ?? '?')

// ----------------------------------------------------------------------- audio
//
// Question 2, made objective. The tap has to be installed before the engine
// creates its context, so it goes in at module scope: every node that connects
// to a destination is routed through an analyser first, and the meter reads
// real samples on their way out.
//
// Both failures are quiet, and they mean opposite things. No context on this
// thread at all means SDL moved audio to the engine thread — good news for the
// worker, reported here as `context: none`. A context that exists but stays at
// zero while music should be playing is the Ogg read failing where the pack
// isn't: that is the finding that would sink the plan as written.

let analyser = null

const originalConnect = AudioNode.prototype.connect
AudioNode.prototype.connect = function connect(destination, ...rest) {
  const context = destination?.context
  if (context && destination === context.destination) {
    if (!analyser) {
      analyser = context.createAnalyser()
      analyser.fftSize = 2048
      originalConnect.call(analyser, context.destination)
      row('audio', 'context', context.constructor.name, 'ok')
      row('audio', 'sampleRate', context.sampleRate)
      row('audio', 'state', context.state, context.state === 'running' ? 'ok' : 'warn')
      setInterval(() => row('audio', 'state', context.state, context.state === 'running' ? 'ok' : 'warn'), 1000)
      log(`audio: tapped a ${context.constructor.name} on the main thread`)
    }
    return originalConnect.call(this, analyser)
  }
  return originalConnect.call(this, destination, ...rest)
}

// Which API SDL reaches for tells us where it intends to run the callback.
const originalScriptProcessor = BaseAudioContext.prototype.createScriptProcessor
if (originalScriptProcessor) {
  BaseAudioContext.prototype.createScriptProcessor = function (...args) {
    row('audio', 'node', 'ScriptProcessor (main thread)', 'warn')
    log('audio: SDL took the ScriptProcessorNode path — callback on the main thread')
    return originalScriptProcessor.apply(this, args)
  }
}
if (globalThis.AudioWorkletNode) {
  const OriginalWorkletNode = globalThis.AudioWorkletNode
  globalThis.AudioWorkletNode = class extends OriginalWorkletNode {
    constructor(...args) {
      super(...args)
      row('audio', 'node', 'AudioWorklet', 'ok')
      log('audio: SDL took the AudioWorklet path')
    }
  }
}

row('audio', 'context', 'none yet', 'idle')

const meterFill = document.getElementById('meterFill')
let peakRms = 0

function sampleAudio() {
  if (!analyser) return
  const buffer = new Float32Array(analyser.fftSize)
  analyser.getFloatTimeDomainData(buffer)
  let sum = 0
  for (const sample of buffer) sum += sample * sample
  const rms = Math.sqrt(sum / buffer.length)
  peakRms = Math.max(peakRms, rms)
  row('audio', 'rms', rms.toFixed(4), rms > 0.0005 ? 'ok' : 'idle')
  row('audio', 'peak', peakRms.toFixed(4), peakRms > 0.0005 ? 'ok' : 'bad')
  meterFill.style.width = `${Math.min(100, rms * 400)}%`
}

// ----------------------------------------------------------------------- input
//
// Question 3. The page can only see that the key reached *it*; whether it also
// reached the engine is answered by the frame counter, which resets whenever a
// scene loads. Press Start on the title screen: if the scene changes, the input
// crossed to the engine thread. That is the objective half of "does it answer".

addEventListener(
  'keydown',
  (event) => {
    keysSeen += 1
    row('input', 'keydown seen', keysSeen)
    row('input', 'last key', event.key)
  },
  { capture: true },
)
row('input', 'keydown seen', 0, 'idle')

// ---------------------------------------------------------------------- engine

/**
 * Poll the engine from the page.
 *
 * `web_frame_count` is an embind call: it runs on *this* thread and reads
 * `Engine.frameCount` out of the shared heap. That it answers at all already
 * proves the memory is shared and the engine is alive; that the number climbs
 * proves the loop is running, and how fast it climbs is the frame rate. It
 * stands still outside a stage and resets on every scene load, so a drop is
 * reported as a scene change rather than as a stall.
 */
function sampleEngine() {
  sampleAudio()
  if (!Module) return

  // Only the worker build exports PThread, and only that build may be asked for
  // it: reaching an unexported runtime method is not an undefined read, it traps
  // and abort()s the module — no try/catch survives that. `threadsExported` is
  // set from the build that was actually booted, never guessed.
  if (threadsExported) {
    const workers = Module.PThread?.runningWorkers?.length
    row('engine', 'pthread workers', workers ?? 0, workers ? 'ok' : 'idle')
  }

  if (typeof Module.web_frame_count !== 'function') {
    row('engine', 'frames', 'no bridge — rebuild the wasm', 'bad')
    return
  }

  const frames = Module.web_frame_count()
  const now = performance.now()
  row('engine', 'frames', frames)

  if (lastFrames !== null) {
    const delta = frames - lastFrames
    const seconds = (now - lastSampleAt) / 1000
    if (delta < 0) {
      sceneChanges += 1
      row('engine', 'scene loads', sceneChanges, 'ok')
      log('engine: frame counter reset — a scene loaded, so input got through')
    } else if (seconds > 0) {
      const fps = delta / seconds
      row('engine', 'fps', fps.toFixed(1), fps > 50 ? 'ok' : fps > 1 ? 'warn' : 'idle')
    }
  }
  lastFrames = frames
  lastSampleAt = now
}

setInterval(sampleEngine, 500)

/** `mkdir -p`, which WASMFS does not give us. */
function ensureDir(module, path) {
  let current = ''
  for (const segment of path.split('/').filter(Boolean)) {
    current += `/${segment}`
    try {
      module.FS.mkdir(current)
    } catch {
      // already there
    }
  }
}

// The engine's own start menu, on purpose: it gives the human something to press
// Start on without any HTML overlay in the way, and its title screen plays music
// — questions 2 and 3 on one screen.
const SETTINGS_INI = ['[Dev]', 'EngineDebugMode=true', 'DevMenu=true', '', '[Game]', 'SkipStartMenu=false', '', '[Window]', 'VSync=true', ''].join('\n')

// ------------------------------------------------------------------------ boot

const buildSelect = document.getElementById('build')
const gameSelect = document.getElementById('game')
const bootButton = document.getElementById('boot')

async function refreshGames() {
  const games = await storage.list()
  gameSelect.innerHTML = games
    .map(
      (game) =>
        `<option value="${game.id}" ${game.installed ? '' : 'disabled'}>${game.short}${
          game.installed ? '' : ' — no pack'
        }</option>`,
    )
    .join('')
  const playable = games.find((game) => game.installed)
  bootButton.disabled = !playable
  if (!playable) log('no pack installed yet — pick a Data.rsdk with the file input')
}

document.getElementById('install').addEventListener('change', async (event) => {
  const file = event.target.files?.[0]
  if (!file) return
  // Which game a pack is for is the player's call; the dropdown says which slot
  // it lands in, exactly like the vanilla host's library does.
  const id = gameSelect.value || storage.GAMES[0].id
  await storage.install(id, file)
  log(`installed ${file.name} as ${id}`)
  await refreshGames()
})

bootButton.addEventListener('click', async () => {
  if (Module) {
    log('already booted — reload the page to try the other build')
    return
  }
  const build = BUILDS[buildSelect.value]
  const id = gameSelect.value
  bootButton.disabled = true
  buildSelect.disabled = true
  gameSelect.disabled = true
  log(`booting the ${build.label} build…`)

  // The canvas has to exist, carry id="canvas" and be in the document *before*
  // the module instantiates: SDL2 finds it by that id.
  //
  // It deliberately stays on the main thread even in the worker build. Handing
  // it to the engine thread is what OFFSCREENCANVASES_TO_PTHREAD would do, and
  // it breaks this engine: SDL2 asks EGL for its GL context, Emscripten's EGL is
  // proxied to the main thread, and a transferred canvas cannot hand out a
  // context there — InvalidStateError inside the proxy hop, no picture at all.
  // So GL calls are proxied instead, and what the fps row measures is the cost
  // of that hop.
  const canvas = document.createElement('canvas')
  canvas.id = 'canvas'
  canvas.style.maxWidth = '100%'
  canvas.style.imageRendering = 'pixelated'
  stage.append(canvas)

  const startedAt = performance.now()
  let ready = false
  try {
    const jsUrl = new URL(`${build.dir}/rsdkv4.js`, import.meta.url).href
    const wasmUrl = new URL(`${build.dir}/rsdkv4.wasm`, import.meta.url).href
    const factory = (await import(/* @vite-ignore */ jsUrl)).default

    Module = await factory({
      canvas,
      noInitialRun: true, // -sINVOKE_RUN=0: the data goes in before main()
      locateFile: (path) => (path.endsWith('.wasm') ? wasmUrl : path),
      print: (...a) => console.log('[rsdkv4]', ...a),
      printErr: (...a) => console.error('[rsdkv4]', ...a),
      onAbort: (reason) => {
        log(`ABORT: ${reason}`)
        row('engine', 'boot', 'aborted', 'bad')
      },
    })
    row('engine', 'instantiate', `${Math.round(performance.now() - startedAt)} ms`, 'ok')
    threadsExported = build.threads

    // Where OPFS stands, asked rather than assumed. web_opfs_supported() mirrors
    // the assertion inside wasmfs_create_opfs_backend(), and the call runs on the
    // *calling* thread — so even in the worker build this answers "no" from the
    // page. That is the expected result, and the reason a real mount has to be
    // issued from the engine thread instead. Reported, not fixed here.
    //
    // Through ccall rather than Module._web_opfs_supported: this build has
    // assertions on, and reaching for a name it does not export is not an
    // undefined read but an abort() that takes the whole module down.
    const opfsFromPage = Module.ccall('web_opfs_supported', 'number', [], []) === 1
    row('engine', 'OPFS from page', yn(opfsFromPage), opfsFromPage ? 'ok' : 'warn')

    const workDir = `${WORK_ROOT}/${storage.namespace(id)}`
    ensureDir(Module, workDir)

    const bytes = await storage.readBytes(id)
    Module.FS.writeFile(`${workDir}/Data.rsdk`, new Uint8Array(bytes))
    Module.FS.writeFile(`${workDir}/settings.ini`, new TextEncoder().encode(SETTINGS_INI))
    Module.FS.chdir(workDir)
    row('engine', 'pack', `${(bytes.byteLength / 1048576).toFixed(1)} MB`, 'ok')

    // With PROXY_TO_PTHREAD this is __emscripten_proxy_main: it spawns the
    // engine thread and returns immediately. Without it, main() runs here and
    // returns through Emscripten's benign unwind. Either way it only *schedules*
    // the loop — Engine::Init runs on the first frame.
    Module.callMain(['UsingCWD'])

    for (let i = 0; i < 200 && !ready; i += 1) {
      ready = Module.web_engine_ready?.() === true
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 50))
    }
  } catch (error) {
    log(`boot failed: ${error.message}`)
    console.error(error)
    row('engine', 'boot', 'failed', 'bad')
    return
  }

  const bootMs = Math.round(performance.now() - startedAt)
  row('engine', 'build', build.label, 'ok')
  row('engine', 'boot', ready ? `${bootMs} ms` : `no Engine::Init in ${bootMs} ms`, cls(ready))
  // Question 1, answered by the engine rather than inferred from the page: the
  // loop recorded which thread it woke up on before Engine::Init ran.
  const placement = Module.web_engine_off_main_thread?.()
  row(
    'engine',
    'loop thread',
    placement === 1 ? 'off the browser thread' : placement === 0 ? 'browser thread' : 'not started',
    placement === 1 ? 'ok' : placement === 0 ? 'warn' : 'bad',
  )

  log(
    ready
      ? `booted in ${bootMs} ms — now: does it move, does it sound, does it answer?`
      : 'the engine never initialised: the loop is not running where the page can see it',
  )
})

await refreshGames()
