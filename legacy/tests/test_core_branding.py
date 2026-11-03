import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class CoreBrandingTests(unittest.TestCase):
    def test_core_module_uses_secheur_name(self):
        self.assertTrue((ROOT / "secheur_core.py").exists())
        self.assertFalse((ROOT / "ga.py").exists())

    def test_agentmain_imports_secheur_core(self):
        agentmain = (ROOT / "agentmain.py").read_text(encoding="utf-8")

        self.assertIn("import secheur_core", agentmain)
        self.assertIn("SecHeurAgentHandler = secheur_core.SecHeurAgentHandler", agentmain)
        self.assertNotIn("getattr(secheur_core,", agentmain)
        self.assertNotIn("import ga as", agentmain)
        self.assertNotIn("ga_core", agentmain)

    def test_load_tool_schema_closes_schema_file(self):
        agentmain = (ROOT / "agentmain.py").read_text(encoding="utf-8")

        self.assertIn("with open(os.path.join(script_dir, f'assets/tools_schema{suffix}.json')", agentmain)

    def test_core_exports_no_old_generic_agent_aliases(self):
        agentmain = (ROOT / "agentmain.py").read_text(encoding="utf-8")
        secheur_core = (ROOT / "secheur_core.py").read_text(encoding="utf-8")
        cli_init = (ROOT / "secheur_cli" / "__init__.py").read_text(encoding="utf-8")
        old_handler = "Generic" + "AgentHandler"
        old_typo = "Generatic" + "Agent"

        for text in (agentmain, secheur_core, cli_init):
            self.assertNotIn("Generic\" + \"Agent", text)
            self.assertNotIn(old_handler, text)
            self.assertNotIn(old_typo, text)

    def test_permission_integration_test_uses_secheur_name(self):
        self.assertTrue((ROOT / "tests" / "test_secheur_permission_integration.py").exists())
        self.assertFalse((ROOT / "tests" / "test_ga_permission_integration.py").exists())

    def test_tests_patch_secheur_core_module(self):
        old_import = "from " + "ga import"
        old_patch = 'patch("' + "ga."
        for test_path in (ROOT / "tests").glob("test_*.py"):
            text = test_path.read_text(encoding="utf-8")
            self.assertNotIn(old_import, text, msg=str(test_path))
            self.assertNotIn(old_patch, text, msg=str(test_path))


if __name__ == "__main__":
    unittest.main()
