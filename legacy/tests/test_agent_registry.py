import tempfile
import unittest
from pathlib import Path

from agent_registry import (
    build_agent_descriptions,
    discover_agents,
    execute_sub_agent,
    filter_tools_for_allowed,
    reset_agent_cache,
)
from registry_state import save_registry_state


def write_agent(root, name, body, meta=None):
    meta = meta or {}
    path = Path(root) / f"{name}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = ["---"]
    for key, value in meta.items():
        lines.append(f"{key}: {value}")
    lines += ["---", "", body]
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


class AgentRegistryTests(unittest.TestCase):
    def tearDown(self):
        reset_agent_cache()

    def test_discovers_project_agent_from_project_agents_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent_dir = Path(tmp) / ".secheur-agent" / "agents"
            write_agent(
                agent_dir,
                "reviewer",
                "Review code for regressions.",
                {"name": "reviewer", "description": "Code review specialist", "allowed-tools": "file_read,grep_search"},
            )

            agents = discover_agents(project_agent_dir=agent_dir, user_agent_dir=Path(tmp) / "none")

        agent_by_name = {agent.name: agent for agent in agents}
        self.assertIn("reviewer", agent_by_name)
        self.assertEqual(agent_by_name["reviewer"].description, "Code review specialist")
        self.assertEqual(agent_by_name["reviewer"].allowed_tools, ["file_read", "grep_search"])

    def test_build_agent_descriptions_lists_custom_agents(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent_dir = Path(tmp) / ".secheur-agent" / "agents"
            write_agent(agent_dir, "researcher", "Research deeply.", {"description": "Research specialist"})

            text = build_agent_descriptions(project_agent_dir=agent_dir, user_agent_dir=Path(tmp) / "none")

        self.assertIn("# Available Sub-Agents", text)
        self.assertIn("researcher", text)
        self.assertIn("Research specialist", text)

    def test_execute_sub_agent_returns_fork_return_prompt(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent_dir = Path(tmp) / ".secheur-agent" / "agents"
            write_agent(agent_dir, "reviewer", "Review code for $TASK", {"description": "Reviewer"})

            result = execute_sub_agent(
                "reviewer",
                "the diff",
                project_agent_dir=agent_dir,
                user_agent_dir=Path(tmp) / "none",
            )

        self.assertEqual(result["agent"], "reviewer")
        self.assertIn("Review code for the diff", result["prompt"])
        self.assertIn("return a concise report", result["prompt"])

    def test_execute_sub_agent_includes_allowed_tools_in_prompt(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent_dir = Path(tmp) / ".secheur-agent" / "agents"
            write_agent(
                agent_dir,
                "reviewer",
                "Review code for $TASK",
                {"description": "Reviewer", "allowed-tools": "file_read,grep_search"},
            )

            result = execute_sub_agent(
                "reviewer",
                "the diff",
                project_agent_dir=agent_dir,
                user_agent_dir=Path(tmp) / "none",
            )

        self.assertIn("Allowed tools: file_read, grep_search", result["prompt"])

    def test_execute_sub_agent_notes_when_no_allowed_tools_are_configured(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent_dir = Path(tmp) / ".secheur-agent" / "agents"
            write_agent(agent_dir, "custom", "Do $TASK", {"description": "Custom"})

            result = execute_sub_agent(
                "custom",
                "the task",
                project_agent_dir=agent_dir,
                user_agent_dir=Path(tmp) / "none",
            )

        self.assertIn("Allowed tools: no explicit restriction", result["prompt"])

    def test_builtin_agents_are_available_without_custom_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            agents = discover_agents(project_agent_dir=Path(tmp) / "project", user_agent_dir=Path(tmp) / "user")

        names = {agent.name for agent in agents}
        self.assertGreaterEqual(names, {"reviewer", "researcher", "planner"})

    def test_project_agent_overrides_builtin_agent(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent_dir = Path(tmp) / ".secheur-agent" / "agents"
            write_agent(agent_dir, "planner", "Custom plan for $TASK", {"description": "Custom planner"})

            result = execute_sub_agent(
                "planner",
                "the task",
                project_agent_dir=agent_dir,
                user_agent_dir=Path(tmp) / "none",
            )

        self.assertEqual(result["source"], "project")
        self.assertEqual(result["description"], "Custom planner")
        self.assertIn("Custom plan for the task", result["prompt"])

    def test_disabled_agent_is_hidden_from_runtime_descriptions_and_execution(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            agent_dir = root / ".secheur-agent" / "agents"
            write_agent(agent_dir, "custom", "Do $TASK", {"description": "Custom"})
            save_registry_state(root, {"agents": {"custom": False}})

            agents = discover_agents(project_root=root, user_agent_dir=root / "missing")
            text = build_agent_descriptions(project_root=root, user_agent_dir=root / "missing")
            result = execute_sub_agent("custom", "work", project_root=root, user_agent_dir=root / "missing")

        self.assertNotIn("custom", [agent.name for agent in agents])
        self.assertNotIn("custom", text)
        self.assertIsNone(result)

    def test_filter_tools_for_allowed_keeps_only_named_tools(self):
        schema = [
            {"type": "function", "function": {"name": "file_read", "description": "read", "parameters": {}}},
            {"type": "function", "function": {"name": "code_run", "description": "shell", "parameters": {}}},
            {"type": "function", "function": {"name": "mcp__fake__echo", "description": "echo", "parameters": {}}},
        ]

        filtered = filter_tools_for_allowed(schema, ["file_read", "mcp__fake__echo"])

        self.assertEqual([tool["function"]["name"] for tool in filtered], ["file_read", "mcp__fake__echo"])

    def test_filter_tools_for_allowed_without_allowlist_keeps_all_tools(self):
        schema = [
            {"type": "function", "function": {"name": "file_read", "description": "read", "parameters": {}}},
            {"type": "function", "function": {"name": "code_run", "description": "shell", "parameters": {}}},
        ]

        filtered = filter_tools_for_allowed(schema, None)

        self.assertEqual([tool["function"]["name"] for tool in filtered], ["file_read", "code_run"])

    def test_filter_tools_for_allowed_returns_copies(self):
        schema = [
            {"type": "function", "function": {"name": "file_read", "description": "read", "parameters": {}}},
        ]

        filtered = filter_tools_for_allowed(schema, ["file_read"])
        filtered[0]["function"]["description"] = "changed"

        self.assertEqual(schema[0]["function"]["description"], "read")


if __name__ == "__main__":
    unittest.main()
