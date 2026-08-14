#!/usr/bin/env python3
"""Validate the D4 product and its Chrome 89 same-document offline boundaries."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    args = parser.parse_args()
    root = args.directory.resolve()
    required = [
        "index.html", "styles.css", "app.js", "player.js",
        "storage.js", "downloader.js", "catalog.json", "resource-map.json", "engine-profiles.js",
        "assets/default-cover.png", "play/index.html", "play/styles.css", "play/app.js",
        "play/storage.js", "engine/krkrsdl2.js", "engine/krkrsdl2.wasm",
    ]
    missing = [relative for relative in required if not (root / relative).is_file()]
    if missing:
        raise SystemExit("D4 artifacts missing: " + ", ".join(missing))

    catalog = json.loads((root / "catalog.json").read_text(encoding="utf-8-sig"))
    resources = json.loads((root / "resource-map.json").read_text(encoding="utf-8"))["resources"]
    if catalog.get("schemaVersion") != 1 or not catalog.get("games"):
        raise SystemExit("D4 catalog is empty or invalid")
    for game in catalog["games"]:
        if not game.get("coverUrl", "").startswith("/assets/"):
            raise SystemExit(f"D4 game has no local cover: {game.get('gameId')}")
        manifest = root / game["manifestUrl"].removeprefix("/")
        if not manifest.is_file():
            raise SystemExit(f"D4 manifest missing: {manifest}")
    if not resources:
        raise SystemExit("D4 resource map is empty")

    if list(root.rglob("*.xp3")):
        raise SystemExit("D4 web output must not copy large XP3 files")

    app = (root / "app.js").read_text(encoding="utf-8")
    player = (root / "player.js").read_text(encoding="utf-8")
    if "getLatestCatalog" not in app or "d4AppState" not in app:
        raise SystemExit("D4 library lacks local-first catalog diagnostics")
    if "setInterval(syncSaves, 30000)" not in player or "storageBridge.prepare(gameId)" not in player or "wasmBinary: wasmBinary" not in player:
        raise SystemExit("D4 player lacks local launch or periodic save sync")
    if "resolveEngineProfile" not in player or "-krkr2web-autopath=" not in player or "firstDynamicError" not in player:
        raise SystemExit("D4 player lacks engine profile mounting diagnostics")
    if "location.href" not in app or 'actionButton("启动游戏"' not in app:
        raise SystemExit("D4 library does not launch the engine in the current document")
    page = (root / "index.html").read_text(encoding="utf-8")
    if "serviceWorker" in page or "/play/?gameId=" in app or "<a class=\"primary\"" in app:
        raise SystemExit("D4 product still depends on service workers or player navigation")
    print(f"D4 artifacts valid: {len(catalog['games'])} game(s), {len(resources)} mapped package(s)")


if __name__ == "__main__":
    main()
