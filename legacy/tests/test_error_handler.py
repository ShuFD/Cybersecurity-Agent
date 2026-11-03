import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from error_handler import observe_flag_result, observe_tool_result
from task_tree import initialize_task_tree


class ErrorHandlerTests(unittest.TestCase):
    def test_browser_no_tab_repeats_degrade_tool_and_update_tree(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = initialize_task_tree("web task", run_dir=tmp, project_root=tmp)
            parent = SimpleNamespace(
                error_handler_enabled=True,
                task_tree_enabled=True,
                task_tree_state=state,
                task_tree_path=str(Path(tmp) / "task_tree.json"),
                oracle_run_id="run-1",
            )
            last = None
            for turn in range(1, 4):
                last = observe_tool_result(
                    parent,
                    tool_name="web_scan",
                    args={"cookie": "secret-cookie"},
                    data={"status": "error", "msg": "no available browser tabs"},
                    turn=turn,
                    branch_id="collect_evidence",
                )

            log_lines = (Path(tmp) / "error_log.jsonl").read_text(encoding="utf-8").splitlines()
            summary = json.loads((Path(tmp) / "error_summary.json").read_text(encoding="utf-8"))
            tree = json.loads((Path(tmp) / "task_tree.json").read_text(encoding="utf-8"))
            collect = next(node for node in tree["nodes"] if node["id"] == "collect_evidence")

        self.assertEqual(len(log_lines), 3)
        self.assertIn("<redacted:", log_lines[-1])
        self.assertEqual(last["event"]["program_classification"]["category"], "browser_no_tab")
        self.assertEqual(last["event"]["program_classification"]["total_count"], 3)
        self.assertEqual(last["decision"]["tool_health_status"], "degraded")
        self.assertIn("Do not retry browser-tab-dependent tools", last["next_prompt"])
        self.assertEqual(summary["tool_health"]["browser_tabs"]["status"], "degraded")
        self.assertEqual(collect["error_count"], 3)
        self.assertEqual(collect["last_error"], "browser_no_tab")

    def test_tool_not_allowed_is_blocked_on_first_seen_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = SimpleNamespace(error_handler_enabled=True, task_dir=tmp, oracle_run_id="run-2")
            result = observe_tool_result(
                parent,
                tool_name="run_ctf_tool",
                args={"command": "curl http://target"},
                data={"status": "error", "msg": "curl is not in allowlist"},
                turn=5,
            )
            summary = json.loads((Path(tmp) / "error_summary.json").read_text(encoding="utf-8"))

        self.assertEqual(result["event"]["program_classification"]["category"], "tool_not_allowed")
        self.assertEqual(result["decision"]["tool_health_status"], "blocked")
        self.assertIn("run_ctf_tool:curl", summary["tool_health"])
        self.assertIn("Do not retry the same command", result["next_prompt"])

    def test_oracle_rejected_logs_recovery_prompt(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = initialize_task_tree("ctf task", run_dir=tmp, project_root=tmp)
            parent = SimpleNamespace(
                error_handler_enabled=True,
                task_tree_enabled=True,
                task_tree_state=state,
                task_tree_path=str(Path(tmp) / "task_tree.json"),
                oracle_run_id="run-3",
            )
            result = observe_flag_result(
                parent,
                result={"status": "incorrect", "attempt_no": 2, "correct": False},
                candidate="flag{bad}",
                turn=8,
                branch_id="verify_candidate",
            )
            log = json.loads((Path(tmp) / "error_log.jsonl").read_text(encoding="utf-8").splitlines()[-1])

        self.assertEqual(result["event"]["program_classification"]["category"], "oracle_rejected")
        self.assertIn("failed hypothesis", result["next_prompt"])
        self.assertEqual(log["runtime_decision"]["action"], "recover_evidence_chain")

    def test_http_404_is_recorded_as_soft_observation(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = SimpleNamespace(error_handler_enabled=True, task_dir=tmp, oracle_run_id="run-4")
            result = observe_tool_result(
                parent,
                tool_name="web_verb_call",
                args={"verb": "web.fetch", "args": {"url": "http://example.test/missing"}},
                data={"status": "success", "data": {"status_code": 404, "url": "http://example.test/missing"}},
                turn=3,
            )

        self.assertEqual(result["event"]["program_classification"]["category"], "http_error")
        self.assertEqual(result["event"]["program_classification"]["severity"], "soft")
        self.assertIn("Treat this as target/application evidence", result["next_prompt"])


if __name__ == "__main__":
    unittest.main()
