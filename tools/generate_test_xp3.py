#!/usr/bin/env python3
"""Create and inspect a small, uncompressed KRKR2 XP3 archive."""

from __future__ import annotations

import argparse
import json
import math
import struct
import zlib
from pathlib import Path


XP3_MARK = b"XP3\r\n \n\x1a\x8b\x67\x01"


def make_probe_bmp(width: int = 960, height: int = 540) -> bytes:
    """Create a deterministic 24-bit BMP without third-party dependencies."""
    row_size = (width * 3 + 3) & ~3
    pixels = bytearray(row_size * height)
    for output_y in range(height):
        y = height - 1 - output_y
        for x in range(width):
            if y < 76:
                color = (225, 184, 77)
            elif 56 <= x < 344 and 126 <= y < 414:
                color = (43, 178, 125)
            elif 364 <= x < 652 and 126 <= y < 414:
                color = (221, 83, 91)
            elif 672 <= x < 904 and 126 <= y < 414:
                color = (75, 137, 224)
            else:
                color = (19, 39, 56)
            offset = output_y * row_size + x * 3
            pixels[offset : offset + 3] = bytes((color[2], color[1], color[0]))
    pixel_offset = 14 + 40
    file_size = pixel_offset + len(pixels)
    header = struct.pack("<2sIHHI", b"BM", file_size, 0, 0, pixel_offset)
    dib = struct.pack("<IiiHHIIiiII", 40, width, height, 1, 24, 0, len(pixels), 2835, 2835, 0, 0)
    return header + dib + pixels


def make_probe_wav(sample_rate: int = 22050, duration_ms: int = 360) -> bytes:
    """Create a short, quiet two-note PCM WAV suitable for an input gesture."""
    sample_count = sample_rate * duration_ms // 1000
    pcm = bytearray()
    for index in range(sample_count):
        frequency = 523.25 if index < sample_count // 2 else 659.25
        envelope = min(1.0, index / 220.0, (sample_count - index) / 440.0)
        value = int(7000 * envelope * math.sin(2.0 * math.pi * frequency * index / sample_rate))
        pcm.extend(struct.pack("<h", value))
    byte_rate = sample_rate * 2
    fmt = struct.pack("<HHIIHH", 1, 1, sample_rate, byte_rate, 2, 16)
    return b"RIFF" + struct.pack("<I", 4 + 8 + len(fmt) + 8 + len(pcm)) + b"WAVEfmt " + struct.pack("<I", len(fmt)) + fmt + b"data" + struct.pack("<I", len(pcm)) + pcm


def chunk(name: bytes, payload: bytes) -> bytes:
    return name + struct.pack("<Q", len(payload)) + payload


def make_archive(files: dict[str, bytes]) -> bytes:
    header_size = len(XP3_MARK) + 8
    data = bytearray()
    records = bytearray()
    offset = header_size
    for name in sorted(files):
        content = files[name]
        encoded_name = name.replace("\\", "/").encode("utf-16le")
        info = struct.pack("<IQQH", 0, len(content), len(content), len(encoded_name) // 2) + encoded_name
        segment = struct.pack("<IQQQ", 0, offset, len(content), len(content))
        checksum = struct.pack("<I", zlib.adler32(content) & 0xFFFFFFFF)
        records.extend(chunk(b"File", chunk(b"info", info) + chunk(b"segm", segment) + chunk(b"adlr", checksum)))
        data.extend(content)
        offset += len(content)
    return XP3_MARK + struct.pack("<Q", offset) + data + b"\x00" + struct.pack("<Q", len(records)) + records


def read_archive(archive: bytes) -> dict[str, bytes]:
    if archive[: len(XP3_MARK)] != XP3_MARK:
        raise ValueError("invalid XP3 marker")
    index_offset = struct.unpack_from("<Q", archive, len(XP3_MARK))[0]
    if archive[index_offset] != 0:
        raise ValueError("test XP3 index is not raw")
    index_size = struct.unpack_from("<Q", archive, index_offset + 1)[0]
    index = archive[index_offset + 9 : index_offset + 9 + index_size]
    result: dict[str, bytes] = {}
    position = 0
    while position < len(index):
        if index[position : position + 4] != b"File":
            raise ValueError("missing File chunk")
        file_size = struct.unpack_from("<Q", index, position + 4)[0]
        payload = index[position + 12 : position + 12 + file_size]
        subchunks: dict[bytes, bytes] = {}
        subpos = 0
        while subpos < len(payload):
            name = payload[subpos : subpos + 4]
            size = struct.unpack_from("<Q", payload, subpos + 4)[0]
            subchunks[name] = payload[subpos + 12 : subpos + 12 + size]
            subpos += 12 + size
        info = subchunks[b"info"]
        name_length = struct.unpack_from("<H", info, 20)[0]
        name = info[22 : 22 + name_length * 2].decode("utf-16le")
        segment = subchunks[b"segm"]
        flags, offset, original_size, archived_size = struct.unpack("<IQQQ", segment)
        if flags != 0 or original_size != archived_size:
            raise ValueError("compressed test XP3 entries are unsupported")
        content = archive[offset : offset + archived_size]
        checksum = struct.unpack("<I", subchunks[b"adlr"])[0]
        if zlib.adler32(content) & 0xFFFFFFFF != checksum:
            raise ValueError(f"checksum failed for {name}")
        result[name] = content
        position += 12 + file_size
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--startup", type=Path)
    parser.add_argument(
        "--file",
        action="append",
        default=[],
        metavar="ARCHIVE_NAME=PATH",
        help="add a file to the archive; may be specified more than once",
    )
    parser.add_argument("--with-probe-media", action="store_true")
    parser.add_argument("--inspect", type=Path)
    args = parser.parse_args()
    if args.inspect:
        files = read_archive(args.inspect.read_bytes())
        print(json.dumps({name: len(data) for name, data in files.items()}, indent=2))
        return
    if not args.output:
        parser.error("--output is required unless --inspect is used")
    startup = args.startup.read_bytes() if args.startup else (
        b'{\n Debug.message("KRKR2WEB_D3_TJS_OK");\n}\n'
    )
    files = {"startup.tjs": startup}
    for item in args.file:
        if "=" not in item:
            parser.error("--file must use ARCHIVE_NAME=PATH")
        archive_name, source_name = item.split("=", 1)
        if not archive_name or archive_name in files:
            parser.error(f"invalid or duplicate archive name: {archive_name}")
        files[archive_name] = Path(source_name).read_bytes()
    if args.with_probe_media:
        files["probe.bmp"] = make_probe_bmp()
        files["tone.wav"] = make_probe_wav()
    archive = make_archive(files)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(archive)
    print(f"Generated {args.output}: {len(archive)} bytes")


if __name__ == "__main__":
    main()
