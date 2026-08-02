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
  /**
   * Skip RSDKv4's in-canvas Start Menu (save select / character select / game
   * options). Set this when the host draws those screens itself from
   * `instance.game` — otherwise the engine's own menu runs underneath.
   */
  skipStartMenu?: boolean;
  /** Boot directly into a stage: 0-based stage-list category. */
  startingCategory?: number;
  /** Boot directly into a stage: 0-based scene within the category. */
  startingScene?: number;
  /** Starting player/character index. */
  startingPlayer?: number;
}

/**
 * RSDKv4 reads 255 as "not set" for the starting stage/player (see Userdata.cpp:
 * anything else — **including 0** — makes Engine::Init skip the start-menu flow
 * and force InitStartingStage). So "boot normally" has to be 255, not 0.
 */
export const RSDKV4_UNSET = 255;

export const DEFAULT_RSDKV4_OPTIONS: Required<Rsdkv4Options> = {
  devMenu: false,
  engineDebugMode: true,
  vsync: true,
  skipStartMenu: false,
  startingCategory: RSDKV4_UNSET,
  startingScene: RSDKV4_UNSET,
  startingPlayer: RSDKV4_UNSET,
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
    skipStartMenu: {
      type: 'boolean',
      default: false,
      description:
        "Skip the engine's own save/character/options screens — set it when the host renders them from instance.game.",
    },
    startingCategory: {
      type: 'integer',
      minimum: 0,
      default: RSDKV4_UNSET,
      description: '0-based stage-list category; 255 = unset (normal boot flow).',
    },
    startingScene: {
      type: 'integer',
      minimum: 0,
      default: RSDKV4_UNSET,
      description: '0-based scene in the category; 255 = unset (normal boot flow).',
    },
    startingPlayer: {
      type: 'integer',
      minimum: 0,
      default: RSDKV4_UNSET,
      description: 'Player/character index; 255 = unset (normal boot flow).',
    },
  },
};
