from __future__ import annotations

import importlib.util
import json
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
        # engine/upstream.json is the build authority: every listed patch must
        # exist on disk, and no patch file may linger after it is retired from
        # the lock (retired leftovers silently rot and mislead readers).
        listed = set(engine_lock["patches"])
        on_disk = {
            f"patches/{entry.name}"
            for entry in (ROOT / "engine" / "patches").iterdir()
            if entry.name.endswith(".patch")
        }
        self.assertEqual(
            listed - on_disk, set(), "patches listed in upstream.json are missing on disk"
        )
        self.assertEqual(
            on_disk - listed, set(), "patch files on disk are not listed in upstream.json"
        )
        decompression_patch = (
            ROOT / "engine" / "patches" / "0006-web-decompression-stream.patch"
        ).read_text(encoding="utf-8")
        self.assertIn("EM_ASYNC_JS", decompression_patch)
        self.assertIn("DecompressionStream", decompression_patch)
        self.assertIn("new Worker", decompression_patch)
        self.assertIn("worker.terminate()", decompression_patch)
        self.assertIn("krkr2webAsyncTrace", decompression_patch)
        self.assertIn("timeout after 15000 ms", decompression_patch)
        self.assertIn("return uncompress(destination, destination_length", decompression_patch)
        self.assertEqual(decompression_patch.count("TVPXP3Uncompress("), 4)
        input_patch = (
            ROOT / "engine" / "patches" / "0035-emscripten-input-path.patch"
        ).read_text(encoding="utf-8")
        self.assertIn("Input is delivered from the next main-loop tick", input_patch)
        self.assertIn("(void)in_event", input_patch)
        compatibility_patch = (
            ROOT / "engine" / "patches" / "0039-web-transition-fallback-force-terminate.patch"
        ).read_text(encoding="utf-8")
        self.assertIn("patches/0039-web-transition-fallback-force-terminate.patch", engine_lock["patches"])
        self.assertIn('name == TJS_W("wave")', compatibility_patch)
        self.assertIn('Find(TJS_W("crossfade"))', compatibility_patch)
        self.assertIn('emscripten::function("forceTerminate"', compatibility_patch)
        perf_patch = (
            ROOT / "engine" / "patches" / "0040-web-perf-graphic-cache-audio-fill.patch"
        ).read_text(encoding="utf-8")
        self.assertIn("patches/0040-web-perf-graphic-cache-audio-fill.patch", engine_lock["patches"])
        self.assertIn("KRKR2WEB_D5_GRAPHIC_CACHE", perf_patch)
        self.assertIn("TVPGraphicCacheSystemLimit = 128 * 1024 * 1024", perf_patch)
        self.assertIn("fill_deadline", perf_patch)
        self.assertIn("KRKR2WEB_D5_PERF", perf_patch)
        stall_patch = (
            ROOT / "engine" / "patches" / "0041-web-trans-throttle-heartbeat-stats.patch"
        ).read_text(encoding="utf-8")
        self.assertIn("patches/0041-web-trans-throttle-heartbeat-stats.patch", engine_lock["patches"])
        self.assertIn("KRKR2WEB_D5_TRANS_STATS", stall_patch)
        self.assertIn("krkr2webEngineHeartbeat", stall_patch)
        self.assertIn("(heartbeat_counter++ & 3)", stall_patch)
        input_budget_patch = (
            ROOT / "engine" / "patches" / "0046-web-input-frame-budget.patch"
        ).read_text(encoding="utf-8")
        self.assertIn("patches/0046-web-input-frame-budget.patch", engine_lock["patches"])
        self.assertIn("max_events_per_tick = 24", input_budget_patch)
        self.assertIn("delivered_mouse_motion", input_budget_patch)
        self.assertIn("KRKR2WEB_D5_INPUT_BUDGET", input_budget_patch)
        runtime_fix_patch = (
            ROOT / "engine" / "patches" / "0044-web-audio-position-input-perf.patch"
        ).read_text(encoding="utf-8")
        self.assertIn(
            "patches/0044-web-audio-position-input-perf.patch",
            engine_lock["patches"],
        )
        self.assertGreaterEqual(runtime_fix_patch.count("GetCurrentPlaySamples()"), 3)
        self.assertIn("AL_SAMPLE_OFFSET", runtime_fix_patch)
        self.assertIn("_bufferSize[_bufferIdx] = len", runtime_fix_patch)
        self.assertIn("total += _bufferSize[idx] / _frame_size", runtime_fix_patch)
        self.assertIn("SDL_WINDOW_ALLOW_HIGHDPI", runtime_fix_patch)
        self.assertIn('name != TJS_W("*loop")', runtime_fix_patch)
        render_fix_patch = (
            ROOT / "engine" / "patches" / "0045-web-gpu-style-present-fast-transition.patch"
        ).read_text(encoding="utf-8")
        self.assertIn(
            "patches/0045-web-gpu-style-present-fast-transition.patch",
            engine_lock["patches"],
        )
        self.assertIn("rect.w = this->surface->w - rect.x", render_fix_patch)
        self.assertIn("rect.y * this->surface->pitch", render_fix_patch)
        self.assertIn("update_rect.clear()", render_fix_patch)
        self.assertIn("SDL_MUSTLOCK", render_fix_patch)
        build_script = (ROOT / "tools" / "build_d3.ps1").read_text(encoding="utf-8")
        self.assertIn('"-DCMAKE_BUILD_TYPE=Release"', build_script)
        self.assertNotIn('"-DCMAKE_BUILD_TYPE=MinSizeRel"', build_script)
        video_patch = (
            ROOT / "engine" / "patches" / "0042-web-video-overlay-bridge.patch"
        ).read_text(encoding="utf-8")
        self.assertIn("patches/0042-web-video-overlay-bridge.patch", engine_lock["patches"])
        self.assertIn("krkr2webVideoOpen", video_patch)
        self.assertIn("NotifyWebVideoEnded", video_patch)
        self.assertIn('emscripten::function("krkr2webVideoEnded"', video_patch)
        player_text = (ROOT / "apps" / "web" / "player.js").read_text(encoding="utf-8")
        self.assertIn("/videos/", player_text)
        self.assertIn("krkr2webVideoPlay", player_text)
        self.assertIn("KRKR2WEB_VIDEO_PLAY_REJECTED", player_text)
        self.assertIn("muted-autoplay-fallback", player_text)
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
        ncb_dispatch_patch = (
            ROOT / "engine" / "patches" / "0015-ncb-link-loadmodule.patch"
        ).read_text(encoding="utf-8")
        self.assertIn('else if(name == TJS_W("motionplayer.dll"))', ncb_dispatch_patch)
        self.assertIn("if(loadNCBModule(name))", ncb_dispatch_patch)
        self.assertIn("lazy-psb", ncb_dispatch_patch)
        # motionplayer must no longer require the bootstrap command-line flag;
        # the flag reference only survives as a removed line in the patch.
        self.assertIn(
            '-		TVPGetCommandLine(TJS_W("-krkr2web-motion-bootstrap")))',
            ncb_dispatch_patch,
        )
        addfont_patch = (
            ROOT / "engine" / "patches" / "0008-web-addfont-shim.patch"
        ).read_text(encoding="utf-8")
        self.assertIn("System.addFont", addfont_patch)
        self.assertIn("Font.addFont(storage)", addfont_patch)

        language_patch = (
            ROOT / "engine" / "patches" / "0021-getlangname-shim.patch"
        ).read_text(encoding="utf-8")
        self.assertIn("System.getArgument('-krkr2web-ui-language')", language_patch)
        self.assertIn("return 'Chinese'", language_patch)
        self.assertIn("return 'English'", language_patch)
        self.assertIn("return 'Japanese'", language_patch)

    def test_motion_runtime_is_commit_locked_with_lazy_psb(self) -> None:
        engine_lock = json.loads(
            (ROOT / "engine" / "upstream.json").read_text(encoding="utf-8")
        )
        build_script = (ROOT / "tools" / "build_d3.ps1").read_text(encoding="utf-8")
        runtime = next(
            item for item in engine_lock["sourceImports"]
            if item["name"] == "Kirikiroid2WebMotionRuntime"
        )

        self.assertEqual(runtime["commit"], "338d2029f16969b84becfd163c67f99740e28296")
        self.assertEqual(
            {item["source"] for item in runtime["directories"]},
            {"cpp/plugins/motionplayer", "cpp/plugins/psbfile"},
        )
        imported_files = {item["source"] for item in runtime["files"]}
        self.assertIn("cpp/plugins/BinaryAccessor.cpp", imported_files)
        self.assertIn("cpp/plugins/xp3filter.cpp", imported_files)
        self.assertNotIn("patches/0037-psbfile-utf8-boundary.patch", engine_lock["patches"])
        self.assertIn("Get-ChildItem -LiteralPath $importDirectory -Recurse -File", build_script)
        self.assertIn("Remove-Item -LiteralPath $target -Recurse -Force", build_script)

    def test_webp_loader_matches_krkr_bitmap_channel_order(self) -> None:
        loader = (ROOT / "engine" / "webp" / "LoadWEBP.cpp").read_text(encoding="utf-8")

        self.assertIn("mode == glmNormalRGBA ? MODE_RGBA : MODE_BGRA", loader)
        self.assertNotIn("config.output.colorspace = MODE_RGBA;", loader)

    def test_textrender_dictionary_arguments_bypass_value_invoker(self) -> None:
        source = (
            ROOT / "engine" / "plugins" / "textrender" / "TextRender.cpp"
        ).read_text(encoding="utf-8")

        for method in ("setOption", "setDefault", "setFont", "setStyle"):
            self.assertIn(
                f"NCB_METHOD_RAW_CALLBACK({method}, &Class::{method}Raw, 0)",
                source,
            )
            self.assertNotIn(f"NCB_METHOD({method});", source)
        self.assertIn("class DictionaryView", source)
        self.assertIn("param[0]->AsObjectNoAddRef()", source)
        self.assertIn("_object->PropGet(", source)
        self.assertNotIn("ncbPropAccessor dict(dictVar);", source)
        self.assertNotIn("(bool)v", source)
        self.assertIn("v.operator bool()", source)

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
        self.assertIn("window.krkr2Player.start(game.gameId", product)
        self.assertIn("window.krkr2Player.restart(game.gameId", product)
        self.assertIn("window.krkr2Player.forceStop", product)
        self.assertNotIn('/play/?gameId=', product)
        self.assertIn('id="player-view"', page)
        self.assertIn('id="player-stop-button"', page)
        self.assertNotIn("serviceWorker", page)
        self.assertIn("storageBridge.prepare(gameId)", player)
        self.assertIn("wasmBinary: wasmBinary", player)
        self.assertIn("setInterval(syncSaves, 30000)", player)
        self.assertIn("forceTerminate", player)
        self.assertIn("this.options.gameId", downloader)

    def test_source_export_extractor_materializes_symlinks(self) -> None:
        import io
        import subprocess
        import sys
        import tarfile

        extractor = ROOT / "tools" / "extract_tar.py"
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "source.tar"
            with tarfile.open(archive, "w") as tf:
                payload = b"engine source"
                info = tarfile.TarInfo("src/main.cpp")
                info.size = len(payload)
                tf.addfile(info, io.BytesIO(payload))
                link = tarfile.TarInfo("android-project/gradle.properties")
                link.type = tarfile.SYMTYPE
                link.linkname = "../external/SDL/android-project/gradle.properties"
                tf.addfile(link)
            dest = Path(tmp) / "out"
            result = subprocess.run(
                [sys.executable, str(extractor), "--archive", str(archive), "--dest", str(dest)],
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertEqual((dest / "src" / "main.cpp").read_bytes(), payload)
            # Windows cannot create symlinks without privileges; the extractor
            # must keep going by writing the link target as plain text, the
            # same representation as a git core.symlinks=false checkout.
            self.assertEqual(
                (dest / "android-project" / "gradle.properties").read_text(encoding="ascii").strip(),
                "../external/SDL/android-project/gradle.properties",
            )
            self.assertIn("symlink-as-text: android-project/gradle.properties", result.stdout)

    def test_patch_applier_tolerates_blank_context_and_rejects_orphans(self) -> None:
        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "apply_patch", ROOT / "tools" / "apply_patch.py"
        )
        applier = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(applier)

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "src.cpp"
            target.write_text("void a() {}\n\nvoid b() {}\n", encoding="utf-8")
            # Empty context line written as a truly blank line (the exact
            # mistake that silently truncated engine patch 0040): the applier
            # must treat it as context, not as end-of-hunk.
            lenient = (
                "--- a/src.cpp\n"
                "+++ b/src.cpp\n"
                "@@ -1,3 +1,4 @@\n"
                " void a() {}\n"
                "\n"
                "+// inserted\n"
                " void b() {}\n"
            )
            files = applier.parse_patch(lenient)
            applier.apply_file(tmp, files[0][0], files[0][1], False)
            self.assertEqual(
                target.read_text(encoding="utf-8"),
                "void a() {}\n\n// inserted\nvoid b() {}\n",
            )
            # Patch content that appears after the hunk was terminated is a
            # malformed diff and must fail loudly instead of applying a
            # no-op replacement.
            orphan = (
                "--- a/src.cpp\n"
                "+++ b/src.cpp\n"
                "@@ -1,1 +1,1 @@\n"
                " void a() {}\n"
                "garbage that ends the hunk\n"
                "+// orphaned content\n"
            )
            with self.assertRaises(ValueError):
                applier.parse_patch(orphan)


if __name__ == "__main__":
    unittest.main()
