import json
import os
import tempfile
import unittest
from pathlib import Path

from secheur_core import SecHeurAgentHandler


SERVER_CODE = r'''
import json
import sys

for line in sys.stdin:
    req = json.loads(line)
    method = req.get("method")
    if "id" not in req:
        continue
    if method == "initialize":
        result = {"protocolVersion": "2024-11-05", "capabilities": {}, "serverInfo": {"name": "fake"}}
    elif method == "tools/list":
        result = {"tools": [{"name": "echo", "description": "Echo text", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}}}]}
    elif method == "tools/call":
        text = ((req.get("params") or {}).get("arguments") or {}).get("text", "")
        result = {"content": [{"type": "text", "text": "echo:" + text}]}
    else:
        result = {}
    print(json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": result}), flush=True)
'''


class DummyClient:
    last_tools = "cached"


class DummyParent:
    task_dir = None
    verbose = False

    def __init__(self, root):
        self.project_root = Path(root)
        self.mcp_manager = None
        self.mcp_tool_schemas = []
        self.llmclient = DummyClient()
        self.permission_mode = "default"


class FakeMcpManager:
    def __init__(self):
        self.connected = False
        self.called = False
        self.tool_name_map = {}

    def connect_all(self):
        self.connected = True

    def get_tool_schemas(self):
        return []

    def call_tool(self, tool_name, args):
        self.called = True
        return "should-not-run"


class McpIntegrationTests(unittest.TestCase):
    def _run_generator(self, gen):
        chunks = []
        while True:
            try:
                chunks.append(next(gen))
            except StopIteration as done:
                return "".join(chunks), done.value

    def test_mcp_refresh_discovers_tools_and_resets_tool_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            server = root / "fake_mcp_server.py"
            server.write_text(SERVER_CODE, encoding="utf-8")
            (root / ".mcp.json").write_text(
                json.dumps({"mcpServers": {"fake": {"command": os.sys.executable, "args": [str(server)]}}}),
                encoding="utf-8",
            )
            parent = DummyParent(root)
            parent.permission_mode = "bypassPermissions"
            handler = SecHeurAgentHandler(parent, [], cwd="./temp")

            output, outcome = self._run_generator(handler.do_mcp_refresh({}, None))
            parent.mcp_manager.disconnect_all()

        self.assertIn("mcp__fake__echo", output)
        self.assertEqual(outcome.data["status"], "success")
        self.assertEqual(parent.mcp_tool_schemas[0]["function"]["name"], "mcp__fake__echo")
        self.assertEqual(parent.llmclient.last_tools, "")

    def test_dispatch_routes_mcp_prefixed_tool(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            server = root / "fake_mcp_server.py"
            server.write_text(SERVER_CODE, encoding="utf-8")
            parent = DummyParent(root)
            parent.permission_mode = "bypassPermissions"
            handler = SecHeurAgentHandler(parent, [], cwd="./temp")
            handler._ensure_mcp_manager({"fake": {"command": os.sys.executable, "args": [str(server)]}})

            args = {"text": "hi"}
            gen = handler.dispatch("mcp__fake__echo", args, response=None)
            output, outcome = self._run_generator(gen)
            parent.mcp_manager.disconnect_all()

        self.assertIn("echo:hi", output)
        self.assertEqual(outcome.data["status"], "success")
        self.assertEqual(args, {"text": "hi"})

    def test_mcp_refresh_reports_connection_diagnostics_when_no_tools_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".mcp.json").write_text(
                json.dumps({"mcpServers": {"broken": {"command": "/definitely/missing/mcp-server"}}}),
                encoding="utf-8",
            )
            parent = DummyParent(root)
            parent.permission_mode = "bypassPermissions"
            handler = SecHeurAgentHandler(parent, [], cwd="./temp")

            output, outcome = self._run_generator(handler.do_mcp_refresh({}, None))

        self.assertIn("broken", output)
        self.assertIn("definitely/missing", output)
        self.assertIn("settings.json", output)
        self.assertIn("settings.local.json", output)
        self.assertIn(".secheur-agent/mcp.json", output)
        self.assertIn(".mcp.json", output)
        self.assertEqual(outcome.data["status"], "not_found")
        self.assertIn("diagnostics", outcome.data)

    def test_mcp_tool_is_blocked_in_plan_mode_before_manager_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = DummyParent(tmp)
            parent.permission_mode = "plan"
            parent.mcp_manager = FakeMcpManager()
            handler = SecHeurAgentHandler(parent, [], cwd="./temp")

            output, outcome = self._run_generator(handler.dispatch("mcp__fake__echo", {"text": "hi"}, response=None))

        self.assertIn("权限拒绝", output)
        self.assertEqual(outcome.data["status"], "permission_denied")
        self.assertFalse(parent.mcp_manager.connected)
        self.assertFalse(parent.mcp_manager.called)

    def test_mcp_prefixed_deny_rule_blocks_before_manager_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            settings = root / "settings.json"
            settings.write_text(
                json.dumps({"permissions": {"deny": ["mcp__fake__echo"]}}),
                encoding="utf-8",
            )
            parent = DummyParent(root)
            parent.mcp_manager = FakeMcpManager()
            handler = SecHeurAgentHandler(parent, [], cwd="./temp")
            handler.permission_settings_paths = [settings]

            output, outcome = self._run_generator(handler.dispatch("mcp__fake__echo", {"text": "hi"}, response=None))

        self.assertIn("权限拒绝", output)
        self.assertEqual(outcome.data["status"], "permission_denied")
        self.assertFalse(parent.mcp_manager.connected)
        self.assertFalse(parent.mcp_manager.called)

    def test_mcp_raw_prefixed_deny_rule_blocks_mapped_safe_tool_before_manager_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            settings = root / "settings.json"
            settings.write_text(
                json.dumps({"permissions": {"deny": ["mcp__fake.server__read/file"]}}),
                encoding="utf-8",
            )
            parent = DummyParent(root)
            parent.mcp_manager = FakeMcpManager()
            parent.mcp_manager.tool_name_map = {
                "mcp__fake_server__read_file": ("fake.server", "read/file"),
            }
            handler = SecHeurAgentHandler(parent, [], cwd="./temp")
            handler.permission_settings_paths = [settings]

            output, outcome = self._run_generator(
                handler.dispatch("mcp__fake_server__read_file", {"path": "a.txt"}, response=None)
            )

        self.assertIn("权限拒绝", output)
        self.assertEqual(outcome.data["status"], "permission_denied")
        self.assertFalse(parent.mcp_manager.connected)
        self.assertFalse(parent.mcp_manager.called)

    def test_mcp_refresh_is_blocked_in_plan_mode_before_manager_connect(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = DummyParent(tmp)
            parent.permission_mode = "plan"
            parent.mcp_manager = FakeMcpManager()
            handler = SecHeurAgentHandler(parent, [], cwd="./temp")

            output, outcome = self._run_generator(handler.do_mcp_refresh({}, None))

        self.assertIn("权限拒绝", output)
        self.assertEqual(outcome.data["status"], "permission_denied")
        self.assertFalse(parent.mcp_manager.connected)

    def test_mcp_refresh_audits_dangerous_server_command_before_connect(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".mcp.json").write_text(
                json.dumps({"mcpServers": {"danger": {"command": "rm", "args": ["-rf", "/tmp/secheur-mcp-danger"]}}}),
                encoding="utf-8",
            )
            parent = DummyParent(root)
            handler = SecHeurAgentHandler(parent, [], cwd="./temp")

            output, outcome = self._run_generator(handler.do_mcp_refresh({}, None))

        self.assertIn("需要确认", output)
        self.assertEqual(outcome.data["status"], "permission_required")
        self.assertIsNone(parent.mcp_manager)


if __name__ == "__main__":
    unittest.main()
