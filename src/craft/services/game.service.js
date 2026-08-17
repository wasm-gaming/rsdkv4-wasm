
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
    console.log('Files at OPFS root:', await opfsService.readFilesInOPFS());

    for (const game of Object.values(this.games)) {
      console.log(`Attempting to load Data.rsdk and save file for ${game.id}...`);
      try {
        const file = await opfsService.readFileFromOPFS(`${game.id}/Data.rsdk`);
        game.loaded = true;
        // console.log(`Loaded Data.rsdk for ${game.name}`);
      } catch (error) {
        // console.warn(`Failed to load Data.rsdk for ${game.name}:`, error);
      }
      try {
        const file = await opfsService.readFileFromOPFS(`${game.id}/${game.saveFileName}`);
        game.savegame = await this.parseSaveFile(file);
      } catch (error) {
        console.warn(`Failed to load save file for ${game.name}:`, error);
      }
    }
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
    const ram = new Int32Array(await saveFile.arrayBuffer())
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
        .start()

      this.playingGameId = gameId
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