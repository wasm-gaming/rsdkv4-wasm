# `sdk.config()` — ajustes del motor, antes de arrancar

> **No es la API publicada.** Describe el contrato 1.0
> ([`EngineSDK`/`EnginePlay`](https://github.com/wasm-gaming/engine-specs)), todavía sin
> implementar aquí. Para la API de hoy (`0.1.5`, `options` en `load(config)`) ver
> [SDK-examples.md](SDK-examples.md).

**`config` es el motor; `options` es la partida.** Aquí van los ajustes con los que RSDKv4
arranca: idioma, volumen, tamaño de pantalla, quién pinta el menú de inicio. Lo que declara el
pack cargado —personaje, ranura, escenario, las reglas del juego— es la otra mitad
([SDK-sdk-options.md](SDK-sdk-options.md)).

```js
const sdk = new Rsdkv4SDK().config({
  language: 4,            // 0 EN · 1 FR · 2 IT · 3 DE · 4 ES · 5 JP · 6 PT · 7 RU · 8 KO
  startMenu: 'host',      // las pantallas de inicio las pinta el host
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

Todas son opcionales: lo que no pases sale de los `default` del manifest.

## El SDK no las guarda

Ni el setter de la fábrica ni el del motor vivo persisten nada. `config` es una entrada de
arranque, como el pack: **las preferencias las guarda la UI**, donde quiera —incluida la nube,
atadas a la cuenta del jugador—. Una copia local del SDK divergiría de la de la UI en cuanto el
jugador tocase el volumen en otro dispositivo.

Lo que sí se guarda en la carpeta del SDK son las partidas, y eso es `storage()`.

## Leer sin arrancar nada

`config()` sin argumentos es el getter, y es **síncrono**: no hay motor al que preguntar, sólo
`manifest.config` con lo que la cadena haya puesto encima. Con eso se pinta una pantalla de
preferencias completa sin instanciar el wasm.

```js
const sdk = new Rsdkv4SDK().config({ language: 4, bgmVolume: 0.8 })

sdk.config()
{
  language: {
    value: 4,            // lo que se usará
    default: 0,          // lo que dice el manifest
    type: 'integer',
    enum: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    enumNames: ['EN', 'FR', 'IT', 'DE', 'ES', 'JP', 'PT', 'RU', 'KO', 'ZH', 'ZS'],
    title: 'Language',
  },
  bgmVolume:  { value: 0.8,  default: 1,   type: 'number',  minimum: 0, maximum: 1, title: 'Music volume' },
  sfxVolume:  { value: 1,    default: 1,   type: 'number',  minimum: 0, maximum: 1, title: 'SFX volume' },
  screenWidth: {
    value: 424, default: 424, type: 'integer',
    enum: [320, 424], enumNames: ['4:3 clásico', 'Panorámico'], title: 'Screen width',
  },
  useHQModes:       { value: true, default: true, type: 'boolean', title: 'HQ modes' },
  fastForwardSpeed: { value: 8,    default: 8,    type: 'integer', minimum: 1, title: 'Fast forward' },
  dimLimit:         { value: 300,  default: 300,  type: 'integer', minimum: 0, title: 'Dim after (s)' },
  devMenu:          { value: false, default: false, type: 'boolean', title: 'Dev menu' },

  // sólo al arrancar
  vsync:           { value: true,   default: true,   type: 'boolean', readOnly: true, title: 'VSync' },
  engineDebugMode: { value: true,   default: true,   type: 'boolean', readOnly: true },
  startMenu:       { value: 'host', default: 'native', type: 'string', enum: ['native', 'host'], readOnly: true },
}
```

Cada clave viene resuelta: el valor en efecto más el vocabulario JSON Schema que declaró el
manifest (`type`, `enum`, `enumNames`, `minimum`, `maximum`, `title`, `readOnly`). Es
deliberadamente estándar, para que un generador de formularios cualquiera lo pinte sin saber nada
de RSDKv4.

```js
const props = sdk.config()
const editables = Object.entries(props).filter(([, p]) => !p.readOnly)
const valores   = Object.fromEntries(Object.entries(props).map(([k, p]) => [k, p.value]))
```

## `readOnly` no quiere decir inmutable

Quiere decir **que hay que reiniciar para cambiarlo**. `vsync`, `engineDebugMode` y `startMenu`
se fijan al arrancar el motor; se cambian tirando el motor y volviendo a arrancarlo, no en
caliente. Una pantalla de ajustes puede pintarlos en gris con un "requiere reiniciar" en vez de
esconderlos.

El resto se puede tocar con el juego en marcha, y eso es
[`play.config()`](PLAY-game-config.md).

## Se congela con el motor vivo

```js
const play = await sdk.start()

sdk.config({ language: 0 })   // ✗ lanza: frozen
sdk.config()                  // ✓ sigue leyendo: con qué arrancó
```

Las dos lecturas son correctas a la vez, y responden a preguntas distintas:

| | `sdk.config()` | `play.config()` |
| --- | --- | --- |
| coste | síncrono: manifest + cadena | asíncrono: cruza al motor |
| `value` | con lo que arrancó | lo que está en efecto ahora |
| escribir | antes de arrancar | en caliente, sólo esta sesión |

Si el jugador bajó la música con el juego en marcha, discrepan — y cada una acierta en lo suyo.

Para reconfigurar de verdad hay que tirar el motor:

```js
await play.destroy()
await sdk.config({ startMenu: 'native' }).start()
```

## De dónde sale el esquema

De `manifest.config`, que es JSON Schema y viaja en `dist/manifest.json`. Un host puede leerlo sin
importar el SDK:

```js
const manifest = await fetch('/manifest.json').then((r) => r.json())
manifest.config.properties.language.enum   // pintar el selector antes de descargar el wasm
```

Y por eso `video` no necesita campo propio: la geometría nativa es
`manifest.config.properties.screenWidth.default`, una sola fuente de verdad en vez de dos que se
desincronizan.

---

Siguientes: [SDK-sdk-options.md](SDK-sdk-options.md) ·
[PLAY-game-config.md](PLAY-game-config.md) ·
[SDK-starting-game.md](SDK-starting-game.md)
