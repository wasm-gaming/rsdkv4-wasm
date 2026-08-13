// Where the player's game packs live. Host-side code: no SDK involved.
//
// One rsdkv4.wasm plays both games — the Data.rsdk decides which — so the
// launcher is a two-slot library, not a single ROM picker. Each pack is written
// once into OPFS and never uploaded anywhere.
//
// Layout, in the OPFS root:
//
//   rsdkv4/Sonic1/Data.rsdk      ← written here, from the player's file
//   rsdkv4/Sonic1/settings.ini   ← written by the SDK on first launch
//   rsdkv4/Sonic1/SData.bin      ← the game's save file
//   rsdkv4/Sonic2/…
//
// That folder is also the engine's working directory: booting with
// `storageNamespace: 'rsdkv4/Sonic1'` points the engine at the very file this
// module wrote, so launching copies nothing.
//
// Why `readBytes()` still exists, then: the WASM side reaches OPFS through sync
// access handles, which need a worker plus cross-origin isolation. When that
// isn't available the SDK falls back to an in-memory working dir and asks the
// host for the bytes — `dataProvider`. This module serves them from the same
// OPFS copy, so a non-isolated page still boots.

/** The games this engine runs. The id doubles as the OPFS folder name. */
export const GAMES = [
  { id: 'Sonic1', short: 'Sonic 1', title: 'Sonic the Hedgehog', year: '1991' },
  { id: 'Sonic2', short: 'Sonic 2', title: 'Sonic the Hedgehog 2', year: '1992' },
]

const LIBRARY_DIR = 'rsdkv4'
/** Fixed: the engine opens "Data.rsdk" in its working dir. */
const DATA_FILE = 'Data.rsdk'

/** Fallback for browsers without OPFS: keep the File for this session only. */
const inMemory = new Map()

/** Handle for `rsdkv4/<id>/`, or null when it doesn't exist / OPFS is blocked. */
async function gameDir(id, create) {
  if (!navigator.storage?.getDirectory) return null
  try {
    const root = await navigator.storage.getDirectory()
    const library = await root.getDirectoryHandle(LIBRARY_DIR, { create })
    return await library.getDirectoryHandle(id, { create })
  } catch {
    return null
  }
}

async function storedFile(id) {
  const dir = await gameDir(id, false)
  if (!dir) return null
  try {
    return await (await dir.getFileHandle(DATA_FILE)).getFile()
  } catch {
    return null
  }
}

/**
 * Probe OPFS and describe both slots.
 * @returns {Promise<Array<{ id, short, title, year, installed: boolean, size: number }>>}
 */
export async function list() {
  return Promise.all(
    GAMES.map(async (game) => {
      const file = (await storedFile(game.id)) ?? inMemory.get(game.id) ?? null
      return { ...game, installed: Boolean(file), size: file?.size ?? 0 }
    }),
  )
}

/** Store a player-provided Data.rsdk, replacing any previous one. */
export async function install(id, file) {
  const dir = await gameDir(id, true)
  if (!dir) {
    inMemory.set(id, file)
    return
  }

  const handle = await dir.getFileHandle(DATA_FILE, { create: true })
  const writable = await handle.createWritable()
  try {
    // Writing the Blob directly streams through the browser: a 40 MB pack never
    // lands in a JS buffer of ours.
    await writable.write(file)
    await writable.close()
  } catch (error) {
    await writable.abort().catch(() => {})
    throw error
  }
  inMemory.delete(id)
}

/**
 * Drop the stored pack. settings.ini and the save file in the same folder are
 * left alone, so re-adding the game later lands on the old saves.
 */
export async function remove(id) {
  inMemory.delete(id)
  const dir = await gameDir(id, false)
  await dir?.removeEntry(DATA_FILE).catch(() => {})
}

/** The SDK's `dataProvider`: bytes of the stored pack, read only on a cache miss. */
export async function readBytes(id) {
  const file = (await storedFile(id)) ?? inMemory.get(id) ?? null
  if (!file) throw new Error(`no Data.rsdk stored for ${id}`)
  return new Uint8Array(await file.arrayBuffer())
}

/** The SDK's `storageNamespace` for a game: its working dir under /data. */
export function namespace(id) {
  return `${LIBRARY_DIR}/${id}`
}
