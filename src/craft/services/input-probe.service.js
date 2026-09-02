
import { $reactive } from 'https://jgermade.github.io/jq79/jq79.js';

// La sonda de input: dos filas sobre el canvas con lo que el navegador tiene
// pulsado y lo que el motor tiene retenido.
//
// Para qué sirve. Una tecla que enciende la fila NAVEGADOR y no la de MOTOR se
// perdió entre SDL y ProcessInput, y eso es un bug del motor. Una que enciende
// las dos y no cambia nada en pantalla llegó entera, y lo que ves es el juego
// decidiendo qué hacer con ella — Sonic no rueda ni se agacha mientras mantienes
// una dirección, y eso es así en el original. Sin la sonda las dos cosas son el
// mismo silencio, que es exactamente por qué este bug se diagnosticó mal una vez.
//
// Fuera del grafo reactivo a propósito. El bucle lee play.input.held sesenta
// veces por segundo, y jq79 atribuye cada lectura de un store al efecto que esté
// corriendo: hacer esto dentro de un `$:` convertiría las catorce teclas en
// dependencias de ese efecto y lo despertaría en cada frame. El rAF es dueño de
// su propio DOM, no toca el de los componentes, y `play` se captura una vez al
// arrancar en vez de leerse de gameService en cada vuelta.
//
// `active` sí es reactivo, porque es un booleano que el menú ESC pinta.

/** El orden de bits del motor. Coincide con RSDKV4_BUTTONS del SDK. */
const BUTTONS = ['up', 'down', 'left', 'right', 'a', 'b', 'c', 'x', 'y', 'z', 'l', 'r', 'start', 'select'];

// KeyboardEvent.code por botón, como los ata [Keyboard 1] de settings.ini, más
// los alias WASD que ProcessInput añade en este build.
//
// x, y, z no aparecen: el ini los ata a KeyA/KeyS/KeyD y el alias direccional les
// gana, así que en este build no tienen tecla. Nada del motor los lee (ni
// PauseMenu.cpp ni Debug.cpp ni Scene.cpp), y Sonic 1 y 2 tampoco.
const CODES = {
  up: ['ArrowUp', 'KeyW'],
  down: ['ArrowDown', 'KeyS'],
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  a: ['KeyZ'],
  b: ['KeyX'],
  c: ['KeyC'],
  x: [],
  y: [],
  z: [],
  l: ['KeyQ'],
  r: ['KeyE'],
  start: ['Enter'],
  select: ['Tab'],
};

// La hoja va aquí y no en styles.css porque la sonda se monta fuera de todo
// componente: así se lleva su propio aspecto y no deja reglas huérfanas en el CSS
// de craft el día que se borre el archivo.
const STYLE = `
#rsdk-input-probe {
  position: fixed;
  left: 12px;
  bottom: 12px;
  z-index: 2147483647;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid #2b3038;
  background: rgba(10, 12, 16, .92);
  color: #e6e8ec;
  font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  pointer-events: none;
  user-select: none;
}
#rsdk-input-probe b {
  display: block;
  color: #9aa3af;
  font-weight: 600;
  letter-spacing: .08em;
  margin-top: 6px;
}
#rsdk-input-probe b:first-child { margin-top: 0; }
#rsdk-input-probe span {
  display: inline-block;
  min-width: 34px;
  margin: 1px;
  padding: 1px 4px;
  border-radius: 4px;
  text-align: center;
  background: #1b1e24;
  color: #5b6270;
}
#rsdk-input-probe span[data-on="1"] { background: var(--tone); color: #fff; }
#rsdk-input-probe p { margin: 8px 0 0; color: #22c55e; }
#rsdk-input-probe p[data-bad="1"] { color: #f87171; }
`;

/** El motor que se está sondeando, capturado en start(). */
let probed = null;
/** El <style> inyectado, o null. */
let sheet = null;
/** El <div> de la sonda, o null. */
let box = null;
/** id del rAF en vuelo, para poder cancelarlo. */
let frame = 0;

const held = new Set();
const onKeyDown = (event) => held.add(event.code);
const onKeyUp = (event) => held.delete(event.code);
// El navegador deja de mandar keyup en cuanto la página pierde el foco, y una
// tecla que se queda pegada en la fila de arriba parecería un fallo del motor.
const onBlur = () => held.clear();

const cell = (label, on, tone) =>
  `<span data-on="${on ? '1' : '0'}" style="--tone:${tone}">${label}</span>`;

function draw() {
  frame = requestAnimationFrame(draw);
  if (!box) return;

  // Todo o nada: si el motor se cayó por debajo, mejor ver la fila apagada que
  // una excepción por frame en la consola.
  let engine = null;
  try {
    engine = probed?.input?.held ?? null;
  } catch {
    engine = null;
  }

  // Lo que el navegador tiene y el motor no. Es la única línea que importa: con
  // ella a cero, el motor está recibiendo lo mismo que la página.
  const lost = engine
    ? BUTTONS.filter((b) => CODES[b].some((code) => held.has(code)) && !engine[b])
    : [];

  box.innerHTML =
    `<b>NAVEGADOR</b><div>${BUTTONS.map((b) =>
      cell(b, CODES[b].some((code) => held.has(code)), '#1d4ed8'),
    ).join('')}</div>` +
    `<b>MOTOR</b><div>${BUTTONS.map((b) => cell(b, !!engine?.[b], '#15803d')).join('')}</div>` +
    `<p data-bad="${lost.length ? '1' : '0'}">${
      !engine
        ? 'el motor no responde'
        : lost.length
          ? `no llegan al motor: ${lost.join(' ')}`
          : 'todo lo pulsado llega al motor'
    }</p>`;
}

export const inputProbe = $reactive({
  active: false,

  /** @param {object} play el motor vivo (gameService.play) */
  start(play) {
    if (this.active) return;
    if (!play?.input || typeof play.input.held !== 'object') {
      console.warn('[craft] este SDK no expone play.input.held — reconstruye con `make build-sdk`');
      return;
    }

    probed = play;
    held.clear();

    sheet = document.createElement('style');
    sheet.textContent = STYLE;
    document.head.appendChild(sheet);

    box = document.createElement('div');
    box.id = 'rsdk-input-probe';
    document.body.appendChild(box);

    // Captura, para que la sonda vea la tecla aunque un overlay la pare después.
    // No para la propagación: el handler de SDL vive en window en fase de burbuja
    // y cortarla aquí sería el teclado entero del motor.
    addEventListener('keydown', onKeyDown, true);
    addEventListener('keyup', onKeyUp, true);
    addEventListener('blur', onBlur);

    frame = requestAnimationFrame(draw);
    this.active = true;
  },

  stop() {
    if (!this.active) return;

    cancelAnimationFrame(frame);
    removeEventListener('keydown', onKeyDown, true);
    removeEventListener('keyup', onKeyUp, true);
    removeEventListener('blur', onBlur);

    box?.remove();
    sheet?.remove();
    box = null;
    sheet = null;
    probed = null;
    frame = 0;
    held.clear();

    this.active = false;
  },

  toggle(play) {
    if (this.active) this.stop();
    else this.start(play);
  },
});
