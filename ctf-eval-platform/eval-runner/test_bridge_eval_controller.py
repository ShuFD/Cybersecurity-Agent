import argparse
import asyncio
import io
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import AsyncMock, patch


MODULE_PATH = Path(__file__).with_name(
    os.environ.get("BRIDGE_EVAL_CONTROLLER_MODULE", "bridge_eval_controller.py")
)
SPEC = importlib.util.spec_from_file_location("bridge_eval_controller", MODULE_PATH)
controller = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = controller
SPEC.loader.exec_module(controller)


def make_config(root: Path):
    return controller.ControllerConfig(
        field_base="http://field.invalid",
        bridge_base="http://bridge.invalid",
        lanes=(
            controller.Lane(0, (1, 4)),
            controller.Lane(1, (2, 5)),
            controller.Lane(2, (3, 6)),
        ),
        debug_profile=7,
        wall_timeout_seconds=9000,
        poll_seconds=0.001,
        request_timeout_seconds=1,
        work_root=root / "work",
        state_root=root / "state",
    )


def make_seven_lane_config(root: Path):
    return controller.ControllerConfig(
        field_base="http://field.invalid",
        bridge_base="http://bridge.invalid",
        lanes=tuple(controller.Lane(index, (index + 1,)) for index in range(7)),
        debug_profile=0,
        wall_timeout_seconds=9000,
        poll_seconds=0.001,
        request_timeout_seconds=1,
        work_root=root / "work",
        state_root=root / "state",
    )


class FakeField:
    def __init__(self, targets):
        self.targets = targets
        self.started = []
        self.recorded = []
        self.stopped = []

    async def health(self):
        return {"ok": True}

    async def untested_targets(self):
        return [
            row for row in self.targets
            if row.get("ready") and str(row.get("status") or "untested") == "untested"
        ]

    async def all_targets(self):
        return list(self.targets)

    async def start(self, target_id, run_id):
        self.started.append((target_id, run_id))
        return {"ok": True, "target_id": target_id, "run_id": run_id}

    async def prompt(self, target_id):
        return {"ok": True, "target_id": target_id, "prompt": f"Target ID:\n{target_id}"}

    async def record(self, payload):
        self.recorded.append(dict(payload))
        return {"ok": True, "record": dict(payload)}

    async def stop(self, target_id, run_id):
        self.stopped.append((target_id, run_id))
        return {"ok": True}


class FakeHttp:
    def __init__(self, payload):
        self.payload = payload
        self.requests = []

    async def request(self, method, path, payload=None, query=None):
        self.requests.append((method, path, payload, query))
        return self.payload


class FakeBridge:
    def __init__(self, terminal=None):
        defaults = {
            "status": "idle",
            "taskKind": "ctf",
            "terminalReason": "hard_turn_limit",
            "verificationState": "not_attempted",
            "outcome": "failed",
        }
        defaults.update({
            "executionMode": "direct",
            "executionCapacity": 1,
            "legacyPlanningMode": "off",
        })
        self.terminal = {**defaults, **(terminal or {})}
        self.created_profiles = []
        self.created_identities = []
        self.target_sessions = []
        self.probed_profiles = []
        self.probe_sessions = set()
        self.deleted = []
        self.verified_cancellations = []
        self.submits = []

    async def status(self):
        return {"ready": True}

    async def profiles(self):
        return [
            {
                "id": i,
                "provider": f"provider-{i}",
                "model": f"model-{i}",
                "name": f"provider-{i}/model-{i}",
            }
            for i in range(8)
        ]

    async def create_session(
        self,
        profile,
        cwd,
        *,
        execution_mode="DIRECT",
        execution_capacity=1,
        target_id=None,
        run_id=None,
    ):
        self.created_profiles.append(profile)
        self.created_identities.append((target_id, run_id))
        session_id = f"eval-{len(self.target_sessions) + 1}"
        self.target_sessions.append(session_id)
        return session_id

    async def create_probe_session(self, profile, cwd):
        self.probed_profiles.append(profile)
        session_id = f"probe-{profile}"
        self.probe_sessions.add(session_id)
        return session_id

    async def submit(self, session_id, prompt, profile, *, web_verbs_enabled=False):
        self.submits.append((session_id, prompt, profile, web_verbs_enabled))
        return {"ok": True, "sessionId": session_id}

    async def plugins_catalog(self):
        return {"plugins": [{"id": "progressive-planning", "effectiveEnabled": False}]}

    async def snapshot(self, session_id):
        if session_id in self.probe_sessions:
            return {"status": "idle", "taskKind": "general", "lastError": ""}
        return dict(self.terminal)

    async def export(self, session_id):
        return {"session": dict(self.terminal), "messages": [], "runtimeLog": []}

    async def cancel_timeout(self, session_id):
        raise AssertionError("timeout not expected")

    async def cancel_verified(self, session_id):
        self.verified_cancellations.append(session_id)
        self.terminal.update({
            "status": "cancelled",
            "cancelSource": "bridge_eval_controller",
            "cancelReason": "trusted_verifier_success",
        })
        return {"ok": True, "sessionId": session_id, "status": "cancelled"}

    async def delete(self, session_id):
        self.deleted.append(session_id)
        return {"ok": True}


class TraceBridge:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def runtime_log(self, session_id, *, after_event_id=None, after_message_id=None, log_epoch=None):
        self.calls.append((session_id, after_event_id, after_message_id, log_epoch))
        if not self.responses:
            return {
                "incremental": True,
                "resetRequired": False,
                "logEpoch": log_epoch or "epoch-1",
                "eventCursor": after_event_id or 0,
                "messageCursor": after_message_id or 0,
                "events": [],
            }
        return self.responses.pop(0)


class PlanningTraceBridge:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def planning_trace(self, session_id, *, cursor=None, limit=100):
        self.calls.append((session_id, cursor, limit))
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


class ControllerTests(unittest.TestCase):
    def test_config_accepts_seven_single_profile_lanes(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = make_seven_lane_config(Path(tmp))
            cfg.validate()
            self.assertEqual(len(cfg.lanes), 7)
            self.assertEqual([lane.profile_for(0) for lane in cfg.lanes], list(range(1, 8)))

    def test_config_rejects_more_than_seven_lanes(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = make_seven_lane_config(Path(tmp))
            bad = controller.ControllerConfig(**{
                **cfg.__dict__,
                "lanes": tuple(controller.Lane(index, (index + 1,)) for index in range(8)),
            })
            with self.assertRaises(ValueError):
                bad.validate()

    def test_config_rejects_empty_profile_lane(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = make_seven_lane_config(Path(tmp))
            bad = controller.ControllerConfig(**{
                **cfg.__dict__,
                "lanes": (controller.Lane(0, ()),),
            })
            with self.assertRaises(ValueError):
                bad.validate()

    def test_execution_mode_capacity_contract_is_validated(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            base = make_config(root)
            for mode, capacity in (("DIRECT", 1), ("PLAN_SINGLE", 1), ("PLAN_MULTI", 2)):
                cfg = controller.ControllerConfig(**{
                    **base.__dict__,
                    "execution_mode": mode,
                    "execution_capacity": capacity,
                })
                cfg.validate()
            with self.assertRaisesRegex(ValueError, "DIRECT requires executionCapacity=1"):
                controller.ControllerConfig(**{**base.__dict__, "execution_capacity": 3}).validate()
            with self.assertRaisesRegex(ValueError, "PLAN_MULTI requires executionCapacity>=2"):
                controller.ControllerConfig(**{
                    **base.__dict__,
                    "execution_mode": "PLAN_MULTI",
                    "execution_capacity": 1,
                }).validate()

    def test_config_rejects_ambiguous_capacity_field(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "controller.json"
            path.write_text(json.dumps({
                "fieldBase": "http://field.invalid",
                "bridgeBase": "http://bridge.invalid",
                "lanes": [[1]],
                "debugProfile": 7,
                "capacity": 3,
            }), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "capacity is ambiguous"):
                controller.ControllerConfig.load(path)

    def test_controller_concurrency_matches_lane_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = make_config(Path(tmp))
            with self.assertRaisesRegex(ValueError, "controllerConcurrency"):
                controller.ControllerConfig(**{**base.__dict__, "controller_concurrency": 1}).validate()

    def test_field_client_accepts_wrapped_targets_response(self):
        async def scenario():
            field = controller.FieldClient(FakeHttp({
                "ok": True,
                "targets": [
                    {"target_id": "t/ready", "ready": True},
                    {"target_id": "t/not-ready", "ready": False},
                ],
            }))
            self.assertEqual(await field.untested_targets(), [{"target_id": "t/ready", "ready": True}])
        asyncio.run(scenario())

    def test_config_rejects_debug_profile_in_lane(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = make_config(Path(tmp))
            bad = controller.ControllerConfig(**{**cfg.__dict__, "debug_profile": 6})
            with self.assertRaises(ValueError):
                bad.validate()

    def test_profile_pairs_alternate(self):
        lanes = make_config(Path("/tmp/test")).lanes
        self.assertEqual([lanes[0].profile_for(i) for i in range(4)], [1, 4, 1, 4])
        self.assertEqual([lanes[1].profile_for(i) for i in range(4)], [2, 5, 2, 5])
        self.assertEqual([lanes[2].profile_for(i) for i in range(4)], [3, 6, 3, 6])

    def test_only_strict_verify_contract_is_done(self):
        accepted = {"taskKind": "ctf", "terminalReason": "verified_true", "verificationState": "accepted"}
        self.assertTrue(controller.strict_verified_done(accepted))
        for changed in (
            {**accepted, "terminalReason": "completed"},
            {**accepted, "verificationState": "rejected"},
            {**accepted, "taskKind": "general"},
        ):
            self.assertFalse(controller.strict_verified_done(changed))

    def test_shared_planning_verification_export_contract_survives_session_cleanup(self):
        fixture_path = (
            Path(__file__).resolve().parents[2]
            / "packages"
            / "secheur-agent"
            / "test"
            / "fixtures"
            / "planning-trusted-verification-session.json"
        )
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        terminal = controller.terminal_snapshot_from_export(
            fixture["pollSnapshot"],
            fixture["export"],
        )

        self.assertTrue(controller.strict_verified_done(terminal))
        self.assertEqual(terminal["outcome"], "solved")
        self.assertEqual(terminal["planningRunId"], "planning_fixture")
        self.assertEqual(
            terminal["trustedPlanningVerification"]["evidenceId"],
            "tool-fixture",
        )

        accepted_before_cancel = dict(terminal)
        accepted_before_cancel["status"] = "cancelled"
        self.assertTrue(controller.strict_verified_done(accepted_before_cancel))

        unverified = controller.terminal_snapshot_from_export(
            fixture["pollSnapshot"],
            {"session": {"taskKind": "ctf", "status": "idle", "planningStatus": "completed"}},
        )
        self.assertFalse(controller.strict_verified_done(unverified))

    def test_unverified_ctf_idle_is_never_agent_completed(self):
        normalized = controller.normalize_ctf_terminal_snapshot({
            "status": "idle",
            "taskKind": "ctf",
            "terminalReason": "",
            "verificationState": "not_attempted",
        })
        self.assertEqual(normalized["terminalReason"], "unverified_idle")
        self.assertEqual(normalized["outcome"], "failed")

    def test_unverified_agent_exhausted_remains_failed(self):
        normalized = controller.normalize_ctf_terminal_snapshot({
            "status": "idle",
            "taskKind": "ctf",
            "terminalReason": "unverified_agent_exhausted",
            "verificationState": "not_attempted",
        })
        self.assertEqual(normalized["terminalReason"], "unverified_agent_exhausted")
        self.assertEqual(normalized["outcome"], "failed")

    def test_bridge_session_creation_binds_ctf_task_kind(self):
        async def scenario():
            http = FakeHttp({"sessionId": "sess-ctf"})
            bridge = controller.BridgeClient(
                http,
                max_turns=80,
                memory_reference_enabled=False,
            )

            session_id = await bridge.create_session(
                2,
                Path("/tmp/work"),
                target_id="challenge/one",
                run_id="run-one",
            )

            self.assertEqual(session_id, "sess-ctf")
            request = http.requests[-1]
            self.assertEqual(request[1], "/session/new")
            self.assertEqual(request[2]["taskKind"], "ctf")
            self.assertEqual(request[2]["targetId"], "challenge/one")
            self.assertEqual(request[2]["runId"], "run-one")
            self.assertEqual(request[2]["maxTurns"], 80)
            self.assertFalse(request[2]["memoryReferenceEnabled"])
        asyncio.run(scenario())

    def test_bridge_session_creation_sends_explicit_execution_contract(self):
        async def scenario():
            http = FakeHttp({"sessionId": "sess-plan"})
            bridge = controller.BridgeClient(http)
            await bridge.create_session(
                2,
                Path("/tmp/work"),
                execution_mode="PLAN_SINGLE",
                execution_capacity=1,
            )
            payload = http.requests[-1][2]
            self.assertEqual(payload["executionMode"], "plan_single")
            self.assertEqual(payload["executionCapacity"], 1)
        asyncio.run(scenario())

    def test_bridge_submit_carries_explicit_web_verb_flag(self):
        async def scenario():
            http = FakeHttp({"ok": True})
            bridge = controller.BridgeClient(http)

            await bridge.submit("sess-web", "prompt", 2, web_verbs_enabled=True)

            self.assertTrue(http.requests[-1][2]["webVerbsEnabled"])
        asyncio.run(scenario())

    def test_baseline_config_loads_runtime_limits_and_feature_gates(self):
        config = controller.ControllerConfig.load(
            Path(__file__).with_name("bridge-eval-controller-pi-plan-baseline-20260904.json")
        )
        self.assertEqual(config.max_turns, 200)
        self.assertEqual(config.wall_timeout_seconds, 2400)
        self.assertFalse(config.memory_reference_enabled)
        self.assertTrue(config.web_verbs_enabled_for_web_only)
        self.assertFalse(config.heuristic_learning_enabled)
        self.assertTrue(config.require_progressive_planning_disabled)
        self.assertEqual(
            config.resolved_artifact_root(),
            Path("/home/shared/eval-runner/bridge-eval-artifacts-pi-plan-baseline-20260904"),
        )
        self.assertEqual(config.retention_class, "pinned")
        self.assertEqual(config.git_commit, "667eeef")
        self.assertEqual(config.release, "task16-execution-mode-9e68e76")
        self.assertEqual(config.execution_mode, "DIRECT")
        self.assertEqual(config.execution_capacity, 1)
        self.assertEqual(config.resolved_controller_concurrency(), 3)

    def test_stage1_freeze_configs_pin_budget_mode_and_isolated_storage(self):
        config_roots = (
            Path(__file__).parents[1] / "config",
            Path(__file__).parent,
            Path(__file__).parent / "stage1-20260918",
        )
        config_paths = next(
            (
                (
                    root / "stage1-20260918-direct.json",
                    root / "stage1-20260918-plan-single.json",
                    root / "stage1-targets.txt",
                )
                for root in config_roots
                if (root / "stage1-20260918-direct.json").exists()
                and (root / "stage1-20260918-plan-single.json").exists()
                and (root / "stage1-targets.txt").exists()
            ),
            (
                config_roots[-1] / "direct/config.json",
                config_roots[-1] / "plan-single/config.json",
                config_roots[-1] / "stage1-targets.txt",
            ),
        )
        direct_path, plan_single_path, targets_path = config_paths
        direct = controller.ControllerConfig.load(direct_path)
        plan_single = controller.ControllerConfig.load(plan_single_path)

        self.assertEqual(direct.execution_mode, "DIRECT")
        self.assertEqual(plan_single.execution_mode, "PLAN_SINGLE")
        for config in (direct, plan_single):
            self.assertEqual(config.execution_capacity, 1)
            self.assertEqual(config.resolved_controller_concurrency(), 6)
            self.assertEqual(len(config.lanes), 6)
            profiles = [profile for lane in config.lanes for profile in lane.profiles]
            self.assertEqual(len(profiles), 6)
            self.assertEqual(len(profiles), len(set(profiles)))
            self.assertNotIn(config.debug_profile, profiles)
            self.assertEqual(config.max_turns, 200)
            self.assertEqual(config.wall_timeout_seconds, 2400)
            self.assertEqual(config.poll_seconds, 10)
            self.assertEqual(config.request_timeout_seconds, 300)
            self.assertEqual(config.profile_cooldown_seconds, 5400)
            self.assertEqual(config.retention_class, "pinned")
            self.assertEqual(config.git_commit, "667eeef")
            self.assertEqual(config.release, "task16-execution-mode-9e68e76")
            self.assertFalse(config.memory_reference_enabled)
            self.assertTrue(config.web_verbs_enabled_for_web_only)
            self.assertFalse(config.heuristic_learning_enabled)
            storage_name = "direct" if config is direct else "plan-single"
            self.assertIn(storage_name, str(config.work_root))
            self.assertIn(storage_name, str(config.state_root))
            self.assertIn(storage_name, str(config.resolved_artifact_root()))
        self.assertTrue(direct.require_progressive_planning_disabled)
        self.assertFalse(plan_single.require_progressive_planning_disabled)
        self.assertEqual(direct.field_base, plan_single.field_base)
        self.assertEqual(direct.bridge_base, plan_single.bridge_base)
        self.assertEqual(direct.lanes, plan_single.lanes)
        self.assertEqual(direct.debug_profile, plan_single.debug_profile)
        self.assertEqual(direct.profile_cooldown_seconds, plan_single.profile_cooldown_seconds)
        self.assertEqual(direct.memory_reference_enabled, plan_single.memory_reference_enabled)
        self.assertEqual(direct.web_verbs_enabled_for_web_only, plan_single.web_verbs_enabled_for_web_only)
        self.assertEqual(direct.heuristic_learning_enabled, plan_single.heuristic_learning_enabled)
        self.assertEqual(
            direct.work_root,
            Path("/home/shared/eval-runner/stage1-20260918/direct/work"),
        )
        self.assertEqual(
            direct.state_root,
            Path("/home/shared/eval-runner/stage1-20260918/direct/state"),
        )
        self.assertEqual(
            direct.resolved_artifact_root(),
            Path("/home/shared/eval-runner/stage1-20260918/direct/artifacts"),
        )
        self.assertEqual(
            plan_single.work_root,
            Path("/home/shared/eval-runner/stage1-20260918/plan-single/work"),
        )
        self.assertEqual(
            plan_single.state_root,
            Path("/home/shared/eval-runner/stage1-20260918/plan-single/state"),
        )
        self.assertEqual(
            plan_single.resolved_artifact_root(),
            Path("/home/shared/eval-runner/stage1-20260918/plan-single/artifacts"),
        )
        self.assertNotEqual(direct.work_root, plan_single.work_root)
        self.assertNotEqual(direct.state_root, plan_single.state_root)
        self.assertNotEqual(direct.resolved_artifact_root(), plan_single.resolved_artifact_root())

        targets = [
            line.strip()
            for line in targets_path.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        self.assertEqual(len(targets), 35)
        self.assertEqual(len(targets), len(set(targets)))

    def test_controller_does_not_claim_to_enable_browser_local_heuristic_learning(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = make_config(Path(tmp))
            with self.assertRaisesRegex(ValueError, "heuristic-learning"):
                controller.ControllerConfig(**{
                    **base.__dict__,
                    "heuristic_learning_enabled": True,
                }).validate()

    def test_web_verb_is_enabled_only_for_explicit_web_targets(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                cfg = controller.ControllerConfig(
                    field_base="http://field.invalid",
                    bridge_base="http://bridge.invalid",
                    lanes=(controller.Lane(0, (1,)), controller.Lane(1, (2,))),
                    debug_profile=7,
                    wall_timeout_seconds=9000,
                    poll_seconds=0.001,
                    request_timeout_seconds=1,
                    work_root=root / "work",
                    state_root=root / "state",
                    web_verbs_enabled_for_web_only=True,
                )
                field = FakeField([
                    {"target_id": "t/web", "ready": True, "category": "web"},
                    {"target_id": "t/crypto", "ready": True, "category": "crypto"},
                ])
                bridge = FakeBridge()
                runner = controller.EvaluationController(cfg, field, bridge, controller.StateStore(cfg.state_root))

                await runner.execute(None, 2)

                eval_submits = [item for item in bridge.submits if item[0].startswith("eval-")]
                self.assertEqual([item[3] for item in eval_submits], [True, False])
                self.assertIn("duration_seconds=", field.recorded[0]["process_summary"])
                self.assertIn("max_turns=800", field.recorded[0]["process_summary"])
        asyncio.run(scenario())

    def test_preflight_rejects_active_progressive_planning_for_baseline(self):
        class ActivePlanningBridge(FakeBridge):
            async def plugins_catalog(self):
                return {"plugins": [{"id": "progressive-planning", "effectiveEnabled": True}]}

        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                base = make_config(root)
                cfg = controller.ControllerConfig(**{
                    **base.__dict__,
                    "require_progressive_planning_disabled": True,
                })
                field = FakeField([{"target_id": "t/plan", "ready": True}])
                runner = controller.EvaluationController(cfg, field, ActivePlanningBridge(), controller.StateStore(cfg.state_root))

                with self.assertRaisesRegex(RuntimeError, "progressive-planning must be disabled"):
                    await runner.execute(None, 1)
                self.assertEqual(field.started, [])
        asyncio.run(scenario())

    def test_profile_probe_session_is_target_free_and_bounded(self):
        async def scenario():
            http = FakeHttp({"sessionId": "sess-probe"})
            bridge = controller.BridgeClient(http)

            session_id = await bridge.create_probe_session(3, Path("/tmp/probe"))

            self.assertEqual(session_id, "sess-probe")
            payload = http.requests[-1][2]
            self.assertEqual(payload["taskKind"], "general")
            self.assertEqual(payload["executionMode"], "direct")
            self.assertEqual(payload["executionCapacity"], 1)
            self.assertEqual(payload["maxTurns"], 1)
            self.assertFalse(payload["memoryReferenceEnabled"])
        asyncio.run(scenario())

    def test_profile_probe_accepts_answer_evidence_guard_after_model_message(self):
        class EvidenceGuardBridge(FakeBridge):
            guard = controller.PROFILE_PROBE_ANSWER_EVIDENCE_GUARDS[0]

            async def snapshot(self, session_id):
                if session_id in self.probe_sessions:
                    return {
                        "status": "error",
                        "lastError": self.guard,
                    }
                return await super().snapshot(session_id)

            async def export(self, session_id):
                if session_id in self.probe_sessions:
                    return {"messages": [], "runtimeLog": [{"event": "message_end"}]}
                return await super().export(session_id)

        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                cfg = make_config(Path(tmp))
                bridge = EvidenceGuardBridge()
                runner = controller.EvaluationController(
                    cfg, FakeField([]), bridge, controller.StateStore(cfg.state_root)
                )
                for guard in controller.PROFILE_PROBE_ANSWER_EVIDENCE_GUARDS:
                    with self.subTest(guard=guard):
                        bridge.guard = guard
                        await runner._probe_profile(2)
                self.assertEqual(bridge.deleted, ["probe-2", "probe-2"])

        asyncio.run(scenario())

    def test_bridge_snapshot_requests_metadata_only(self):
        async def scenario():
            http = FakeHttp({"session": {"status": "idle"}})
            bridge = controller.BridgeClient(http)

            await bridge.snapshot("sess-one")

            self.assertEqual(http.requests[-1][1], "/session/sess-one")
            self.assertEqual(http.requests[-1][3], {"includeMessages": "false"})
        asyncio.run(scenario())

    def test_bridge_planning_trace_uses_session_scoped_pagination(self):
        async def scenario():
            http = FakeHttp({"ok": True, "sessionId": "sess/one", "events": []})
            bridge = controller.BridgeClient(http)

            await bridge.planning_trace("sess/one", cursor="17", limit=3)

            self.assertEqual(http.requests[-1][0], "GET")
            self.assertEqual(http.requests[-1][1], "/session/sess/one/planning/trace")
            self.assertEqual(http.requests[-1][3], {"limit": "3", "cursor": "17"})
        asyncio.run(scenario())

    def test_planning_trace_export_paginates_and_rejects_mismatched_events(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                base = make_config(root)
                cfg = controller.ControllerConfig(**{
                    **base.__dict__,
                    "execution_mode": "PLAN_SINGLE",
                    "execution_capacity": 1,
                })
                run_id = "planning_" + "a" * 32
                artifact = controller.RunArtifact(cfg, run_id="run-plan", target_id="t/plan", profile=1, lane=1)
                artifact.initialize()
                bridge = PlanningTraceBridge([
                    {
                        "ok": True,
                        "sessionId": "sess-plan",
                        "planningRunId": run_id,
                        "planningStatus": "running",
                        "events": [{"eventId": "e1", "runId": run_id, "sequence": 4, "type": "run_created"}],
                        "eventCount": 2,
                        "traceComplete": False,
                        "nextCursor": "4",
                    },
                    {
                        "ok": True,
                        "sessionId": "sess-plan",
                        "planningRunId": run_id,
                        "planningStatus": "failed",
                        "events": [{"eventId": "e2", "runId": run_id, "sequence": 9, "type": "run_failed"}],
                        "eventCount": 2,
                        "traceComplete": True,
                        "nextCursor": None,
                    },
                ])
                exported = controller.PlanningTraceExport(
                    bridge,
                    artifact,
                    cfg,
                    session_id="sess-plan",
                )
                await exported.collect()
                self.assertEqual(exported.fields(), {
                    "planningRunId": run_id,
                    "planningStatus": "failed",
                    "planningTraceState": "available",
                    "planningTraceEventCount": 2,
                    "planningTraceComplete": True,
                    "planningTraceErrorCode": "",
                })
                self.assertEqual(len(artifact.planning_events_path.read_text(encoding="utf-8").splitlines()), 2)
                self.assertEqual(bridge.calls, [("sess-plan", None, 100), ("sess-plan", "4", 100)])

                mismatch_artifact = controller.RunArtifact(
                    cfg,
                    run_id="run-mismatch",
                    target_id="t/mismatch",
                    profile=1,
                    lane=1,
                )
                mismatch_artifact.initialize()
                mismatch = controller.PlanningTraceExport(
                    PlanningTraceBridge([{
                        "ok": True,
                        "sessionId": "sess-plan",
                        "planningRunId": run_id,
                        "planningStatus": "running",
                        "events": [{"eventId": "e1", "runId": "planning_" + "b" * 32, "sequence": 1}],
                        "eventCount": 1,
                        "traceComplete": True,
                        "nextCursor": None,
                    }]),
                    mismatch_artifact,
                    cfg,
                    session_id="sess-plan",
                )
                await mismatch.collect()
                self.assertEqual(mismatch.state, "unavailable")
                self.assertEqual(mismatch.error_code, "planning_trace_event_run_mismatch")
                self.assertFalse(mismatch.complete)

                partial_artifact = controller.RunArtifact(
                    cfg,
                    run_id="run-partial",
                    target_id="t/partial",
                    profile=1,
                    lane=1,
                )
                partial_artifact.initialize()
                partial_bridge = PlanningTraceBridge([
                    {
                        "ok": True,
                        "sessionId": "sess-plan",
                        "planningRunId": run_id,
                        "planningStatus": "completed",
                        "events": [{"eventId": "e1", "runId": run_id, "sequence": 4, "type": "run_created"}],
                        "eventCount": 2,
                        "traceComplete": False,
                        "nextCursor": "4",
                    },
                    RuntimeError("planning trace connection interrupted"),
                ])
                partial = controller.PlanningTraceExport(
                    partial_bridge,
                    partial_artifact,
                    cfg,
                    session_id="sess-plan",
                )
                await partial.collect()
                self.assertEqual(partial.state, "partial")
                self.assertEqual(partial.event_count, 1)
                self.assertFalse(partial.complete)
                self.assertEqual(partial.error_code, "planning_trace_connection_error")
                self.assertEqual(partial.planning_status, "completed")
                self.assertEqual(partial.fields()["planningStatus"], "completed")
                self.assertEqual(len(partial_artifact.planning_events_path.read_text(encoding="utf-8").splitlines()), 1)
        asyncio.run(scenario())

    def test_planning_trace_export_preserves_terminal_run_statuses(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                base = make_config(root)
                cfg = controller.ControllerConfig(**{
                    **base.__dict__,
                    "execution_mode": "PLAN_SINGLE",
                    "execution_capacity": 1,
                })
                statuses = ("completed", "failed", "paused", "cancelled")
                for index, status in enumerate(statuses):
                    run_id = f"planning_{index + 1:032x}"
                    artifact = controller.RunArtifact(
                        cfg,
                        run_id=f"run-status-{status}",
                        target_id=f"t/status-{status}",
                        profile=1,
                        lane=1,
                    )
                    artifact.initialize()
                    exported = controller.PlanningTraceExport(
                        PlanningTraceBridge([{
                            "ok": True,
                            "sessionId": f"sess-{status}",
                            "planningRunId": run_id,
                            "planningStatus": status,
                            "events": [{"eventId": f"event-{status}", "runId": run_id, "sequence": 1}],
                            "eventCount": 1,
                            "traceComplete": True,
                            "nextCursor": None,
                        }]),
                        artifact,
                        cfg,
                        session_id=f"sess-{status}",
                    )
                    await exported.collect()
                    self.assertEqual(exported.state, "available")
                    self.assertTrue(exported.complete)
                    self.assertEqual(exported.planning_status, status)
                    self.assertEqual(exported.fields()["planningStatus"], status)
                    self.assertEqual(exported.fields()["planningTraceComplete"], True)
        asyncio.run(scenario())

    def test_direct_planning_trace_export_has_no_planning_status(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                cfg = make_config(root)
                artifact = controller.RunArtifact(
                    cfg,
                    run_id="run-direct",
                    target_id="t/direct",
                    profile=1,
                    lane=1,
                )
                artifact.initialize()
                bridge = PlanningTraceBridge([])
                exported = controller.PlanningTraceExport(
                    bridge,
                    artifact,
                    cfg,
                    session_id="sess-direct",
                )
                await exported.collect()
                self.assertEqual(exported.state, "not_applicable")
                self.assertTrue(exported.complete)
                self.assertIsNone(exported.planning_status)
                self.assertEqual(exported.fields()["planningStatus"], None)
                self.assertEqual(bridge.calls, [])
        asyncio.run(scenario())

    def test_profile_probe_classifies_auth_and_quota(self):
        self.assertEqual(controller.EvaluationController._profile_probe_error(RuntimeError("HTTP 403"), 2), "auth_failed: profile=2")
        self.assertEqual(controller.EvaluationController._profile_probe_error(RuntimeError("HTTP 429"), 2), "quota_exhausted: profile=2")

    def test_profile_preflight_records_each_existing_retry_without_leaking_error_text(self):
        class RateLimitedProbeBridge(FakeBridge):
            def __init__(self):
                super().__init__()
                self.snapshot_calls = 0

            async def snapshot(self, session_id):
                if session_id in self.probe_sessions:
                    self.snapshot_calls += 1
                    controller.record_profile_probe_http(429, f"probe-request-{self.snapshot_calls}")
                    raise RuntimeError("HTTP 429 private response body must not be logged")
                return await super().snapshot(session_id)

        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                base = make_config(Path(tmp))
                cfg = controller.ControllerConfig(**{
                    **base.__dict__,
                    "lanes": (controller.Lane(0, (2,)),),
                })
                bridge = RateLimitedProbeBridge()
                state = controller.StateStore(cfg.state_root)
                runner = controller.EvaluationController(
                    cfg, FakeField([]), bridge, state
                )
                stderr = io.StringIO()
                with redirect_stderr(stderr), patch.object(controller.asyncio, "sleep", new=AsyncMock()):
                    with self.assertRaisesRegex(RuntimeError, "profile_preflight_failed"):
                        await runner.preflight()

                self.assertEqual(bridge.snapshot_calls, controller.PROFILE_PROBE_ATTEMPTS)
                self.assertEqual(bridge.probed_profiles, [2, 2])
                self.assertEqual(bridge.deleted, ["probe-2", "probe-2"])
                self.assertEqual(len(runner.profile_probe_attempts), controller.PROFILE_PROBE_ATTEMPTS)
                persisted_attempts = json.loads(state.path.read_text(encoding="utf-8"))["profileProbeAttempts"]
                self.assertEqual(len(persisted_attempts), controller.PROFILE_PROBE_ATTEMPTS)
                for index, attempt in enumerate(runner.profile_probe_attempts, start=1):
                    self.assertEqual(attempt["event"], "profile_preflight_attempt")
                    self.assertEqual(attempt["profile"], 2)
                    self.assertEqual(attempt["stage"], "poll_snapshot")
                    self.assertEqual(attempt["attempt"], index)
                    self.assertGreaterEqual(attempt["durationMs"], 0)
                    self.assertEqual(attempt["httpStatus"], 429)
                    self.assertEqual(attempt["errorCategory"], "quota_exhausted")
                    self.assertEqual(attempt["requestId"], f"probe-request-{index}")
                    self.assertEqual(persisted_attempts[index - 1], attempt)
                self.assertNotIn("private response body", stderr.getvalue())
                self.assertEqual(stderr.getvalue().count("profile_preflight_attempt"), 2)

        asyncio.run(scenario())

    def test_failed_profile_is_disabled_without_stopping_healthy_lanes(self):
        class OneBadProfileBridge(FakeBridge):
            async def snapshot(self, session_id):
                if session_id == "probe-2":
                    return {"status": "error", "lastError": "HTTP 429"}
                return await super().snapshot(session_id)

        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                cfg = controller.ControllerConfig(
                    field_base="http://field.invalid",
                    bridge_base="http://bridge.invalid",
                    lanes=(
                        controller.Lane(0, (1,)),
                        controller.Lane(1, (2,)),
                        controller.Lane(2, (3,)),
                    ),
                    debug_profile=7,
                    wall_timeout_seconds=9000,
                    poll_seconds=0.001,
                    request_timeout_seconds=1,
                    work_root=root / "work",
                    state_root=root / "state",
                )
                field = FakeField([{"target_id": f"t/{i}", "ready": True} for i in range(3)])
                bridge = OneBadProfileBridge()
                runner = controller.EvaluationController(cfg, field, bridge, controller.StateStore(cfg.state_root))

                results = await runner.execute(None, 3)

                self.assertEqual(len(results), 3)
                self.assertNotIn(2, bridge.created_profiles)
                self.assertEqual(runner.profile_failures, {2: "quota_exhausted"})

        asyncio.run(scenario())

    def test_submit_runtime_error_records_operation_and_safe_code(self):
        class ArtifactField(FakeField):
            async def start(self, target_id, run_id):
                self.started.append((target_id, run_id))
                return {
                    "ok": True,
                    "target_id": target_id,
                    "run_id": run_id,
                    "target_url": "http://target.invalid/",
                    "assets_path": "/official/assets",
                }

        class SubmitFailureBridge(FakeBridge):
            def __init__(self):
                super().__init__({"terminalReason": "infra_failed"})

            async def submit(self, session_id, prompt, profile, *, web_verbs_enabled=False):
                if session_id.startswith("probe-"):
                    return {"ok": True}
                raise RuntimeError("HTTP 503 POST /session/private/prompt: hidden-detail")

            async def export(self, session_id):
                raise RuntimeError("HTTP 503 GET /session/private/export: hidden-detail")

        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                cfg = make_config(Path(tmp))
                field = ArtifactField([{"target_id": "t/infra", "ready": True}])
                runner = controller.EvaluationController(
                    cfg,
                    field,
                    SubmitFailureBridge(),
                    controller.StateStore(cfg.state_root),
                )

                result = (await runner.execute(None, 1))[0]
                record = field.recorded[0]

                self.assertEqual(result["operation"], "bridge.submit")
                self.assertEqual(result["errorCode"], "http_503")
                self.assertIn("operation=bridge.submit; error=http_503", record["failure_reason"])
                self.assertNotIn("hidden-detail", record["failure_reason"])
                self.assertEqual(record["target_url"], "http://target.invalid/")
                self.assertEqual(record["assets_path"], "/official/assets")

        asyncio.run(scenario())

    def test_unexpected_lane_error_does_not_stop_other_lane(self):
        class OneLaneFailureRunner(controller.EvaluationController):
            async def _run_one(self, lane, target_id, profile, run_id):
                if target_id == "t/0":
                    raise RuntimeError("synthetic lane failure")
                return {
                    "status": "failed",
                    "terminalReason": "agent_completed",
                    "verificationState": "not_attempted",
                    "sessionId": f"session-{target_id}",
                }

        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                cfg = controller.ControllerConfig(
                    field_base="http://field.invalid",
                    bridge_base="http://bridge.invalid",
                    lanes=(controller.Lane(0, (1,)), controller.Lane(1, (2,))),
                    debug_profile=7,
                    wall_timeout_seconds=9000,
                    poll_seconds=0.001,
                    request_timeout_seconds=1,
                    work_root=root / "work",
                    state_root=root / "state",
                )
                field = FakeField([{"target_id": f"t/{i}", "ready": True} for i in range(2)])
                runner = OneLaneFailureRunner(cfg, field, FakeBridge(), controller.StateStore(cfg.state_root))

                results = await runner.execute(None, 2)

                self.assertEqual(len(results), 2)
                self.assertEqual(
                    {item["terminalReason"] for item in results},
                    {"infra_failed", "agent_completed"},
                )

        asyncio.run(scenario())

    def test_cleanup_failures_are_structured(self):
        class StopFailureField(FakeField):
            async def stop(self, target_id, run_id):
                raise RuntimeError("HTTP 503 POST /api/stop")

        class DeleteFailureBridge(FakeBridge):
            async def delete(self, session_id):
                raise RuntimeError("HTTP 503 DELETE /session/private")

        async def scenario():
            original_stop_retries = controller.FIELD_STOP_RETRIES
            original_delete_retries = controller.SESSION_DELETE_RETRIES
            controller.FIELD_STOP_RETRIES = 1
            controller.SESSION_DELETE_RETRIES = 1
            try:
                with tempfile.TemporaryDirectory() as tmp:
                    cfg = make_config(Path(tmp))
                    field = StopFailureField([{"target_id": "t/cleanup", "ready": True}])
                    runner = controller.EvaluationController(
                        cfg,
                        field,
                        DeleteFailureBridge(),
                        controller.StateStore(cfg.state_root),
                    )

                    result = await runner._run_one(cfg.lanes[0], "t/cleanup", 1, "run-cleanup")
                    result.update(runner._cleanup_diagnostics.pop("run-cleanup"))

                    self.assertEqual(result["targetStopStatus"], "failed:http_503")
                    self.assertEqual(result["sessionCleanupStatus"], "failed")
            finally:
                controller.FIELD_STOP_RETRIES = original_stop_retries
                controller.SESSION_DELETE_RETRIES = original_delete_retries

        asyncio.run(scenario())

    def test_record_failure_is_not_reported_as_saved(self):
        class RecordFailureField(FakeField):
            async def record(self, payload):
                raise RuntimeError("HTTP 503 POST /api/record")

        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                cfg = make_config(Path(tmp))
                field = RecordFailureField([{"target_id": "t/record", "ready": True}])
                runner = controller.EvaluationController(
                    cfg,
                    field,
                    FakeBridge(),
                    controller.StateStore(cfg.state_root),
                )

                result = await runner._run_one(cfg.lanes[0], "t/record", 1, "run-record")

                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["terminalReason"], "record_save_failed")
                self.assertEqual(result["recordStatus"], "failed")
                self.assertEqual(result["recordErrorCode"], "http_503")

        asyncio.run(scenario())

    def test_error_session_without_contract_is_infra_failed(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                cfg = make_config(Path(tmp))
                field = FakeField([{"target_id": "t/error", "ready": True}])
                bridge = FakeBridge({
                    "status": "error",
                    "terminalReason": "",
                    "verificationState": "not_applicable",
                    "outcome": "",
                    "taskKind": "general",
                })
                state = controller.StateStore(cfg.state_root)
                runner = controller.EvaluationController(cfg, field, bridge, state)

                results = await runner.execute(None, 1)

                self.assertEqual(results[0]["terminalReason"], "infra_failed")
                self.assertEqual(results[0]["verificationState"], "not_attempted")
                self.assertEqual(field.recorded[0]["status"], "failed")
                self.assertEqual(
                    field.recorded[0]["failure_reason"],
                    "infra_failed; verification=not_attempted",
                )
        asyncio.run(scenario())

    def test_execution_contract_mismatch_fails_closed_before_prompt(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                cfg = make_config(Path(tmp))
                field = FakeField([{"target_id": "t/mismatch", "ready": True}])
                bridge = FakeBridge({
                    "executionMode": "plan_single",
                    "executionCapacity": 1,
                    "legacyPlanningMode": "active",
                })
                runner = controller.EvaluationController(
                    cfg,
                    field,
                    bridge,
                    controller.StateStore(cfg.state_root),
                )

                result = (await runner.execute(None, 1))[0]

                self.assertEqual(result["terminalReason"], "execution_contract_mismatch")
                self.assertEqual(result["status"], "failed")
                self.assertEqual(
                    [item for item in bridge.submits if item[0].startswith("eval-")],
                    [],
                )
                manifest = json.loads(
                    (Path(result["artifactDir"]) / "manifest.json").read_text(encoding="utf-8")
                )
                self.assertEqual(manifest["requestedExecutionMode"], "DIRECT")
                self.assertEqual(manifest["effectiveExecutionMode"], "plan_single")
        asyncio.run(scenario())

    def test_artifact_initialization_failure_prevents_execution(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                cfg = make_config(Path(tmp))
                field = FakeField([{"target_id": "t/no-artifact", "ready": True}])
                bridge = FakeBridge()
                runner = controller.EvaluationController(
                    cfg,
                    field,
                    bridge,
                    controller.StateStore(cfg.state_root),
                )
                original = controller.RunArtifact.initialize

                def fail_initialize(_artifact):
                    raise OSError("artifact disk unavailable")

                controller.RunArtifact.initialize = fail_initialize
                try:
                    result = (await runner.execute(None, 1))[0]
                finally:
                    controller.RunArtifact.initialize = original

                self.assertEqual(result["errorOperation"], "artifact.initialize")
                self.assertEqual(result["artifactState"], "unavailable")
                self.assertEqual(field.started, [])
                self.assertEqual(bridge.target_sessions, [])
        asyncio.run(scenario())

    def test_manifest_records_requested_and_effective_execution_contract(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                base = make_config(Path(tmp))
                cfg = controller.ControllerConfig(**{
                    **base.__dict__,
                    "execution_mode": "PLAN_SINGLE",
                    "execution_capacity": 1,
                })
                field = FakeField([{"target_id": "t/manifest", "ready": True}])
                bridge = FakeBridge({
                    "executionMode": "plan_single",
                    "executionCapacity": 1,
                    "legacyPlanningMode": "active",
                })
                runner = controller.EvaluationController(
                    cfg,
                    field,
                    bridge,
                    controller.StateStore(cfg.state_root),
                )

                result = (await runner.execute(None, 1))[0]
                manifest = json.loads(
                    (Path(result["artifactDir"]) / "manifest.json").read_text(encoding="utf-8")
                )
                self.assertEqual(manifest["requestedExecutionMode"], "PLAN_SINGLE")
                self.assertEqual(manifest["requestedExecutionCapacity"], 1)
                self.assertEqual(manifest["effectiveExecutionMode"], "plan_single")
                self.assertEqual(manifest["effectiveExecutionCapacity"], 1)
                self.assertEqual(manifest["legacyPlanningMode"], "active")
                self.assertEqual(manifest["controllerConcurrency"], 3)
                self.assertEqual(manifest["profile"], 1)
                self.assertEqual(manifest["profileProvider"], "provider-1")
                self.assertEqual(manifest["profileModel"], "model-1")
                self.assertEqual(result["profile"], 1)
                self.assertEqual(result["profileProvider"], "provider-1")
                self.assertEqual(result["profileModel"], "model-1")
        asyncio.run(scenario())

    def test_controller_exports_planning_trace_before_session_cleanup(self):
        class EvalPlanningBridge(FakeBridge):
            def __init__(self, response):
                super().__init__({
                    "status": "idle",
                    "taskKind": "ctf",
                    "terminalReason": "verified_true",
                    "verificationState": "accepted",
                    "outcome": "done",
                    "executionMode": "plan_single",
                    "executionCapacity": 1,
                    "legacyPlanningMode": "active",
                })
                self.planning_response = response
                self.planning_calls = []

            async def planning_trace(self, session_id, *, cursor=None, limit=100):
                self.planning_calls.append((session_id, cursor, limit, list(self.deleted)))
                if self.deleted:
                    raise AssertionError("planning trace was requested after session deletion")
                return self.planning_response

            async def runtime_log(self, session_id, *, after_event_id=None, after_message_id=None, log_epoch=None):
                return {
                    "incremental": True,
                    "resetRequired": False,
                    "logEpoch": "mock-runtime-epoch",
                    "eventCursor": 0,
                    "messageCursor": 0,
                    "events": [],
                }

        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                base = make_config(root)
                cfg = controller.ControllerConfig(**{
                    **base.__dict__,
                    "execution_mode": "PLAN_SINGLE",
                    "execution_capacity": 1,
                })
                run_id = "planning_" + "c" * 32
                bridge = EvalPlanningBridge({
                    "ok": True,
                    "sessionId": "eval-1",
                    "planningRunId": run_id,
                    "planningStatus": "completed",
                    "events": [{"eventId": "event-1", "runId": run_id, "sequence": 7, "type": "run_created"}],
                    "eventCount": 1,
                    "traceComplete": True,
                    "nextCursor": None,
                })
                field = FakeField([{"target_id": "t/planning", "ready": True}])
                state = controller.StateStore(cfg.state_root)
                await state.reserve(cfg.lanes[0], "t/planning", 1, 0, "run-planning")
                runner = controller.EvaluationController(
                    cfg,
                    field,
                    bridge,
                    state,
                )

                result = await runner._run_one(cfg.lanes[0], "t/planning", 1, "run-planning")
                artifact = Path(result["artifactDir"])
                manifest = json.loads((artifact / "manifest.json").read_text(encoding="utf-8"))
                archived_result = json.loads((artifact / "result.json").read_text(encoding="utf-8"))
                planning_events = [
                    json.loads(line)
                    for line in (artifact / "planning-events.jsonl").read_text(encoding="utf-8").splitlines()
                ]

                self.assertEqual(result["terminalReason"], "verified_true")
                self.assertEqual(result["verificationState"], "accepted")
                self.assertEqual(result["planningTraceState"], "available")
                self.assertTrue(result["planningTraceComplete"])
                self.assertEqual(result["planningStatus"], "completed")
                self.assertTrue(result["traceComplete"])
                self.assertEqual(archived_result["planningRunId"], run_id)
                self.assertEqual(archived_result["planningStatus"], "completed")
                self.assertEqual(archived_result["planningTraceState"], "available")
                self.assertTrue(archived_result["planningTraceComplete"])
                self.assertEqual(archived_result["planningTraceEventCount"], 1)
                self.assertTrue(archived_result["traceComplete"])
                self.assertEqual(manifest["planningRunId"], run_id)
                self.assertEqual(manifest["planningStatus"], "completed")
                self.assertEqual(manifest["planningTraceState"], "available")
                self.assertEqual(manifest["planningTraceEventCount"], 1)
                self.assertTrue(manifest["planningTraceComplete"])
                self.assertEqual(manifest["planningTraceErrorCode"], "")
                self.assertEqual(len(planning_events), 1)
                self.assertEqual(planning_events[0]["runId"], run_id)
                self.assertEqual(planning_events[0]["type"], "run_created")
                self.assertEqual(bridge.created_identities, [("t/planning", "run-planning")])
                self.assertEqual(bridge.planning_calls, [("eval-1", None, 100, [])])
                self.assertEqual(bridge.deleted, ["eval-1"])
                self.assertEqual(result["sessionCleanupStatus"], "deleted")
        asyncio.run(scenario())

    def test_planning_trace_export_failure_preserves_terminal_result_and_cleanup(self):
        class FailingEvalPlanningBridge(FakeBridge):
            def __init__(self):
                super().__init__({
                    "status": "idle",
                    "taskKind": "ctf",
                    "terminalReason": "verified_true",
                    "verificationState": "accepted",
                    "outcome": "done",
                    "executionMode": "plan_single",
                    "executionCapacity": 1,
                    "legacyPlanningMode": "active",
                })
                self.planning_calls = []

            async def planning_trace(self, session_id, *, cursor=None, limit=100):
                self.planning_calls.append((session_id, cursor, limit, list(self.deleted)))
                raise RuntimeError("private planning trace failure")

            async def runtime_log(self, session_id, *, after_event_id=None, after_message_id=None, log_epoch=None):
                return {
                    "incremental": True,
                    "resetRequired": False,
                    "logEpoch": "mock-runtime-epoch",
                    "eventCursor": 0,
                    "messageCursor": 0,
                    "events": [],
                }

        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                base = make_config(root)
                cfg = controller.ControllerConfig(**{
                    **base.__dict__,
                    "execution_mode": "PLAN_SINGLE",
                    "execution_capacity": 1,
                })
                bridge = FailingEvalPlanningBridge()
                field = FakeField([{"target_id": "t/planning-failure", "ready": True}])
                state = controller.StateStore(cfg.state_root)
                await state.reserve(cfg.lanes[0], "t/planning-failure", 1, 0, "run-planning-failure")
                runner = controller.EvaluationController(
                    cfg,
                    field,
                    bridge,
                    state,
                )

                result = await runner._run_one(cfg.lanes[0], "t/planning-failure", 1, "run-planning-failure")
                artifact = Path(result["artifactDir"])
                manifest = json.loads((artifact / "manifest.json").read_text(encoding="utf-8"))

                self.assertEqual(result["status"], "done")
                self.assertEqual(result["terminalReason"], "verified_true")
                self.assertEqual(result["verificationState"], "accepted")
                self.assertEqual(result["planningTraceState"], "unavailable")
                self.assertFalse(result["planningTraceComplete"])
                self.assertIsNone(result["planningStatus"])
                self.assertTrue(result["planningTraceErrorCode"].startswith("planning_trace_"))
                self.assertEqual(manifest["planningTraceState"], "unavailable")
                self.assertFalse(manifest["planningTraceComplete"])
                self.assertIsNone(manifest["planningStatus"])
                self.assertTrue(manifest["traceComplete"])
                self.assertEqual(bridge.planning_calls, [("eval-1", None, 100, [])])
                self.assertEqual(bridge.deleted, ["eval-1"])
                self.assertEqual(result["sessionCleanupStatus"], "deleted")

        asyncio.run(scenario())

    def test_runtime_trace_persists_incremental_cursor_and_events(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                cfg = make_config(Path(tmp))
                state = controller.StateStore(cfg.state_root)
                await state.reserve(cfg.lanes[0], "t/trace", 1, 0, "run-trace")
                artifact = controller.RunArtifact(
                    cfg, run_id="run-trace", target_id="t/trace", profile=1, lane=1
                )
                artifact.initialize()
                bridge = TraceBridge([
                    {
                        "incremental": False,
                        "logEpoch": "epoch-1",
                        "eventCursor": 2,
                        "messageCursor": 1,
                        "events": [{"id": 1, "event": "start"}, {"id": 2, "event": "end"}],
                    },
                    {
                        "incremental": True,
                        "logEpoch": "epoch-1",
                        "eventCursor": 3,
                        "messageCursor": 2,
                        "events": [{"id": 3, "event": "done"}],
                    },
                ])
                trace = controller.RuntimeTrace(
                    bridge,
                    artifact,
                    state,
                    target_id="t/trace",
                    run_id="run-trace",
                    session_id="sess-trace",
                )
                await trace.poll()
                await trace.poll()
                self.assertEqual(trace.after_event_id, 3)
                self.assertTrue(trace.trace_complete)
                self.assertEqual(len(artifact.events_path.read_text(encoding="utf-8").splitlines()), 3)
                restored = controller.StateStore(cfg.state_root)
                restored.load()
                self.assertEqual(restored.data["targets"]["t/trace"]["afterEventId"], 3)
        asyncio.run(scenario())

    def test_runtime_trace_rebases_compacted_message_cursor_without_hiding_gap(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                cfg = make_config(Path(tmp))
                state = controller.StateStore(cfg.state_root)
                await state.reserve(cfg.lanes[0], "t/compact", 1, 0, "run-compact")
                artifact = controller.RunArtifact(cfg, run_id="run-compact", target_id="t/compact", profile=1, lane=1)
                artifact.initialize()
                bridge = TraceBridge([
                    {"incremental": False, "logEpoch": "a", "eventCursor": 1, "messageCursor": 20, "events": [{"id": 1}]},
                    {"incremental": True, "resetRequired": True, "logEpoch": "a", "eventCursor": 2,
                     "messageCursor": 3, "events": [{"id": 1}, {"id": 2}]},
                    {"incremental": True, "logEpoch": "a", "eventCursor": 3, "messageCursor": 4, "events": [{"id": 3}]},
                ])
                trace = controller.RuntimeTrace(bridge, artifact, state, target_id="t/compact", run_id="run-compact", session_id="sess-compact")
                await trace.poll()
                await trace.poll()
                self.assertEqual(trace.after_message_id, 3)
                self.assertEqual(trace.after_event_id, 2)
                await trace.poll()
                self.assertEqual(bridge.calls[-1][2], 3)
                self.assertEqual(trace.after_message_id, 4)
                self.assertEqual(trace.after_event_id, 3)
                self.assertFalse(trace.trace_complete)
                self.assertEqual(trace.trace_gap_reason, "cursor_reset")
                self.assertEqual(len(artifact.events_path.read_text(encoding="utf-8").splitlines()), 3)
        asyncio.run(scenario())

    def test_runtime_trace_marks_epoch_mismatch_incomplete(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                cfg = make_config(Path(tmp))
                state = controller.StateStore(cfg.state_root)
                await state.reserve(cfg.lanes[0], "t/gap", 1, 0, "run-gap")
                artifact = controller.RunArtifact(cfg, run_id="run-gap", target_id="t/gap", profile=1, lane=1)
                artifact.initialize()
                bridge = TraceBridge([
                    {"incremental": False, "logEpoch": "epoch-a", "eventCursor": 1, "events": [{"id": 1}]},
                    {"incremental": True, "logEpoch": "epoch-b", "eventCursor": 2, "events": [{"id": 2}]},
                ])
                trace = controller.RuntimeTrace(
                    bridge, artifact, state, target_id="t/gap", run_id="run-gap", session_id="sess-gap"
                )
                await trace.poll()
                await trace.poll()
                self.assertFalse(trace.trace_complete)
                self.assertEqual(trace.trace_gap_reason, "epoch_mismatch")
        asyncio.run(scenario())

    def test_runtime_trace_keeps_cursors_isolated_per_session(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                cfg = make_config(Path(tmp))
                state = controller.StateStore(cfg.state_root)
                await state.reserve(cfg.lanes[0], "t/a", 1, 0, "run-a")
                await state.reserve(cfg.lanes[1], "t/b", 2, 0, "run-b")
                artifact_a = controller.RunArtifact(cfg, run_id="run-a", target_id="t/a", profile=1, lane=1)
                artifact_b = controller.RunArtifact(cfg, run_id="run-b", target_id="t/b", profile=2, lane=2)
                artifact_a.initialize()
                artifact_b.initialize()
                trace_a = controller.RuntimeTrace(
                    TraceBridge([{"logEpoch": "a", "eventCursor": 4, "events": [{"id": 4, "session": "a"}]}]),
                    artifact_a, state, target_id="t/a", run_id="run-a", session_id="sess-a"
                )
                trace_b = controller.RuntimeTrace(
                    TraceBridge([{"logEpoch": "b", "eventCursor": 9, "events": [{"id": 9, "session": "b"}]}]),
                    artifact_b, state, target_id="t/b", run_id="run-b", session_id="sess-b"
                )
                await trace_a.poll()
                await trace_b.poll()
                self.assertEqual(trace_a.after_event_id, 4)
                self.assertEqual(trace_b.after_event_id, 9)
                self.assertEqual(json.loads(artifact_a.events_path.read_text(encoding="utf-8"))["session"], "a")
                self.assertEqual(json.loads(artifact_b.events_path.read_text(encoding="utf-8"))["session"], "b")
        asyncio.run(scenario())

    def test_execute_requires_two_part_guard(self):
        base = {"execute": True, "confirm": "", "max_targets": 1}
        with self.assertRaises(ValueError):
            controller.validate_execute_args(argparse.Namespace(**base))
        with self.assertRaises(ValueError):
            controller.validate_execute_args(argparse.Namespace(execute=True, confirm=controller.EXECUTE_CONFIRMATION, max_targets=0))
        controller.validate_execute_args(argparse.Namespace(execute=True, confirm=controller.EXECUTE_CONFIRMATION, max_targets=3))

    def test_plan_is_read_only_and_round_robin(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                cfg = make_config(Path(tmp))
                field = FakeField([{"target_id": f"t/{i}", "ready": True} for i in range(7)])
                bridge = FakeBridge()
                state = controller.StateStore(cfg.state_root)
                runner = controller.EvaluationController(cfg, field, bridge, state)
                plan = await runner.plan()
                self.assertEqual([item["lane"] for item in plan], [1, 2, 3, 1, 2, 3, 1])
                self.assertEqual([item["profile"] for item in plan], [1, 2, 3, 4, 5, 6, 1])
                self.assertEqual(field.started, [])
                self.assertFalse(cfg.state_root.exists())
        asyncio.run(scenario())

    def test_execute_three_targets_uses_three_profiles_and_records_failure(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                cfg = make_config(Path(tmp))
                field = FakeField([{"target_id": f"t/{i}", "ready": True} for i in range(3)])
                bridge = FakeBridge()
                state = controller.StateStore(cfg.state_root)
                runner = controller.EvaluationController(cfg, field, bridge, state)
                results = await runner.execute(None, 3)
                self.assertEqual(sorted(bridge.created_profiles), [1, 2, 3])
                self.assertEqual(len(results), 3)
                self.assertTrue(all(item["status"] == "failed" for item in results))
                self.assertTrue(all(item["status"] == "failed" for item in field.recorded))
                self.assertEqual(len(field.stopped), 3)
                self.assertEqual(len(bridge.deleted), 9)
        asyncio.run(scenario())

    def test_execute_seven_targets_uses_seven_profiles(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                cfg = make_seven_lane_config(Path(tmp))
                field = FakeField([{"target_id": f"t/{i}", "ready": True} for i in range(7)])
                bridge = FakeBridge()
                state = controller.StateStore(cfg.state_root)
                runner = controller.EvaluationController(cfg, field, bridge, state)
                results = await runner.execute(None, 7)
                self.assertEqual(sorted(bridge.created_profiles), list(range(1, 8)))
                self.assertEqual(len(results), 7)
                self.assertEqual(len(field.recorded), 7)
                self.assertEqual(len(field.stopped), 7)
                self.assertEqual(len(bridge.deleted), 14)
        asyncio.run(scenario())

    def test_finished_lane_claims_next_target_from_shared_queue(self):
        class TrackingRunner(controller.EvaluationController):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.assignments = []
                self.release_slow_lane = asyncio.Event()

            async def _run_one(self, lane, target_id, profile, run_id):
                self.assignments.append((lane.index, target_id, profile))
                if target_id == "t/0":
                    await self.release_slow_lane.wait()
                elif target_id == "t/2":
                    self.release_slow_lane.set()
                else:
                    await asyncio.sleep(0)
                return {
                    "status": "failed",
                    "terminalReason": "agent_completed",
                    "verificationState": "not_attempted",
                    "sessionId": f"session-{target_id}",
                }

        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                cfg = controller.ControllerConfig(
                    field_base="http://field.invalid",
                    bridge_base="http://bridge.invalid",
                    lanes=(controller.Lane(0, (1,)), controller.Lane(1, (2,))),
                    debug_profile=3,
                    wall_timeout_seconds=9000,
                    poll_seconds=0.001,
                    request_timeout_seconds=1,
                    work_root=root / "work",
                    state_root=root / "state",
                )
                field = FakeField([{"target_id": f"t/{i}", "ready": True} for i in range(3)])
                runner = TrackingRunner(cfg, field, FakeBridge(), controller.StateStore(cfg.state_root))

                results = await asyncio.wait_for(runner.execute(None, 3), timeout=1)

                self.assertEqual(len(results), 3)
                self.assertIn((0, "t/0", 1), runner.assignments)
                self.assertIn((1, "t/1", 2), runner.assignments)
                self.assertIn((1, "t/2", 2), runner.assignments)

        asyncio.run(scenario())

    def test_explicit_failed_target_is_eligible_for_retest(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                cfg = make_config(Path(tmp))
                field = FakeField([{
                    "target_id": "t/failed",
                    "status": "failed",
                    "ready": True,
                    "running": False,
                }])
                bridge = FakeBridge()
                state = controller.StateStore(cfg.state_root)
                runner = controller.EvaluationController(cfg, field, bridge, state)
                results = await runner.execute({"t/failed"}, 1)
                self.assertEqual([item[0] for item in field.started], ["t/failed"])
                self.assertEqual(results[0]["targetId"], "t/failed")
        asyncio.run(scenario())

    def test_default_queue_does_not_implicitly_retest_failed_target(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                cfg = make_config(Path(tmp))
                field = FakeField([{
                    "target_id": "t/failed",
                    "status": "failed",
                    "ready": True,
                    "running": False,
                }])
                bridge = FakeBridge()
                state = controller.StateStore(cfg.state_root)
                runner = controller.EvaluationController(cfg, field, bridge, state)
                self.assertEqual(await runner.execute(None, 1), [])
                self.assertEqual(field.started, [])
        asyncio.run(scenario())

    def test_explicit_done_running_or_missing_target_is_rejected_before_start(self):
        async def scenario():
            cases = [
                ({"t/done"}, [{"target_id": "t/done", "status": "done", "ready": True, "running": False}]),
                ({"t/running"}, [{"target_id": "t/running", "status": "failed", "ready": True, "running": True}]),
                ({"t/missing"}, []),
            ]
            for target_ids, targets in cases:
                with self.subTest(target_ids=target_ids), tempfile.TemporaryDirectory() as tmp:
                    cfg = make_config(Path(tmp))
                    field = FakeField(targets)
                    bridge = FakeBridge()
                    state = controller.StateStore(cfg.state_root)
                    runner = controller.EvaluationController(cfg, field, bridge, state)
                    with self.assertRaisesRegex(RuntimeError, "explicit target selection rejected"):
                        await runner.execute(target_ids, 1)
                    self.assertEqual(field.started, [])
        asyncio.run(scenario())

    def test_explicit_done_target_can_be_opted_into_rerun(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                cfg = make_config(Path(tmp))
                field = FakeField([{
                    "target_id": "t/done",
                    "status": "done",
                    "ready": True,
                    "running": False,
                }])
                bridge = FakeBridge()
                state = controller.StateStore(cfg.state_root)
                runner = controller.EvaluationController(
                    cfg,
                    field,
                    bridge,
                    state,
                    allow_done_rerun=True,
                )
                plan = await runner.plan({"t/done"})
                self.assertEqual(plan[0]["targetId"], "t/done")
                self.assertEqual(field.started, [])
        asyncio.run(scenario())

    def test_verified_session_is_only_done_path(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                cfg = make_config(Path(tmp))
                field = FakeField([{"target_id": "t/verified", "ready": True}])
                bridge = FakeBridge({
                    "status": "idle",
                    "taskKind": "ctf",
                    "terminalReason": "verified_true",
                    "verificationState": "accepted",
                    "outcome": "solved",
                })
                state = controller.StateStore(cfg.state_root)
                runner = controller.EvaluationController(cfg, field, bridge, state)
                results = await runner.execute(None, 1)
                self.assertEqual(results[0]["status"], "done")
                self.assertEqual(field.recorded[0]["status"], "done")
                self.assertIsNone(field.recorded[0]["failure_reason"])
                self.assertEqual(field.recorded[0]["terminal_reason"], "verified_true")
                self.assertEqual(field.recorded[0]["verification_state"], "accepted")
                self.assertEqual(bridge.verified_cancellations, [])
        asyncio.run(scenario())

    def test_running_verified_session_is_cancelled_then_saved_done(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                cfg = make_config(Path(tmp))
                field = FakeField([{"target_id": "t/running-verified", "ready": True}])
                bridge = FakeBridge({
                    "status": "running",
                    "taskKind": "ctf",
                    "terminalReason": "verified_true",
                    "verificationState": "accepted",
                })
                state = controller.StateStore(cfg.state_root)
                runner = controller.EvaluationController(cfg, field, bridge, state)

                result = (await runner.execute(None, 1))[0]

                self.assertEqual(bridge.verified_cancellations, ["eval-1"])
                self.assertEqual(result["status"], "done")
                self.assertEqual(result["terminalReason"], "verified_true")
                self.assertEqual(field.recorded[0]["status"], "done")
                self.assertEqual(field.recorded[0]["cancel_reason"], "trusted_verifier_success")
                self.assertEqual(field.recorded[0]["pre_cancel_status"], "running")
                self.assertEqual(len(field.stopped), 1)
                self.assertEqual(bridge.deleted[-1], "eval-1")

        asyncio.run(scenario())

    def test_bridge_verified_cancel_uses_distinct_lifecycle_metadata(self):
        async def scenario():
            http = FakeHttp({"ok": True})
            bridge = controller.BridgeClient(http)

            await bridge.cancel_verified("session-verified")

            self.assertEqual(http.requests, [(
                "POST",
                "/session/session-verified/cancel",
                {
                    "source": "bridge_eval_controller",
                    "reason": "trusted_verifier_success",
                },
                None,
            )])

        asyncio.run(scenario())

    def test_exception_after_accepted_export_cannot_regress_to_failed(self):
        class AcceptedAfterSubmitBridge(FakeBridge):
            async def submit(self, session_id, prompt, profile, *, web_verbs_enabled=False):
                if session_id.startswith("probe-"):
                    return {"ok": True}
                raise RuntimeError("synthetic controller interruption")

            async def export(self, session_id):
                accepted = {
                    "status": "idle",
                    "taskKind": "ctf",
                    "terminalReason": "verified_true",
                    "verificationState": "accepted",
                }
                return {"session": accepted, "messages": [], "runtimeLog": []}

        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                cfg = make_config(Path(tmp))
                field = FakeField([{"target_id": "t/accepted", "ready": True}])
                bridge = AcceptedAfterSubmitBridge()
                runner = controller.EvaluationController(cfg, field, bridge, controller.StateStore(cfg.state_root))

                result = (await runner.execute(None, 1))[0]

                self.assertEqual(result["status"], "done")
                self.assertEqual(field.recorded[0]["status"], "done")
                self.assertEqual(field.recorded[0]["verification_state"], "accepted")
        asyncio.run(scenario())

    def test_export_metrics_prefers_structured_tool_events(self):
        export = {
            "session": {"turnCount": 4},
            "messages": [{"role": "assistant", "content": "text"}],
            "runtimeLog": [
                {"event": "tool_execution_start", "toolCallId": "a"},
                {"event": "tool_execution_end", "toolCallId": "a"},
                {"event": "tool_execution_start", "toolCallId": "b"},
            ],
        }
        self.assertEqual(controller.export_metrics(export), {"turns": 4, "tool_calls": 2})

    def test_state_blocks_duplicate_and_persists_lane_cursor(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                cfg = make_config(Path(tmp))
                store = controller.StateStore(cfg.state_root)
                lane = cfg.lanes[0]
                profile, ordinal = store.next_profile(lane)
                await store.reserve(lane, "t/1", profile, ordinal, "run-1")
                self.assertEqual(store.next_profile(lane), (4, 1))
                with self.assertRaises(RuntimeError):
                    await store.reserve(lane, "t/1", 4, 1, "run-2")
                restored = controller.StateStore(cfg.state_root)
                restored.load()
                self.assertIn("t/1", restored.blocked_targets())
                self.assertEqual(restored.next_profile(lane), (4, 1))
        asyncio.run(scenario())

    def test_execute_refuses_stale_running_lease(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                cfg = make_config(Path(tmp))
                field = FakeField([{"target_id": "t/new", "ready": True}])
                bridge = FakeBridge()
                state = controller.StateStore(cfg.state_root)
                profile, ordinal = state.next_profile(cfg.lanes[0])
                await state.reserve(cfg.lanes[0], "t/stale", profile, ordinal, "run-stale")
                restored = controller.StateStore(cfg.state_root)
                runner = controller.EvaluationController(cfg, field, bridge, restored)
                with self.assertRaisesRegex(RuntimeError, "stale running leases"):
                    await runner.execute(None, 1)
                self.assertEqual(field.started, [])
        asyncio.run(scenario())

    def test_profile_cooldown_persists_and_expires(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                store = controller.StateStore(Path(tmp) / "state")
                until = await store.cooldown_profile(3, 60, "http_429")
                self.assertGreater(store.profile_cooldown_remaining(3), 0)

                restored = controller.StateStore(Path(tmp) / "state")
                restored.load()
                self.assertGreater(restored.profile_cooldown_remaining(3), 0)
                self.assertIn(3, restored.active_profile_cooldowns())
                self.assertEqual(restored.profile_cooldown_remaining(3, until + 1), 0)

        asyncio.run(scenario())

    def test_runtime_429_cools_profile_before_next_target(self):
        class RateLimitedRunner(controller.EvaluationController):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.assignments = []

            async def _run_one(self, lane, target_id, profile, run_id):
                del run_id
                self.assignments.append((lane.index, target_id, profile))
                result = {
                    "status": "failed",
                    "terminalReason": "infra_failed" if profile == 1 else "agent_completed",
                    "verificationState": "not_attempted",
                    "sessionId": f"session-{target_id}",
                }
                if profile == 1:
                    result["errorCode"] = "http_429"
                return result

        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                cfg = controller.ControllerConfig(
                    field_base="http://field.invalid",
                    bridge_base="http://bridge.invalid",
                    lanes=(controller.Lane(0, (1,)), controller.Lane(1, (2,))),
                    debug_profile=7,
                    wall_timeout_seconds=9000,
                    poll_seconds=0.001,
                    request_timeout_seconds=1,
                    work_root=root / "work",
                    state_root=root / "state",
                    profile_cooldown_seconds=1.0,
                )
                field = FakeField([{"target_id": f"t/{i}", "ready": True} for i in range(3)])
                state = controller.StateStore(cfg.state_root)
                runner = RateLimitedRunner(cfg, field, FakeBridge(), state)

                results = await asyncio.wait_for(runner.execute(None, 3), timeout=1)

                self.assertEqual(len(results), 3)
                self.assertEqual([item[1] for item in runner.assignments if item[2] == 1], ["t/0"])
                self.assertEqual([item[1] for item in runner.assignments if item[2] == 2], ["t/1", "t/2"])
                self.assertGreater(state.profile_cooldown_remaining(1), 0)

        asyncio.run(scenario())

    def test_terminal_export_429_sets_profile_error_code(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                cfg = controller.ControllerConfig(
                    field_base="http://field.invalid",
                    bridge_base="http://bridge.invalid",
                    lanes=(controller.Lane(0, (1,)),),
                    debug_profile=7,
                    wall_timeout_seconds=9000,
                    poll_seconds=0.001,
                    request_timeout_seconds=1,
                    work_root=root / "work",
                    state_root=root / "state",
                    profile_cooldown_seconds=60,
                )
                field = FakeField([{"target_id": "t/429", "ready": True}])
                bridge = FakeBridge({
                    "status": "error",
                    "taskKind": "ctf",
                    "terminalReason": "",
                    "verificationState": "not_attempted",
                    "lastError": "HTTP 429 upstream limit",
                })
                runner = controller.EvaluationController(cfg, field, bridge, controller.StateStore(cfg.state_root))

                result = (await runner.execute(None, 1))[0]

                self.assertEqual(result["errorCode"], "http_429")
                self.assertGreater(runner.state.profile_cooldown_remaining(1), 0)

        asyncio.run(scenario())

    def test_verifier_quota_does_not_set_provider_error_code_or_cooldown(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                cfg = controller.ControllerConfig(
                    field_base="http://field.invalid",
                    bridge_base="http://bridge.invalid",
                    lanes=(controller.Lane(0, (1,)),),
                    debug_profile=7,
                    wall_timeout_seconds=9000,
                    poll_seconds=0.001,
                    request_timeout_seconds=1,
                    work_root=root / "work",
                    state_root=root / "state",
                    profile_cooldown_seconds=60,
                )
                field = FakeField([{"target_id": "t/verifier-quota", "ready": True}])
                bridge = FakeBridge({
                    "status": "error",
                    "taskKind": "ctf",
                    "terminalReason": "verifier_unavailable",
                    "verificationState": "infra_error",
                    "failureSource": "verifier",
                    "failureStage": "verifier",
                    "failureCode": "verifier_quota_exhausted",
                    "lastError": "Flag verifier infrastructure failure (quota_exhausted): verification unavailable",
                })
                runner = controller.EvaluationController(cfg, field, bridge, controller.StateStore(cfg.state_root))

                result = (await runner.execute(None, 1))[0]

                self.assertNotIn("errorCode", result)
                self.assertEqual(result["failureCode"], "verifier_quota_exhausted")
                self.assertEqual(runner.state.profile_cooldown_remaining(1), 0)

        asyncio.run(scenario())

    def test_profile_rate_limit_classifier_prefers_structured_verifier_source(self):
        snapshot = {
            "failureSource": "verifier",
            "failureStage": "executor",
            "failureCode": "verifier_quota_exhausted",
            "lastError": "HTTP 429 quota exceeded",
        }

        self.assertEqual(controller.profile_rate_limit_error_code(snapshot, {}), "")
        self.assertEqual(
            controller.profile_rate_limit_error_code({"lastError": "HTTP 429 upstream model provider"}, {}),
            "http_429",
        )
        self.assertFalse(controller.is_provider_rate_limit_result({
            "errorCode": "http_429",
            "failureSource": "verifier",
            "failureCode": "verifier_quota_exhausted",
        }))
        self.assertTrue(controller.is_provider_rate_limit_result({"errorCode": "http_429"}))


if __name__ == "__main__":
    unittest.main()
