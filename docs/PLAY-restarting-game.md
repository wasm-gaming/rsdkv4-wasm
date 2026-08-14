# `play.restart()` — abrir y reabrir partidas

> **No es la API publicada.** Describe el contrato 1.0
> ([`EngineSDK`/`EnginePlay`](https://github.com/wasm-gaming/engine-specs)), todavía sin
> implementar aquí. Para la API de hoy (`0.1.5`, `instance.game.start()`) ver
> [SDK-examples.md](SDK-examples.md).

El motor vive una vez; las partidas van y vienen encima. `boot()` da un motor sin sesión, y cada
`restart()` abre otra sobre el mismo wasm — sin reinstanciar nada, sin volver a leer el pack.

```js
await play.restart({ slot: 0, player: 1 })   // ranura 0, TAILS
await play.restart({ slot: null })           // sin guardar
await play.restart()                         // power cycle: repite el payload vigente
```

## El payload es acumulativo

Hay un payload vigente, empieza en el de la fábrica ([SDK-sdk-options.md](SDK-sdk-options.md)) y
cada llamada mezcla el suyo encima, plano y de un nivel:

```js
await sdk.start({ slot: 0, player: 1 })   // { slot: 0, player: 1 }
await play.restart({ slot: 3 })           // { slot: 3, player: 1 }  ← player no se revierte
await play.restart()                      // { slot: 3, player: 1 }
```

O sea que `restart({ slot: 3 })` es `restart({ ...vigente, slot: 3 })`. Si cada payload
reemplazase al anterior, cambiar de ranura te devolvería a SONIC sin decírtelo — justo la
operación que más se hace.

`null` es un valor explícito, no "sin cambios": `{ slot: null }` es *juega sin guardar*. Para
dejar una clave como estaba, se omite.

## Continuar una partida guardada

En una ranura ocupada manda el personaje guardado: pasar `player` no lo cambia, exactamente como
en el menú nativo del motor.

```js
const [ocupada] = (await play.saves()).filter((s) => !s.empty)
await play.restart({ slot: ocupada.id })
```

Las filas son las que pintaría un lanzador:

```js
await play.saves()
// [ { id: 0, empty: false, label: 'GREEN HILL ZONE 1 · SONIC · 3 vidas',
//     meta: { character: 0, lives: 3, score: 12000, emeralds: 2, list: 1, zone: 0 } },
//   { id: 1, empty: true, label: 'NEW GAME', meta: {} }, … ]
```

`label` está listo para pintar; `meta` es lo específico de RSDKv4, por si el host quiere pintar
las esmeraldas. Borrar una ranura es `play.deleteSave(id)`, y la deja en NEW GAME.

## Lo `readOnly` se cambia reiniciando

`player` sale `readOnly: true` en [`play.options()`](PLAY-game-options.md): no se cambia en
caliente, se cambia abriendo otra sesión. Eso no es una limitación de la API, es cómo funciona el
motor — el personaje se elige al empezar.

```js
await play.options({ player: 2 })    // ✗ lanza: read-only
await play.restart({ player: 2 })    // ✓ así
```

El escenario, en cambio, **sí** es caliente: `play.options({ stage: 14 })` es el warp, y no
reinicia nada.

## Qué se emite

`restart()` emite `start` con el payload con el que abrió. **No** vuelve a emitir `ready`: el
motor no ha vuelto a arrancar.

```js
play.on('start', ({ payload }) => console.log('partida', payload))
```

`sdk.start()` sobre una fábrica sin motor emite los dos, en orden: `ready` y luego `start`.

## Encadenar

`restart()` devuelve la cadena, así que la secuencia típica de un menú de pausa se escribe de un
tirón:

```js
await play.pause('menu').restart({ slot: 2 }).resume('menu')
```

Las acciones encadenan; las consultas cierran:

```js
const slots = await play.pause('menu').saves()   // saves() cierra la cadena
```

Y un fallo aborta el resto: si `restart()` rechaza, el `resume('menu')` de después no llega a
ejecutarse — el `catch` recibe el error tipado y la pausa sigue siendo del menú, que es quien
sabe qué hacer con ella.

## Lo que `restart()` no puede hacer

Cambiar el pack. Sonic 1 y Sonic 2 son el mismo wasm con distinto `Data.rsdk`, pero el pack se
lee al arrancar el motor, así que cambiarlo es tirar el motor:

```js
await play.destroy()
await sdk.assets({ data: sonic2 }).storage({ namespace: 'rsdkv4/sonic-2' }).start()
```

`destroy()` cierra la cadena y devuelve `Promise<void>`; ese `await` es la barrera que mantiene la
fábrica congelada hasta que el motor viejo termina de volcar sus partidas. Después, cualquier
método de ese `play` lanza `destroyed`, incluidas las cadenas que estuvieran en vuelo.

Es idempotente: llamarlo dos veces resuelve y no hace nada.

---

Siguientes: [PLAY-game-options.md](PLAY-game-options.md) ·
[PLAY-game-config.md](PLAY-game-config.md) ·
[SDK-starting-game.md](SDK-starting-game.md)
