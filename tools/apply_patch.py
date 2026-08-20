#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""krkr2web: unified-diff patch applier.

Replaces 'git apply' in the D3 build pipeline because git.exe runs in a
different file view inside the DSH sandbox (it reads/writes content that
other processes never see).  Python sees the same bytes as PowerShell and
the host tools, so patch application happens here instead.

Usage:
    python tools/apply_patch.py --dir <dir> [--check] patch1 [patch2 ...]

The patch paths are relative to --dir; the standard a/ b/ prefixes are
stripped (git-style -p1).  Context matching is line-based and exact (CRLF
is ignored for matching); hunks may appear at a different offset than the
@@ header claims, in which case the first exact match wins.
"""
import argparse
import os
import sys

BACKSLASH = chr(92)
CR = chr(13)
LF = chr(10)


class Hunk(object):
    __slots__ = ("old_start", "old_count", "new_start", "new_count", "old", "new")

    def __init__(self, old_start, old_count, new_start, new_count):
        self.old_start = old_start
        self.old_count = old_count
        self.new_start = new_start
        self.new_count = new_count
        self.old = []
        self.new = []


def parse_hunk_header(line):
    # "@@ -old[,cnt] +new[,cnt] @@"
    head = line[3:].split("@@", 1)[0].strip()
    parts = head.split()
    if len(parts) < 2:
        raise ValueError("bad hunk header: %r" % line)

    def parse_range(s):
        if "," in s:
            a, b = s.split(",", 1)
            return int(a), int(b)
        return int(s), 1

    old_start, old_count = parse_range(parts[0][1:])
    new_start, new_count = parse_range(parts[1][1:])
    return Hunk(old_start, old_count, new_start, new_count)


def strip_prefix(path):
    """Strip a/ b/ prefixes from a diff --git path."""
    if len(path) > 2 and path[1] == "/" and path[0] in "ab":
        return path[2:]
    return path


def parse_patch(text):
    """Parse a unified diff into [(path, [Hunk])]."""
    files = []
    current = None
    hunk = None
    lines = text.split(LF)
    if lines and lines[-1] == "":
        lines.pop()
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("diff --git "):
            rest = line[len("diff --git "):]
            bpart = rest.split(" b/", 1)
            path = strip_prefix(bpart[1] if len(bpart) > 1 else bpart[0])
            current = (path, [])
            files.append(current)
            hunk = None
        elif line.startswith("--- ") and len(line) > 4:
            # patch without a "diff --git" header (e.g. 0016)
            rest = line[4:]
            if rest.startswith("/dev/null"):
                current = None
                hunk = None
            else:
                path = strip_prefix(rest)
                if current is None or current[0] != path:
                    current = (path, [])
                    files.append(current)
                    hunk = None
        elif line.startswith("@@") and current is not None:
            hunk = parse_hunk_header(line)
            current[1].append(hunk)
        elif hunk is not None:
            if line.startswith(" "):
                hunk.old.append(line[1:])
                hunk.new.append(line[1:])
            elif line.startswith("+") and not line.startswith("+++"):
                hunk.new.append(line[1:])
            elif line.startswith("-") and not line.startswith("---"):
                hunk.old.append(line[1:])
            elif line.startswith(BACKSLASH):
                # ignore "\ No newline at end of file" (never used by us)
                pass
            else:
                nxt = lines[i + 1] if i + 1 < len(lines) else ""
                if line == "" and (
                    nxt[:1] in ("+", "-", " ") or nxt.startswith(BACKSLASH)
                ):
                    # git-style tolerance: a truly blank line followed by more
                    # hunk content is an empty context line
                    hunk.old.append("")
                    hunk.new.append("")
                else:
                    # end of hunk (blank separator between hunks or EOF)
                    hunk = None
        elif line[:1] in ("+", "-", " ") and not (
            line.startswith("--- ") or line.startswith("+++ ")
        ):
            # krkr2web: patch content outside a hunk means the diff is
            # malformed and the hunk above was silently truncated. Fail
            # loudly instead of claiming success with a no-op replacement.
            raise ValueError("patch content outside hunk: %r" % line)
        i += 1
    return files


import re as _re


def _ws_key(lines):
    """git --ignore-space-change style key: collapse whitespace runs."""
    return [_re.sub(r"[ \t]+", " ", s).strip() for s in lines]


def find_match(norm, needle, hint):
    """Find needle in norm starting at hint; fall back to full scan."""
    if hint is not None and 0 <= hint <= len(norm) - len(needle):
        if norm[hint:hint + len(needle)] == needle:
            return hint
    for idx in range(len(norm) - len(needle) + 1):
        if norm[idx:idx + len(needle)] == needle:
            return idx
    # whitespace-insensitive fallback (git apply --ignore-space-change)
    key = _ws_key(needle)
    for idx in range(len(norm) - len(needle) + 1):
        if _ws_key(norm[idx:idx + len(needle)]) == key:
            return idx
    return None


def apply_file(base_dir, path, hunks, check_only):
    target = os.path.join(base_dir, path.replace("/", os.sep))
    if not os.path.isfile(target):
        raise RuntimeError("patch target not found: %s" % path)
    with open(target, "rb") as fh:
        raw = fh.read()
    text = raw.decode("latin-1")
    eol = CR + LF if CR + LF in text else LF
    lines = raw.split(LF.encode("latin-1"))
    if lines and lines[-1] == b"":
        lines.pop()
    # strip trailing CR (CRLF files) so join(eol) never doubles the CR
    cr = CR.encode("latin-1")
    lines = [ln[:-1] if ln.endswith(cr) else ln for ln in lines]
    norm = [ln.decode("utf-8", errors="surrogateescape") for ln in lines]

    patch_lines = []
    for h in hunks:
        old = [s.rstrip(CR) for s in h.old]
        new = [s.rstrip(CR) for s in h.new]
        pos = find_match(norm, old, h.old_start - 1)
        if pos is None:
            raise RuntimeError(
                "%s: hunk @@ -%d,%d +%d,%d @@ did not match" % (
                    path, h.old_start, h.old_count, h.new_start, h.new_count))
        patch_lines.append((pos, pos + len(old), new))

    if check_only:
        return "ok"

    # rebuild (apply from the end so earlier offsets stay valid)
    # NOTE: block elements must NOT carry eol -- join() adds it, otherwise
    # every patched line would be followed by a blank line.
    for pos, end, new in sorted(patch_lines, reverse=True):
        keep = lines[:pos] + lines[end:]
        block = [s.encode("utf-8", errors="surrogateescape") for s in new]
        lines = keep[:pos] + block + keep[pos:]

    out = eol.encode("latin-1").join(lines)
    if raw.endswith(LF.encode("latin-1")):
        out += LF.encode("latin-1")
    with open(target, "wb") as fh:
        fh.write(out)
    return "applied"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("patches", nargs="+")
    args = ap.parse_args()

    status = 0
    for patch_path in args.patches:
        try:
            with open(patch_path, "r", encoding="utf-8") as fh:
                text = fh.read()
            files = parse_patch(text)
            if not files:
                raise RuntimeError("no files in patch: %s" % patch_path)
            for path, hunks in files:
                result = apply_file(args.dir, path, hunks, args.check)
                verb = "check" if args.check else "apply"
                print("%s: %s (%s)" % (patch_path, verb, result))
        except Exception as exc:  # noqa: BLE001
            print("error: %s: %s" % (patch_path, exc), file=sys.stderr)
            status = 1
    sys.exit(status)


if __name__ == "__main__":
    main()
