from __future__ import annotations

import importlib.util
import struct
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("generate_test_xp3", ROOT / "tools" / "generate_test_xp3.py")
XP3 = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(XP3)


class D3Xp3Tests(unittest.TestCase):
    def test_archive_round_trip_and_marker(self) -> None:
        files = {"startup.tjs": b'{ Debug.message("ok"); }', "sub/test.bin": bytes(range(256))}
        archive = XP3.make_archive(files)
        self.assertEqual(archive[:11], XP3.XP3_MARK)
        self.assertEqual(XP3.read_archive(archive), files)

    def test_corrupt_marker_is_rejected(self) -> None:
        archive = bytearray(XP3.make_archive({"startup.tjs": b"{}"}))
        archive[0] = 0
        with self.assertRaisesRegex(ValueError, "marker"):
            XP3.read_archive(bytes(archive))

    def test_cli_output_can_be_inspected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="krkr2web-d3-") as directory:
            target = Path(directory) / "data.xp3"
            target.write_bytes(XP3.make_archive({"startup.tjs": b"{}"}))
            self.assertEqual(XP3.read_archive(target.read_bytes())["startup.tjs"], b"{}")

    def test_frame_probe_contains_real_window_and_layer(self) -> None:
        startup = (ROOT / "probes" / "d3-engine" / "game" / "startup.tjs").read_text(encoding="utf-8")
        self.assertIn("class D3ProbeWindow extends Window", startup)
        self.assertIn("new D3ProbeWindow()", startup)
        self.assertIn("new Layer(d3ProbeWindow, null)", startup)
        self.assertIn('loadImages("probe.bmp"', startup)
        self.assertIn('Font.addFont("DroidSansFallback.ttf")', startup)
        self.assertIn("drawText(", startup)
        self.assertIn("onClick", startup)
        self.assertIn("onTouchUp", startup)
        self.assertIn("onKeyDown", startup)
        self.assertIn("onKeyUp", startup)
        self.assertIn("KRKR2WEB_D3_INPUT_ACTION", startup)
        self.assertIn('new Timer(d3ProbeWindow, "onTimer")', startup)
        self.assertIn("KRKR2WEB_D3_HEARTBEAT", startup)
        self.assertIn("0x1C0", startup)
        self.assertIn("new WaveSoundBuffer", startup)
        self.assertIn("new KAGParser()", startup)
        self.assertIn('loadScenario("scenario.ks")', startup)
        self.assertIn("d3ProbeKag.store()", startup)
        self.assertIn("d3ProbeKag.restore(restored.parser)", startup)
        self.assertIn("Dictionary.saveStruct incontextof progress", startup)
        self.assertIn("KRKR2WEB_D3_KAG_CHOICE", startup)
        self.assertIn("KRKR2WEB_D3_INTERACTIVE_READY", startup)

    def test_kag_scenario_covers_control_flow_and_branching(self) -> None:
        scenario = (ROOT / "probes" / "d3-engine" / "game" / "scenario.ks").read_text(encoding="utf-8")
        self.assertIn("[jump target=*intro]", scenario)
        self.assertIn("[macro name=emit]", scenario)
        self.assertIn("[if exp=", scenario)
        self.assertIn("[choice]", scenario)
        self.assertIn("*left", scenario)
        self.assertIn("*right", scenario)
        self.assertIn("[checkpoint branch=left]", scenario)

    def test_engine_lock_tracks_kag_source_and_all_patches(self) -> None:
        import json

        engine_lock = json.loads((ROOT / "engine" / "upstream.json").read_text(encoding="utf-8"))
        self.assertEqual(engine_lock["sourceImports"][0]["name"], "KAGParser")
        self.assertIn("patches/0002-enable-kag-parser.patch", engine_lock["patches"])
        self.assertIn("patches/0006-web-decompression-stream.patch", engine_lock["patches"])
        self.assertIn("patches/0007-web-plugin-contract.patch", engine_lock["patches"])
        self.assertIn("patches/0008-web-addfont-shim.patch", engine_lock["patches"])
        decompression_patch = (
            ROOT / "engine" / "patches" / "0006-web-decompression-stream.patch"
        ).read_text(encoding="utf-8")
        self.assertIn('DecompressionStream("deflate")', decompression_patch)
        self.assertEqual(decompression_patch.count("TVPXP3Uncompress("), 4)
        plugin_patch = (
            ROOT / "engine" / "patches" / "0007-web-plugin-contract.patch"
        ).read_text(encoding="utf-8")
        self.assertIn("KRKR2WEB_D5_PLUGIN_NOOP", plugin_patch)
        self.assertIn("KRKR2WEB_D5_PLUGIN_SHIM menu.dll", plugin_patch)
        self.assertIn("class KRKR2WebMenuItem", plugin_patch)
        self.assertIn("function MenuItem(owner, caption)", plugin_patch)
        self.assertIn("function finalize()", plugin_patch)
        self.assertIn("var index = -1", plugin_patch)
        self.assertIn("refreshIndexes()", plugin_patch)
        self.assertIn("function insert(item, index)", plugin_patch)
        self.assertIn("children.find(item)", plugin_patch)
        self.assertNotIn("TVPThrowExceptionMessage", plugin_patch)
        self.assertIn("-krkr2web-motion-bootstrap", plugin_patch)
        addfont_patch = (
            ROOT / "engine" / "patches" / "0008-web-addfont-shim.patch"
        ).read_text(encoding="utf-8")
        self.assertIn("System.addFont", addfont_patch)
        self.assertIn("Font.addFont(storage)", addfont_patch)

    def test_probe_checks_server_version_before_starting_cached_game(self) -> None:
        app = (ROOT / "probes" / "d3-engine" / "web" / "app.js").read_text(encoding="utf-8")
        page = (ROOT / "probes" / "d3-engine" / "web" / "index.html").read_text(encoding="utf-8")
        self.assertIn("prepared.version !== catalogState.manifest.version", app)
        self.assertIn("await downloader.start()", app)
        self.assertIn("module.FS.syncfs(false", app)
        self.assertIn("elements.reload.href = restartUrl()", app)
        self.assertIn('if (params.get("restart")) { setTimeout(start, 0); }', app)
        self.assertNotIn("location.reload()", app)
        self.assertIn('<a id="reload-button"', page)
        self.assertIn('id="soak-button"', page)
        self.assertIn("SOAK_TARGET_DURATION_MS", app)
        self.assertIn('reportVersion: 5', app)
        self.assertIn("localStorage.setItem(soakKey", app)
        self.assertIn("document.visibilityState === \"visible\"", app)
        self.assertIn("KRKR2WEB_D3_HEARTBEAT", app)
        self.assertIn("var storageBridge = window.krkr2StorageBridge", app)
        self.assertNotIn("window.krkr2StorageBridge.snapshot()", app)
        self.assertIn("legacyStorageProbeErrors.indexOf(message)", app)

    def test_generated_probe_media_has_valid_headers(self) -> None:
        bmp = XP3.make_probe_bmp(8, 4)
        wav = XP3.make_probe_wav(sample_rate=8000, duration_ms=100)
        self.assertEqual(bmp[:2], b"BM")
        self.assertEqual(struct.unpack_from("<ii", bmp, 18), (8, 4))
        self.assertEqual(wav[:12], b"RIFF" + struct.pack("<I", len(wav) - 8) + b"WAVE")

    def test_d4_product_starts_offline_in_the_current_document(self) -> None:
        product = (ROOT / "apps" / "web" / "app.js").read_text(encoding="utf-8")
        player = (ROOT / "apps" / "web" / "player.js").read_text(encoding="utf-8")
        page = (ROOT / "apps" / "web" / "index.html").read_text(encoding="utf-8")
        downloader = (ROOT / "probes" / "d2-downloader" / "web" / "downloader.js").read_text(encoding="utf-8")
        self.assertIn("getLatestCatalog", product)
        self.assertIn('actionButton("启动游戏"', product)
        self.assertNotIn('/play/?gameId=', product)
        self.assertIn('id="player-view"', page)
        self.assertNotIn("serviceWorker", page)
        self.assertIn("storageBridge.prepare(gameId)", player)
        self.assertIn("wasmBinary: wasmBinary", player)
        self.assertIn("setInterval(syncSaves, 30000)", player)
        self.assertIn("this.options.gameId", downloader)


if __name__ == "__main__":
    unittest.main()
