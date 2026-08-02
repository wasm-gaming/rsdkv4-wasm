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
function characterBadge(player: number, size: 'sm' | 'lg'): HTMLElement {
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
  const hint = el('p', 'rsdk-start-hint', '← → file · ↑ ↓ player · Enter start');
  root.append(heading, grid, hint);

  // If the engine bridge isn't there, everything below degrades quietly: one
  // character to "choose" from, no save data, and a pause menu with nothing in
  // it. That looks like a broken UI, so say what it actually is — the page is
  // running an rsdkv4.wasm older than this SDK, virtually always a cached one.
  if (!reportedPlayers.length) {
    const warning = el(
      'p',
      'rsdk-start-warning',
      'Engine bridge unavailable — this page is running an older rsdkv4.wasm than the SDK expects. Reload with the cache disabled (or clear this site’s storage) after rebuilding.',
    );
    root.insertBefore(warning, grid);
  }

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

  /** Every card, in visual order. */
  const cards = (): HTMLButtonElement[] => [
    ...root.querySelectorAll<HTMLButtonElement>('.rsdk-start-choice'),
  ];

  /**
   * Left/right picks the file, up/down picks who to play as — the two axes of
   * the same screen, so a player never has to leave it. Up/down does nothing on
   * a used file: its character came with the save.
   */
  function onKeyDown(event: KeyboardEvent): void {
    if (!root.isConnected) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape'].includes(event.key)) return;

    // The engine is paused behind this screen and the pause menu would only get
    // in the way, so the overlay keeps these keys to itself.
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') return;

    const all = cards();
    if (!all.length) return;
    const current = all.indexOf(document.activeElement as HTMLButtonElement);

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const step = event.key === 'ArrowLeft' ? -1 : 1;
      all[current < 0 ? 0 : (current + step + all.length) % all.length]?.focus();
      return;
    }

    const card = all[current < 0 ? 0 : current];
    card?.focus();
    cycleCharacter(card, event.key === 'ArrowUp' ? -1 : 1);
  }

  window.addEventListener('keydown', onKeyDown, true);

  /**
   * Change which character an empty file would start as. The card shows one at
   * a time with ▲▼ arrows, the way Mania's save select cycles a file — so the
   * whole card stays a single button and up/down has something to act on.
   */
  function cycleCharacter(card: HTMLButtonElement | undefined, step: number): void {
    if (!card || card.dataset.pick === undefined) return; // a used file: fixed character
    const next = (Number(card.dataset.pick) + step + players.length) % players.length;
    card.dataset.pick = String(next);
    card.querySelector('.rsdk-start-face')?.setAttribute('data-character', String(next));
    const name = players[next] ?? '';
    const caption = card.querySelector('.rsdk-start-where');
    if (caption) caption.textContent = name;
    card.setAttribute('aria-label', card.dataset.labelPrefix + name);
  }

  /**
   * One card, and the whole card is the button: left/right moves between them,
   * up/down changes the character on an unused file, Enter (or a click) starts.
   */
  function buildCard(slot: RsdkSaveSlot | null): HTMLElement {
    const isNoSave = slot === null;
    const card = el('button', 'rsdk-start-card rsdk-start-choice');
    card.type = 'button';
    card.dataset.state = isNoSave ? 'nosave' : slot.empty ? 'empty' : 'filled';
    card.append(el('span', 'rsdk-start-strip', isNoSave ? 'No save' : `Save ${slot.slot + 1}`));

    if (slot && !slot.empty) {
      const character = players[slot.character] ?? 'player';
      card.setAttribute('aria-label', `Continue save ${slot.slot + 1} as ${character}`);
      card.append(
        (() => {
          const art = el('span', 'rsdk-start-art');
          art.append(characterBadge(slot.character, 'lg'));
          return art;
        })(),
        el('span', 'rsdk-start-where', resumePoint(slot) ?? 'In progress'),
        (() => {
          const stats = el('span', 'rsdk-start-stats');
          stats.append(
            el('span', 'rsdk-start-lives', `×${slot.lives}`),
            el('span', 'rsdk-start-score', slot.score.toLocaleString()),
          );
          return stats;
        })(),
        emeraldRow(emeraldCount(slot.emeralds)),
      );
      card.addEventListener('click', () => start(slot.slot, slot.character));
      return card;
    }

    // Unused file (or no-save): the card carries the character choice itself.
    card.dataset.pick = '0';
    card.dataset.labelPrefix = isNoSave
      ? 'Play without saving as '
      : `New game on save ${slot!.slot + 1} as `;
    card.setAttribute('aria-label', card.dataset.labelPrefix + (players[0] ?? ''));

    const art = el('span', 'rsdk-start-art');
    const up = el('span', 'rsdk-start-arrow rsdk-start-arrow--up');
    const down = el('span', 'rsdk-start-arrow rsdk-start-arrow--down');
    up.dataset.step = '-1';
    down.dataset.step = '1';
    art.append(up, characterBadge(0, 'lg'), down);

    card.append(art, el('span', 'rsdk-start-where', players[0] ?? 'New game'), emeraldRow(0));

    // Clicking an arrow cycles instead of starting — the arrows live inside the
    // card button (spans, so the markup stays valid), so the click is routed here.
    card.addEventListener('click', (event) => {
      const arrow = (event.target as HTMLElement).closest<HTMLElement>('.rsdk-start-arrow');
      if (arrow) {
        cycleCharacter(card, Number(arrow.dataset.step));
        return;
      }
      start(isNoSave ? NO_SAVE : slot!.slot, Number(card.dataset.pick));
    });

    return card;
  }

  const slots = engine.game.saveSlots();
  grid.append(buildCard(NO_SAVE), ...(slots.length ? slots : EMPTY_SLOTS).map((s) => buildCard(s)));
  cards()[0]?.focus();

  return teardown;
}

export default mountStartScreens;
