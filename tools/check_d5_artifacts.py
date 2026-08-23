#!/usr/bin/env python3
"""Validate the first Senren Banka compatibility product artifact."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


GAME_ID = "senren-banka"
CONTENT_VERSION = "content-ebe5177821a6917c7a80"
PROFILE_ID = "senren-banka-v1"
EXPECTED_PACKAGES = {
    "data.xp3": 2_312_777_571,
    "adult.xp3": 306_995_899,
    "video.xp3": 1_424_495_513,
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--profile", type=Path, required=True)
    args = parser.parse_args()
    root = args.directory.resolve()
    for relative in ("compat/index.html", "compat/app.js", "compat/styles.css"):
        if not (root / relative).is_file():
            raise SystemExit(f"D5 compatibility probe is missing {relative}")

    catalog = json.loads((root / "catalog.json").read_text(encoding="utf-8-sig"))
    games = catalog.get("games", [])
    if len(games) != 1:
        raise SystemExit("D5 catalog must contain exactly one development game")
    game = games[0]
    if game.get("gameId") != GAME_ID or game.get("version") != CONTENT_VERSION:
        raise SystemExit("D5 catalog changed the existing IndexedDB cache identity")

    manifest_path = root / str(game["manifestUrl"]).removeprefix("/")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    if manifest.get("engineProfile") != PROFILE_ID:
        raise SystemExit("D5 manifest does not select senren-banka-v1")
    package_sizes = {item["virtualPath"]: item["size"] for item in manifest.get("packages", [])}
    if package_sizes != EXPECTED_PACKAGES:
        raise SystemExit("D5 package paths or sizes changed")
    if manifest.get("requiredBytes") != sum(EXPECTED_PACKAGES.values()):
        raise SystemExit("D5 requiredBytes changed")

    profile = json.loads(args.profile.read_text(encoding="utf-8-sig"))
    if profile.get("id") != PROFILE_ID:
        raise SystemExit("D5 profile id is invalid")
    if profile.get("entryPackage") != "data.xp3":
        raise SystemExit("D5 profile has an invalid entry package")
    if profile.get("autoPathPackages") != ["adult.xp3", "video.xp3"]:
        raise SystemExit("D5 profile does not mount both secondary archives")
    if profile.get("plugins", {}).get("motionplayer.dll") != "native-lazy-psb":
        raise SystemExit("D5 profile must enable the native lazy-PSB Motion runtime")
    if any(argument.startswith("-krkr2web-motion-bootstrap") for argument in profile.get("engineArguments", [])):
        raise SystemExit("D5 profile must not retain the legacy Motion isolation switch")
    if "-debugwin=no" not in profile.get("engineArguments", []):
        raise SystemExit("D5 profile must disable the unavailable Win32 debug console")
    if profile.get("videoStrategy") != "mp4-bridge":
        raise SystemExit("D5 profile lost the mandatory D6 video strategy")

    resource_map = json.loads((root / "resource-map.json").read_text(encoding="utf-8-sig"))
    mapped = {item["url"]: item for item in resource_map.get("resources", [])}
    for package, size in EXPECTED_PACKAGES.items():
        url = f"/games/{GAME_ID}/{CONTENT_VERSION}/{package}"
        if url not in mapped or mapped[url].get("size") != size:
            raise SystemExit(f"D5 resource map is missing {package}")

    player = (root / "player.js").read_text(encoding="utf-8")
    for relative in ("engine-worker-host.js", "engine-worker.js", "engine/krkrsdl2.js", "engine/krkrsdl2.wasm"):
        if not (root / relative).is_file():
            raise SystemExit(f"D5 Dedicated Worker runtime is missing {relative}")
    for token in ("resolveEngineProfile", "-krkr2web-autopath=", "firstDynamicError",
                  "directKagApplied", "runtimeVariant", "Krkr2EngineWorkerHost",
                  "forceTerminate", "workerCapability"):
        if token not in player:
            raise SystemExit(f"D5 player is missing {token}")
    if list(root.rglob("*.xp3")):
        raise SystemExit("D5 web output must not copy XP3 files")
    print("D5 artifacts valid: existing 4.04 GB cache identity preserved; three archives configured.")


if __name__ == "__main__":
    main()
