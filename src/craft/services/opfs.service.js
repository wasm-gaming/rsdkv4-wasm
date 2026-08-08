
// Matches the directory the SDK itself uses (src/vanilla/storage.js, src/demo/library.ts).
const LIBRARY_DIR = 'rsdkv4';

export const opfsService = {
    filesInOPFS: [],
    readFilesInOPFS: async (path = LIBRARY_DIR) => {
        const dirHandle = await navigator.storage.getDirectory();
        let targetDirHandle;
        try {
            targetDirHandle = await dirHandle.getDirectoryHandle(path, { create: false });
        } catch {
            // Nothing stored yet. Reading is not what creates the directory, so an
            // empty library is an empty list, not an error.
            opfsService.filesInOPFS = [];
            return opfsService.filesInOPFS;
        }
        const files = [];
        for await (const [, handle] of targetDirHandle.entries()) {
            if (handle.kind === 'file') files.push(await handle.getFile());
        }
        opfsService.filesInOPFS = files;
        return files;
    },
    writeFileToOPFS: async (file, path = LIBRARY_DIR) => {
        const dirHandle = await navigator.storage.getDirectory();
        const targetDirHandle = await dirHandle.getDirectoryHandle(path, { create: true });
        const fileHandle = await targetDirHandle.getFileHandle(file.name, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(file);
        await writable.close();
    },
    readFileFromOPFS: async (fileName, path = LIBRARY_DIR) => {
        const dirHandle = await navigator.storage.getDirectory();
        const targetDirHandle = await dirHandle.getDirectoryHandle(path, { create: false });
        const fileHandle = await targetDirHandle.getFileHandle(fileName);
        return await fileHandle.getFile();
    },
    deleteFileFromOPFS: async (fileName, path = LIBRARY_DIR) => {
        const dirHandle = await navigator.storage.getDirectory();
        const targetDirHandle = await dirHandle.getDirectoryHandle(path, { create: false });
        await targetDirHandle.removeEntry(fileName);
    },
};
