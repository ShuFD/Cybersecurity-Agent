import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

from task_tree import (
    active_path,
    format_task_tree_prompt,
    initialize_task_tree,
    record_flag_result,
    record_tool_result,
)


class TaskTreeTests(unittest.TestCase):
    def test_initial_tree_includes_tool_experience_and_web_verb_branches(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = initialize_task_tree(
                "http://127.0.0.1:8000 login cookie",
                run_dir=tmp,
                project_root=tmp,
                tool_experience_context={
                    "enabled": True,
                    "fingerprint": {"digest": "fp1", "traits": ["unsafe_deserialization"]},
                    "recommendations": {"tools": ["mcp_refresh"], "skills": ["ctf-web"]},
                },
                web_verb_context={
                    "enabled": True,
                    "is_web_task": True,
                    "digest": "web1",
                    "traits": ["html_form"],
                    "recommended_tools": ["web_verb_call"],
                    "recommended_verbs": ["web.extract_forms"],
                },
            )

            prompt = format_task_tree_prompt(state)
            saved = json.loads((Path(tmp) / "task_tree.json").read_text(encoding="utf-8"))
            ids = {node["id"] for node in saved["nodes"]}

        self.assertIn("tool_experience", ids)
        self.assertIn("web_verbs", ids)
        self.assertIn("web.extract_forms", prompt)
        self.assertIn("State file:", prompt)

    def test_failed_tool_node_rolls_back_to_parent(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = initialize_task_tree("solve", run_dir=tmp, project_root=tmp)
            parent = SimpleNamespace(task_tree_enabled=True, task_tree_state=state)
            summary = record_tool_result(
                parent,
                tool_name="web_fetch",
                args={"url": "http://example.test"},
                data={"status": "error", "msg": "timeout"},
                turn=4,
            )

            saved = json.loads((Path(tmp) / "task_tree.json").read_text(encoding="utf-8"))
            node = next(node for node in saved["nodes"] if node["id"] == summary["node_id"])

        self.assertTrue(summary["failed"])
        self.assertEqual(node["status"], "failed")
        self.assertEqual(saved["current_node_id"], "collect_evidence")
        self.assertIn("Backtrack", summary["next_prompt"])

    def test_rejected_flag_creates_recovery_branch(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = initialize_task_tree("solve", run_dir=tmp, project_root=tmp)
            parent = SimpleNamespace(task_tree_enabled=True, task_tree_state=state)
            summary = record_flag_result(
                parent,
                result={"status": "incorrect", "attempt_no": 2, "candidate_preview": "flag{bad}"},
                candidate="flag{bad}",
                turn=9,
            )

            saved = json.loads((Path(tmp) / "task_tree.json").read_text(encoding="utf-8"))
            recovery = next(node for node in saved["nodes"] if node["id"].startswith("recovery_after_attempt_2"))

        self.assertFalse(summary["correct"])
        self.assertEqual(recovery["parent_id"], "collect_evidence")
        self.assertEqual(saved["current_node_id"], recovery["id"])
        self.assertEqual(active_path(saved, recovery["id"]), ["root", "collect_evidence", recovery["id"]])
        self.assertIn("Do not mutate", summary["next_prompt"])

    def test_correct_flag_marks_root_solved(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = initialize_task_tree("solve", run_dir=tmp, project_root=tmp)
            parent = SimpleNamespace(task_tree_enabled=True, task_tree_state=state)
            summary = record_flag_result(
                parent,
                result={"status": "correct", "correct": True, "attempt_no": 1},
                candidate="flag{ok}",
                turn=12,
            )

            saved = json.loads((Path(tmp) / "task_tree.json").read_text(encoding="utf-8"))
            root = next(node for node in saved["nodes"] if node["id"] == "root")

        self.assertTrue(summary["correct"])
        self.assertEqual(root["status"], "solved")
        self.assertIn("Oracle accepted", summary["next_prompt"])

    def test_parallel_tool_results_keep_unique_nodes_and_valid_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = initialize_task_tree("solve", run_dir=tmp, project_root=tmp)
            parent = SimpleNamespace(task_tree_enabled=True, task_tree_state=state)

            def record(index):
                return record_tool_result(
                    parent,
                    tool_name="file_read",
                    args={"path": f"file-{index}"},
                    data={"status": "success", "content": "x" * 1000},
                    turn=1,
                    useful_progress=True,
                )

            with ThreadPoolExecutor(max_workers=12) as pool:
                list(pool.map(record, range(80)))

            persisted = json.loads((Path(tmp) / "task_tree.json").read_text(encoding="utf-8"))
            node_ids = [node["id"] for node in persisted["nodes"]]

        self.assertEqual(len(node_ids), 84)
        self.assertEqual(len(set(node_ids)), 84)


if __name__ == "__main__":
    unittest.main()
