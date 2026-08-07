# Vanilla demo

The same thing `src/demo/` does — pick a Data.rsdk, boot the engine, save select,
pause menu — with no template, no framework, no build step and no styling worth
the name. It exists so the UI can be rewritten from scratch against a reference
that shows every SDK call in context.

```
make build-sdk && make preview     →  http://localhost:8024/vanilla/
```

Plain JS modules, served as-is: edit a file, reload the page. Only the SDK itself
(`dist/rsdkv4/`) is compiled, and it is imported by package name through an
import map, exactly as a real host would.

## The files

| File | |
|---|---|
| `engine.js` | **The reference.** The only file that imports the SDK; the whole engine surface as plain functions over plain data. Read it once; you should not need to change it. |
| `storage.js` | The player's game packs in OPFS. Host-side, no SDK. |
| `app.js` | **The part you rewrite.** Every screen is a string written into `#ui`; every interaction is one of three delegated listeners. No helpers, no classes, no CSS. |
| `index.html` | Two divs: `#ui` and `#stage`. |

There is no stylesheet: the demo renders as unstyled HTML on purpose, with the
canvas at its natural 424×240 until you give `#stage` a size.

## What the engine needs from a UI

Four things; the last three are marked "SDK rule" in `app.js`:

1. **A box for the canvas.** The SDK creates the `<canvas>` inside `attachTo`
   (here `#stage`) and keeps it scaled to that element. Style the box, not the
   canvas — and remember a hidden or zero-height box gives a zero-height picture.
2. **`destroy()` before leaving.** Otherwise the audio keeps mixing and the save
   mirror keeps running behind your launcher.
3. **Pause under an owner, resume under the same one.** `pause('menu')` can only
   be lifted by `resume('menu')`. That is what stops a pause menu from resuming a
   game the save select is still holding.
4. **Give focus back to the canvas** when an overlay closes — SDL reads the
   keyboard from it (`engine.focusEngine()`).

## Two decisions worth knowing you're making

**`skipStartMenu: true`.** It switches off RSDKv4's own save-select, character
and options screens so this demo can draw them in HTML from `instance.game` —
which mirrors the native menu exactly: same globals, same `SData.bin`, same
`InitStartingStage`. If you'd rather keep the engine's screens, drop the option
and delete `openSaveSelect()`; you then never touch `instance.game` at all.

**Persistence.** The engine reaches OPFS through sync access handles, which need
a worker *and* cross-origin isolation (`../coi.js`, or your server's COOP/COEP
headers) *and* an Asyncify/JSPI build — today's isn't. So the working dir is
in-memory in practice, `dataProvider` feeds the pack in from the host's own OPFS
copy, and the SDK mirrors `SData.bin` in and out so saves survive a reload
anyway. `instance.persistent` tells you which mode you got.
