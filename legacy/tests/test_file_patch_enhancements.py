import tempfile
import unittest
import os
from pathlib import Path
from unittest.mock import patch

from secheur_core import file_patch


class FilePatchEnhancementTests(unittest.TestCase):
    def test_file_patch_matches_smart_quotes_and_reports_note(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "quote.txt"
            target.write_text('title = “hello”\n', encoding="utf-8")

            result = file_patch(str(target), 'title = "hello"\n', 'title = "world"\n')

            content = target.read_text(encoding="utf-8")

        self.assertEqual(result["status"], "success")
        self.assertTrue(result["quote_normalized"])
        self.assertEqual(content, 'title = "world"\n')

    def test_file_patch_returns_unified_diff_preview(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "app.py"
            target.write_text("a\nold\nc\n", encoding="utf-8")

            result = file_patch(str(target), "old\n", "new\n")

        self.assertEqual(result["status"], "success")
        self.assertIn("@@ -2,1 +2,1 @@", result["diff"])
        self.assertIn("- old", result["diff"])
        self.assertIn("+ new", result["diff"])

    def test_file_patch_keeps_original_when_replace_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "app.py"
            target.write_text("old\n", encoding="utf-8")

            with patch("secheur_core.os.replace", side_effect=OSError("simulated replace failure")):
                result = file_patch(str(target), "old\n", "new\n")
            content = target.read_text(encoding="utf-8")

        self.assertEqual(result["status"], "error")
        self.assertIn("simulated replace failure", result["msg"])
        self.assertEqual(content, "old\n")

    def test_file_patch_preserves_existing_file_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "run.sh"
            target.write_text("#!/bin/sh\necho old\n", encoding="utf-8")
            os.chmod(target, 0o755)

            result = file_patch(str(target), "echo old\n", "echo new\n")
            mode = target.stat().st_mode & 0o777

        self.assertEqual(result["status"], "success")
        self.assertEqual(mode, 0o755)


if __name__ == "__main__":
    unittest.main()
