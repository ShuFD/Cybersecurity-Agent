import json
import tarfile
import tempfile
import unittest
from pathlib import Path

from pi_agent_compat.build_release import build_release


PROJECT_ROOT = Path(__file__).resolve().parents[1]


class PiAgentCompatibilityReleaseTests(unittest.TestCase):
    def test_release_replaces_only_legacy_planning_modules(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            package = root / "base" / "package"
            legacy = package / "dist" / "legacy"
            legacy.mkdir(parents=True)
            (package / "package.json").write_text('{"name":"@secheur/agent"}\n', encoding="utf-8")
            (package / "dist" / "extension.js").write_text("PI_NATIVE_EXTENSION\n", encoding="utf-8")
            (legacy / "keep.py").write_text("KEEP = True\n", encoding="utf-8")
            (legacy / "error_handler.py").write_text("SERVER_ERROR_HANDLER = True\n", encoding="utf-8")
            (legacy / "flag_oracle.py").write_text("SERVER_FLAG_ORACLE = True\n", encoding="utf-8")
            base = root / "base.tgz"
            with tarfile.open(base, "w:gz") as archive:
                archive.add(package, arcname="package")

            output = root / "migrated.tgz"
            manifest = build_release(
                base,
                output,
                PROJECT_ROOT,
                PROJECT_ROOT / "secheur_pi_bridge.py",
            )
            extracted = root / "extracted"
            with tarfile.open(output, "r:gz") as archive:
                archive.extractall(extracted, filter="data")

            migrated = extracted / "package"
            self.assertEqual((migrated / "dist" / "extension.js").read_text(), "PI_NATIVE_EXTENSION\n")
            self.assertEqual((migrated / "dist" / "legacy" / "keep.py").read_text(), "KEEP = True\n")
            self.assertEqual(
                (migrated / "dist" / "legacy" / "error_handler.py").read_text(),
                "SERVER_ERROR_HANDLER = True\n",
            )
            self.assertEqual(
                (migrated / "dist" / "legacy" / "flag_oracle.py").read_text(),
                "SERVER_FLAG_ORACLE = True\n",
            )
            self.assertTrue((migrated / "dist" / "legacy" / "task_descriptor" / "parser.py").is_file())
            self.assertTrue((migrated / "dist" / "legacy" / "plan_runtime" / "progress_controller.py").is_file())
            self.assertIn("secheur_pi_bridge.py", manifest["files"])
            self.assertFalse(manifest["pi_loop_replaced"])
            self.assertFalse(manifest["adjacent_modules_replaced"])
            stored = json.loads(
                (migrated / "dist" / "legacy" / "planning-migration-manifest.json").read_text(encoding="utf-8")
            )
            self.assertEqual(stored["strategy"], manifest["strategy"])


if __name__ == "__main__":
    unittest.main()
