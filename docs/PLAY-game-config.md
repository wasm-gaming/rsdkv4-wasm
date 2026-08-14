# `play.config()` — los ajustes del motor, en caliente

> **No es la API publicada.** Describe el contrato 1.0
> ([`EngineSDK`/`EnginePlay`](https://github.com/wasm-gaming/engine-specs)), todavía sin
> implementar aquí. Para la API de hoy (`0.1.5`) ver [SDK-examples.md](SDK-examples.md).

Las mismas claves que [`sdk.config()`](SDK-sdk-config.md) —idioma, volúmenes, pantalla, dev
menu—, pero contra el motor vivo: leídas como están ahora, y escritas sin reiniciar.

```js
const props = await play.config()
await play.config({ bgmVolume: 0.5 })
```

Es asíncrono porque cruza al motor. `sdk.config()` era síncrono porque no había a quién
preguntar.

## Leer

```js
await play.config()
{
  language:   { value: 4,   default: 0, type: 'integer', enum: [0,1,2,3,4,5,6,7,8,9,10],
                enumNames: ['EN','FR','IT','DE','ES','JP','PT','RU','KO','ZH','ZS'], title: 'Language' },
  bgmVolume:  { value: 0.5, default: 1, type: 'number', minimum: 0, maximum: 1, title: 'Music volume' },
  sfxVolume:  { value: 1,   default: 1, type: 'number', minimum: 0, maximum: 1, title: 'SFX volume' },
  screenWidth: { value: 424, default: 424, type: 'integer', enum: [320, 424],
                 enumNames: ['4:3 clásico', 'Panorámico'], title: 'Screen width' },
  useHQModes:       { value: true,  default: true,  type: 'boolean', title: 'HQ modes' },
  fastForwardSpeed: { value: 8,     default: 8,     type: 'integer', minimum: 1, title: 'Fast forward' },
  dimLimit:         { value: 300,   default: 300,   type: 'integer', minimum: 0, title: 'Dim after (s)' },
  devMenu:          { value: false, default: false, type: 'boolean', title: 'Dev menu' },

  vsync:           { value: true,   readOnly: true, type: 'boolean', title: 'VSync' },
  engineDebugMode: { value: true,   readOnly: true, type: 'boolean' },
  startMenu:       { value: 'host', readOnly: true, type: 'string', enum: ['native', 'host'] },
}
```

Mismo vocabulario JSON Schema que en la fábrica, así que la misma pantalla de preferencias sirve
antes y después de arrancar. Lo único que cambia es de dónde sale `value`.

## Escribir: valores planos, y sólo lo que cambia

```js
await play.config({ bgmVolume: 0.5 })                  // un deslizador
await play.config({ language: 0, sfxVolume: 0.8 })     // varias a la vez
await play.config({ vsync: false })                    // ✗ lanza: read-only
```

El setter **no** acepta la forma del getter (`{ bgmVolume: { value: 0.5 } }`): sería ambigua el
día que una propiedad sea de tipo objeto.

`readOnly` son las que se fijan al arrancar el motor —`vsync`, `engineDebugMode`, `startMenu`—.
Para cambiarlas hay que rearrancar, y eso es cosa de la fábrica:

```js
await play.destroy()
await sdk.config({ startMenu: 'native' }).start()
```

## No se persiste. Nunca

Lo que escribes aquí vale **para esta sesión del motor y nada más**. El SDK no guarda
preferencias: si el jugador baja la música, quien decide que eso sobreviva a un recargado es la
UI, que además puede tenerlas atadas a la cuenta y sincronizadas entre dispositivos.

El patrón, entonces, es guardar tú y aplicar al arrancar:

```js
// al cambiar algo
await play.config({ bgmVolume: v })
await misPreferencias.set('bgmVolume', v)      // dónde y cómo, es tuyo

// al arrancar la siguiente vez
new Rsdkv4SDK().config(await misPreferencias.all())
```

Lo único que el SDK guarda por su cuenta son las partidas, en la carpeta de `storage()`.

## Las dos lecturas, y por qué las dos aciertan

```js
sdk.config().bgmVolume.value          // 1    — con lo que arrancó
;(await play.config()).bgmVolume.value // 0.5 — lo que suena ahora
```

| | `sdk.config()` | `play.config()` |
| --- | --- | --- |
| coste | síncrono: manifest + cadena | asíncrono: cruza al motor |
| `value` | con lo que arrancó | lo que está en efecto |
| escribir | antes de arrancar; después lanza `frozen` | en caliente, sólo esta sesión |
| `readOnly` | informativo | escribirlo lanza `read-only` |

## Encadenar

`config({…})` es una acción: encadena. `config()` es una consulta: cierra.

```js
await play.pause('ajustes').config({ bgmVolume: 0.5 }).resume('ajustes')

const props = await play.pause('ajustes').config()   // cierra la cadena
```

## Qué **no** vive aquí

Lo que declara el pack cargado: el personaje, la ranura, el escenario y las reglas del juego
(spindash, límites de velocidad, tipo de escudo). Eso es la partida, no el motor, y va en
[`play.options()`](PLAY-game-options.md).

La frontera es útil justamente porque el mismo wasm corre dos juegos: `config` es idéntico en
Sonic 1 y Sonic 2, y `options` no.

---

Siguientes: [PLAY-game-options.md](PLAY-game-options.md) ·
[SDK-sdk-config.md](SDK-sdk-config.md) ·
[PLAY-restarting-game.md](PLAY-restarting-game.md)
