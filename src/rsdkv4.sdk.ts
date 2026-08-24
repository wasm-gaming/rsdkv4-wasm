/**
 * The engine package's entry point: an `EngineSDK` for RSDKv4.
 *
 * ```ts
 * import Rsdkv4SDK from '@wasm-gaming/rsdkv4-wasm';
 *
 * const play = await new Rsdkv4SDK()
 *   .mount(document.querySelector('#stage'))
 *   .assets({ data: () => library.readBytes('Sonic2') })
 *   .storage({ namespace: 'rsdkv4/Sonic2' })
 *   .config({ startMenu: 'host' })
 *   .on('saves', ({ detail }) => paintSlots(detail))
 *   .start({ slot: 0 });
 * ```
 *
 * Everything a host drives is the contract's, and documented there: the four payloads
 * with their descriptors, `mount`, `on`/`off`, `start`, `restart`, `destroy`. What is
 * this engine's own lives in two places — {@link Rsdkv4Config} and friends, which say
 * what the payloads accept *here*, and the extra members of {@link Rsdkv4Play} below:
 * {@link Rsdkv4Play.game} and {@link Rsdkv4Play.devMenu}, for a host that draws
 * RSDKv4's start screens itself, owner-aware {@link Rsdkv4Play.pause}, and
 * {@link Rsdkv4Play.input}, for a host that would rather drive the buttons than let
 * the engine read the keyboard.
 *
 * One game-agnostic `rsdkv4.wasm` runs both Sonic 1 and Sonic 2 — the difference is
 * only which `Data.rsdk` the host hands over in `assets.data`, written into the
 * filesystem at runtime (not baked with `--preload-file`).
 *
 * Filesystem: built with `-sWASMFS`. The working dir is mounted on **OPFS** when the
 * page is cross-origin isolated *and* the build can create the OPFS backend from the
 * main thread (an Asyncify/JSPI build — today's is not, see `WebFS.cpp`); otherwise it
 * falls back to the WASMFS in-memory backend, which boots fine but forgets everything.
 * That fallback is why the SDK mirrors `SData.bin` into OPFS itself: see
 * {@link Rsdkv4Storage.persist}.
 *
 * @module
 * @see [The engine contract](https://wasm-gaming.github.io/engine-specs/api-docs/)
 */

import { EnginePlayBase, EngineSDKBase, EventEmitter } from '@wasm-gaming/engine-specs';
import type {
  EngineInit,
  EngineSDKConstructor,
  EventsOf,
  PayloadKind,
  PromisePlay,
  PropertiesDefinition,
  PropertyDefinition,
} from '@wasm-gaming/engine-specs';
import {
  RSDKV4_BUTTONS,
  RSDKV4_SPEC,
  type Rsdkv4Asset,
  type Rsdkv4AssetData,
  type Rsdkv4Assets,
  type Rsdkv4Buttons,
  type Rsdkv4Config,
  type Rsdkv4Options,
  type Rsdkv4Payloads,
  type Rsdkv4Stage,
  type Rsdkv4Storage,
  type RsdkSaveSlot,
} from './rsdkv4.options.js';

export type {
  Rsdkv4Asset,
  Rsdkv4AssetData,
  Rsdkv4Assets,
  Rsdkv4Button,
  Rsdkv4Buttons,
  Rsdkv4Config,
  Rsdkv4Events,
  Rsdkv4InputDefaults,
  Rsdkv4Options,
  Rsdkv4Payloads,
  Rsdkv4Stage,
  Rsdkv4Storage,
  RsdkSaveSlot,
} from './rsdkv4.options.js';
export { RSDKV4_BUTTONS, RSDKV4_INPUT, RSDKV4_SPEC } from './rsdkv4.options.js';

/** The core events unioned with this engine's own — what `on`/`off` accept. */
export type Rsdkv4Events_ = EventsOf<Rsdkv4Payloads>;

const WORK_ROOT = '/data';
const DEFAULT_STORAGE_NAMESPACE = 'default';

/** RSDKv4's save file, written next to the game data in the working dir. */
const SAVE_FILE = 'SData.bin';

/**
 * Emscripten's SDL2 port locates the canvas via `document.querySelector('#canvas')`,
 * so the element the game draws into has to carry this id.
 */
const CANVAS_ID = 'canvas';

/**
 * The picture's native size, which is what the SDK scales to fit its mount.
 *
 * A module constant rather than a manifest field: `EngineManifest` left the contract
 * in 0.3.0, and this was one of only two things the SDK ever read back out of it.
 */
export const RSDKV4_VIDEO = { baseWidth: 424, baseHeight: 240, aspect: '16:9' } as const;

/**
 * The embind bridges this SDK drives the engine through. All of them ship in the same
 * rsdkv4.wasm, so a module missing any one of them is an artifact older than this SDK
 * rather than a build variant.
 */
const ENGINE_BRIDGES = [
  'web_engine_ready',
  'web_game_type',
  'web_get_players',
  'web_get_save_slots',
  'web_get_game_options',
  'web_start_game',
  'web_audio_stop',
  'web_devmenu_get_stage_list',
  'web_input_set_source',
] as const;

/**
 * The name the engine's `web_input_pull()` looks the reader up under, on the module
 * object itself rather than on a global: two engines on one page have two modules,
 * and a global would have them fighting over one claim.
 */
const INPUT_PULL_HOOK = '__rsdkv4_input_pull';

/** How often a pull that keeps throwing is allowed to say so. See {@link Rsdkv4Play}. */
const INPUT_ERROR_INTERVAL_MS = 1000;

/** The Emscripten module. Untyped on purpose: it is generated glue, not our surface. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EmscriptenModule = any;

// ---------------------------------------------------------------- small helpers

function toUint8(x: unknown): Uint8Array | null {
  if (x == null) return null;
  if (typeof x === 'string') return new TextEncoder().encode(x);
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new TypeError('rsdkv4: an asset must be Uint8Array | ArrayBuffer | string');
}

/** Bytes for an asset, calling the thunk form only when we get this far. */
async function resolveAsset(asset: Rsdkv4Asset | undefined): Promise<Uint8Array | null> {
  if (asset == null) return null;
  return toUint8(typeof asset === 'function' ? await asset() : asset);
}

/** Normalize a host-provided storage namespace into a safe relative path. */
function normalizeStorageNamespace(namespace: unknown): string {
  if (typeof namespace !== 'string' || !namespace.trim()) return DEFAULT_STORAGE_NAMESPACE;

  const cleaned = namespace
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, '_'))
    .filter(Boolean)
    .join('/');

  return cleaned || DEFAULT_STORAGE_NAMESPACE;
}

/** The plain values behind a descriptor table — what the engine actually needs. */
function valuesOf<T>(described: PropertiesDefinition<T>): T {
  const out: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(
    described as Record<string, PropertyDefinition<unknown>>,
  )) {
    out[key] = property.value;
  }
  return out as T;
}

/**
 * Serialize {@link Rsdkv4Config} into RSDKv4's settings.ini format.
 *
 * The `Starting*` trio is written as 255 — the engine's "unset" — and never anything
 * else. That is not a leftover: anything else there, **including 0**, makes
 * `Engine::Init` skip its normal boot flow and force a stage (see Userdata.cpp). The
 * session's own `stage` is applied after boot instead, through the engine's stage
 * loader, which is why it survives a `restart()`.
 */
function buildSettingsIni(config: Rsdkv4Config): string {
  return [
    '[Dev]',
    `EngineDebugMode=${config.engineDebugMode ? 'true' : 'false'}`,
    `DevMenu=${config.devMenu ? 'true' : 'false'}`,
    'StartingCategory=255',
    'StartingScene=255',
    'StartingPlayer=255',
    '',
    '[Game]',
    `SkipStartMenu=${config.startMenu === 'host' ? 'true' : 'false'}`,
    '',
    '[Window]',
    `VSync=${config.vsync ? 'true' : 'false'}`,
    '',
  ].join('\n');
}

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------- the wasm filesystem

/** Best-effort mkdir -p for the Emscripten FS layer. */
function ensureDir(Module: EmscriptenModule, path: string): void {
  const parts = path.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    try {
      Module.FS.mkdir(current);
    } catch {
      /* already exists */
    }
  }
}

/** True if `path` exists in the (mounted) filesystem. */
function fileExists(Module: EmscriptenModule, path: string): boolean {
  try {
    Module.FS.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this build can mount OPFS at all, asked of the wasm itself.
 *
 * WASMFS's `wasmfs_create_opfs_backend()` spawns a proxy worker synchronously, which it
 * refuses to do on the main browser thread without Asyncify/JSPI — it *asserts*, and a
 * failed assert calls `abort()`, which tears the module down for good. That is past the
 * point where a try/catch around the call can save us, so we have to know before
 * calling. `web_opfs_supported` (WebFS.cpp) mirrors the same condition; builds predating
 * that helper simply answer "no".
 */
function opfsMountSupported(Module: EmscriptenModule): boolean {
  const probe = Module._web_opfs_supported;
  if (typeof probe !== 'function') return false;
  try {
    return probe() !== 0;
  } catch {
    return false;
  }
}

/**
 * Mount the game working dir, honouring {@link Rsdkv4Storage.persist}. Returns whether
 * the resulting mount is persistent.
 *
 * Cross-origin isolation is necessary but not sufficient: the mount also needs a build
 * whose OPFS backend can run from where we call it (see {@link opfsMountSupported}), so
 * both gates apply before we touch `web_mount_opfs`.
 */
function mountWorkingDir(
  Module: EmscriptenModule,
  persist: Rsdkv4Storage['persist'],
): { persistent: boolean } {
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  const wantsOpfs = persist === 'opfs' || (persist === undefined && isolated);

  if (wantsOpfs && typeof Module.ccall === 'function' && opfsMountSupported(Module)) {
    try {
      const rc = Module.ccall('web_mount_opfs', 'number', ['string'], [WORK_ROOT]);
      if (rc === 0) return { persistent: true };
    } catch {
      /* fall through to in-memory */
    }
  }
  if (persist === 'opfs') {
    console.warn(
      '[rsdkv4] OPFS requested but unavailable (needs a cross-origin isolated page and an Asyncify/JSPI build) — using in-memory WASMFS',
    );
  }
  ensureDir(Module, WORK_ROOT);
  return { persistent: false };
}

/**
 * OPFS handle for `<namespace>/`, reached with the plain (async) OPFS API from JS —
 * which, unlike the WASM side's sync access handles, works on the main thread of any
 * page. Returns null when OPFS isn't available at all.
 */
async function opfsNamespaceDir(
  namespace: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  try {
    let dir = await navigator.storage.getDirectory();
    for (const segment of namespace.split('/').filter(Boolean)) {
      dir = await dir.getDirectoryHandle(segment, { create });
    }
    return dir;
  } catch {
    return null; // missing (create: false), or blocked
  }
}

/**
 * Wait for `Engine::Init`, which runs on the engine's first frame (main.cpp's
 * main_loop), not inside `callMain`. Gives up after ~4s rather than hanging the host:
 * everything still works, the first read just comes back empty.
 */
async function waitForEngine(Module: EmscriptenModule, timeoutMs = 4000): Promise<boolean> {
  if (typeof Module.web_engine_ready !== 'function') return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (Module.web_engine_ready()) return true;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  console.warn('[rsdkv4] engine did not report ready within %dms', timeoutMs);
  return false;
}

function engineBridgeComplete(Module: EmscriptenModule): boolean {
  return ENGINE_BRIDGES.every((name) => typeof Module?.[name] === 'function');
}

// ---------------------------------------------------------------- this engine's own surface

/** RSDKv4-specific bridge for a host's debug/stage-select UI. */
export interface RsdkDevMenuBridge {
  getStageList(): Array<{ name: string; stages: Array<{ name: string }> }>;
  loadStage(categoryIdx: number, stageIdx: number): void;
  setPaused(paused: boolean): void;
}

/**
 * A row of the engine's GAME OPTIONS screen (differs between Sonic 1 and 2), as the
 * engine reports it — with `value` as the raw number it stores.
 *
 * The same rows also come back through `play.options()` as descriptors, where a
 * boolean row reads as a boolean and an enum row as one of its choice labels. This is
 * the untranslated view, for a host that wants it.
 */
export interface RsdkGameOption {
  key: string;
  label: string;
  value: number;
  type: 'boolean' | 'enum';
  /** Choice labels, for `type: 'enum'` (item box sets). */
  values?: string[];
}

/**
 * The engine's Start Menu as data, so a host can render save-slot / character /
 * game-option screens itself. Everything here mirrors what RSDKv4's own in-canvas menu
 * does — see WebGame.cpp.
 */
export interface RsdkGameBridge {
  /** 1 = Sonic 1, 2 = Sonic 2, 0 = unrecognised pack. */
  type(): number;
  /** Playable characters from the pack's GameConfig, in engine order. */
  players(): string[];
  saveSlots(): RsdkSaveSlot[];
  /**
   * Start a game the way the native menu would: a slot with data continues it, an
   * empty slot starts a new game as `player`, and `slot: null` plays without saving.
   * Resumes the engine if the SDK had it paused.
   *
   * This is the index-taking form. `play.restart({ slot, player })` is the same thing
   * through the contract, with the character named rather than numbered.
   */
  start(slot: number | null, player?: number): void;
  /** Wipe a slot back to "NEW GAME". */
  deleteSave(slot: number): void;
  options(): RsdkGameOption[];
  /** Set an option; written through to the engine and its save file, as the engine does. */
  setOption(key: string, value: number): void;
}

/**
 * Input ownership, named — the same thing as `options({ buttons })` and
 * `options({ buttons: null })`, for a host that would rather say what it means.
 *
 * See {@link Rsdkv4Options.buttons} for what a claim costs the host: keyup on focus
 * loss, the gamepad, and remembering to release.
 */
export interface RsdkInputBridge {
  /**
   * Take input over. The object is kept by reference and read once per tick — write
   * to it, do not replace it.
   *
   * All fourteen keys of {@link Rsdkv4Buttons} must be present and nothing else may
   * be: a missing key would read `false` for ever, and a misspelled one would be
   * written to and never read. Both throw here instead.
   */
  claim(buttons: Rsdkv4Buttons): PromisePlay<Rsdkv4Payloads>;
  /** Hand input back; the engine polls SDL again from the next tick. */
  release(): PromisePlay<Rsdkv4Payloads>;
  /** Whether a claim is held. The `options()` descriptor deliberately will not say. */
  readonly claimed: boolean;
}

/**
 * What `start()` and `restart()` hand back: the contract's chainable promise, narrowed
 * so that awaiting it gives this engine's {@link Rsdkv4Play} rather than the contract's
 * `EnginePlay` — which is what puts {@link Rsdkv4Play.game} within reach without a cast.
 *
 * Chaining (`.mount(…)`, `.options(…)`) returns the contract's own `PromisePlay`, so
 * put the `await` at the end of the chain to keep the narrowing.
 */
export interface Rsdkv4Session extends PromisePlay<Rsdkv4Payloads> {
  then<TResult1 = Rsdkv4Play, TResult2 = never>(
    onfulfilled?: ((value: Rsdkv4Play) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
}

// ---------------------------------------------------------------- the live engine

/**
 * The running engine.
 *
 * Most of it is the contract's, inherited: the four getter/setter pairs, the cumulative
 * merge, the chainable promise, the event channel, and `destroy()`. What this class
 * adds is the four hooks the base leaves to an engine — {@link open}, {@link close},
 * {@link mounted}, {@link patched} — plus the members below, which have no contract
 * equivalent and exist because RSDKv4 has a start menu worth drawing from HTML.
 */
export class Rsdkv4Play extends EnginePlayBase<Rsdkv4Payloads> {
  #module: EmscriptenModule | null = null;
  /** In flight, so two concurrent `restart()`s do not boot two engines. */
  #booting: Promise<EmscriptenModule> | null = null;
  #destroyed = false;

  #canvas: HTMLCanvasElement | null = null;
  /** False when the host handed us its own canvas: then we neither size nor remove it. */
  #ownsCanvas = false;
  /** The element the picture has to fit inside, in CSS pixels. */
  #box: HTMLElement | null = null;
  #boxObserver: ResizeObserver | null = null;

  #persistent = false;
  #namespace = DEFAULT_STORAGE_NAMESPACE;
  #workDir = `${WORK_ROOT}/${DEFAULT_STORAGE_NAMESPACE}`;
  #mirrorSaves = true;
  #saveTimer: ReturnType<typeof setInterval> | null = null;
  /** Last bytes mirrored out, so the `saves` event means "changed" and not "checked". */
  #lastSave: Uint8Array | null = null;

  /**
   * Pause state, with an owner.
   *
   * `masterPaused` only freezes the logic loop — the audio callback keeps mixing, so a
   * paused engine went on playing its music behind whatever the host put on top.
   * Pausing therefore has to stop the sound too.
   *
   * The owner matters because pause/resume has several callers: a pause overlay, a
   * start screen, the host itself. Closing an overlay must not resume a game something
   * else had already frozen, so the *first* pause claims ownership and only that
   * owner's `resume()` lifts it.
   */
  #pauseOwner: string | null = null;

  /**
   * The host's button object while it holds a claim, by reference — read on the
   * engine's callback, never copied.
   */
  #buttons: Rsdkv4Buttons | null = null;
  /** The reader handed to the engine, kept so the same function can be uninstalled. */
  #pull: (() => number) | null = null;
  /** Throttle state for a pull that throws. See {@link Rsdkv4Play.#readButtons}. */
  #pullErrorKey: string | null = null;
  #pullErrorAt = 0;
  #pullErrors = 0;

  constructor(init?: EngineInit<Rsdkv4Payloads>, events?: EventEmitter<Rsdkv4Events_>) {
    // The spec goes up rather than being declared as a field: a subclass field
    // initialiser runs after `super()`, which would be too late for the base to seed
    // state from it.
    super(RSDKV4_SPEC, init, events);
  }

  // ---- The hooks the contract's base class leaves to an engine ----

  /**
   * Open or reopen a session. The first call brings the wasm up; every call after that
   * reuses it, because RSDKv4 cannot power-cycle in process and does not need to — a
   * session is a save slot, a character and a stage, and all three are reachable on a
   * running engine.
   */
  protected override async open(options: Rsdkv4Options): Promise<void> {
    await this.#ensureBooted();

    // Re-applied from the merged state rather than from a patch, which is what makes a
    // claim survive `restart()`: the engine's own input source was just reset by the
    // boot (or never set, on a reopen), and the host's object is still the one it was.
    if (options.buttons !== undefined) this.#applyButtons(options.buttons);

    // Absence is "boot the way the engine normally would", so an empty options bag
    // leaves the engine wherever it came up — its own start menu, usually.
    if (options.player !== undefined || options.slot !== undefined) {
      this.game.start(options.slot ?? null, this.#playerIndex(options.player));
    }
    if (options.stage) {
      this.devMenu.loadStage(options.stage.category | 0, options.stage.scene | 0);
    }
  }

  /**
   * Stop and release. The base emits `exit` once this resolves.
   *
   * There is no coming back: RSDKv4 cannot be restarted in process, so a later
   * `start()` on the same factory reports that rather than quietly doing nothing.
   */
  protected override async close(): Promise<void> {
    this.#destroyed = true;

    if (this.#saveTimer !== null) {
      clearInterval(this.#saveTimer);
      this.#saveTimer = null;
    }

    const Module = this.#module;
    if (Module) {
      // Before anything else: the engine is about to be pumped a few more times on its
      // way down, and there is no reason for those ticks to reach into a host object
      // whose owner has already been told the session is over.
      this.#applyButtons(null);

      // Last chance to keep whatever the player earned this session.
      if (this.#mirrorSaves) await this.#mirrorSaveData();

      try {
        Module.pauseMainLoop?.();
      } catch {
        /* engine already down */
      }
      this.#applyPaused(true);
      // Freezing the loop does not silence the audio callback — without this the music
      // kept playing after the host went back to its launcher.
      try {
        Module.web_audio_stop?.();
      } catch {
        /* engine already down */
      }
    }

    this.#teardownCanvas();
    this.#module = null;
    this.#booting = null;
  }

  /**
   * Where the picture goes. Called by the base before the first `open()`, which is what
   * guarantees the canvas exists before Emscripten's SDL2 port goes looking for it.
   *
   * Hand over a `<canvas>` and it is used as-is, untouched apart from the id SDL needs;
   * hand over any other element and the SDK creates a canvas inside it and keeps it
   * scaled to fit. Reparenting a live engine is legal — the same canvas moves.
   */
  protected override async mounted(target: HTMLElement): Promise<void> {
    if (this.#canvas) {
      this.#reparent(target);
      return;
    }

    const provided = target instanceof HTMLCanvasElement ? target : null;
    const canvas = provided ?? document.createElement('canvas');
    this.#ownsCanvas = provided === null;
    this.#canvas = canvas;
    this.#box = this.#ownsCanvas ? target : canvas;

    // Emscripten's SDL2 port locates the canvas via document.querySelector('#canvas').
    if (canvas.id !== CANVAS_ID) {
      if (canvas.id) {
        console.warn(
          `[rsdkv4] renaming the render target's id from "${canvas.id}" to "${CANVAS_ID}" — SDL looks the canvas up by that id.`,
        );
      }
      canvas.id = CANVAS_ID;
    }

    if (this.#ownsCanvas) {
      canvas.style.display = 'block';
      canvas.style.maxWidth = '100%';
      canvas.style.maxHeight = '100%';
      canvas.style.height = 'auto';
      canvas.classList.add('emscripten');
      target.appendChild(canvas);
    }

    // A canvas is not in the tab order and `focus()` on one is a silent no-op until it
    // has a tabindex. -1 makes it focusable without adding a tab stop.
    if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '-1');
    // …and the focus ring would draw a browser-blue box around the picture.
    canvas.style.outline = 'none';

    canvas.addEventListener('contextmenu', this.#swallowContextMenu);
    canvas.addEventListener('pointerdown', this.#onPointerDown);
    window.addEventListener('resize', this.#onResize);
    // Fullscreen transitions need a refit too.
    document.addEventListener('fullscreenchange', this.#onFullscreenChange);
    if (typeof ResizeObserver !== 'undefined' && this.#box) {
      this.#boxObserver = new ResizeObserver(this.#onResize);
      this.#boxObserver.observe(this.#box);
    }

    this.#fitPicture();
  }

  /**
   * A payload changed on a running engine. Only the GAME OPTIONS rows are `live` here —
   * `config` is `settings.ini`, read once at boot, and `player`/`slot`/`stage` are what
   * a `restart()` is for.
   */
  protected override async patched(kind: PayloadKind, patch: object): Promise<void> {
    if (kind !== 'options') return;

    // Ahead of the engine check, unlike everything below it: a claim written onto an
    // engine that has not booted yet is still a claim, and a malformed one should be
    // rejected by the call that made it rather than by the boot three lines later.
    //
    // `undefined` and `null` are not the same key here, and must not be collapsed:
    // absence means "leave the claim as it is" — which is what keeps a later
    // `options({ stage })` from dropping a claim on its way past — and only `null`
    // releases.
    const buttons = (patch as Rsdkv4Options).buttons;
    if (buttons !== undefined) this.#applyButtons(buttons);

    if (!this.#module) return;

    const rows = this.game.options();
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'player' || key === 'slot' || key === 'stage' || key === 'buttons') continue;
      const row = rows.find((candidate) => candidate.key === key);
      if (!row) {
        console.warn(
          `[rsdkv4] "${key}" is not a game option this pack declares — ignoring. Read options() for the ones it does.`,
        );
        continue;
      }
      this.game.setOption(row.key, toEngineOption(row, value));
    }
  }

  // ---- The one place this engine does not simply inherit ----

  /**
   * The session's descriptors, enriched with what only a loaded pack can say: the
   * playable characters, the stage list, and the engine's own GAME OPTIONS rows.
   *
   * The base builds descriptors from a spec fixed at construction, which is right for
   * every other payload and cannot work for this one — Sonic 1 and Sonic 2 do not offer
   * the same characters or the same options, and neither is knowable before
   * `Data.rsdk` is read. Before the engine is up this answers the static spec, which is
   * still enough for a host to know the keys exist.
   */
  override options(): Promise<PropertiesDefinition<Rsdkv4Options>>;
  override options(patch: Partial<Rsdkv4Options>): PromisePlay<Rsdkv4Payloads>;
  override options(
    patch?: Partial<Rsdkv4Options>,
  ): Promise<PropertiesDefinition<Rsdkv4Options>> | PromisePlay<Rsdkv4Payloads> {
    // `arguments.length`, not `patch === undefined`: `options(undefined)` is a write of
    // nothing, not a read.
    if (arguments.length === 0) return this.#describeOptions();
    return super.options(patch as Partial<Rsdkv4Options>);
  }

  async #describeOptions(): Promise<PropertiesDefinition<Rsdkv4Options>> {
    const described = (await super.options()) as Record<string, PropertyDefinition<unknown>>;
    // The claim never reads back, engine or no engine. The base would have written the
    // host's live object into `value` here, and this getter is what a host serialises
    // to save its settings and what it reads to paint a settings screen — neither of
    // which fourteen booleans that change sixty times a second belong in.
    // `play.input.claimed` is the honest question, and it is a different one.
    described.buttons = { ...described.buttons, value: null };
    if (!this.#module) return described as PropertiesDefinition<Rsdkv4Options>;

    const out: Record<string, PropertyDefinition<unknown>> = { ...described };

    const players = this.game.players();
    if (players.length) out.player = { ...out.player, enum: players };

    const stages = flattenStages(this.devMenu.getStageList());
    if (stages.length) out.stage = { ...out.stage, enum: stages };

    for (const row of this.game.options()) {
      if (
        row.key === 'player' ||
        row.key === 'slot' ||
        row.key === 'stage' ||
        row.key === 'buttons'
      ) {
        console.warn(`[rsdkv4] the pack declares a game option named "${row.key}" — shadowed`);
        continue;
      }
      out[row.key] = {
        value: fromEngineOption(row),
        description: row.label,
        live: true,
        enum: row.type === 'boolean' ? [false, true] : (row.values ?? []),
      };
    }

    return out as PropertiesDefinition<Rsdkv4Options>;
  }

  override restart(options?: Partial<Rsdkv4Options>): Rsdkv4Session {
    return super.restart(options) as Rsdkv4Session;
  }

  // ---- Members with no contract equivalent ----

  /**
   * Pause, on behalf of `owner`. The first caller to pause owns it and only that
   * owner's `resume()` lifts it, so a pause overlay cannot resume a game a start
   * screen — or the host — had already frozen. Audio stops with the engine.
   *
   * Emits the contract's `pause` event, whose detail carries the owner.
   */
  pause(owner: string = 'host'): void {
    if (this.#pauseOwner !== null) return; // whoever got there first keeps the claim
    this.#pauseOwner = owner;
    this.#applyPaused(true);
    // A pause is a natural checkpoint for the save mirror.
    if (this.#mirrorSaves) void this.#mirrorSaveData();
    this.emit('pause', { owner });
  }

  resume(owner: string = 'host'): void {
    if (this.#pauseOwner !== owner) return; // someone else's pause — leave it alone
    this.#pauseOwner = null;
    this.#applyPaused(false);
    this.emit('resume', { owner });
  }

  /** Who is holding the engine paused, or null. */
  get pausedBy(): string | null {
    return this.#pauseOwner;
  }

  /** True when the working dir is OPFS-backed rather than in-memory. */
  get persistent(): boolean {
    return this.#persistent;
  }

  /** The normalised {@link Rsdkv4Storage.namespace} this session actually used. */
  get namespace(): string {
    return this.#namespace;
  }

  /**
   * Input ownership, named. `play.input.claim(buttons)` and `play.input.release()`
   * are exactly `options({ buttons })` and `options({ buttons: null })` — same state,
   * same survival across `restart()`, same everything.
   */
  get input(): RsdkInputBridge {
    // Captured, because `this` inside an object literal's getter is the literal. A
    // host that holds on to `play.input` and asks later still gets today's answer.
    const play = this;
    return {
      claim: (buttons: Rsdkv4Buttons) => this.options({ buttons }),
      release: () => this.options({ buttons: null }),
      get claimed(): boolean {
        return play.#buttons !== null;
      },
    };
  }

  // ---- Host-driven input ----

  /**
   * Claim or release, on the engine and here. The only writer of {@link #buttons}.
   *
   * Order matters in both directions: the reader is installed before the engine is
   * told to use it, and the engine is told to stop before it is taken away — so there
   * is never a tick where the engine is pulling at something that is not there.
   */
  #applyButtons(buttons: Rsdkv4Buttons | null): void {
    if (buttons !== null) validateButtons(buttons);

    const Module = this.#module;
    this.#buttons = buttons;

    // Before a boot there is nothing to tell; `open()` re-applies from the merged
    // state once the engine is up, which is the same path a `restart()` takes.
    if (!Module) return;

    if (typeof Module.web_input_set_source !== 'function') {
      console.error(
        '[rsdkv4] web_input_set_source is missing from this build of rsdkv4.wasm — host-driven input needs an engine built from this SDK\'s build.sh. Rebuild it (`make build-wasm`); the engine keeps polling the keyboard until then.',
      );
      return;
    }

    if (buttons === null) {
      Module.web_input_set_source(0);
      delete Module[INPUT_PULL_HOOK];
      this.#pull = null;
      this.#resetPullErrors();
      return;
    }

    this.#pull ??= () => this.#readButtons();
    Module[INPUT_PULL_HOOK] = this.#pull;
    Module.web_input_set_source(1);
  }

  /**
   * The per-tick read. Called from the engine, at the top of its input pass, through
   * `web_input_pull()` — never from a timer and never from anywhere else.
   *
   * **Keep it on the engine's callback.** A read inside a reactive effect would make
   * all fourteen buttons dependencies of that effect (jq79 attributes every read
   * through a store's `get` trap to whichever effect is running), and every keypress
   * would wake it. The call stack here is always rAF → wasm → EM_JS → this, where no
   * effect can be running, and that is an invariant to preserve rather than a
   * coincidence to rely on.
   */
  #readButtons(): number {
    const buttons = this.#buttons;
    if (!buttons) return 0;

    try {
      let mask = 0;
      // Indexed, not `Object.entries`: the array's order is the engine's bit order,
      // and a host object's key order is its own business.
      for (let bit = 0; bit < RSDKV4_BUTTONS.length; bit++) {
        if (buttons[RSDKV4_BUTTONS[bit]]) mask |= 1 << bit;
      }
      this.#resetPullErrors();
      return mask;
    } catch (error) {
      this.#reportPullError(error);
      // Everything released, never the last good mask: a repeated mask with a
      // direction held leaves the character running into a pit on its own.
      return 0;
    }
  }

  /**
   * Announce a failing pull at most once a second, with a count.
   *
   * This runs sixty times a second, so an unthrottled `emit` would bury the page. It
   * does **not** release the claim: a transient fault recovers on its own, whereas
   * releasing would change input ownership behind the host's back.
   *
   * With a plain object nothing here can fire. It exists because the API accepts any
   * object and a Proxy runs host code on every read — a store nulled by a component
   * that unmounted without releasing, a revoked `Proxy.revocable`, a `get` trap whose
   * effect scope has been torn down. Claim-time validation covers none of those: it
   * validated once, over a reference that was live at the time.
   */
  #reportPullError(error: unknown): void {
    const key = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    // performance.now() rather than a timer: nothing to schedule, nothing to clear,
    // and the comparison is already in the hand.
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.#pullErrors++;

    if (key !== this.#pullErrorKey || now - this.#pullErrorAt >= INPUT_ERROR_INTERVAL_MS) {
      const windowMs = this.#pullErrorKey === null ? 0 : now - this.#pullErrorAt;
      this.emit(
        'error',
        Object.assign(
          new Error(
            `rsdkv4: reading the host's buttons failed (${this.#pullErrors}× in ${Math.round(windowMs)}ms) — input is dead until it recovers, and the claim is still held. Release it with options({ buttons: null }) if the host is gone. Cause: ${key}`,
          ),
          { cause: error },
        ),
      );
      this.#pullErrorKey = key;
      this.#pullErrorAt = now;
      this.#pullErrors = 0;
    }
  }

  /** Forget the streak, so a relapse announces itself immediately rather than in a second. */
  #resetPullErrors(): void {
    if (this.#pullErrorKey === null) return;
    this.#pullErrorKey = null;
    this.#pullErrorAt = 0;
    this.#pullErrors = 0;
  }

  /** RSDKv4's Start Menu as data. Available once the engine is up. */
  get game(): RsdkGameBridge {
    const Module = this.#requireModule();
    const parse = <T>(fn: unknown, fallback: T, what: string): T => parseJson(fn, fallback, what);
    return {
      type: () => (typeof Module.web_game_type === 'function' ? Module.web_game_type() : 0),
      players: () => parse(Module.web_get_players, [] as string[], 'web_get_players'),
      saveSlots: () =>
        parse(Module.web_get_save_slots, [] as RsdkSaveSlot[], 'web_get_save_slots'),
      options: () =>
        parse(Module.web_get_game_options, [] as RsdkGameOption[], 'web_get_game_options'),
      setOption: (key, value) => {
        Module.web_set_game_option?.(String(key), value | 0);
      },
      deleteSave: (slot) => {
        Module.web_delete_save?.(slot | 0);
        if (this.#mirrorSaves) void this.#mirrorSaveData();
      },
      start: (slot, player = 0) => {
        Module.web_start_game?.(slot == null ? -1 : slot | 0, player | 0);
        // Whatever drove this is done with the engine — hand it back.
        this.#pauseOwner = null;
        this.#applyPaused(false);
      },
    };
  }

  /** The engine's stage list and loader. Available once the engine is up. */
  get devMenu(): RsdkDevMenuBridge {
    const Module = this.#requireModule();
    return {
      getStageList: () =>
        parseJson(Module.web_devmenu_get_stage_list, [], 'web_devmenu_get_stage_list'),
      loadStage: (categoryIdx, stageIdx) => {
        Module.web_devmenu_load_stage?.(categoryIdx | 0, stageIdx | 0);
      },
      setPaused: (paused) => {
        if (paused) this.pause('host');
        else this.resume(this.#pauseOwner ?? 'host');
      },
    };
  }

  // ---- Bringing the engine up ----

  #requireModule(): EmscriptenModule {
    if (!this.#module) {
      throw new Error('rsdkv4: the engine is not running — await start() before reaching for it');
    }
    return this.#module;
  }

  #ensureBooted(): Promise<EmscriptenModule> {
    if (this.#destroyed) {
      throw new Error(
        'rsdkv4: this engine has been destroyed and cannot be restarted in process — build a new Rsdkv4SDK',
      );
    }
    // A boot that failed must not poison the next attempt. The common failure is a
    // host that started before handing over `assets.data` — it fixes that and calls
    // `start()` again, and caching the rejection would tell it "no Data.rsdk" forever.
    this.#booting ??= this.#boot().catch((error: unknown) => {
      this.#booting = null;
      this.#module = null;
      throw error;
    });
    return this.#booting;
  }

  async #boot(): Promise<EmscriptenModule> {
    const canvas = this.#canvas;
    if (!canvas) {
      throw new Error('rsdkv4: mount(target) before start() — the engine draws into a canvas');
    }

    const config = valuesOf(await this.config());
    const assets = valuesOf(await this.assets());
    const storage = valuesOf(await this.storage());

    const Module = await this.#instantiate(canvas, config);
    this.#module = Module;

    // Mount the working dir first, so we can see what is already persisted (OPFS)
    // before deciding whether to pull assets.
    this.#persistent = mountWorkingDir(Module, storage.persist).persistent;
    this.#namespace = normalizeStorageNamespace(storage.namespace);
    this.#workDir = `${WORK_ROOT}/${this.#namespace}`;
    this.#mirrorSaves = storage.persist !== null;
    ensureDir(Module, this.#workDir);

    await this.#writeAssets(Module, assets, config);

    // `persist: null` means the host wants nothing kept, so honour it; otherwise pull
    // any previous SData.bin in before the engine reads it.
    if (this.#mirrorSaves) await this.#restoreSaveData(Module);

    Module.FS.chdir(this.#workDir);

    // Run main() from the working dir. simulate_infinite_loop schedules the rAF loop
    // and returns via a benign unwind Emscripten swallows.
    Module.callMain(['UsingCWD']);

    // callMain only *schedules* the loop: Engine::Init runs on the first frame, and
    // until it has, there is no game config, stage list or saveRAM to read. Waiting
    // here means the bridges answer the moment start() resolves.
    await waitForEngine(Module);

    this.#focusCanvas();

    // The engine writes SData.bin at its own pace (new game, checkpoint, options
    // change), so copy it out on a slow timer as well as on the way down.
    if (this.#mirrorSaves) {
      this.#saveTimer = setInterval(() => void this.#mirrorSaveData(), 10_000);
    }

    return Module;
  }

  async #instantiate(canvas: HTMLCanvasElement, config: Rsdkv4Config): Promise<EmscriptenModule> {
    const jsUrl = config.jsUrl ?? new URL('./rsdkv4.js', import.meta.url).href;
    const wasmUrl = config.wasmUrl ?? new URL('./rsdkv4.wasm', import.meta.url).href;

    const load = async (bust?: string): Promise<EmscriptenModule> => {
      const withBust = (url: string): string => {
        if (!bust) return url;
        const parsed = new URL(url, location.href);
        parsed.searchParams.set('_', bust);
        return parsed.href;
      };

      const mod = await import(/* @vite-ignore */ withBust(jsUrl));
      return mod.default({
        canvas,
        noInitialRun: true, // built with -sINVOKE_RUN=0; we mount data before main()
        locateFile: (path: string) => (path.endsWith('.wasm') ? withBust(wasmUrl) : path),
        print: (...a: unknown[]) => console.log('[rsdkv4]', ...a),
        printErr: (...a: unknown[]) => console.error('[rsdkv4]', ...a),
        onAbort: (reason: unknown) => {
          this.emit('error', new Error(`rsdkv4 aborted: ${reason}`));
        },
      });
    };

    let Module = await load();

    // Self-heal a stale engine.
    //
    // rsdkv4.js/.wasm are big and served by most static hosts with nothing but
    // Last-Modified, so a browser will happily keep a build for hours. The symptom is
    // nasty: fresh SDK code against an old engine, where the bridges this SDK calls
    // simply don't exist and every getter quietly answers "empty" — no save slots, no
    // characters, an empty pause menu. Rather than leave that to the reader's cache
    // hygiene, notice it and fetch once past the cache.
    if (!engineBridgeComplete(Module)) {
      console.warn(
        '[rsdkv4] the engine that loaded is missing bridges this SDK needs — refetching past the HTTP cache',
      );
      Module = await load(String(Date.now()));
      if (!engineBridgeComplete(Module)) {
        console.error(
          '[rsdkv4] still missing engine bridges after a cache-busting reload — rsdkv4.wasm is genuinely older than this SDK; rebuild it (`make build-wasm`)',
        );
      }
    }

    return Module;
  }

  /** Data.rsdk and settings.ini into the working dir. See {@link Rsdkv4Assets}. */
  async #writeAssets(
    Module: EmscriptenModule,
    assets: Rsdkv4Assets,
    config: Rsdkv4Config,
  ): Promise<void> {
    const dataPath = `${this.#workDir}/Data.rsdk`;
    const settingsPath = `${this.#workDir}/settings.ini`;

    // The pack — the expensive one, so a persisted copy short-circuits the thunk.
    if (fileExists(Module, dataPath)) {
      const explicit = typeof assets.data === 'function' ? null : await resolveAsset(assets.data);
      if (explicit) Module.FS.writeFile(dataPath, explicit);
      else {
        console.log(
          `[rsdkv4] Data.rsdk already in persistent storage (${this.#namespace}) — skipping fetch`,
        );
      }
    } else {
      const bytes = await resolveAsset(assets.data);
      if (!bytes) {
        throw new Error(
          'rsdkv4: no Data.rsdk — hand one over as assets.data (bytes or a thunk), or point storage.namespace at a persisted copy',
        );
      }
      Module.FS.writeFile(dataPath, bytes);
    }

    // The settings — cheap, and regenerated every boot so `config` is never shadowed
    // by a file an earlier session left behind. The engine never writes it back (its
    // writeSettings() is #ifndef __EMSCRIPTEN__), so there is nothing to lose.
    const settings = await resolveAsset(assets.settings);
    Module.FS.writeFile(settingsPath, settings ?? new TextEncoder().encode(buildSettingsIni(config)));
  }

  // ---- The save mirror ----

  /**
   * Pull a previously mirrored SData.bin into the wasm before the engine reads it.
   *
   * The working dir is in-memory whenever the OPFS *mount* is unavailable (which is
   * every build without Asyncify/JSPI — see {@link mountWorkingDir}), so SData.bin
   * would die with the page and every slot would read "NEW GAME" forever. The host-side
   * OPFS API has no such limitation, so the SDK copies the file in here and back out as
   * it changes.
   */
  async #restoreSaveData(Module: EmscriptenModule): Promise<void> {
    const dir = await opfsNamespaceDir(this.#namespace, false);
    if (!dir) return;
    try {
      const file = await (await dir.getFileHandle(SAVE_FILE)).getFile();
      if (file.size > 0) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        Module.FS.writeFile(`${this.#workDir}/${SAVE_FILE}`, bytes);
        this.#lastSave = bytes;
      }
    } catch {
      /* no save yet */
    }
  }

  /**
   * Copy SData.bin out of the wasm into `<namespace>/`, and announce it if it moved.
   *
   * The division of labour the session settled on: the SDK owns getting the bytes out
   * of the wasm and into the namespace both sides already agree on; a host owns
   * reading, parsing and painting them. `saves` is what tells it to look again — which
   * is why it fires on a change and not on every check.
   */
  async #mirrorSaveData(): Promise<void> {
    const Module = this.#module;
    if (!Module) return;

    // Explicitly over an ArrayBuffer, not the default ArrayBufferLike: OPFS's
    // `write()` will not take a view that might be backed by a SharedArrayBuffer,
    // and on a cross-origin isolated page that is not a hypothetical distinction.
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = Module.FS.readFile(`${this.#workDir}/${SAVE_FILE}`);
    } catch {
      return; // the engine hasn't written one
    }
    if (sameBytes(bytes, this.#lastSave)) return;

    const dir = await opfsNamespaceDir(this.#namespace, true);
    if (dir) {
      try {
        const handle = await dir.getFileHandle(SAVE_FILE, { create: true });
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
      } catch (e) {
        console.warn('[rsdkv4] could not persist save data', e);
        return;
      }
    }

    this.#lastSave = bytes;
    this.emit('saves', this.game.saveSlots());
  }

  // ---- The render target ----

  #swallowContextMenu = (event: Event): void => event.preventDefault();
  #onPointerDown = (): void => this.#focusCanvas();
  #onResize = (): void => this.#fitPicture();
  #onFullscreenChange = (): void => {
    this.#fitPicture();
    requestAnimationFrame(() => this.#fitPicture());
  };

  #focusCanvas(): void {
    if (!this.#canvas) return;
    if (!document.hasFocus()) window.focus();
    this.#canvas.focus({ preventScroll: true });
  }

  #fitPicture(): void {
    if (!this.#ownsCanvas || !this.#canvas || !this.#box) return;
    const box = this.#box.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return;

    const { baseWidth, baseHeight } = RSDKV4_VIDEO;
    const scale = Math.min(box.width / baseWidth, box.height / baseHeight);
    this.#canvas.style.width = `${Math.round(baseWidth * scale)}px`;
    this.#canvas.style.height = `${Math.round(baseHeight * scale)}px`;
  }

  /**
   * Move the picture we already have. SDL keeps its canvas; only the parent changes.
   *
   * Pointing a second `mount()` at a *different* `<canvas>` is the one case this
   * refuses: SDL2 resolved `#canvas` once, at instantiation, so swapping the element
   * would leave the engine drawing into an orphan while the host watched a blank one.
   */
  #reparent(target: HTMLElement): void {
    const canvas = this.#canvas;
    if (!canvas || target === canvas || canvas.parentElement === target) return;

    if (target instanceof HTMLCanvasElement) {
      console.warn(
        '[rsdkv4] the canvas SDL draws into cannot be swapped after mounting — ignoring this mount()',
      );
      return;
    }

    target.appendChild(canvas);
    if (this.#box) this.#boxObserver?.unobserve(this.#box);
    this.#box = this.#ownsCanvas ? target : canvas;
    if (this.#box) this.#boxObserver?.observe(this.#box);
    this.#fitPicture();
  }

  #teardownCanvas(): void {
    const canvas = this.#canvas;
    if (canvas) {
      canvas.removeEventListener('contextmenu', this.#swallowContextMenu);
      canvas.removeEventListener('pointerdown', this.#onPointerDown);
      if (this.#ownsCanvas) canvas.remove();
    }
    document.removeEventListener('fullscreenchange', this.#onFullscreenChange);
    window.removeEventListener('resize', this.#onResize);
    this.#boxObserver?.disconnect();
    this.#boxObserver = null;
    this.#canvas = null;
    this.#box = null;
  }

  // ---- Misc ----

  #applyPaused(paused: boolean): void {
    const Module = this.#module;
    if (!Module) return;
    if (typeof Module.web_devmenu_set_paused === 'function') Module.web_devmenu_set_paused(paused);
    if (typeof Module.web_audio_set_paused === 'function') Module.web_audio_set_paused(paused);
  }

  /** A character name, as the pack spells it, to the index the engine wants. */
  #playerIndex(player: string | undefined): number {
    if (player === undefined) return 0;
    const players = this.game.players();
    const index = players.findIndex((name) => name.toLowerCase() === player.toLowerCase());
    if (index < 0) {
      throw new Error(
        `rsdkv4: "${player}" is not a playable character in this pack — try one of ${players.join(', ') || '(none reported)'}`,
      );
    }
    return index;
  }
}

// ---------------------------------------------------------------- the factory

/**
 * The factory a host imports: identity on the constructor, one live engine per
 * instance, and a `start()` that brings the wasm up and opens a session.
 *
 * Everything on it is the contract's — see the module doc for the shape of a call.
 */
export class Rsdkv4SDK extends EngineSDKBase<Rsdkv4Payloads> {
  static readonly id = 'rsdkv4';
  /** Kept in step with package.json by `node scripts/sync-version.mjs`. */
  static readonly version = '0.2.0';
  static readonly name = 'Retro Software Development Kit v4';
  static readonly description =
    'RSDKv4 compiled to WebAssembly via Emscripten. One game-agnostic WASM binary runs both Sonic 1 and Sonic 2 — the difference is only which Data.rsdk the host supplies at runtime. Ships none of the game: the player provides their own Data.rsdk, and it never leaves their browser.';

  protected override createPlay(
    init: EngineInit<Rsdkv4Payloads>,
    events: EventEmitter<Rsdkv4Events_>,
  ): Rsdkv4Play {
    return new Rsdkv4Play(init, events);
  }

  override start(options?: Partial<Rsdkv4Options>): Rsdkv4Session {
    return super.start(options) as Rsdkv4Session;
  }
}

/**
 * The line that puts the contract in CI: if this file stops satisfying
 * `EngineSDKConstructor`, `make typecheck` says so.
 */
export const RSDKV4_ENGINE: EngineSDKConstructor<Rsdkv4Payloads> = Rsdkv4SDK;

export default Rsdkv4SDK;

// ---------------------------------------------------------------- module-private helpers

/**
 * Call a `web_*` embind getter and parse its JSON.
 *
 * A missing function means the loaded rsdkv4.wasm predates that bridge — the usual
 * cause is a browser serving a cached build. Say so out loud: silently returning an
 * empty list makes a stale artifact look like an empty save file or a game with no
 * playable characters.
 */
function parseJson<T>(fn: unknown, fallback: T, what: string): T {
  if (typeof fn !== 'function') {
    console.error(
      `[rsdkv4] ${what} is missing from this build of rsdkv4.wasm — the page is probably running a cached copy. Hard-reload (or clear the site's storage) after rebuilding.`,
    );
    return fallback;
  }
  try {
    return JSON.parse((fn as () => string)());
  } catch (e) {
    console.error(`[rsdkv4] ${what} failed`, e);
    return fallback;
  }
}

/**
 * A claim, checked once — exactly the fourteen buttons, with missing and unknown both
 * fatal.
 *
 * Strict because the two failure modes are silent and asymmetric. A **missing** key
 * reads `false` on every tick: a dead button, no error anywhere, and easy to blame on
 * the engine. An **unknown** key is a button the host writes to that nothing ever
 * reads. The first sketch of this API lost `right` to a duplicated `up` — a duplicate
 * key in an object literal is legal JavaScript and surfaces only as an absent one.
 *
 * `Object.keys`, not `in`: a reactive store's `has` trap can answer `true` for a key
 * that has been deleted (jq79 does exactly that, deliberately, so a template
 * expression reading a deleted name takes its else branch instead of dying), and
 * `ownKeys` has no such licence.
 */
function validateButtons(buttons: Rsdkv4Buttons): void {
  if (typeof buttons !== 'object' || buttons === null) {
    throw new Error(
      `rsdkv4: options({ buttons }) takes an object of the 14 buttons or null to release, not ${typeof buttons}`,
    );
  }

  const keys = new Set(Object.keys(buttons));
  const missing = RSDKV4_BUTTONS.filter((button) => !keys.has(button));
  const unknown = [...keys].filter(
    (key) => !(RSDKV4_BUTTONS as readonly string[]).includes(key),
  );

  if (missing.length || unknown.length) {
    const faults = [
      missing.length && `missing ${missing.join(', ')}`,
      unknown.length && `unknown ${unknown.join(', ')}`,
    ].filter(Boolean);
    throw new Error(
      `rsdkv4: the buttons object must carry exactly the 14 buttons (${RSDKV4_BUTTONS.join(', ')}) — ${faults.join('; ')}. A missing button is dead, not neutral, so this is an error rather than a default.`,
    );
  }
}

/** The engine's two-level stage list as flat, writable {@link Rsdkv4Stage} values. */
function flattenStages(
  categories: Array<{ name: string; stages: Array<{ name: string }> }>,
): Rsdkv4Stage[] {
  const out: Rsdkv4Stage[] = [];
  categories.forEach((category, categoryIdx) => {
    category.stages.forEach((stage, sceneIdx) => {
      out.push({ category: categoryIdx, scene: sceneIdx, name: `${category.name} · ${stage.name}` });
    });
  });
  return out;
}

/** A GAME OPTIONS row as a host reads it: a boolean, or the label of the chosen entry. */
function fromEngineOption(row: RsdkGameOption): boolean | string | number {
  if (row.type === 'boolean') return row.value !== 0;
  return row.values?.[row.value] ?? row.value;
}

/** …and back to the number the engine stores. */
function toEngineOption(row: RsdkGameOption, value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value | 0;
  if (typeof value === 'string') {
    const index = (row.values ?? []).findIndex(
      (choice) => choice.toLowerCase() === value.toLowerCase(),
    );
    if (index >= 0) return index;
  }
  throw new Error(
    `rsdkv4: ${JSON.stringify(value)} is not a value "${row.key}" accepts — try one of ${
      row.type === 'boolean' ? 'true, false' : (row.values ?? []).join(', ')
    }`,
  );
}
