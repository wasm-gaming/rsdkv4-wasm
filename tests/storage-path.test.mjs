// The engine owns its folder: every namespace resolves under rsdkv4/, and none can
// climb out of it. Runs against the built SDK (make build-sdk), the module a host
// actually imports — which also proves it loads with no import map or bundler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Rsdkv4SDK, { storagePath } from '../dist/rsdkv4/rsdkv4.sdk.js';

const cases = [
  [undefined, 'default', 'rsdkv4/default', false],
  ['', 'default', 'rsdkv4/default', false],
  [{ id: 'sonic-1' }, 'default', 'rsdkv4/default', false],
  ['sonic-1', 'sonic-1', 'rsdkv4/sonic-1', false],
  ['sonic-2/profile-a', 'sonic-2/profile-a', 'rsdkv4/sonic-2/profile-a', false],
  [' a b /c? ', 'a_b/c_', 'rsdkv4/a_b/c_', false],
  ['../x', 'x', 'rsdkv4/x', false],
  ['./../../etc', 'etc', 'rsdkv4/etc', false],
  ['..', 'default', 'rsdkv4/default', false],
  ['/abs/path', 'abs/path', 'rsdkv4/abs/path', false],
  // the old convention: the prefix is stripped once, so the files stay where they were
  ['rsdkv4/Sonic1', 'Sonic1', 'rsdkv4/Sonic1', true],
  // a game literally named like the engine is not mistaken for the prefix
  ['rsdkv4', 'rsdkv4', 'rsdkv4/rsdkv4', false],
];

for (const [input, namespace, path, prefixed] of cases) {
  test(`storagePath('rsdkv4', ${JSON.stringify(input)}) → ${path}`, () => {
    assert.deepEqual(storagePath('rsdkv4', input), { namespace, path, prefixed });
  });
}

test('the engine id is the folder', () => {
  assert.equal(Rsdkv4SDK.id, 'rsdkv4');
  assert.ok(storagePath(Rsdkv4SDK.id, 'x').path.startsWith(`${Rsdkv4SDK.id}/`));
});
