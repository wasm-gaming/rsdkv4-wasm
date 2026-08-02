// @wasm-gaming/rsdkv4-wasm — SDK entry point.
//
// Conforms to the wasm-gaming engine contract (github.com/wasm-gaming/engine-specs):
// exports `manifest` (declarative) and `load(config)` (imperative).
//
// One game-agnostic rsdkv4.wasm runs both Sonic 1 and Sonic 2 — the difference is
// only which Data.rsdk the host hands us in `config.assets.data`, written into the
// filesystem at runtime (not baked with --preload-file).
//
// Filesystem: built with -sWASMFS (the modern Emscripten filesystem, not MEMFS).
// The game working dir `/data` is mounted on **OPFS** for persistence when the
// page is cross-origin isolated *and* the wasm build can create the OPFS backend
// from the main thread (an Asyncify/JSPI build — today's is not, see WebFS.cpp);
// otherwise it falls back to the WASMFS in-memory backend (transient, but the
// engine still boots). The backend is selectable via
// `config.persist` (see mountWorkingDir), and when the dir is OPFS-backed the SDK
// reuses an already-persisted Data.rsdk/settings.ini instead of re-fetching.

import type { EngineConfig, EngineInstance, EngineEvent, AssetData, InputPreset, KeyMap } from '@wasm-gaming/engine-specs';
import { manifest } from './rsdkv4.manifest.js';
import { DEFAULT_RSDKV4_OPTIONS, type Rsdkv4Options } from './rsdkv4.options.js';

export { manifest };

const WORK_ROOT = '/data';
const DEFAULT_STORAGE_NAMESPACE = 'default';

/**
 * Emscripten's SDL2 port locates the canvas via `document.querySelector('#canvas')`,
 * so the element the game draws into has to carry this id.
 */
const CANVAS_ID = 'canvas';

/**
 * Serialize engine options into RSDKv4's settings.ini format.
 *
 * Note the Starting* trio defaults to 255 ("unset") — writing 0 is not neutral,
 * it tells the engine to skip its start-menu flow and force that stage. See
 * DEFAULT_RSDKV4_OPTIONS.
 */
function buildSettingsIni(options: Rsdkv4Options = {}): string {
  const o = { ...DEFAULT_RSDKV4_OPTIONS, ...options };
  return [
    '[Dev]',
    `EngineDebugMode=${o.engineDebugMode ? 'true' : 'false'}`,
    `DevMenu=${o.devMenu ? 'true' : 'false'}`,
    `StartingCategory=${o.startingCategory | 0}`,
    `StartingScene=${o.startingScene | 0}`,
    `StartingPlayer=${o.startingPlayer | 0}`,
    '',
    '[Window]',
    `VSync=${o.vsync ? 'true' : 'false'}`,
    '',
  ].join('\n');
}

function toUint8(x: unknown): Uint8Array | null {
  if (x == null) return null;
  if (typeof x === 'string') return new TextEncoder().encode(x);
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new TypeError('asset must be Uint8Array | ArrayBuffer | string');
}

/** Normalize a user-provided storage namespace into a safe relative path. */
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

/** Best-effort mkdir -p for the Emscripten FS layer. */
function ensureDir(Module: any, path: string): void {
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

/**
 * Whether this build can mount OPFS at all, asked of the wasm itself.
 *
 * WASMFS's `wasmfs_create_opfs_backend()` spawns a proxy worker synchronously,
 * which it refuses to do on the main browser thread without Asyncify/JSPI — it
 * *asserts*, and a failed assert calls `abort()`, which tears the module down for
 * good. That is past the point where a try/catch around the call can save us, so
 * we have to know before calling. `web_opfs_supported` (WebFS.cpp) mirrors the
 * same condition; builds predating that helper simply answer "no".
 */
function opfsMountSupported(Module: any): boolean {
  const probe = Module._web_opfs_supported;
  if (typeof probe !== 'function') return false;
  try {
    return probe() !== 0;
  } catch {
    return false;
  }
}

/**
 * Mount the game working dir, honoring `persist`:
 *   'opfs'     → force an OPFS (persistent) mount; warn + fall back if unavailable.
 *   null       → force the in-memory WASMFS backend (the MEMFS-equivalent fallback).
 *   undefined  → auto: OPFS when the page is cross-origin isolated, else in-memory.
 * ('idbfs' isn't supported under WASMFS and is treated as in-memory.)
 *
 * Cross-origin isolation is necessary but not sufficient: the mount also needs a
 * build whose OPFS backend can run from where we call it (see opfsMountSupported),
 * so both gates apply before we touch `web_mount_opfs`.
 * Returns whether the resulting mount is persistent.
 */
function mountWorkingDir(Module: any, persist: EngineConfig['persist']): { persistent: boolean } {
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

/** True if `path` exists in the (mounted) filesystem. */
function fileExists(Module: any, path: string): boolean {
  try {
    Module.FS.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Delete a file if present; returns true when something was removed. */
function deleteFileIfExists(Module: any, path: string): boolean {
  if (!fileExists(Module, path)) return false;
  try {
    Module.FS.unlink(path);
    return true;
  } catch {
    return false;
  }
}

/** RSDKv4-specific bridge for the launcher's debug/stage-select UI. */
export interface RsdkDevMenuBridge {
  getStageList(): Array<{ name: string; stages: Array<{ name: string }> }>;
  loadStage(categoryIdx: number, stageIdx: number): void;
  setPaused(paused: boolean): void;
}

export type Rsdkv4Instance = EngineInstance & {
  devMenu: RsdkDevMenuBridge;
  /** True when the working dir is OPFS-backed (persistent) rather than in-memory. */
  persistent: boolean;
  /** Relative storage namespace used under /data (e.g. "sonic1", "sonic2"). */
  storageNamespace: string;
  /** Remove persisted game files for this namespace only. */
  purgeStorage(): { data: boolean; settings: boolean };
};

/**
 * Extra (engine-specific) config on top of the contract's EngineConfig: lazy asset
 * providers, invoked only on a cache miss — e.g. to skip a large Data.rsdk fetch
 * when it's already persisted in OPFS.
 */
export type Rsdkv4LoadConfig = EngineConfig & {
  dataProvider?: () => Promise<AssetData> | AssetData;
  settingsProvider?: () => Promise<AssetData> | AssetData;
  /**
   * Per-game storage folder under /data used for OPFS/WASMFS files.
   * Examples: "sonic1", "sonic2", "my-pack/v1".
   */
  storageNamespace?: string;
  /** Deprecated alias for `canvasEl`, kept for hosts written against 0.0.x. */
  canvas?: HTMLCanvasElement;
};

/** Boot the RSDKv4 engine. */
export async function load(config: Rsdkv4LoadConfig): Promise<Rsdkv4Instance> {
  const { assets, onEvent, attachTo } = config;
  const options = config.options as Rsdkv4Options | undefined;

  const emit = (event: EngineEvent): void => {
    try {
      onEvent?.(event);
    } catch {
      // A host callback must not break the engine runtime.
    }
  };

  // ----------------------------------------------------------------- render target

  const providedCanvas = config.canvasEl ?? config.canvas ?? null;
  if (!providedCanvas && !attachTo) {
    throw new Error('rsdkv4: config.canvasEl or config.attachTo is required');
  }

  const ownsCanvas = providedCanvas === null;
  const canvas = providedCanvas ?? document.createElement('canvas');

  // Emscripten's SDL2 port locates the canvas via document.querySelector('#canvas').
  if (canvas.id !== CANVAS_ID) {
    if (canvas.id) {
      console.warn(
        `rsdkv4: renaming the render target's id from "${canvas.id}" to "${CANVAS_ID}" — SDL looks the canvas up by that id.`,
      );
    }
    canvas.id = CANVAS_ID;
  }

  if (ownsCanvas) {
    canvas.style.display = 'block';
    canvas.style.maxWidth = '100%';
    canvas.style.maxHeight = '100%';
    canvas.style.height = 'auto';
    canvas.classList.add('emscripten');

    attachTo?.appendChild(canvas);
  }

  // A canvas is not in the tab order and `focus()` on one is a silent no-op
  // until it has a tabindex. -1 makes it focusable without adding a tab stop.
  if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '-1');
  // …and the focus ring would draw a browser-blue box around the picture.
  canvas.style.outline = 'none';

  const swallowContextMenu = (event: Event): void => event.preventDefault();
  canvas.addEventListener('contextmenu', swallowContextMenu);

  const focusCanvas = (): void => {
    if (!document.hasFocus()) window.focus();
    canvas.focus({ preventScroll: true });
  };

  const onPointerDown = (): void => focusCanvas();
  canvas.addEventListener('pointerdown', onPointerDown);

  // ----------------------------------------------------------------- sizing

  /** The box the picture has to fit inside, in CSS pixels. */
  const boxElement = ownsCanvas && attachTo ? attachTo : canvas;

  const fitPicture = (): void => {
    if (!ownsCanvas) return;
    const box = boxElement.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return;

    const bw = manifest.video.baseWidth;
    const bh = manifest.video.baseHeight;
    const scale = Math.min(box.width / bw, box.height / bh);
    canvas.style.width = `${Math.round(bw * scale)}px`;
    canvas.style.height = `${Math.round(bh * scale)}px`;
  };

  fitPicture();

  const onResize = (): void => fitPicture();
  window.addEventListener('resize', onResize);
  const boxObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize);
  boxObserver?.observe(boxElement);

  // Fullscreen transitions need a refit too.
  const onFullscreenChange = (): void => {
    fitPicture();
    requestAnimationFrame(fitPicture);
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);

  // ----------------------------------------------------------------- emscripten

  const jsUrl = config.jsUrl ?? new URL('./rsdkv4.js', import.meta.url).href;
  const wasmUrl = config.wasmUrl ?? new URL('./rsdkv4.wasm', import.meta.url).href;

  // RSDKv4 keyboard bindings are the shared input script's default preset.
  if (typeof window !== 'undefined') (window as any).__gamepadKeyMap = manifest.input;

  const mod: any = await import(/* @vite-ignore */ jsUrl);
  const createRSDKv4 = mod.default;

  const Module: any = await createRSDKv4({
    canvas,
    noInitialRun: true, // built with -sINVOKE_RUN=0; we mount data before main()
    locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path),
    print: (...a: unknown[]) => console.log('[rsdkv4]', ...a),
    printErr: (...a: unknown[]) => console.error('[rsdkv4]', ...a),
    onAbort: (reason: unknown) =>
      emit({ type: 'error', error: new Error(`rsdkv4 aborted: ${reason}`) }),
  });

  // Mount the working dir first, so we can see what's already persisted (OPFS)
  // before deciding whether to pull assets.
  const { persistent } = mountWorkingDir(Module, config.persist);
  const storageNamespace = normalizeStorageNamespace(config.storageNamespace);
  const workDir = `${WORK_ROOT}/${storageNamespace}`;
  ensureDir(Module, workDir);

  const dataPath = `${workDir}/Data.rsdk`;
  const settingsPath = `${workDir}/settings.ini`;

  // Data.rsdk — precedence: explicit asset > already persisted (skip fetch) > lazy provider.
  let dataBytes = toUint8(assets?.data);
  if (!dataBytes) {
    if (fileExists(Module, dataPath)) {
      console.log(
        `[rsdkv4] Data.rsdk already in persistent storage (${storageNamespace}) — skipping fetch`,
      );
    } else if (config.dataProvider) {
      dataBytes = toUint8(await config.dataProvider());
    }
  }
  if (dataBytes) {
    Module.FS.writeFile(dataPath, dataBytes);
  } else if (!fileExists(Module, dataPath)) {
    throw new Error(
      'rsdkv4: no Data.rsdk — provide assets.data, a dataProvider, or a persisted copy (OPFS)',
    );
  }

  // settings.ini — explicit asset > persisted > lazy provider > generated from options.
  let settingsBytes = toUint8(assets?.settings);
  if (!settingsBytes && !fileExists(Module, settingsPath) && config.settingsProvider) {
    settingsBytes = toUint8(await config.settingsProvider());
  }
  if (settingsBytes) {
    Module.FS.writeFile(settingsPath, settingsBytes);
  } else if (!fileExists(Module, settingsPath)) {
    Module.FS.writeFile(settingsPath, new TextEncoder().encode(buildSettingsIni(options)));
  }
  // else: keep the persisted settings.ini

  Module.FS.chdir(workDir);

  const setPaused = (paused: boolean) => {
    if (typeof Module.web_devmenu_set_paused === 'function') Module.web_devmenu_set_paused(paused);
  };

  const devMenu: RsdkDevMenuBridge = {
    getStageList() {
      if (typeof Module.web_devmenu_get_stage_list !== 'function') return [];
      try {
        return JSON.parse(Module.web_devmenu_get_stage_list());
      } catch (e) {
        console.error('[rsdkv4] getStageList failed', e);
        return [];
      }
    },
    loadStage(categoryIdx, stageIdx) {
      if (typeof Module.web_devmenu_load_stage === 'function') {
        Module.web_devmenu_load_stage(categoryIdx | 0, stageIdx | 0);
      }
    },
    setPaused,
  };

  // Run main() from the OPFS/WASMFS working dir. simulate_infinite_loop schedules
  // the rAF loop and returns via a benign unwind Emscripten swallows.
  Module.callMain(['UsingCWD']);

  focusCanvas();
  emit({ type: 'ready' });

  return {
    start() {},
    pause() { setPaused(true); },
    resume() { setPaused(false); },
    reset() {
      throw new Error('rsdkv4: reset() is not supported — destroy() and load() again');
    },
    setInput(preset: InputPreset | KeyMap) {
      if (typeof window !== 'undefined') {
        (window as any).__gamepadKeyMap = preset ?? manifest.input;
      }
    },
    destroy() {
      try { Module.pauseMainLoop?.(); } catch { /* noop */ }
      try { setPaused(true); } catch { /* noop */ }

      canvas.removeEventListener('contextmenu', swallowContextMenu);
      canvas.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      window.removeEventListener('resize', onResize);
      boxObserver?.disconnect();
      if (ownsCanvas) canvas.remove();
    },
    devMenu,
    persistent,
    storageNamespace,
    purgeStorage() {
      return {
        data: deleteFileIfExists(Module, dataPath),
        settings: deleteFileIfExists(Module, settingsPath),
      };
    },
  };
}

export default { manifest, load };
