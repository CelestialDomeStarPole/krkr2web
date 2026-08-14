from __future__ import annotations

import contextlib
import hashlib
import http.client
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from functools import partial
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"
sys.path.insert(0, str(TOOLS))

from https_diagnostics_server import DiagnosticsHandler  # noqa: E402
from http.server import ThreadingHTTPServer  # noqa: E402


class D2ToolsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="krkr2web-d2-")
        self.base = Path(self.temporary.name)
        self.source = self.base / "source"
        self.web = self.base / "web"
        self.reports = self.base / "reports"
        self.source.mkdir()
        self.web.mkdir()
        pattern = bytes(range(256))
        self.package_bytes = pattern * ((5 * 1024 * 1024 + 37) // len(pattern))
        self.package_bytes = self.package_bytes[: 5 * 1024 * 1024 + 37]
        (self.source / "fixture.xp3").write_bytes(self.package_bytes)
        for name in ("index.html", "styles.css", "storage.js", "downloader.js", "app.js"):
            source = ROOT / "probes" / "d2-downloader" / "web" / name
            (self.web / name).write_bytes(source.read_bytes())
        self.resource_map_path = self.base / "resource-map.json"
        self.metadata_path = self.base / "metadata.json"

        subprocess.run(
            [
                sys.executable,
                str(TOOLS / "generate_d2_catalog.py"),
                "--game-id", "test-game",
                "--title", "Test Game",
                "--engine-profile", "test-v1",
                "--source-directory", str(self.source),
                "--package", "fixture.xp3",
                "--web-output", str(self.web),
                "--resource-map-output", str(self.resource_map_path),
                "--metadata-output", str(self.metadata_path),
            ],
            check=True,
            capture_output=True,
            text=True,
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_generator_and_checker(self) -> None:
        catalog = json.loads((self.web / "catalog.json").read_text(encoding="utf-8"))
        game = catalog["games"][0]
        manifest = json.loads((self.web / game["manifestUrl"].lstrip("/")).read_text(encoding="utf-8"))
        package = manifest["packages"][0]
        self.assertEqual(package["size"], len(self.package_bytes))
        self.assertEqual(package["sha256"], hashlib.sha256(self.package_bytes).hexdigest())
        self.assertEqual(len(package["chunks"]), 2)
        self.assertEqual(package["chunks"][0], hashlib.sha256(self.package_bytes[: 4 * 1024 * 1024]).hexdigest())
        subprocess.run(
            [
                sys.executable,
                str(TOOLS / "check_d2_artifacts.py"),
                "--web-directory", str(self.web),
                "--resource-map", str(self.resource_map_path),
            ],
            check=True,
            capture_output=True,
            text=True,
        )

    @contextlib.contextmanager
    def running_server(self):
        raw_map = json.loads(self.resource_map_path.read_text(encoding="utf-8"))
        resource_map = {
            resource["url"]: {
                "source": resource["source"],
                "size": resource["size"],
                "etag": f'"sha256-{resource["sha256"]}"',
            }
            for resource in raw_map["resources"]
        }
        handler = partial(
            DiagnosticsHandler,
            directory=str(self.web),
            report_directory=str(self.reports),
            resource_map=resource_map,
        )
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield server.server_address[1], next(iter(resource_map)), next(iter(resource_map.values()))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_strict_range_and_version_etag(self) -> None:
        with self.running_server() as (port, url, resource):
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            connection.request(
                "GET",
                url,
                headers={"Range": "bytes=4194300-4194311", "If-Match": resource["etag"]},
            )
            response = connection.getresponse()
            body = response.read()
            self.assertEqual(response.status, 206)
            self.assertEqual(response.getheader("Content-Range"), f"bytes 4194300-4194311/{len(self.package_bytes)}")
            self.assertEqual(body, self.package_bytes[4194300:4194312])

            connection.request("GET", url, headers={"Range": "bytes=0-15", "If-Match": '"stale"'})
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.status, 412)

            connection.request("GET", url, headers={"Range": "bytes=999999999-"})
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.status, 416)

            connection.request("GET", "/games/missing/content/file.xp3", headers={"Range": "bytes=0-15"})
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.status, 404)
            connection.close()

    def test_diagnostic_report_versions_one_through_five_are_accepted(self) -> None:
        with self.running_server() as (port, _url, _resource):
            for version in (1, 2, 3, 4, 5):
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                results = {"interactive": {"kag": {"textPhases": []}}} if version in (3, 4, 5) else {}
                if version in (4, 5):
                    results["interactive"]["enhancedInput"] = {"keyboard": {}, "gamepad": {}}
                if version == 5:
                    results["stability"] = {
                        "schemaVersion": 1, "segments": [], "samples": [], "gate": {}
                    }
                body = json.dumps({"reportVersion": version, "probe": "test", "results": results})
                connection.request(
                    "POST",
                    "/api/diagnostics-reports",
                    body=body,
                    headers={
                        "Content-Type": "application/json",
                        "Origin": f"http://127.0.0.1:{port}",
                        "Host": f"127.0.0.1:{port}",
                    },
                )
                response = connection.getresponse()
                response_body = json.loads(response.read())
                self.assertEqual(response.status, 201)
                self.assertTrue(response_body["ok"])
                connection.close()

    def test_diagnostic_report_version_three_requires_kag_results(self) -> None:
        with self.running_server() as (port, _url, _resource):
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            body = json.dumps({"reportVersion": 3, "probe": "test", "results": {}})
            connection.request(
                "POST",
                "/api/diagnostics-reports",
                body=body,
                headers={
                    "Content-Type": "application/json",
                    "Origin": f"http://127.0.0.1:{port}",
                    "Host": f"127.0.0.1:{port}",
                },
            )
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.status, 400)
            connection.close()

    def test_diagnostic_report_version_four_requires_enhanced_input(self) -> None:
        with self.running_server() as (port, _url, _resource):
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            body = json.dumps({
                "reportVersion": 4,
                "probe": "test",
                "results": {"interactive": {"kag": {"textPhases": []}}},
            })
            connection.request(
                "POST",
                "/api/diagnostics-reports",
                body=body,
                headers={
                    "Content-Type": "application/json",
                    "Origin": f"http://127.0.0.1:{port}",
                    "Host": f"127.0.0.1:{port}",
                },
            )
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.status, 400)
            connection.close()

    def test_diagnostic_report_version_five_requires_stability_results(self) -> None:
        with self.running_server() as (port, _url, _resource):
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            body = json.dumps({
                "reportVersion": 5,
                "probe": "test",
                "results": {
                    "interactive": {
                        "kag": {"textPhases": []},
                        "enhancedInput": {"keyboard": {}, "gamepad": {}},
                    }
                },
            })
            connection.request(
                "POST",
                "/api/diagnostics-reports",
                body=body,
                headers={
                    "Content-Type": "application/json",
                    "Origin": f"http://127.0.0.1:{port}",
                    "Host": f"127.0.0.1:{port}",
                },
            )
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.status, 400)
            connection.close()

    def test_d4_product_report_requires_offline_state_and_installs(self) -> None:
        with self.running_server() as (port, _url, _resource):
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            headers = {
                "Content-Type": "application/json",
                "Origin": f"http://127.0.0.1:{port}",
                "Host": f"127.0.0.1:{port}",
            }
            connection.request(
                "POST", "/api/diagnostics-reports",
                body=json.dumps({"reportVersion": 1, "probe": "d4-product", "results": {}}),
                headers=headers,
            )
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.status, 400)

            connection.request(
                "POST", "/api/diagnostics-reports",
                body=json.dumps({
                    "reportVersion": 1,
                    "probe": "d4-product",
                    "results": {"installs": {}, "samePageOffline": {"assets": {"status": "ready"}}},
                }),
                headers=headers,
            )
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.status, 201)
            connection.close()


if __name__ == "__main__":
    unittest.main()
