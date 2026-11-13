// rsdkv4's own app: the screens a host gets when it mounts this engine instead of
// driving the SDK itself — craft's load-game screen (NO SAVE + four save slots) and a
// pause menu, on the wasm-gaming usability scheme (engine-specs UX.md).
//
//   import * as app from '<engines>/rsdkv4/app/app.js'
//   const handle = await app.mount(target, host)   // EngineApp.mount
//   await handle.unmount()
//
// `host` is engine-specs' EngineAppHost: { game, storage, assets, input, exit }. The
// input is the host's createInput(): resumed it delivers menu actions; suspended (in
// game) only Select+Start and Escape come through, as `menu`.
//
// Plain JS and DOM on purpose: the app ships inside the engine's package next to the
// SDK and loads from a static server, so it imports nothing but the SDK.

import Rsdkv4SDK from '../rsdkv4.sdk.js';

const OWNER = 'app';
const asset = (path) => new URL(`./assets/${path}`, import.meta.url).href;

/**
 * Each pack's zones in its own order (GameConfig.bin, regular list). `scene` is the
 * FIRST scene of the zone: a save points at an act, not a zone (Scrap Brain 3 is
 * scene 17). `art` is how many zones have a portrait. Same table as craft's
 * game.service.js.
 */
export const STAGES = {
  1: {
    folder: 'stages-sonic1',
    scenes: 19,
    art: 7,
    zones: [
      ['GREEN HILL', 0], ['MARBLE', 3], ['SPRING YARD', 6], ['LABYRINTH', 9],
      ['STARLIGHT', 12], ['SCRAP BRAIN', 15], ['FINAL', 18],
    ],
  },
  2: {
    folder: 'stages-sonic2',
    scenes: 21,
    art: 10,
    zones: [
      ['EMERALD HILL', 0], ['CHEMICAL PLANT', 2], ['AQUATIC RUIN', 4], ['CASINO NIGHT', 6],
      ['HILL TOP', 8], ['MYSTIC CAVE', 10], ['OIL OCEAN', 12], ['METROPOLIS', 14],
      ['SKY CHASE', 17], ['WING FORTRESS', 18], ['DEATH EGG', 19], ['HIDDEN PALACE', 20],
    ],
  },
};

/** The pack's own menu scenes, looked up by name in the live stage list. */
const PACK_SCREENS = [
  { list: 0, match: 'LEVEL SELECT', label: 'Level select' },
  { list: 1, match: 'STAGE MENU', label: 'Stage menu' },
];

const PLAYER_ART = ['sonic', 'tails', 'knuckles', 'sonictails'];
const PLAYER_NAMES = ['Sonic', 'Tails', 'Knuckles', 'Sonic y Tails'];
const GEMS = ['#58e058', '#f0a038', '#f078d8', '#9878f0', '#f0f0f0', '#f07878', '#78c0f8'];

/** RSDKv4 stores how many emeralds, not which; an out-of-range value is counted by bits. */
export const emeraldCount = (value) => {
  if (value >= 0 && value <= 7) return value;
  let bits = 0;
  for (let v = value; v > 0; v >>= 1) bits += v & 1;
  return Math.min(bits, 7);
};

/** Zone name, tag and portrait of a save slot, or null for an empty one. */
export const describeSlot = (slot, type) => {
  if (!slot || slot.empty) return null;
  const pack = STAGES[type] ?? STAGES[1];
  if (slot.list === 3) {
    return { name: 'SPECIAL STAGE', tag: `STAGE ${slot.zone + 1}`, act: null, img: asset(`${pack.folder}/special.png`) };
  }
  if (slot.zone < 0 || slot.zone >= pack.scenes) return { name: 'UNKNOWN ZONE', tag: '', act: null, img: '' };
  const index = pack.zones.findLastIndex(([, scene]) => slot.zone >= scene);
  const [name, scene] = pack.zones[index];
  return {
    name,
    tag: `ZONE ${index + 1}`,
    act: slot.zone - scene + 1,
    img: index < pack.art ? asset(`${pack.folder}/zone-${index + 1}.png`) : '',
  };
};

const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let cssLoaded = null;
const loadCss = () =>
  (cssLoaded ??= new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('./app.css', import.meta.url).href;
    link.onload = link.onerror = () => resolve();
    document.head.append(link);
  }));

export async function mount(target, host) {
  await loadCss();

  const root = document.createElement('div');
  root.className = 'rsdk-app';
  root.style.setProperty('--accent', host.game?.accent ?? '#1d4ed8');
  const stage = document.createElement('div');
  stage.className = 'rsdk-stage';
  const overlay = document.createElement('div');
  overlay.className = 'rsdk-overlay';
  root.append(stage, overlay);
  target.append(root);

  /**
   * screen: 'boot' | 'slots' | 'game' | 'pause' | 'confirm' | 'error'
   * The slot screen is the top level before playing; from the pause menu it is one
   * level down (Back returns to the pause menu, not out of the game).
   */
  const state = {
    screen: 'boot',
    status: 'Arrancando el motor…',
    error: null,
    type: 0,
    players: [],
    slots: [],
    focus: 1, // 0 = NO SAVE, 1-4 = slots
    pick: [0, 0, 0, 0, 0], // character per card (NO SAVE + four slots)
    playing: false, // a game has been started at least once
    from: null, // what the slot screen / a confirm returns to
    pause: { items: [], focus: 0 },
    confirm: null, // { title, text, yes, no, onYes, onNo, focus }
  };

  let play = null;
  let leaving = false;
  let destroyed = false;

  const canvasFocus = () => stage.querySelector('canvas')?.focus({ preventScroll: true });

  // ---- screens ------------------------------------------------------------------

  const slotCard = (i) => {
    const focused = state.focus === i ? ' is-focused' : '';
    if (i === 0) {
      const p = state.pick[0];
      return `<button class="card is-nosave${focused}" data-card="0">
        <span class="card-head">Sin guardar</span>
        ${characterPicker(0, p)}
        <span class="card-play">Jugar</span>
      </button>`;
    }
    const slot = state.slots[i - 1];
    const info = describeSlot(slot, state.type);
    if (!info) {
      const p = state.pick[i];
      return `<button class="card is-new${focused}" data-card="${i}">
        <span class="card-head">Partida ${i}</span>
        ${characterPicker(i, p)}
        <span class="card-play">Nueva</span>
      </button>`;
    }
    const gems = emeraldCount(slot.emeralds);
    const char = PLAYER_ART[slot.character] ?? 'sonic';
    return `<button class="card is-saved${focused}" data-card="${i}">
      <span class="card-head">Partida ${i}</span>
      <span class="shot">
        ${info.img ? `<img src="${info.img}" alt="">` : ''}
        <span class="shot-tag">${esc(info.tag)}</span>
        <img class="shot-player" src="${asset(`player-${char}.svg`)}" alt="">
      </span>
      <span class="zone">${esc(info.name)}${info.act ? `<small> · acto ${info.act}</small>` : ''}</span>
      <span class="gems" title="${gems} de 7 esmeraldas">${GEMS.map((c, g) => `<i style="--gem:${c}"${g < gems ? ' class="on"' : ''}></i>`).join('')}</span>
      <span class="stats"><span>Vidas ${slot.lives}</span><span>${String(slot.score).padStart(6, '0')}</span></span>
      <span class="card-play">Continuar</span>
    </button>`;
  };

  const characterPicker = (card, p) => {
    const count = Math.max(1, Math.min(PLAYER_ART.length, state.players.length || 1));
    const name = PLAYER_NAMES[p] ?? state.players[p] ?? '';
    return `<span class="picker" data-player="${PLAYER_ART[p]}">
      <img src="${asset(`player-${PLAYER_ART[p]}.svg`)}" alt="">
      ${count > 1 ? `<span class="picker-name"><b data-pick="${card}" data-dir="-1">‹</b>${esc(name)}<b data-pick="${card}" data-dir="1">›</b></span>` : ''}
    </span>`;
  };

  const hints = (pairs) =>
    `<footer class="rsdk-hints">${pairs.map(([k, t]) => `<span><kbd>${k}</kbd>${t}</span>`).join('')}</footer>`;

  const render = () => {
    if (destroyed) return;
    root.dataset.screen = state.screen;
    const s = state.screen;
    if (s === 'game') {
      overlay.innerHTML = '';
      return;
    }
    if (s === 'boot') {
      overlay.innerHTML = `<section class="rsdk-boot">
        ${host.game?.art ? `<img src="${esc(host.game.art)}" alt="">` : ''}
        <p>${esc(state.status)}</p>
      </section>`;
      return;
    }
    if (s === 'error') {
      overlay.innerHTML = `<section class="rsdk-panel">
        <p class="kicker">${esc(host.game?.title ?? 'RSDKv4')}</p>
        <h2>No se pudo arrancar</h2>
        <p class="text">${esc(state.error)}</p>
        <button class="item is-focused" data-exit>Volver</button>
      </section>`;
      return;
    }
    const base = s === 'confirm' ? state.confirm.under : s;
    let html = '';
    if (base === 'slots') {
      const selected = state.focus;
      const slot = selected > 0 ? state.slots[selected - 1] : null;
      const saved = slot && !slot.empty;
      html += `<section class="rsdk-slots">
        <header><p class="kicker">${esc(host.game?.title ?? '')}</p><h2>Elige partida</h2></header>
        <div class="cards">${[0, 1, 2, 3, 4].map(slotCard).join('')}</div>
        ${hints([
          ['←→', 'partida'],
          ...(saved ? [] : [['↑↓', 'personaje']]),
          ['A', saved ? 'continuar' : 'jugar'],
          ...(saved ? [['Y', 'borrar']] : []),
          ['B', state.playing ? 'volver' : 'salir'],
        ])}
      </section>`;
    } else if (base === 'pause') {
      html += `<section class="rsdk-panel">
        <p class="kicker">${esc(host.game?.title ?? '')}</p>
        <h2>Pausa</h2>
        ${state.pause.items.map((item, i) => `<button class="item${i === state.pause.focus && s !== 'confirm' ? ' is-focused' : ''}" data-item="${i}">${esc(item.label)}${item.hint ? `<small>${esc(item.hint)}</small>` : ''}</button>`).join('')}
        ${hints([['A', 'elegir'], ['B', 'continuar']])}
      </section>`;
    }
    if (s === 'confirm') {
      const c = state.confirm;
      html += `<div class="rsdk-confirm"><section class="rsdk-panel">
        <h2>${esc(c.title)}</h2>
        ${c.text ? `<p class="text">${esc(c.text)}</p>` : ''}
        <div class="row">
          <button class="item${c.focus === 0 ? ' is-focused' : ''}" data-confirm="0">${esc(c.no)}</button>
          <button class="item is-danger${c.focus === 1 ? ' is-focused' : ''}" data-confirm="1">${esc(c.yes)}</button>
        </div>
      </section></div>`;
    }
    overlay.innerHTML = html;
    // On a narrow screen the cards scroll sideways: keep the focused one in view
    // (by hand — scrollIntoView would also scroll the host's page).
    const cards = overlay.querySelector('.cards');
    const focused = cards?.querySelector('.card.is-focused');
    if (cards && focused && cards.scrollWidth > cards.clientWidth) {
      cards.scrollLeft = focused.offsetLeft - (cards.clientWidth - focused.offsetWidth) / 2;
    }
  };

  // ---- transitions --------------------------------------------------------------

  const refreshSlots = (slots) => {
    try {
      state.slots = slots ?? play?.game.saveSlots() ?? [];
    } catch {
      state.slots = [];
    }
  };

  const showSlots = (from = null) => {
    refreshSlots();
    state.from = from;
    state.screen = 'slots';
    play?.pause(OWNER);
    host.input.resume();
    render();
  };

  const startGame = () => {
    const card = state.focus;
    const slot = card === 0 ? null : card - 1;
    const saved = slot !== null && state.slots[slot] && !state.slots[slot].empty;
    const player = saved ? state.slots[slot].character : state.pick[card];
    state.screen = 'game';
    state.playing = true;
    render();
    host.input.suspend();
    play.game.start(slot, player); // also lifts the pause
    canvasFocus();
  };

  const packScreens = () => {
    try {
      const lists = play.devMenu.getStageList();
      return PACK_SCREENS.map((screen) => {
        const scene = (lists[screen.list]?.stages ?? []).findIndex(({ name }) => name?.trim() === screen.match);
        return scene < 0 ? null : { ...screen, scene };
      }).filter(Boolean);
    } catch {
      return [];
    }
  };

  const openPause = () => {
    play?.pause(OWNER);
    state.pause = {
      focus: 0,
      items: [
        { label: 'Continuar', run: closePause },
        { label: 'Cambiar de partida', hint: 'vuelve a las partidas guardadas', run: () => showSlots('pause') },
        ...packScreens().map((screen) => ({
          label: screen.label,
          hint: 'pantalla del propio juego',
          run: () => {
            closePause();
            play.devMenu.loadStage(screen.list, screen.scene);
          },
        })),
        { label: 'Volver al lanzador', run: askExit },
      ],
    };
    state.screen = 'pause';
    host.input.resume();
    render();
  };

  const closePause = () => {
    state.screen = 'game';
    render();
    host.input.suspend();
    play?.resume(OWNER);
    canvasFocus();
  };

  // A confirm sits on top of the screen it was asked from and goes back to it;
  // `state.from` (where the slot screen returns to) is left alone.
  const ask = (options) => {
    state.confirm = { focus: 0, under: state.screen, ...options };
    state.screen = 'confirm';
    render();
  };
  const answer = (yes) => {
    const c = state.confirm;
    state.screen = c.under;
    state.confirm = null;
    render();
    (yes ? c.onYes : c.onNo)?.();
  };

  const exit = async () => {
    if (leaving) return;
    leaving = true;
    try {
      await play?.destroy();
    } catch (error) {
      console.warn('[rsdkv4 app] destroy failed', error);
    }
    play = null;
    host.exit();
  };

  const askExit = () =>
    ask({ title: '¿Volver al lanzador?', text: 'La partida se guarda donde la guarde el juego.', yes: 'Salir', no: 'Seguir', onYes: exit });

  const askDelete = (slot) =>
    ask({
      title: `¿Borrar la partida ${slot + 1}?`,
      text: 'No se puede deshacer.',
      yes: 'Borrar',
      no: 'Cancelar',
      onYes: () => {
        play.game.deleteSave(slot);
        refreshSlots();
        render();
      },
    });

  const cyclePlayer = (card, dir) => {
    const count = Math.max(1, Math.min(PLAYER_ART.length, state.players.length || 1));
    state.pick[card] = (state.pick[card] + dir + count) % count;
    render();
  };

  // ---- input ----------------------------------------------------------------------

  const onSlots = (action) => {
    const card = state.focus;
    const slot = card > 0 ? state.slots[card - 1] : null;
    const saved = slot && !slot.empty;
    if (action === 'left' || action === 'prev') state.focus = Math.max(0, card - 1);
    else if (action === 'right' || action === 'next') state.focus = Math.min(4, card + 1);
    else if ((action === 'up' || action === 'down') && !saved) return cyclePlayer(card, action === 'up' ? -1 : 1);
    else if (action === 'accept') return startGame();
    else if (action === 'more' && saved) return askDelete(card - 1);
    else if (action === 'back' || action === 'menu') {
      if (state.from === 'pause') return openPause();
      return askExit();
    } else return;
    render();
  };

  const onPause = (action) => {
    const p = state.pause;
    if (action === 'up') p.focus = (p.focus + p.items.length - 1) % p.items.length;
    else if (action === 'down') p.focus = (p.focus + 1) % p.items.length;
    else if (action === 'accept') return p.items[p.focus].run();
    else if (action === 'back' || action === 'menu') return closePause();
    else return;
    render();
  };

  const onConfirm = (action) => {
    const c = state.confirm;
    if (action === 'left' || action === 'up') c.focus = 0;
    else if (action === 'right' || action === 'down') c.focus = 1;
    else if (action === 'accept') return answer(c.focus === 1);
    else if (action === 'back') return answer(false);
    else return;
    render();
  };

  const off = host.input.on((action) => {
    if (leaving) return;
    const s = state.screen;
    if (s === 'game') {
      if (action === 'menu') openPause();
    } else if (s === 'slots') onSlots(action);
    else if (s === 'pause') onPause(action);
    else if (s === 'confirm') onConfirm(action);
    else if (s === 'error' && (action === 'accept' || action === 'back')) exit();
    else if (s === 'boot' && action === 'back') exit();
  });

  // Pointer: hover focuses, click activates — the same paths as the pad. Hover is read
  // from real movement only: every render replaces the cards, and the browser fires a
  // fresh pointerover for whatever lands under a resting cursor, which would steal
  // the focus back from the pad on every key.
  let lastPointer = '';
  const onPointer = (event) => {
    if (event.type === 'pointermove') {
      const at = `${event.clientX},${event.clientY}`;
      if (at === lastPointer) return;
      lastPointer = at;
    }
    const el = event.target.closest('[data-card],[data-item],[data-confirm],[data-exit],[data-pick]');
    if (!el || leaving) return;
    if (event.type === 'pointermove') {
      if (el.dataset.card != null && state.screen === 'slots' && state.focus !== +el.dataset.card) {
        state.focus = +el.dataset.card;
        render();
      } else if (el.dataset.item != null && state.pause.focus !== +el.dataset.item) {
        state.pause.focus = +el.dataset.item;
        render();
      }
      return;
    }
    if (el.dataset.pick != null) {
      event.stopPropagation();
      state.focus = +el.dataset.pick;
      return cyclePlayer(+el.dataset.pick, +el.dataset.dir);
    }
    if (el.dataset.card != null) {
      state.focus = +el.dataset.card;
      startGame();
    } else if (el.dataset.item != null) state.pause.items[+el.dataset.item].run();
    else if (el.dataset.confirm != null) answer(el.dataset.confirm === '1');
    else if (el.dataset.exit != null) exit();
  };
  overlay.addEventListener('click', onPointer);
  overlay.addEventListener('pointermove', onPointer);

  const handle = {
    async unmount() {
      destroyed = true;
      leaving = true;
      off();
      overlay.removeEventListener('click', onPointer);
      overlay.removeEventListener('pointermove', onPointer);
      try {
        await play?.destroy();
      } catch {
        /* already gone */
      }
      play = null;
      root.remove();
    },
  };

  // ---- boot -----------------------------------------------------------------------

  render();
  host.input.resume();
  try {
    play = await new Rsdkv4SDK()
      .mount(stage)
      .assets(host.assets)
      .storage(host.storage)
      .config({ startMenu: 'host' })
      .on('saves', ({ detail }) => {
        refreshSlots(detail);
        if (state.screen === 'slots' || state.from === 'slots') render();
      })
      .on('error', ({ detail }) => console.error('[rsdkv4 app]', detail))
      .on('exit', () => exit())
      .start();
    if (destroyed) {
      // Unmounted while booting: nothing to show any more.
      await play.destroy().catch(() => {});
      play = null;
      return handle;
    }
    state.type = play.game.type();
    try {
      state.players = play.game.players();
    } catch {
      state.players = [];
    }
    // The first slot with a game in it is where most people want to be.
    refreshSlots();
    const firstSaved = state.slots.findIndex((slot) => slot && !slot.empty);
    state.focus = firstSaved >= 0 ? firstSaved + 1 : state.slots.findIndex((slot) => slot?.empty) + 1 || 1;
    showSlots();
  } catch (error) {
    console.error('[rsdkv4 app]', error);
    state.error = error?.message ?? String(error);
    state.screen = 'error';
    render();
  }

  return handle;
}
