/**
 * What this engine's four payloads accept, and the {@link RSDKV4_SPEC} that describes
 * them to a host.
 *
 * ```ts
 * import type { Rsdkv4Config, Rsdkv4Options } from '@wasm-gaming/rsdkv4-wasm/options';
 * ```
 *
 * The contract's own module documents *how* the four payloads behave — they read as
 * descriptors and write as patches, and `live` says whether a key reaches a running
 * engine. This module is only the part that is RSDKv4's: which keys exist, what they
 * mean here, and what the engine does with them.
 *
 * The split between the first two is the whole design:
 *
 * - {@link Rsdkv4Config} is **the engine**. It is serialized into RSDKv4's
 *   `settings.ini` and read once, at boot — so none of it is `live`.
 * - {@link Rsdkv4Options} is **the session**: which character, which save slot, which
 *   stage. That is what a `restart()` reopens. It also carries the engine's own GAME
 *   OPTIONS rows, which *are* `live` — and which are not declared here at all, because
 *   they differ between Sonic 1 and Sonic 2 and are only knowable once the pack is
 *   loaded.
 *
 * @module
 */

import type { EnginePayloads, EngineSpec } from '@wasm-gaming/engine-specs';

/** Bytes a host can hand over for an asset. */
export type Rsdkv4AssetData = Uint8Array | ArrayBuffer | ArrayBufferView | string;

/**
 * An asset, eagerly or on demand.
 *
 * The thunk form is what the old `dataProvider` / `settingsProvider` config fields
 * were: `assets({ data: () => fetch(url).then((r) => r.arrayBuffer()) })`. See
 * {@link Rsdkv4Assets} for when each one is actually called — they differ, and the
 * difference is tens of megabytes.
 */
export type Rsdkv4Asset = Rsdkv4AssetData | (() => Rsdkv4AssetData | Promise<Rsdkv4AssetData>);

/**
 * The engine, as `settings.ini` — read once at boot, which is why nothing here is
 * `live`. Change any of it and the engine has to come back up: `destroy()` and a new
 * factory, not `restart()`.
 *
 * Regenerated on every boot, and that is safe: RSDKv4's `writeSettings()` is inside
 * `#ifndef __EMSCRIPTEN__`, so this build never writes the file back and there is
 * nothing of the player's in it to overwrite. A host that wants its own file hands one
 * over as `assets.settings` instead, and then this payload is ignored.
 */
export interface Rsdkv4Config {
  /**
   * VSync the engine's SDL window.
   *
   * @defaultValue `true`
   */
  vsync?: boolean;
  /**
   * RSDKv4's native in-canvas Dev Menu. Off by default: a host that wants a
   * debug/stage-select UI draws it from `play.devMenu`, and leaving this on has
   * historically produced a native menu-like screen at boot.
   *
   * @defaultValue `false`
   */
  devMenu?: boolean;
  /**
   * RSDKv4 `EngineDebugMode`. In this build it gates the engine's log output and
   * nothing else — `play.devMenu` and `play.game` are embind bridges the wasm installs
   * unconditionally, so they work either way.
   *
   * @defaultValue `true`
   */
  engineDebugMode?: boolean;
  /**
   * Who draws the save-select / character-select / game-options screens.
   *
   * `'native'` leaves RSDKv4's own in-canvas Start Menu on. `'host'` skips it, for a
   * host that renders those screens itself from `play.game` — otherwise the engine's
   * menu runs underneath the host's.
   *
   * This is the old `skipStartMenu` boolean, the right way up: the inverted name meant
   * `false` had to be read twice to mean "yes, show it".
   *
   * @defaultValue `'native'`
   */
  startMenu?: 'native' | 'host';
  /**
   * Where to load the Emscripten glue from. Defaults to `./rsdkv4.js` next to the
   * built SDK, which is where `make build` puts it.
   */
  jsUrl?: string;
  /** Where to load the wasm from. Defaults to `./rsdkv4.wasm` next to the built SDK. */
  wasmUrl?: string;
}

/**
 * A stage, as the engine's two-level stage list indexes it.
 *
 * `name` is **read-only**: the descriptors {@link Rsdkv4Options.stage} reports back
 * carry one so a host can paint a stage picker straight from `options()`, but writing
 * it is ignored — `category` and `scene` are what reach the engine.
 */
export interface Rsdkv4Stage {
  /** 0-based category, as ordered by `play.devMenu.getStageList()`. */
  category: number;
  /** 0-based scene within the category. */
  scene: number;
  /** `"<Category> · <Scene>"`, filled in by the SDK. Ignored on write. */
  name?: string;
}

/**
 * RSDKv4's fourteen buttons, in the engine's own `InputButtons` order.
 *
 * The order is not cosmetic: it is the bit order of the mask the SDK hands the
 * engine once per tick, so this array is the wire format and not merely a list.
 *
 * Sonic 1 and Sonic 2 read only the four directions, A, B, C and start. The other
 * six exist in the engine and are free for a host to do as it likes with.
 */
export const RSDKV4_BUTTONS = [
  'up',
  'down',
  'left',
  'right',
  'a',
  'b',
  'c',
  'x',
  'y',
  'z',
  'l',
  'r',
  'start',
  'select',
] as const;

/**
 * One button, spelled as {@link RSDKV4_BUTTONS} spells it.
 *
 * Derived from the array rather than declared beside it, so there is one list and
 * not two to drift apart — and so a typo in a `buttons` literal is a compile error
 * rather than a button that silently never fires.
 */
export type Rsdkv4Button = (typeof RSDKV4_BUTTONS)[number];

/**
 * Every button as a boolean — what a host hands over to {@link Rsdkv4Options.buttons}
 * and keeps writing to for as long as it holds the claim.
 *
 * All fourteen are required. A key that is merely absent reads as `false` on every
 * tick, which is a dead button and no error anywhere; requiring the whole set is what
 * turns that into something the compiler catches.
 */
export type Rsdkv4Buttons = Record<Rsdkv4Button, boolean>;

/**
 * What the engine binds each button to by default, for a host that has taken input
 * over and now has to bind them itself.
 *
 * Not engine configuration — nothing here is read by the engine, and writing to it
 * changes nothing. It is a starting table, so a host that claims input can offer the
 * bindings a player already knows instead of inventing its own.
 */
export interface Rsdkv4InputDefaults {
  /** `KeyboardEvent.code` values, as `settings.ini`'s `[Keyboard 1]` binds them. */
  keyboard: Record<Rsdkv4Button, string>;
  /**
   * Indices into `Gamepad.buttons` under the browser's **standard mapping**.
   *
   * These are translated, not copied: `settings.ini`'s `[Controller 1]` holds
   * SDL's `SDL_CONTROLLER_BUTTON_*` values, and those are different numbers — SDL's
   * left shoulder is 9, where the browser's is 4. A host polling the Gamepad API
   * wants the browser's, so that is what this carries.
   *
   * `null` where the engine's default has no standard-mapping button: `select` is
   * bound to SDL's GUIDE, which this build's own web-gamepad mapping never wires
   * up, so it is dead on a pad in the engine too. `y` and `z` are the analog
   * triggers (the engine reads them past a deadzone, as ZL/ZR).
   */
  gamepad: Record<Rsdkv4Button, number | null>;
}

/**
 * The engine's own default bindings. See {@link Rsdkv4InputDefaults}.
 *
 * Directions are the arrow keys. This build's `ProcessInput()` also reads `KeyW`,
 * `KeyA`, `KeyS` and `KeyD` as a second set of them, and takes those three scancodes
 * off `x`, `y` and `z` to do it — so the table below is what a *claiming* host should
 * bind, and the engine under SDL polling answers to both.
 *
 * This replaces the old `RSDKV4_KEYMAP`, which nothing read and which was wrong in
 * three ways for want of ever being checked against the engine: it listed 9 of the
 * 14 buttons, and bound `select` to `ShiftLeft` where the engine's default is `Tab`.
 */
export const RSDKV4_INPUT: Rsdkv4InputDefaults = {
  keyboard: {
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    a: 'KeyZ',
    b: 'KeyX',
    c: 'KeyC',
    x: 'KeyA',
    y: 'KeyS',
    z: 'KeyD',
    l: 'KeyQ',
    r: 'KeyE',
    start: 'Enter',
    select: 'Tab',
  },
  gamepad: {
    up: 12,
    down: 13,
    left: 14,
    right: 15,
    a: 0,
    b: 1,
    c: 2,
    x: 3,
    y: 6,
    z: 7,
    l: 4,
    r: 5,
    start: 9,
    select: null,
  },
};

/**
 * The session — what a `restart()` reopens.
 *
 * **Absence is the neutral value.** The old `RSDKV4_UNSET = 255` sentinel is gone:
 * leaving a key out means "boot the way the engine normally would", and there is no
 * longer a number that quietly means something else. (In particular `player: 0` used
 * to be indistinguishable from "unset" in the ini, which is why it was a footgun.)
 *
 * The index signature is not laziness. The engine's GAME OPTIONS rows — spin dash,
 * item-box set, and whatever else the loaded pack declares — are keys neither this
 * package nor the host can know ahead of time. They come back from `options()` as
 * descriptors with their own labels and choices, `live: true`, and are written back
 * the same way. That is what lets a host paint a settings screen without knowing a
 * single key name.
 */
export interface Rsdkv4Options {
  /**
   * The character to start a *new* game as, by the name the pack reports — the
   * `enum` of this key's descriptor is exactly `play.game.players()`, so a host paints
   * a character picker from it and writes one of the values straight back. Matched
   * case-insensitively; an unknown name is an error rather than a silent Sonic.
   *
   * Continuing a slot that already has a save ignores this: the save carries its own
   * character.
   */
  player?: string;
  /**
   * Which of RSDKv4's four save slots (0-3) the session runs on. `null` plays without
   * saving, as the native menu's NO SAVE does.
   *
   * A slot with data continues it; an empty slot starts a new game as {@link player}.
   */
  slot?: number | null;
  /**
   * Jump straight to a stage, skipping wherever the session would otherwise open.
   *
   * Applied through the engine's own stage loader after boot, not through
   * `settings.ini`'s `Starting*` trio — which is why it works on a `restart()` of a
   * running engine and not only on the first one.
   */
  stage?: Rsdkv4Stage;
  /**
   * Take input over: hand the engine a live object of fourteen booleans and it stops
   * polling SDL, reading yours instead — touch buttons, rebinding, netplay, a test
   * that drives a stage from a script.
   *
   * ```ts
   * const buttons = { up: false, down: false, ...rest, select: false }; // all 14
   * play.options({ buttons });       // claim
   * play.options({ buttons: null }); // release — the engine polls SDL again
   * ```
   *
   * **Read once per tick, from wherever it lives.** The engine calls in at the top of
   * its input pass and the SDK reads the object at that moment, so a plain object and
   * a reactive store both work and neither one needs the SDK to know which it is.
   * Whatever is `true` when the engine asks is what the engine sees.
   *
   * Three things become the host's the moment it claims:
   *
   * - **Keyup on focus loss.** SDL resets its keyboard when the window loses focus; a
   *   host that owns input inherits that job (`blur`, `visibilitychange`) or a held
   *   arrow strands the player mid-run.
   * - **The gamepad, entirely.** The engine stops polling it, so a host that wants one
   *   polls the Gamepad API itself — deadzones and the D-pad-from-axes fallback
   *   included. {@link RSDKV4_INPUT} is the table to start from.
   * - **Releasing.** Absence means "leave the claim as it is"; only `null` releases.
   *   A component that claims and then unmounts without releasing leaves the engine
   *   pulling at an object nobody writes to any more.
   *
   * Not persistable, and not a settings row: it reads back from `options()` as `null`
   * whether or not a claim is held, so that `JSON.stringify(await play.options())`
   * cannot sweep fourteen transient booleans into a host's saved settings. Ask
   * `play.input.claimed` for the claim state.
   *
   * `play.input.claim(buttons)` and `play.input.release()` are the same thing, named.
   */
  buttons?: Rsdkv4Buttons | null;
  /**
   * The engine's GAME OPTIONS rows. See the note on the interface: these are declared
   * by the loaded pack, not here.
   *
   * A `boolean` row reads and writes as a boolean, an enum row as one of its choice
   * labels; the raw engine-side number is accepted on write too.
   */
  [key: string]: unknown;
}

/**
 * The two files the engine reads out of its working directory.
 *
 * Neither is `live`: they are read while the engine comes up, so a patch after that
 * lands in the state a *future* engine would boot from.
 */
export interface Rsdkv4Assets {
  /**
   * The `Data.rsdk` pack — the whole game, and what decides *which* game: one
   * game-agnostic wasm runs both Sonic 1 and Sonic 2, the pack is the difference.
   *
   * Precedence, and the reason the thunk form exists: bytes handed over here win;
   * otherwise a copy already persisted in this storage namespace is reused; only if
   * there is neither is a thunk called. That is what keeps a host from re-fetching
   * tens of megabytes it already has. With none of the three, `start()` fails.
   */
  data?: Rsdkv4Asset;
  /**
   * A ready-made `settings.ini`, for a host that would rather write the file itself
   * than describe it through {@link Rsdkv4Config}. Given one, the config payload is
   * not serialized at all.
   *
   * Unlike `data`, a thunk here is called on **every** boot rather than only on a
   * cache miss — the file is a few hundred bytes, and re-reading it is what makes the
   * host's copy authoritative instead of whatever an earlier session left behind.
   */
  settings?: Rsdkv4Asset;
}

/** Where this engine's files live, and whether they outlive the page. */
export interface Rsdkv4Storage {
  /**
   * Per-game folder for the pack, the settings and the save file, so two games do not
   * overwrite each other. Examples: `"sonic1"`, `"rsdkv4/Sonic2"`.
   *
   * It is a path under the engine's working root *and* the OPFS directory the SDK
   * mirrors save data into, which is what lets a host read `<namespace>/SData.bin`
   * itself. Anything that is not a usable relative path normalises to `"default"` —
   * including the object you get from interpolating a game record by mistake.
   *
   * @defaultValue `"default"`
   */
  namespace?: string;
  /**
   * What the engine's working directory is backed by.
   *
   * `'opfs'` forces a persistent mount and warns if it cannot have one; `null` means
   * the host wants nothing kept, which switches off the save mirror as well; leaving
   * it out picks OPFS when the page is cross-origin isolated.
   *
   * Worth knowing: on every build without Asyncify/JSPI — today's included — the mount
   * itself cannot be OPFS, so the working dir is in-memory whatever this says. Saves
   * survive anyway, because the SDK mirrors `SData.bin` into
   * `<namespace>/` through the host-side OPFS API. `null` is what turns that off.
   */
  persist?: 'opfs' | null;
}

/** One of RSDKv4's four save slots, as the engine's own save-select screen sees it. */
export interface RsdkSaveSlot {
  /** 0-3. */
  slot: number;
  /** No game stored here — starting it means picking a character first. */
  empty: boolean;
  /** Character index into `play.game.players()`: 0 Sonic, 1 Tails, 2 Knuckles, 3 both. */
  character: number;
  lives: number;
  score: number;
  emeralds: number;
  /** Stage list the save resumes into (1 regular, 3 special), or -1 when empty. */
  list: number;
  /** 0-based scene within `list` — index it against `play.devMenu.getStageList()`. */
  zone: number;
}

/**
 * What this engine announces on top of the contract's core set (`start`, `error`,
 * `exit`, `pause`, `resume`).
 */
export interface Rsdkv4Events {
  /**
   * The save file changed, with every slot as it now stands.
   *
   * Emitted when the SDK has just written `<namespace>/SData.bin` out of the wasm and
   * the bytes are not what they were — on its slow timer, on a pause, and on the way
   * down. A host painting save slots subscribes to this instead of polling.
   */
  saves: RsdkSaveSlot[];
}

/** The four payloads, closed — the single type parameter everything else takes. */
export interface Rsdkv4Payloads extends EnginePayloads {
  config: Rsdkv4Config;
  options: Rsdkv4Options;
  assets: Rsdkv4Assets;
  storage: Rsdkv4Storage;
  events: Rsdkv4Events;
}

/**
 * Everything the engine declares about its own properties, as data.
 *
 * `default` appears here and nowhere else: the contract's base class seeds the
 * starting state from it, so there is no second table of defaults to drift out of
 * agreement with this one — which is exactly what the old
 * `DEFAULT_RSDKV4_OPTIONS`-alongside-a-JSON-Schema pair did.
 *
 * What is missing from `options` is deliberate: `player` and `stage` get their `enum`
 * filled in from the loaded pack, and the GAME OPTIONS rows are added outright, when a
 * running engine is asked to describe itself.
 */
export const RSDKV4_SPEC: EngineSpec<Rsdkv4Payloads> = {
  config: {
    vsync: { default: true, live: false, description: 'VSync the engine window.' },
    devMenu: {
      default: false,
      live: false,
      description: "RSDKv4's native in-canvas Dev Menu. Hosts draw their own from play.devMenu.",
    },
    engineDebugMode: {
      default: true,
      live: false,
      description: "Gates the engine's log output. The embind bridges are installed either way.",
    },
    startMenu: {
      default: 'native',
      enum: ['native', 'host'],
      live: false,
      description:
        "Who draws save/character/options: the engine's own menu, or the host from play.game.",
    },
    jsUrl: { live: false, description: 'Emscripten glue URL. Defaults to ./rsdkv4.js.' },
    wasmUrl: { live: false, description: 'WASM URL. Defaults to ./rsdkv4.wasm.' },
  },
  options: {
    // No `default` on any of the three: absence is what "boot normally" means here,
    // and a default would take that away.
    player: {
      live: false,
      description: 'Character for a new game, by name. Choices arrive once the pack is loaded.',
    },
    slot: {
      enum: [null, 0, 1, 2, 3],
      live: false,
      description: 'Save slot 0-3, or null to play without saving.',
    },
    stage: {
      live: false,
      description: 'Jump straight to a stage. Choices arrive once the pack is loaded.',
    },
    // No `default`, for the same reason as the three above: absence is what "the
    // engine polls SDL as usual" means, and only `null` is a release.
    //
    // `live` because it is the one option that reaches a running engine directly
    // rather than through a restart — and the description says the rest out loud,
    // because the contract has no flag for "transient, do not paint, do not
    // persist" and a host reading descriptors to build a settings screen would
    // otherwise put fourteen booleans on it.
    buttons: {
      live: true,
      description:
        'Host-driven input: a live object of 14 booleans the engine reads once per tick, or null to hand input back. Transient — not a settings row, not persistable, and it always reads back as null.',
    },
  },
  assets: {
    data: {
      allowedTypes: ['.rsdk'],
      live: false,
      description: 'The RSDKv4 game data pack. Selects the game; required to start.',
    },
    settings: {
      allowedTypes: ['.ini'],
      live: false,
      description: 'A ready-made settings.ini. Omitted, one is generated from config.',
    },
  },
  storage: {
    namespace: {
      default: 'default',
      live: false,
      description: "Folder for this game's pack, settings and save file.",
    },
    persist: {
      enum: ['opfs', null],
      live: false,
      description: "'opfs' forces persistence, null keeps nothing, absent auto-detects.",
    },
  },
};
