import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from agent_loop import agent_runner_loop
from flag_oracle import check_flag, extract_flag_candidates, feedback_prompt, normalize_flag
from secheur_core import SecHeurAgentHandler


class DummyParent:
    task_dir = None
    verbose = False
    project_root = "."


class DummyResponse:
    def __init__(self, content, tool_calls=None):
        self.content = content
        self.thinking = ""
        self.tool_calls = tool_calls or []


class DummyFunction:
    def __init__(self, name, arguments):
        self.name = name
        self.arguments = arguments


class DummyToolCall:
    def __init__(self, name, arguments="{}", call_id="call-1"):
        self.id = call_id
        self.function = DummyFunction(name, arguments)


class DummyClient:
    last_tools = ""

    def __init__(self, responses):
        self.responses = list(responses)
        self.messages = []

    def chat(self, messages, tools):
        self.messages.append(messages)
        if False:
            yield ""
        return self.responses.pop(0)


def _run_generator(gen):
    chunks = []
    while True:
        try:
            chunks.append(next(gen))
        except StopIteration as done:
            return "".join(chunks), done.value


class FlagOracleTests(unittest.TestCase):
    def test_extracts_and_normalizes_final_answer(self):
        self.assertEqual(normalize_flag("```text\nflag{ok}\n```"), "flag{ok}")
        self.assertEqual(extract_flag_candidates("done <FINAL_ANSWER> flag{ok} </FINAL_ANSWER>"), ["flag{ok}"])
        self.assertEqual(extract_flag_candidates("answer is flag{ok}"), ["flag{ok}"])

    def test_check_flag_uses_hash_oracle_and_records_attempts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run_dir = root / "run-1"
            run_dir.mkdir()
            (run_dir / "metadata.json").write_text(
                json.dumps({"run_id": "run-1", "target": {"id": "bench/task"}}),
                encoding="utf-8",
            )
            digest = hashlib.sha256(b"flag{ok}").hexdigest()
            oracle_file = root / "flags.json"
            oracle_file.write_text(
                json.dumps({"targets": {"bench/task": {"sha256": [digest]}}}),
                encoding="utf-8",
            )
            env = {
                "SECHEUR_FLAG_ORACLE_FILE": str(oracle_file),
                "SECHEUR_RUN_DIR": str(run_dir),
            }
            with patch.dict(os.environ, env, clear=False):
                wrong = check_flag("flag{bad}", cwd=str(root), source="test")
                right = check_flag("flag{ok}", cwd=str(root), source="test")

            self.assertEqual(wrong["status"], "incorrect")
            self.assertEqual(wrong["attempt_no"], 1)
            self.assertEqual(right["status"], "correct")
            self.assertEqual(right["attempt_no"], 2)
            attempts = (run_dir / "flag_attempts.jsonl").read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(attempts), 2)
            summary = json.loads((run_dir / "flag_oracle_summary.json").read_text(encoding="utf-8"))
            self.assertTrue(summary["flag_correct"])
            self.assertEqual(summary["flag_attempts_total"], 2)

    def test_rejected_flag_feedback_requires_evidence_recovery(self):
        prompt = feedback_prompt(
            {
                "status": "incorrect",
                "attempt_no": 3,
                "candidate_preview": "flag{bad}",
            }
        )
        self.assertIn("failed hypothesis", prompt)
        self.assertIn("evidence chain", prompt)
        self.assertIn("Do not mutate, enumerate, or guess", prompt)

    def test_agent_loop_continues_after_wrong_final_flag_then_stops_on_correct(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run_dir = root / "run-2"
            run_dir.mkdir()
            (run_dir / "metadata.json").write_text(
                json.dumps({"run_id": "run-2", "target": {"id": "bench/task"}}),
                encoding="utf-8",
            )
            oracle_file = root / "flags.json"
            oracle_file.write_text(
                json.dumps({"targets": {"bench/task": {"flags": ["flag{ok}"]}}}),
                encoding="utf-8",
            )
            env = {
                "SECHEUR_FLAG_ORACLE_FILE": str(oracle_file),
                "SECHEUR_RUN_DIR": str(run_dir),
            }
            (root / "evidence.txt").write_text("verified evidence", encoding="utf-8")
            parent = SimpleNamespace(
                task_dir=str(run_dir),
                verbose=False,
                project_root=str(root),
                permission_mode="bypassPermissions",
            )
            handler = SecHeurAgentHandler(parent, [], cwd=str(root))
            client = DummyClient(
                [
                    DummyResponse("<FINAL_ANSWER>flag{bad}</FINAL_ANSWER>"),
                    DummyResponse(
                        "<summary>audit rejected evidence</summary>",
                        [
                            DummyToolCall(
                                "file_read",
                                '{"path": "evidence.txt"}',
                                call_id="read-evidence",
                            )
                        ],
                    ),
                    DummyResponse("<FINAL_ANSWER>flag{ok}</FINAL_ANSWER>"),
                ]
            )

            with patch.dict(os.environ, env, clear=False):
                output, exit_reason = _run_generator(
                    agent_runner_loop(
                        client,
                        "system",
                        "Target ID: test/challenge\n<FINAL_ANSWER>answer</FINAL_ANSWER>",
                        handler,
                        [],
                        max_turns=4,
                        verbose=False,
                    )
                )

            self.assertIn("flag{bad}", output)
            self.assertIn("Rejection Recovery Note", client.messages[1][-1]["content"])
            self.assertIn("evidence chain", client.messages[1][-1]["content"])
            self.assertIn("verified evidence", client.messages[2][-1]["tool_results"][0]["content"])
            self.assertIn("flag{ok}", output)
            self.assertEqual(exit_reason["result"], "VERIFIED_TRUE")
            self.assertEqual(exit_reason["terminal_reason"], "verified_true")
            attempts = (run_dir / "flag_attempts.jsonl").read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(attempts), 2)
            self.assertIn("[Agent]", handler.history_info[-1])


if __name__ == "__main__":
    unittest.main()
