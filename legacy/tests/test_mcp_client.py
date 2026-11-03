import json
import os
import threading
import tempfile
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from mcp_client import McpManager, load_mcp_configs


SERVER_CODE = r'''
import json
import os
import sys

for line in sys.stdin:
    req = json.loads(line)
    method = req.get("method")
    if "id" not in req:
        continue
    if method == "initialize":
        result = {"protocolVersion": "2024-11-05", "capabilities": {}, "serverInfo": {"name": "fake"}}
    elif method == "tools/list":
        result = {
            "tools": [
                {
                    "name": "echo",
                    "description": "Echo text",
                    "inputSchema": {
                        "type": "object",
                        "properties": {"text": {"type": "string"}},
                        "required": ["text"]
                    }
                }
            ]
        }
    elif method == "tools/call":
        params = req.get("params") or {}
        text = (params.get("arguments") or {}).get("text", "")
        if text == "__cwd__":
            result = {"content": [{"type": "text", "text": os.getcwd()}]}
        else:
            result = {"content": [{"type": "text", "text": "echo:" + text}]}
    else:
        result = {}
    print(json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": result}), flush=True)
'''

HANGING_SERVER_CODE = r'''
import json
import sys
import time

for line in sys.stdin:
    req = json.loads(line)
    method = req.get("method")
    if "id" not in req:
        continue
    if method == "initialize":
        result = {"protocolVersion": "2024-11-05", "capabilities": {}, "serverInfo": {"name": "hanging"}}
        print(json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": result}), flush=True)
    elif method == "tools/list":
        time.sleep(60)
'''


class McpClientTests(unittest.TestCase):
    def _start_http_mcp_server(self):
        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            seen_headers = []

            def log_message(self, _format, *_args):
                pass

            def _send_json(self, payload, status=200, extra_headers=None):
                body = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                for key, value in (extra_headers or {}).items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(body)

            def _send_sse(self, payload, extra_headers=None):
                body = f"event: message\ndata: {json.dumps(payload)}\n\n".encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(body)))
                for key, value in (extra_headers or {}).items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                request = json.loads(self.rfile.read(length).decode("utf-8"))
                method = request.get("method")
                Handler.seen_headers.append({
                    "method": method,
                    "session": self.headers.get("Mcp-Session-Id"),
                    "protocol": self.headers.get("MCP-Protocol-Version"),
                })
                req_id = request.get("id")
                if method == "initialize":
                    self._send_json(
                        {
                            "jsonrpc": "2.0",
                            "id": req_id,
                            "result": {
                                "protocolVersion": "2025-11-25",
                                "capabilities": {},
                                "serverInfo": {"name": "http-fake"},
                            },
                        },
                        extra_headers={"Mcp-Session-Id": "session-123"},
                    )
                elif method == "notifications/initialized":
                    self.send_response(202)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                elif method == "tools/list":
                    self._send_json({
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "result": {
                            "tools": [
                                {
                                    "name": "echo",
                                    "description": "Echo text over HTTP",
                                    "inputSchema": {
                                        "type": "object",
                                        "properties": {"text": {"type": "string"}},
                                    },
                                }
                            ]
                        },
                    })
                elif method == "tools/call":
                    text = ((request.get("params") or {}).get("arguments") or {}).get("text", "")
                    self._send_sse({
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "result": {"content": [{"type": "text", "text": "http-echo:" + text}]},
                    })
                else:
                    self._send_json({"jsonrpc": "2.0", "id": req_id, "result": {}})

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return server, Handler

    def test_loads_mcp_configs_from_settings_and_mcp_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "settings.json").write_text(
                json.dumps({"mcpServers": {"settings": {"command": "cmd-settings"}}}),
                encoding="utf-8",
            )
            (root / ".secheur-agent").mkdir()
            (root / ".secheur-agent" / "mcp.json").write_text(
                json.dumps({"mcpServers": {"a": {"command": "cmd-a"}}}),
                encoding="utf-8",
            )
            (root / ".mcp.json").write_text(
                json.dumps({"mcpServers": {"b": {"command": "cmd-b"}}}),
                encoding="utf-8",
            )

            configs = load_mcp_configs(project_root=root, user_settings_path=root / "missing.json")

        self.assertEqual(set(configs), {"settings", "a", "b"})

    def test_loads_streamable_http_mcp_config_from_settings(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "settings.json").write_text(
                json.dumps({"mcpServers": {"remote": {"url": "http://127.0.0.1:8765/mcp"}}}),
                encoding="utf-8",
            )

            configs = load_mcp_configs(project_root=root)

        self.assertEqual(configs, {"remote": {"url": "http://127.0.0.1:8765/mcp"}})

    def test_connects_lists_and_calls_stdio_server(self):
        with tempfile.TemporaryDirectory() as tmp:
            server = Path(tmp) / "fake_mcp_server.py"
            server.write_text(SERVER_CODE, encoding="utf-8")
            manager = McpManager(
                {
                    "fake": {
                        "command": os.sys.executable,
                        "args": [str(server)],
                    }
                },
                timeout=5,
            )

            manager.connect_all()
            schemas = manager.get_tool_schemas()
            result = manager.call_tool("mcp__fake__echo", {"text": "hello"})
            manager.disconnect_all()

        self.assertEqual(schemas[0]["function"]["name"], "mcp__fake__echo")
        self.assertEqual(result, "echo:hello")

    def test_connects_lists_and_calls_streamable_http_server(self):
        server, handler = self._start_http_mcp_server()
        try:
            url = f"http://127.0.0.1:{server.server_port}/mcp"
            manager = McpManager({"remote": {"url": url}}, timeout=2)

            manager.connect_all()
            schemas = manager.get_tool_schemas()
            result = manager.call_tool("mcp__remote__echo", {"text": "hello"})
            diagnostics = manager.get_diagnostics()
            manager.disconnect_all()
        finally:
            server.shutdown()
            server.server_close()

        self.assertEqual(schemas[0]["function"]["name"], "mcp__remote__echo")
        self.assertEqual(result, "http-echo:hello")
        self.assertEqual(diagnostics["remote"]["transport"], "http")
        post_initialize = [item for item in handler.seen_headers if item["method"] != "initialize"]
        self.assertTrue(post_initialize)
        self.assertTrue(all(item["session"] == "session-123" for item in post_initialize))
        self.assertTrue(all(item["protocol"] == "2025-11-25" for item in post_initialize))

    def test_tool_schemas_are_sorted_by_prefixed_name_for_prompt_cache_stability(self):
        manager = McpManager({}, timeout=5)
        manager.tools = [
            {"serverName": "zeta", "name": "beta", "description": "", "inputSchema": {"type": "object"}},
            {"serverName": "alpha", "name": "zulu", "description": "", "inputSchema": {"type": "object"}},
            {"serverName": "alpha", "name": "echo", "description": "", "inputSchema": {"type": "object"}},
        ]

        schemas = manager.get_tool_schemas()

        self.assertEqual(
            [schema["function"]["name"] for schema in schemas],
            ["mcp__alpha__echo", "mcp__alpha__zulu", "mcp__zeta__beta"],
        )

    def test_tool_schema_safe_name_maps_back_to_raw_mcp_names(self):
        class FakeConnection:
            def __init__(self):
                self.calls = []

            def call_tool(self, tool_name, args):
                self.calls.append((tool_name, args))
                return "ok"

            def close(self):
                pass

        manager = McpManager({}, timeout=5)
        conn = FakeConnection()
        manager.connections = {"fake.server": conn}
        manager.tools = [
            {
                "serverName": "fake.server",
                "name": "search/files",
                "description": "",
                "inputSchema": {"type": "object"},
            },
        ]

        schemas = manager.get_tool_schemas()
        result = manager.call_tool("mcp__fake_server__search_files", {"query": "x"})

        self.assertEqual(schemas[0]["function"]["name"], "mcp__fake_server__search_files")
        self.assertEqual(result, "ok")
        self.assertEqual(conn.calls, [("search/files", {"query": "x"})])

    def test_tool_schema_safe_name_removes_component_separator_collisions(self):
        manager = McpManager({}, timeout=5)
        manager.tools = [
            {"serverName": "fake__server", "name": "read__file", "description": "", "inputSchema": {"type": "object"}},
        ]

        schemas = manager.get_tool_schemas()

        self.assertEqual(schemas[0]["function"]["name"], "mcp__fake_server__read_file")

    def test_tool_schema_safe_name_truncates_long_names_and_preserves_mapping(self):
        class FakeConnection:
            def __init__(self):
                self.calls = []

            def call_tool(self, tool_name, args):
                self.calls.append((tool_name, args))
                return "ok"

            def close(self):
                pass

        raw_server = "server-" + ("a" * 80)
        raw_tool = "tool-" + ("b" * 80)
        manager = McpManager({}, timeout=5)
        conn = FakeConnection()
        manager.connections = {raw_server: conn}
        manager.tools = [
            {"serverName": raw_server, "name": raw_tool, "description": "", "inputSchema": {"type": "object"}},
        ]

        schemas = manager.get_tool_schemas()
        schema_name = schemas[0]["function"]["name"]
        result = manager.call_tool(schema_name, {"query": "x"})

        self.assertLessEqual(len(schema_name), 64)
        self.assertTrue(schema_name.startswith("mcp__"))
        self.assertEqual(result, "ok")
        self.assertEqual(conn.calls, [(raw_tool, {"query": "x"})])

    def test_connect_uses_configured_working_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            server = root / "fake_mcp_server.py"
            workspace = root / "workspace"
            workspace.mkdir()
            server.write_text(SERVER_CODE, encoding="utf-8")
            manager = McpManager(
                {
                    "fake": {
                        "command": os.sys.executable,
                        "args": [str(server)],
                        "cwd": str(workspace),
                    }
                },
                timeout=5,
            )

            manager.connect_all()
            result = manager.call_tool("mcp__fake__echo", {"text": "__cwd__"})
            manager.disconnect_all()

        self.assertEqual(Path(result).resolve(), workspace.resolve())

    def test_disconnect_all_clears_runtime_state_and_allows_reconnect(self):
        with tempfile.TemporaryDirectory() as tmp:
            server = Path(tmp) / "fake_mcp_server.py"
            server.write_text(SERVER_CODE, encoding="utf-8")
            manager = McpManager(
                {
                    "fake": {
                        "command": os.sys.executable,
                        "args": [str(server)],
                    }
                },
                timeout=5,
            )

            manager.connect_all()
            self.assertTrue(manager.get_tool_schemas())
            manager.disconnect_all()
            self.assertFalse(manager.connected)
            self.assertEqual(manager.get_tool_schemas(), [])
            manager.connect_all()
            schemas = manager.get_tool_schemas()
            result = manager.call_tool("mcp__fake__echo", {"text": "again"})
            manager.disconnect_all()

        self.assertEqual(schemas[0]["function"]["name"], "mcp__fake__echo")
        self.assertEqual(result, "echo:again")

    def test_records_connection_failure_diagnostics(self):
        manager = McpManager(
            {"broken": {"command": "/definitely/missing/mcp-server"}},
            timeout=1,
        )

        manager.connect_all()
        diagnostics = manager.get_diagnostics()

        self.assertEqual(diagnostics["broken"]["status"], "error")
        self.assertIn("/definitely/missing/mcp-server", diagnostics["broken"]["message"])

    def test_connect_timeout_applies_when_server_stops_writing_stdout(self):
        with tempfile.TemporaryDirectory() as tmp:
            server = Path(tmp) / "hanging_mcp_server.py"
            server.write_text(HANGING_SERVER_CODE, encoding="utf-8")
            manager = McpManager(
                {
                    "hanging": {
                        "command": os.sys.executable,
                        "args": [str(server)],
                    }
                },
                timeout=0.2,
            )

            started = time.perf_counter()
            manager.connect_all()
            elapsed = time.perf_counter() - started
            diagnostics = manager.get_diagnostics()
            manager.disconnect_all()

        self.assertEqual(diagnostics["hanging"]["status"], "error")
        self.assertIn("timed out", diagnostics["hanging"]["message"])
        self.assertEqual(diagnostics["hanging"]["timeout"], 0.2)
        self.assertLess(elapsed, 1.0)

    def test_server_config_timeout_overrides_manager_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            server = Path(tmp) / "hanging_mcp_server.py"
            server.write_text(HANGING_SERVER_CODE, encoding="utf-8")
            manager = McpManager(
                {
                    "hanging": {
                        "command": os.sys.executable,
                        "args": [str(server)],
                        "timeout": 0.2,
                    }
                },
                timeout=5,
            )

            started = time.perf_counter()
            manager.connect_all()
            elapsed = time.perf_counter() - started
            diagnostics = manager.get_diagnostics()
            manager.disconnect_all()

        self.assertEqual(diagnostics["hanging"]["status"], "error")
        self.assertIn("timed out", diagnostics["hanging"]["message"])
        self.assertLess(elapsed, 1.0)

    def test_global_mcp_timeout_from_settings_applies_to_servers_without_timeout(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "settings.json").write_text(
                json.dumps(
                    {
                        "mcp": {"timeout": 0.3},
                        "mcpServers": {
                            "defaulted": {"command": "cmd-defaulted"},
                            "explicit": {"command": "cmd-explicit", "timeout": 0.7},
                        },
                    }
                ),
                encoding="utf-8",
            )

            configs = load_mcp_configs(project_root=root)

        self.assertEqual(configs["defaulted"]["timeout"], 0.3)
        self.assertEqual(configs["explicit"]["timeout"], 0.7)

    def test_global_mcp_timeout_legacy_key_applies_to_servers_without_timeout(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "settings.json").write_text(
                json.dumps(
                    {
                        "mcpTimeout": 0.4,
                        "mcpServers": {"fake": {"command": "cmd-fake"}},
                    }
                ),
                encoding="utf-8",
            )

            configs = load_mcp_configs(project_root=root)

        self.assertEqual(configs["fake"]["timeout"], 0.4)

    def test_connect_all_reloads_when_mcp_config_file_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            server = root / "fake_mcp_server.py"
            server.write_text(SERVER_CODE, encoding="utf-8")
            config_path = root / ".mcp.json"
            config_path.write_text(
                json.dumps({"mcpServers": {"broken": {"command": "/definitely/missing/mcp-server"}}}),
                encoding="utf-8",
            )
            manager = McpManager(project_root=root, timeout=5)

            manager.connect_all()
            self.assertEqual(manager.get_tool_schemas(), [])
            config_path.write_text(
                json.dumps({"mcpServers": {"fake": {"command": os.sys.executable, "args": [str(server)]}}}),
                encoding="utf-8",
            )
            manager.connect_all()
            schemas = manager.get_tool_schemas()
            manager.disconnect_all()

        self.assertEqual(schemas[0]["function"]["name"], "mcp__fake__echo")

    def test_connect_all_retries_failed_connections_with_same_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            server = root / "eventual_mcp_server.py"
            manager = McpManager(
                {
                    "fake": {
                        "command": os.sys.executable,
                        "args": [str(server)],
                    }
                },
                timeout=1,
            )

            manager.connect_all()
            self.assertEqual(manager.get_tool_schemas(), [])
            self.assertEqual(manager.get_diagnostics()["fake"]["status"], "error")

            server.write_text(SERVER_CODE, encoding="utf-8")
            manager.connect_all()
            schemas = manager.get_tool_schemas()
            manager.disconnect_all()

        self.assertEqual(schemas[0]["function"]["name"], "mcp__fake__echo")


if __name__ == "__main__":
    unittest.main()
