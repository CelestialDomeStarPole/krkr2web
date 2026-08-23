#!/usr/bin/env python3
"""Serve only the KRKR2 diagnostics page over HTTPS with COOP/COEP headers."""

from __future__ import annotations

import argparse
import datetime as dt
import functools
import hashlib
import http.server
import json
import mimetypes
import os
import re
import ssl
import threading
import uuid
from pathlib import Path
from urllib.parse import urlsplit


REPORT_ENDPOINT = "/api/diagnostics-reports"
MAX_REPORT_BYTES = 1024 * 1024
COPY_BUFFER_BYTES = 1024 * 1024
RANGE_PATTERN = re.compile(r"bytes=(\d+)-(\d*)$")
GAME_ID_PATTERN = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*$")
# Content-addressed assets stamped by tools/stamp_build_versions.py (?v=hash).
# The exact-hash URL can never change meaning, so it may be cached forever;
# everything else (HTML, catalog, xp3 ranges, videos) must revalidate.
STAMPED_QUERY = re.compile(r"v=[0-9a-f]{8}")


class GameDirectoryScanner:
    """krkr2web: drop-in game discovery for deployments.

    Games live as ``games/<gameId>/<version>/manifest.json`` — the layout
    written by tools/generate_d2_catalog.py. The scanner derives two things
    from that tree: a synthesized catalog served for ``/catalog.json``
    (--auto-catalog), and resource entries (URL -> file + sha256 ETag) so
    packages physically placed inside the site directory get the same
    Range/206 + If-Match service as explicit --resource-map entries — the
    chunked installer requires it, plain static serving does not provide it.
    """

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self._cached_marks: tuple[object, ...] | None = None
        self._cached_result: tuple[dict[str, object], dict[str, dict[str, object]]] | None = None

    def _walk(self) -> list[tuple[Path, Path, dict[str, int]]]:
        games_root = self.root / "games"
        found: list[tuple[Path, Path, dict[str, int]]] = []
        if not games_root.is_dir():
            return found
        for game_dir in sorted(games_root.iterdir()):
            if not game_dir.is_dir() or not GAME_ID_PATTERN.fullmatch(game_dir.name):
                continue
            for version_dir in sorted(game_dir.iterdir()):
                if not version_dir.is_dir():
                    continue
                manifest_path = version_dir / "manifest.json"
                if not manifest_path.is_file():
                    continue
                marks = {"manifest": manifest_path.stat().st_mtime_ns}
                meta_path = version_dir / "meta.json"
                if meta_path.is_file():
                    marks["meta"] = meta_path.stat().st_mtime_ns
                found.append((game_dir, version_dir, marks))
        return found

    def scan(self) -> tuple[dict[str, object], dict[str, dict[str, object]]]:
        walked = self._walk()
        marks = tuple((str(version_dir), file_marks) for _, version_dir, file_marks in walked)
        if self._cached_result is not None and self._cached_marks == marks:
            return self._cached_result
        result = self._build(walked)
        self._cached_marks = marks
        self._cached_result = result
        return result

    def _build(self, walked: list[tuple[Path, Path, dict[str, int]]]) -> tuple[dict[str, object], dict[str, dict[str, object]]]:
        by_game: dict[str, list[tuple[int, Path, Path]]] = {}
        for game_dir, version_dir, file_marks in walked:
            by_game.setdefault(game_dir.name, []).append(
                (file_marks["manifest"], version_dir / "manifest.json", version_dir)
            )
        games: dict[str, dict[str, object]] = {}
        resources: dict[str, dict[str, object]] = {}
        for game_id, candidates in by_game.items():
            # several version directories may coexist (immutable content
            # versions); the manifest generated or copied last wins
            _, manifest_path, version_dir = max(candidates, key=lambda item: (item[0], item[1].parent.name))
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
                print(f"Auto-catalog: skipping unreadable manifest {manifest_path}: {error}")
                continue
            packages = manifest.get("packages")
            required_bytes = manifest.get("requiredBytes")
            if (
                manifest.get("gameId") != game_id
                or manifest.get("version") != version_dir.name
                or not isinstance(packages, list)
                or not packages
                or not isinstance(required_bytes, int)
                or required_bytes <= 0
            ):
                print(f"Auto-catalog: skipping {version_dir} (gameId/version/packages inconsistent)")
                continue
            meta: dict[str, object] = {}
            meta_path = version_dir / "meta.json"
            if meta_path.is_file():
                try:
                    loaded = json.loads(meta_path.read_text(encoding="utf-8-sig"))
                    if isinstance(loaded, dict):
                        meta = loaded
                except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                    meta = {}
            entry: dict[str, object] = {
                "gameId": game_id,
                "title": str(meta.get("title") or manifest.get("title") or game_id),
                "version": version_dir.name,
                "manifestUrl": f"/games/{game_id}/{version_dir.name}/manifest.json",
                "requiredBytes": required_bytes,
                "compatibility": str(meta.get("compatibility") or "development"),
            }
            if isinstance(meta.get("coverUrl"), str) and meta["coverUrl"]:
                entry["coverUrl"] = meta["coverUrl"]
            if isinstance(meta.get("description"), str) and meta["description"]:
                entry["description"] = meta["description"]
            games[game_id] = entry
            for package in packages:
                if not isinstance(package, dict):
                    continue
                url = package.get("url")
                size = package.get("size")
                sha256 = package.get("sha256")
                if not (isinstance(url, str) and url.startswith("/")
                        and isinstance(size, int) and isinstance(sha256, str) and len(sha256) == 64):
                    continue
                source = (self.root / url.lstrip("/")).resolve()
                if not source.is_relative_to(self.root):
                    continue
                resources[url] = {"source": str(source), "size": size, "etag": f'"sha256-{sha256}"'}
        seed = "|".join(f"{game_id}:{games[game_id]['version']}" for game_id in sorted(games))
        catalog = {
            "schemaVersion": 1,
            "catalogVersion": "catalog-" + hashlib.sha256(seed.encode("utf-8")).hexdigest()[:16],
            "games": [games[game_id] for game_id in sorted(games)],
        }
        return catalog, resources


class DiagnosticsHandler(http.server.SimpleHTTPRequestHandler):
    # krkr2web: HTTP/1.0 (the stdlib default) tears down the connection after
    # every response, so each page refresh rebuilt TCP+TLS for ~12 subresources;
    # on the flaky X5 WebView stack any of those handshakes failing drops one
    # stylesheet/script and the page renders unstyled. 1.1 keep-alive reuses
    # connections. Every response path here sends an exact Content-Length, which
    # keep-alive requires.
    protocol_version = "HTTP/1.1"
    timeout = 60
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".webmanifest": "application/manifest+json; charset=utf-8",
        ".wasm": "application/wasm",
    }
    report_write_lock = threading.Lock()

    def __init__(
        self,
        *args: object,
        report_directory: str,
        resource_map: dict[str, dict[str, object]] | None = None,
        video_directory: str | None = None,
        savedata_directory: str | None = None,
        catalog_scanner: GameDirectoryScanner | None = None,
        auto_catalog: bool = False,
        **kwargs: object,
    ) -> None:
        self.report_directory = Path(report_directory)
        self.resource_map = resource_map or {}
        self.video_directory = Path(video_directory).resolve() if video_directory else None
        self.savedata_directory = Path(savedata_directory).resolve() if savedata_directory else None
        self.catalog_scanner = catalog_scanner
        self.auto_catalog = auto_catalog
        super().__init__(*args, **kwargs)

    def translate_path(self, path: str) -> str:
        request = urlsplit(path).path
        if self.video_directory and request.startswith("/videos/"):
            # krkr2web: pre-transcoded game videos served read-only from a
            # separate directory so the transcoded video cache never enters the
            # product build.
            relative = request[len("/videos/"):].lstrip("/")
            target = (self.video_directory / relative).resolve()
            if target.is_relative_to(self.video_directory):
                return str(target)
        return super().translate_path(path)

    def end_headers(self) -> None:
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Origin-Agent-Cluster", "?1")
        self.send_header("Permissions-Policy", "interest-cohort=()")
        if STAMPED_QUERY.fullmatch(urlsplit(self.path).query):
            # immutable lets the WebView serve stamped assets straight from its
            # disk cache with zero network requests — a revalidation round-trip
            # is one more chance for the flaky mobile stack to drop a resource
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def _is_missing_page_route(self) -> bool:
        request_path = urlsplit(self.path).path
        target = Path(self.translate_path(request_path))
        if target.exists():
            return False
        suffix = Path(request_path).suffix.lower()
        return request_path.endswith("/") or suffix in {"", ".html", ".htm"}

    def _serve_or_redirect(self, method: str) -> None:
        if self._is_missing_page_route():
            self.send_response(http.HTTPStatus.FOUND)
            request = urlsplit(self.path)
            location = "/play/" if request.path.startswith("/play/") else "/"
            if request.query:
                location += "?" + request.query
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        getattr(super(), method)()

    def _resource_entry(self) -> dict[str, object] | None:
        path = urlsplit(self.path).path
        # explicit --resource-map wins; auto-derived entries (packages placed
        # physically under games/) fill the gaps so both layouts work
        entry = self.resource_map.get(path)
        if entry is not None:
            return entry
        if self.catalog_scanner is not None:
            return self.catalog_scanner.scan()[1].get(path)
        return None

    def _serve_synthesized_catalog(self, head_only: bool) -> bool:
        if not (self.auto_catalog and urlsplit(self.path).path == "/catalog.json"):
            return False
        assert self.catalog_scanner is not None
        catalog, _ = self.catalog_scanner.scan()
        if not catalog["games"]:
            # nothing discovered: keep serving a static catalog if present
            if Path(self.translate_path("/catalog.json")).is_file():
                return False
        payload = (json.dumps(catalog, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        self.send_response(http.HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if not head_only:
            self.wfile.write(payload)
        return True

    def _serve_resource(self, head_only: bool) -> None:
        entry = self._resource_entry()
        if entry is None:
            self.send_error(http.HTTPStatus.NOT_FOUND)
            return

        source = Path(str(entry["source"]))
        expected_size = int(entry["size"])
        etag = str(entry["etag"])
        try:
            actual_size = source.stat().st_size
        except OSError:
            self.send_error(http.HTTPStatus.NOT_FOUND)
            return
        if actual_size != expected_size:
            self._send_json(
                http.HTTPStatus.PRECONDITION_FAILED,
                {"ok": False, "error": "服务器资源已变化，请重新生成 Manifest"},
            )
            return

        if_match = self.headers.get("If-Match")
        if if_match and if_match not in {"*", etag}:
            self.send_response(http.HTTPStatus.PRECONDITION_FAILED)
            self.send_header("ETag", etag)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        start = 0
        end = expected_size - 1
        status = http.HTTPStatus.OK
        requested_range = self.headers.get("Range")
        if requested_range:
            match = RANGE_PATTERN.fullmatch(requested_range.strip())
            if not match:
                self.send_response(http.HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{expected_size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            start = int(match.group(1))
            requested_end = match.group(2)
            end = int(requested_end) if requested_end else expected_size - 1
            if start >= expected_size or end < start:
                self.send_response(http.HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{expected_size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            end = min(end, expected_size - 1)
            status = http.HTTPStatus.PARTIAL_CONTENT

        content_length = max(0, end - start + 1)
        self.send_response(status)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("ETag", etag)
        self.send_header("Content-Length", str(content_length))
        if status == http.HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{expected_size}")
        self.end_headers()
        if head_only or content_length == 0:
            return

        try:
            with source.open("rb") as stream:
                stream.seek(start)
                remaining = content_length
                while remaining:
                    block = stream.read(min(COPY_BUFFER_BYTES, remaining))
                    if not block:
                        break
                    self.wfile.write(block)
                    remaining -= len(block)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _serve_video(self, head_only: bool) -> bool:
        # krkr2web: SimpleHTTPRequestHandler ignores Range headers, which the
        # <video> overlay needs for seeking. Serve /videos/ files ourselves.
        request_path = urlsplit(self.path).path
        if not (self.video_directory and request_path.startswith("/videos/")):
            return False
        target = Path(self.translate_path(request_path))
        if not target.is_file():
            return False
        size = target.stat().st_size
        start, end = 0, size - 1
        status = http.HTTPStatus.OK
        requested_range = self.headers.get("Range")
        if requested_range:
            match = RANGE_PATTERN.fullmatch(requested_range.strip())
            if match:
                start = int(match.group(1))
                requested_end = match.group(2)
                end = int(requested_end) if requested_end else size - 1
            if not match or start >= size or end < start:
                self.send_response(http.HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return True
            end = min(end, size - 1)
            status = http.HTTPStatus.PARTIAL_CONTENT
        content_length = max(0, end - start + 1)
        self.send_response(status)
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_header("Content-Type", content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(content_length))
        if status == http.HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if head_only or content_length == 0:
            return True
        try:
            with target.open("rb") as stream:
                stream.seek(start)
                remaining = content_length
                while remaining:
                    block = stream.read(min(COPY_BUFFER_BYTES, remaining))
                    if not block:
                        break
                    self.wfile.write(block)
                    remaining -= len(block)
        except (BrokenPipeError, ConnectionResetError):
            pass
        return True

    def _serve_savedata_import(self, head_only: bool) -> bool:
        # krkr2web: read-only cleared-save import directory. The browser save
        # manager fetches manifest.json plus each file and writes IDBFS-shaped
        # records into the game's save database.
        request_path = urlsplit(self.path).path
        if not (self.savedata_directory and request_path.startswith("/savedata-import/")):
            return False
        relative = request_path[len("/savedata-import/"):].lstrip("/")
        if relative == "manifest.json":
            files = []
            if self.savedata_directory.is_dir():
                for entry in sorted(self.savedata_directory.iterdir()):
                    if entry.is_file():
                        files.append({"name": entry.name, "bytes": entry.stat().st_size})
            payload = json.dumps({"files": files}, ensure_ascii=False).encode("utf-8")
            self.send_response(http.HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            if not head_only:
                self.wfile.write(payload)
            return True
        target = (self.savedata_directory / relative).resolve()
        if not (relative and target.is_relative_to(self.savedata_directory) and target.is_file()):
            self.send_error(http.HTTPStatus.NOT_FOUND)
            return True
        payload = target.read_bytes()
        self.send_response(http.HTTPStatus.OK)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if not head_only:
            self.wfile.write(payload)
        return True

    def do_GET(self) -> None:
        if self._serve_synthesized_catalog(head_only=False):
            return
        if self._resource_entry() is not None:
            self._serve_resource(head_only=False)
            return
        if self._serve_video(head_only=False):
            return
        if self._serve_savedata_import(head_only=False):
            return
        self._serve_or_redirect("do_GET")

    def do_HEAD(self) -> None:
        if self._serve_synthesized_catalog(head_only=True):
            return
        if self._resource_entry() is not None:
            self._serve_resource(head_only=True)
            return
        if self._serve_video(head_only=True):
            return
        if self._serve_savedata_import(head_only=True):
            return
        self._serve_or_redirect("do_HEAD")

    def _send_json(self, status: http.HTTPStatus, payload: dict[str, object]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        if urlsplit(self.path).path != REPORT_ENDPOINT:
            self._send_json(http.HTTPStatus.NOT_FOUND, {"ok": False, "error": "接口不存在"})
            return

        host = self.headers.get("Host", "")
        request_origin = self.headers.get("Origin", "")
        scheme = "https" if isinstance(self.connection, ssl.SSLSocket) else "http"
        if not host or request_origin != f"{scheme}://{host}":
            self._send_json(http.HTTPStatus.FORBIDDEN, {"ok": False, "error": "只接受检测页面的同源上传"})
            return

        content_type = self.headers.get_content_type()
        if content_type != "application/json":
            self._send_json(http.HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"ok": False, "error": "只接受 JSON 报告"})
            return

        content_length_text = self.headers.get("Content-Length")
        try:
            content_length = int(content_length_text or "")
        except ValueError:
            content_length = -1
        if content_length <= 0 or content_length > MAX_REPORT_BYTES:
            self._send_json(http.HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"ok": False, "error": "报告大小无效或超过 1 MiB"})
            return

        try:
            report = json.loads(self.rfile.read(content_length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json(http.HTTPStatus.BAD_REQUEST, {"ok": False, "error": "报告 JSON 无效"})
            return
        if not isinstance(report, dict) or report.get("reportVersion") not in {1, 2, 3, 4, 5} or not isinstance(report.get("results"), dict):
            self._send_json(http.HTTPStatus.BAD_REQUEST, {"ok": False, "error": "报告结构无效"})
            return
        # "d4-product" is the pre-rename value; historical devices may still
        # submit it until every cached page has been reopened once.
        if report.get("probe") in {"krkr2web-product", "d4-product"}:
            results = report["results"]
            installs = results.get("installs")
            offline = results.get("samePageOffline", results.get("shell"))
            if not isinstance(installs, dict) or not isinstance(offline, dict):
                self._send_json(http.HTTPStatus.BAD_REQUEST, {"ok": False, "error": "产品报告结构无效"})
                return
        if report.get("reportVersion") in {3, 4, 5}:
            interactive = report["results"].get("interactive")
            kag = interactive.get("kag") if isinstance(interactive, dict) else None
            if not isinstance(kag, dict) or not isinstance(kag.get("textPhases"), list):
                self._send_json(http.HTTPStatus.BAD_REQUEST, {"ok": False, "error": "KAG 报告结构无效"})
                return
        if report.get("reportVersion") in {4, 5}:
            enhanced_input = interactive.get("enhancedInput") if isinstance(interactive, dict) else None
            keyboard = enhanced_input.get("keyboard") if isinstance(enhanced_input, dict) else None
            gamepad = enhanced_input.get("gamepad") if isinstance(enhanced_input, dict) else None
            if not isinstance(keyboard, dict) or not isinstance(gamepad, dict):
                self._send_json(http.HTTPStatus.BAD_REQUEST, {"ok": False, "error": "增强输入报告结构无效"})
                return
        if report.get("reportVersion") == 5:
            stability = report["results"].get("stability")
            gate = stability.get("gate") if isinstance(stability, dict) else None
            if (
                not isinstance(stability, dict)
                or stability.get("schemaVersion") != 1
                or not isinstance(stability.get("segments"), list)
                or not isinstance(stability.get("samples"), list)
                or not isinstance(gate, dict)
            ):
                self._send_json(http.HTTPStatus.BAD_REQUEST, {"ok": False, "error": "稳定性报告结构无效"})
                return

        received_at = dt.datetime.now(dt.UTC)
        report_id = received_at.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8]
        stored_report = dict(report)
        stored_report["serverReceipt"] = {
            "reportId": report_id,
            "receivedAt": received_at.isoformat(),
        }
        target = self.report_directory / f"{report_id}.json"
        temporary = self.report_directory / f".{report_id}.tmp"
        try:
            body = json.dumps(stored_report, ensure_ascii=False, indent=2).encode("utf-8")
            with self.report_write_lock:
                self.report_directory.mkdir(parents=True, exist_ok=True)
                temporary.write_bytes(body)
                os.replace(temporary, target)
        except OSError as error:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            print(f"Report save failed: {error}")
            self._send_json(http.HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": "服务器保存报告失败"})
            return

        print(f"Saved diagnostics report: {target}")
        self._send_json(http.HTTPStatus.CREATED, {
            "ok": True,
            "reportId": report_id,
            "receivedAt": received_at.isoformat(),
        })

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.client_address[0]} - {format % args}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8443)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--reports-directory", type=Path, default=Path("diagnostic-reports"))
    parser.add_argument("--cert", type=Path)
    parser.add_argument("--key", type=Path)
    parser.add_argument(
        "--resource-map",
        type=Path,
        help="optional JSON map for exact URL paths backed by large local files",
    )
    parser.add_argument(
        "--video-directory",
        type=Path,
        help="optional directory served under /videos/ (pre-transcoded game videos)",
    )
    parser.add_argument(
        "--savedata-directory",
        type=Path,
        help="optional directory served under /savedata-import/ (cleared saves for browser import)",
    )
    parser.add_argument("--http", action="store_true", help="local automated QA only; do not use for device testing")
    parser.add_argument(
        "--auto-catalog",
        action="store_true",
        help="serve /catalog.json synthesized from games/<gameId>/<version>/manifest.json "
        "(drop-in game deployment; per-game meta.json may override title/description/coverUrl/compatibility)",
    )
    args = parser.parse_args()

    directory = args.directory.resolve()
    report_directory = args.reports_directory.resolve()
    if not directory.is_dir():
        raise SystemExit(f"Diagnostics directory does not exist: {directory}")

    catalog_scanner = GameDirectoryScanner(directory)

    resource_map: dict[str, dict[str, object]] = {}
    if args.resource_map is not None:
        resource_map_path = args.resource_map.resolve()
        try:
            raw_resource_map = json.loads(resource_map_path.read_text(encoding="utf-8"))
            raw_resources = raw_resource_map["resources"]
            if not isinstance(raw_resources, list):
                raise TypeError("resources must be an array")
            for resource in raw_resources:
                url_path = resource["url"]
                if not isinstance(url_path, str) or not url_path.startswith("/"):
                    raise ValueError("resource URL must be an absolute path")
                source = Path(resource["source"]).resolve()
                size = int(resource["size"])
                sha256 = str(resource["sha256"])
                if url_path in resource_map:
                    raise ValueError(f"duplicate resource URL: {url_path}")
                resource_map[url_path] = {
                    "source": str(source),
                    "size": size,
                    "etag": f'"sha256-{sha256}"',
                }
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise SystemExit(f"Invalid resource map {resource_map_path}: {error}") from error

    handler = functools.partial(
        DiagnosticsHandler,
        directory=str(directory),
        report_directory=str(report_directory),
        resource_map=resource_map,
        video_directory=str(args.video_directory.resolve()) if args.video_directory else None,
        savedata_directory=str(args.savedata_directory.resolve()) if args.savedata_directory else None,
        catalog_scanner=catalog_scanner,
        auto_catalog=args.auto_catalog,
    )
    server = http.server.ThreadingHTTPServer((args.bind, args.port), handler)
    scheme = "http" if args.http else "https"
    if not args.http:
        if args.cert is None or args.key is None:
            raise SystemExit("HTTPS mode requires --cert and --key")
        certificate = args.cert.resolve()
        private_key = args.key.resolve()
        if not certificate.is_file() or not private_key.is_file():
            raise SystemExit("Certificate or private key does not exist")
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(certificate, private_key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
    print(f"Serving {directory}")
    print(f"Saving uploaded reports to {report_directory}")
    if resource_map:
        print(f"Serving {len(resource_map)} mapped large resources with HTTP Range")
    if args.auto_catalog:
        discovered = catalog_scanner.scan()[0]["games"]
        print(f"Auto-catalog enabled: {len(discovered)} game(s) discovered under games/")
    else:
        print("Auto-derived package entries under games/: enabled (catalog synthesis off)")
    print(f"Listening on {scheme}://{args.bind}:{args.port}/")
    print("Press Ctrl+C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopping server")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
