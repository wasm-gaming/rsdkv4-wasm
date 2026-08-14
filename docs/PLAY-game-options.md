# `play.options()` — lo que declara el pack

> **No es la API publicada.** Describe el contrato 1.0
> ([`EngineSDK`/`EnginePlay`](https://github.com/wasm-gaming/engine-specs)), todavía sin
> implementar aquí. Para la API de hoy (`0.1.5`, `instance.game.options()`) ver
> [SDK-examples.md](SDK-examples.md).

Las opciones son **de la partida**, y sus claves las declara el `Data.rsdk` cargado — no el
manifest. Por eso no hay esquema estático que consultar: hasta que no hay un pack abierto, nadie
sabe si los personajes son tres o cuatro, ni si este juego tiene spindash.

```js
const props = await play.options()
await play.options({ spindash: 1 })
```

Es la diferencia con [`config`](PLAY-game-config.md), que es del motor y es idéntico en Sonic 1 y
en Sonic 2.

## Leer

```js
await play.options()
{
  // ─── la sesión ────────────────────────────────────────────────────────
  slot:   { value: 0, type: 'integer', enum: [0, 1, 2, 3], title: 'Save slot', readOnly: true },
  player: {
    value: 0,
    type: 'integer',
    enum: [0, 1, 2, 3],
    enumNames: ['SONIC', 'TAILS', 'KNUCKLES', 'SONIC & TAILS'],
    title: 'Character',
    readOnly: true,
  },
  stage: {
    value: 12,
    type: 'integer',
    enum: [0, 1, 2, /* … */],
    enumNames: ['Presentation / TITLE SCREEN', /* … */, 'Regular / GREEN HILL ZONE 1'],
    title: 'Level',
  },

  // ─── las reglas del juego: distintas en Sonic 1 y Sonic 2 ─────────────
  spindash:      { value: 0, type: 'boolean', title: 'Spindash' },
  speedCap:      { value: 0, type: 'boolean', title: 'Ground speed cap' },
  airSpeedCap:   { value: 0, type: 'boolean', title: 'Air speed cap' },
  spikeBehavior: { value: 0, type: 'boolean', title: 'S1 spikes' },
  superStates:   { value: 0, type: 'boolean', title: 'Super forms' },
  shieldType: {
    value: 1,
    type: 'integer',
    enum: [0, 1, 2, 3],
    enumNames: ['S1', 'S2', 'S1+S3', 'S2+S3'],
    title: 'Item type',
  },
}
```

Son las filas de la pantalla GAME OPTIONS del propio motor, con el vocabulario JSON Schema de
siempre. `enumNames` sale del pack: los nombres de personaje y de escenario son los que el juego
enseñaría en su menú, en el idioma que toque.

No hay campo `source`: **el método que llamas es la fuente**. `config()` son claves del motor,
`options()` son claves de la partida.

## Escribir: valores planos

```js
await play.options({ spindash: 1 })                  // sólo lo que cambia
await play.options({ shieldType: 2, superStates: 1 })
await play.options({ player: 2 })                    // ✗ lanza: read-only
```

Igual que en `config()`, el setter no acepta la forma del getter (`{ spindash: { value: 1 } }`).

Los cambios se escriben en el motor **y en su fichero de guardado**, exactamente como haría el
menú nativo: si el jugador activa el spindash desde tu UI, sigue activado la próxima vez que
cargue esa ranura.

## `readOnly`: lo que se cambia reiniciando

`slot` y `player` se eligen al abrir la partida, así que no se tocan en caliente. Se cambian con
[`restart()`](PLAY-restarting-game.md), que para eso existe:

```js
await play.restart({ slot: 0, player: 2 })
```

No es una limitación de la API: es que cambiar de personaje a mitad de una zona no significa
nada. `readOnly` marca justo eso —*requiere reiniciar*—, y una pantalla de opciones puede
pintarlo en gris en vez de esconderlo.

## El escenario es una opción más

```js
await play.options({ stage: 14 })   // esto es el warp
```

No hace falta un `warpTo()` aparte: cargar un escenario es escribir `stage`, y la lista de
destinos ya viene en `enum`/`enumNames`. Un selector de nivel es un `<select>` pintado desde la
misma propiedad.

## Agrupar y extraer

```js
const opts = await play.options()

const valores   = Object.fromEntries(Object.entries(opts).map(([k, p]) => [k, p.value]))
const editables = Object.entries(opts).filter(([, p]) => !p.readOnly)
const niveles   = opts.stage.enum.map((v, i) => ({ value: v, label: opts.stage.enumNames[i] }))
```

Como las claves dependen del pack, conviene programar contra lo que hay y no contra una lista
fija:

```js
if ('spindash' in opts) pintarInterruptor(opts.spindash)   // Sonic 1 no lo tiene igual que Sonic 2
```

## Encadenar

```js
await play.pause('menu').options({ spindash: 1 }).resume('menu')

const opts = await play.pause('menu').options()   // consulta: cierra la cadena
```

## Con la fábrica

[`sdk.options({…})`](SDK-sdk-options.md) escribe el payload de la **próxima** partida y no toca la
actual; `play.options({…})` toca la actual y no cambia el payload de la siguiente. Se parecen en
el nombre porque son la misma cosa en dos momentos: antes de abrir la sesión, y con la sesión
abierta.

---

Siguientes: [PLAY-restarting-game.md](PLAY-restarting-game.md) ·
[PLAY-game-config.md](PLAY-game-config.md) ·
[SDK-sdk-options.md](SDK-sdk-options.md)
