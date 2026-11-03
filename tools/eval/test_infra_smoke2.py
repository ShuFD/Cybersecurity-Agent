import asyncio
import copy
import io
import json
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import bridge_eval_controller as base
import private_cached_compose_field as cached


class DeleteTimeoutTests(unittest.IsolatedAsyncioTestCase):
    async def test_housekeeping_timeout_does_not_change_solving_timeout(self):
        client = base.JsonHttpClient("http://test", 300)
        class Reply(io.BytesIO):
            status = 200
            headers = {}
        with patch.object(base.urllib.request, "urlopen", side_effect=lambda *a, **k: Reply(b"{}")) as open_request:
            await client.request("DELETE", "/session/existing")
            self.assertEqual(open_request.call_args.kwargs["timeout"], 10)
            await client.request("GET", "/session/existing")
            self.assertEqual(open_request.call_args.kwargs["timeout"], 300)
            self.assertEqual(client.timeout, 300)

    async def test_actual_stalled_socket_retries_finish_and_return_failure(self):
        class Handler(BaseHTTPRequestHandler):
            def do_DELETE(self):
                time.sleep(0.2)
                self.close_connection = True
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        controller = object.__new__(base.EvaluationController)
        controller.bridge = base.BridgeClient(base.JsonHttpClient("http://127.0.0.1:" + str(server.server_port), 300))
        real_sleep = asyncio.sleep
        async def no_backoff(seconds):
            await real_sleep(0)
        started = time.monotonic()
        try:
            with patch.object(base, "SESSION_DELETE_TIMEOUT_SECONDS", 0.05), patch.object(base.asyncio, "sleep", no_backoff):
                self.assertFalse(await controller._delete_session_with_retry("stalled"))
            self.assertLess(time.monotonic() - started, 1.5)
        finally:
            await asyncio.to_thread(server.shutdown)
            server.server_close()
            worker.join(timeout=2)


class CachedComposeTests(unittest.TestCase):
    def config(self):
        return {"name": "old", "services": {name: {"build": {"context": "/original/" + name}, "container_name": name,
                "environment": {"FIXTURE": "original"}, "ports": [{"published": "41590", "target": 8080}] if name == "cache" else [],
                "networks": {"shared_net": None}} for name in cached.IMAGES},
                "networks": {"shared_net": {"name": "old-shared"}}}

    def test_only_runtime_names_and_image_binding_change(self):
        original = self.config()
        before = copy.deepcopy(original)
        result = cached.cached_config(original, "new-project", "run")
        self.assertEqual(original, before)
        for name, item in result["services"].items():
            self.assertEqual(item["image"], cached.IMAGES[name])
            self.assertEqual(item["pull_policy"], "never")
            self.assertNotIn("build", item)
            self.assertNotIn("container_name", item)
            self.assertEqual(item["environment"], original["services"][name]["environment"])
            self.assertEqual(item["ports"], original["services"][name]["ports"])
        self.assertEqual(result["networks"]["shared_net"]["name"], "new-project-shared_net")

    def test_unknown_services_external_networks_and_shared_volumes_fail_closed(self):
        cases = [self.config(), self.config(), self.config()]
        cases[0]["services"]["foreign"] = {}
        cases[1]["networks"]["shared_net"]["external"] = True
        cases[2]["services"]["cache"]["volumes"] = ["/shared:/shared"]
        for config in cases:
            with self.assertRaises(ValueError):
                cached.cached_config(config, "new-project", "run")

    def test_source_hash_checked_before_docker_or_start(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source.json"
            source.write_text(json.dumps(self.config()))
            sandbox = SimpleNamespace(target_id=cached.TARGET, run_id="run", scope={"targetUrl": "http://original:41590"})
            adapter = cached.PrivateCachedComposeField(None, sandbox, {"kind": "cached-compose", "root": root,
                "configPath": str(source), "configSha256": "wrong"})
            with patch.object(adapter, "command") as command:
                with self.assertRaisesRegex(ValueError, "source changed"):
                    adapter.start_sync()
                command.assert_not_called()

    def test_foreign_container_prevents_cleanup(self):
        sandbox = SimpleNamespace(target_id=cached.TARGET, run_id="run")
        adapter = cached.PrivateCachedComposeField(None, sandbox, {"kind": "cached-compose", "root": "/unused"})
        adapter.attempted = True
        def command(args):
            return "container-id" if args[0] == "ps" else json.dumps([{"Config": {"Labels": {cached.LABEL: "foreign"}}}])
        with patch.object(adapter, "command", side_effect=command), patch.object(adapter, "compose") as compose:
            with self.assertRaisesRegex(RuntimeError, "ownership differs"):
                adapter.stop_sync()
            compose.assert_not_called()

if __name__ == "__main__":
    unittest.main()
