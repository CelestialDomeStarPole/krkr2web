#!/usr/bin/env python3
"""Validate the no-SAB Dedicated Worker build contract."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


def validate_contract(
    contract: dict[str, Any], build_text: str, glue_text: str | None = None
) -> list[str]:
    failures: list[str] = []

    for flag in contract["requiredBuildFlags"]:
        if flag not in build_text:
            failures.append(f"build plan is missing required flag: {flag}")

    for pattern in contract["forbiddenBuildPatterns"]:
        if re.search(pattern, build_text):
            failures.append(f"build plan contains forbidden pattern: {pattern}")

    if glue_text is not None:
        for token in contract["requiredGlueTokens"]:
            if token not in glue_text:
                failures.append(f"JavaScript glue is missing required token: {token}")
        for token in contract["forbiddenGlueTokens"]:
            if token in glue_text:
                failures.append(f"JavaScript glue contains forbidden token: {token}")

    return failures


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contract", type=Path, required=True)
    parser.add_argument("--build-plan", type=Path, required=True)
    parser.add_argument("--glue", type=Path)
    args = parser.parse_args()

    contract = json.loads(args.contract.read_text(encoding="utf-8"))
    build_text = args.build_plan.read_text(encoding="utf-8")
    glue_text = args.glue.read_text(encoding="utf-8") if args.glue else None
    failures = validate_contract(contract, build_text, glue_text)
    if failures:
        raise SystemExit("\n".join(failures))

    target = contract["target"]
    print(
        "Worker contract valid: Chromium "
        f"{target['minimumMajorVersion']}+, no pthreads, SAB, JSPI, Wasm EH or SIMD."
    )


if __name__ == "__main__":
    main()
