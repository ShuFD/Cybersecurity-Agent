import unittest
import json
import tempfile
from pathlib import Path
from bridge_eval_controller import FieldStartError, export_metrics, safe_error_code, profile_rate_limit_error_code, planning_trace_metrics


class PlanningMetricsTest(unittest.TestCase):
    def test_timeout_trace_preserves_counts_without_duplicate_pages_or_cairn_prefixes(self):
        events = [
            {"eventId": "reason-start", "type": "cairn_reason_start"},
            {"eventId": "proposal", "type": "proposal_generation_end"},
            {"eventId": "request", "type": "planning_model_request_end"},
            {"eventId": "turn", "type": "cairn_model_turn_completed"},
            {"eventId": "tool", "type": "cairn_executor_tool_execution_start", "payload": {"leaseId": "a", "toolCallId": "call"}},
        ]
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "planning-events.jsonl"
            path.write_text("\n".join(json.dumps(e) for e in events + events))
            self.assertEqual(planning_trace_metrics(path), {"plannerCalls": 1, "executorTurns": 1, "toolCallsStarted": 1})
    def test_typed_verifier_quota_cannot_cool_down_a_model_profile(self):
        record = {"failureSource": "planning", "failureStage": "executor", "failureCode": "verifier_quota_exhausted", "lastError": "Flag verifier quota exhausted"}
        self.assertEqual(profile_rate_limit_error_code(record, {}), "")
        self.assertEqual(profile_rate_limit_error_code({"lastError": "HTTP 429 rate limit"}, {}), "http_429")
    def test_start_failure_preserves_category_without_response_body(self):
        for payload, code in [
            ({"error": "No such image: sensitive-example"}, "field_image_unavailable"),
            ({"error": "port is already allocated: sensitive-example"}, "field_resource_busy"),
            ({"message": "cannot connect to the Docker daemon"}, "field_daemon_unavailable"),
            ({"error": "unknown sensitive-example"}, "field_start_failed"),
        ]:
            error = FieldStartError(payload)
            self.assertEqual(safe_error_code(error), code)
            self.assertNotIn("sensitive-example", str(error))

    def test_aggregate_children_not_added_twice(self):
        export = {"session": {"turnCount": 30, "toolCallCount": 120}, "runtimeLog": [{"event": "tool_execution_start", "toolCallId": "parent"}], "messages": []}
        self.assertEqual(export_metrics(export), {"turns": 30, "tool_calls": 120})

    def test_compaction_does_not_reduce_aggregate(self):
        self.assertEqual(export_metrics({"session": {"turnCount": 20, "toolCallCount": 90}, "messages": [], "runtimeLog": []}), {"turns": 20, "tool_calls": 90})

    def test_old_bridge_fallback_and_invalid_aggregate(self):
        for value in [None, -1, True, "123"]:
            export = {"session": {"toolCallCount": value}, "messages": [{"role": "assistant", "content": "<fixture>"}], "runtimeLog": []}
            self.assertEqual(export_metrics(export), {"turns": 1, "tool_calls": 1})


if __name__ == "__main__":
    unittest.main()
