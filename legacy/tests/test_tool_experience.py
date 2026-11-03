import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from tool_experience import (
    build_tool_experience_context,
    heuristic_tool_reuse_enabled,
    record_success,
)


class ToolExperienceTests(unittest.TestCase):
    def test_frontend_heuristic_marker_enables_reuse(self):
        self.assertTrue(heuristic_tool_reuse_enabled("please use heuristic-learning first"))
        self.assertFalse(heuristic_tool_reuse_enabled("solve this challenge"))
        with patch.dict(os.environ, {"SECHEUR_TOOL_EXPERIENCE": "1"}, clear=False):
            self.assertTrue(heuristic_tool_reuse_enabled("solve this challenge"))

    def test_fingerprint_uses_challenge_signals_not_benchmark_labels(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run_dir = root / "run"
            run_dir.mkdir()
            (run_dir / "metadata.json").write_text(
                json.dumps(
                    {
                        "benchmark": "cybench",
                        "category": "web",
                        "target_id": "cybench/web/pickle",
                        "description": "Find the flag in this serialized object service.",
                    }
                ),
                encoding="utf-8",
            )
            (run_dir / "challenge.py").write_text(
                "import pickle\npickle.loads(payload)\nclass SafeUnpickler: pass\n",
                encoding="utf-8",
            )

            context = build_tool_experience_context(
                "please use heuristic-learning first",
                project_root=str(root),
                task_dir=str(run_dir),
            )

        fingerprint_blob = json.dumps(context["fingerprint"], ensure_ascii=False)
        self.assertIn("unsafe_deserialization", context["fingerprint"]["traits"])
        self.assertIn("pickle", context["fingerprint"]["prompt_terms"])
        self.assertNotIn("cybench", fingerprint_blob)
        self.assertNotIn("target_id", fingerprint_blob)
        self.assertIn("ctf-misc", context["recommendations"]["skills"])
        oracle_tools = set(context["recommendations"]["tools"])
        self.assertTrue({"verify_flag", "check_flag"} & oracle_tools)

    def test_verified_success_records_case_and_updates_learned_rule(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run_dir = root / "run"
            memory_dir = root / "memory"
            run_dir.mkdir()
            (run_dir / "challenge.py").write_text("import pickle\npickle.loads(payload)\n", encoding="utf-8")
            context = build_tool_experience_context(
                "please use heuristic-learning first",
                project_root=str(root),
                task_dir=str(run_dir),
            )
            parent = SimpleNamespace(
                tool_experience_enabled=True,
                tool_experience_context=context,
                project_root=str(root),
                task_dir=str(run_dir),
            )
            handler = SimpleNamespace(
                history_info=[
                    "[Agent] 调用工具grep_search, args: {}",
                    "[Agent] 调用工具check_flag, args: {}",
                ]
            )

            with patch.dict(os.environ, {"SECHEUR_TOOL_EXPERIENCE_MEMORY_DIR": str(memory_dir)}, clear=False):
                summary = record_success(
                    parent=parent,
                    handler=handler,
                    response=SimpleNamespace(content="<FINAL_ANSWER>flag{ok}</FINAL_ANSWER>"),
                    oracle_result={"status": "correct", "attempts_total": 1},
                )

            self.assertEqual(summary["status"], "recorded")
            self.assertTrue((memory_dir / "tool_success_cases.jsonl").is_file())
            self.assertTrue((memory_dir / "tool_index_rules.jsonl").is_file())
            learned = (memory_dir / "tool_index_rules.jsonl").read_text(encoding="utf-8")
            self.assertIn("unsafe-python-deserialization", learned)
            self.assertIn("grep_search", learned)


if __name__ == "__main__":
    unittest.main()
