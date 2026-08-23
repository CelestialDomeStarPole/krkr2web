from __future__ import annotations

import functools
import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"
sys.path.insert(0, str(TOOLS))

from https_diagnostics_server import DiagnosticsHandler, GameDirectoryScanner  # noqa: E402


def package(game_id: str, version: str, name: str = "data.xp3", size: int = 100) -> dict[str, object]:
    return {
        "id": name,
        "virtualPath": name,
        "url": f"/games/{game_id}/{version}/{name}",
        "size": size,
        "chunkSize": 4 * 1024 * 1024,
        "sha256": "a" * 64,
        "chunks": ["b" * 64],
    }


def write_manifest(
    root: Path,
    game_id: str,
    version: str,
    *,
    title: str | None = None,
    packages: list[dict[str, object]] | None = None,
    meta: dict[str, object] | None = None,
    mtime: float | None = None,
) -> Path:
    packages = packages or []
    directory = root / "games" / game_id / version
    directory.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schemaVersion": 1,
        "gameId": game_id,
        "version": version,
        "title": title or game_id,
        "requiredBytes": sum(int(item["size"]) for item in packages),
        "engineProfile": "d3-minimal",
        "packages": packages,
        "mediaOverrides": [],
    }
    path = directory / "manifest.json"
    path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    for item in packages:
        target = root / str(item["url"]).lstrip("/")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"p" * int(item["size"]))
    if meta is not None:
        (directory / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path


class GameDirectoryScannerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="krkr2web-autocatalog-")
        self.base = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_discovers_game_and_derives_catalog_and_resources(self) -> None:
        write_manifest(self.base, "alpha", "content-1", title="Alpha", packages=[package("alpha", "content-1", size=120)])
        catalog, resources = GameDirectoryScanner(self.base).scan()
        self.assertEqual([game["gameId"] for game in catalog["games"]], ["alpha"])
        entry = catalog["games"][0]
        self.assertEqual(entry["title"], "Alpha")
        self.assertEqual(entry["version"], "content-1")
        self.assertEqual(entry["manifestUrl"], "/games/alpha/content-1/manifest.json")
        self.assertEqual(entry["requiredBytes"], 120)
        self.assertEqual(entry["compatibility"], "development")
        self.assertEqual(catalog["schemaVersion"], 1)
        self.assertTrue(str(catalog["catalogVersion"]).startswith("catalog-"))
        url = "/games/alpha/content-1/data.xp3"
        self.assertIn(url, resources)
        self.assertEqual(resources[url]["size"], 120)
        self.assertEqual(resources[url]["etag"], '"sha256-' + "a" * 64 + '"')
        self.assertTrue(Path(str(resources[url]["source"])).is_file())

    def test_multiple_games_sorted_and_catalog_version_changes(self) -> None:
        write_manifest(self.base, "zeta", "content-z", packages=[package("zeta", "content-z")])
        write_manifest(self.base, "alpha", "content-a", packages=[package("alpha", "content-a")])
        scanner = GameDirectoryScanner(self.base)
        catalog_one, _ = scanner.scan()
        self.assertEqual([game["gameId"] for game in catalog_one["games"]], ["alpha", "zeta"])
        version_one = catalog_one["catalogVersion"]
        self.assertEqual(scanner.scan()[0]["catalogVersion"], version_one)
        write_manifest(self.base, "mid", "content-m", packages=[package("mid", "content-m")])
        catalog_two, _ = scanner.scan()
        self.assertEqual([game["gameId"] for game in catalog_two["games"]], ["alpha", "mid", "zeta"])
        self.assertNotEqual(catalog_two["catalogVersion"], version_one)

    def test_newest_manifest_version_wins(self) -> None:
        write_manifest(self.base, "alpha", "content-old", packages=[package("alpha", "content-old", size=10)], mtime=1000)
        write_manifest(self.base, "alpha", "content-new", packages=[package("alpha", "content-new", size=20)], mtime=2000)
        catalog, _ = GameDirectoryScanner(self.base).scan()
        self.assertEqual(catalog["games"][0]["version"], "content-new")
        self.assertEqual(catalog["games"][0]["requiredBytes"], 20)

    def test_meta_overrides(self) -> None:
        write_manifest(
            self.base,
            "alpha",
            "content-1",
            title="Manifest Title",
            packages=[package("alpha", "content-1")],
            meta={"title": "Meta Title", "description": "描述", "coverUrl": "/assets/x.png", "compatibility": "verified"},
        )
        entry = GameDirectoryScanner(self.base).scan()[0]["games"][0]
        self.assertEqual(entry["title"], "Meta Title")
        self.assertEqual(entry["description"], "描述")
        self.assertEqual(entry["coverUrl"], "/assets/x.png")
        self.assertEqual(entry["compatibility"], "verified")

    def test_inconsistent_or_unreadable_entries_skipped(self) -> None:
        write_manifest(self.base, "alpha", "content-1", packages=[package("alpha", "content-1")])
        mismatch = self.base / "games" / "beta" / "content-1"
        mismatch.mkdir(parents=True)
        (mismatch / "manifest.json").write_text(
            json.dumps({"gameId": "other", "version": "content-1", "packages": [package("beta", "content-1")]}),
            encoding="utf-8",
        )
        broken = self.base / "games" / "gamma" / "content-1"
        broken.mkdir(parents=True)
        (broken / "manifest.json").write_text("{ not json", encoding="utf-8")
        invalid_id = self.base / "games" / "Not_Valid"
        invalid_id.mkdir(parents=True)
        (invalid_id / "content-1" / "manifest.json").parent.mkdir(parents=True)
        (invalid_id / "content-1" / "manifest.json").write_text("{}", encoding="utf-8")
        catalog, _ = GameDirectoryScanner(self.base).scan()
        self.assertEqual([game["gameId"] for game in catalog["games"]], ["alpha"])

    def test_scan_refreshes_when_manifest_changes(self) -> None:
        write_manifest(self.base, "alpha", "content-1", packages=[package("alpha", "content-1", size=10)])
        scanner = GameDirectoryScanner(self.base)
        self.assertEqual(scanner.scan()[0]["games"][0]["requiredBytes"], 10)
        write_manifest(self.base, "alpha", "content-1", packages=[package("alpha", "content-1", size=30)])
        self.assertEqual(scanner.scan()[0]["games"][0]["requiredBytes"], 30)


class AutoCatalogHttpTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="krkr2web-autocatalog-http-")
        self.base = Path(self.temporary.name)
        self.site = self.base / "site"
        self.site.mkdir()
        (self.base / "reports").mkdir()
        write_manifest(self.site, "alpha", "content-1", title="Alpha", packages=[package("alpha", "content-1", size=1000)])
        self.server: ThreadingHTTPServer | None = None
        self.thread: threading.Thread | None = None

    def tearDown(self) -> None:
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
            assert self.thread is not None
            self.thread.join(timeout=5)
        self.temporary.cleanup()

    def start_server(self, *, auto_catalog: bool, site: Path | None = None) -> int:
        directory = site or self.site
        handler = functools.partial(
            DiagnosticsHandler,
            directory=str(directory),
            report_directory=str(self.base / "reports"),
            resource_map={},
            catalog_scanner=GameDirectoryScanner(directory),
            auto_catalog=auto_catalog,
        )
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return int(self.server.server_address[1])

    def request(self, port: int, path: str, headers: dict[str, str] | None = None) -> tuple[int, dict[str, str], bytes]:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            connection.request("GET", path, headers=headers or {})
            response = connection.getresponse()
            return response.status, {key.lower(): value for key, value in response.getheaders()}, response.read()
        finally:
            connection.close()

    def test_synthesized_catalog_and_physical_range_service(self) -> None:
        port = self.start_server(auto_catalog=True)
        status, headers, body = self.request(port, "/catalog.json")
        self.assertEqual(status, 200)
        self.assertIn("application/json", headers["content-type"])
        catalog = json.loads(body.decode("utf-8"))
        self.assertEqual([game["gameId"] for game in catalog["games"]], ["alpha"])
        # physical packages get the installer contract: 206 + Content-Range + ETag
        etag = '"sha256-' + "a" * 64 + '"'
        status, headers, body = self.request(
            port,
            "/games/alpha/content-1/data.xp3",
            headers={"Range": "bytes=10-19", "If-Match": etag},
        )
        self.assertEqual(status, 206)
        self.assertEqual(headers["content-range"], "bytes 10-19/1000")
        self.assertEqual(headers["etag"], etag)
        self.assertEqual(len(body), 10)
        status, _, _ = self.request(
            port,
            "/games/alpha/content-1/data.xp3",
            headers={"Range": "bytes=0-0", "If-Match": '"sha256-mismatch"'},
        )
        self.assertEqual(status, 412)

    def test_auto_catalog_falls_back_to_static_file_when_nothing_discovered(self) -> None:
        static_site = self.base / "static-site"
        static_site.mkdir()
        (static_site / "catalog.json").write_text(
            json.dumps({"schemaVersion": 1, "catalogVersion": "catalog-static", "games": [
                {"gameId": "shipped", "title": "Shipped", "version": "content-s",
                 "manifestUrl": "/games/shipped/content-s/manifest.json",
                 "requiredBytes": 1, "compatibility": "development"}
            ]}, ensure_ascii=False),
            encoding="utf-8",
        )
        port = self.start_server(auto_catalog=True, site=static_site)
        status, _, body = self.request(port, "/catalog.json")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body.decode("utf-8"))["games"][0]["gameId"], "shipped")

    def test_auto_catalog_off_keeps_static_catalog(self) -> None:
        (self.site / "catalog.json").write_text(
            json.dumps({"schemaVersion": 1, "catalogVersion": "catalog-static", "games": [
                {"gameId": "shipped", "title": "Shipped", "version": "content-s",
                 "manifestUrl": "/games/shipped/content-s/manifest.json",
                 "requiredBytes": 1, "compatibility": "development"}
            ]}, ensure_ascii=False),
            encoding="utf-8",
        )
        port = self.start_server(auto_catalog=False)
        status, _, body = self.request(port, "/catalog.json")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body.decode("utf-8"))["games"][0]["gameId"], "shipped")


if __name__ == "__main__":
    unittest.main()
