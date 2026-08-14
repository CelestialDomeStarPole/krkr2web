#!/usr/bin/env python3
"""Validate generated D2 catalogs, manifests, resource mappings, and web files."""

from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path


CHUNK_SIZE = 4 * 1024 * 1024
HEX_256 = re.compile(r"[0-9a-f]{64}$")
GAME_ID = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*$")
REQUIRED_WEB_FILES = {"index.html", "styles.css", "storage.js", "downloader.js", "app.js", "catalog.json"}
FORBIDDEN_JS_TOKENS = {
    "SharedArrayBuffer": "shared memory",
    "Atomics.": "Atomics",
    "navigator.storage.getDirectory": "OPFS",
    "showOpenFilePicker": "file picker",
    "WebAssembly.Function": "typed Wasm references",
    "Promise.withResolvers": "new Promise API",
}


def require(condition: bool, message: str, failures: list[str]) -> None:
    if not condition:
        failures.append(message)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--web-directory", type=Path, required=True)
    parser.add_argument("--resource-map", type=Path, required=True)
    args = parser.parse_args()

    failures: list[str] = []
    web_directory = args.web_directory.resolve()
    missing = sorted(name for name in REQUIRED_WEB_FILES if not (web_directory / name).is_file())
    require(not missing, f"missing web files: {', '.join(missing)}", failures)
    if missing:
        raise SystemExit("\n".join(failures))

    try:
        catalog = json.loads((web_directory / "catalog.json").read_text(encoding="utf-8"))
        resource_map = json.loads(args.resource_map.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"cannot read D2 JSON: {error}") from error

    require(catalog.get("schemaVersion") == 1, "catalog schemaVersion must be 1", failures)
    require(isinstance(catalog.get("catalogVersion"), str), "catalogVersion must be a string", failures)
    games = catalog.get("games")
    require(isinstance(games, list) and len(games) > 0, "catalog games must be non-empty", failures)
    manifests: list[dict[str, object]] = []
    if isinstance(games, list):
        game_ids: set[str] = set()
        for game in games:
            game_id = game.get("gameId") if isinstance(game, dict) else None
            require(isinstance(game_id, str) and GAME_ID.fullmatch(game_id) is not None, "invalid gameId", failures)
            require(game_id not in game_ids, f"duplicate gameId: {game_id}", failures)
            if isinstance(game_id, str):
                game_ids.add(game_id)
            manifest_url = game.get("manifestUrl", "") if isinstance(game, dict) else ""
            require(isinstance(manifest_url, str) and manifest_url.startswith("/") and manifest_url.endswith(".json"), "invalid manifestUrl", failures)
            manifest_path = web_directory / str(manifest_url).lstrip("/")
            try:
                manifests.append(json.loads(manifest_path.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError) as error:
                failures.append(f"cannot read manifest {manifest_path}: {error}")

    mapped = {item.get("url"): item for item in resource_map.get("resources", []) if isinstance(item, dict)}
    total_chunks = 0
    total_bytes = 0
    for manifest in manifests:
        require(manifest.get("schemaVersion") == 1, "manifest schemaVersion must be 1", failures)
        packages = manifest.get("packages")
        require(isinstance(packages, list) and len(packages) > 0, "manifest packages must be non-empty", failures)
        package_total = 0
        if not isinstance(packages, list):
            continue
        package_ids: set[str] = set()
        virtual_paths: set[str] = set()
        for package in packages:
            package_id = package.get("id")
            virtual_path = package.get("virtualPath")
            size = package.get("size")
            chunks = package.get("chunks")
            url = package.get("url")
            require(isinstance(package_id, str) and package_id not in package_ids, f"invalid or duplicate package id: {package_id}", failures)
            require(isinstance(virtual_path, str) and virtual_path not in virtual_paths and ".." not in virtual_path and "\\" not in virtual_path, f"invalid virtualPath: {virtual_path}", failures)
            if isinstance(package_id, str): package_ids.add(package_id)
            if isinstance(virtual_path, str): virtual_paths.add(virtual_path)
            require(isinstance(size, int) and 0 < size <= 2**53 - 1, f"invalid package size: {size}", failures)
            require(package.get("chunkSize") == CHUNK_SIZE, "chunkSize must be 4 MiB", failures)
            require(isinstance(package.get("sha256"), str) and HEX_256.fullmatch(package["sha256"]) is not None, "invalid package hash", failures)
            expected_chunks = math.ceil(size / CHUNK_SIZE) if isinstance(size, int) and size > 0 else -1
            require(isinstance(chunks, list) and len(chunks) == expected_chunks, f"wrong chunk count for {package_id}", failures)
            if isinstance(chunks, list):
                require(all(isinstance(value, str) and HEX_256.fullmatch(value) is not None for value in chunks), f"invalid chunk hash for {package_id}", failures)
                total_chunks += len(chunks)
            mapping = mapped.get(url)
            require(mapping is not None, f"resource URL is not mapped: {url}", failures)
            if mapping is not None:
                source = Path(str(mapping.get("source", "")))
                require(source.is_file(), f"mapped source does not exist: {source}", failures)
                require(mapping.get("size") == size, f"mapped size mismatch for {url}", failures)
                require(mapping.get("sha256") == package.get("sha256"), f"mapped hash mismatch for {url}", failures)
                if source.is_file() and isinstance(size, int):
                    require(source.stat().st_size == size, f"source size changed for {url}", failures)
            if isinstance(size, int): package_total += size
        require(isinstance(manifest.get("requiredBytes"), int) and manifest["requiredBytes"] >= package_total, "requiredBytes is smaller than package total", failures)
        total_bytes += package_total

    for script_name in ("storage.js", "downloader.js", "app.js"):
        script = (web_directory / script_name).read_text(encoding="utf-8")
        for token, description in FORBIDDEN_JS_TOKENS.items():
            require(token not in script, f"{script_name} contains forbidden {description}: {token}", failures)

    require("Range:" in (web_directory / "downloader.js").read_text(encoding="utf-8"), "downloader does not request HTTP Range", failures)
    require(total_chunks > 0, "no chunks were generated", failures)
    if failures:
        raise SystemExit("\n".join(failures))
    print(f"D2 artifacts valid: {len(manifests)} game(s), {total_chunks} chunks, {total_bytes} bytes")


if __name__ == "__main__":
    main()
