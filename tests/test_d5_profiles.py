import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "generate_engine_profiles", ROOT / "tools" / "generate_engine_profiles.py"
)
PROFILES = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
sys.modules[SPEC.name] = PROFILES
SPEC.loader.exec_module(PROFILES)


class D5ProfileTests(unittest.TestCase):
    def test_repository_profiles_validate_and_emit_registry(self) -> None:
        profiles = PROFILES.load_profiles(ROOT / "engine" / "profiles")
        self.assertEqual(set(profiles), {"d3-minimal", "senren-banka-v1"})
        senren = profiles["senren-banka-v1"]
        self.assertEqual(senren["requiredPackages"], ["data.xp3", "adult.xp3", "video.xp3"])
        self.assertEqual(senren["plugins"]["motionplayer.dll"], "native-lazy-psb")
        self.assertEqual(senren["plugins"]["wuvorbis.dll"], "built-in-streaming")
        self.assertIn("-scanim=no", senren["engineArguments"])
        self.assertIn("-krkr2web-ui-language=zh-CN", senren["engineArguments"])
        self.assertFalse(any(
            argument.startswith("-krkr2web-motion-bootstrap")
            for argument in senren["engineArguments"]
        ))
        self.assertFalse(senren["runtimeCompatibility"]["directKagScenario"])
        registry = PROFILES.emit_registry(profiles)
        self.assertIn("window.krkr2EngineProfiles", registry)
        self.assertIn("senren-banka-v1", registry)

    def test_auto_path_must_be_required(self) -> None:
        source = json.loads((ROOT / "engine" / "profiles" / "d3-minimal.json").read_text())
        source["id"] = "bad-profile"
        source["autoPathPackages"] = ["missing.xp3"]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad-profile.json"
            with self.assertRaisesRegex(ValueError, "auto path must be required"):
                PROFILES.validate_profile(source, path)

    def test_indexed_db_cache_chunks_are_profile_tunable_within_memory_gate(self) -> None:
        source = json.loads((ROOT / "engine" / "profiles" / "d3-minimal.json").read_text())
        source["id"] = "cache-profile"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cache-profile.json"
            for chunks in (4, 16):
                source["runtime"]["indexedDbCacheChunks"] = chunks
                self.assertEqual(PROFILES.validate_profile(source, path)["runtime"]["indexedDbCacheChunks"], chunks)
            for chunks in (3, 17, True):
                source["runtime"]["indexedDbCacheChunks"] = chunks
                with self.assertRaisesRegex(ValueError, "indexedDbCacheChunks must be 4..16"):
                    PROFILES.validate_profile(source, path)


if __name__ == "__main__":
    unittest.main()
