#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
EMSDK_DIR="${KRKR2_EMSDK_DIR:-${PROJECT_ROOT}/.toolchains/emsdk}"
SOURCE_DIR="${PROJECT_ROOT}/probes/d0-chrome89"
OUTPUT_DIR="${KRKR2_D0_OUTPUT_DIR:-${PROJECT_ROOT}/build/d0-chrome89}"

if [[ ! -f "${EMSDK_DIR}/emsdk_env.sh" ]]; then
  echo "D0 toolchain is missing. Run tools/setup_d0_toolchain.sh first." >&2
  exit 1
fi

# shellcheck disable=SC1091
source "${EMSDK_DIR}/emsdk_env.sh" >/dev/null

mkdir -p "${OUTPUT_DIR}"
find "${OUTPUT_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
cp "${SOURCE_DIR}/web/index.html" "${OUTPUT_DIR}/index.html"
cp "${SOURCE_DIR}/web/styles.css" "${OUTPUT_DIR}/styles.css"
cp "${SOURCE_DIR}/web/app.js" "${OUTPUT_DIR}/app.js"

em++ "${SOURCE_DIR}/src/probe.cpp" \
  -o "${OUTPUT_DIR}/d0-probe.js" \
  -O2 \
  -std=c++17 \
  -fno-exceptions \
  --no-entry \
  -s MIN_CHROME_VERSION=89 \
  -s ENVIRONMENT=web \
  -s MODULARIZE=1 \
  -s EXPORT_NAME=createD0Module \
  -s EXPORT_ES6=0 \
  -s FILESYSTEM=0 \
  -s DYNAMIC_EXECUTION=0 \
  -s ASSERTIONS=1 \
  -s DISABLE_EXCEPTION_CATCHING=1 \
  -s USE_PTHREADS=0 \
  -s ASYNCIFY=0 \
  -s WASM_BIGINT=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=33554432 \
  -s MAXIMUM_MEMORY=536870912 \
  -s STACK_SIZE=1048576 \
  -s MALLOC=emmalloc \
  -s "EXPORTED_FUNCTIONS=['_d0_core_self_test','_d0_echo_u64','_d0_offset_high','_d0_offset_low','_d0_pointer_bits','_d0_heap_bytes']"

python3 "${PROJECT_ROOT}/tools/check_d0_artifacts.py" \
  --wasm "${OUTPUT_DIR}/d0-probe.wasm" \
  --glue "${OUTPUT_DIR}/d0-probe.js" \
  --lock "${PROJECT_ROOT}/toolchains/d0-toolchain.lock.json" \
  --source "${SOURCE_DIR}/src/probe.cpp" \
  --output "${OUTPUT_DIR}/d0-build.json" \
  --compiler "$(command -v emcc)"

# Keep the public JavaScript filename stable while preserving the Wasm URL
# baked into Emscripten's glue.
mv "${OUTPUT_DIR}/d0-probe.js" "${OUTPUT_DIR}/d0-module.js"

echo "D0 build completed: ${OUTPUT_DIR}"
