import concurrent.futures
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

import agent_loop
from agent_loop import BaseHandler, StepOutcome
from attempt_tracker import AttemptTracker, canonical_operation, fingerprint, get_attempt_tracker


class Response:
    def __init__(self, content=""):
        self.content = content


class RecordingHandler(BaseHandler):
    def __init__(self, ledger_dir, *, enabled, cwd=None, delay=0, parent=None):
        self.parent = parent or SimpleNamespace(
            attempt_dedup_enabled=enabled,
            attempt_ledger_dir=str(ledger_dir),
            oracle_run_id="attempt-tracker-tests",
        )
        self.cwd = str(cwd or ledger_dir)
        self.delay = delay
        self.current_turn = 3
        self.calls = []
        self._calls_lock = threading.Lock()

    def do_code_run(self, args, response):
        with self._calls_lock:
            self.calls.append(dict(args))
        if self.delay:
            time.sleep(self.delay)
        return StepOutcome({"status": "ran"}, next_prompt="continue")

    def do_file_read(self, args, response):
        with self._calls_lock:
            self.calls.append(dict(args))
        return StepOutcome({"status": "read"}, next_prompt="continue")

    def do_mcp__demo(self, args, response):
        with self._calls_lock:
            self.calls.append(dict(args))
        return StepOutcome({"status": "mcp-result"}, next_prompt="continue")


def _capture(handler, tool_name, args, response=None):
    return agent_loop._capture_tool_call(
        handler,
        response or Response(),
        {"tool_name": tool_name, "args": args, "id": "call-1"},
        index=0,
        tool_num=1,
        verbose=False,
    )


class AttemptTrackerTests(unittest.TestCase):
    def test_default_disabled_executes_duplicate_calls(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            handler = RecordingHandler(temp_dir, enabled=False)

            first = _capture(handler, "code_run", {"script": "print('once')"})
            second = _capture(handler, "code_run", {"script": "print('once')"})

        self.assertTrue(first["executed"])
        self.assertTrue(second["executed"])
        self.assertEqual(len(handler.calls), 2)
        self.assertIsNone(getattr(handler, "_attempt_tracker", None))

    def test_enabled_blocks_same_operation_and_state_before_dispatch(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            handler = RecordingHandler(temp_dir, enabled=True)

            first = _capture(handler, "code_run", {"script": "print('once')"})
            second = _capture(handler, "code_run", {"script": "print('once')"})

        self.assertTrue(first["executed"])
        self.assertFalse(second["executed"])
        self.assertEqual(second["outcome"].data["status"], "duplicate_attempt_blocked")
        self.assertEqual(len(handler.calls), 1)

    def test_state_change_in_tracked_file_permits_retry(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            tracked_file = Path(temp_dir) / "state.txt"
            tracked_file.write_text("before", encoding="utf-8")
            handler = RecordingHandler(temp_dir, enabled=True, cwd=temp_dir)

            first = _capture(handler, "file_read", {"path": "state.txt"})
            tracked_file.write_text("after", encoding="utf-8")
            second = _capture(handler, "file_read", {"path": "state.txt"})

        self.assertTrue(first["executed"])
        self.assertTrue(second["executed"])
        self.assertEqual(len(handler.calls), 2)

    def test_nested_workspace_change_permits_code_retry(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            nested = Path(temp_dir) / "src" / "state.txt"
            nested.parent.mkdir()
            nested.write_text("before", encoding="utf-8")
            handler = RecordingHandler(temp_dir, enabled=True, cwd=temp_dir)

            first = _capture(handler, "code_run", {"script": "print('same')"})
            blocked = _capture(handler, "code_run", {"script": "print('same')"})
            nested.write_text("after", encoding="utf-8")
            retried = _capture(handler, "code_run", {"script": "print('same')"})

        self.assertTrue(first["executed"])
        self.assertFalse(blocked["executed"])
        self.assertTrue(retried["executed"])
        self.assertEqual(len(handler.calls), 2)

    def test_mcp_refresh_generation_permits_retry(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            handler = RecordingHandler(temp_dir, enabled=True)

            first = _capture(handler, "mcp__demo", {"query": "same"})
            blocked = _capture(handler, "mcp__demo", {"query": "same"})
            handler.parent._mcp_refresh_generation = 1
            retried = _capture(handler, "mcp__demo", {"query": "same"})

        self.assertTrue(first["executed"])
        self.assertFalse(blocked["executed"])
        self.assertTrue(retried["executed"])
        self.assertEqual(len(handler.calls), 2)

    def test_parallel_atomic_reservation_dispatches_once(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            handler = RecordingHandler(temp_dir, enabled=True, delay=0.15)
            ready = threading.Barrier(2)

            def capture_from_worker():
                ready.wait()
                return _capture(handler, "code_run", {"script": "print('once')"})

            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda _: capture_from_worker(), range(2)))

        self.assertEqual(sum(result["executed"] for result in results), 1)
        self.assertEqual(len(handler.calls), 1)
        blocked = next(result for result in results if not result["executed"])
        self.assertEqual(blocked["outcome"].data["status"], "duplicate_attempt_blocked")

    def test_jsonl_records_lifecycle_and_redacts_secret_arguments(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            handler = RecordingHandler(temp_dir, enabled=True)
            tracker = AttemptTracker(temp_dir, run_id="ledger-test")
            args = {"script": "print('ok')", "api_key": "super-secret-value"}

            ticket, duplicate = tracker.begin(handler, "code_run", args, Response())
            self.assertIsNotNone(ticket)
            self.assertIsNone(duplicate)
            duplicate_ticket, duplicate = tracker.begin(handler, "code_run", args, Response())
            self.assertIsNone(duplicate_ticket)
            self.assertIsNotNone(duplicate)
            tracker.finish(
                handler,
                ticket,
                StepOutcome({"status": "ran", "result": "cookie=private-value"}),
                "Authorization: Bearer private-output-token",
            )

            raw_ledger = tracker.ledger_path.read_text(encoding="utf-8")
            records = [json.loads(line) for line in raw_ledger.splitlines()]

        self.assertEqual([record["event"] for record in records], ["reserved", "blocked", "finished"])
        self.assertNotIn("super-secret-value", raw_ledger)
        self.assertEqual(records[0]["operation"]["args"]["api_key"][:10], "<redacted ")
        self.assertEqual(records[1]["status"], "duplicate_attempt_blocked")
        self.assertEqual(records[2]["status"], "completed")
        self.assertNotIn("private-value", raw_ledger)
        self.assertNotIn("private-output-token", raw_ledger)

    def test_tracker_persists_across_handler_and_process_recreation(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            parent = SimpleNamespace(
                attempt_dedup_enabled=True,
                attempt_ledger_dir=temp_dir,
                oracle_run_id="persistent-run",
            )
            first_handler = RecordingHandler(temp_dir, enabled=True, parent=parent)
            first = _capture(first_handler, "code_run", {"script": "print('same')"})

            second_handler = RecordingHandler(temp_dir, enabled=True, parent=parent)
            blocked_in_memory = _capture(second_handler, "code_run", {"script": "print('same')"})

            delattr(parent, "_attempt_tracker")
            third_handler = RecordingHandler(temp_dir, enabled=True, parent=parent)
            blocked_from_disk = _capture(third_handler, "code_run", {"script": "print('same')"})

        self.assertTrue(first["executed"])
        self.assertFalse(blocked_in_memory["executed"])
        self.assertFalse(blocked_from_disk["executed"])

    def test_unwritable_ledger_disables_guard_and_fails_open(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            ledger_target = Path(temp_dir) / "not-a-directory"
            ledger_target.write_text("occupied", encoding="utf-8")
            handler = RecordingHandler(ledger_target, enabled=True, cwd=temp_dir)

            first = _capture(handler, "code_run", {"script": "print('same')"})
            second = _capture(handler, "code_run", {"script": "print('same')"})

        self.assertTrue(first["executed"])
        self.assertTrue(second["executed"])
        self.assertEqual(len(handler.calls), 2)
        self.assertTrue(handler._attempt_tracker.disabled_reason)

    def test_response_payload_changes_effective_code_and_file_write_fingerprints(self):
        handler = SimpleNamespace(cwd=".")
        code_one = canonical_operation(
            handler,
            "code_run",
            {"type": "python"},
            Response("```python\nprint('one')\n```"),
        )
        code_two = canonical_operation(
            handler,
            "code_run",
            {"type": "python"},
            Response("```python\nprint('two')\n```"),
        )
        write_one = canonical_operation(
            handler,
            "file_write",
            {"path": "result.txt"},
            Response("<file_content>one</file_content>"),
        )
        write_two = canonical_operation(
            handler,
            "file_write",
            {"path": "result.txt"},
            Response("<file_content>two</file_content>"),
        )

        self.assertEqual(code_one["args"]["effective_code"], "print('one')")
        self.assertNotEqual(fingerprint(code_one), fingerprint(code_two))
        self.assertEqual(write_one["args"]["effective_content"], "one")
        self.assertNotEqual(fingerprint(write_one), fingerprint(write_two))


if __name__ == "__main__":
    unittest.main()
