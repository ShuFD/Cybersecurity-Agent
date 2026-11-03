import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import frontends.desktop_settings as desktop_settings
from frontends.desktop_settings import (
    build_registry,
    load_api_config,
    delete_api_config,
    save_api_config,
    save_mcp_server,
    save_project_agent,
    save_project_skill,
    save_registry_state,
)
from mcp_client import load_mcp_configs
from skill_registry import discover_skills
from agent_registry import discover_agents
from tool_registry import get_active_tool_schema, search_deferred_tools


class DesktopSettingsTests(unittest.TestCase):
    def test_build_registry_discovers_default_mcp_skills_and_tools(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".mcp.json").write_text(
                json.dumps({"mcpServers": {"fake": {"command": "python", "args": ["server.py"]}}}),
                encoding="utf-8",
            )
            skill_dir = root / "skill" / "review"
            skill_dir.mkdir(parents=True)
            (skill_dir / "SKILL.md").write_text(
                "---\nname: review\ndescription: Review code\n---\nUse this skill.",
                encoding="utf-8",
            )
            tools_schema = root / "tools_schema.json"
            tools_schema.write_text(
                json.dumps([
                    {"type": "function", "function": {"name": "file_read", "description": "Read file", "parameters": {}}},
                    {"type": "function", "function": {"name": "code_run", "description": "Run code", "parameters": {}}},
                ]),
                encoding="utf-8",
            )

            with patch.object(Path, "home", return_value=root / "home"):
                registry = build_registry(root, tools_schema_path=tools_schema)

        self.assertEqual(registry["statePath"].endswith(".secheur-agent/settings.json"), True)
        self.assertIn("sources", registry)
        self.assertEqual([item["name"] for item in registry["mcpServers"]], ["fake"])
        self.assertTrue(registry["mcpServers"][0]["enabled"])
        self.assertEqual([item["name"] for item in registry["skills"]], ["review"])
        self.assertTrue(registry["skills"][0]["enabled"])
        self.assertGreaterEqual({item["name"] for item in registry["agents"]}, {"reviewer", "researcher", "planner"})
        self.assertTrue(next(item for item in registry["agents"] if item["name"] == "reviewer")["enabled"])
        self.assertIn("file_read", [item["name"] for item in registry["tools"]])
        self.assertTrue(next(item for item in registry["tools"] if item["name"] == "file_read")["enabled"])

    def test_build_registry_reports_settings_json_mcp_source_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            settings = root / "settings.json"
            settings.write_text(
                json.dumps({"mcpServers": {"from-settings": {"command": "python", "args": ["server.py"]}}}),
                encoding="utf-8",
            )

            registry = build_registry(root)

        self.assertIn(str(settings), registry["sources"]["mcpConfigPaths"])
        self.assertEqual([item["name"] for item in registry["mcpServers"]], ["from-settings"])
        self.assertEqual(registry["mcpServers"][0]["sourcePath"], str(settings))
        self.assertEqual(registry["mcpServers"][0]["openPath"], str(root))

    def test_registry_items_include_manageable_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            mcp_path = root / ".mcp.json"
            mcp_path.write_text(
                json.dumps({"mcpServers": {"fake": {"command": "python", "args": ["server.py"]}}}),
                encoding="utf-8",
            )
            skill_dir = root / "skills" / "audit"
            skill_dir.mkdir(parents=True)
            (skill_dir / "SKILL.md").write_text(
                "---\nname: audit\ndescription: Audit code\n---\n",
                encoding="utf-8",
            )
            tools_schema = root / "tools_schema.json"
            tools_schema.write_text(
                json.dumps([{"type": "function", "function": {"name": "file_read", "description": "Read file", "parameters": {}}}]),
                encoding="utf-8",
            )

            with patch.object(Path, "home", return_value=root / "home"):
                registry = build_registry(root, tools_schema_path=tools_schema)

        mcp = registry["mcpServers"][0]
        skill = registry["skills"][0]
        tool = next(item for item in registry["tools"] if item["name"] == "file_read")
        self.assertEqual(mcp["sourcePath"], str(mcp_path))
        self.assertEqual(mcp["openPath"], str(root))
        self.assertEqual(skill["sourcePath"], str(skill_dir / "SKILL.md"))
        self.assertEqual(skill["skillDir"], str(skill_dir))
        self.assertEqual(skill["openPath"], str(skill_dir))
        self.assertEqual(skill["source"], str(skill_dir.parent))
        self.assertEqual(tool["sourcePath"], str(tools_schema))
        self.assertEqual(tool["openPath"], str(root))

    def test_registry_state_can_disable_items(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".mcp.json").write_text(
                json.dumps({"mcpServers": {"fake": {"command": "python"}}}),
                encoding="utf-8",
            )
            skill_dir = root / "skill" / "review"
            skill_dir.mkdir(parents=True)
            (skill_dir / "SKILL.md").write_text("---\nname: review\n---\n", encoding="utf-8")
            tools_schema = root / "tools_schema.json"
            tools_schema.write_text(
                json.dumps([{"type": "function", "function": {"name": "file_read", "description": "Read file", "parameters": {}}}]),
                encoding="utf-8",
            )

            save_registry_state(
                root,
                {
                    "mcpServers": {"fake": False},
                    "skills": {"review": False},
                    "agents": {"reviewer": False},
                    "tools": {"file_read": False},
                },
            )
            with patch.object(Path, "home", return_value=root / "home"):
                registry = build_registry(root, tools_schema_path=tools_schema)

        self.assertFalse(registry["mcpServers"][0]["enabled"])
        self.assertFalse(registry["skills"][0]["enabled"])
        self.assertFalse(next(item for item in registry["agents"] if item["name"] == "reviewer")["enabled"])
        self.assertFalse(next(item for item in registry["tools"] if item["name"] == "file_read")["enabled"])

    def test_registry_state_treats_string_false_as_disabled(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tools_schema = root / "tools_schema.json"
            tools_schema.write_text(
                json.dumps([{"type": "function", "function": {"name": "file_read", "description": "Read file", "parameters": {}}}]),
                encoding="utf-8",
            )
            (root / ".secheur-agent").mkdir()
            (root / ".secheur-agent" / "settings.json").write_text(
                json.dumps({"tools": {"file_read": "false"}}),
                encoding="utf-8",
            )

            registry = build_registry(root, tools_schema_path=tools_schema)

        self.assertFalse(next(item for item in registry["tools"] if item["name"] == "file_read")["enabled"])

    def test_registry_state_save_coerces_string_false_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".mcp.json").write_text(
                json.dumps({"mcpServers": {"fake": {"command": "python"}}}),
                encoding="utf-8",
            )
            skill_dir = root / "skill" / "review"
            skill_dir.mkdir(parents=True)
            (skill_dir / "SKILL.md").write_text("---\nname: review\n---\n", encoding="utf-8")
            tools_schema = root / "tools_schema.json"
            tools_schema.write_text(
                json.dumps([{"type": "function", "function": {"name": "file_read", "description": "Read file", "parameters": {}}}]),
                encoding="utf-8",
            )

            save_registry_state(
                root,
                {
                    "mcpServers": {"fake": "false"},
                    "skills": {"review": "0"},
                    "agents": {"planner": "disabled"},
                    "tools": {"file_read": "off"},
                },
            )
            registry = build_registry(root, tools_schema_path=tools_schema)

        self.assertFalse(registry["mcpServers"][0]["enabled"])
        self.assertFalse(registry["skills"][0]["enabled"])
        self.assertFalse(next(item for item in registry["agents"] if item["name"] == "planner")["enabled"])
        self.assertFalse(next(item for item in registry["tools"] if item["name"] == "file_read")["enabled"])

    def test_registry_creates_only_project_owned_default_skill_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            home = Path(tmp) / "home"
            skill_dir = root / "skill" / "grill-me"
            skill_dir.mkdir(parents=True)
            (skill_dir / "SKILL.md").write_text(
                "---\nname: grill-me\ndescription: Ask hard questions\n---\nGrill $ARGUMENTS.",
                encoding="utf-8",
            )

            with patch.object(Path, "home", return_value=home):
                registry = build_registry(root)

            self.assertTrue((root / "skill").is_dir())
            self.assertFalse((root / "skills").exists())
            self.assertTrue((root / ".secheur-agent" / "skills").is_dir())
            self.assertTrue((root / ".secheur-agent" / "agents").is_dir())
            self.assertTrue((root / ".secheur-agent" / "rules").is_dir())
            self.assertTrue((root / ".secheur-agent" / "mcp.json").is_file())
            self.assertIn(str(root / "skill"), registry["sources"]["skillDirs"])
            self.assertNotIn(str(root / "skills"), registry["sources"]["skillDirs"])
            self.assertIn(str(root / ".secheur-agent" / "skills"), registry["sources"]["skillDirs"])
            self.assertIn(str(root / ".secheur-agent" / "mcp.json"), registry["sources"]["mcpConfigPaths"])
            self.assertIn("grill-me", [item["name"] for item in registry["skills"]])
            self.assertEqual(registry["sources"]["agentDir"], str(root / ".secheur-agent" / "agents"))

    def test_registry_discovers_custom_skill_directories_from_desktop_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            custom_dir = Path(tmp) / "custom-skills"
            skill_dir = custom_dir / "threat-review"
            skill_dir.mkdir(parents=True)
            (skill_dir / "SKILL.md").write_text(
                "---\nname: threat-review\ndescription: Review threat model\n---\nReview.",
                encoding="utf-8",
            )

            registry = build_registry(root, custom_skill_dirs=str(custom_dir))

        skill = next(item for item in registry["skills"] if item["name"] == "threat-review")
        self.assertEqual(skill["sourcePath"], str(skill_dir / "SKILL.md"))
        self.assertIn(str(custom_dir), registry["sources"]["skillDirs"])

    def test_save_mcp_server_writes_project_owned_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            saved = save_mcp_server(
                root,
                {
                    "name": "filesystem",
                    "command": "npx",
                    "args": "-y @modelcontextprotocol/server-filesystem .",
                    "env": {"TOKEN": "secret"},
                    "cwd": str(root / "workspace"),
                    "timeout": "2.5",
                },
            )

            registry = build_registry(root)
            config = json.loads((root / ".secheur-agent" / "mcp.json").read_text(encoding="utf-8"))

        self.assertEqual(saved["path"], str(root / ".secheur-agent" / "mcp.json"))
        self.assertEqual(config["mcpServers"]["filesystem"]["command"], "npx")
        self.assertEqual(config["mcpServers"]["filesystem"]["args"], ["-y", "@modelcontextprotocol/server-filesystem", "."])
        self.assertEqual(config["mcpServers"]["filesystem"]["env"], {"TOKEN": "secret"})
        self.assertEqual(config["mcpServers"]["filesystem"]["cwd"], str(root / "workspace"))
        self.assertEqual(config["mcpServers"]["filesystem"]["timeout"], 2.5)
        item = next(item for item in registry["mcpServers"] if item["name"] == "filesystem")
        self.assertEqual(item["env"], {"TOKEN": "secret"})
        self.assertEqual(item["cwd"], str(root / "workspace"))
        self.assertEqual(item["timeout"], 2.5)

    def test_save_mcp_server_writes_project_owned_http_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            saved = save_mcp_server(
                root,
                {
                    "name": "remote",
                    "url": "http://127.0.0.1:8765/mcp",
                    "headers": {"Authorization": "Bearer token"},
                    "timeout": "3.5",
                },
            )

            registry = build_registry(root)
            config = json.loads((root / ".secheur-agent" / "mcp.json").read_text(encoding="utf-8"))

        self.assertEqual(saved["path"], str(root / ".secheur-agent" / "mcp.json"))
        self.assertEqual(config["mcpServers"]["remote"]["url"], "http://127.0.0.1:8765/mcp")
        self.assertNotIn("command", config["mcpServers"]["remote"])
        self.assertEqual(config["mcpServers"]["remote"]["headers"], {"Authorization": "Bearer token"})
        self.assertEqual(config["mcpServers"]["remote"]["timeout"], 3.5)
        item = next(item for item in registry["mcpServers"] if item["name"] == "remote")
        self.assertEqual(item["transport"], "http")
        self.assertEqual(item["url"], "http://127.0.0.1:8765/mcp")
        self.assertEqual(item["headers"], {"Authorization": "Bearer token"})

    def test_saving_project_owned_items_reenables_previous_disabled_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            save_registry_state(
                root,
                {
                    "mcpServers": {"filesystem": False},
                    "skills": {"incident-review": False},
                    "agents": {"incident-reviewer": False},
                },
            )

            save_mcp_server(root, {"name": "filesystem", "command": "npx"})
            save_project_skill(root, {"name": "incident-review", "body": "Review $ARGUMENTS."})
            save_project_agent(root, {"name": "incident-reviewer", "body": "Review $TASK."})
            registry = build_registry(root)

        self.assertTrue(next(item for item in registry["mcpServers"] if item["name"] == "filesystem")["enabled"])
        self.assertTrue(next(item for item in registry["skills"] if item["name"] == "incident-review")["enabled"])
        self.assertTrue(next(item for item in registry["agents"] if item["name"] == "incident-reviewer")["enabled"])

    def test_save_project_skill_writes_project_skill_file_and_registry_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            saved = save_project_skill(
                root,
                {
                    "name": "incident-review",
                    "description": "Review incident response",
                    "context": "fork",
                    "body": "Review $ARGUMENTS carefully.",
                },
            )

            registry = build_registry(root)
            skill_path = root / ".secheur-agent" / "skills" / "incident-review" / "SKILL.md"
            skill_text = skill_path.read_text(encoding="utf-8")

        self.assertEqual(saved["path"], str(root / ".secheur-agent" / "skills" / "incident-review" / "SKILL.md"))
        self.assertEqual(saved["skillDir"], str(root / ".secheur-agent" / "skills" / "incident-review"))
        self.assertIn("name: incident-review", skill_text)
        self.assertIn("context: fork", skill_text)
        self.assertIn("Review $ARGUMENTS carefully.", skill_text)
        item = next(item for item in registry["skills"] if item["name"] == "incident-review")
        self.assertEqual(item["context"], "fork")
        self.assertEqual(item["body"], "Review $ARGUMENTS carefully.")

    def test_save_project_agent_writes_project_agent_file_and_registry_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            saved = save_project_agent(
                root,
                {
                    "name": "incident-reviewer",
                    "description": "Review incidents",
                    "whenToUse": "Use for incident reports",
                    "allowedTools": "file_read,grep_search",
                    "body": "Review $TASK carefully.",
                },
            )

            registry = build_registry(root)
            agent_text = (root / ".secheur-agent" / "agents" / "incident-reviewer.md").read_text(encoding="utf-8")

        self.assertEqual(saved["path"], str(root / ".secheur-agent" / "agents" / "incident-reviewer.md"))
        self.assertIn("name: incident-reviewer", agent_text)
        self.assertIn("allowed-tools: file_read,grep_search", agent_text)
        self.assertIn("Review $TASK carefully.", agent_text)
        item = next(item for item in registry["agents"] if item["name"] == "incident-reviewer")
        self.assertEqual(item["allowedTools"], ["file_read", "grep_search"])
        self.assertEqual(item["body"], "Review $TASK carefully.")

    def test_disabled_registry_items_are_hidden_from_runtime_loaders(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".mcp.json").write_text(
                json.dumps({"mcpServers": {"fake": {"command": "python"}}}),
                encoding="utf-8",
            )
            skill_dir = root / "skill" / "review"
            skill_dir.mkdir(parents=True)
            (skill_dir / "SKILL.md").write_text("---\nname: review\n---\nReview.", encoding="utf-8")
            save_registry_state(
                root,
                {
                    "mcpServers": {"fake": False},
                    "skills": {"review": False},
                    "agents": {"reviewer": False},
                    "tools": {"web_fetch": False},
                },
            )

            mcp_configs = load_mcp_configs(project_root=root, user_settings_path=root / "missing-user-settings.json")
            visible_skills = discover_skills(project_root=root, user_skill_dir=root / "missing")
            visible_agents = discover_agents(project_root=root, user_agent_dir=root / "missing")
            schema = get_active_tool_schema([], activated={"web_fetch"}, project_root=root)
            matches = search_deferred_tools([], "fetch url", project_root=root)

        self.assertEqual(mcp_configs, {})
        self.assertEqual(visible_skills, [])
        self.assertNotIn("reviewer", [agent.name for agent in visible_agents])
        self.assertNotIn("web_fetch", [tool["function"]["name"] for tool in schema])
        self.assertEqual(matches, [])

    def test_api_config_loads_masked_key_and_saves_without_manual_file_edit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            save_api_config(
                root,
                {
                    "name": "work",
                    "type": "native_oai",
                    "apikey": "sk-test-secret",
                    "apibase": "https://api.example.com/v1",
                    "model": "gpt-test",
                    "api_mode": "chat_completions",
                },
            )

            loaded = load_api_config(root)

        self.assertTrue(loaded["hasApiKey"])
        self.assertEqual(loaded["maskedApiKey"], "sk-t...cret")
        self.assertNotIn("sk-test-secret", json.dumps(loaded, ensure_ascii=False))
        self.assertEqual(loaded["config"]["name"], "work")
        self.assertEqual(loaded["config"]["apikey"], "")

    def test_api_config_can_add_multiple_profiles(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            save_api_config(
                root,
                {
                    "name": "openai",
                    "type": "native_oai",
                    "apikey": "sk-test-openai",
                    "apibase": "https://api.openai.example/v1",
                    "model": "gpt-test",
                },
            )
            save_api_config(
                root,
                {
                    "name": "anthropic",
                    "type": "native_anthropic",
                    "apikey": "sk-ant-test-secret",
                    "apibase": "https://api.anthropic.example",
                    "model": "anthropic-test",
                    "thinking_type": "adaptive",
                },
            )

            loaded = load_api_config(root)

        self.assertEqual([profile["name"] for profile in loaded["profiles"]], ["openai", "anthropic"])
        self.assertEqual(loaded["activeNames"], ["anthropic"])
        self.assertNotIn("sk-ant-test-secret", json.dumps(loaded, ensure_ascii=False))

    def test_api_config_can_delete_profile_without_exposing_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            save_api_config(root, {
                "name": "openai",
                "type": "native_oai",
                "apikey": "sk-test-openai",
                "apibase": "https://api.openai.example/v1",
                "model": "gpt-test",
            })
            save_api_config(root, {
                "name": "anthropic",
                "type": "native_anthropic",
                "apikey": "sk-ant-test-secret",
                "apibase": "https://api.anthropic.example",
                "model": "anthropic-test",
            })

            loaded = delete_api_config(root, "anthropic")

        self.assertEqual([profile["name"] for profile in loaded["profiles"]], ["openai"])
        self.assertEqual(loaded["activeNames"], ["openai"])
        self.assertNotIn("sk-ant-test-secret", json.dumps(loaded, ensure_ascii=False))

    def test_delete_project_mcp_server_only_removes_project_owned_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            save_mcp_server(root, {"name": "project-fs", "command": "python"})
            legacy = root / ".mcp.json"
            legacy.write_text(json.dumps({"mcpServers": {"legacy-fs": {"command": "node"}}}), encoding="utf-8")

            deleted = desktop_settings.delete_project_mcp_server(root, "project-fs")
            registry = build_registry(root)
            config = json.loads((root / ".secheur-agent" / "mcp.json").read_text(encoding="utf-8"))

        self.assertEqual(deleted["name"], "project-fs")
        self.assertEqual(config["mcpServers"], {})
        self.assertIn("legacy-fs", [item["name"] for item in registry["mcpServers"]])
        self.assertNotIn("project-fs", [item["name"] for item in registry["mcpServers"]])

    def test_deleting_project_owned_items_clears_enabled_state_for_fallback_entries(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            save_project_skill(root, {"name": "audit", "body": "Project audit."})
            legacy_skill_dir = root / "skill" / "audit"
            legacy_skill_dir.mkdir(parents=True)
            (legacy_skill_dir / "SKILL.md").write_text("---\nname: audit\n---\nLegacy audit.", encoding="utf-8")
            save_mcp_server(root, {"name": "fs", "command": "python"})
            (root / ".mcp.json").write_text(json.dumps({"mcpServers": {"fs": {"command": "node"}}}), encoding="utf-8")
            save_registry_state(root, {"skills": {"audit": False}, "mcpServers": {"fs": False}})

            desktop_settings.delete_project_skill(root, "audit")
            desktop_settings.delete_project_mcp_server(root, "fs")
            registry = build_registry(root)

        self.assertTrue(next(item for item in registry["skills"] if item["name"] == "audit")["enabled"])
        self.assertTrue(next(item for item in registry["mcpServers"] if item["name"] == "fs")["enabled"])

    def test_delete_project_skill_removes_only_project_owned_skill_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            save_project_skill(root, {"name": "audit", "body": "Project audit."})
            legacy_dir = root / "skill" / "audit"
            legacy_dir.mkdir(parents=True)
            (legacy_dir / "SKILL.md").write_text("---\nname: audit\n---\nLegacy audit.", encoding="utf-8")

            deleted = desktop_settings.delete_project_skill(root, "audit")
            registry = build_registry(root)

        self.assertEqual(deleted["name"], "audit")
        self.assertFalse((root / ".secheur-agent" / "skills" / "audit").exists())
        item = next(item for item in registry["skills"] if item["name"] == "audit")
        self.assertEqual(item["sourcePath"], str(legacy_dir / "SKILL.md"))

    def test_delete_project_agent_rejects_builtin_and_removes_project_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            save_project_agent(root, {"name": "audit-agent", "body": "Audit $TASK."})

            deleted = desktop_settings.delete_project_agent(root, "audit-agent")
            registry = build_registry(root)

            with self.assertRaises(ValueError):
                desktop_settings.delete_project_agent(root, "reviewer")

        self.assertEqual(deleted["name"], "audit-agent")
        self.assertFalse((root / ".secheur-agent" / "agents" / "audit-agent.md").exists())
        self.assertNotIn("audit-agent", [item["name"] for item in registry["agents"]])


if __name__ == "__main__":
    unittest.main()
