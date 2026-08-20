import importlib.util
import struct
import sys
import tempfile
import unittest
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("scan_xp3_compat", ROOT / "tools" / "scan_xp3_compat.py")
SCAN = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
sys.modules[SPEC.name] = SCAN
SPEC.loader.exec_module(SCAN)


def chunk(name: bytes, payload: bytes) -> bytes:
    return name + struct.pack("<Q", len(payload)) + payload


def make_archive(path: Path) -> None:
    script = b'Plugins.link("motionplayer.dll");\nSystem.inform("ready");\n'
    compressed = zlib.compress(script)
    data_position = 19
    info = struct.pack("<IQQH", 0, len(script), len(compressed), len("startup.tjs"))
    info += "startup.tjs".encode("utf-16le")
    segm = struct.pack("<IQQQ", 1, data_position, len(script), len(compressed))
    file_chunk = chunk(b"File", chunk(b"info", info) + chunk(b"segm", segm) + chunk(b"adlr", struct.pack("<I", 123)))
    packed_index = zlib.compress(file_chunk)
    first_index = data_position + len(compressed)
    second_pointer = first_index + 9
    second_index = second_pointer + 8
    header = SCAN.XP3_MARK + struct.pack("<Q", first_index)
    body = compressed
    continuation = bytes([SCAN.INDEX_CONTINUE | SCAN.INDEX_RAW]) + struct.pack("<Q", 0)
    pointer = struct.pack("<Q", second_index)
    final_index = bytes([SCAN.INDEX_ZLIB]) + struct.pack("<QQ", len(packed_index), len(file_chunk)) + packed_index
    path.write_bytes(header + body + continuation + pointer + final_index)


class D5ScanTests(unittest.TestCase):
    def test_senren_profile_disables_win32_debug_window(self) -> None:
        import json

        profile = json.loads(
            (ROOT / "engine" / "profiles" / "senren-banka-v1.json").read_text(encoding="utf-8")
        )
        self.assertIn("-debugwin=no", profile["engineArguments"])
        self.assertIn("-scanim=no", profile["engineArguments"])
        self.assertIn("-krkr2web-ui-language=zh-CN", profile["engineArguments"])

    def test_continued_index_and_compressed_script_are_scanned(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "data.xp3"
            make_archive(archive)
            entries, index = SCAN.read_index(archive)
            self.assertEqual(index["segments"], 2)
            self.assertEqual([entry.name for entry in entries], ["startup.tjs"])
            self.assertIn(b"motionplayer.dll", SCAN.read_entry(archive, entries[0]))
            report = SCAN.scan_archives([archive])
            self.assertEqual(report["scripts"]["decoded"], 1)
            self.assertEqual(report["schemaVersion"], 2)
            self.assertEqual(report["plugins"][0]["name"], "motionplayer.dll")
            self.assertEqual(report["plugins"][0]["packageEntries"], 0)
            self.assertEqual(report["plugins"][0]["linkCalls"], 1)
            self.assertEqual(report["plugins"][0]["mentions"], 1)
            self.assertEqual(report["plugins"][0]["bytecodeMentions"], 0)

    def test_tjs_bytecode_strings_are_mentions_not_link_calls(self) -> None:
        data = (
            SCAN.TJS_BYTECODE_MARK
            + b"\x00\x01motionplayer.dll\x00\xff"
            + "PSBFile.dll".encode("utf-16le")
            + b"\x00\x00"
        )
        strings = SCAN.extract_bytecode_strings(data)
        self.assertTrue(any("motionplayer.dll" in value for value in strings))
        self.assertTrue(any("PSBFile.dll" in value for value in strings))

    def test_non_bytecode_data_has_no_bytecode_strings(self) -> None:
        self.assertEqual(SCAN.extract_bytecode_strings(b"motionplayer.dll"), [])

    def test_out_of_bounds_segment_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "bad.xp3"
            make_archive(archive)
            data = bytearray(archive.read_bytes())
            index_position = struct.unpack_from("<Q", data, 11)[0]
            second_pointer = index_position + 9
            final_index = struct.unpack_from("<Q", data, second_pointer)[0]
            packed_size, expanded_size = struct.unpack_from("<QQ", data, final_index + 1)
            expanded = bytearray(zlib.decompress(data[final_index + 17:final_index + 17 + packed_size]))
            segment_start = expanded.index(b"segm") + 12 + 4
            struct.pack_into("<Q", expanded, segment_start, len(data) + 1)
            replacement = zlib.compress(expanded)
            struct.pack_into("<QQ", data, final_index + 1, len(replacement), expanded_size)
            data[final_index + 17:] = replacement
            archive.write_bytes(data)
            with self.assertRaisesRegex(SCAN.XP3Error, "outside the archive"):
                SCAN.read_index(archive)

    def test_declared_index_over_limit_is_rejected_before_allocation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "large-index.xp3"
            archive.write_bytes(
                SCAN.XP3_MARK
                + struct.pack("<Q", 19)
                + bytes([SCAN.INDEX_RAW])
                + struct.pack("<Q", SCAN.MAX_INDEX_BYTES + 1)
            )
            with self.assertRaisesRegex(SCAN.XP3Error, "safety limit"):
                SCAN.read_index(archive)


if __name__ == "__main__":
    unittest.main()
