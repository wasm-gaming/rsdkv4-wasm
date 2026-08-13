# SDK — ejemplos del contrato propuesto

> **Esto no es la API publicada.** Es el contrato acordado en
> [SESSIONS/2026-08-13_01h49.engine-specs-refinement.md](../SESSIONS/2026-08-13_01h49.engine-specs-refinement.md),
> todavía sin implementar. Para la API que existe hoy en `@wasm-gaming/rsdkv4-wasm@0.1.5`, ver
> [SDK-examples.md](SDK-examples.md).

La forma es siempre la misma: una **fábrica** que se configura encadenando, un `start()` que
devuelve la **instancia**, y una instancia cuyas acciones encadenan también.

```js
const sdk = new Rsdkv4SDK()
  .assets({ … })       // entradas del jugador — del host, el SDK sólo lee
  .config({ … })       // ajustes del motor, de arranque
  .storage({ … })      // carpeta propia del SDK: settings + partidas
  .on('error', fn)     // eventos
  .mount(el)           // dónde se ve

const instance = await sdk.start({ … })   // o .boot() para no abrir sesión
```

---

## 1. Arranque

### 1.1 Lo mínimo (rsdkv4: el pack ya está en el almacén)

```js
import { Rsdkv4SDK } from '@wasm-gaming/rsdkv4-wasm'

const instance = await new Rsdkv4SDK()
  .storage({ namespace: 'rsdkv4/Sonic1' })
  .mount(document.querySelector('#stage'))
  .start()
```

### 1.2 Arrancar sin abrir partida

`boot()` deja el motor vivo y sin sesión: es donde un lanzador lee las partidas guardadas y
pinta sus tarjetas.

```js
const instance = await sdk.boot()
const slots = await instance.saves()
// … el jugador elige …
await instance.restart({ slot: 0, player: 1 })
```

### 1.3 Con el menú nativo del motor

Sin `startMenu: 'host'`, las pantallas de guardado y personaje las pinta el propio juego y el
payload de `start()` sobra.

```js
await new Rsdkv4SDK()
  .storage({ namespace: 'rsdkv4/Sonic1' })
  .config({ startMenu: 'native' })      // por defecto
  .mount(el)
  .start()                              // manda el menú del motor
```

### 1.4 Un motor que recibe la ROM en memoria

```js
await new FbneoSDK()
  .assets({ rom: await file.arrayBuffer() })
  .mount(el)
  .start()
```

### 1.5 Configuración plana, sin cadena

El constructor acepta el `EngineSetup` completo: es lo que permite guardar la configuración en
JSON, restaurar la última sesión, o escribir tests de tabla.

```js
const setup = JSON.parse(localStorage.getItem('last-session'))
const instance = await new Rsdkv4SDK(setup).mount(el).start()
```

---

## 2. Assets y almacenamiento

### 2.1 Primera vez: preguntar, pedir, escribir

El SDK dice qué le falta; el host consigue el fichero y lo escribe en el destino que el SDK le
da. Ninguno inventa rutas.

```js
const sdk = new Rsdkv4SDK().storage({ namespace: 'rsdkv4/Sonic1' })

for (const missing of await sdk.missingStorage()) {
  // { key: 'data', accept: ['.rsdk'], description: 'RSDKv4 game data pack…' }
  const [handle] = await showOpenFilePicker({
    types: [{ description: missing.description, accept: { 'application/octet-stream': missing.accept } }],
  })
  const file = await handle.getFile()
  const target = await sdk.assetTarget(missing.key)
  await file.stream().pipeTo(await target.createWritable())   // disco a disco, sin heap
}

await sdk.mount(el).start()
```

### 2.2 Siguientes veces

```js
const sdk = new Rsdkv4SDK().storage({ namespace: 'rsdkv4/Sonic1' })
;(await sdk.missingStorage()).length === 0   // true → a jugar
```

### 2.3 Sin persistencia: bytes para esta ejecución

```js
await new Rsdkv4SDK()
  .assets({ data: await file.arrayBuffer() })
  .mount(el)
  .start()
// sin storage(): no se guarda nada, ni partidas ni ajustes
```

### 2.4 Assets perezosos

El thunk sólo se invoca si hace falta; devolver un handle evita la copia.

```js
sdk.assets({
  data: async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('mi-biblioteca')
    return await dir.getFileHandle('Sonic1.rsdk')     // handle: lectura a demanda
  },
})
```

### 2.5 El host con su propio layout

```js
sdk.assets({ data: miHandleDeOPFS })   // el SDK lee, no es dueño de nada
```

### 2.6 Qué le falta al host, y qué al jugador

```js
sdk.missingAssets()          // síncrono, mira la cadena → bug del programador
await sdk.missingStorage()   // asíncrono, mira el disco → falta pedírselo al jugador
```

### 2.7 Borrar lo que el SDK escribió

```js
await instance.purgeStorage()   // { settings: true, saves: true }
// nunca toca los assets: no son suyos
```

---

## 3. Sesiones

### 3.1 Empezar una partida concreta

```js
await sdk.start({ slot: 0, player: 1 })   // ranura 0, segundo personaje
await sdk.start({ slot: null })           // sin guardar
await sdk.start()                         // valores por defecto
```

### 3.2 Qué acepta el payload, en este pack

`manifest` no puede saber los personajes: salen del `Data.rsdk` cargado.

```js
const schema = await instance.startSchema()
// { type: 'object', properties: {
//     slot:   { type: ['integer','null'], minimum: 0, maximum: 3 },
//     player: { type: 'integer', enum: [0,1,2,3],
//               enumNames: ['SONIC','TAILS','KNUCKLES','SONIC & TAILS'] } } }
```

### 3.3 Reiniciar con otros parámetros

```js
await instance.restart({ slot: 2 })   // en caliente, sin tocar el wasm
await instance.restart()              // power cycle
```

### 3.4 Continuar una partida guardada

El personaje guardado manda: pasar `player` en una ranura ocupada no hace nada.

```js
const [slot] = (await instance.saves()).filter((s) => !s.empty)
await instance.restart({ slot: slot.id })
```

### 3.5 Cambiar de juego

Cambiar el pack **rearranca el motor** y se nota en los eventos (`exit` y luego `ready`).

```js
await instance.destroy()
await sdk.storage({ namespace: 'rsdkv4/Sonic2' }).start()
```

---

## 4. `config()` y `options()`

`config` son ajustes de arranque, congelados mientras haya instancia viva. `options` son
valores vivos: los del motor que se pueden cambiar en marcha, más los que expone el pack.

### 4.1 Ajustes de arranque

```js
sdk.config({
  language: 4,            // 0 EN · 1 FR · 2 IT · 3 DE · 4 ES · 5 JP · 6 PT · 7 RU · 8 KO
  startMenu: 'host',      // las pantallas las pinta el host
  screenWidth: 424,       // 320 = 4:3 clásico
  vsync: true,
  bgmVolume: 0.8,
  sfxVolume: 1,
  devMenu: false,
  engineDebugMode: true,
  fastForwardSpeed: 8,
  dimLimit: 300,          // segundos sin input antes de atenuar; 0 = nunca
  useHQModes: true,
})
```

### 4.2 Leer las opciones vivas

```js
const rows = await instance.options()
// [{ key: 'bgmVolume', label: 'Music volume', value: 0.8, type: 'number',  source: 'engine' },
//  { key: 'spindash',  label: 'Spindash',     value: 0,   type: 'boolean', source: 'game' },
//  { key: 'shieldType', label: 'Item type', value: 1, type: 'enum', source: 'game',
//    values: ['S1', 'S2', 'S1+S3', 'S2+S3'] }]

const porGrupo = Object.groupBy(rows, (r) => r.source)   // Motor / Juego
```

### 4.3 Escribirlas

```js
await instance.options({ spindash: 1, bgmVolume: 0.5 })
await instance.options({ vsync: false })   // ✗ lanza: vsync no es viva, sólo de arranque
```

### 4.4 El escenario es una opción más

```js
const stage = (await instance.options()).find((r) => r.key === 'stage')
// { key: 'stage', label: 'Level', value: 12, type: 'enum', source: 'game',
//   values: ['Presentation / TITLE SCREEN', …, 'Regular / GREEN HILL ZONE 1', …] }

await instance.options({ stage: 14 })   // esto es el warp
```

### 4.5 Sólo los valores

```js
const values = Object.fromEntries((await instance.options()).map((r) => [r.key, r.value]))
```

---

## 5. Ciclo de vida

### 5.1 Pausa con dueño

Sólo quien pausó puede reanudar, así que un overlay no puede reanudar lo que congeló otro.

```js
const OWNER = { menu: 'menu', startScreen: 'start-screen' }

await instance.pause(OWNER.startScreen)
await instance.resume(OWNER.menu)          // ignorado: la pausa es de otro
await instance.resume(OWNER.startScreen)   // ahora sí
```

### 5.2 Encadenar acciones

```js
await instance.pause(OWNER.menu).options({ spindash: 1 }).resume(OWNER.menu)
```

### 5.3 Los getters cierran la cadena

```js
const slots = await instance.pause(OWNER.menu).saves()   // pausa y devuelve datos
// a partir de aquí no se encadena: lo que llega son filas, no la instancia
```

### 5.4 Un fallo aborta el resto

```js
try {
  await instance.options({ vsync: false }).restart({ slot: 1 })   // restart no llega a correr
} catch (e) {
  console.error(e)
}
```

### 5.5 Cerrar

```js
await instance.destroy()   // para el bucle, calla el audio, vuelca partidas, suelta el canvas
```

---

## 6. Render

### 6.1 Contenedor: el SDK escala

```js
sdk.mount(document.querySelector('#stage'))
```

### 6.2 Canvas propio: escalas tú

```js
sdk.mount(document.querySelector('canvas#mio'))   // sólo antes de start()
```

### 6.3 Mover la imagen con el juego en marcha

```js
await instance.mount(document.querySelector('#fullscreen-box'))   // reparenta y reajusta
```

### 6.4 Colocarlo a mano

```js
document.querySelector('#stage').appendChild(sdk.canvasEl)   // entonces el tamaño es tuyo
```

### 6.5 Lo que no se puede

```js
await instance.mount(otroCanvas)   // ✗ lanza: el contexto GL quedó atado al arrancar
```

---

## 7. Eventos y errores

### 7.1 Catálogo

```js
sdk
  .on('ready',    () => console.log('motor arriba'))
  .on('start',    ({ payload }) => console.log('sesión', payload))
  .on('progress', ({ key, loaded, total }) => barra.value = loaded / total)
  .on('frame',    ({ fps }) => hud.textContent = `${fps} fps`)
  .on('error',    ({ error }) => console.error(error))
  .on('exit',     () => volverAlLanzador())
```

Los handlers de la fábrica se copian a cada instancia nueva; lo que la instancia añada o quite
no afecta a la fábrica.

```js
const onFrame = ({ fps }) => …
instance.on('frame', onFrame)
instance.off('frame', onFrame)
```

### 7.2 Errores tipados

```js
try {
  await sdk.start({ slot: 0 })
} catch (e) {
  switch (e.code) {
    case 'storage-required':    return pedirNamespace()
    case 'storage-unavailable': return avisar('Tu navegador no permite guardar partidas')
    case 'not-isolated':        return avisar('La página necesita COOP/COEP')
    case 'storage-locked':      return avisar('Cierra la otra pestaña con el juego abierto')
    case 'quota-exceeded':      return avisar('No hay espacio para el juego')
    case 'asset-missing':       return pedirFichero()
    case 'asset-invalid':       return avisar('Ese fichero no es un pack válido')
    case 'unsupported-browser': return avisar('Necesitas un navegador más reciente')
    default: throw e
  }
}
```

El error llega **por las dos vías**: la promesa rechaza y además se emite `error`, para que un
host que no hace `await` no se quede a ciegas.

### 7.3 Persistencia obligatoria o degradada

```js
sdk.storage({ namespace: 'rsdkv4/Sonic1', required: true })   // sin OPFS → error al arrancar

// o dejar que arranque y consultarlo
const { persistent } = await instance.storage()
if (!persistent) avisar('Esta partida no se guardará')
```

---

## 8. Consultas

### 8.1 Partidas guardadas

```js
const slots = await instance.saves()
// [{ id: 0, empty: false, label: 'Green Hill Zone 1 · SONIC · 3 vidas',
//    meta: { character: 0, lives: 3, score: 12000, emeralds: 2 } },
//  { id: 1, empty: true, label: 'NEW GAME', meta: {} }, …]

await instance.deleteSave(2)
```

### 8.2 Sin arrancar el motor

```js
const slots = await sdk.saves()   // capabilities.savesOffline
```

Sirve para pintar las tarjetas antes de pagar el arranque; devuelve las mismas filas que
`instance.saves()`.

### 8.3 Qué sabe el motor de sí mismo

```js
Rsdkv4SDK.manifest        // sin instanciar nada: artefactos, assets, vídeo, input, capacidades
Rsdkv4SDK.manifest.capabilities
// { sram: true, saveSlots: true, savesOffline: true, saveStates: false,
//   multiInstance: false, coreSelectable: false }
```

---

## 9. Casos completos

### 9.1 Lanzador de dos juegos

```js
import { Rsdkv4SDK } from '@wasm-gaming/rsdkv4-wasm'

const JUEGOS = { Sonic1: 'Sonic the Hedgehog', Sonic2: 'Sonic the Hedgehog 2' }
let sdk = null
let instance = null

async function elegirJuego(id) {
  sdk = new Rsdkv4SDK()
    .storage({ namespace: `rsdkv4/${id}` })
    .on('error', ({ error }) => mostrarError(error))
    .on('exit', () => volverALaBiblioteca())

  const faltan = await sdk.missingStorage()
  if (faltan.length) return pedirPack(faltan[0])

  return pintarTarjetas(await sdk.saves())     // sin arrancar el motor
}

async function pedirPack({ key, accept, description }) {
  const [h] = await showOpenFilePicker({
    types: [{ description, accept: { 'application/octet-stream': accept } }],
  })
  const file = await h.getFile()
  await file.stream().pipeTo(await (await sdk.assetTarget(key)).createWritable())
  return elegirJuego(juegoActual)
}

async function jugar(slot, player) {
  instance = await sdk.mount(document.querySelector('#stage')).start({ slot, player })
}

async function salir() {
  await instance?.destroy()
  instance = null
}
```

### 9.2 Menú de pausa

```js
window.addEventListener('keydown', async (e) => {
  if (e.key !== 'Escape' || !instance) return
  e.preventDefault()

  if (menuAbierto) {
    await instance.resume('menu')
    menuAbierto = false
    sdk.canvasEl.focus({ preventScroll: true })      // SDL lee el teclado del canvas
  } else {
    await instance.pause('menu')
    menuAbierto = true
    pintarMenu(await instance.options())
  }
}, true)   // capture: la tecla no llega al canvas
```

### 9.3 Selector de personaje desde el motor

```js
const schema = await instance.startSchema()
const nombres = schema.properties.player.enumNames    // del pack, no cableados

pintarBotones(nombres, (i) => instance.restart({ slot: ranuraElegida, player: i }))
```

### 9.4 Varias instancias

```js
if (!MiSDK.manifest.capabilities.multiInstance) {
  await instance.destroy()      // obligatorio antes de otro start()
}
const otra = await sdk.mount(otroBox).start()
```

---

## 10. TypeScript

Los genéricos se cierran por motor, así que los payloads dejan de ser bolsas opacas.

```ts
import { Rsdkv4SDK, type Rsdkv4Config, type Rsdkv4Start } from '@wasm-gaming/rsdkv4-wasm'

const sdk = new Rsdkv4SDK()
sdk.config({ startMenu: 'host' })          // ✓
sdk.config({ startMenu: 'hots' })          // ✗ error de compilación
await sdk.start({ player: 'TAILS' })       // ✗ error: player es un índice
await sdk.start({ player: 1 })             // ✓
```

Y el motor conforma el contrato en compilación, que es lo que hoy no comprueba nadie:

```ts
import type { EngineSDKClass } from '@wasm-gaming/engine-specs'
const _contract: EngineSDKClass = Rsdkv4SDK
```

---

## 11. Equivalencias con la API de hoy

| hoy (`0.1.5`) | propuesto |
| --- | --- |
| `sdk.load({ attachTo, … })` | `new Rsdkv4SDK().mount(el).start()` |
| `config.dataProvider` | `.assets({ data: () => … })` |
| `config.storageNamespace` | `.storage({ namespace })` |
| `config.options` | `.config({ … })` |
| `config.onEvent` | `.on(tipo, fn)` |
| `instance.start()` | — (era un no-op; arrancar es de la fábrica) |
| `instance.game.start(slot, player)` | `sdk.start({ slot, player })` · `instance.restart({ … })` |
| `instance.game.players()` | `instance.startSchema()` |
| `instance.game.saveSlots()` | `instance.saves()` · `sdk.saves()` |
| `instance.game.deleteSave(n)` | `instance.deleteSave(n)` |
| `instance.game.options()` · `setOption()` | `instance.options()` · `options({ … })` |
| `instance.game.type()` | — (descartado: el host sabe qué instaló) |
| `instance.devMenu.getStageList()` · `loadStage()` | `instance.options()` · `options({ stage })` |
| `instance.devMenu.setPaused()` | `instance.pause(owner)` · `resume(owner)` |
| `instance.reset()` (lanzaba) | `instance.restart(payload)` |
| `instance.persistent` | `await instance.storage()` |
| `instance.purgeStorage()` | igual, pero ya no borra el pack del jugador |
