#!/usr/bin/env python3
"""Validate the D3 engine build and its Chrome 89 feature baseline."""

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
    parser.add_argument("--engine-lock", type=Path, required=True)
    parser.add_argument("--patch", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--compiler", type=Path, required=True)
    args = parser.parse_args()

    target_lock = json.loads(args.lock.read_text(encoding="utf-8"))
    engine_lock = json.loads(args.engine_lock.read_text(encoding="utf-8"))
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

    for feature in sorted(target_features & set(target_lock["forbiddenFeatures"])):
        failures.append(f"Wasm target_features enables {feature}")
    for token, description in FORBIDDEN_GLUE_TOKENS.items():
        if token in glue:
            failures.append(f"JavaScript glue contains {description}: {token}")
    required_tokens = {
        "Asyncify": "Asyncify runtime",
        "krkr2web_read_cached_package": "IndexedDB XP3 read import",
        "instantiate_krkrsdl2_module": "stable module export",
    }
    for token, description in required_tokens.items():
        if token not in glue:
            failures.append(f"JavaScript glue is missing {description}: {token}")

    version, description = compiler_version(args.compiler)
    if version != engine_lock["emscriptenVersion"]:
        failures.append(f"compiler version is {version}, expected {engine_lock['emscriptenVersion']}")

    decompression_patch = next(
        (patch for patch in args.patch if patch.name == "0006-web-decompression-stream.patch"), None
    )
    if decompression_patch is None:
        failures.append("engine patch set is missing the XP3 decompression wrapper")
    else:
        decompression_text = decompression_patch.read_text(encoding="utf-8")
        for token in (
            "TVPXP3Uncompress",
            "EM_ASYNC_JS",
            "DecompressionStream",
            "new Worker",
            "worker.terminate()",
            "krkr2webAsyncTrace",
            "timeout after 15000 ms",
        ):
            if token not in decompression_text:
                failures.append(f"XP3 decompression wrapper is missing {token}")

    passed = not failures
    report = {
        "schemaVersion": 1,
        "buildVersion": dt.datetime.now(dt.UTC).strftime("d3-%Y%m%d-%H%M%SZ"),
        "builtAt": dt.datetime.now(dt.UTC).isoformat(),
        "upstream": {"repository": engine_lock["repository"], "commit": engine_lock["commit"]},
        "emscriptenVersion": version,
        "compilerDescription": description,
        "minimumChromeVersion": target_lock["target"]["minimumMajorVersion"],
        "fileBridge": {
            "asyncify": True,
            "chunkSizeBytes": 4 * 1024 * 1024,
            "maximumCachedChunks": 4,
        },
        "sourceImports": engine_lock.get("sourceImports", []),
        "patches": [{"file": patch.name, "sha256": sha256(patch)} for patch in args.patch],
        "artifacts": {
            "wasm": {"file": args.wasm.name, "bytes": args.wasm.stat().st_size, "sha256": sha256(args.wasm)},
            "javascript": {"file": args.glue.name, "bytes": args.glue.stat().st_size, "sha256": sha256(args.glue)},
        },
        "compatibility": {"passed": passed, "targetFeatures": sorted(target_features), "failures": failures},
    }
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if failures:
        raise SystemExit("\n".join(failures))
    print("D3 artifacts valid: Asyncify enabled; no threads, shared memory, SIMD, JSPI or Wasm EH detected.")


if __name__ == "__main__":
    main()
