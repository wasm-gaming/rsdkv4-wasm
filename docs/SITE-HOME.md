---
title: rsdkv4-wasm
---

# @wasm-gaming/rsdkv4-wasm

RSDKv4 compiled to WebAssembly, behind the [wasm-gaming engine
contract](https://wasm-gaming.github.io/engine-specs/api-docs/). One game-agnostic
`rsdkv4.wasm` runs both Sonic 1 and Sonic 2 — the difference is only which `Data.rsdk`
the host hands it at runtime. The engine ships none of the game, and the pack never
leaves the browser.

```ts
import { load } from '@wasm-gaming/rsdkv4-wasm';

const instance = await load({
  attachTo: document.querySelector('#stage'),
  assets: { data },
  storageNamespace: 'sonic2',
});
```

## What is contract, and what is ours

A host drives every engine in the ecosystem the same way, so almost everything here is
documented **in the contract, not in this reference**:

| | where it lives |
| --- | --- |
| `manifest` — what the engine ships and needs | [EngineManifest](https://wasm-gaming.github.io/engine-specs/api-docs/interfaces/EngineManifest.html) |
| `load(config)` — boot it | [EngineConfig](https://wasm-gaming.github.io/engine-specs/api-docs/types/EngineConfig.html) |
| the running engine | [EngineInstance](https://wasm-gaming.github.io/engine-specs/api-docs/interfaces/EngineInstance.html) |
| `{ manifest, load }` — the package's default export | [EngineSDK](https://wasm-gaming.github.io/engine-specs/api-docs/interfaces/EngineSDK.html) |

Two things are RSDKv4's own, and this is the only place they are written down:

- **{@link rsdkv4.sdk!Rsdkv4LoadConfig}** — the fields this engine adds to `config`: the lazy
  `dataProvider` / `settingsProvider`, and the `storageNamespace` that keeps two games
  from overwriting each other. It also spells out how this engine reads the contract's
  own fields, which is the part a host gets wrong first.
- **{@link rsdkv4.options!Rsdkv4Options}** — the values `config.options` takes, mirrored as JSON Schema
  in `manifest.options`. Seven keys, serialized into RSDKv4's `settings.ini`. They are a
  *fallback*: an explicit `assets.settings`, or a file persisted by an earlier session,
  wins over them.

## Beyond the contract

A host that wants to draw the save-select and character screens itself — instead of
letting the engine's in-canvas menu run — gets them as data through
{@link rsdkv4.sdk!RsdkGameBridge}, with the stage list in {@link rsdkv4.sdk!RsdkDevMenuBridge}. Neither is
part of the contract; both are what "one WASM, two games" needs in practice.

## Where to start

{@link rsdkv4.sdk!load} is the whole entry point, and {@link rsdkv4.sdk!Rsdkv4Instance} is what it hands
back.
