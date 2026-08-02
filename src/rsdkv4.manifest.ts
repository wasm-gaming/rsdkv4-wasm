// The rsdkv4 EngineManifest — typed against the contract, so a drift from
// @wasm-gaming/engine-specs is a compile error here. `npm run build:manifest`
// serializes this to dist/manifest.json (the artifact CI attaches to a Release).

import type { EngineManifest } from '@wasm-gaming/engine-specs';
import { RSDKV4_OPTIONS_SCHEMA } from './rsdkv4.options.js';

export const manifest: EngineManifest = {
  id: 'rsdkv4',
  version: '0.1.5',
  name: 'Retro Software Development Kit v4',
  description:
    'RSDKv4 compiled to WebAssembly via Emscripten. One game-agnostic WASM binary runs both Sonic 1 and Sonic 2 — the difference is only which Data.rsdk the host supplies at runtime. Ships none of the game: the player provides their own Data.rsdk, and it never leaves their browser.',
  artifacts: {
    // Relative to the manifest (dist/manifest.json); the engine files live in
    // the dist/rsdkv4/ subfolder.
    wasm: 'rsdkv4/rsdkv4.wasm',
    js: 'rsdkv4/rsdkv4.js',
  },
  assets: [
    {
      key: 'data',
      // Lives under the OPFS-backed (persistent) working dir; the engine reads it
      // via CWD (booted with the UsingCWD arg).
      mountPath: '/data/Data.rsdk',
      required: true,
      accept: ['.rsdk'],
      description:
        'RSDKv4 game data pack. Differs per game (Sonic 1 vs Sonic 2); selects the game.',
    },
    {
      key: 'settings',
      mountPath: '/data/settings.ini',
      required: false,
      accept: ['.ini'],
      description:
        'Engine settings. Omitted → the SDK generates one from config.options.',
    },
  ],
  // RSDKv4 keyboard defaults. The key names are KeyboardEvent.code values.
  input: {
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    a: 'KeyZ',
    b: 'KeyX',
    c: 'KeyC',
    start: 'Enter',
    select: 'ShiftLeft',
  },
  video: { baseWidth: 424, baseHeight: 240, aspect: '16:9' },
  options: RSDKV4_OPTIONS_SCHEMA,
  capabilities: { saveStates: false, sram: false, coreSelectable: false },
};

export default manifest;
