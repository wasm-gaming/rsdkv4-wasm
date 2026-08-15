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

# RSDKV4_WORKER selects the experimental pthread/OffscreenCanvas variant, and it
# is read inside the container — `docker run` starts with a clean environment, so
# it has to be forwarded explicitly or the build silently makes the normal one.
exec docker run --rm \
  -v "$ROOT_DIR:/src" \
  -w /src \
  -e RSDKV4_WORKER="${RSDKV4_WORKER:-0}" \
  -e RSDKV4_OFFSCREEN="${RSDKV4_OFFSCREEN:-0}" \
  -e RSDKV4_NOAUDIO="${RSDKV4_NOAUDIO:-0}" \
  "$IMAGE" \
  bash scripts/build.sh "$@"
