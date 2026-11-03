import tempfile
import unittest
from types import SimpleNamespace

from agent_loop import StepOutcome, exhaust
from plan_runtime import PlanRuntime
from plan_runtime.consistency import args_digest, normalize_args
from plan_runtime.templates import detect_category
from secheur_core import SecHeurAgentHandler


class TemplateTests(unittest.TestCase):
    def test_detects_ctf_categories(self):
        self.assertEqual(detect_category("Web target https://challenge.test"), "web")
        self.assertEqual(detect_category("pwn challenge with checksec"), "pwn")
        self.assertEqual(detect_category("reverse this APK"), "reverse")
        self.assertEqual(detect_category("forensics PCAP capture"), "forensics")
        self.assertEqual(detect_category("\u8fd9是一个\u7f51\u7ad9题"), "web")
        self.assertEqual(detect_category("\u8fd9是一个\u9006\u5411题"), "reverse")
        self.assertEqual(detect_category("\u8fd9是一个\u6808\u6ea2\u51fa题"), "pwn")
        self.assertEqual(detect_category("\u8fd9是一个\u53d6\u8bc1题"), "forensics")

    def test_web_template_exposes_grounded_parallel_actions(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = PlanRuntime.initialize("Web target https://challenge.test", run_dir=tmp)
            status = runtime.status()

            self.assertEqual(status["template"], "web")
            self.assertEqual(
                status["runnable_node_ids"],
                ["web_fetch_root", "web_inspect_headers", "web_check_common_files", "web_extract_forms"],
            )
            self.assertIn("web_fetch", runtime.required_tools())
            self.assertIn("web_verb_call", runtime.required_tools())
            self.assertEqual(runtime.state["facts"]["task.target_url"]["value"], "https://challenge.test")

    def test_file_category_template_starts_with_inventory(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = PlanRuntime.initialize("pwn challenge attachment chal.bin", run_dir=tmp)

            self.assertEqual(runtime.status()["runnable_node_ids"], ["pwn_inventory_assets"])
            self.assertEqual(runtime.required_tools(), ["list_files", "mcp_refresh"])


class ExtractorTests(unittest.TestCase):
    def test_web_extractor_commits_routes_forms_headers_and_safe_cookie_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = PlanRuntime.initialize("Web target https://challenge.test", run_dir=tmp)
            result = {
                "status": "success",
                "verb": "web.enumerate_routes",
                "data": {
                    "url": "https://challenge.test/login?id=1",
                    "status_code": 200,
                    "headers": {"server": "Werkzeug/3.0", "set-cookie": "session=secret"},
                    "routes": [{"path": "/login"}, {"path": "/download"}],
                    "forms": [{"fields": [{"name": "username"}, {"name": "password"}]}],
                    "cookies": ["session=secret; HttpOnly"],
                },
            }
            observed = runtime.observe_tool_result(
                tool_name="web_verb_call",
                args={"verb": "web.enumerate_routes", "args": {"url": "https://challenge.test"}},
                result=result,
                turn=1,
            )
            facts = runtime.state["facts"]

            self.assertEqual(facts["web.routes"]["value"], ["/login", "/download"])
            self.assertTrue(facts["web.has_forms"]["value"])
            self.assertIn("username", facts["web.parameters"]["value"])
            self.assertIn("python-flask", facts["web.framework_hints"]["value"])
            self.assertEqual(facts["web.cookie_metadata"]["value"], [{"name": "session"}])
            self.assertNotIn("secret", str(facts["web.cookie_metadata"]))
            evidence = runtime.state["evidence"][observed["evidence_id"]]
            self.assertNotIn("secret", str(evidence))
            self.assertIn("<redacted:", str(evidence))
            self.assertIn("web.routes", observed["changed_fact_keys"])

    def test_pwn_extractor_parses_checksec_and_crash(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = PlanRuntime.initialize("pwn challenge", run_dir=tmp)
            runtime.observe_tool_result(
                tool_name="mcp__ctf__checksec_file",
                args={"path": "chal"},
                result={
                    "stdout": "Full RELRO    Canary found    NX enabled    PIE enabled\nSegmentation fault",
                    "exit_code": 139,
                    "status": "success",
                },
                turn=1,
            )
            facts = runtime.state["facts"]

            self.assertEqual(facts["binary.protections"]["value"]["relro"], "full")
            self.assertTrue(facts["binary.protections"]["value"]["canary"])
            self.assertTrue(facts["binary.crash_observed"]["value"])

    def test_reverse_and_forensics_extractors_commit_domain_facts(self):
        with tempfile.TemporaryDirectory() as reverse_tmp, tempfile.TemporaryDirectory() as forensic_tmp:
            reverse = PlanRuntime.initialize("reverse challenge", run_dir=reverse_tmp)
            reverse.observe_tool_result(
                tool_name="mcp__ctf__strings_extract",
                args={"path": "chal"},
                result={"status": "success", "stdout": "UPX!\nsecret_checker\nIsDebuggerPresent\n"},
                turn=1,
            )
            forensic = PlanRuntime.initialize("forensics pcap", run_dir=forensic_tmp)
            forensic.observe_tool_result(
                tool_name="mcp__ctf__binwalk_scan",
                args={"path": "image.bin"},
                result={"status": "success", "stdout": "0  0x0  PNG image\n1024  0x400  Zip archive data"},
                turn=1,
            )

            self.assertTrue(reverse.state["facts"]["reverse.packed_signature"]["value"])
            self.assertIn("secret_checker", reverse.state["facts"]["reverse.interesting_strings"]["value"])
            self.assertIn("reverse.anti_debug_possible", reverse.state["hypotheses"])
            self.assertEqual(len(forensic.state["facts"]["forensics.embedded_signatures"]["value"]), 2)


class ConsistencyTests(unittest.TestCase):
    def test_argument_normalization_sorts_url_queries_and_ignores_internal_args(self):
        first = {"url": "HTTPS://EXAMPLE.TEST/a?b=2&a=1", "_index": 0}
        second = {"url": "https://example.test/a?a=1&b=2", "_tool_num": 3}

        self.assertEqual(normalize_args(first), normalize_args(second))
        self.assertEqual(args_digest("web_fetch", first), args_digest("web_fetch", second))

    def test_calls_are_classified_without_being_blocked(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = PlanRuntime.initialize("Web target https://challenge.test", run_dir=tmp)
            planned = runtime.start_execution(
                tool_name="web_fetch", args={"url": "https://challenge.test"}, turn=1
            )
            exploratory = runtime.start_execution(
                tool_name="memory_search", args={"query": "unknown clue"}, turn=2
            )
            deviation = runtime.start_execution(
                tool_name="code_run", args={"script": "print('unplanned')"}, turn=3
            )

            self.assertEqual(planned["classification"], "planned")
            self.assertEqual(exploratory["classification"], "exploratory")
            self.assertEqual(deviation["classification"], "deviation")
            self.assertNotIn("allowed", planned)

    def test_repeated_no_yield_call_and_unplanned_evidence_produce_hints(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = PlanRuntime.initialize("Web target https://challenge.test", run_dir=tmp)
            first = runtime.start_execution(tool_name="memory_search", args={"query": "nothing"}, turn=1)
            runtime.observe_tool_result(
                tool_name="memory_search",
                args={"query": "nothing"},
                result={"status": "not_found"},
                turn=1,
                execution_id=first["execution_id"],
            )
            repeated = runtime.start_execution(tool_name="memory_search", args={"query": "nothing"}, turn=2)
            repeated_result = runtime.observe_tool_result(
                tool_name="memory_search",
                args={"query": "nothing"},
                result={"status": "not_found"},
                turn=2,
                execution_id=repeated["execution_id"],
            )
            exploratory = runtime.start_execution(
                tool_name="web_fetch", args={"url": "https://challenge.test/robots.txt"}, turn=3
            )
            exploratory_result = runtime.observe_tool_result(
                tool_name="web_fetch",
                args={"url": "https://challenge.test/robots.txt"},
                result={"status": "success", "source_url": "https://challenge.test/robots.txt", "content": "Disallow: /admin"},
                turn=3,
                execution_id=exploratory["execution_id"],
            )

            self.assertEqual(repeated["classification"], "repeated")
            self.assertEqual(repeated_result["replan_hint"]["suggested_action"], "plan_revise")
            self.assertEqual(exploratory["classification"], "exploratory")
            self.assertEqual(exploratory_result["replan_hint"]["suggested_action"], "plan_expand")
            self.assertIn("web.urls", exploratory_result["changed_fact_keys"])

    def test_direct_observation_counts_its_synthesized_execution(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = PlanRuntime.initialize("Web target https://challenge.test", run_dir=tmp)

            observed = runtime.observe_tool_result(
                tool_name="memory_search",
                args={"query": "clue"},
                result={"status": "not_found"},
                turn=1,
            )

            self.assertEqual(observed["classification"], "exploratory")
            self.assertEqual(runtime.status()["metrics"]["exploratory"], 1)


class ResumeTests(unittest.TestCase):
    def test_initialize_resumes_matching_state_and_recovers_running_execution(self):
        with tempfile.TemporaryDirectory() as tmp:
            prompt = "Web target https://challenge.test"
            runtime = PlanRuntime.initialize(prompt, run_dir=tmp)
            execution = runtime.start_execution(
                tool_name="web_fetch", args={"url": "https://challenge.test"}, turn=1
            )

            resumed = PlanRuntime.initialize(prompt, run_dir=tmp)

            self.assertEqual(resumed.state["executions"][-1]["execution_id"], execution["execution_id"])
            self.assertEqual(resumed.state["executions"][-1]["status"], "interrupted")
            self.assertEqual(resumed.state["nodes"]["web_fetch_root"]["status"], "runnable")
            self.assertGreaterEqual(resumed.state["nodes"]["web_fetch_root"]["interrupted_count"], 1)

    def test_different_prompt_reinitializes_same_run_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = PlanRuntime.initialize("Web target https://one.test", run_dir=tmp)
            first.observe_tool_result(
                tool_name="memory_search", args={"query": "x"}, result={"status": "not_found"}, turn=1
            )

            second = PlanRuntime.initialize("Web target https://two.test", run_dir=tmp)

            self.assertNotEqual(first.state["prompt_digest"], second.state["prompt_digest"])
            self.assertEqual(len(second.state["executions"]), 0)
            self.assertEqual(second.state["facts"]["task.target_url"]["value"], "https://two.test")


class HandlerIntegrationTests(unittest.TestCase):
    def test_dispatch_records_plan_execution_without_blocking_tool_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = PlanRuntime.initialize("Web target https://challenge.test", run_dir=tmp)
            parent = SimpleNamespace(
                plan_runtime_state=runtime.state,
                plan_runtime_path=runtime.state["path"],
                task_tree_enabled=False,
                error_handler_enabled=False,
            )
            handler = SecHeurAgentHandler(parent, cwd=tmp)
            handler.current_turn = 1
            handler.do_web_fetch = lambda args, response: StepOutcome(
                {"status": "success", "source_url": args["url"], "content": "root"},
                next_prompt="tool-result",
            )

            outcome = exhaust(handler.dispatch("web_fetch", {"url": "https://challenge.test"}, None))

            self.assertEqual(outcome.data["content"], "root")
            self.assertIn("tool-result", outcome.next_prompt)
            self.assertIn("[Plan Runtime] planned execution", outcome.next_prompt)
            self.assertEqual(runtime.state["nodes"]["web_fetch_root"]["status"], "done")
            self.assertEqual(runtime.state["executions"][-1]["classification"], "planned")


if __name__ == "__main__":
    unittest.main()
