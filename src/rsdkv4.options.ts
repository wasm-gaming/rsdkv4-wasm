// Engine-specific options for RSDKv4.
//
// This is the authoritative description of what `EngineConfig.options` accepts
// for this engine. It provides both:
//   - `Rsdkv4Options`         — the compile-time type (for TS hosts/launchers)
//   - `RSDKV4_OPTIONS_SCHEMA` — the JSON Schema mirrored into manifest.json's
//                               `options` (for runtime host UI + validation)
//   - `DEFAULT_RSDKV4_OPTIONS` — defaults the SDK falls back to.
//
// At runtime these options are serialized into RSDKv4's `settings.ini` (see the
// SDK's settings serializer) when the host does not pass an explicit `settings`
// asset.

import type { JSONSchema } from '@wasm-gaming/engine-specs';

export interface Rsdkv4Options {
  /**
   * RSDKv4's native in-canvas Dev Menu. Kept off by default: the launcher owns
   * the debug/stage-select UI (via `instance.devMenu`), and leaving this on has
   * historically produced a native menu-like screen at boot.
   */
  devMenu?: boolean;
  /** RSDKv4 EngineDebugMode — enables the web devmenu embind bridge hooks. */
  engineDebugMode?: boolean;
  /** VSync the engine's SDL window. */
  vsync?: boolean;
  /** Boot directly into a stage: 0-based stage-list category. */
  startingCategory?: number;
  /** Boot directly into a stage: 0-based scene within the category. */
  startingScene?: number;
  /** Starting player/character index. */
  startingPlayer?: number;
}

export const DEFAULT_RSDKV4_OPTIONS: Required<Rsdkv4Options> = {
  devMenu: false,
  engineDebugMode: true,
  vsync: true,
  startingCategory: 0,
  startingScene: 0,
  startingPlayer: 0,
};

export const RSDKV4_OPTIONS_SCHEMA: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    devMenu: {
      type: 'boolean',
      default: false,
      description:
        "RSDKv4's native in-canvas Dev Menu. The launcher provides its own overlay via instance.devMenu, so keep this off.",
    },
    engineDebugMode: {
      type: 'boolean',
      default: true,
      description: 'Enables the web devmenu embind bridge (stage list / warp / pause).',
    },
    vsync: { type: 'boolean', default: true },
    startingCategory: { type: 'integer', minimum: 0, default: 0 },
    startingScene: { type: 'integer', minimum: 0, default: 0 },
    startingPlayer: { type: 'integer', minimum: 0, default: 0 },
  },
};
