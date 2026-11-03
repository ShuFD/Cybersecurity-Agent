import unittest
import os
import subprocess
from unittest.mock import patch

import scripts.verify_global as verify_global


class VerifyGlobalScriptTests(unittest.TestCase):
    def test_run_merges_custom_env_with_process_env(self):
        calls = []

        def capture_subprocess_run(cmd, **kwargs):
            calls.append((cmd, kwargs))

        with patch.dict(os.environ, {"PATH": "/test/bin", "KEEP": "yes"}, clear=True), \
             patch.object(verify_global.subprocess, "run", capture_subprocess_run):
            verify_global.run(["echo", "ok"], env={"KEEP": "overridden", "EXTRA": "1"})

        process_env = calls[0][1]["env"]
        self.assertEqual(process_env["PATH"], "/test/bin")
        self.assertEqual(process_env["KEEP"], "overridden")
        self.assertEqual(process_env["EXTRA"], "1")

    def test_cli_entrypoint_check_covers_documented_entrypoints(self):
        commands = []

        def capture_run(cmd, **_kwargs):
            commands.append(tuple(cmd))

        with patch.object(verify_global, "run", capture_run):
            verify_global.check_cli_entrypoints()

        python = verify_global.PYTHON
        self.assertIn((python, "-m", "secheur_cli.cli", "--help"), commands)
        self.assertIn((python, "-m", "secheur_cli.cli", "list"), commands)
        self.assertIn((python, "-m", "secheur_cli.cli", "status"), commands)
        self.assertIn((python, "-m", "secheur_cli.cli", "--version"), commands)
        self.assertIn((python, "launch.pyw", "--help"), commands)
        self.assertIn((python, "agentmain.py", "--help"), commands)

    def test_cli_status_uses_verification_bridge_status_url(self):
        calls = []

        def capture_run(cmd, **kwargs):
            calls.append((tuple(cmd), kwargs.get("env")))

        with patch.object(verify_global, "BRIDGE_BASE", "http://127.0.0.1:54321"), \
             patch.object(verify_global, "run", capture_run):
            verify_global.check_cli_entrypoints()

        status_env = dict(calls[2][1])
        self.assertEqual(calls[2][0], (verify_global.PYTHON, "-m", "secheur_cli.cli", "status"))
        self.assertEqual(status_env["SECHEUR_STATUS_URL"], "http://127.0.0.1:54321/status")

    def test_repository_hygiene_rejects_stale_branding_tokens(self):
        with patch.object(verify_global, "tracked_files", return_value=["frontends/desktop/static/app.js"]), \
             patch.object(verify_global, "read_text", return_value="window.ga.call()"):
            with self.assertRaises(AssertionError):
                verify_global.check_repository_hygiene()

    def test_bridge_smoke_checks_current_desktop_asset_versions(self):
        source = verify_global.Path(verify_global.__file__).read_text(encoding="utf-8")

        self.assertIn("styles.css?v=settings-b33", source)
        self.assertIn("secheur-web.js?v=bridge-adapter-10", source)
        self.assertIn("app.js?v=bridge-api-77", source)
        self.assertNotIn("styles.css?v=settings-b32", source)
        self.assertNotIn("app.js?v=bridge-api-75", source)
        self.assertNotIn("styles.css?v=settings-b31", source)
        self.assertNotIn("app.js?v=bridge-api-74", source)
        self.assertNotIn("styles.css?v=settings-b30", source)
        self.assertNotIn("app.js?v=bridge-api-73", source)
        self.assertNotIn("styles.css?v=settings-b29", source)
        self.assertNotIn("secheur-web.js?v=bridge-adapter-8", source)
        self.assertNotIn("app.js?v=bridge-api-72", source)
        self.assertNotIn("styles.css?v=settings-b28", source)
        self.assertNotIn("app.js?v=bridge-api-71", source)
        self.assertNotIn("styles.css?v=settings-b27", source)
        self.assertNotIn("app.js?v=bridge-api-70", source)
        self.assertNotIn("styles.css?v=settings-b26", source)
        self.assertNotIn("styles.css?v=settings-b25", source)
        self.assertNotIn("app.js?v=bridge-api-69", source)

    def test_tracked_files_falls_back_to_filesystem_without_git_metadata(self):
        def fail_git(*_args, **_kwargs):
            raise subprocess.CalledProcessError(128, ["git", "ls-files"])

        with patch.object(verify_global.subprocess, "run", fail_git), \
             patch.object(verify_global, "filesystem_source_files", return_value=["README.md"]):
            self.assertEqual(verify_global.tracked_files(), ["README.md"])

    def test_clean_archive_check_runs_exported_gate_without_recursing(self):
        calls = []

        def capture_run(cmd, **kwargs):
            calls.append((tuple(cmd), kwargs))

        with patch.object(verify_global, "export_clean_archive", return_value="/tmp/secheur-clean-test"), \
             patch.object(verify_global, "run", capture_run):
            verify_global.check_clean_archive()

        self.assertEqual(
            calls,
            [
                (
                    (
                        verify_global.PYTHON,
                        "/tmp/secheur-clean-test/scripts/verify_global.py",
                        "--skip-clean-archive",
                    ),
                    {
                        "env": {"SECHEUR_VERIFY_CLEAN_ARCHIVE": "1"},
                        "display": f"{verify_global.PYTHON} <clean-archive>/scripts/verify_global.py --skip-clean-archive",
                    },
                )
            ],
        )


if __name__ == "__main__":
    unittest.main()
