#!/usr/bin/env python3
"""Generate an immutable D2 catalog, manifest, and local resource map."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from pathlib import Path


CHUNK_SIZE = 4 * 1024 * 1024
GAME_ID_PATTERN = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*$")


def hash_package(path: Path) -> tuple[int, str, list[str]]:
    size = 0
    package_hash = hashlib.sha256()
    chunks: list[str] = []
    with path.open("rb") as stream:
        while True:
            data = stream.read(CHUNK_SIZE)
            if not data:
                break
            size += len(data)
            package_hash.update(data)
            chunks.append(hashlib.sha256(data).hexdigest())
    return size, package_hash.hexdigest(), chunks


def load_reusable_metadata(path: Path, sources: list[Path]) -> dict[str, object] | None:
    if not path.is_file():
        return None
    try:
        metadata = json.loads(path.read_text(encoding="utf-8"))
        fingerprints = metadata["sourceFingerprints"]
        if len(fingerprints) != len(sources):
            return None
        for source, fingerprint in zip(sources, fingerprints, strict=True):
            stat = source.stat()
            if (
                str(source.resolve()) != fingerprint["source"]
                or stat.st_size != fingerprint["size"]
                or stat.st_mtime_ns != fingerprint["mtimeNs"]
            ):
                return None
        return metadata
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None


def source_fingerprint(source: Path) -> dict[str, object]:
    stat = source.stat()
    return {
        "source": str(source.resolve()),
        "size": stat.st_size,
        "mtimeNs": stat.st_mtime_ns,
    }


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-id", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--engine-profile", required=True)
    parser.add_argument("--source-directory", type=Path, required=True)
    parser.add_argument("--package", action="append", required=True)
    parser.add_argument("--web-output", type=Path, required=True)
    parser.add_argument("--resource-map-output", type=Path, required=True)
    parser.add_argument("--metadata-output", type=Path, required=True)
    parser.add_argument("--compatibility", default="development")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    if not GAME_ID_PATTERN.fullmatch(args.game_id):
        raise SystemExit("game-id must contain only lowercase ASCII letters, digits, and hyphens")
    package_names = args.package
    if len(package_names) != len(set(package_names)):
        raise SystemExit("package names must be unique")
    for name in package_names:
        if Path(name).name != name or "\\" in name or name in {"", ".", ".."}:
            raise SystemExit(f"invalid package name: {name}")

    source_directory = args.source_directory.resolve()
    sources = [(source_directory / name).resolve() for name in package_names]
    for source in sources:
        if source.parent != source_directory or not source.is_file():
            raise SystemExit(f"package does not exist in source directory: {source}")

    metadata = None if args.force else load_reusable_metadata(args.metadata_output, sources)
    if metadata is not None:
        package_metadata = metadata["packages"]
        print("Reusing D2 package hashes; source size and modification times are unchanged.")
    else:
        package_metadata = []
        for index, (name, source) in enumerate(zip(package_names, sources, strict=True), start=1):
            print(f"Hashing package {index}/{len(sources)}: {source}")
            size, sha256, chunks = hash_package(source)
            package_metadata.append({
                "id": name,
                "virtualPath": name,
                "size": size,
                "sha256": sha256,
                "chunks": chunks,
            })

    version_seed = json.dumps(package_metadata, sort_keys=True, separators=(",", ":")).encode("utf-8")
    version = "content-" + hashlib.sha256(version_seed).hexdigest()[:20]
    base_url = f"/games/{args.game_id}/{version}"
    packages = []
    resources = []
    for item, source in zip(package_metadata, sources, strict=True):
        package_url = f"{base_url}/{item['id']}"
        packages.append({
            "id": item["id"],
            "virtualPath": item["virtualPath"],
            "url": package_url,
            "size": item["size"],
            "chunkSize": CHUNK_SIZE,
            "sha256": item["sha256"],
            "chunks": item["chunks"],
        })
        resources.append({
            "url": package_url,
            "source": str(source),
            "size": item["size"],
            "sha256": item["sha256"],
        })

    required_bytes = sum(int(package["size"]) for package in packages)
    manifest = {
        "schemaVersion": 1,
        "gameId": args.game_id,
        "version": version,
        "title": args.title,
        "requiredBytes": required_bytes,
        "engineProfile": args.engine_profile,
        "packages": packages,
        "mediaOverrides": [],
    }
    manifest_path = args.web_output / base_url.removeprefix("/") / "manifest.json"
    write_json(manifest_path, manifest)

    catalog_version_seed = f"{args.game_id}:{version}".encode("utf-8")
    catalog = {
        "schemaVersion": 1,
        "catalogVersion": "catalog-" + hashlib.sha256(catalog_version_seed).hexdigest()[:16],
        "games": [{
            "gameId": args.game_id,
            "title": args.title,
            "version": version,
            "manifestUrl": f"{base_url}/manifest.json",
            "requiredBytes": required_bytes,
            "compatibility": args.compatibility,
        }],
    }
    write_json(args.web_output / "catalog.json", catalog)
    write_json(args.resource_map_output, {"schemaVersion": 1, "resources": resources})
    write_json(args.metadata_output, {
        "schemaVersion": 1,
        "gameId": args.game_id,
        "version": version,
        "sourceFingerprints": [source_fingerprint(source) for source in sources],
        "packages": package_metadata,
    })
    print(f"Generated {args.title} {version}: {required_bytes} bytes, {sum(len(p['chunks']) for p in packages)} chunks")


if __name__ == "__main__":
    main()
