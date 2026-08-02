// The demo's save-select screen: one screen that picks the save slot *and* the
// character, laid out like Sonic Mania's — a row of portrait cards, each with its
// status on top, the character in the middle and the chaos emeralds along the
// bottom, plus a NO SAVE card.
//
// A card with a game in it starts that game as its saved character. A card with
// nothing in it shows the playable characters inline, so choosing a file and
// choosing who to play as is one action instead of two screens.
//
// This replaces RSDKv4's own in-canvas Start Menu (the engine is booted with
// `skipStartMenu: true`) and drives the engine through `instance.game`, which
// mirrors the native menu's logic exactly — same globals, same saveRAM, same
// InitStartingStage call. So a game started from here is indistinguishable from
// one started through the engine's screens.
//
// The artwork is CSS (see theme.rsdkv4.css, `.rsdk-start-*`); the only image is
// the optional game logo the host passes in.

import type { Rsdkv4Instance, RsdkSaveSlot } from '@wasm-gaming/rsdkv4-wasm';

/** Playing without a save slot — the engine's "no save" mode. */
const NO_SAVE = null;

/** Who holds the pause while this screen is up (see EngineInstance.pause). */
const PAUSE_OWNER = 'start-screens';

export interface StartScreensOptions {
  /** Shown above the cards, e.g. "Sonic the Hedgehog". */
  title?: string;
  /** Optional logo to show instead of the title text (e.g. the game's SVG). */
  logo?: string;
  /** Called once the player has committed to a game. */
  onStart?: (choice: { slot: number | null; player: number }) => void;
}

/**
 * RSDKv4 has four save slots — always, whatever is in them. If the engine bridge
 * can't be reached (an old rsdkv4.wasm, typically a cached one; the SDK logs
 * which export is missing) show them anyway rather than an empty screen: a new
 * game only needs `game.start()`, which is a different export.
 */
const EMPTY_SLOTS: RsdkSaveSlot[] = [0, 1, 2, 3].map((slot) => ({
  slot,
  empty: true,
  character: 0,
  lives: 3,
  score: 0,
  emeralds: 0,
  list: -1,
  zone: -1,
}));

/** Same reasoning for the character list: never leave the player with no way on. */
const FALLBACK_PLAYERS = ['Start'];

/**
 * Number of emeralds to draw. RSDKv4 stores a plain count, but a corrupt or
 * unfamiliar save could hold a bitfield instead of a small number — treat
 * anything out of range as bits so a card can't render 4 billion gems.
 */
function emeraldCount(value: number): number {
  if (value >= 0 && value <= 7) return value;
  let bits = 0;
  for (let v = value; v > 0; v >>= 1) bits += v & 1;
  return Math.min(bits, 7);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A character badge: colours come from CSS, keyed on the engine's player index. */
function characterBadge(player: number, size: 'sm' | 'md' | 'lg'): HTMLElement {
  const badge = el('span', `rsdk-start-face rsdk-start-face--${size}`);
  badge.dataset.character = String(player);
  return badge;
}

/** The seven chaos emeralds, `owned` of them lit. */
function emeraldRow(owned: number): HTMLElement {
  const gems = el('span', 'rsdk-start-gems');
  for (let i = 0; i < 7; i++) {
    const gem = el('i', 'rsdk-start-gem');
    gem.dataset.gem = String(i);
    if (i < owned) gem.classList.add('is-owned');
    gems.appendChild(gem);
  }
  return gems;
}

export function mountStartScreens(
  container: HTMLElement,
  engine: Rsdkv4Instance,
  options: StartScreensOptions = {},
): () => void {
  const stageLists = engine.devMenu.getStageList();
  const reportedPlayers = engine.game.players();
  const players = reportedPlayers.length ? reportedPlayers : FALLBACK_PLAYERS;
  const title = options.title ?? 'Save select';

  // Hold the engine while the player decides, under our own name: the pause
  // menu's resume() carries a different owner, so opening and closing it on top
  // of this screen cannot start the game behind our back.
  engine.pause(PAUSE_OWNER);

  const root = el('div', 'rsdk-start');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Save select');

  const heading = el('h2', 'rsdk-start-title', title);
  if (options.logo) {
    const logo = el('img', 'rsdk-start-logo');
    logo.src = options.logo;
    logo.alt = title;
    heading.replaceChildren(logo);
  }

  const grid = el('div', 'rsdk-start-grid');
  const hint = el('p', 'rsdk-start-hint', '← → choose · Enter start');
  root.append(heading, grid, hint);
  container.appendChild(root);

  /** Where a save resumes, as a human-readable stage name. */
  const resumePoint = (slot: RsdkSaveSlot): string | null => {
    if (slot.empty || slot.list < 0) return null;
    return stageLists[slot.list]?.stages?.[slot.zone]?.name ?? null;
  };

  const teardown = (): void => {
    window.removeEventListener('keydown', onKeyDown, true);
    root.remove();
  };

  const start = (slot: number | null, player: number): void => {
    // Resumes the engine as a side effect — the overlay is done with it.
    engine.game.start(slot, player);
    options.onStart?.({ slot, player });
    teardown();
  };

  /** Every focusable choice on the screen, in visual order. */
  const choices = (): HTMLButtonElement[] => [
    ...root.querySelectorAll<HTMLButtonElement>('.rsdk-start-choice'),
  ];

  /** Arrow keys walk the choices; the screen keeps the keys off the engine. */
  function onKeyDown(event: KeyboardEvent): void {
    if (!root.isConnected) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape'].includes(event.key)) return;

    // The engine is paused behind this screen and the pause menu would only get
    // in the way, so the overlay keeps these keys to itself.
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') return;

    const buttons = choices();
    if (!buttons.length) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    buttons[current < 0 ? 0 : (current + step + buttons.length) % buttons.length]?.focus();
  }

  window.addEventListener('keydown', onKeyDown, true);

  /**
   * One card. `slot` is null for the NO SAVE card. A card with a saved game is a
   * single button; an empty one carries a button per playable character, which
   * is what merges "pick a file" and "pick a player" into one screen.
   */
  function buildCard(slot: RsdkSaveSlot | null): HTMLElement {
    const isNoSave = slot === null;
    const card = el('div', 'rsdk-start-card');
    card.dataset.state = isNoSave ? 'nosave' : slot.empty ? 'empty' : 'filled';

    card.append(el('span', 'rsdk-start-strip', isNoSave ? 'No save' : `Save ${slot.slot + 1}`));

    if (slot && !slot.empty) {
      const pick = el('button', 'rsdk-start-choice rsdk-start-continue');
      pick.type = 'button';
      pick.setAttribute(
        'aria-label',
        `Continue save ${slot.slot + 1} as ${players[slot.character] ?? 'player'}`,
      );
      pick.append(
        characterBadge(slot.character, 'lg'),
        el('span', 'rsdk-start-where', resumePoint(slot) ?? 'In progress'),
        (() => {
          const stats = el('span', 'rsdk-start-stats');
          stats.append(
            el('span', 'rsdk-start-lives', `×${slot.lives}`),
            el('span', 'rsdk-start-score', slot.score.toLocaleString()),
          );
          return stats;
        })(),
      );
      pick.addEventListener('click', () => start(slot.slot, slot.character));
      card.append(pick, emeraldRow(emeraldCount(slot.emeralds)));
      return card;
    }

    // Empty file (or no-save): choose who to play as, right here.
    const caption = el('span', 'rsdk-start-where', isNoSave ? 'No progress kept' : 'New game');
    const picks = el('div', 'rsdk-start-chars');

    players.forEach((name, index) => {
      const pick = el('button', 'rsdk-start-choice rsdk-start-char');
      pick.type = 'button';
      pick.title = name;
      pick.setAttribute(
        'aria-label',
        isNoSave ? `Play as ${name} without saving` : `New game on save ${slot!.slot + 1} as ${name}`,
      );
      pick.append(characterBadge(index, 'md'));
      // Name the character being considered, rather than trying to fit four
      // labels across a card this narrow.
      const show = () => (caption.textContent = name);
      const reset = () => (caption.textContent = isNoSave ? 'No progress kept' : 'New game');
      pick.addEventListener('pointerenter', show);
      pick.addEventListener('focus', show);
      pick.addEventListener('pointerleave', reset);
      pick.addEventListener('blur', reset);
      pick.addEventListener('click', () => start(isNoSave ? NO_SAVE : slot!.slot, index));
      picks.appendChild(pick);
    });

    card.append(picks, caption, emeraldRow(0));
    return card;
  }

  const slots = engine.game.saveSlots();
  grid.append(buildCard(NO_SAVE), ...(slots.length ? slots : EMPTY_SLOTS).map((s) => buildCard(s)));
  choices()[0]?.focus();

  return teardown;
}

export default mountStartScreens;
