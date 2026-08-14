#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
EMSDK_DIR="${KRKR2_EMSDK_DIR:-${PROJECT_ROOT}/.toolchains/emsdk}"
EMSDK_VERSION="3.1.64"
EMSDK_COMMIT="0b3bcbc3b005cbb811d48e497eabcc6846d43001"
RELEASES_COMMIT="fd61bacaf40131f74987e649a135f1dd559aff60"
NODE_PACKAGE="node-18.20.3-64bit"

if [[ ! -d "${EMSDK_DIR}/.git" ]]; then
  mkdir -p "$(dirname "${EMSDK_DIR}")"
  git clone --branch "${EMSDK_VERSION}" --depth 1 \
    https://github.com/emscripten-core/emsdk.git "${EMSDK_DIR}"
fi

actual_commit="$(git -C "${EMSDK_DIR}" rev-parse HEAD)"
if [[ "${actual_commit}" != "${EMSDK_COMMIT}" ]]; then
  echo "Unexpected emsdk commit: ${actual_commit}" >&2
  echo "Expected: ${EMSDK_COMMIT}" >&2
  exit 1
fi

"${EMSDK_DIR}/emsdk" install \
  "${NODE_PACKAGE}" "releases-${RELEASES_COMMIT}-64bit"
"${EMSDK_DIR}/emsdk" activate \
  "${NODE_PACKAGE}" "releases-${RELEASES_COMMIT}-64bit"

# shellcheck disable=SC1091
source "${EMSDK_DIR}/emsdk_env.sh" >/dev/null
emcc --version | head -n 1
echo "D0 toolchain ready at ${EMSDK_DIR}"
