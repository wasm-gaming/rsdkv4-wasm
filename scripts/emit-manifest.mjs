// Serialize the typed manifest (dist/rsdkv4/rsdkv4.manifest.js) to dist/manifest.json —
// the declarative artifact CI attaches to a Release and hosts consume. Run after
// build:lib.
import { writeFileSync } from 'node:fs';
import { manifest } from '../dist/rsdkv4/rsdkv4.manifest.js';

const out = new URL('../dist/manifest.json', import.meta.url);
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log('wrote dist/manifest.json');
