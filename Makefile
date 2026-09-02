# @wasm-gaming/rsdkv4-wasm — build & preview
#
#   make build     The package: SDK + both WASM builds → dist/
#   make demo      The site: API reference, demo shell, hosts, smoke page
#   make test      Type-check the SDK
#   make preview   Serve dist/ at http://localhost:$(PORT) with COOP/COEP
#   make up        The dev loop: build, serve, rebuild on save, reload the browser
#
# The site's home page is the API reference — typedoc writes straight to dist/ —
# and the hosts hang off it at /craft/ and /worker-smoke/. `up` builds and
# watches exactly those three; src/demo is out of the loop until it catches up
# with the SDK, and `make demo` is where that shows.
#
# **`build` is what ships, `demo` is what gets looked at**, and keeping them apart
# is the point of the split rather than tidiness. They used to be one target, so a
# host that had not caught up with the SDK blocked the package release — which is
# exactly what happened when the SDK moved to engine-specs 0.3.2 and src/demo
# stayed on the old API. `test` follows the same line: it checks the SDK, and the
# hosts are type-checked by `make demo`, where a stale one is a broken page rather
# than an unpublishable package.
#
# All build logic lives here (package.json has no scripts). Sub-targets:
# build-sdk/lib/specs, build-wasm/-worker (Docker/emsdk), build-typedoc/demo/
# vanilla/craft/smoke, typecheck/release-check, install, clean.

# Local npm bin, so we can run tsc without a global install. NOTE: we call it as
# $(BIN)/tsc rather than adding it to PATH — macOS ships GNU Make 3.81, whose
# direct-exec of simple recipe lines ignores a make-variable PATH (even exported),
# so `PATH := ...` + bare `tsc` silently fails there. Path-prefixing works on every
# make version. (node/cp/python3/bash resolve via the system PATH already.)
BIN := node_modules/.bin

PORT ?= 8024

# Shared demo template shipped by the engine contract package; this repo only
# adds index.html + theme.rsdkv4.css on top of it.
SPECS := node_modules/@wasm-gaming/engine-specs
SPECS_DEMO := $(SPECS)/demo

.PHONY: build build-sdk build-lib build-specs build-wasm build-wasm-worker \
	demo build-typedoc build-demo build-vanilla build-craft build-smoke build-input-doctor \
	up preview preview.single typecheck test release-check i install clean clean-all help

i: install
install: ## Install dev dependencies (typescript)
	npm install

# Real target: only (re)installs when package.json is newer than node_modules.
node_modules: package.json
	npm install
	@touch node_modules

build: build-sdk build-wasm build-wasm-worker ## The package: SDK + both WASM builds → dist/

build-sdk: build-lib build-specs ## The published package: TypeScript → dist/rsdkv4/ (no WASM)

build-lib: node_modules ## Compile SDK + options → dist/rsdkv4/
	$(BIN)/tsc -p tsconfig.json

build-specs: build-lib ## Copy the contract's runtime → dist/engine-specs.js
	# As of engine-specs 0.3.2 the contract is not types-only: the SDK extends
	# EngineSDKBase/EnginePlayBase and imports EventEmitter, so the built
	# rsdkv4.sdk.js carries a bare `@wasm-gaming/engine-specs` specifier. A
	# bundler resolves it; a page served straight out of dist/ needs an import
	# map, and this is the file it points at.
	cp $(SPECS)/dist/engine-specs.js dist/engine-specs.js

demo: build-typedoc build-demo build-smoke build-input-doctor ## The site: API reference + demo shell + hosts + smoke page + input doctor

build-demo: build-lib ## Compile demo → dist/demo.js; copy shared template (no root page — that is the API reference)
	# This emit is also the demo's type check — `typecheck` covers the SDK only,
	# so a host that has drifted from the contract fails here and nowhere else.
	$(BIN)/tsc -p tsconfig.demo.json
	rm -rf dist/demo
	cp -R $(SPECS_DEMO) dist/demo
	# The shared launcher is a single-ROM picker; RSDKv4 needs a two-game
	# library (Sonic 1 / Sonic 2 packs). demo.js fetches the component by path,
	# so replacing the file swaps the launcher and leaves the rest of the
	# template (sdk-info, esc-menu, launch flow) untouched.
	cp src/demo/components/launcher.html dist/demo/components/launcher.html
	# Same override trick for the pause overlay: our copy fixes the template's
	# leaked capture-phase keydown listener, which swallowed arrows/Enter (and
	# with them the engine's d-pad and Start) after one open/close cycle.
	cp src/demo/components/esc-menu.html dist/demo/components/esc-menu.html
	# No `cp src/demo/index.html dist/index.html` any more: dist/index.html is the
	# API reference (see build-typedoc), and whichever of the two ran last used to
	# win the root. The shared demo shell has no entry page of its own as a result.
	# No `cp -R src/demo/assets dist/assets` either, and this one would have been
	# silent: typedoc writes its stylesheet and scripts to dist/assets/ now, and
	# build-demo ran after it — so the copy took the reference's CSS with it and
	# left a site that merely looked unstyled. The one file it carried is reached
	# from src/demo/index.html, which is no longer deployed; whatever revives the
	# demo shell should give it a subdirectory of its own.
	cp src/demo/theme.rsdkv4.css dist/theme.rsdkv4.css
	cp src/demo/coi.js dist/coi.js
	cp src/demo/_headers dist/_headers
	node scripts/seed-settings.mjs
	$(MAKE) build-vanilla
	$(MAKE) build-craft

build-vanilla: ## Copy the no-build demo → dist/vanilla/ (served at /vanilla/)
	# Plain JS + HTML, nothing to compile: it imports the built SDK through an
	# import map, so a copy is the whole "build". Edit src/vanilla and reload.
	rm -rf dist/vanilla
	cp -R src/vanilla dist/vanilla

build-craft: ## Copy the no-build demo → dist/craft/ (served at /craft/)
	# Plain JS + HTML, nothing to compile: it imports the built SDK through an
	# import map, so a copy is the whole "build". Edit src/craft and reload.
	#
	# A whole-tree copy, which is what a build should be. The dev loop does *not*
	# come through here — it mirrors single files instead (scripts/dev-server.mjs),
	# because any full copy makes 22 files look changed when one of them is, and a
	# burst containing a .js is a full page reload. See the note there.
	rm -rf dist/craft
	cp -R src/craft dist/craft

build-input-doctor: ## Copy the keyboard diagnostic → dist/input-doctor/ (served at /input-doctor/)
	# Plain HTML with an inline script and no imports, on purpose: it measures what
	# the *browser* delivers, so it has to be able to run with the SDK, the wasm and
	# the game data all missing or broken. The ESC menu in craft links to it, and the
	# in-game half of the same diagnostic is the input probe next to that link.
	rm -rf dist/input-doctor
	cp -R src/input-doctor dist/input-doctor

build-typedoc: node_modules ## API reference → dist/ root, i.e. the site's home page (config in typedoc.json)
	# The reference *is* the site now: `out` is dist/ itself, so dist/index.html is
	# the API home and the hosts hang off it at /craft/ and /worker-smoke/. CI
	# uploads dist/ as the build artifact and the release deploys it to Pages, so
	# this publishes itself with no workflow changes.
	#
	# typedoc.json turns cleanOutputDir off. It has to: the default would delete
	# dist/ — wasm included — before writing the docs. The flip side is that
	# nothing clears the previous location, so the pre-move copy is dropped by
	# hand rather than shipped twice.
	rm -rf dist/api-docs
	$(BIN)/typedoc

build-wasm: ## WASM via emscripten/emsdk (Docker) → dist/rsdkv4/rsdkv4.{js,wasm}
	bash scripts/build-docker.sh

build-wasm-worker: ## Experimental pthread/OffscreenCanvas WASM → dist/rsdkv4-worker/
	# Opt-in variant: main() on a pthread, picture on a transferred OffscreenCanvas.
	# Lands beside the shipped build rather than replacing it, so worker-smoke can
	# run the two against each other. See SESSIONS/ for what it is meant to answer.
	RSDKV4_WORKER=1 bash scripts/build-docker.sh

build-smoke: ## Copy the worker smoke test → dist/worker-smoke/ (served at /worker-smoke/)
	rm -rf dist/worker-smoke
	cp -R src/worker-smoke dist/worker-smoke

typecheck: node_modules ## Type-check the SDK without emitting (clean checkout, no build)
	# The SDK only, and it needs nothing built to run — the demo project resolved
	# the SDK through dist/*.d.ts, which is what used to force a build first.
	# `make demo` type-checks the hosts.
	$(BIN)/tsc -p tsconfig.json --noEmit

test: typecheck ## Run the test suite (currently TypeScript checks)

release-check: build-sdk test ## Preflight release checks (types/tests + npm pack preview)
	npm config get registry
	npm pack --dry-run

# What `make up` builds and serves: the API reference at /, and the two hosts
# that are current. src/demo is not in the loop — it has not caught up with the
# SDK migration, and `make demo` is where that has to be fixed.
# build-sdk first: craft resolves both `@wasm-gaming/rsdkv4-wasm` and
# `@wasm-gaming/engine-specs` through its import map, and build-specs is what
# puts the second one in dist/.
UP_TARGETS := build-sdk build-typedoc build-craft build-smoke build-input-doctor

up: node_modules ## Dev loop: /=API reference, /craft/, /worker-smoke/ — rebuilt and reloaded on save
	# One build up front so the first page load is not a 404, then jq79's dev
	# server. The serving and the hot reload are jq79's own — craft is built on
	# that runtime, so its dev server is the thing that can swap a component into
	# the live page instead of reloading it. What this project has to supply is
	# the headers and the build steps, and those are in scripts/dev-server.mjs.
	#
	# WASM is deliberately not watched: it is a Docker/emsdk build measured in
	# minutes, so a C change still means an explicit `make build-wasm`.
	$(MAKE) $(UP_TARGETS)
	@if [ ! -f dist/rsdkv4/rsdkv4.wasm ]; then \
		echo "warning: dist/rsdkv4/rsdkv4.wasm is missing — run 'make build-wasm' or the engine will not boot"; \
	fi
	PORT=$(PORT) node scripts/dev-server.mjs

preview: ## Serve dist/ with COOP/COEP headers (required for OPFS persistence)
	@echo "Serving dist/ at http://localhost:$(PORT) (Ctrl+C to stop)"
	python3 scripts/preview-server.py --port $(PORT) --directory dist

preview.single: ## Serve dist/ without COOP/COEP, to see the isolation check fail
	@echo "Serving dist/ at http://localhost:$(PORT) (Ctrl+C to stop)"
	python3 -m http.server $(PORT) --directory dist

clean: ## Remove build outputs (keeps dist/Data.rsdk and dist/settings.ini)
	@if [ -d dist ]; then find dist -mindepth 1 ! -name Data.rsdk ! -name settings.ini -delete; fi

clean-all: clean ## Also drop the cached build workspace
	rm -rf .tmp

help: ## List targets
	@grep -E '^[a-zA-Z_.-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
