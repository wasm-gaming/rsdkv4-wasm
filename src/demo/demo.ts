// Typed side of the demo page.
//
// The shared template (dist/demo/, copied from @wasm-gaming/engine-specs) is
// plain JS and gets wired up in index.html, which is its documented integration
// point. Everything that benefits from type checking lives here and is handed
// to the page on `window.SDK`.

import sdk from '@wasm-gaming/rsdkv4-wasm';

declare global {
  interface Window {
    /** Convention the shared template's sdk.js looks for. */
    SDK?: typeof sdk;
  }
}

window.SDK = sdk;

// The engine needs cross-origin isolation for OPFS persistence. coi.js handles
// the service worker that injects the headers on static hosts; this reports the
// result to anyone listening.
const isolation = document.getElementById('isolation');
if (isolation) {
  isolation.textContent = window.crossOriginIsolated === true ? 'isolated' : 'not isolated';
  isolation.classList.toggle('bad', window.crossOriginIsolated !== true);
}
