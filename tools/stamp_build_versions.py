#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""krkr2web: content-hash cache busting for D5 product static assets.

The Android WebView (Chrome 89) occasionally serves no-cache subresources
from a stale HTTP cache after server redeployments, which broke script
loading (an old engine-profiles.js without a top-level schemaVersion made
every launch fail with "缺少引擎配置：<id>"). Stamping every local asset
reference in index.html (plus the wasm URL inside player.js) with a short
content hash makes revalidated HTML reference the exact matching assets:
a fresh page can only pull fresh scripts, and unchanged assets keep their
stable cache identity.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path

HTML_ASSETS = [
    "styles.css",
    "storage.js",
    "downloader.js",
    "play/storage.js",
    "play/prefetch.js",
    "engine-profiles.js",
    "engine-worker-host.js",
    "engine/krkrsdl2.js",
    "player.js",
    "save-manager.js",
    "app.js",
]

PLAYER_RUNTIME_ASSETS = [
    "engine-worker.js",
    "engine/krkrsdl2.js",
    "engine/krkrsdl2.wasm",
    "play/storage.js",
]

# The engine js/wasm pair must always be replaced together: a stale cached
# HTML/JS paired with a fresh wasm fails instantiation with zero engine
# output whenever the glue interface changes (patch 0078's EM_ASM did).
# The manifest lets the player verify what it actually downloaded, and the
# page meta lets it detect a stale page against the manifest and self-heal.
ENGINE_MANIFEST_NAME = "engine-manifest.json"
ENGINE_FILES = [
    "engine/krkrsdl2.js",
    "engine/krkrsdl2.wasm",
]


def content_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:8]


def stamp_html(page: str, versions: dict) -> str:
    # strip previous stamps, then re-add, so re-running is idempotent
    page = re.sub(r"\?v=[0-9a-f]{8}", "", page)
    def repl(match):
        attr, quote, target = match.group(1), match.group(2), match.group(3)
        version = versions.get(target)
        if version is None:
            return match.group(0)
        return f"{attr}={quote}{target}?v={version}{quote}"
    return re.sub(r'(href|src)=(["\'])(/[a-zA-Z0-9_./-]+)\2', repl, page)


def stamp_player(player: str, root: Path) -> str:
    for runtime_asset in PLAYER_RUNTIME_ASSETS:
        asset = root / runtime_asset
        if not asset.is_file():
            continue
        player = re.sub(
            r"/" + re.escape(runtime_asset) + r"\?v=[0-9a-f]{8}",
            "/" + runtime_asset,
            player,
        )
        version = content_hash(asset)
        player = re.sub(
            r'(["\'])/' + re.escape(runtime_asset) + r'\1',
            lambda match, name=runtime_asset, value=version: f'{match.group(1)}/{name}?v={value}{match.group(1)}',
            player,
        )
    return player


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    args = parser.parse_args()
    root = args.directory.resolve()

    # stamp player.js first: rewriting its wasm URL changes the file, and
    # index.html must reference the version of the FINAL player.js bytes
    player_path = root / "player.js"
    if player_path.is_file():
        player_path.write_text(
            stamp_player(player_path.read_text(encoding="utf-8"), root),
            encoding="utf-8",
        )

    versions = {}
    for rel in HTML_ASSETS + PLAYER_RUNTIME_ASSETS:
        asset = root / rel
        if asset.is_file():
            versions["/" + rel] = content_hash(asset)

    page_path = root / "index.html"
    page = page_path.read_text(encoding="utf-8")
    stamped_page = stamp_html(page, versions)

    # Engine integrity manifest: full sha256 + byte size per engine file,
    # plus a combined build id mirrored into the page meta so the player can
    # (1) verify the wasm it fetched and re-pull with a buster on mismatch,
    # (2) detect a stale cached page and force one self-healing reload.
    manifest_files = {}
    combined = hashlib.sha256()
    for rel in ENGINE_FILES:
        asset = root / rel
        if not asset.is_file():
            continue
        blob = asset.read_bytes()
        combined.update(blob)
        manifest_files["/" + rel] = {
            "bytes": len(blob),
            "sha256": hashlib.sha256(blob).hexdigest(),
        }
    build = combined.hexdigest()[:8]
    (root / ENGINE_MANIFEST_NAME).write_text(
        json.dumps(
            {"schemaVersion": 1, "build": build, "files": manifest_files},
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    stamped_page = re.sub(r'\s*<meta name="krkr2-engine-build" content="[0-9a-f]+">', "", stamped_page)
    stamped_page = stamped_page.replace(
        '<meta name="theme-color"',
        f'<meta name="krkr2-engine-build" content="{build}">\n  <meta name="theme-color"',
        1,
    )
    page_path.write_text(stamped_page, encoding="utf-8")

    refs = re.findall(r'(?:href|src)=["\'](/[a-zA-Z0-9_./-]+\?v=[0-9a-f]{8})', stamped_page)
    for ref in refs:
        print("stamped: " + ref)
    if not refs:
        raise SystemExit("no stamped references found in index.html")
    print(f"engine manifest: /{ENGINE_MANIFEST_NAME} build={build}")


if __name__ == "__main__":
    main()
