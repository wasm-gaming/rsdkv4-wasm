/**
 * The values `config.options` takes for this engine.
 *
 * The contract leaves `EngineConfig.options` as an opaque bag and points at
 * `manifest.options` for its schema; this module is both sides of that — the
 * compile-time {@link Rsdkv4Options} for TypeScript hosts, and the
 * {@link RSDKV4_OPTIONS_SCHEMA} that the manifest carries for hosts that build
 * their settings UI at runtime.
 *
 * ```ts
 * import { load } from '@wasm-gaming/rsdkv4-wasm';
 * import type { Rsdkv4Options } from '@wasm-gaming/rsdkv4-wasm/options';
 * ```
 *
 * @module
 */

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

/**
 * What `config.options` accepts, and nothing else — the SDK writes exactly these
 * seven keys into RSDKv4's `settings.ini`.
 *
 * **They are a fallback, not an override.** The generated `settings.ini` is the
 * *last* source the SDK tries: an explicit `assets.settings`, a file persisted by
 * an earlier session in the same `storageNamespace`, or a `settingsProvider` each
 * win over it. A host that changes an option and sees nothing happen is almost
 * always looking at a persisted file from a previous run.
 *
 * Unset keys fall back to {@link DEFAULT_RSDKV4_OPTIONS}.
 */
export interface Rsdkv4Options {
  /**
   * RSDKv4's native in-canvas Dev Menu. Kept off by default: the launcher owns
   * the debug/stage-select UI (via `instance.devMenu`), and leaving this on has
   * historically produced a native menu-like screen at boot.
   *
   * @defaultValue `false`
   */
  devMenu?: boolean;
  /**
   * RSDKv4 `EngineDebugMode`. In this build it gates the engine's log output and
   * nothing else — `instance.devMenu` and `instance.game` are embind bridges the
   * wasm installs unconditionally, so they work either way.
   *
   * @defaultValue `true`
   */
  engineDebugMode?: boolean;
  /**
   * VSync the engine's SDL window.
   *
   * @defaultValue `true`
   */
  vsync?: boolean;
  /**
   * Skip RSDKv4's in-canvas Start Menu (save select / character select / game
   * options). Set this when the host draws those screens itself from
   * `instance.game` — otherwise the engine's own menu runs underneath.
   *
   * @defaultValue `false`
   */
  skipStartMenu?: boolean;
  /**
   * Boot directly into a stage: 0-based stage-list category, as indexed by
   * `instance.devMenu.getStageList()`.
   *
   * @defaultValue {@link RSDKV4_UNSET} — normal boot flow
   */
  startingCategory?: number;
  /**
   * Boot directly into a stage: 0-based scene within the category.
   *
   * @defaultValue {@link RSDKV4_UNSET} — normal boot flow
   */
  startingScene?: number;
  /**
   * Starting player/character index, in the order `instance.game.players()`
   * reports. An index, never a name: the settings serializer coerces with `| 0`,
   * so `'TAILS'` becomes `0` — and `0` is not only Sonic, it also counts as
   * *set*, which drops the engine out of its normal boot flow.
   *
   * @defaultValue {@link RSDKV4_UNSET} — normal boot flow
   */
  startingPlayer?: number;
}

/**
 * RSDKv4 reads 255 as "not set" for the starting stage/player (see Userdata.cpp:
 * anything else — **including 0** — makes Engine::Init skip the start-menu flow
 * and force InitStartingStage). So "boot normally" has to be 255, not 0.
 */
export const RSDKV4_UNSET = 255;

/**
 * What the SDK writes for every key the host leaves out. Mirrored as `default` in
 * {@link RSDKV4_OPTIONS_SCHEMA}, so a host UI built from the manifest starts from
 * these same values.
 */
export const DEFAULT_RSDKV4_OPTIONS: Required<Rsdkv4Options> = {
  devMenu: false,
  engineDebugMode: true,
  vsync: true,
  skipStartMenu: false,
  startingCategory: RSDKV4_UNSET,
  startingScene: RSDKV4_UNSET,
  startingPlayer: RSDKV4_UNSET,
};

/**
 * {@link Rsdkv4Options} as JSON Schema — the value of `manifest.options`, which is
 * where the contract tells hosts to look for an engine's settings.
 *
 * It is the same seven keys with the same defaults, in the form a host can render
 * a settings panel from without importing any TypeScript. Kept `additionalProperties:
 * false` on purpose: an unknown key here is a typo, not an extension.
 */
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
      description:
        "Gates the engine's log output. The devmenu/game embind bridges are installed either way.",
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
