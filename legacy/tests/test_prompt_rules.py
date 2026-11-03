import tempfile
import unittest
from pathlib import Path
from unittest import mock

from prompt_rules import load_project_prompt_extensions


class PromptRulesTests(unittest.TestCase):
    def test_loads_project_rules_and_expands_includes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            rules_dir = root / ".secheur-agent" / "rules"
            rules_dir.mkdir(parents=True)
            (rules_dir / "main.md").write_text("Main rule\n@include docs/detail.md\n", encoding="utf-8")
            (root / "docs").mkdir()
            (root / "docs" / "detail.md").write_text("Detailed rule\n", encoding="utf-8")

            prompt = load_project_prompt_extensions(root)

        self.assertIn("# Project Rules", prompt)
        self.assertIn("Main rule", prompt)
        self.assertIn("Detailed rule", prompt)

    def test_include_cannot_escape_project_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            root.mkdir()
            outside = Path(tmp) / "secret.md"
            outside.write_text("do not include\n", encoding="utf-8")
            rules_dir = root / ".secheur-agent" / "rules"
            rules_dir.mkdir(parents=True)
            (rules_dir / "main.md").write_text("@include ../secret.md\n", encoding="utf-8")

            prompt = load_project_prompt_extensions(root)

        self.assertIn("[include skipped:", prompt)
        self.assertNotIn("do not include", prompt)

    def test_include_cycles_are_reported_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            rules_dir = root / ".secheur-agent" / "rules"
            rules_dir.mkdir(parents=True)
            (rules_dir / "a.md").write_text("A\n@include .secheur-agent/rules/b.md\n", encoding="utf-8")
            (rules_dir / "b.md").write_text("B\n@include .secheur-agent/rules/a.md\n", encoding="utf-8")

            prompt = load_project_prompt_extensions(root)

        self.assertIn("A", prompt)
        self.assertIn("B", prompt)
        self.assertIn("[include skipped: cycle", prompt)

    def test_expands_safe_template_variables_in_rules_and_includes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            rules_dir = root / ".secheur-agent" / "rules"
            rules_dir.mkdir(parents=True)
            (rules_dir / "main.md").write_text(
                "Root=${PROJECT_ROOT}\nRule=${RULE_FILE}\n@include docs/detail.md\nUnknown=${NOPE}\n",
                encoding="utf-8",
            )
            (root / "docs").mkdir()
            (root / "docs" / "detail.md").write_text(
                "Dir=${RULE_DIR}\nDate=${DATE}\n",
                encoding="utf-8",
            )

            with mock.patch("prompt_rules.date") as fake_date:
                fake_date.today.return_value.isoformat.return_value = "2026-06-01"
                prompt = load_project_prompt_extensions(root)

        self.assertIn(f"Root={root}", prompt)
        self.assertIn(f"Rule={rules_dir / 'main.md'}", prompt)
        self.assertIn(f"Dir={root / 'docs'}", prompt)
        self.assertIn("Date=2026-06-01", prompt)
        self.assertIn("Unknown=${NOPE}", prompt)


if __name__ == "__main__":
    unittest.main()
