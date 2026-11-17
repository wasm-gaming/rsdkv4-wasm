/**
 * Remapping the controls, in front of RSDKv4.
 *
 * The engine binds its keys in the generated `settings.ini` (`[Keyboard 1]`, read once at
 * boot) and its pad through SDL's game-controller layer; both reach it through Emscripten's
 * SDL2 on the page. So a player's bindings are applied live, before SDL sees anything:
 *
 * - **Keys**: a physical key bound to a control is swallowed and replayed as the key the engine
 *   binds that control to by default; a default key no control has any more is swallowed.
 * - **Pads**: `navigator.getGamepads()` is wrapped while the game runs, and each pad's buttons
 *   are reordered so that the button a player chose sits where the engine's default looks for it.
 *
 * The controls are the ones the Sonics read: the d-pad, A B C and Start.
 */

import { RSDKV4_INPUT } from './rsdkv4.options.js';

/** A control a player can rebind: its default key (`KeyboardEvent.code` / `.key`) and pad button. */
export interface Rsdkv4ControlSpec {
  id: string;
  label: string;
  code: string;
  key: string;
  /** Its button by default (standard mapping). */
  button: number;
}

const KEY_OF: Readonly<Record<string, string>> = { KeyA: 'a', KeyS: 's', KeyD: 'd', Enter: 'Enter' };
const control = (id: 'a' | 'b' | 'c' | 'start' | 'up' | 'down' | 'left' | 'right', label: string): Rsdkv4ControlSpec => {
  const code = RSDKV4_INPUT.keyboard[id];
  return { id, label, code, key: KEY_OF[code] ?? code, button: RSDKV4_INPUT.gamepad[id] as number };
};

/** The engine's default bindings (`RSDKV4_INPUT`), for the controls the Sonics read. */
export const RSDKV4_CONTROLS: readonly Rsdkv4ControlSpec[] = Object.freeze([
  control('a', 'A'),
  control('b', 'B'),
  control('c', 'C'),
  control('start', 'Start'),
  control('up', 'Up'),
  control('down', 'Down'),
  control('left', 'Left'),
  control('right', 'Right'),
]);

/** The player's bindings, by control id: physical keys and pad buttons. */
export interface Rsdkv4Controls {
  keys?: Record<string, string>;
  buttons?: Record<string, number>;
}

export interface Rsdkv4ControlTables {
  /** Physical key → the control's default key, for the keys that moved. */
  keys: Map<string, Rsdkv4ControlSpec>;
  /** Default keys no control has any more. */
  blocked: Set<string>;
  /** Default button → the button the player chose for that control, where they differ. */
  pad: Map<number, number>;
}

export function controlTables(controls: Rsdkv4Controls = {}): Rsdkv4ControlTables {
  const keys = new Map<string, Rsdkv4ControlSpec>();
  const bound = new Set<string>();
  const pad = new Map<number, number>();
  for (const control of RSDKV4_CONTROLS) {
    const physical = controls.keys?.[control.id] ?? control.code;
    bound.add(physical);
    if (physical !== control.code) keys.set(physical, control);
    const button = controls.buttons?.[control.id] ?? control.button;
    if (button !== control.button) pad.set(control.button, button);
  }
  const blocked = new Set(RSDKV4_CONTROLS.map((control) => control.code).filter((code) => !bound.has(code)));
  return { keys, blocked, pad };
}

type PadLike = {
  readonly id: string;
  readonly index: number;
  readonly connected: boolean;
  readonly mapping: string;
  readonly timestamp: number;
  readonly axes: readonly number[];
  readonly buttons: ReadonlyArray<{ pressed: boolean; touched?: boolean; value: number }>;
};

/** A pad with its buttons reordered by `pad` (default button → chosen button). */
export function remapPad<T extends PadLike>(source: T, table: ReadonlyMap<number, number>): PadLike {
  if (table.size === 0) return source;
  const buttons = [...source.buttons];
  for (const [target, from] of table) {
    const button = source.buttons[from];
    buttons[target] = button ? { pressed: button.pressed, touched: button.touched ?? button.pressed, value: button.value } : { pressed: false, touched: false, value: 0 };
  }
  // A button taken for a control does only that: where it was not itself a control's
  // default slot, what the engine would read there by default is released.
  const targets = new Set(table.keys());
  for (const from of table.values()) {
    if (!targets.has(from)) buttons[from] = { pressed: false, touched: false, value: 0 };
  }
  return {
    id: source.id,
    index: source.index,
    connected: source.connected,
    mapping: source.mapping,
    timestamp: source.timestamp,
    axes: source.axes,
    buttons,
  };
}

/** `KeyboardEvent.keyCode` of the default keys, which SDL's Emscripten port also reads. */
const KEY_CODES: Readonly<Record<string, number>> = {
  Enter: 13,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
};
export const keyCodeOf = (control: Rsdkv4ControlSpec): number =>
  KEY_CODES[control.code] ?? control.key.toUpperCase().charCodeAt(0);
