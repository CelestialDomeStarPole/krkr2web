#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Transcode KRKR game videos to browser-friendly H.264/AAC MP4 files.

The engine's VideoOverlay has no in-wasm decoder (win32 needs DirectShow via
krmovie). The web build plays pre-transcoded copies from
/videos/<game-id>/<stem>.mp4 (see https_diagnostics_server.py --video-directory
and the player DOM overlay). H.264 is used intentionally: the target Android
WebView can hardware-decode it, while VP8 both consumed substantially more CPU
and lost the source BT.709 matrix. Existing outputs newer than the archive are
skipped.
"""
import argparse
import importlib.util
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("scan_xp3_compat", ROOT / "tools" / "scan_xp3_compat.py")
SCAN = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules["scan_xp3_compat"] = SCAN  # dataclasses resolution needs the module registered
SPEC.loader.exec_module(SCAN)

VIDEO_EXTENSIONS = {".wmv", ".avi", ".mpg", ".mpeg", ".m2v", ".mp4", ".webm", ".ogv", ".mov"}


def transcode_archive(
    archive: Path,
    output_dir: Path,
    ffmpeg: str,
    force: bool,
    selected_stems: set[str] | None = None,
) -> tuple[int, int, int]:
    converted = skipped = failed = 0
    entries, _ = SCAN.read_index(archive)
    videos = [e for e in entries if Path(e.name).suffix.lower() in VIDEO_EXTENSIONS]
    for entry in videos:
        stem = Path(entry.name).stem
        if selected_stems is not None and stem.casefold() not in selected_stems:
            continue
        if not stem or not all(c.isascii() and (c.isalnum() or c in "_().-") for c in stem):
            print(f"  skip (unsafe name): {entry.name}")
            failed += 1
            continue
        target = output_dir / f"{stem}.mp4"
        if target.exists() and not force and target.stat().st_mtime >= archive.stat().st_mtime:
            skipped += 1
            continue
        with tempfile.NamedTemporaryFile(suffix=Path(entry.name).suffix, delete=False) as temp:
            temp_path = Path(temp.name)
        try:
            temp_path.write_bytes(SCAN.read_entry(archive, entry, limit=entry.original_size))
            output_dir.mkdir(parents=True, exist_ok=True)
            result = subprocess.run(
                [
                    ffmpeg, "-nostdin", "-y", "-loglevel", "error",
                    "-i", str(temp_path),
                    "-map", "0:v:0", "-map", "0:a:0?",
                    "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
                    "-profile:v", "high", "-level:v", "4.1",
                    "-color_range", "tv", "-colorspace", "bt709",
                    "-color_primaries", "bt709", "-color_trc", "bt709",
                    "-x264-params",
                    "colorprim=bt709:transfer=bt709:colormatrix=bt709:range=limited",
                    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
                    str(target),
                ],
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                print(f"  FAIL {entry.name}: {result.stderr.strip()[:200]}")
                target.unlink(missing_ok=True)
                failed += 1
            else:
                size_mb = target.stat().st_size / 1048576
                print(f"  ok {entry.name} -> {target.name} ({size_mb:.1f} MB)")
                converted += 1
        finally:
            temp_path.unlink(missing_ok=True)
    return converted, skipped, failed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-id", required=True)
    parser.add_argument("--xp3", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--force", action="store_true")
    parser.add_argument(
        "--stem",
        action="append",
        default=[],
        help="only transcode this exact filename stem (repeatable)",
    )
    args = parser.parse_args()

    output = args.output or (ROOT / "build" / "video-transcode" / args.game_id)
    output.mkdir(parents=True, exist_ok=True)
    total = [0, 0, 0]
    for archive in args.xp3:
        archive = archive.resolve()
        if not archive.is_file():
            raise SystemExit(f"archive not found: {archive}")
        print(f"archive: {archive.name}")
        selected_stems = {stem.casefold() for stem in args.stem} or None
        stats = transcode_archive(
            archive, output, args.ffmpeg, args.force, selected_stems
        )
        for i in range(3):
            total[i] += stats[i]
    converted, skipped, failed = total
    print(f"{args.game_id}: converted={converted} skipped={skipped} failed={failed} -> {output}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
