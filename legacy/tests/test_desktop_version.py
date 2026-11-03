import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class DesktopVersionTests(unittest.TestCase):
    def test_sidebar_version_matches_project_version(self):
        pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        project = re.search(r"(?ms)^\[project\]\s*(.*?)(?=^\[|\Z)", pyproject)
        self.assertIsNotNone(project)
        version = re.search(r'^version\s*=\s*"([^"]+)"', project.group(1), re.MULTILINE)
        self.assertIsNotNone(version)

        expected_version = version.group(1)
        self.assertIn(f'id="app-version" class="sidebar-version"', index_html)
        self.assertIn(f'aria-label="当前版本 {expected_version}"', index_html)
        self.assertIn(f'>v{expected_version}</span>', index_html)
        self.assertIn(".sidebar-version {", styles)
        self.assertIn("color: var(--text-faint);", styles)


if __name__ == "__main__":
    unittest.main()
