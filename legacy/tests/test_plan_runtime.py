import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from plan_runtime import PlanRuntime, TriValue, evaluate_condition
from agent_loop import exhaust
from plan_runtime.linter import lint_nodes
from plan_runtime.scheduler import refresh_schedule
from secheur_core import SecHeurAgentHandler
from tool_registry import PLAN_EXPAND_SCHEMA, PLAN_REVISE_SCHEMA, PLAN_STATUS_SCHEMA, get_active_tool_schema


class ConditionTests(unittest.TestCase):
    def test_conditions_use_three_valued_logic(self):
        facts = {"web.routes": {"value": ["/login", "/download"]}}

        self.assertEqual(
            evaluate_condition({"op": "contains", "fact": "web.routes", "value": "/download"}, facts).value,
            TriValue.TRUE,
        )
        self.assertEqual(
            evaluate_condition({"op": "eq", "fact": "web.has_api", "value": True}, facts).value,
            TriValue.UNKNOWN,
        )
        self.assertEqual(
            evaluate_condition({"op": "eq", "fact": "web.routes", "value": []}, facts).value,
            TriValue.FALSE,
        )

    def test_all_preserves_unknown_unless_a_child_is_false(self):
        facts = {"known": {"value": True}}
        unknown = evaluate_condition(
            {
                "op": "all",
                "args": [
                    {"op": "eq", "fact": "known", "value": True},
                    {"op": "eq", "fact": "missing", "value": True},
                ],
            },
            facts,
        )
        false = evaluate_condition(
            {
                "op": "all",
                "args": [
                    {"op": "eq", "fact": "known", "value": False},
                    {"op": "eq", "fact": "missing", "value": True},
                ],
            },
            facts,
        )

        self.assertEqual(unknown.value, TriValue.UNKNOWN)
        self.assertEqual(unknown.missing_facts, frozenset({"missing"}))
        self.assertEqual(false.value, TriValue.FALSE)


class LinterTests(unittest.TestCase):
    def test_while_requires_iteration_and_progress_budgets(self):
        existing = {
            "root": {"id": "root", "kind": "sequence", "children": ["loop"]},
            "body": {"id": "body", "kind": "sequence", "children": []},
        }
        errors = lint_nodes(
            existing_nodes=existing,
            proposed_nodes=[
                {
                    "id": "loop",
                    "parent_id": "root",
                    "kind": "while",
                    "condition": {"op": "eq", "fact": "done", "value": False},
                    "body": "body",
                }
            ],
            facts={},
            hypotheses={},
        )
        codes = {item["code"] for item in errors}

        self.assertIn("MISSING_LOOP_BUDGET", codes)
        self.assertIn("MISSING_PROGRESS_FACT", codes)
        self.assertIn("MISSING_NO_PROGRESS_BUDGET", codes)

    def test_hypothesis_cannot_unlock_non_probe_action(self):
        existing = {"root": {"id": "root", "kind": "sequence", "children": ["exploit"]}}
        errors = lint_nodes(
            existing_nodes=existing,
            proposed_nodes=[
                {
                    "id": "exploit",
                    "parent_id": "root",
                    "kind": "action",
                    "requires": [{"op": "eq", "fact": "web.sqli_possible", "value": True}],
                    "action": {"tool": "web_fetch", "args": {}},
                    "failure_policy": {"type": "backtrack"},
                }
            ],
            facts={},
            hypotheses={"web.sqli_possible": {"claim": "possible SQL injection"}},
        )

        self.assertIn("HYPOTHESIS_USED_AS_FACT", {item["code"] for item in errors})

    def test_hypothesis_is_allowed_for_probe_node(self):
        existing = {"root": {"id": "root", "kind": "sequence", "children": ["probe"]}}
        errors = lint_nodes(
            existing_nodes=existing,
            proposed_nodes=[
                {
                    "id": "probe",
                    "parent_id": "root",
                    "kind": "probe",
                    "requires": [{"op": "eq", "fact": "web.sqli_possible", "value": True}],
                    "action": {"tool": "web_fetch", "args": {}},
                    "failure_policy": {"type": "backtrack"},
                }
            ],
            facts={},
            hypotheses={"web.sqli_possible": {"claim": "possible SQL injection"}},
        )

        self.assertNotIn("HYPOTHESIS_USED_AS_FACT", {item["code"] for item in errors})


class PlanRuntimeTests(unittest.TestCase):
    def _runtime(self, tmp):
        return PlanRuntime.initialize("target=http://challenge.test web", run_dir=tmp)

    def _complete_web_triage(self, runtime):
        calls = [
            (
                "web_fetch",
                {"url": "http://challenge.test"},
                {"status": "success", "source_url": "http://challenge.test", "content": "home"},
            ),
            (
                "web_verb_call",
                {"verb": "web.inspect_headers", "args": {"url": "http://challenge.test"}},
                {
                    "status": "success",
                    "verb": "web.inspect_headers",
                    "data": {"url": "http://challenge.test", "status_code": 200, "headers": {"server": "Werkzeug"}},
                },
            ),
            (
                "web_verb_call",
                {"verb": "web.check_common_files", "args": {"url": "http://challenge.test"}},
                {"status": "success", "verb": "web.check_common_files", "data": {"results": []}},
            ),
            (
                "web_verb_call",
                {"verb": "web.extract_forms", "args": {"url": "http://challenge.test"}},
                {"status": "success", "verb": "web.extract_forms", "data": {"forms": []}},
            ),
        ]
        result = None
        for turn, (tool_name, args, data) in enumerate(calls, 1):
            execution = runtime.start_execution(tool_name=tool_name, args=args, turn=turn)
            result = runtime.observe_tool_result(
                tool_name=tool_name,
                args=args,
                result=data,
                turn=turn,
                execution_id=execution["execution_id"],
            )
        return result

    def test_initial_skeleton_is_persisted_and_expandable(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = self._runtime(tmp)
            status = runtime.status(include_nodes=True)

            self.assertEqual(
                status["runnable_node_ids"],
                ["web_fetch_root", "web_inspect_headers", "web_check_common_files", "web_extract_forms"],
            )
            self.assertEqual(status["template"], "web")
            self.assertEqual(status["recent_evidence_ids"], ["ev_task_input"])
            self.assertTrue(status["shadow_mode"])
            self.assertTrue((Path(tmp) / "plan_runtime.json").exists())
            self.assertTrue((Path(tmp) / "plan_runtime_events.jsonl").exists())

    def test_observation_can_support_local_expansion_and_complete_action(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = self._runtime(tmp)
            self._complete_web_triage(runtime)
            observation = runtime.observe_tool_result(
                tool_name="web_fetch",
                args={"url": "http://challenge.test"},
                result={"status": "success", "routes": ["/login", "/download"]},
                turn=5,
            )
            evidence_id = observation["evidence_id"]
            result = runtime.expand(
                parent_id="investigation_body",
                reason="The route crawl exposed a download endpoint.",
                evidence_refs=[evidence_id],
                facts=[{"key": "web.routes", "value": ["/login", "/download"], "evidence_refs": [evidence_id]}],
                nodes=[
                    {
                        "id": "probe_download",
                        "parent_id": "investigation_body",
                        "kind": "probe",
                        "title": "Probe the download baseline",
                        "requires": [{"op": "contains", "fact": "web.routes", "value": "/download"}],
                        "action": {
                            "tool": "web_fetch",
                            "args": {"url": "http://challenge.test/download?file=readme.txt"},
                        },
                        "failure_policy": {"type": "backtrack"},
                    }
                ],
            )

            self.assertEqual(result["status"], "accepted")
            self.assertEqual(result["runnable_node_ids"], ["probe_download"])

            completion = runtime.observe_tool_result(
                tool_name="web_fetch",
                args={"url": "http://challenge.test/download?file=readme.txt"},
                result={"status": "success"},
                turn=2,
            )

            self.assertEqual(completion["matched_node_id"], "probe_download")
            self.assertEqual(completion["classification"], "planned")
            self.assertEqual(runtime.state["nodes"]["investigation_loop"]["iterations"], 1)
            self.assertEqual(runtime.status()["runnable_node_ids"], ["probe_download"])

    def test_expansion_rejects_unknown_evidence_without_mutating_tree(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = self._runtime(tmp)
            before = set(runtime.state["nodes"])
            result = runtime.expand(
                parent_id="collect_evidence",
                reason="unsupported",
                evidence_refs=["ev_missing"],
                nodes=[{"id": "invented", "kind": "sequence", "children": []}],
            )

            self.assertEqual(result["status"], "rejected")
            self.assertEqual(set(runtime.state["nodes"]), before)

    def test_hypothesis_can_schedule_probe_but_not_regular_action(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = self._runtime(tmp)
            self._complete_web_triage(runtime)
            observation = runtime.observe_tool_result(
                tool_name="web_fetch", args={"url": "x"}, result={"status": "success"}, turn=1
            )
            evidence_id = observation["evidence_id"]
            result = runtime.expand(
                parent_id="investigation_body",
                reason="A response shape suggests a low-risk SQL injection probe.",
                evidence_refs=[evidence_id],
                hypotheses=[
                    {
                        "id": "web.sqli_possible",
                        "claim": "The parameter may reach a SQL query.",
                        "confidence": 0.4,
                        "evidence_refs": [evidence_id],
                    }
                ],
                nodes=[
                    {
                        "id": "probe_sqli",
                        "kind": "probe",
                        "requires": [{"op": "eq", "fact": "web.sqli_possible", "value": True}],
                        "action": {"tool": "web_fetch", "args": {"url": "x?id=1%27"}},
                        "failure_policy": {"type": "backtrack"},
                    }
                ],
            )

            self.assertEqual(result["status"], "accepted")
            self.assertEqual(result["runnable_node_ids"], ["probe_sqli"])

    def test_revision_prunes_a_failed_branch(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = self._runtime(tmp)
            observation = runtime.observe_tool_result(
                tool_name="web_fetch", args={"url": "x"}, result={"status": "success"}, turn=1
            )
            evidence_id = observation["evidence_id"]
            runtime.expand(
                parent_id="collect_evidence",
                reason="create a probe",
                evidence_refs=[evidence_id],
                nodes=[
                    {
                        "id": "dead_probe",
                        "kind": "probe",
                        "action": {"tool": "web_fetch", "args": {"url": "x"}},
                        "failure_policy": {"type": "backtrack"},
                    }
                ],
            )
            failed = runtime.observe_tool_result(
                tool_name="web_fetch", args={"url": "x"}, result={"status": "error"}, turn=2
            )
            result = runtime.revise(
                changes=[{"op": "prune", "node_id": "dead_probe", "reason": "endpoint is unavailable"}],
                reason="The probe produced a reproducible error.",
                evidence_refs=[failed["evidence_id"]],
            )

            self.assertEqual(result["status"], "accepted")
            self.assertEqual(runtime.state["nodes"]["dead_probe"]["status"], "pruned")


class SchedulerTests(unittest.TestCase):
    def _base_state(self, nodes, facts=None, hypotheses=None):
        return {
            "root_id": "root",
            "nodes": nodes,
            "facts": facts or {},
            "hypotheses": hypotheses or {},
            "runtime": {},
        }

    def test_if_uses_probe_branch_for_unknown_then_switches_to_true_branch(self):
        nodes = {
            "root": {"id": "root", "kind": "sequence", "status": "pending", "children": ["route_if"]},
            "route_if": {
                "id": "route_if",
                "kind": "if",
                "status": "pending",
                "condition": {"op": "eq", "fact": "web.has_login", "value": True},
                "then": "auth_probe",
                "else": "anonymous_probe",
                "on_unknown": "discover_login",
            },
            "auth_probe": {"id": "auth_probe", "kind": "probe", "status": "pending"},
            "anonymous_probe": {"id": "anonymous_probe", "kind": "probe", "status": "pending"},
            "discover_login": {"id": "discover_login", "kind": "probe", "status": "pending"},
        }
        state = self._base_state(nodes)

        self.assertEqual(refresh_schedule(state), ["discover_login"])
        state["facts"]["web.has_login"] = {"value": True}
        self.assertEqual(refresh_schedule(state), ["auth_probe"])

    def test_parallel_exposes_all_runnable_children(self):
        nodes = {
            "root": {"id": "root", "kind": "parallel", "status": "pending", "children": ["headers", "routes"]},
            "headers": {"id": "headers", "kind": "probe", "status": "pending", "priority": 2},
            "routes": {"id": "routes", "kind": "probe", "status": "pending", "priority": 1},
        }

        self.assertEqual(refresh_schedule(self._base_state(nodes)), ["headers", "routes"])

    def test_while_stops_when_body_finishes_without_progress(self):
        nodes = {
            "root": {
                "id": "root",
                "kind": "while",
                "status": "pending",
                "condition": {"op": "eq", "fact": "flag.verified", "value": False},
                "body": "body",
                "max_iterations": 5,
                "iterations": 0,
                "progress_fact": "runtime.useful_fact_count",
                "last_progress_value": 2,
                "max_no_progress": 1,
                "no_progress_count": 0,
            },
            "body": {"id": "body", "kind": "sequence", "status": "done", "children": ["probe"]},
            "probe": {"id": "probe", "kind": "probe", "status": "done"},
        }
        facts = {"flag.verified": {"value": False}, "runtime.useful_fact_count": {"value": 2}}
        state = self._base_state(nodes, facts=facts)

        self.assertEqual(refresh_schedule(state), [])
        self.assertEqual(state["nodes"]["root"]["status"], "failed")
        self.assertEqual(state["nodes"]["root"]["failure_reason"], "no_progress")

    def test_parallel_actions_with_same_tool_match_by_arguments(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = PlanRuntime.initialize("solve", run_dir=tmp)
            runtime.state["nodes"] = {
                "root": {"id": "root", "kind": "parallel", "status": "pending", "children": ["fetch_a", "fetch_b"]},
                "fetch_a": {
                    "id": "fetch_a",
                    "kind": "probe",
                    "status": "pending",
                    "action": {"tool": "web_fetch", "args": {"url": "https://a.test"}},
                },
                "fetch_b": {
                    "id": "fetch_b",
                    "kind": "probe",
                    "status": "pending",
                    "action": {"tool": "web_fetch", "args": {"url": "https://b.test"}},
                },
            }
            refresh_schedule(runtime.state)

            result = runtime.observe_tool_result(
                tool_name="web_fetch",
                args={"url": "https://b.test"},
                result={"status": "success"},
                turn=1,
            )

            self.assertEqual(result["matched_node_id"], "fetch_b")
            self.assertEqual(runtime.state["nodes"]["fetch_b"]["status"], "done")
            self.assertEqual(runtime.state["nodes"]["fetch_a"]["status"], "runnable")


class PlanToolSchemaTests(unittest.TestCase):
    def test_plan_tools_are_standard_virtual_tools(self):
        schemas = [PLAN_EXPAND_SCHEMA, PLAN_REVISE_SCHEMA, PLAN_STATUS_SCHEMA]
        names = [schema["function"]["name"] for schema in schemas]
        active = get_active_tool_schema([], activated=set(names))
        active_names = [schema["function"]["name"] for schema in active]

        self.assertEqual(names, ["plan_expand", "plan_revise", "plan_status"])
        for name in names:
            self.assertIn(name, active_names)

    def test_handler_dispatches_plan_status_without_recording_it_as_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = PlanRuntime.initialize("solve", run_dir=tmp)
            parent = SimpleNamespace(
                plan_runtime_state=runtime.state,
                plan_runtime_path=runtime.state["path"],
                task_tree_enabled=False,
                error_handler_enabled=False,
            )
            handler = SecHeurAgentHandler(parent, cwd=tmp)
            before = len(runtime.state["evidence"])

            outcome = exhaust(handler.dispatch("plan_status", {}, None))

            self.assertEqual(outcome.data["status"], "success")
            self.assertEqual(len(runtime.state["evidence"]), before)


if __name__ == "__main__":
    unittest.main()
