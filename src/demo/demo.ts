// Standalone demo harness for the RSDKv4 SDK.
//
// Compiles to dist/demo.js and is loaded by dist/index.html. It consumes the SDK
// by package name (resolved via the page's import map to ./rsdkv4/rsdkv4.sdk.js),
// exactly as a real host would.
//
// Data.rsdk resolution mirrors a real launcher:
//   1. If it's already persisted in OPFS (cross-origin isolated pages), the SDK
//      reuses it and the `dataProvider` fetch below is never called.
//   2. Otherwise the SDK calls `dataProvider`, which fetches a sibling ./Data.rsdk.
//   3. If that fetch fails (e.g. GitHub Pages ships no ROM), we fall back to a
//      pick / drag-and-drop prompt.

import { load, type Rsdkv4Instance } from '@wasm-gaming/engine-rsdkv4';
import type { EngineEvent } from '@wasm-gaming/wasm-specs';

const picker = document.getElementById('picker') as HTMLDivElement;
const status = document.getElementById('status') as HTMLParagraphElement;
const fileInput = document.getElementById('file') as HTMLInputElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;

/** Fetch an optional sibling file; returns its bytes, or null if absent. */
async function fetchOptional(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Fetch the sibling Data.rsdk; throws if it isn't served. */
async function fetchData(): Promise<Uint8Array> {
  const res = await fetch('./Data.rsdk');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

let booting = false;

async function boot(source: { data?: Uint8Array }): Promise<void> {
  if (booting) return; // ignore extra drops/picks once we've started
  booting = true;
  picker.classList.add('hidden');
  try {
    const settings = await fetchOptional('./settings.ini');
    const engine: Rsdkv4Instance = await load({
      canvas,
      assets: {
        ...(source.data ? { data: source.data } : {}),
        ...(settings ? { settings } : {}),
      },
      // Lazy: only invoked if there's no explicit data AND nothing persisted in OPFS.
      dataProvider: source.data ? undefined : fetchData,
      // persist: 'opfs',   // force OPFS; omit for auto (OPFS iff cross-origin isolated),
      // persist: null,     // force the in-memory (MEMFS-equivalent) backend.
      onEvent: (ev: EngineEvent) => {
        console.log('[demo] engine event', ev);
        if (ev.type === 'error') alert('Engine error: ' + ev.error.message);
      },
    });
    (window as any).__engine = engine; // console poking: __engine.pause()
    console.log('[demo] working dir persistent (OPFS):', engine.persistent);
    wireEscape(engine);
  } catch (e) {
    booting = false;
    picker.classList.remove('hidden');
    throw e;
  }
}

/** Demo-only: Escape pauses + logs the stage list (the launcher owns real UI). */
function wireEscape(engine: Rsdkv4Instance): void {
  let paused = false;
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    paused = !paused;
    paused ? engine.pause() : engine.resume();
    if (paused) console.log('[demo] stage list:', engine.devMenu.getStageList());
  }, true);
}

async function bootFromFile(file: File): Promise<void> {
  try {
    await boot({ data: new Uint8Array(await file.arrayBuffer()) });
  } catch (e) {
    console.error('[demo] boot failed', e);
  }
}

function offerPicker(reason: string): void {
  status.textContent = reason;
  fileInput.hidden = false;

  // Click-to-pick.
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void bootFromFile(file);
  });

  // Drag-and-drop anywhere on the page.
  const stop = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
  for (const t of ['dragenter', 'dragover'] as const) {
    window.addEventListener(t, (e) => { stop(e); picker.classList.add('dragover'); });
  }
  for (const t of ['dragleave', 'dragend'] as const) {
    window.addEventListener(t, (e) => { stop(e); picker.classList.remove('dragover'); });
  }
  window.addEventListener('drop', (e) => {
    stop(e);
    picker.classList.remove('dragover');
    const file = (e as DragEvent).dataTransfer?.files?.[0];
    if (file) void bootFromFile(file);
  });
}

// Initial attempt: reuse a persisted OPFS copy or fetch ./Data.rsdk; on a miss,
// offer the pick / drag-and-drop prompt.
(async () => {
  try {
    await boot({});
  } catch (e) {
    console.warn('[demo] no persisted/served Data.rsdk — showing picker', e);
    offerPicker('No Data.rsdk found — pick one, or drag & drop it anywhere:');
  }
})();
