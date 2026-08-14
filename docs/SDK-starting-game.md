# `Rsdkv4SDK` — arrancar

> **No es la API publicada.** Describe el contrato 1.0
> ([`EngineSDK`/`EnginePlay`](https://github.com/wasm-gaming/engine-specs)), todavía sin
> implementar aquí. Para la API de hoy (`0.1.5`, `load(config)`) ver
> [SDK-examples.md](SDK-examples.md).

Una **fábrica** que se configura encadenando, y un arranque que devuelve el **motor vivo**.
Todo lo de la fábrica es síncrono: apunta, no resuelve.

```js
import { Rsdkv4SDK } from '@wasm-gaming/rsdkv4-wasm'

const sdk = new Rsdkv4SDK()
  .assets({ data: packHandle })          // el pack del jugador — el SDK sólo lee
  .config({ language: 4 })               // ajustes del motor      → SDK-sdk-config.md
  .options({ slot: 0, player: 1 })       // payload por defecto    → SDK-sdk-options.md
  .storage({ namespace: 'rsdkv4/sonic-1' })
  .on('error', report)
  .mount(document.querySelector('#stage'))

const play = await sdk.start()
```

## Tres verbos, y dos son azúcar del tercero

| | qué hace | equivale a |
| --- | --- | --- |
| `sdk.boot()` | motor vivo, sin partida | — |
| `play.restart(payload)` | abre o reabre la partida | — |
| `sdk.start(payload)` | motor vivo **y** partida corriendo | `boot().restart(payload)` |

La equivalencia es literal: así lo implementa la clase base. De ahí que **`boot()` sea
idempotente** —con un motor vivo devuelve *ese* motor— y que `sdk.start(p)` con un motor vivo sea
exactamente `play.restart(p)`. Ninguno de los dos lanza por llamarse dos veces.

## Lo mínimo

```js
const play = await new Rsdkv4SDK()
  .assets({ data: packHandle })
  .storage({ namespace: 'rsdkv4/sonic-1' })
  .mount(el)
  .start()
```

## Arrancar sin abrir partida

`boot()` deja el motor vivo y sin sesión: es donde un lanzador lee las partidas guardadas y pinta
sus tarjetas antes de comprometerse con ninguna.

```js
const play = await sdk.boot()
const slots = await play.saves()
// … el jugador elige …
await play.restart({ slot: 0, player: 1 })
```

Con `capabilities.saves: 'storage'` ni siquiera hace falta arrancar: `sdk.saves()` lee el almacén
desde JS y devuelve las mismas filas. Toda función de la fábrica que necesite motor es azúcar de
`boot().<método>()`; la capacidad sólo dice si ese `boot()` se puede saltar.

## Con el menú nativo del motor

Por defecto las pantallas de guardado y personaje las pinta el propio juego, y el payload sobra.

```js
await new Rsdkv4SDK()
  .assets({ data: packHandle })
  .config({ startMenu: 'native' })       // el valor por defecto
  .mount(el)
  .start()
```

Con `startMenu: 'host'` esas pantallas son tuyas, y entonces `start()`/`restart()` son la única
forma de decir con qué ranura y personaje se empieza.

## El pack es del host

El SDK lo lee; nunca lo escribe, nunca sabe dónde vive. La biblioteca —dónde se guarda, con qué
nombre, cuándo se borra— es del host, que es quien conoce a su usuario.

```js
// 1. pedírselo al jugador con lo que el manifest declara
const { accept, description } = Rsdkv4SDK.manifest.assets.find((a) => a.key === 'data')
const [picked] = await showOpenFilePicker({
  types: [{ description, accept: { 'application/octet-stream': accept } }],
})

// 2. guardarlo donde el host quiera — aquí, su propio OPFS
const dir = await (await navigator.storage.getDirectory())
  .getDirectoryHandle('mi-biblioteca', { create: true })
const stored = await dir.getFileHandle('sonic-1.rsdk', { create: true })
await (await picked.getFile()).stream().pipeTo(await stored.createWritable())

// 3. prestárselo
await new Rsdkv4SDK().assets({ data: stored }).storage({ namespace: 'rsdkv4/sonic-1' }).mount(el).start()
```

Un handle de OPFS se lee **a demanda**, sin que los 40 MB del pack entren en memoria; uno de
`showOpenFilePicker()` no tiene acceso síncrono y obliga a copiar. El host no tiene que saber
cuál toca: eso lo decide el SDK.

`assets()` es **siempre síncrono** —registra fuentes, no las resuelve—, y por eso el valor puede
ser un thunk, incluso `async`. Lo invoca `boot()`, y sólo si el asset hace falta de verdad:

```js
sdk.assets({
  data: async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('mi-biblioteca')
    return await dir.getFileHandle('sonic-1.rsdk')
  },
})

sdk.missingAssets()   // ['data'] — síncrono: mira la cadena, no el disco
```

`missingAssets()` cuenta como ausente lo que no es una `AssetSource` válida, no sólo lo que
falta: un `{}` de una deserialización JSON perdida no cuela.

## Almacenamiento

`storage()` es la carpeta **del SDK**: las partidas guardadas y lo que el motor persista por su
cuenta. Nunca el pack, y nunca las preferencias del jugador.

```js
sdk.storage({ namespace: 'rsdkv4/sonic-1' })
```

Un solo parámetro, el namespace, y lo elige el host — que es lo que le permite separar Sonic 1 de
Sonic 2, y también localizar y vaciar la carpeta él mismo si quiere. **Sin `storage()` no se
guarda nada.**

No hay bandera `required`: si el motor necesita persistencia y no la tiene, el arranque falla solo
con un error tipado que dice *qué* pasó (`storage-unavailable`, `not-isolated`, `storage-locked`,
`quota-exceeded`). Cuando no es imprescindible, se pregunta:

```js
const { persistent } = await play.storage()
if (!persistent) avisar('Esta partida no se guardará')
```

## Dónde se ve

```js
sdk.mount(document.querySelector('#stage'))   // contenedor: escala el SDK
sdk.mount(miCanvas)                           // canvas propio: escalas tú
```

Un canvas sólo se puede fijar **antes** de arrancar: en cuanto el motor vive, el contexto GL está
atado a esa superficie. Mover la imagen con el juego en marcha sí se puede, y es
`play.mount(otroContenedor)`, que reparenta y reajusta.

## Todo de una vez

El constructor acepta el `EngineSetup` entero, que es lo que convierte "restaurar la última
sesión" en una llamada:

```js
const setup = await db.get('sessions', 'last')   // IndexedDB, no JSON
const play = await new Rsdkv4SDK(setup).mount(el).start()
```

**IndexedDB, no JSON**: `JSON.stringify` convierte un `FileSystemFileHandle`, un `ArrayBuffer` o
un `Blob` en `{}` y tira las funciones, sin avisar. `structuredClone` —y por tanto IndexedDB— los
lleva enteros. Sólo la mitad `EngineSetupData` (`config`, `options`, `storage`) sobrevive a JSON.

Que `options` viaje en el setup es justo lo que hace que "restaurar la última sesión" signifique
la partida de antes y no una partida nueva del mismo juego.

## Qué se congela

Con un motor vivo, `assets()`, `config()` y `storage()` lanzan `frozen`: describen al motor, y el
motor ya está arrancado. `options()` **no** se congela — describe la próxima sesión, y abrir otra
sesión es legal siempre ([SDK-sdk-options.md](SDK-sdk-options.md)).

Cambiar de juego es, por tanto, tirar el motor y reconfigurar:

```js
await play.destroy()                                  // cierra la cadena y descongela la fábrica
await sdk.assets({ data: pack2 }).storage({ namespace: 'rsdkv4/sonic-2' }).start()
```

El `await` de `destroy()` es la barrera: la fábrica sigue congelada hasta que el motor viejo
termina de volcar sus partidas, para que nadie repunte `storage()` a mitad del volcado.

## Eventos y errores

```js
sdk.on('progress', ({ key, loaded, total }) => barra(loaded / (total ?? loaded)))
  .on('ready', () => console.log('motor vivo'))
  .on('start', ({ payload }) => console.log('partida abierta', payload))
  .on('error', ({ error }) => report(error.code, error.message))
```

`sdk.start()` emite `ready` y luego `start`; un `restart()` no vuelve a emitir `ready`. Los
errores llegan **por los dos lados** —la promesa rechaza *y* se emite `error`—, así que un host
que no haga `await` no se queda a ciegas.

```js
try {
  await sdk.start()
} catch (e) {
  if (e.code === 'asset-missing') return pedirPack()   // sdk.missingAssets() dice cuál
  if (e.code === 'not-isolated') return avisarCOOP()
  throw e
}
```

---

Siguientes: [SDK-sdk-config.md](SDK-sdk-config.md) ·
[SDK-sdk-options.md](SDK-sdk-options.md) · [PLAY-restarting-game.md](PLAY-restarting-game.md)
