import asyncio
import tempfile
import unittest
from pathlib import Path

from aiohttp import ClientSession, web

from frontends import desktop_bridge


class DesktopBridgeHttpSmokeTests(unittest.TestCase):
    def test_create_app_http_smoke_covers_core_bridge_routes(self):
        async def run_case(root: Path):
            old_root = desktop_bridge.manager.project_root
            old_config = dict(desktop_bridge.manager.config)
            old_sessions = desktop_bridge.manager.sessions
            old_active = desktop_bridge.manager.active_session_id

            runner = None
            site = None
            try:
                desktop_bridge.manager.project_root = root
                desktop_bridge.manager.config = {}
                desktop_bridge.manager.sessions = {}
                desktop_bridge.manager.active_session_id = None

                app = desktop_bridge.create_app()
                runner = web.AppRunner(app)
                await runner.setup()
                site = web.TCPSite(runner, "127.0.0.1", 0)
                await site.start()
                port = site._server.sockets[0].getsockname()[1]
                base = f"http://127.0.0.1:{port}"

                async with ClientSession() as client:
                    async def req(method, path, **kwargs):
                        async with client.request(method, base + path, **kwargs) as response:
                            text = await response.text()
                            self.assertLess(response.status, 400, msg=f"{method} {path}: {text}")
                            if response.content_type == "application/json":
                                return await response.json()
                            return text

                    index_html = await req("GET", "/")
                    self.assertIn("SecHeur Agent", index_html)
                    status = await req("GET", "/status")
                    self.assertTrue(status["ok"])
                    self.assertTrue(status["ready"])
                    sessions_payload = await req("GET", "/sessions")
                    self.assertEqual(sessions_payload["sessions"], [])
                    self.assertIsNone(sessions_payload["activeSessionId"])
                    self.assertIn("config", await req("GET", "/config"))
                    self.assertIn("mcpServers", await req("GET", "/registry"))
                    self.assertIn("profiles", await req("GET", "/model-profiles"))
                    self.assertIn("secheurAgent", await req("GET", "/secheur-web.js"))

                    session_payload = await req("POST", "/session/new", json={"cwd": str(root), "mcp_servers": []})
                    session_id = session_payload["sessionId"]
                    self.assertIn("sessions", await req("GET", "/sessions"))
                    self.assertIn("session", await req("GET", f"/session/{session_id}"))
                    self.assertIn("messages", await req("GET", f"/session/{session_id}/messages?after=0&limit=5"))
                    self.assertTrue((await req("POST", f"/session/{session_id}/model", json={"llmNo": 0}))["ok"])
                    self.assertTrue((await req("POST", f"/session/{session_id}/permission-mode", json={"permissionMode": "default"}))["ok"])
                    self.assertIn("ok", await req("POST", f"/session/{session_id}/cancel", json={}))
                    self.assertTrue((await req("DELETE", f"/session/{session_id}"))["ok"])

                    tmp_name = "http-smoke-temp"
                    self.assertTrue((await req("POST", "/mcp-config", json={
                        "config": {"name": tmp_name, "command": "echo", "args": ["ok"]},
                    }))["ok"])
                    self.assertTrue((await req("POST", "/skill-config", json={
                        "config": {"name": tmp_name, "body": "# Smoke Skill\n\n临时测试。"},
                    }))["ok"])
                    self.assertTrue((await req("POST", "/agent-config", json={
                        "config": {"name": tmp_name, "body": "# Smoke Agent\n\n临时测试。"},
                    }))["ok"])
                    self.assertTrue((await req("DELETE", f"/mcp-config/{tmp_name}"))["ok"])
                    self.assertTrue((await req("DELETE", f"/skill-config/{tmp_name}"))["ok"])
                    self.assertTrue((await req("DELETE", f"/agent-config/{tmp_name}"))["ok"])
            finally:
                if site is not None:
                    await site.stop()
                if runner is not None:
                    await runner.cleanup()
                desktop_bridge.manager.project_root = old_root
                desktop_bridge.manager.config = old_config
                desktop_bridge.manager.sessions = old_sessions
                desktop_bridge.manager.active_session_id = old_active

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            root.mkdir()
            asyncio.run(run_case(root))


if __name__ == "__main__":
    unittest.main()
