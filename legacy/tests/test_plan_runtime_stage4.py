import json
import tempfile
import unittest
from types import SimpleNamespace

from agent_loop import StepOutcome, exhaust
from plan_runtime import PlanRuntime
from secheur_core import SecHeurAgentHandler


RAW_CTF_TOOLS = (
    "identify_file",
    "checksec_file",
    "strings_extract",
    "binwalk_scan",
    "run_ctf_tool",
)


def ctf_schemas():
    return [
        {
            "type": "function",
            "function": {
                "name": f"mcp__ctf-toolbox__{raw_name}",
                "description": raw_name,
                "parameters": {"type": "object", "properties": {}},
            },
        }
        for raw_name in RAW_CTF_TOOLS
    ]


def complete_inventory(runtime, files, turn=1):
    args = {"pattern": "**/*", "path": "."}
    execution = runtime.start_execution(tool_name="list_files", args=args, turn=turn)
    return runtime.observe_tool_result(
        tool_name="list_files",
        args=args,
        result={"status": "success", "files": files},
        turn=turn,
        execution_id=execution["execution_id"],
    )


def complete_mcp_refresh(runtime, turn=2):
    schemas = ctf_schemas()
    names = [schema["function"]["name"] for schema in schemas]
    execution = runtime.start_execution(tool_name="mcp_refresh", args={}, turn=turn)
    return runtime.observe_tool_result(
        tool_name="mcp_refresh",
        args={},
        result={"status": "success", "tools": names},
        turn=turn,
        execution_id=execution["execution_id"],
        available_tools=schemas,
    )


def complete_identify(runtime, path, file_info, turn=3):
    action = next(
        item
        for item in runtime.status()["runnable"]
        if item["tool"].endswith("__identify_file") and item["args"].get("path") == path
    )
    execution = runtime.start_execution(tool_name=action["tool"], args=action["args"], turn=turn)
    nested = {
        "path": f"/work/{path}",
        "size": 4096,
        "file": file_info,
        "sha256": f"abc123  /work/{path}",
    }
    return runtime.observe_tool_result(
        tool_name=action["tool"],
        args=action["args"],
        result={"status": "success", "result": json.dumps(nested)},
        turn=turn,
        execution_id=execution["execution_id"],
        available_tools=ctf_schemas(),
    )


class SecondaryTriageTests(unittest.TestCase):
    def test_pwn_inventory_and_elf_identity_expand_grounded_probes(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = PlanRuntime.initialize("pwn challenge", run_dir=tmp)

            inventory = complete_inventory(runtime, ["chal", "libc.so.6"])
            refreshed = complete_mcp_refresh(runtime)
            identified = complete_identify(runtime, "chal", "ELF 64-bit LSB pie executable, x86-64")

            self.assertEqual(inventory["replan_decision"]["decision"], "KEEP")
            self.assertEqual(runtime.state["facts"]["artifact.files"]["value"], ["chal", "libc.so.6"])
            self.assertEqual(refreshed["replan_decision"]["decision"], "EXPAND")
            self.assertTrue(refreshed["replan_decision"]["auto_applied"])
            self.assertEqual(identified["replan_decision"]["decision"], "EXPAND")
            tools = {
                (runtime.state["nodes"][node_id].get("action") or {}).get("tool")
                for node_id in identified["triage_result"]["added_node_ids"]
            }
            self.assertIn("mcp__ctf-toolbox__checksec_file", tools)
            self.assertIn("mcp__ctf-toolbox__strings_extract", tools)
            self.assertIn("mcp__ctf-toolbox__run_ctf_tool", tools)

    def test_reverse_apk_identity_adds_package_and_embedded_content_probes(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = PlanRuntime.initialize("reverse APK challenge", run_dir=tmp)
            complete_inventory(runtime, ["app.apk"])
            complete_mcp_refresh(runtime)

            identified = complete_identify(runtime, "app.apk", "Zip archive data, Android package (APK)")
            nodes = [runtime.state["nodes"][node_id] for node_id in identified["triage_result"]["added_node_ids"]]
            operations = {node["id"].split("_", 2)[1] for node in nodes}

            self.assertEqual(identified["replan_decision"]["decision"], "EXPAND")
            self.assertIn("strings", operations)
            self.assertIn("archive", operations)
            self.assertIn("binwalk", operations)

    def test_forensics_pcap_identity_adds_capture_summary_and_protocol_probes(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = PlanRuntime.initialize("forensics PCAP challenge", run_dir=tmp)
            complete_inventory(runtime, ["capture.pcapng"])
            complete_mcp_refresh(runtime)

            identified = complete_identify(runtime, "capture.pcapng", "pcapng capture file, little-endian")
            action_argv = [
                runtime.state["nodes"][node_id]["action"]["args"].get("argv")
                for node_id in identified["triage_result"]["added_node_ids"]
            ]

            self.assertTrue(any(argv and argv[0] == "capinfos" for argv in action_argv))
            self.assertTrue(any(argv and argv[0] == "tshark" for argv in action_argv))

    def test_nested_mcp_json_is_normalized_into_path_specific_file_type_fact(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = PlanRuntime.initialize("reverse challenge", run_dir=tmp)
            complete_inventory(runtime, ["target.bin"])
            complete_mcp_refresh(runtime)

            complete_identify(runtime, "target.bin", "ELF 64-bit LSB executable, x86-64")

            self.assertEqual(
                runtime.state["facts"]["artifact.file_types"]["value"]["target.bin"],
                "ELF 64-bit LSB executable, x86-64",
            )


class ReplanDecisionTests(unittest.TestCase):
    def test_keep_expand_revise_and_complete_decisions(self):
        with tempfile.TemporaryDirectory() as keep_tmp:
            keep_runtime = PlanRuntime.initialize("Web target https://challenge.test", run_dir=keep_tmp)
            execution = keep_runtime.start_execution(
                tool_name="web_fetch", args={"url": "https://challenge.test"}, turn=1
            )
            kept = keep_runtime.observe_tool_result(
                tool_name="web_fetch",
                args={"url": "https://challenge.test"},
                result={"status": "success"},
                turn=1,
                execution_id=execution["execution_id"],
            )
            self.assertEqual(kept["replan_decision"]["decision"], "KEEP")

        with tempfile.TemporaryDirectory() as expand_tmp:
            expand_runtime = PlanRuntime.initialize("Web target https://challenge.test", run_dir=expand_tmp)
            execution = expand_runtime.start_execution(
                tool_name="web_fetch", args={"url": "https://challenge.test/robots.txt"}, turn=1
            )
            expanded = expand_runtime.observe_tool_result(
                tool_name="web_fetch",
                args={"url": "https://challenge.test/robots.txt"},
                result={"status": "success", "source_url": "https://challenge.test/robots.txt"},
                turn=1,
                execution_id=execution["execution_id"],
            )
            self.assertEqual(expanded["replan_decision"]["decision"], "EXPAND")
            self.assertTrue(expanded["replan_decision"]["requires_planner_action"])

        with tempfile.TemporaryDirectory() as revise_tmp:
            revise_runtime = PlanRuntime.initialize("Web target https://challenge.test", run_dir=revise_tmp)
            first = revise_runtime.start_execution(tool_name="memory_search", args={"query": "none"}, turn=1)
            revise_runtime.observe_tool_result(
                tool_name="memory_search",
                args={"query": "none"},
                result={"status": "not_found"},
                turn=1,
                execution_id=first["execution_id"],
            )
            repeated = revise_runtime.start_execution(tool_name="memory_search", args={"query": "none"}, turn=2)
            revised = revise_runtime.observe_tool_result(
                tool_name="memory_search",
                args={"query": "none"},
                result={"status": "not_found"},
                turn=2,
                execution_id=repeated["execution_id"],
            )
            self.assertEqual(revised["replan_decision"]["decision"], "REVISE")

        with tempfile.TemporaryDirectory() as complete_tmp:
            complete_runtime = PlanRuntime.initialize("Web target https://challenge.test", run_dir=complete_tmp)
            execution = complete_runtime.start_execution(
                tool_name="verify_flag", args={"candidate": "flag{ok}"}, turn=1
            )
            completed = complete_runtime.observe_tool_result(
                tool_name="verify_flag",
                args={"candidate": "flag{ok}"},
                result={"status": "success", "correct": True},
                turn=1,
                execution_id=execution["execution_id"],
            )
            self.assertEqual(completed["replan_decision"]["decision"], "COMPLETE")
            self.assertEqual(complete_runtime.status()["metrics"]["decision_complete"], 1)

    def test_nested_mcp_nonzero_exit_marks_node_failed_and_requests_revision(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = PlanRuntime.initialize("pwn challenge", run_dir=tmp)
            complete_inventory(runtime, ["chal"])
            complete_mcp_refresh(runtime)
            action = next(
                item
                for item in runtime.status()["runnable"]
                if item["tool"].endswith("__identify_file")
            )
            execution = runtime.start_execution(
                tool_name=action["tool"], args=action["args"], turn=3
            )

            observed = runtime.observe_tool_result(
                tool_name=action["tool"],
                args=action["args"],
                result={
                    "status": "success",
                    "result": json.dumps(
                        {"exit_code": 2, "stdout": "", "stderr": "file failed"}
                    ),
                },
                turn=3,
                execution_id=execution["execution_id"],
                available_tools=ctf_schemas(),
            )

            self.assertEqual(observed["replan_decision"]["decision"], "REVISE")
            self.assertEqual(runtime.state["nodes"][action["id"]]["status"], "failed")

    def test_missing_domain_tools_requests_revision_after_refresh(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = PlanRuntime.initialize("forensics challenge", run_dir=tmp)
            complete_inventory(runtime, ["capture.pcap"])
            execution = runtime.start_execution(tool_name="mcp_refresh", args={}, turn=2)

            observed = runtime.observe_tool_result(
                tool_name="mcp_refresh",
                args={},
                result={"status": "not_found", "tools": []},
                turn=2,
                execution_id=execution["execution_id"],
            )

            self.assertEqual(observed["triage_result"]["status"], "waiting_for_domain_tools")
            self.assertEqual(observed["replan_decision"]["decision"], "REVISE")
            self.assertEqual(
                observed["replan_decision"]["reason"],
                "configured_domain_analysis_tools_unavailable",
            )


class HandlerReplanIntegrationTests(unittest.TestCase):
    def test_handler_syncs_mcp_catalog_activates_tools_and_injects_decision(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = PlanRuntime.initialize("pwn challenge", run_dir=tmp)
            parent = SimpleNamespace(
                plan_runtime_state=runtime.state,
                plan_runtime_path=runtime.state["path"],
                task_tree_enabled=False,
                error_handler_enabled=False,
                mcp_tool_schemas=ctf_schemas(),
                activated_tools=set(),
            )
            handler = SecHeurAgentHandler(parent, cwd=tmp)
            handler.current_turn = 1
            handler.do_list_files = lambda args, response: StepOutcome(
                {"status": "success", "files": ["chal"]},
                next_prompt="inventory-result",
            )

            outcome = exhaust(
                handler.dispatch("list_files", {"pattern": "**/*", "path": "."}, None)
            )

            self.assertIn("inventory-result", outcome.next_prompt)
            self.assertIn("[Replan Decision] EXPAND", outcome.next_prompt)
            self.assertEqual(
                handler.working["plan_runtime"]["replan_decision"]["decision"],
                "EXPAND",
            )
            self.assertIn("mcp__ctf-toolbox__identify_file", parent.activated_tools)
            identify_nodes = [
                node
                for node in runtime.state["nodes"].values()
                if (node.get("action") or {}).get("tool") == "mcp__ctf-toolbox__identify_file"
            ]
            self.assertEqual(len(identify_nodes), 1)


if __name__ == "__main__":
    unittest.main()
