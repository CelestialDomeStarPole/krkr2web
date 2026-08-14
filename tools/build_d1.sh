#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
EMSDK_DIR="${KRKR2_EMSDK_DIR:-${PROJECT_ROOT}/.toolchains/emsdk}"
SOURCE_DIR="${PROJECT_ROOT}/probes/d1-file-bridge"
OUTPUT_DIR="${KRKR2_D1_OUTPUT_DIR:-${PROJECT_ROOT}/build/d1-file-bridge}"

if [[ ! -f "${EMSDK_DIR}/emsdk_env.sh" ]]; then
  echo "D1 toolchain is missing. Run tools/setup_d0_toolchain.sh first." >&2
  exit 1
fi

# shellcheck disable=SC1091
source "${EMSDK_DIR}/emsdk_env.sh" >/dev/null

mkdir -p "${OUTPUT_DIR}"
find "${OUTPUT_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
cp "${SOURCE_DIR}/web/index.html" "${OUTPUT_DIR}/index.html"
cp "${SOURCE_DIR}/web/styles.css" "${OUTPUT_DIR}/styles.css"
cp "${SOURCE_DIR}/web/storage.js" "${OUTPUT_DIR}/storage.js"
cp "${SOURCE_DIR}/web/app.js" "${OUTPUT_DIR}/app.js"

em++ "${SOURCE_DIR}/src/probe.cpp" \
  -o "${OUTPUT_DIR}/d1-probe.js" \
  -O2 -std=c++17 -fno-exceptions --no-entry \
  -s MIN_CHROME_VERSION=89 \
  -s ENVIRONMENT=web \
  -s MODULARIZE=1 \
  -s EXPORT_NAME=createD1Module \
  -s EXPORT_ES6=0 \
  -s FILESYSTEM=0 \
  -s DYNAMIC_EXECUTION=0 \
  -s ASSERTIONS=1 \
  -s DISABLE_EXCEPTION_CATCHING=1 \
  -s USE_PTHREADS=0 \
  -s ASYNCIFY=1 \
  -s ASYNCIFY_STACK_SIZE=65536 \
  -s WASM_BIGINT=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=67108864 \
  -s MAXIMUM_MEMORY=536870912 \
  -s STACK_SIZE=1048576 \
  -s MALLOC=emmalloc \
  -s "EXPORTED_RUNTIME_METHODS=['ccall']" \
  -s "EXPORTED_FUNCTIONS=['_d1_run_suite','_d1_run_background_suite','_d1_run_soak_batch','_d1_reset_soak_counters','_d1_pass_mask','_d1_expected_pass_mask','_d1_random_reads','_d1_verified_bytes','_d1_logical_file_size','_d1_last_error','_d1_background_verified_bytes','_d1_soak_reads','_d1_soak_verified_bytes']"

python3 "${PROJECT_ROOT}/tools/check_d1_artifacts.py" \
  --wasm "${OUTPUT_DIR}/d1-probe.wasm" \
  --glue "${OUTPUT_DIR}/d1-probe.js" \
  --lock "${PROJECT_ROOT}/toolchains/d0-toolchain.lock.json" \
  --source "${SOURCE_DIR}/src/probe.cpp" \
  --output "${OUTPUT_DIR}/d1-build.json" \
  --compiler "$(command -v emcc)"

mv "${OUTPUT_DIR}/d1-probe.js" "${OUTPUT_DIR}/d1-module.js"
echo "D1 build completed: ${OUTPUT_DIR}"
