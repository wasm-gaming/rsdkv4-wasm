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
// page is cross-origin isolated; otherwise it falls back to the WASMFS in-memory
// backend (transient, but the engine still boots). The backend is selectable via
// `config.persist` (see mountWorkingDir), and when the dir is OPFS-backed the SDK
// reuses an already-persisted Data.rsdk/settings.ini instead of re-fetching.

import type { EngineConfig, EngineInstance, AssetData } from '@wasm-gaming/engine-specs';
import { manifest } from './rsdkv4.manifest.js';
import { DEFAULT_RSDKV4_OPTIONS, type Rsdkv4Options } from './rsdkv4.options.js';

export { manifest };

const WORK_ROOT = '/data';
const DEFAULT_STORAGE_NAMESPACE = 'default';

/** Serialize engine options into RSDKv4's settings.ini format. */
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
 * Mount the game working dir, honoring `persist`:
 *   'opfs'     → force an OPFS (persistent) mount; warn + fall back if unavailable.
 *   null       → force the in-memory WASMFS backend (the MEMFS-equivalent fallback).
 *   undefined  → auto: OPFS when the page is cross-origin isolated, else in-memory.
 * ('idbfs' isn't supported under WASMFS and is treated as in-memory.)
 *
 * OPFS sync access needs a worker/pthread + cross-origin isolation, so 'auto' only
 * attempts it when isolated (the single-threaded build would otherwise trap).
 * Returns whether the resulting mount is persistent.
 */
function mountWorkingDir(Module: any, persist: EngineConfig['persist']): { persistent: boolean } {
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  const attemptOpfs = persist === 'opfs' || (persist === undefined && isolated);

  if (attemptOpfs && typeof Module.ccall === 'function') {
    try {
      const rc = Module.ccall('web_mount_opfs', 'number', ['string'], [WORK_ROOT]);
      if (rc === 0) return { persistent: true };
    } catch {
      /* fall through to in-memory */
    }
    if (persist === 'opfs') {
      console.warn('[rsdkv4] OPFS requested but unavailable — using in-memory WASMFS');
    }
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
};

/** Boot the RSDKv4 engine. */
export async function load(config: Rsdkv4LoadConfig): Promise<Rsdkv4Instance> {
  const { canvas, assets, onEvent } = config;
  const options = config.options as Rsdkv4Options | undefined;
  if (!canvas) throw new Error('rsdkv4: config.canvas is required');

  // Emscripten's SDL2 port locates the canvas via document.querySelector('#canvas').
  if (canvas.id !== 'canvas') canvas.id = 'canvas';

  const emit = (e: Parameters<NonNullable<EngineConfig['onEvent']>>[0]) => {
    try { onEvent?.(e); } catch { /* host handler must not break us */ }
  };

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
  emit({ type: 'ready' });

  return {
    start() {},
    pause() { setPaused(true); },
    resume() { setPaused(false); },
    reset() {
      throw new Error('rsdkv4: reset() is not supported — destroy() and load() again');
    },
    setInput(preset) {
      if (typeof window !== 'undefined') {
        (window as any).__gamepadKeyMap = preset ?? manifest.input;
      }
    },
    destroy() {
      try { Module.pauseMainLoop?.(); } catch { /* noop */ }
      try { setPaused(true); } catch { /* noop */ }
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
