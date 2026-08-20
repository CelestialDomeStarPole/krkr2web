from __future__ import annotations

import importlib.util
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "check_worker_contract", ROOT / "tools" / "check_worker_contract.py"
)
CHECKER = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(CHECKER)


class WorkerContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.contract = json.loads(
            (ROOT / "engine" / "worker-runtime-contract.json").read_text(
                encoding="utf-8"
            )
        )

    def test_worker_build_passes_without_shared_memory(self) -> None:
        build = " ".join(self.contract["requiredBuildFlags"])
        glue = "ENVIRONMENT_IS_WORKER OffscreenCanvas Asyncify"
        self.assertEqual(CHECKER.validate_contract(self.contract, build, glue), [])

    def test_old_pthread_build_is_rejected(self) -> None:
        build = " ".join(self.contract["requiredBuildFlags"]) + (
            " -pthread -sUSE_PTHREADS=1 -sPROXY_TO_PTHREAD=1"
        )
        failures = CHECKER.validate_contract(self.contract, build)
        self.assertTrue(any("-pthread" in failure for failure in failures))
        self.assertTrue(any("USE_PTHREADS" in failure for failure in failures))
        self.assertTrue(any("PROXY_TO_PTHREAD" in failure for failure in failures))

    def test_chromium_89_incompatible_features_are_rejected(self) -> None:
        build = " ".join(self.contract["requiredBuildFlags"]) + (
            " -sJSPI=1 -fwasm-exceptions -msimd128"
        )
        glue = (
            "ENVIRONMENT_IS_WORKER OffscreenCanvas Asyncify "
            "SharedArrayBuffer WebAssembly.Suspending"
        )
        failures = CHECKER.validate_contract(self.contract, build, glue)
        for token in ("JSPI", "fwasm-exceptions", "msimd128", "SharedArrayBuffer"):
            self.assertTrue(any(token in failure for failure in failures), token)


if __name__ == "__main__":
    unittest.main()
