import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EVAL_RUNNER = ROOT / "eval-runner"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


_SCRIPT_ROOT = ROOT / "scripts" if (ROOT / "scripts" / "stage1_prepare_batches.py").exists() else Path(__file__).resolve().parent
prepare = load_module("stage1_prepare_batches", _SCRIPT_ROOT / "stage1_prepare_batches.py")
audit = load_module("stage1_audit", EVAL_RUNNER / "stage1_audit.py")
runner = load_module("stage1_run_batch", EVAL_RUNNER / "stage1_run_batch.py")


_LOCAL_CONFIG_ROOT = ROOT / "config"
_REMOTE_STAGE_ROOT = Path(__file__).resolve().parent / "stage1-20260918"
if (_LOCAL_CONFIG_ROOT / "stage1-targets.txt").exists():
    TARGETS = _LOCAL_CONFIG_ROOT / "stage1-targets.txt"
    BATCH_DIR = _LOCAL_CONFIG_ROOT / "stage1-batches"
    CONFIGS = {
        "direct": _LOCAL_CONFIG_ROOT / "stage1-20260918-direct.json",
        "plan-single": _LOCAL_CONFIG_ROOT / "stage1-20260918-plan-single.json",
    }
else:
    TARGETS = _REMOTE_STAGE_ROOT / "targets.txt"
    BATCH_DIR = _REMOTE_STAGE_ROOT / "batches"
    CONFIGS = {
        "direct": _REMOTE_STAGE_ROOT / "direct" / "config.json",
        "plan-single": _REMOTE_STAGE_ROOT / "plan-single" / "config.json",
    }


class Stage1BenchmarkToolTests(unittest.TestCase):
    def test_planning_experiment_manifest_records_effective_defaults_and_options(self):
        defaults = runner.planning_experiment_manifest({})
        self.assertEqual(
            defaults,
            {
                "evidenceCatalogEnabled": False,
                "observerMode": "off",
                "taskGranularityPromptEnabled": False,
                "executorContextBytes": 16384,
                "maxEvidenceBytes": 16384,
                "taskTimeoutMs": 600000,
                "observerCheckpointsMs": [180000, 420000],
                "observerFinalizeReminderMs": 540000,
                "observerMaxRemindersPerAttempt": 2,
                "evidenceCatalogDefaultPageSize": 25,
                "evidenceCatalogMaximumPageSize": 50,
            },
        )
        configured = runner.planning_experiment_manifest(
            {
                "planning": {
                    "evidenceCatalogEnabled": True,
                    "observerMode": "guidance",
                    "taskGranularityPromptEnabled": True,
                    "executorContextBytes": 49152,
                    "maxEvidenceBytes": 32768,
                    "taskTimeoutSeconds": 600,
                }
            }
        )
        self.assertTrue(configured["evidenceCatalogEnabled"])
        self.assertEqual(configured["observerMode"], "guidance")
        self.assertTrue(configured["taskGranularityPromptEnabled"])
        self.assertEqual(configured["executorContextBytes"], 49152)
        self.assertEqual(configured["maxEvidenceBytes"], 32768)

    def test_six_lane_configs_use_same_profiles_and_frozen_limits(self):
        configs = [runner.load_config(path) for path in CONFIGS.values()]
        profiles = []
        for config in configs:
            self.assertEqual(len(config["lanes"]), 6)
            self.assertEqual(int(config["controllerConcurrency"]), 6)
            self.assertEqual(int(config["executionCapacity"]), 1)
            self.assertEqual(int(config["maxTurns"]), 200)
            self.assertEqual(int(config["wallTimeoutSeconds"]), 2400)
            current = [int(lane[0]) for lane in config["lanes"]]
            self.assertEqual(len(current), len(set(current)))
            self.assertNotIn(int(config["debugProfile"]), current)
            profiles.append(current)
        self.assertEqual(profiles[0], profiles[1])
        self.assertEqual(profiles[0], [3, 4, 5, 6, 7, 9])
        comparable = []
        for config in configs:
            comparable.append({
                key: value
                for key, value in config.items()
                if key not in {"executionMode", "requireProgressivePlanningDisabled", "workRoot", "stateRoot", "artifactRoot"}
            })
        self.assertEqual(comparable[0], comparable[1])

    def test_frozen_partition_is_12_12_11_and_preserves_order(self):
        targets = prepare.read_targets(TARGETS)
        batches = [audit.load_lines(BATCH_DIR / f"batch-{index:02d}.txt") for index in (1, 2, 3)]
        self.assertEqual([len(batch) for batch in batches], [12, 12, 11])
        self.assertEqual([target for batch in batches for target in batch], targets)
        self.assertEqual(len({target for batch in batches for target in batch}), 35)

    def test_prepare_batches_fails_closed_when_frozen_target_list_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            targets = root / "targets.txt"
            targets.write_text(TARGETS.read_text(encoding="utf-8"), encoding="utf-8")
            output = root / "batches"
            prepare.prepare(targets, output)
            lines = targets.read_text(encoding="utf-8").splitlines()
            lines[0] = "changed/target"
            targets.write_text("\n".join(lines) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "frozen batch differs"):
                prepare.prepare(targets, output)

    def test_runner_command_contains_every_exact_target_id(self):
        target_ids = ["a/1", "b/2", "c/3"]
        command = runner.build_controller_command(Path("controller.py"), Path("config.json"), target_ids)
        self.assertEqual(command.count("--target-id"), len(target_ids))
        for target_id in target_ids:
            self.assertIn(target_id, command)
        self.assertIn("--allow-done-rerun", command)

    def test_runner_does_not_use_implicit_queue_selection(self):
        command = runner.build_controller_command(Path("controller.py"), Path("config.json"), ["a/1"])
        self.assertEqual(command[command.index("--max-targets") + 1], "1")
        self.assertEqual(command[-2:], ["--target-id", "a/1"])

    def test_continue_on_pass_stops_on_warn_or_fail(self):
        self.assertTrue(runner.continue_after_health("PASS", True))
        self.assertFalse(runner.continue_after_health("WARN", True))
        self.assertFalse(runner.continue_after_health("FAIL", True))
        self.assertFalse(runner.continue_after_health("PASS", False))

    def _write_config(self, root: Path, mode: str = "DIRECT") -> Path:
        config = {
            "executionMode": mode,
            "executionCapacity": 1,
            "controllerConcurrency": 6,
            "lanes": [[3], [4], [5], [6], [7], [9]],
            "debugProfile": 8,
            "maxTurns": 200,
            "wallTimeoutSeconds": 2400,
            "artifactRoot": str(root / "artifacts"),
            "stateRoot": str(root / "state"),
            "workRoot": str(root / "work"),
        }
        path = root / "config.json"
        path.write_text(json.dumps(config), encoding="utf-8")
        return path

    def _write_batch(self, root: Path, count: int = 12) -> tuple[Path, Path]:
        targets = [f"target/{index}" for index in range(35)]
        targets_path = root / "targets.txt"
        targets_path.write_text("\n".join(targets) + "\n", encoding="utf-8")
        batch_path = root / "batch-01.txt"
        batch_path.write_text("\n".join(targets[:count]) + "\n", encoding="utf-8")
        return targets_path, batch_path

    def _write_artifact(
        self,
        root: Path,
        target_id: str,
        *,
        requested_mode: str = "DIRECT",
        effective_mode: str = "direct",
        trace_complete: bool = True,
    ):
        artifact = root / "artifacts" / f"run-{target_id.rsplit('/', 1)[-1]}"
        artifact.mkdir(parents=True)
        planning_applicable = requested_mode == "PLAN_SINGLE" or effective_mode == "plan_single"
        planning_run_id = "planning_" + "a" * 32 if planning_applicable else ""
        manifest = {
            "runId": artifact.name,
            "targetId": target_id,
            "sessionId": f"session-{target_id.rsplit('/', 1)[-1]}",
            "profile": 2,
            "lane": 1,
            "artifactState": "complete",
            "traceComplete": trace_complete,
            "traceGapReason": "event_history_expired" if not trace_complete else "",
            "requestedExecutionMode": requested_mode,
            "effectiveExecutionMode": effective_mode,
            "effectiveExecutionCapacity": 1,
            "legacyPlanningMode": "active" if planning_applicable else "off",
            "planningRunId": planning_run_id,
            "planningStatus": "completed" if planning_applicable else None,
            "planningTraceState": "available" if planning_applicable else "not_applicable",
            "planningTraceEventCount": 0,
            "planningTraceComplete": True,
            "planningTraceErrorCode": "",
            "startedAt": "2026-09-18T00:00:00+0800",
        }
        (artifact / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        result = {
            "status": "failed",
            "terminalReason": "hard_turn_limit",
            "verificationState": "not_attempted",
            "durationSeconds": 10,
            "turns": 2,
            "toolCalls": 1,
            "profile": 2,
        }
        (artifact / "result.json").write_text(json.dumps(result), encoding="utf-8")
        (artifact / "session-export.json").write_text(json.dumps({"session": result}), encoding="utf-8")
        (artifact / "runtime-events.jsonl").write_text("", encoding="utf-8")
        (artifact / "planning-events.jsonl").write_text("", encoding="utf-8")

    def test_audit_detects_missing_artifact(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = self._write_config(root)
            targets, batch = self._write_batch(root)
            result = audit.audit_batch("direct", 1, config_path=config, targets_path=targets, batch_path=batch, write_outputs=False)
            self.assertEqual(result["health"]["status"], "FAIL")
            self.assertEqual(result["summary"]["artifactHealth"]["missingResult"], 12)

    def test_audit_detects_execution_contract_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = self._write_config(root)
            targets, batch = self._write_batch(root)
            for target_id in audit.load_lines(batch):
                self._write_artifact(root, target_id, effective_mode="plan_single")
            result = audit.audit_batch("direct", 1, config_path=config, targets_path=targets, batch_path=batch, write_outputs=False)
            self.assertEqual(result["summary"]["contract"]["contractMismatchCount"], 12)
            self.assertEqual(result["health"]["status"], "FAIL")

    def test_audit_detects_running_lease(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = self._write_config(root)
            targets, batch = self._write_batch(root)
            (root / "state").mkdir()
            (root / "state" / "state.json").write_text(json.dumps({"targets": {"target/0": {"state": "running"}}}), encoding="utf-8")
            result = audit.audit_batch("direct", 1, config_path=config, targets_path=targets, batch_path=batch, write_outputs=False)
            self.assertEqual(result["health"]["status"], "FAIL")
            self.assertEqual(result["summary"]["artifactHealth"]["runningLeaseCount"], 1)

    def test_audit_marks_trace_gap_as_warn_when_artifacts_are_complete(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = self._write_config(root)
            targets, batch = self._write_batch(root)
            for target_id in audit.load_lines(batch):
                self._write_artifact(root, target_id, trace_complete=False)
            result = audit.audit_batch("direct", 1, config_path=config, targets_path=targets, batch_path=batch, write_outputs=False)
            self.assertEqual(result["health"]["status"], "WARN")
            self.assertEqual(result["summary"]["artifactHealth"]["traceIncomplete"], 12)

    def test_audit_records_profile_failure_as_warn(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = self._write_config(root)
            targets, batch = self._write_batch(root)
            for target_id in audit.load_lines(batch):
                self._write_artifact(root, target_id)
            (root / "batch-01-manifest.json").write_text(json.dumps({"profileFailures": {"2": "quota_exhausted"}}), encoding="utf-8")
            result = audit.audit_batch("direct", 1, config_path=config, targets_path=targets, batch_path=batch, write_outputs=False)
            self.assertEqual(result["health"]["status"], "WARN")
            self.assertEqual(result["summary"]["environment"]["profileFailures"], {"2": "quota_exhausted"})

    def test_audit_marks_record_save_failure_as_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = self._write_config(root)
            targets, batch = self._write_batch(root)
            for target_id in audit.load_lines(batch):
                self._write_artifact(root, target_id)
            artifact = root / "artifacts" / "run-0"
            result = json.loads((artifact / "result.json").read_text(encoding="utf-8"))
            result["recordStatus"] = "failed"
            (artifact / "result.json").write_text(json.dumps(result), encoding="utf-8")
            audited = audit.audit_batch("direct", 1, config_path=config, targets_path=targets, batch_path=batch, write_outputs=False)
            self.assertEqual(audited["health"]["status"], "FAIL")
            self.assertEqual(audited["summary"]["health"]["failReasons"]["recordSaveFailed"], 1)

    def test_audit_reports_plan_single_trace_integrity_separately(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = self._write_config(root, mode="PLAN_SINGLE")
            targets, batch = self._write_batch(root)
            for target_id in audit.load_lines(batch):
                self._write_artifact(root, target_id, requested_mode="PLAN_SINGLE", effective_mode="plan_single")
            result = audit.audit_batch(
                "plan-single",
                1,
                config_path=config,
                targets_path=targets,
                batch_path=batch,
                write_outputs=False,
            )
            self.assertEqual(result["health"]["status"], "PASS")
            self.assertEqual(result["summary"]["planningTrace"]["available"], 12)
            self.assertEqual(result["summary"]["planningTrace"]["integrityIssues"], 0)
            self.assertEqual(result["cases"][0]["planningStatus"], "completed")
            self.assertTrue(result["cases"][0]["planningTraceAudit"]["planningStatusValid"])
            self.assertTrue(result["cases"][0]["planningTraceAudit"]["ok"])


if __name__ == "__main__":
    unittest.main()
