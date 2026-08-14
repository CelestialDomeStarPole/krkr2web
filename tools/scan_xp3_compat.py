#!/usr/bin/env python3
"""Scan XP3 indexes and small script files without unpacking game assets."""

from __future__ import annotations

import argparse
import collections
import json
import re
import struct
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Iterable


XP3_MARK = b"XP3\r\n \n\x1a\x8bg\x01"
INDEX_METHOD_MASK = 0x07
INDEX_RAW = 0
INDEX_ZLIB = 1
INDEX_CONTINUE = 0x80
SEGMENT_METHOD_MASK = 0x07
SEGMENT_RAW = 0
SEGMENT_ZLIB = 1
MAX_INDEX_BYTES = 64 * 1024 * 1024
MAX_SCRIPT_BYTES = 4 * 1024 * 1024
MAX_TOTAL_SCRIPT_BYTES = 64 * 1024 * 1024

SCRIPT_EXTENSIONS = {".tjs", ".ks", ".asd", ".csv", ".ini"}
PLUGIN_RE = re.compile(
    r"(?:Plugins\s*\.\s*link|linkPlugin)\s*\(\s*[\"']([^\"']+)[\"']",
    re.IGNORECASE,
)
DLL_RE = re.compile(r"(?i)([a-z0-9_+.-]+\.dll)")
MEDIA_EXTENSIONS = {".wmv", ".mp4", ".avi", ".mpg", ".mpeg", ".webm"}
TJS_BYTECODE_MARK = b"TJS2100"
BYTECODE_ASCII_STRING_RE = re.compile(rb"[\x20-\x7e]{4,}")
BYTECODE_UTF16LE_STRING_RE = re.compile(rb"(?:[\x20-\x7e\x80-\xff]\x00){4,}")


class XP3Error(RuntimeError):
    pass


@dataclass(frozen=True)
class Segment:
    compressed: bool
    start: int
    original_size: int
    archived_size: int


@dataclass(frozen=True)
class Entry:
    name: str
    flags: int
    original_size: int
    archived_size: int
    file_hash: int
    segments: tuple[Segment, ...]


def _read_exact(stream: BinaryIO, size: int, label: str) -> bytes:
    data = stream.read(size)
    if len(data) != size:
        raise XP3Error(f"Unexpected end of file while reading {label}")
    return data


def _u16(data: bytes, offset: int) -> int:
    if offset + 2 > len(data):
        raise XP3Error("XP3 index contains a truncated uint16")
    return struct.unpack_from("<H", data, offset)[0]


def _u32(data: bytes, offset: int) -> int:
    if offset + 4 > len(data):
        raise XP3Error("XP3 index contains a truncated uint32")
    return struct.unpack_from("<I", data, offset)[0]


def _u64(data: bytes, offset: int) -> int:
    if offset + 8 > len(data):
        raise XP3Error("XP3 index contains a truncated uint64")
    return struct.unpack_from("<Q", data, offset)[0]


def _chunks(data: bytes) -> Iterable[tuple[bytes, bytes]]:
    offset = 0
    while offset < len(data):
        if offset + 12 > len(data):
            raise XP3Error("XP3 index contains a truncated chunk header")
        name = data[offset : offset + 4]
        size = _u64(data, offset + 4)
        start = offset + 12
        end = start + size
        if end > len(data):
            raise XP3Error(f"XP3 chunk {name!r} extends beyond its index")
        yield name, data[start:end]
        offset = end


def _parse_file_chunk(payload: bytes, archive_size: int) -> Entry:
    subchunks: dict[bytes, bytes] = {}
    for name, data in _chunks(payload):
        subchunks[name] = data
    for required in (b"info", b"segm", b"adlr"):
        if required not in subchunks:
            raise XP3Error(f"XP3 File chunk is missing {required.decode('ascii')}")

    info = subchunks[b"info"]
    if len(info) < 22:
        raise XP3Error("XP3 info chunk is truncated")
    name_length = _u16(info, 20)
    name_end = 22 + name_length * 2
    if name_end > len(info):
        raise XP3Error("XP3 filename extends beyond its info chunk")
    name = info[22:name_end].decode("utf-16le")

    segment_data = subchunks[b"segm"]
    if len(segment_data) % 28:
        raise XP3Error(f"XP3 segment table for {name!r} has an invalid size")
    segments: list[Segment] = []
    for offset in range(0, len(segment_data), 28):
        flags = _u32(segment_data, offset)
        method = flags & SEGMENT_METHOD_MASK
        if method not in (SEGMENT_RAW, SEGMENT_ZLIB):
            raise XP3Error(f"XP3 entry {name!r} uses unknown segment method {method}")
        start = _u64(segment_data, offset + 4)
        original_size = _u64(segment_data, offset + 12)
        archived_size = _u64(segment_data, offset + 20)
        if start > archive_size or archived_size > archive_size - start:
            raise XP3Error(f"XP3 entry {name!r} points outside the archive")
        segments.append(Segment(method == SEGMENT_ZLIB, start, original_size, archived_size))

    return Entry(
        name=name.replace("\\", "/"),
        flags=_u32(info, 0),
        original_size=_u64(info, 4),
        archived_size=_u64(info, 12),
        file_hash=_u32(subchunks[b"adlr"], 0),
        segments=tuple(segments),
    )


def read_index(path: Path, max_index_bytes: int = MAX_INDEX_BYTES) -> tuple[list[Entry], dict]:
    archive_size = path.stat().st_size
    entries: list[Entry] = []
    index_segments = 0
    compressed_index_bytes = 0
    expanded_index_bytes = 0
    with path.open("rb") as stream:
        if _read_exact(stream, len(XP3_MARK), "XP3 signature") != XP3_MARK:
            raise XP3Error(f"{path.name} does not start with an XP3 signature")
        pointer_position = len(XP3_MARK)
        while True:
            if pointer_position + 8 > archive_size:
                raise XP3Error("XP3 index pointer is outside the archive")
            stream.seek(pointer_position)
            index_position = struct.unpack("<Q", _read_exact(stream, 8, "index pointer"))[0]
            if index_position >= archive_size:
                raise XP3Error("XP3 index is outside the archive")
            stream.seek(index_position)
            flags = _read_exact(stream, 1, "index flags")[0]
            method = flags & INDEX_METHOD_MASK
            if method == INDEX_ZLIB:
                archived_size, original_size = struct.unpack(
                    "<QQ", _read_exact(stream, 16, "compressed index sizes")
                )
            elif method == INDEX_RAW:
                original_size = struct.unpack("<Q", _read_exact(stream, 8, "index size"))[0]
                archived_size = original_size
            else:
                raise XP3Error(f"XP3 index uses unknown method {method}")
            if original_size > max_index_bytes or archived_size > max_index_bytes:
                raise XP3Error(
                    f"XP3 index exceeds the {max_index_bytes}-byte safety limit"
                )
            payload_position = stream.tell()
            if archived_size > archive_size - payload_position:
                raise XP3Error("XP3 index payload extends beyond the archive")
            archived = _read_exact(stream, archived_size, "index payload")
            try:
                index_data = zlib.decompress(archived) if method == INDEX_ZLIB else archived
            except zlib.error as error:
                raise XP3Error(f"Cannot decompress XP3 index: {error}") from error
            if len(index_data) != original_size:
                raise XP3Error("XP3 index expanded to an unexpected size")
            for chunk_name, chunk_data in _chunks(index_data):
                if chunk_name == b"File":
                    entries.append(_parse_file_chunk(chunk_data, archive_size))
            index_segments += 1
            compressed_index_bytes += archived_size
            expanded_index_bytes += original_size
            if not flags & INDEX_CONTINUE:
                break
            pointer_position = payload_position + archived_size

    return entries, {
        "segments": index_segments,
        "archivedBytes": compressed_index_bytes,
        "expandedBytes": expanded_index_bytes,
    }


def read_entry(path: Path, entry: Entry, limit: int = MAX_SCRIPT_BYTES) -> bytes:
    if entry.original_size > limit:
        raise XP3Error(f"Refusing to read {entry.name!r}: it exceeds the {limit}-byte limit")
    output = bytearray()
    with path.open("rb") as stream:
        for segment in entry.segments:
            stream.seek(segment.start)
            archived = _read_exact(stream, segment.archived_size, entry.name)
            try:
                data = zlib.decompress(archived) if segment.compressed else archived
            except zlib.error as error:
                raise XP3Error(f"Cannot decompress {entry.name!r}: {error}") from error
            if len(data) != segment.original_size:
                raise XP3Error(f"XP3 segment for {entry.name!r} expanded to an unexpected size")
            output.extend(data)
            if len(output) > limit:
                raise XP3Error(f"Refusing to read {entry.name!r}: expanded data exceeds the limit")
    if len(output) != entry.original_size:
        raise XP3Error(f"XP3 entry {entry.name!r} has inconsistent segment sizes")
    return bytes(output)


def decode_script(data: bytes) -> tuple[str | None, str | None]:
    candidates: list[tuple[str, bytes]] = []
    if data.startswith(b"\xff\xfe"):
        candidates.append(("utf-16le", data[2:]))
    elif data.startswith(b"\xef\xbb\xbf"):
        candidates.append(("utf-8", data[3:]))
    else:
        candidates.extend((("utf-8", data), ("cp932", data), ("utf-16le", data)))
    for encoding, body in candidates:
        try:
            text = body.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
        if not text:
            return text, encoding
        printable = sum(character.isprintable() or character in "\r\n\t" for character in text)
        if printable / len(text) >= 0.85:
            return text, encoding
    return None, None


def extract_bytecode_strings(data: bytes) -> list[str]:
    """Extract conservative string candidates without interpreting TJS bytecode."""
    if not data.startswith(TJS_BYTECODE_MARK):
        return []
    strings: list[str] = []
    seen: set[str] = set()
    for match in BYTECODE_ASCII_STRING_RE.finditer(data):
        value = match.group().decode("ascii")
        if value not in seen:
            seen.add(value)
            strings.append(value)
    for match in BYTECODE_UTF16LE_STRING_RE.finditer(data):
        try:
            value = match.group().decode("utf-16le")
        except UnicodeDecodeError:
            continue
        if value not in seen:
            seen.add(value)
            strings.append(value)
    return strings


def scan_archives(paths: list[Path]) -> dict:
    archive_reports = []
    extension_counts: collections.Counter[str] = collections.Counter()
    plugin_package_entries: collections.Counter[str] = collections.Counter()
    plugin_link_calls: collections.Counter[str] = collections.Counter()
    plugin_mentions: collections.Counter[str] = collections.Counter()
    plugin_bytecode_mentions: collections.Counter[str] = collections.Counter()
    plugin_evidence: dict[str, set[str]] = collections.defaultdict(set)
    scripts_scanned = 0
    scripts_decoded = 0
    scripts_bytecode = 0
    script_bytes = 0
    script_errors = []
    startup_candidates = []
    media_files = []
    largest_entries: list[tuple[int, str, str]] = []

    for path in paths:
        entries, index_report = read_index(path)
        archive_extension_counts: collections.Counter[str] = collections.Counter()
        protected = 0
        for entry in entries:
            suffix = Path(entry.name).suffix.lower() or "(none)"
            extension_counts[suffix] += 1
            archive_extension_counts[suffix] += 1
            protected += int(bool(entry.flags & 0x80000000))
            largest_entries.append((entry.original_size, path.name, entry.name))
            lowered = entry.name.lower()
            if lowered.endswith("startup.tjs") or lowered.endswith("initialize.tjs"):
                startup_candidates.append({"archive": path.name, "path": entry.name})
            if suffix == ".dll":
                plugin = Path(entry.name).name.lower()
                plugin_package_entries[plugin] += 1
                plugin_evidence[plugin].add(f"entry:{path.name}:{entry.name}")
            if suffix in MEDIA_EXTENSIONS:
                media_files.append(
                    {"archive": path.name, "path": entry.name, "size": entry.original_size}
                )
            if suffix not in SCRIPT_EXTENSIONS or entry.original_size > MAX_SCRIPT_BYTES:
                continue
            if script_bytes + entry.original_size > MAX_TOTAL_SCRIPT_BYTES:
                continue
            scripts_scanned += 1
            script_bytes += entry.original_size
            try:
                raw = read_entry(path, entry)
                if raw.startswith(TJS_BYTECODE_MARK):
                    scripts_bytecode += 1
                    for value in extract_bytecode_strings(raw):
                        for match in DLL_RE.finditer(value):
                            plugin = match.group(1).lower()
                            plugin_bytecode_mentions[plugin] += 1
                            plugin_evidence[plugin].add(
                                f"bytecode-mention:{path.name}:{entry.name}"
                            )
                    continue
                text, encoding = decode_script(raw)
                if text is None:
                    script_errors.append(
                        {"archive": path.name, "path": entry.name, "error": "not-decodable"}
                    )
                    continue
                scripts_decoded += 1
                for match in PLUGIN_RE.finditer(text):
                    plugin = Path(match.group(1).replace("\\", "/")).name.lower()
                    plugin_link_calls[plugin] += 1
                    plugin_evidence[plugin].add(f"link:{path.name}:{entry.name}")
                for match in DLL_RE.finditer(text):
                    plugin = match.group(1).lower()
                    plugin_mentions[plugin] += 1
                    plugin_evidence[plugin].add(f"mention:{path.name}:{entry.name}")
            except XP3Error as error:
                script_errors.append(
                    {"archive": path.name, "path": entry.name, "error": str(error)}
                )
        archive_reports.append(
            {
                "name": path.name,
                "size": path.stat().st_size,
                "entries": len(entries),
                "protectedEntries": protected,
                "index": index_report,
                "extensions": dict(sorted(archive_extension_counts.items())),
            }
        )

    largest_entries.sort(reverse=True)
    return {
        "schemaVersion": 2,
        "archives": archive_reports,
        "totalBytes": sum(path.stat().st_size for path in paths),
        "totalEntries": sum(report["entries"] for report in archive_reports),
        "extensions": dict(sorted(extension_counts.items())),
        "startupCandidates": startup_candidates,
        "plugins": [
            {
                "name": name,
                "packageEntries": plugin_package_entries[name],
                "linkCalls": plugin_link_calls[name],
                "mentions": plugin_mentions[name],
                "bytecodeMentions": plugin_bytecode_mentions[name],
                "evidence": sorted(plugin_evidence[name]),
            }
            for name in sorted(
                set(plugin_package_entries)
                | set(plugin_link_calls)
                | set(plugin_mentions)
                | set(plugin_bytecode_mentions)
            )
        ],
        "media": {
            "count": len(media_files),
            "totalBytes": sum(item["size"] for item in media_files),
            "files": media_files,
        },
        "scripts": {
            "scanned": scripts_scanned,
            "decoded": scripts_decoded,
            "bytecode": scripts_bytecode,
            "bytesRead": script_bytes,
            "errors": script_errors,
        },
        "largestEntries": [
            {"archive": archive, "path": name, "size": size}
            for size, archive, name in largest_entries[:25]
        ],
        "limits": {
            "maxIndexBytes": MAX_INDEX_BYTES,
            "maxScriptBytes": MAX_SCRIPT_BYTES,
            "maxTotalScriptBytes": MAX_TOTAL_SCRIPT_BYTES,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archives", nargs="+", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    for path in args.archives:
        if not path.is_file():
            parser.error(f"XP3 archive does not exist: {path}")
    report = scan_archives(args.archives)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(
        f"Scanned {report['totalEntries']} entries from {len(args.archives)} archives; "
        f"read {report['scripts']['bytesRead']} script bytes"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
