"""Extract a git-archive tarball on Windows without symlink support.

GNU tar under Git Bash fails to create symlinks ("Cannot create symlink"),
and Windows bsdtar needs Developer Mode for them. The krkrsdl2 source export
tracks a handful of symlinks (all android-project scaffolding). Materialize
each symlink as a plain text file containing the link target -- the same
representation git uses for core.symlinks=false checkouts on Windows.
"""

import argparse
import os
import sys
import tarfile


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--dest", required=True)
    args = parser.parse_args()

    os.makedirs(args.dest, exist_ok=True)
    materialized = []
    with tarfile.open(args.archive, "r") as tf:
        for member in tf:
            # Repository automation is not part of the engine source and the
            # Windows sandbox reserves .github directories as metadata.
            if ".github" in member.name.replace("\\", "/").split("/"):
                continue
            if member.issym() or member.islnk():
                target = member.linkname
                out = os.path.join(args.dest, member.name)
                os.makedirs(os.path.dirname(out), exist_ok=True)
                with open(out, "w", encoding="ascii", newline="") as handle:
                    handle.write(target + "\n")
                materialized.append(member.name)
                continue
            tf.extract(member, args.dest, filter="tar")
    for name in materialized:
        print("symlink-as-text: " + name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
