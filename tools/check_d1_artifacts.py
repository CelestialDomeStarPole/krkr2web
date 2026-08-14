#!/usr/bin/env python3
"""Check the D1 Wasm build against the Chrome 89 and Asyncify baseline."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_d0_artifacts import (  # noqa: E402
    FORBIDDEN_GLUE_TOKENS,
    compiler_version,
    inspect_imports,
    inspect_memories,
    inspect_tables,
    inspect_target_features,
    read_sections,
    sha256,
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wasm", type=Path, required=True)
    parser.add_argument("--glue", type=Path, required=True)
    parser.add_argument("--lock", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--compiler", type=Path, default=Path("emcc"))
    args = parser.parse_args()

    lock = json.loads(args.lock.read_text(encoding="utf-8"))
    wasm = args.wasm.read_bytes()
    glue = args.glue.read_text(encoding="utf-8")
    failures: list[str] = []
    target_features: set[str] = set()

    for section_id, payload in read_sections(wasm):
        if section_id == 0:
            target_features.update(inspect_target_features(payload))
        elif section_id == 2:
            inspect_imports(payload, failures)
        elif section_id == 4:
            inspect_tables(payload, failures)
        elif section_id == 5:
            inspect_memories(payload, failures)
        elif section_id == 13:
            failures.append("Wasm binary contains an exception tag section")

    forbidden_features = set(lock["forbiddenFeatures"])
    for feature in sorted(target_features & forbidden_features):
        failures.append(f"Wasm target_features enables {feature}")
    for token, description in FORBIDDEN_GLUE_TOKENS.items():
        if token in glue:
            failures.append(f"JavaScript glue contains {description}: {token}")

    required_glue_tokens = {
        "Asyncify": "Asyncify runtime",
        "d1_async_read": "asynchronous file-read import",
        "createD1Module": "stable module export name",
        'Module["ccall"]': "asynchronous exported-function wrapper",
    }
    for token, description in required_glue_tokens.items():
        if token not in glue:
            failures.append(f"JavaScript glue is missing {description}: {token}")

    actual_compiler, compiler_description = compiler_version(args.compiler)
    expected_compiler = lock["emsdk"]["version"]
    if actual_compiler != expected_compiler:
        failures.append(
            f"compiler version is {actual_compiler}, expected {expected_compiler}"
        )

    passed = not failures
    report = {
        "schemaVersion": 1,
        "buildVersion": dt.datetime.now(dt.UTC).strftime("d1-%Y%m%d-%H%M%SZ"),
        "builtAt": dt.datetime.now(dt.UTC).isoformat(),
        "emscriptenVersion": actual_compiler,
        "compilerDescription": compiler_description,
        "minimumChromeVersion": lock["target"]["minimumMajorVersion"],
        "fileBridge": {
            "asyncify": True,
            "sharedMemory": False,
            "chunkSizeBytes": 4 * 1024 * 1024,
            "maximumCachedChunks": 4,
            "logicalFileSizeBytes": 5 * 1024 * 1024 * 1024 + 12345,
            "randomReadCount": 10000,
        },
        "source": {
            "path": "probes/d1-file-bridge/src/probe.cpp",
            "sha256": sha256(args.source),
        },
        "artifacts": {
            "wasm": {
                "file": "d1-probe.wasm",
                "bytes": args.wasm.stat().st_size,
                "sha256": sha256(args.wasm),
            },
            "javascript": {
                "file": "d1-module.js",
                "bytes": args.glue.stat().st_size,
                "sha256": sha256(args.glue),
            },
        },
        "compatibility": {
            "passed": passed,
            "summary": (
                "D1 使用 Asyncify，未发现 pthreads、共享内存、JSPI 或其他禁用特性。"
                if passed
                else "D1 静态检查失败：" + "; ".join(failures)
            ),
            "targetFeatures": sorted(target_features),
            "failures": failures,
        },
    }
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    if not passed:
        raise SystemExit("\n".join(failures))
    print(report["compatibility"]["summary"])


if __name__ == "__main__":
    main()
