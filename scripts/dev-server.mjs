#!/usr/bin/env node
// The dev loop: jq79's dev server, given this project's headers and build steps.
//
//   make up
//
// Serving is jq79's, and so is the hot reload — craft is built on that runtime,
// and its dev server already knows how to swap a component into a live page with
// its props and store intact. That matters more here than in most projects: a
// full reload re-boots a 10 MB wasm and throws away whatever game was running.
//
// What this file adds is the two things a generic server cannot know. `headers`
// is the static host we deploy behind (dist/_headers), and without the isolation
// pair there is no SharedArrayBuffer and the engine does not start. `watch` is
// the build: src/ is not what gets served, dist/ is, so a source change has to go
// through make before it means anything to the page.
//
// The round trip is the part worth understanding. src/craft/** sits *outside* the
// served root, so a change there runs its handler and stops — no url out there
// for the runtime to swap into. The handler writes dist/craft/**, which is inside
// the root, so it comes back round as a change with a url, and *that* is what the
// page hot-swaps. Which is why nothing here has to say where a source file ends
// up being served: the build already said it.
import { spawn } from 'node:child_process'
import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { devServer } from 'jq79/dev'

const port = Number(process.env.PORT ?? 8024)

/**
 * Copy exactly the files the watcher named, into where the build would put them.
 *
 * `make build-craft` would do the same job in one line, and it is deliberately
 * not what runs here. A whole-tree copy stamps every destination file, so
 * replacing the one file that changed looks to a watcher like all 22 changing —
 * and a burst holding a .js or a .css can only be answered with a full page
 * reload, which is the reload the hot swap exists to avoid. (rsync is no way
 * out: `-a` re-applies times and permissions to every file, and on macOS that
 * alone fired 58 change events for a one-file edit.)
 *
 * So the dev loop mirrors instead. It can, because jq79 hands a handler the
 * precise list of paths that changed — that is what `fn(files)` is for. This
 * stays honest only while these targets are pure copies; give either of them a
 * real build step and it has to run make here instead.
 */
const mirror = (from, to) => async (files) => {
  const source = resolve(from)
  for (const file of files) {
    const path = relative(source, file)
    if (!path || path.startsWith('..')) continue
    const destination = join(to, path)
    try {
      await stat(file)
    } catch {
      // Deleted or renamed away: the watcher reports those too, and the copy
      // has to go or the page keeps serving a component that no longer exists.
      await rm(destination, { force: true, recursive: true })
      console.log(`[mirror] removed ${destination}`)
      continue
    }
    await mkdir(dirname(destination), { recursive: true })
    await cp(file, destination)
    console.log(`[mirror] ${destination}`)
  }
}

/** A watch handler that runs make targets, inheriting stdio so the build is visible. */
const make =
  (...targets) =>
  () =>
    new Promise((resolve, reject) => {
      console.log(`\n[make] ${targets.join(' ')}`)
      const child = spawn('make', targets, { stdio: 'inherit' })
      child.on('error', reject)
      // A rejection is reported by the server, which stays up — a build that
      // fails is a normal morning, and killing the server over it would mean
      // restarting for every typo.
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`make ${targets.join(' ')} exited ${code}`)),
      )
    })

const server = await devServer({
  rootDir: 'dist',
  port,
  headers: {
    // The engine is built with threads, so the page needs SharedArrayBuffer, so
    // it has to be cross-origin isolated. This is dist/_headers, in the shape the
    // dev server takes.
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-resource-policy': 'cross-origin',
    // Never let the browser reuse a build: a rebuilt rsdkv4.wasm is 10 MB and
    // very tempting to keep, and a stale one runs old engine code against new SDK
    // code — which does not look like a caching problem at all.
    'cache-control': 'no-store, max-age=0',
  },
  watch: [
    // The docs are generated from the SDK's sources, and the SDK is what craft
    // resolves through its import map, so both are rebuilt together.
    {
      pattern: [
        'src/rsdkv4.sdk.ts',
        'src/rsdkv4.options.ts',
        'docs/SITE-HOME.md',
        'docs/typedoc-toolbar.js',
      ],
      fn: make('build-sdk', 'build-typedoc'),
    },
    { pattern: 'src/craft/**', fn: mirror('src/craft', 'dist/craft') },
    { pattern: 'src/worker-smoke/**', fn: mirror('src/worker-smoke', 'dist/worker-smoke') },
    { pattern: 'src/input-doctor/**', fn: mirror('src/input-doctor', 'dist/input-doctor') },
  ],
})

console.log(`Serving dist/ at ${server.url} (Ctrl+C to stop)`)
console.log('  /              API reference')
console.log('  /craft/        craft demo')
console.log('  /worker-smoke/ worker smoke test')
console.log('  /input-doctor/ keyboard diagnostic')
