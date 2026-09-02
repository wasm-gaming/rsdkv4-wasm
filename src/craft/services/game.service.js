
import { $reactive } from 'https://jgermade.github.io/jq79/jq79.js';
import { opfsService } from './opfs.service.js';
import Rsdkv4SDK from '@wasm-gaming/rsdkv4-wasm';   // ya mapeado en el importmap de craft/index.html

// El SDK es una clase encadenable, no un `sdk.load(config)`:
//
//   const play = await new Rsdkv4SDK()
//     .mount(el)                              // un <canvas> se usa tal cual; otro elemento y lo crea dentro
//     .assets({ data: () => bytes })          // Data.rsdk: el thunk sólo se llama si no hay copia guardada
//     .storage({ namespace: `rsdkv4/${gameId}` })
//     .config({ startMenu: 'host' })          // las pantallas de save/personaje las pinta craft
//     .start()
//   play.game.start(slot, player)             // slot 0-3, o null = NO SAVE


/**
 * Las zonas de cada juego, en el orden en que las lista su propio Data.rsdk
 * (`Data/Game/GameConfig.bin`, categoría 1 — las escenas regulares).
 *
 * `scene` es el índice de la PRIMERA escena de la zona, porque eso es lo que guarda
 * el slot en +4: el save apunta a un acto, no a una zona. Green Hill 2 es la escena
 * 1, Scrap Brain 3 la 17. Y no vale leer la carpeta del pack para deducir la zona:
 * Scrap Brain 3 vive en `Zone04` (reusa el tileset de Labyrinth) y Final Zone en
 * `Zone06`. Por eso el número de zona se deriva de esta lista y no del pack.
 *
 * Volcado del propio pack con `.tmp/scripts/dump-stagelist.py`; vale mientras el
 * Data.rsdk sea el que verifica el `checksum` de cada juego ahí abajo.
 *
 * `art` es hasta qué zona hay retrato en `assets/stages-<juego>/`: Sonic 2 tiene doce
 * zonas y diez imágenes, así que Death Egg e Hidden Palace se quedan sin foto.
 */
export const STAGES = {
  Sonic1: {
    folder: 'stages-sonic1',
    scenes: 19,
    art: 7,
    zones: [
      { name: 'GREEN HILL ZONE', scene: 0 },
      { name: 'MARBLE ZONE', scene: 3 },
      { name: 'SPRING YARD ZONE', scene: 6 },
      { name: 'LABYRINTH ZONE', scene: 9 },
      { name: 'STARLIGHT ZONE', scene: 12 },
      { name: 'SCRAP BRAIN ZONE', scene: 15 },
      { name: 'FINAL ZONE', scene: 18 },
    ],
  },
  Sonic2: {
    folder: 'stages-sonic2',
    scenes: 21,
    art: 10,
    zones: [
      { name: 'EMERALD HILL ZONE', scene: 0 },
      { name: 'CHEMICAL PLANT ZONE', scene: 2 },
      { name: 'AQUATIC RUIN ZONE', scene: 4 },
      { name: 'CASINO NIGHT ZONE', scene: 6 },
      { name: 'HILL TOP ZONE', scene: 8 },
      { name: 'MYSTIC CAVE ZONE', scene: 10 },
      { name: 'OIL OCEAN ZONE', scene: 12 },
      { name: 'METROPOLIS ZONE', scene: 14 },
      { name: 'SKY CHASE ZONE', scene: 17 },
      { name: 'WING FORTRESS ZONE', scene: 18 },
      { name: 'DEATH EGG ZONE', scene: 19 },
      { name: 'HIDDEN PALACE ZONE', scene: 20 },
    ],
  },
}

/**
 * Cuántas esmeraldas enseñar de las siete.
 *
 * RSDKv4 guarda un contador, no una máscara: el save dice CUÁNTAS se llevan, nunca
 * cuáles, así que se encienden las primeras. Un valor fuera de rango se cuenta por
 * bits antes que pintar cuatro mil millones de gemas — misma lectura que hace
 * `src/demo/start-screens.ts`.
 */
export const emeraldCount = (value) => {
  if (value >= 0 && value <= 7) return value
  let bits = 0
  for (let v = value; v > 0; v >>= 1) bits += v & 1
  return Math.min(bits, 7)
}

/**
 * Qué enseñar de un slot: nombre de zona, número, acto y retrato.
 *
 * Devuelve null para un slot vacío, que es lo que la tarjeta ya distingue.
 */
export const describeSlot = (slot, gameId) => {
  if (!slot || slot.empty) return null

  const pack = STAGES[gameId] ?? STAGES.Sonic1

  // Las special stages son su propia categoría (cat 3), con su numeración.
  if (slot.list === 3) {
    return {
      name: 'SPECIAL STAGE',
      tag: `STAGE ${slot.zone + 1}`,
      zone: null,
      act: slot.zone + 1,
      img: `./assets/${pack.folder}/special.png`,
    }
  }

  // Fuera de la lista regular sólo queda el STAGE MENU del pack: no es una zona y no
  // hay nada honesto que pintar.
  if (slot.zone < 0 || slot.zone >= pack.scenes) {
    return { name: 'UNKNOWN ZONE', tag: '', zone: null, act: null, img: '' }
  }

  const index = pack.zones.findLastIndex(({ scene }) => slot.zone >= scene)
  const zone = pack.zones[index]

  return {
    name: zone.name,
    tag: `ZONE ${index + 1}`,
    zone: index + 1,
    act: slot.zone - zone.scene + 1,
    img: index < pack.art ? `./assets/${pack.folder}/zone-${index + 1}.png` : '',
  }
}

export const gameService = $reactive({
  selectedGame: null,
  isRunning: false,
  isLaunched: false,

  /** El motor vivo, y con qué pack arrancó — ver launchGame. */
  play: null,
  playingGameId: null,

  games: {
    'Sonic1': {
      name: 'Sonic the Hedgehog',
      shortName: 'Sonic 1',
      id: 'Sonic1',
      saveFileName: 'SData.bin',
      loaded: false,
      savegame: null,
      checksum: '5fcb0c89',
    },
    'Sonic2': {
      name: 'Sonic the Hedgehog 2',
      shortName: 'Sonic 2',
      id: 'Sonic2',
      saveFileName: 'SData.bin',
      loaded: false,
      savegame: null,
      checksum: '4b801b09',
    },
  },

  async init() {
    // El árbol entero, no `readFilesInOPFS()`: ésa sólo devuelve los ficheros
    // *sueltos* en la raíz de la librería, y ahí no hay ninguno — todo cuelga de
    // rsdkv4/<juego>/. Listaba [] siempre, que es peor que no listar nada.
    await opfsService.logTree();

    for (const game of Object.values(this.games)) {
      try {
        await opfsService.readFileFromOPFS(`${game.id}/Data.rsdk`);
        game.loaded = true;
      } catch {
        game.loaded = false;
      }
      await this.refreshSaves(game);
    }
  },

  /**
   * Relee las partidas guardadas de un juego.
   *
   * Dos fuentes, y el orden importa. Con el motor vivo manda `play.game.saveSlots()`:
   * lee el saveRAM que el motor tiene en memoria, que es lo que el jugador acaba de
   * cambiar, y lo parsea el propio motor (WebGame.cpp) en vez de esta copia a mano.
   * Sin motor sólo queda el fichero que el SDK espejea en OPFS, que es el arranque en
   * frío.
   *
   * `savegame` queda en null cuando no hay nada que enseñar, y eso es distinto de un
   * array de cuatro slots vacíos: el primero es "aún no sé", el segundo es "sé que no
   * hay partidas".
   */
  async refreshSaves(game) {
    if (this.play && this.playingGameId === game.id) {
      game.savegame = this.play.game.saveSlots();
      return game.savegame;
    }

    let file;
    try {
      file = await opfsService.readFileFromOPFS(`${game.id}/${game.saveFileName}`);
    } catch {
      // Todavía no se ha jugado a este juego en este navegador. No es un error.
      game.savegame = null;
      return null;
    }

    try {
      game.savegame = await this.parseSaveFile(file);
    } catch (error) {
      // Un SData.bin truncado o de otra cosa. Vale la pena gritarlo: se ve igual
      // que "no hay partidas" y no es lo mismo en absoluto.
      console.warn(`[craft] ${game.id}/${game.saveFileName} (${file.size} B) no se pudo parsear:`, error);
      game.savegame = null;
    }
    return game.savegame;
  },

  selectGame(gameId) {
    if (gameId === null) {
      this.selectedGame = null;
    } else if (this.games[gameId]) {
      this.selectedGame = this.games[gameId];
    } else {
      console.warn(`Game with ID ${gameId} not found.`);
    }
  },

  // base = slot * 8
  // +0 character (0 Sonic, 1 Tails, 2 Knuckles, 3 Sonic&Tails)
  // +1 lives   +2 score   +3 bonus
  // +4 zone    (0 = slot vacío; 1-based; >127 = special stage)
  // +5 emeralds  +6 specialPos
  async parseSaveFile(saveFile) {
    const buffer = await saveFile.arrayBuffer()
    // El motor escribe saveRAM entero: 0x2000 ints, 32768 bytes (Userdata.hpp).
    // Comprobado antes de mirarlo porque `new Int32Array(buf)` con un tamaño que no
    // es múltiplo de 4 lanza, y cuatro slots son 32 ints: menos que eso no es un
    // SData.bin, es otra cosa con el mismo nombre.
    if (buffer.byteLength % 4 || buffer.byteLength < 128) {
      throw new RangeError(`${buffer.byteLength} bytes no es un SData.bin`)
    }
    const ram = new Int32Array(buffer)
    return Array.from({ length: 4 }, (_, slot) => {
        const base = slot << 3
        const zone = ram[base + 4]
        const special = zone > 127
        return {
          slot,
          empty: !zone,
          character: ram[base],
          lives: ram[base + 1],
          score: ram[base + 2],
          emeralds: ram[base + 5],
          list: zone ? (special ? 3 : 1) : -1,          // 3 = special, 1 = regular
          zone: zone ? (special ? zone - 129 : zone - 1) : -1,
        }
    })
  },

  async addDataFile(file, gameId = 'auto') {
    const gameChecksum = await opfsService.calculateFileCRC32(file);

    if (gameId === 'auto') {
      if (gameChecksum === this.games.Sonic1.checksum) {
        gameId = 'Sonic1';
      } else if (gameChecksum === this.games.Sonic2.checksum) {
        gameId = 'Sonic2';
      }
    } else {
      if (gameChecksum !== this.games[gameId].checksum) {
        console.warn(`Game with ID ${gameId} does not match Checksum.`);
        return;
      }
    }

    if (!this.games[gameId]) {
      console.warn(`Game with ID ${gameId} not found.`);
      return;
    }

    try {
      await opfsService.writeFileToOPFS(`${gameId}/Data.rsdk`, file);
      this.games[gameId].loaded = true;
      console.log(`Data.rsdk for ${this.games[gameId].name} added successfully.`);
    } catch (error) {
      console.error(`Failed to add Data.rsdk for ${this.games[gameId].name}:`, error);
    }
  },

  async launchGame (el, {
    gameId = this.selectedGame?.id,
    slot = null,
    player = 0,
  } = {}) {
    if (!gameId) throw new Error('launchGame: no game selected')

    console.log('launchGame', {
      gameId,
      slot,
      player,
    })
    
    // Un motor cada vez, y un pack distinto pide uno nuevo: Data.rsdk se lee
    // mientras arranca el wasm, así que cambiar de juego es un boot y no un
    // restart().
    if (this.play && this.playingGameId !== gameId) {
      await this.play.destroy()
      this.play = null
      this.playingGameId = null
    }

    this.isLaunched = true

    if (!this.play) {
      // `mount` acepta el <canvas> del propio App.html y lo usa tal cual — no
      // añade otro ni toca la maquetación; sólo le pone el id que SDL busca.
      this.play = await new Rsdkv4SDK()
        .mount(el)
        .assets({
          data: () => opfsService.readFileFromOPFS(`${gameId}/Data.rsdk`).then(f => f.arrayBuffer()),
        })
        .storage({ namespace: `rsdkv4/${gameId}` })   // mismo layout OPFS que opfs.service.js (LIBRARY_DIR)
        .config({ startMenu: 'host' })                // antes: options.skipStartMenu
        .on('error', ({ detail }) => console.error('[rsdkv4]', detail))
        // El motor guarda a su ritmo (partida nueva, checkpoint, fin de acto) y el
        // SDK espejea SData.bin a OPFS y avisa cuando los bytes cambian. Sin esto
        // las tarjetas se quedaban con lo que hubiera al cargar la página: jugabas,
        // volvías, y seguían diciendo lo mismo que antes de jugar.
        .on('saves', ({ detail }) => { this.games[gameId].savegame = detail })
        .start()

      this.playingGameId = gameId

      // El motor ya tiene el saveRAM cargado: es más fresco y más fiable que el
      // fichero, y deja las tarjetas correctas para cuando se vuelva al launcher.
      await this.refreshSaves(this.games[gameId])
    }

    // La forma por índice, que es la que tiene esta UI. `start({ player })` del
    // contrato quiere el *nombre* del personaje tal y como lo declara el pack, y
    // las etiquetas de craft ('sonictails') no son esos nombres: un nombre
    // desconocido es un error, no un Sonic silencioso.
    this.play.game.start(slot, player)
    this.isRunning = true;
  },
})

gameService
  .$on('selectedGame', selectedGame => {
    if (selectedGame) {
      sessionStorage.setItem('selectedGame', selectedGame.id)
    } else {
      sessionStorage.removeItem('selectedGame')
    }
  })

const previousSelectedGame = sessionStorage.getItem('selectedGame')

if (previousSelectedGame) {
  gameService.selectGame(previousSelectedGame)
}