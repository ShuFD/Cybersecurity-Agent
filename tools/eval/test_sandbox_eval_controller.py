import asyncio
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import sys
import types

# These tests never acquire a process lock. Production remains Linux-only.
if sys.platform == "win32":
    def unavailable_lock(*args):
        raise AssertionError("Linux process locking must not be mocked into an execution test")
    sys.modules.setdefault("fcntl", types.SimpleNamespace(flock=unavailable_lock, LOCK_EX=2, LOCK_NB=4, LOCK_UN=8))

import bridge_eval_controller as base
from sandbox_eval_controller import copy_scoped_attachments, RunSandbox, ScopedBridge, SandboxEvaluationController


class ScopedAttachmentsTests(unittest.TestCase):
    def test_only_pinned_current_files_are_copied(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            (source / "current.txt").write_bytes(b"current")
            (source / "historical-answer.txt").write_bytes(b"never exposed")
            scope = {"attachmentRoot": str(source), "attachments": [
                {"path": "current.txt", "sha256": hashlib.sha256(b"current").hexdigest()}]}
            records = copy_scoped_attachments(scope, root / "worker")
            self.assertEqual([item["path"] for item in records], ["current.txt"])
            self.assertEqual(list((root / "worker").iterdir()), [root / "worker" / "current.txt"])

    def test_wrong_hash_and_parent_paths_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "current").write_bytes(b"modified")
            for index, item in enumerate([
                {"path": "current", "sha256": "0" * 64},
                {"path": "../other", "sha256": "0" * 64},
            ]):
                with self.assertRaises(ValueError):
                    copy_scoped_attachments({"attachmentRoot": str(root), "attachments": [item]}, root / str(index))


    @unittest.skipIf(sys.platform == "win32", "POSIX executable bit requires the Linux environment gate")
    def test_preserves_executable_mode_without_granting_write_access(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            script = source / "public-tool"
            script.write_bytes(b"#!/bin/sh\nprintf synthetic-mode-ok")
            script.chmod(0o755)
            scope = {"attachmentRoot": str(source), "attachments": [
                {"path": "public-tool", "sha256": hashlib.sha256(script.read_bytes()).hexdigest(), "executable": True}]}
            records = copy_scoped_attachments(scope, root / "worker")
            self.assertTrue(records[0]["executable"])
            self.assertEqual((root / "worker/public-tool").stat().st_mode & 0o777, 0o555)
            import subprocess
            self.assertEqual(subprocess.check_output([str(root / "worker/public-tool")]), b"synthetic-mode-ok")
            scope["attachments"][0]["executable"] = False
            with self.assertRaisesRegex(ValueError, "executable mode"):
                copy_scoped_attachments(scope, root / "another-worker")



def config(root):
    return base.ControllerConfig(field_base="http://field", bridge_base="http://must-never-be-used",
        lanes=(base.Lane(0, (1,)), base.Lane(1, (2,))), debug_profile=7,
        wall_timeout_seconds=3000, poll_seconds=0.1, request_timeout_seconds=1,
        work_root=root / "work", state_root=root / "state", execution_mode="PLAN_MULTI",
        execution_capacity=2, controller_concurrency=2, max_turns=220, memory_reference_enabled=False)


class FakeHttp:
    def __init__(self, run):
        self.run = run
        self.requests = []

    async def request(self, method, path, payload=None, query=None):
        self.requests.append((path, payload))
        await asyncio.sleep(0)
        return {"sessionId": self.run}


class ScopedControllerTests(unittest.IsolatedAsyncioTestCase):
    async def test_offline_field_identity_maps_without_reusing_executor_run(self):
        from sandbox_eval_controller import ScopedField
        class Field:
            async def start(self, target, run):
                return {"ok": True, "target_id": target, "deploy_mode": "offline-assets",
                        "target_url": "", "run_id": "field-offline"}
            async def stop(self, target, run):
                return {"run_id": run}
        field = ScopedField(Field(), None)
        result = await field.start("one", "private-execution")
        self.assertEqual(result["run_id"], "private-execution")
        self.assertEqual(result["field_run_id"], "field-offline")
        self.assertEqual((await field.stop("one", "private-execution"))["run_id"], "field-offline")

    async def test_unadmitted_bridge_never_falls_back_to_host(self):
        with tempfile.TemporaryDirectory() as temporary:
            sandbox = RunSandbox({"privateRoot": temporary, "scopes": {"one": {}}}, config(Path(temporary)), "one", "run")
            bridge = ScopedBridge(sandbox)
            with self.assertRaisesRegex(RuntimeError, "admission"):
                await bridge.status()

    async def test_concurrent_lanes_keep_distinct_clients_and_force_private_profile(self):
        with tempfile.TemporaryDirectory() as temporary:
            settings = {"privateRoot": temporary, "mode": "progressive", "scopes": {"one": {}, "two": {}},
                        "model": {"provider": "fixture", "model": "same"}, "image": "pinned", "toolchainDigest": "fixed"}
            cfg = config(Path(temporary))
            controller = SandboxEvaluationController(cfg, object(), object(), settings)
            http_clients = {}

            async def fake_run(child, lane, target_id, profile, run_id):
                sandbox = child.bridge.sandbox
                http = FakeHttp(run_id)
                http_clients[run_id] = http
                sandbox.bridge = base.BridgeClient(http)
                sandbox.sandbox = {"runId": run_id}
                session = await child.bridge.create_session(profile, Path("/host/history"),
                    execution_mode="PLAN_MULTI", execution_capacity=2, run_id=run_id, target_id=target_id)
                await child.bridge.submit(session, "current", profile)
                return {"recordStatus": "not_saved", "sessionCleanupStatus": "failed", "sessionId": session}

            with patch.object(base.EvaluationController, "_run_one", fake_run):
                results = await asyncio.gather(controller._run_one(cfg.lanes[0], "one", 1, "run-one"),
                                               controller._run_one(cfg.lanes[1], "two", 2, "run-two"))
            self.assertIsNone(controller.bridge)
            self.assertEqual([row["sessionId"] for row in results], ["run-one", "run-two"])
            for run_id, client in http_clients.items():
                self.assertEqual(client.requests[0][1]["runId"], run_id)
                self.assertEqual(client.requests[0][1]["cwd"], "/workspace")
                self.assertTrue(all(payload["llmNo"] == 0 for _, payload in client.requests))
                self.assertFalse(client.requests[0][1]["memoryReferenceEnabled"])

    async def test_scope_checks_identity_and_endpoint_before_creating_worker(self):
        with tempfile.TemporaryDirectory() as temporary:
            sandbox = RunSandbox({"privateRoot": temporary, "scopes": {"one": {"targetUrl": "tcp://host:9000"}}},
                                 config(Path(temporary)), "one", "run-one")
            with self.assertRaisesRegex(ValueError, "identity"):
                await sandbox.start({"run_id": "another", "target_url": "tcp://host:9000"})
            with self.assertRaisesRegex(ValueError, "endpoint"):
                await sandbox.start({"run_id": "run-one", "target_url": "tcp://host:22"})
            self.assertFalse(sandbox.root.exists())

    async def test_prompt_mapping_cannot_expand_network_scope(self):
        with tempfile.TemporaryDirectory() as temporary:
            scope = {"attachmentRoot": "/official/current/assets", "targetUrl": "tcp://host:9000",
                     "routes": [{"host": "host", "port": 9000, "listenPort": 18080}]}
            sandbox = RunSandbox({"privateRoot": temporary, "scopes": {"one": scope}}, config(Path(temporary)), "one", "run")
            sandbox.sandbox = {"gatewayAddress": "172.30.0.2"}
            result = sandbox.rewrite_prompt("/official/current/assets/input; host:9000; unrelated:22")
            self.assertEqual(result, "/attachments/input; 172.30.0.2:18080; unrelated:22")
            self.assertEqual(len(scope["routes"]), 1)


    async def test_host_and_mcp_aliases_map_only_the_pinned_question(self):
        with tempfile.TemporaryDirectory() as temporary:
            scope = {"attachmentRoot": "/official/current/assets", "routes": [],
                     "promptAttachmentRoots": ["/work/ctf-field/current/assets",
                                               "/home/shared/eval-runner/agent-work/ctf-field/current/assets"]}
            sandbox = RunSandbox({"privateRoot": temporary, "scopes": {"one": scope}}, config(Path(temporary)), "one", "run")
            sandbox.sandbox = {"gatewayAddress": "172.30.0.2"}
            prompt = "/work/ctf-field/current/assets/input; /home/shared/eval-runner/agent-work/ctf-field/current/assets/; /work/ctf-field/current/assets-other/input; /work/ctf-field/other/assets/input"
            self.assertEqual(sandbox.rewrite_prompt(prompt), "/attachments/input; /attachments/; /work/ctf-field/current/assets-other/input; /work/ctf-field/other/assets/input")
            self.assertEqual(scope["routes"], [])


    async def test_replaces_only_the_staging_added_intercode_host_hint(self):
        with tempfile.TemporaryDirectory() as temporary:
            scope = {"attachmentRoot": "/official/current/assets", "routes": []}
            sandbox = RunSandbox({"privateRoot": temporary, "scopes": {"intercode-ctf/17": scope}}, config(Path(temporary)), "intercode-ctf/17", "run")
            sandbox.sandbox = {"gatewayAddress": "172.30.0.2"}
            hint = 'Use /home/shared/bench-harness/intercode-ctf/icctl exec intercode-ctf/17 "COMMAND" to work inside the official task environment.'
            original = "synthetic original question; another /home/shared/bench-harness/intercode-ctf/icctl reference. " + hint
            result = sandbox.rewrite_prompt(original)
            self.assertTrue(result.startswith("synthetic original question; another /home/shared/bench-harness/intercode-ctf/icctl reference."))
            self.assertNotIn(hint, result)
            self.assertIn("native bash tool in /workspace", result)
            self.assertEqual(scope["routes"], [])

    async def test_authoritative_manifest_describes_only_current_public_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            scope = {"attachmentRoot": "/official/current/assets", "routes": [],
                     "attachments": [{"path": "public-input", "sha256": "0" * 64}]}
            sandbox = RunSandbox({"privateRoot": temporary, "scopes": {"one": scope}}, config(Path(temporary)), "one", "run")
            sandbox.sandbox = {"gatewayAddress": "172.30.0.2"}
            result = sandbox.rewrite_prompt("synthetic original question")
            self.assertIn('Declared public input files: ["public-input"]', result)
            self.assertTrue(result.startswith("synthetic original question"))


    async def test_gateway_metadata_export_preserves_raw_reference_and_unknown_role(self):
        from sandbox_eval_controller import export_model_gateway_diagnostics
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifact = root / "artifact"
            artifact.mkdir()
            rows = [{"event": "model_gateway_request", "requestId": "model-1", "status": "started"},
                    {"event": "model_gateway_request", "requestId": "model-1", "status": "upstream_error", "phase": "upstream_body", "receivedBytes": 42}]
            content = "\n".join(json.dumps(row) for row in rows).encode()
            (root / "model-requests.jsonl").write_bytes(content)
            metrics = export_model_gateway_diagnostics(str(root), artifact)
            self.assertEqual(metrics["requests"], 1)
            self.assertEqual(metrics["statusCounts"]["upstream_error"], 1)
            self.assertEqual(metrics["roleMapping"], "unknown")
            self.assertEqual(metrics["sha256"], hashlib.sha256(content).hexdigest())
            self.assertEqual((artifact / metrics["file"]).read_bytes(), content)

    async def test_missing_gateway_journal_is_unknown_not_zero_failures(self):
        from sandbox_eval_controller import export_model_gateway_diagnostics
        with tempfile.TemporaryDirectory() as temporary:
            self.assertEqual(export_model_gateway_diagnostics(temporary, Path(temporary)),
                             {"status": "unknown", "reason": "no_gateway_journal"})


if __name__ == "__main__":
    unittest.main()
