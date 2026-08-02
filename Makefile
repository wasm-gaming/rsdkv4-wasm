# @wasm-gaming/rsdkv4-wasm — build & preview
#
#   make build     Full build → dist/ (TypeScript SDK + WASM)
#   make preview   Serve dist/ at http://localhost:$(PORT) with COOP/COEP
#
# All build logic lives here (package.json has no scripts). Sub-targets:
# build-sdk (TS only), build-lib/manifest/demo, build-wasm (Docker/emsdk),
# typecheck/test/release-check, install, clean.

# Local npm bin, so we can run tsc without a global install. NOTE: we call it as
# $(BIN)/tsc rather than adding it to PATH — macOS ships GNU Make 3.81, whose
# direct-exec of simple recipe lines ignores a make-variable PATH (even exported),
# so `PATH := ...` + bare `tsc` silently fails there. Path-prefixing works on every
# make version. (node/cp/python3/bash resolve via the system PATH already.)
BIN := node_modules/.bin

PORT ?= 8024

# Shared demo template shipped by the engine contract package; this repo only
# adds index.html + theme.rsdkv4.css on top of it.
SPECS_DEMO := node_modules/@wasm-gaming/engine-specs/demo

.PHONY: build build-sdk build-lib build-manifest build-demo build-wasm \
	preview preview.single typecheck test release-check i install \
	clean clean-all help

i: install
install: ## Install dev dependencies (typescript)
	npm install

# Real target: only (re)installs when package.json is newer than node_modules.
node_modules: package.json
	npm install
	@touch node_modules

build: build-sdk build-wasm ## Full build → dist/ (TypeScript + WASM)

build-sdk: build-lib build-manifest build-demo ## TypeScript → dist/ (no WASM)

build-lib: node_modules ## Compile SDK/options/manifest → dist/rsdkv4/
	$(BIN)/tsc -p tsconfig.json

build-manifest: build-lib ## Serialize typed manifest → dist/manifest.json
	node scripts/emit-manifest.mjs

build-demo: build-lib ## Compile demo → dist/{demo.js,index.html}; copy shared template
	$(BIN)/tsc -p tsconfig.demo.json
	rm -rf dist/demo
	cp -R $(SPECS_DEMO) dist/demo
	cp src/demo/index.html dist/index.html
	cp src/demo/theme.rsdkv4.css dist/theme.rsdkv4.css
	cp src/demo/coi.js dist/coi.js
	cp src/demo/_headers dist/_headers
	node scripts/seed-settings.mjs

build-wasm: ## WASM via emscripten/emsdk (Docker) → dist/rsdkv4/rsdkv4.{js,wasm}
	bash scripts/build-docker.sh

typecheck: build-lib ## Type-check without emitting (works from a clean checkout)
	$(BIN)/tsc -p tsconfig.json --noEmit
	$(BIN)/tsc -p tsconfig.demo.json --noEmit

test: typecheck ## Run the test suite (currently TypeScript checks)

release-check: test ## Preflight release checks (types/tests + npm pack preview)
	npm config get registry
	npm pack --dry-run

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
