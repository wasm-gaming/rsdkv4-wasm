// Game library for the demo launcher: the two Data.rsdk packs RSDKv4 can run.
//
// One rsdkv4.wasm plays both games — the pack decides which. So the launcher is
// a two-slot library rather than a single ROM picker: the player drops Sonic 1's
// Data.rsdk in one slot, Sonic 2's in the other, and afterwards just picks which
// one to boot.
//
// Storage layout (OPFS root):
//
//   rsdkv4/Sonic1/Data.rsdk      ← written here, from the player's file
//   rsdkv4/Sonic1/settings.ini   ← written by the SDK on first launch
//   rsdkv4/Sonic1/…              ← the game's own save data
//   rsdkv4/Sonic2/…
//
// That directory is *also* the engine's working dir: rsdkv4.wasm mounts the OPFS
// root at /data (WebFS.cpp → wasmfs_create_opfs_backend), so loading with
// `storageNamespace: 'rsdkv4/Sonic1'` points the engine at exactly the file this
// module wrote. One copy of a ~40 MB pack, written once — a launch re-uploads
// nothing, and each game keeps its saves next to its own data.
//
// The engine reaches OPFS through WASMFS sync access handles, which need a
// worker + cross-origin isolation. When the page isn't isolated the SDK falls
// back to an in-memory working dir and asks for the bytes via `dataProvider()`;
// `readBytes()` below serves them from this same OPFS copy, so a non-isolated
// page still boots (it just loses persistence of the game's saves).

/** The games RSDKv4 runs; the id doubles as the OPFS folder name. */
export type GameId = 'Sonic1' | 'Sonic2';

export interface GameDefinition {
  id: GameId;
  /** Short label for the slot header. */
  short: string;
  /** Full title, used in status lines and the ESC menu. */
  title: string;
  /** Release year, shown as a hint under the title. */
  year: string;
  /**
   * The game's wordmark, relative to the demo page. Shown on the launcher (as
   * the screen's title and as the card's cover art) and again on the save-select
   * screen once the game is running. Copied to dist/assets by `make build-demo`.
   */
  logo: string;
}

export interface GameSlot extends GameDefinition {
  /** True when a Data.rsdk for this game is available to launch. */
  installed: boolean;
  /** Size of the stored Data.rsdk in bytes (0 when not installed). */
  size: number;
  /** mtime of the stored Data.rsdk (0 when not installed). */
  lastModified: number;
}

export const GAMES: readonly GameDefinition[] = [
  {
    id: 'Sonic1',
    short: 'Sonic 1',
    title: 'Sonic the Hedgehog',
    year: '1991',
    logo: './assets/Sonic_The_Hedgehog.svg',
  },
  {
    id: 'Sonic2',
    short: 'Sonic 2',
    title: 'Sonic the Hedgehog 2',
    year: '1992',
    logo: './assets/Sonic_The_Hedgehog_2.svg',
  },
];

/** Folder under the OPFS root that holds every game folder. */
const LIBRARY_DIR = 'rsdkv4';
/** File name inside a game folder. Fixed: the engine opens "Data.rsdk" in its CWD. */
const DATA_FILE = 'Data.rsdk';

/**
 * Session fallback for browsers without OPFS (or where it throws): the picked
 * File is kept in memory so the player can still launch, just not persist.
 */
const inMemory = new Map<GameId, File>();

let snapshot: GameSlot[] = GAMES.map((game) => ({
  ...game,
  installed: false,
  size: 0,
  lastModified: 0,
}));

let selectedId: GameId | null = null;

function emptySlot(game: GameDefinition): GameSlot {
  return { ...game, installed: false, size: 0, lastModified: 0 };
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  try {
    return await navigator.storage.getDirectory();
  } catch (err) {
    console.warn('[library] OPFS not accessible:', err);
    return null;
  }
}

/** Handle for `rsdkv4/<id>/`. Returns null when it doesn't exist and create is false. */
async function gameDir(id: GameId, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  const root = await opfsRoot();
  if (!root) return null;
  try {
    const library = await root.getDirectoryHandle(LIBRARY_DIR, { create });
    return await library.getDirectoryHandle(id, { create });
  } catch {
    // Missing (create: false) or a quota/permission failure — same answer either way.
    return null;
  }
}

/** The stored Data.rsdk as a File, or null when this game isn't installed. */
async function storedFile(id: GameId): Promise<File | null> {
  const dir = await gameDir(id, false);
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(DATA_FILE);
    return await handle.getFile();
  } catch {
    return null;
  }
}

/** Re-probe OPFS and return a fresh snapshot of both slots. */
export async function refresh(): Promise<GameSlot[]> {
  snapshot = await Promise.all(
    GAMES.map(async (game) => {
      const file = (await storedFile(game.id)) ?? inMemory.get(game.id) ?? null;
      if (!file) return emptySlot(game);
      return {
        ...game,
        installed: true,
        size: file.size,
        lastModified: file.lastModified || 0,
      };
    }),
  );

  // Keep the selection meaningful across installs/removals.
  if (!snapshot.some((slot) => slot.id === selectedId && slot.installed)) {
    selectedId = snapshot.find((slot) => slot.installed)?.id ?? null;
  }

  return snapshot;
}

/** Last probed state, without touching OPFS — what the launcher renders from. */
export function slots(): GameSlot[] {
  return snapshot;
}

export function slot(id: GameId): GameSlot | null {
  return snapshot.find((entry) => entry.id === id) ?? null;
}

/** Store a player-provided Data.rsdk for `id`, replacing any previous one. */
export async function install(id: GameId, file: File): Promise<GameSlot[]> {
  const dir = await gameDir(id, true);
  if (dir) {
    const handle = await dir.getFileHandle(DATA_FILE, { create: true });
    const writable = await handle.createWritable();
    try {
      // A Blob write streams through the browser — a 40 MB pack never lands in
      // a JS buffer of our own.
      await writable.write(file);
      await writable.close();
    } catch (err) {
      await writable.abort().catch(() => {});
      throw err;
    }
    inMemory.delete(id);
  } else {
    inMemory.set(id, file);
  }

  await refresh();
  selectedId = id;
  return snapshot;
}

/**
 * Drop the stored Data.rsdk for `id`. Save data and settings.ini in the same
 * folder are left alone, so re-adding the pack later lands on the old saves.
 */
export async function remove(id: GameId): Promise<GameSlot[]> {
  inMemory.delete(id);
  const dir = await gameDir(id, false);
  if (dir) {
    try {
      await dir.removeEntry(DATA_FILE);
    } catch {
      // Already gone.
    }
  }
  return refresh();
}

/** Bytes of the stored pack — the SDK's `dataProvider`, used only on a cache miss. */
export async function readBytes(id: GameId): Promise<Uint8Array> {
  const file = (await storedFile(id)) ?? inMemory.get(id) ?? null;
  if (!file) throw new Error(`rsdkv4 demo: no Data.rsdk stored for ${id}`);
  return new Uint8Array(await file.arrayBuffer());
}

/** Where the SDK should keep this game's working dir, under the OPFS-mounted /data. */
export function storageNamespace(id: GameId): string {
  return `${LIBRARY_DIR}/${id}`;
}

export function select(id: GameId | null): void {
  selectedId = id;
}

export function selected(): GameId | null {
  return selectedId;
}

/** The slot the player is about to launch, or null when nothing is playable. */
export function selectedGame(): GameSlot | null {
  const current = snapshot.find((entry) => entry.id === selectedId) ?? null;
  return current?.installed ? current : null;
}

export const library = {
  GAMES,
  refresh,
  slots,
  slot,
  install,
  remove,
  readBytes,
  storageNamespace,
  select,
  selected,
  selectedGame,
};

export type GameLibrary = typeof library;

export default library;
