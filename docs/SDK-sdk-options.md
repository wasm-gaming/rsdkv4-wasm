# `sdk.options()` — el payload de la próxima partida

> **No es la API publicada.** Describe el contrato 1.0
> ([`EngineSDK`/`EnginePlay`](https://github.com/wasm-gaming/engine-specs)), todavía sin
> implementar aquí. Para la API de hoy (`0.1.5`) ver [SDK-examples.md](SDK-examples.md).

`sdk.options({…})` deja puesto el payload con el que se abrirá la partida. Es **exactamente lo
mismo** que pasárselo a `start()`, y sirve para lo que sirve toda la cadena: configurar en un
sitio y arrancar en otro.

```js
sdk.options({ slot: 0, player: 1 })
await sdk.start()                      // ≡ sdk.start({ slot: 0, player: 1 })
```

En rsdkv4 el payload son tres claves:

| clave | qué es |
| --- | --- |
| `slot` | ranura de guardado `0-3`, o `null` para jugar sin guardar |
| `player` | índice de personaje: `0` SONIC, `1` TAILS, `2` KNUCKLES, `3` SONIC & TAILS |
| `stage` | escenario de la lista del pack — el warp |

Son índices, nunca nombres: `players[player]` es cosa del host, y `'TAILS'` no es un `player`
válido. Los nombres reales los declara el pack cargado y se leen en
[`play.options()`](PLAY-game-options.md), porque cambian entre Sonic 1 y Sonic 2.

## Una sola regla: el payload es acumulativo

Hay **un payload vigente**. Empieza siendo el de la fábrica, y cada `start()`/`restart()` mezcla
el suyo encima (mezcla plana, un nivel).

```js
sdk.options({ slot: 0, player: 1 })
await sdk.start({ player: 2 })        // { slot: 0, player: 2 }
await play.restart({ slot: 3 })       // { slot: 3, player: 2 } — player sigue donde lo dejaste
await play.restart()                  // { slot: 3, player: 2 } — power cycle: repite el vigente
await play.restart({ slot: null })    // { slot: null, player: 2 }
```

`restart({ slot: 3 })` es literalmente `restart({ ...payloadVigente, slot: 3 })`. Y `null` es un
valor explícito —partida sin guardar—, no "déjalo como estaba": para eso se omite la clave.

## No se congela

A diferencia de `assets()`, `config()` y `storage()`, `options()` **no lanza `frozen`** con un
motor vivo:

```js
const play = await sdk.start()

sdk.config({ language: 0 })      // ✗ frozen
sdk.options({ player: 2 })       // ✓ no lanza — pero tampoco cambia nada todavía
await sdk.start()                // ahora sí: ≡ play.restart({ player: 2 })
```

La razón es que no describe al motor, describe la próxima sesión, y abrir otra sesión es legal en
cualquier momento. Si se congelase, `sdk.options({…}).start()` fallaría la segunda vez mientras
`sdk.start({…})` funciona, y las dos formas dejarían de ser la misma.

Ojo con la consecuencia: **`sdk.options({…})` no cambia nada en caliente.** Lo que toca la partida
en marcha es [`play.options({…})`](PLAY-game-options.md); esto sólo apunta lo que valdrá en el
próximo arranque.

## El getter es fino, y con motivo

```js
sdk.options()   // { slot: { value: 0 }, player: { value: 2 } }
```

Devuelve la misma forma que los demás getters, pero con `value` y poco más: las claves de la
partida las declara **el pack cargado**, no el manifest, así que sin motor no hay `enum`,
`enumNames` ni `title` que dar. Los personajes de Sonic 1 no son los de Sonic 2, y hasta que no
hay un `Data.rsdk` abierto nadie sabe cuáles son.

Con el motor vivo, la lectura buena es `play.options()`, que sí trae el esquema completo.

## Sobrevive a JSON

`options` viaja en `EngineSetupData`, la mitad JSON-safe del setup — junto con `config` y
`storage`, y a diferencia de `assets` y `mount`. Eso es lo que hace que "restaurar la última
sesión" signifique *la partida de antes*:

```js
// al salir
await db.put('sessions', { config: sdk.config(), options: { slot: 2, player: 1 },
                           storage: { namespace: 'rsdkv4/sonic-1' } }, 'last')

// al volver
const setup = await db.get('sessions', 'last')
await new Rsdkv4SDK(setup).assets({ data: pack }).mount(el).start()   // reabre la ranura 2
```

El pack no viaja: `assets` hay que volver a dárselo. Con IndexedDB (`structuredClone`) un
`FileSystemFileHandle` sí se restaura, y ahí el setup entero cabe en un solo registro — pero un
handle de `showOpenFilePicker()` pedirá `requestPermission()` tras recargar, y eso exige un gesto
del jugador. Un handle de OPFS no.

## Cuándo usarlo, y cuándo no

Usa `sdk.options({…})` cuando quien decide la partida no es quien la arranca: un lanzador que
prepara la fábrica en una pantalla y la arranca en otra, o un setup restaurado de IndexedDB.

Si ya tienes el payload en la mano en el momento de arrancar, `sdk.start({ slot, player })` dice
lo mismo en una línea.

---

Siguientes: [PLAY-restarting-game.md](PLAY-restarting-game.md) ·
[PLAY-game-options.md](PLAY-game-options.md) · [SDK-sdk-config.md](SDK-sdk-config.md)
