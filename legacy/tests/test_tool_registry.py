import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import agentmain
from tool_registry import (
    MCP_REFRESH_SCHEMA,
    SUB_AGENT_SCHEMA,
    SKILL_SCHEMA,
    TOOL_SEARCH_SCHEMA,
    activate_tools,
    get_active_tool_schema,
    search_deferred_tools,
)


BASE_SCHEMA = [
    {"type": "function", "function": {"name": "code_run", "description": "run code", "parameters": {}}},
    {"type": "function", "function": {"name": "web_scan", "description": "scan browser html", "parameters": {}}},
    {"type": "function", "function": {"name": "web_execute_js", "description": "execute browser javascript", "parameters": {}}},
    {"type": "function", "function": {"name": "start_long_term_update", "description": "distill memory", "parameters": {}}},
]


class ToolRegistryTests(unittest.TestCase):
    def test_active_schema_hides_deferred_tools_and_injects_tool_search(self):
        tools = get_active_tool_schema(BASE_SCHEMA, activated=set())
        names = [tool["function"]["name"] for tool in tools]

        self.assertIn("code_run", names)
        self.assertIn("tool_search", names)
        self.assertNotIn("web_scan", names)
        self.assertNotIn("web_execute_js", names)
        self.assertNotIn("start_long_term_update", names)

    def test_cache_first_schema_keeps_deferred_tools_stable(self):
        tools = get_active_tool_schema(BASE_SCHEMA, activated=set(), cache_first=True)
        names = [tool["function"]["name"] for tool in tools]

        self.assertIn("web_scan", names)
        self.assertIn("web_execute_js", names)
        self.assertIn("start_long_term_update", names)
        self.assertNotIn("tool_search", names)

    def test_agent_uses_cache_first_schema_for_deepseek_backend(self):
        agent = SimpleNamespace(
            base_tools_schema=BASE_SCHEMA,
            activated_tools=set(),
            mcp_tool_schemas=[],
            project_root=None,
            llmclient=SimpleNamespace(
                backend=SimpleNamespace(model="deepseek-reasoner", api_base="https://api.deepseek.com")
            ),
        )

        before = [tool["function"]["name"] for tool in agentmain.SecHeurAgent.get_tools_schema(agent)]
        agent.activated_tools.add("web_scan")
        after = [tool["function"]["name"] for tool in agentmain.SecHeurAgent.get_tools_schema(agent)]

        self.assertEqual(before, after)
        self.assertIn("web_scan", before)
        self.assertNotIn("tool_search", before)

    def test_agent_keeps_deferred_schema_for_non_deepseek_backend(self):
        agent = SimpleNamespace(
            base_tools_schema=BASE_SCHEMA,
            activated_tools=set(),
            mcp_tool_schemas=[],
            project_root=None,
            llmclient=SimpleNamespace(
                backend=SimpleNamespace(model="gpt-4.1", api_base="https://api.openai.com")
            ),
        )

        names = [tool["function"]["name"] for tool in agentmain.SecHeurAgent.get_tools_schema(agent)]

        self.assertIn("tool_search", names)
        self.assertNotIn("web_scan", names)

    def test_search_deferred_tools_returns_matching_schemas(self):
        matches = search_deferred_tools(BASE_SCHEMA, "browser")
        names = [tool["function"]["name"] for tool in matches]

        self.assertEqual(names, ["web_scan", "web_execute_js"])

    def test_activate_tools_by_search_result(self):
        matches = search_deferred_tools(BASE_SCHEMA, "memory")
        activated = activate_tools(set(), matches)
        tools = get_active_tool_schema(BASE_SCHEMA, activated=activated)
        names = [tool["function"]["name"] for tool in tools]

        self.assertIn("start_long_term_update", names)
        self.assertNotIn("web_scan", names)

    def test_tool_search_schema_is_standard_function_schema(self):
        self.assertEqual(TOOL_SEARCH_SCHEMA["type"], "function")
        self.assertEqual(TOOL_SEARCH_SCHEMA["function"]["name"], "tool_search")
        self.assertIn("query", TOOL_SEARCH_SCHEMA["function"]["parameters"]["properties"])

    def test_skill_is_virtual_deferred_tool(self):
        matches = search_deferred_tools(BASE_SCHEMA, "skill")
        self.assertEqual([tool["function"]["name"] for tool in matches], ["skill"])

        activated = activate_tools(set(), matches)
        tools = get_active_tool_schema(BASE_SCHEMA, activated=activated)
        names = [tool["function"]["name"] for tool in tools]

        self.assertIn("skill", names)
        self.assertIn("skill_name", tools[names.index("skill")]["function"]["parameters"]["properties"])

    def test_skill_schema_describes_project_owned_skill_directories(self):
        description = SKILL_SCHEMA["function"]["description"]

        self.assertIn("project-owned .secheur-agent/skills/<name>/SKILL.md", description)
        self.assertIn("Legacy skill/<name>/SKILL.md and skills/<name>/SKILL.md are read for compatibility", description)
        self.assertNotIn("from skill/<name>/SKILL.md.", description)

    def test_skill_schema_documents_fork_context_isolated_execution(self):
        description = SKILL_SCHEMA["function"]["description"]

        self.assertIn("context: fork", description)
        self.assertIn("temporary sub-agent", description)
        self.assertNotIn("returns the resolved skill prompt to follow", description)

    def test_sub_agent_is_virtual_deferred_tool(self):
        matches = search_deferred_tools(BASE_SCHEMA, "subagent")
        self.assertEqual([tool["function"]["name"] for tool in matches], ["sub_agent"])

        activated = activate_tools(set(), matches)
        tools = get_active_tool_schema(BASE_SCHEMA, activated=activated)
        names = [tool["function"]["name"] for tool in tools]

        self.assertIn("sub_agent", names)
        self.assertIn("agent_type", tools[names.index("sub_agent")]["function"]["parameters"]["properties"])

    def test_sub_agent_schema_documents_cli_and_desktop_isolation(self):
        description = SUB_AGENT_SCHEMA["function"]["description"]

        self.assertIn("temporary sub-agent", description)
        self.assertIn("CLI and desktop", description)
        self.assertNotIn("In the desktop app", description)

    def test_mcp_refresh_is_virtual_deferred_tool(self):
        matches = search_deferred_tools(BASE_SCHEMA, "mcp")
        self.assertEqual([tool["function"]["name"] for tool in matches], ["mcp_refresh"])

        activated = activate_tools(set(), matches)
        tools = get_active_tool_schema(BASE_SCHEMA, activated=activated)
        names = [tool["function"]["name"] for tool in tools]

        self.assertIn("mcp_refresh", names)

    def test_mcp_refresh_description_matches_supported_config_paths(self):
        description = MCP_REFRESH_SCHEMA["function"]["description"]

        self.assertIn("settings.json", description)
        self.assertIn("settings.local.json", description)
        self.assertIn(".secheur-agent/mcp.json", description)
        self.assertIn(".mcp.json", description)

    def test_memory_search_is_always_active_tool(self):
        tools = get_active_tool_schema(BASE_SCHEMA, activated=set())
        names = [tool["function"]["name"] for tool in tools]

        self.assertIn("memory_search", names)
        self.assertIn("attack_memory_search", names)
        self.assertIn("query", tools[names.index("memory_search")]["function"]["parameters"]["properties"])

    def test_memory_search_can_be_disabled_via_settings(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            settings_dir = root / ".secheur-agent"
            settings_dir.mkdir()
            (settings_dir / "settings.json").write_text(
                json.dumps({
                    "tools": {
                        "memory_search": "false",
                        "attack_memory_search": "false",
                    }
                }),
                encoding="utf-8",
            )

            tools = get_active_tool_schema(BASE_SCHEMA, project_root=root)
            names = [tool["function"]["name"] for tool in tools]

        self.assertNotIn("memory_search", names)
        self.assertNotIn("attack_memory_search", names)

    def test_extra_tools_are_included_in_active_schema(self):
        extra = [{"type": "function", "function": {"name": "mcp__fake__echo", "description": "Echo", "parameters": {}}}]
        tools = get_active_tool_schema(BASE_SCHEMA, activated=set(), extra_tools=extra)
        names = [tool["function"]["name"] for tool in tools]

        self.assertIn("mcp__fake__echo", names)

    def test_extra_tools_are_sorted_by_name_for_prompt_cache_stability(self):
        extra_a = [
            {"type": "function", "function": {"name": "mcp__zeta__echo", "description": "Z", "parameters": {}}},
            {"type": "function", "function": {"name": "mcp__alpha__echo", "description": "A", "parameters": {}}},
        ]
        extra_b = list(reversed(extra_a))

        names_a = [tool["function"]["name"] for tool in get_active_tool_schema(BASE_SCHEMA, extra_tools=extra_a)]
        names_b = [tool["function"]["name"] for tool in get_active_tool_schema(BASE_SCHEMA, extra_tools=extra_b)]

        self.assertEqual(names_a, names_b)
        self.assertLess(names_a.index("mcp__alpha__echo"), names_a.index("mcp__zeta__echo"))

    def test_file_search_and_fetch_tools_are_virtual_deferred_tools(self):
        matches = search_deferred_tools(BASE_SCHEMA, "grep")
        self.assertEqual([tool["function"]["name"] for tool in matches], ["grep_search"])

        matches = search_deferred_tools(BASE_SCHEMA, "list files")
        self.assertEqual([tool["function"]["name"] for tool in matches], ["list_files"])

        matches = search_deferred_tools(BASE_SCHEMA, "fetch url")
        self.assertEqual([tool["function"]["name"] for tool in matches], ["web_fetch"])

    def test_string_false_disables_tools_at_runtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            settings_dir = root / ".secheur-agent"
            settings_dir.mkdir()
            (settings_dir / "settings.json").write_text(
                json.dumps({"tools": {"web_fetch": "false", "web_scan": "false"}}),
                encoding="utf-8",
            )

            active = get_active_tool_schema(BASE_SCHEMA, activated={"web_scan"}, project_root=root)
            matches = search_deferred_tools(BASE_SCHEMA, "fetch url", project_root=root)

        self.assertNotIn("web_scan", [tool["function"]["name"] for tool in active])
        self.assertEqual(matches, [])


if __name__ == "__main__":
    unittest.main()
