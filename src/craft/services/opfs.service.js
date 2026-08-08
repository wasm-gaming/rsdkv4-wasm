
// Matches the layout the SDK itself uses (src/vanilla/storage.js, src/demo/library.ts):
//
//   rsdkv4/Sonic1/Data.rsdk      ← the player's pack, written here
//   rsdkv4/Sonic1/settings.ini   ← written by the SDK on first launch
//   rsdkv4/Sonic2/…
//
// Every `path` below is relative to that root, so 'Sonic1/Data.rsdk' is exactly
// the file the engine opens when booted with `storageNamespace: 'rsdkv4/Sonic1'`.
// The folder name is the game id, and OPFS is case-sensitive — 'sonic1' would be
// a second library the engine never looks in.
const LIBRARY_DIR = 'rsdkv4';

// CRC-32 (IEEE 802.3 — the zip/PNG variant, reflected polynomial 0xEDB88320).
// WebCrypto only implements SHA-*, so there is nothing to delegate this to; the
// table is the standard byte-at-a-time one, built once at module load.
const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let bit = 0; bit < 8; bit++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

const segmentsOf = (path) => String(path ?? '').split('/').filter((s) => s && s !== '.');

/**
 * Handle for `rsdkv4/<path>`, walked one segment at a time: getDirectoryHandle()
 * takes a single directory *name*, never a path — a name containing "/" throws.
 * Rejects when a segment is missing and `create` is false.
 */
const directoryAt = async (path, create = false) => {
    let handle = await navigator.storage.getDirectory();
    for (const segment of [LIBRARY_DIR, ...segmentsOf(path)]) {
        handle = await handle.getDirectoryHandle(segment, { create });
    }
    return handle;
};

/** Split 'Sonic1/Data.rsdk' into the directory handle holding it and its name. */
const fileAt = async (path, create = false) => {
    const segments = segmentsOf(path);
    const name = segments.pop();
    if (!name) throw new TypeError(`not a file path: "${path}"`);
    return { dir: await directoryAt(segments.join('/'), create), name };
};

export const opfsService = {
    filesInOPFS: [],
    /** Files directly inside `rsdkv4/<path>`; the library root when omitted. */
    readFilesInOPFS: async (path = '') => {
        let dirHandle;
        try {
            dirHandle = await directoryAt(path);
        } catch {
            // Nothing stored yet. Reading is not what creates the directory, so an
            // empty library is an empty list, not an error.
            opfsService.filesInOPFS = [];
            return [];
        }
        const files = [];
        for await (const [, handle] of dirHandle.entries()) {
            if (handle.kind === 'file') files.push(await handle.getFile());
        }
        opfsService.filesInOPFS = files;
        return [...files];
    },
    /** `path` is the destination including the name: (file, 'Sonic1/Data.rsdk'). */
    writeFileToOPFS: async (file, path = file.name) => {
        const { dir, name } = await fileAt(path, true);
        const fileHandle = await dir.getFileHandle(name, { create: true });
        const writable = await fileHandle.createWritable();
        try {
            // Writing the Blob directly streams through the browser: a 40 MB pack
            // never lands in a JS buffer of ours.
            await writable.write(file);
            await writable.close();
        } catch (error) {
            // A half-written pack is worse than none — drop it rather than leave a
            // truncated Data.rsdk the engine would try to boot.
            await writable.abort().catch(() => {});
            throw error;
        }
    },
    readFileFromOPFS: async (path) => {
        const { dir, name } = await fileAt(path);
        return await (await dir.getFileHandle(name)).getFile();
    },
    deleteFileFromOPFS: async (path) => {
        const { dir, name } = await fileAt(path);
        await dir.removeEntry(name);
    },
    clearOPFS: async (path = '') => {
        const dirHandle = await directoryAt(path);
        for await (const [name, handle] of dirHandle.entries()) {
            if (handle.kind === 'file') {
                await dirHandle.removeEntry(name);
            }
        }
    },
    /** Lowercase 8-digit hex, the form the published RSDK checksums are quoted in. */
    calculateFileCRC32: async (file) => {
        let crc = 0xffffffff;
        // A Data.rsdk runs to tens of MB. Streaming keeps one chunk in memory at a
        // time instead of the whole pack, the same reason writeFileToOPFS() hands
        // the Blob straight to the writable.
        const reader = file.stream().getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            for (let i = 0; i < value.length; i++) {
                crc = CRC32_TABLE[(crc ^ value[i]) & 0xff] ^ (crc >>> 8);
            }
        }
        return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
    },
};
