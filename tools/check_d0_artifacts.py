#!/usr/bin/env python3
"""Reject Wasm features that are outside the KRKR2 Web Chrome 89 baseline."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import subprocess
from pathlib import Path


FORBIDDEN_GLUE_TOKENS = {
    "SharedArrayBuffer": "shared memory",
    "Atomics.": "atomics",
    "WebAssembly.Suspending": "JSPI",
    "WebAssembly.promising": "JSPI",
    "PThread": "pthreads",
    ".worker.js": "worker bootstrap",
}


class WasmFormatError(ValueError):
    pass


def read_uleb(data: bytes, offset: int) -> tuple[int, int]:
    value = 0
    shift = 0
    for _ in range(10):
        if offset >= len(data):
            raise WasmFormatError("unexpected end of unsigned LEB128")
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if byte & 0x80 == 0:
            return value, offset
        shift += 7
    raise WasmFormatError("unsigned LEB128 is too long")


def read_name(data: bytes, offset: int) -> tuple[str, int]:
    size, offset = read_uleb(data, offset)
    end = offset + size
    if end > len(data):
        raise WasmFormatError("name exceeds section boundary")
    return data[offset:end].decode("utf-8"), end


def read_limits(data: bytes, offset: int) -> tuple[int, int]:
    flags, offset = read_uleb(data, offset)
    _, offset = read_uleb(data, offset)
    if flags & 0x01:
        _, offset = read_uleb(data, offset)
    return flags, offset


def read_sections(data: bytes) -> list[tuple[int, bytes]]:
    if data[:4] != b"\x00asm" or data[4:8] != b"\x01\x00\x00\x00":
        raise WasmFormatError("not a WebAssembly 1.0 binary")
    sections = []
    offset = 8
    while offset < len(data):
        section_id = data[offset]
        size, payload_start = read_uleb(data, offset + 1)
        payload_end = payload_start + size
        if payload_end > len(data):
            raise WasmFormatError("section exceeds file boundary")
        sections.append((section_id, data[payload_start:payload_end]))
        offset = payload_end
    return sections


def inspect_limits(flags: int, label: str, failures: list[str]) -> None:
    if flags & 0x02:
        failures.append(f"{label} uses shared memory")
    if flags & 0x04:
        failures.append(f"{label} uses memory64")


def inspect_imports(payload: bytes, failures: list[str]) -> None:
    count, offset = read_uleb(payload, 0)
    for index in range(count):
        _, offset = read_name(payload, offset)
        _, offset = read_name(payload, offset)
        if offset >= len(payload):
            raise WasmFormatError("truncated import entry")
        kind = payload[offset]
        offset += 1
        if kind == 0:
            _, offset = read_uleb(payload, offset)
        elif kind == 1:
            reference_type = payload[offset]
            offset += 1
            if reference_type != 0x70:
                failures.append(f"imported table {index} uses non-funcref reference type")
            _, offset = read_limits(payload, offset)
        elif kind == 2:
            flags, offset = read_limits(payload, offset)
            inspect_limits(flags, f"imported memory {index}", failures)
        elif kind == 3:
            offset += 2
        elif kind == 4:
            failures.append(f"import {index} uses a Wasm exception tag")
            _, offset = read_uleb(payload, offset + 1)
        else:
            raise WasmFormatError(f"unknown import kind {kind}")


def inspect_memories(payload: bytes, failures: list[str]) -> None:
    count, offset = read_uleb(payload, 0)
    for index in range(count):
        flags, offset = read_limits(payload, offset)
        inspect_limits(flags, f"memory {index}", failures)


def inspect_tables(payload: bytes, failures: list[str]) -> None:
    count, offset = read_uleb(payload, 0)
    for index in range(count):
        reference_type = payload[offset]
        offset += 1
        if reference_type != 0x70:
            failures.append(f"table {index} uses non-funcref reference type")
        _, offset = read_limits(payload, offset)


def inspect_target_features(payload: bytes) -> set[str]:
    name, offset = read_name(payload, 0)
    if name != "target_features":
        return set()
    count, offset = read_uleb(payload, offset)
    features = set()
    for _ in range(count):
        if offset >= len(payload):
            raise WasmFormatError("truncated target_features entry")
        prefix = chr(payload[offset])
        feature, offset = read_name(payload, offset + 1)
        if prefix == "+":
            features.add(feature)
    return features


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def compiler_version(compiler: Path) -> tuple[str, str]:
    command = [str(compiler), "--version"]
    if compiler.suffix.lower() in {".bat", ".cmd"}:
        command = ["cmd.exe", "/d", "/c", str(compiler), "--version"]
    completed = subprocess.run(
        command,
        check=True,
        capture_output=True,
        text=True,
    )
    first_line = completed.stdout.splitlines()[0].strip()
    match = re.search(r"\b(\d+\.\d+\.\d+)\b", first_line)
    if match is None:
        raise RuntimeError(f"cannot parse Emscripten version from: {first_line}")
    return match.group(1), first_line


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

    actual_compiler, compiler_description = compiler_version(args.compiler)
    expected_compiler = lock["emsdk"]["version"]
    if actual_compiler != expected_compiler:
        failures.append(
            f"compiler version is {actual_compiler}, expected {expected_compiler}"
        )

    passed = not failures
    report = {
        "schemaVersion": 1,
        "buildVersion": dt.datetime.now(dt.UTC).strftime("d0-%Y%m%d-%H%M%SZ"),
        "builtAt": dt.datetime.now(dt.UTC).isoformat(),
        "emscriptenVersion": actual_compiler,
        "compilerDescription": compiler_description,
        "minimumChromeVersion": lock["target"]["minimumMajorVersion"],
        "source": {
            "path": "probes/d0-chrome89/src/probe.cpp",
            "sha256": sha256(args.source),
        },
        "artifacts": {
            "wasm": {
                "file": "d0-probe.wasm",
                "bytes": args.wasm.stat().st_size,
                "sha256": sha256(args.wasm),
            },
            "javascript": {
                "file": "d0-module.js",
                "bytes": args.glue.stat().st_size,
                "sha256": sha256(args.glue),
            },
        },
        "compatibility": {
            "passed": passed,
            "summary": (
                "未发现 pthreads、共享内存、JSPI、Wasm 原生异常或其他禁用特性。"
                if passed
                else "静态检查失败：" + "; ".join(failures)
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
