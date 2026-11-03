import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class CliBrandingTests(unittest.TestCase):
    def test_console_script_uses_secheur_command(self):
        pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")

        self.assertIn('packages = ["secheur_cli"]', pyproject)
        self.assertIn('secheur = "secheur_cli.cli:main"', pyproject)
        self.assertNotIn('packages = ["ga_cli"]', pyproject)
        self.assertNotIn('ga = "ga_cli.cli:main"', pyproject)

    def test_root_launcher_scripts_use_secheur_name(self):
        launcher = ROOT / "secheur"
        launcher_cmd = ROOT / "secheur.cmd"

        self.assertTrue(launcher.exists())
        self.assertTrue(launcher_cmd.exists())
        self.assertIn("-m secheur_cli", launcher.read_text(encoding="utf-8"))
        self.assertIn("-m secheur_cli", launcher_cmd.read_text(encoding="utf-8"))
        self.assertFalse((ROOT / "ga").exists())
        self.assertFalse((ROOT / "ga.cmd").exists())

    def test_cli_help_mentions_secheur_command(self):
        cli_py = (ROOT / "secheur_cli" / "cli.py").read_text(encoding="utf-8")

        self.assertIn('prog="secheur"', cli_py)
        self.assertIn("secheur launch", cli_py)
        self.assertIn("secheur list", cli_py)
        self.assertIn("python -m secheur_cli", cli_py)
        self.assertNotIn("qtapp.py", cli_py)
        self.assertNotIn("tuiapp_v2.py", cli_py)
        self.assertNotIn('prog="ga"', cli_py)
        self.assertNotIn("python -m ga_cli", cli_py)
        self.assertNotIn("使用 'ga list'", cli_py)

    def test_windows_installer_uses_secheur_command(self):
        installer = ROOT / "secheur_cli" / "secheur-cli-install.cmd"
        installer_text = installer.read_text(encoding="utf-8")

        self.assertTrue(installer.exists())
        self.assertFalse((ROOT / "ga_cli").exists())
        self.assertFalse((ROOT / "secheur_cli" / "ga-cli-install.cmd").exists())
        self.assertIn("secheur list", installer_text)
        self.assertIn("secheur launch / secheur cli", installer_text)
        self.assertNotIn("ga list", installer_text)
        self.assertNotIn("ga gui", installer_text)

    def test_secheur_cli_package_has_no_ga_cli_module_invocation(self):
        init_py = (ROOT / "secheur_cli" / "__init__.py").read_text(encoding="utf-8")
        main_py = (ROOT / "secheur_cli" / "__main__.py").read_text(encoding="utf-8")
        helper_cmd = (ROOT / "secheur_cli" / "secheur_cli.cmd").read_text(encoding="utf-8")

        self.assertIn("secheur_cli - SecHeur Agent CLI", init_py)
        self.assertIn("from secheur_cli.cli import main", main_py)
        self.assertIn("-m secheur_cli", helper_cmd)
        self.assertFalse((ROOT / "secheur_cli" / "ga_cli.cmd").exists())
        self.assertNotIn("python -m ga_cli", init_py)
        self.assertNotIn("from ga_cli.cli", main_py)


if __name__ == "__main__":
    unittest.main()
