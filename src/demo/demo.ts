// Typed side of the demo page.
//
// The shared template (dist/demo/, copied from @wasm-gaming/engine-specs) is
// plain JS and gets wired up in index.html, which is its documented integration
// point. Everything that benefits from type checking lives here and is handed
// to the page on `window.SDK` / `window.rsdkv4Library`.

import sdk from '@wasm-gaming/rsdkv4-wasm';
import library, { type GameLibrary } from './library.js';

declare global {
  interface Window {
    /** Convention the shared template's sdk.js looks for. */
    SDK?: typeof sdk;
    /**
     * The two-game library the launcher renders from. A global rather than an
     * import because the launcher component's setup script is compiled with
     * `new Function` (no module scope), and `window.SDK` already sets the
     * precedent for how this page hands typed things to plain-JS template code.
     */
    rsdkv4Library?: GameLibrary;
  }
}

window.SDK = sdk;
window.rsdkv4Library = library;

// The engine needs cross-origin isolation for OPFS persistence. coi.js handles
// the service worker that injects the headers on static hosts; this reports the
// result to anyone listening.
const isolation = document.getElementById('isolation');
if (isolation) {
  isolation.textContent = window.crossOriginIsolated === true ? 'isolated' : 'not isolated';
  isolation.classList.toggle('bad', window.crossOriginIsolated !== true);
}
