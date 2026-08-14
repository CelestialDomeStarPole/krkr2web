#!/usr/bin/env python3
"""Validate engine profiles and emit a same-document browser registry."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


PROFILE_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
PACKAGE_PATH = re.compile(r"^[A-Za-z0-9._/-]+$")
REQUIRED_RUNTIME = {
    "initialWasmMemoryBytes": 64 * 1024 * 1024,
    "maximumWasmMemoryBytes": 512 * 1024 * 1024,
    "indexedDbChunkBytes": 4 * 1024 * 1024,
    "indexedDbCacheChunks": 4,
    "xp3SegmentCacheBytes": 1024 * 1024,
}


def _fail(path: Path, message: str) -> None:
    raise ValueError(f"{path.name}: {message}")


def validate_profile(value: object, path: Path) -> dict:
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        _fail(path, "unsupported schemaVersion")
    profile_id = value.get("id")
    if not isinstance(profile_id, str) or not PROFILE_ID.fullmatch(profile_id):
        _fail(path, "invalid id")
    if path.stem != profile_id:
        _fail(path, "filename must match id")

    required = value.get("requiredPackages")
    entry = value.get("entryPackage")
    auto_paths = value.get("autoPathPackages")
    if not isinstance(required, list) or not required:
        _fail(path, "requiredPackages must be a non-empty array")
    if not isinstance(auto_paths, list):
        _fail(path, "autoPathPackages must be an array")
    for label, items in (("requiredPackages", required), ("autoPathPackages", auto_paths)):
        if any(not isinstance(item, str) or not PACKAGE_PATH.fullmatch(item) for item in items):
            _fail(path, f"{label} contains an invalid path")
        lowered = [item.lower() for item in items]
        if len(lowered) != len(set(lowered)):
            _fail(path, f"{label} contains duplicate paths")
    if not isinstance(entry, str) or entry.lower() not in {item.lower() for item in required}:
        _fail(path, "entryPackage must be required")
    if any(item.lower() == entry.lower() for item in auto_paths):
        _fail(path, "entryPackage cannot also be an auto path")
    if any(item.lower() not in {required_item.lower() for required_item in required} for item in auto_paths):
        _fail(path, "every auto path must be required")

    arguments = value.get("engineArguments")
    if not isinstance(arguments, list) or any(
        not isinstance(argument, str) or not argument.startswith("-") for argument in arguments
    ):
        _fail(path, "engineArguments must contain option strings")
    if value.get("runtime") != REQUIRED_RUNTIME:
        _fail(path, "runtime limits do not match the Chrome 89 low-memory gate")
    if not isinstance(value.get("display"), dict):
        _fail(path, "display must be an object")
    if not isinstance(value.get("plugins"), dict):
        _fail(path, "plugins must be an object")
    if not isinstance(value.get("videoStrategy"), str):
        _fail(path, "videoStrategy must be a string")
    if not isinstance(value.get("allowStartupTimeoutReady"), bool):
        _fail(path, "allowStartupTimeoutReady must be boolean")
    return value


def load_profiles(directory: Path) -> dict[str, dict]:
    profiles: dict[str, dict] = {}
    for path in sorted(directory.glob("*.json")):
        value = validate_profile(json.loads(path.read_text(encoding="utf-8")), path)
        if value["id"] in profiles:
            _fail(path, "duplicate id")
        profiles[value["id"]] = value
    if not profiles:
        raise ValueError("No engine profiles found")
    return profiles


def emit_registry(profiles: dict[str, dict]) -> str:
    registry = {"schemaVersion": 1, "profiles": profiles}
    payload = json.dumps(registry, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    return (
        "(function () {\n"
        '  "use strict";\n'
        f"  window.krkr2EngineProfiles = {payload};\n"
        "}());\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    profiles = load_profiles(args.directory)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(emit_registry(profiles), encoding="ascii")
    print(f"Generated {len(profiles)} engine profiles: {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
