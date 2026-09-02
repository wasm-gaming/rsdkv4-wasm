#!/usr/bin/env bash
set -euo pipefail

# Local convenience wrapper: runs scripts/build.sh inside the emscripten/emsdk
# container, so you don't need a local Emscripten toolchain.
#
# In CI, build.sh runs directly inside an emscripten/emsdk *container job*
# (see .github/workflows/build.yml) and this wrapper is not used.
#
# Override the image with EMSDK_IMAGE=... if needed.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${EMSDK_IMAGE:-emscripten/emsdk:latest}"

# The engine source, fetched here on the host rather than inside the container.
#
# Two reasons. The container often has no route to github.com — a sandboxed or
# offline Docker daemon fails the clone with "could not read Username for
# 'https://github.com'", which is git asking for credentials it will never get —
# and the host usually does. And a copy beats a fresh clone on every rebuild.
#
# Best-effort on purpose: if the refresh fails but a checkout is already here, that
# one is used with a warning; if there is nothing to fall back on, RSDKV4_SRC stays
# unset and build.sh clones inside the container the way CI does.
SRC_DIR="$ROOT_DIR/.tmp/rsdkv4-src"
REPO="${RSDKV4_REPO:-https://github.com/mattConn/Sonic-Decompilation-WASM.git}"

mkdir -p "$ROOT_DIR/.tmp"
if [ -d "$SRC_DIR/.git" ]; then
  echo "Refreshing engine source in .tmp/rsdkv4-src ..."
  git -C "$SRC_DIR" fetch --depth=1 origin HEAD >/dev/null 2>&1 \
    && git -C "$SRC_DIR" reset --hard FETCH_HEAD >/dev/null \
    && git -C "$SRC_DIR" clean -fdxq \
    || echo "warning: could not refresh .tmp/rsdkv4-src — building from the copy already there"
else
  echo "Cloning engine source into .tmp/rsdkv4-src ..."
  rm -rf "$SRC_DIR"
  git clone --depth=1 "$REPO" "$SRC_DIR" || rm -rf "$SRC_DIR"
fi

SRC_ARG=()
if [ -d "$SRC_DIR" ]; then
  echo "Engine source: $(git -C "$SRC_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  SRC_ARG=(-e RSDKV4_SRC=/src/.tmp/rsdkv4-src)
else
  echo "No local engine source — the container will clone it itself."
fi

# RSDKV4_WORKER selects the experimental pthread/OffscreenCanvas variant, and it
# is read inside the container — `docker run` starts with a clean environment, so
# it has to be forwarded explicitly or the build silently makes the normal one.
exec docker run --rm \
  -v "$ROOT_DIR:/src" \
  -w /src \
  -e RSDKV4_WORKER="${RSDKV4_WORKER:-0}" \
  -e RSDKV4_OFFSCREEN="${RSDKV4_OFFSCREEN:-0}" \
  -e RSDKV4_NOAUDIO="${RSDKV4_NOAUDIO:-0}" \
  ${SRC_ARG[@]+"${SRC_ARG[@]}"} \
  "$IMAGE" \
  bash scripts/build.sh "$@"
