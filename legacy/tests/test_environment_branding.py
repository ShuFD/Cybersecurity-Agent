import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class EnvironmentBrandingTests(unittest.TestCase):
    def test_readme_uses_secheur_permission_env(self):
        text = (ROOT / "README.md").read_text(encoding="utf-8")

        self.assertIn("SECHEUR_PERMISSION_MODE=bypassPermissions", text)
        self.assertNotIn("G" + "A_PERMISSION_MODE=", text)

    def test_readme_describes_permission_modes(self):
        text = (ROOT / "README.md").read_text(encoding="utf-8")

        self.assertIn("`bypassPermissions`：完全访问权限", text)
        self.assertIn("`plan`：计划模式", text)
        self.assertNotIn("仍遵守 `deny` 规则", text)

    def test_repository_does_not_keep_standalone_docs_directory(self):
        self.assertFalse((ROOT / "docs").exists())

    def test_readme_does_not_link_removed_docs(self):
        text = (ROOT / "README.md").read_text(encoding="utf-8")

        self.assertNotIn("docs/", text)
        self.assertNotIn("GETTING_STARTED", text)
        self.assertNotIn("installation_zh", text)

    def test_legacy_frontends_are_removed_from_simplified_build(self):
        removed = [
            "tuiapp_v2.py",
            "tui_v3.py",
            "tuiapp.py",
            "stapp.py",
            "stapp2.py",
            "qtapp.py",
            "tgapp.py",
            "fsapp.py",
            "wechatapp.py",
            "wecomapp.py",
            "dingtalkapp.py",
            "dcapp.py",
            "qqapp.py",
            "desktop_pet.pyw",
            "desktop_pet_v2.pyw",
        ]

        for name in removed:
            self.assertFalse((ROOT / "frontends" / name).exists(), msg=name)

    def test_legacy_review_command_assets_are_removed(self):
        self.assertFalse((ROOT / "frontends" / "review_cmd.py").exists())
        self.assertFalse((ROOT / "memory" / "review_sop.md").exists())
        self.assertFalse((ROOT / "memory" / "review_sop").exists())

    def test_keychain_uses_secheur_storage_name(self):
        text = (ROOT / "memory" / "keychain.py").read_text(encoding="utf-8")

        self.assertIn("secheur_keychain.enc", text)
        self.assertIn("@secheur_keychain", text)
        self.assertNotIn("ga_keychain.enc", text)
        self.assertNotIn("@ga_keychain", text)

    def test_acp_session_ids_use_secheur_prefix(self):
        self.assertTrue((ROOT / "frontends" / "secheur_acp_bridge.py").exists())
        self.assertFalse((ROOT / "frontends" / ("generic" + "agent_acp_bridge.py")).exists())
        text = (ROOT / "frontends" / "secheur_acp_bridge.py").read_text(encoding="utf-8")

        self.assertIn('session_id = f"secheur_', text)
        self.assertNotIn('session_id = f"ga_', text)

    def test_repository_does_not_keep_external_technical_report_assets(self):
        report_suffix = "Agent_" + "Technical" + "_Report.pdf"
        self.assertFalse((ROOT / "assets" / ("SecHeur" + report_suffix)).exists())
        self.assertFalse((ROOT / "assets" / ("Generic" + report_suffix)).exists())

    def test_license_uses_project_owner(self):
        text = (ROOT / "LICENSE").read_text(encoding="utf-8")

        self.assertIn("Copyright (c) 2026 yg2224", text)
        self.assertNotIn("ls" + "define", text)

    def test_install_docs_use_secheur_repository_and_command(self):
        doc_paths = [
            ROOT / "README.md",
        ]
        combined = "\n".join(path.read_text(encoding="utf-8") for path in doc_paths)

        self.assertIn("https://github.com/yg2224/SecHeur-Agent.git", combined)
        self.assertIn("secheur list", combined)
        self.assertNotIn("ga_install", combined)
        self.assertNotIn("ls" + "define/SecHeur Agent", combined)
        self.assertNotIn("type ga", combined)
        self.assertNotIn("ga update", combined)
        self.assertNotIn("`ga` command", combined)
        self.assertNotIn("`ga` 命令", combined)
        self.assertNotIn("hello-generic-agent", combined)
        self.assertNotIn("ga-manager", combined)

    def test_frontends_import_secheur_agent_class(self):
        old_getattr = "getattr(agentmain, \"Generic\" + \"Agent\")"
        old_typo = "Generatic" + "Agent"
        old_import = "from agentmain import " + "Generic" + "Agent"
        for path in (ROOT / "frontends").glob("*.py"):
            text = path.read_text(encoding="utf-8")
            self.assertNotIn(old_getattr, text, msg=str(path))
            self.assertNotIn(old_typo, text, msg=str(path))
            self.assertNotIn(old_import, text, msg=str(path))

    def test_oauth_referrer_uses_secheur_name(self):
        proxy = (ROOT / "assets" / "supergrok_proxy.py").read_text(encoding="utf-8")

        self.assertIn("'referrer': 'secheur-agent'", proxy)
        self.assertNotIn("'referrer': 'generic-agent'", proxy)

    def test_registry_state_uses_only_secheur_state_dir(self):
        text = (ROOT / "registry_state.py").read_text(encoding="utf-8")

        self.assertIn('STATE_DIR_NAME = ".secheur-agent"', text)
        self.assertNotIn("LEGACY_STATE_DIR_NAME", text)
        self.assertNotIn("legacy_state_path", text)
        self.assertNotIn("ga-desktop", text)

    def test_ui_extra_keeps_only_html_desktop_dependency(self):
        pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
        ui_start = pyproject.index("ui = [")
        ui_end = pyproject.index("]", ui_start)
        ui_block = pyproject[ui_start:ui_end]

        self.assertIn('"pywebview>=4.0"', ui_block)
        self.assertNotIn("streamlit", ui_block)
        self.assertNotIn("legacy-streamlit", pyproject)
        self.assertNotIn("all-frontends", pyproject)
        self.assertNotIn("textual", pyproject)

    def test_install_docs_describe_html_ui_extra_without_legacy_frontends(self):
        docs = (ROOT / "README.md").read_text(encoding="utf-8")

        self.assertIn("HTML desktop shell 依赖", docs)
        self.assertNotIn("旧 Streamlit 前端", docs)
        self.assertNotIn(".[legacy-streamlit]", docs)
        self.assertNotIn("frontends/tuiapp_v2.py", docs)


if __name__ == "__main__":
    unittest.main()
