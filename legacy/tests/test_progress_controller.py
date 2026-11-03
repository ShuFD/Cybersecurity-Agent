import tempfile
import unittest

from plan_runtime import PlanRuntime, ProgressController


class ProgressControllerTests(unittest.TestCase):
    def test_deterministic_repeat_is_short_circuited_without_new_evidence(self):
        controller = ProgressController()
        args = {"path": "/work/a.bin", "start": 0, "count": 20}

        first_preflight = controller.before_tool(tool_name="file_read", args=args, turn=1)
        first = controller.after_tool(
            tool_name="file_read",
            args=args,
            result={"status": "success", "content": "ELF"},
            turn=1,
            preflight=first_preflight,
        )
        second_preflight = controller.before_tool(tool_name="file_read", args=args, turn=2)
        second = controller.after_tool(
            tool_name="file_read",
            args=args,
            result={"status": "success", "content": "ELF"},
            turn=2,
            preflight=second_preflight,
        )
        third_preflight = controller.before_tool(tool_name="file_read", args=args, turn=3)

        self.assertTrue(first["useful_progress"])
        self.assertFalse(second["useful_progress"])
        self.assertEqual(third_preflight["action"], "SHORT_CIRCUIT")

    def test_repeated_no_progress_requests_replan_then_stops(self):
        controller = ProgressController(replan_after=2, phase_replan_after=4, stop_after=6)
        actions = []
        for turn in range(1, 7):
            args = {"include_nodes": bool(turn % 2), "nonce": turn}
            preflight = controller.before_tool(tool_name="plan_status", args=args, turn=turn)
            decision = controller.after_tool(
                tool_name="plan_status",
                args=args,
                result={"status": "success"},
                turn=turn,
                preflight=preflight,
            )
            actions.append(decision["action"])

        self.assertIn("REPLAN_BRANCH", actions)
        self.assertEqual(actions[-1], "STOP_STUCK")
        self.assertEqual(controller.snapshot()["terminal_state"], "stuck")
        self.assertEqual(controller.snapshot()["phase"], "stuck")
        self.assertIn("STOP_STUCK", controller.prompt_for(controller.snapshot()["last_decision"]))

    def test_changed_fact_resets_no_progress_streak(self):
        controller = ProgressController()
        decision = controller.after_tool(
            tool_name="code_run",
            args={"script": "true"},
            result={"status": "success", "stdout": ""},
            turn=3,
            plan_summary={"changed_fact_keys": ["binary.arch"]},
        )

        self.assertTrue(decision["useful_progress"])
        self.assertEqual(decision["no_progress_streak"], 0)

    def test_verified_candidate_is_terminal(self):
        controller = ProgressController()
        decision = controller.after_tool(
            tool_name="verify_flag",
            args={"candidate": "flag{ok}"},
            result={"correct": True},
            turn=5,
        )

        self.assertEqual(decision["action"], "STOP_SOLVED")
        self.assertEqual(controller.snapshot()["verification_state"], "accepted")

    def test_volatile_transport_headers_do_not_create_false_progress(self):
        controller = ProgressController()
        args = {"url": "https://example.test/"}

        first = controller.after_tool(
            tool_name="web_fetch",
            args=args,
            result={"status": "success", "headers": {"Date": "t1"}, "body": "same"},
            turn=1,
        )
        second = controller.after_tool(
            tool_name="web_fetch",
            args=args,
            result={"status": "success", "headers": {"Date": "t2"}, "body": "same"},
            turn=2,
        )

        self.assertTrue(first["useful_progress"])
        self.assertFalse(second["useful_progress"])
        self.assertEqual(second["no_progress_streak"], 1)

    def test_flag_recovery_blocks_are_counted_and_can_stop_the_task(self):
        controller = ProgressController(replan_after=2, phase_replan_after=4, stop_after=6)
        decision = None
        for turn in range(1, 7):
            args = {"candidate": f"flag{{{turn}}}"}
            preflight = controller.before_tool(tool_name="verify_flag", args=args, turn=turn)
            decision = controller.after_tool(
                tool_name="verify_flag",
                args=args,
                result={"status": "blocked", "reason": "flag_rejection_recovery_required"},
                turn=turn,
                preflight=preflight,
            )

        self.assertEqual(decision["action"], "STOP_STUCK")
        self.assertEqual(controller.snapshot()["no_progress_streak"], 6)


class InitialTemplatePathTests(unittest.TestCase):
    def test_official_asset_path_is_used_by_file_inventory(self):
        prompt = "Reverse challenge\nOfficial assets: /work/demo/assets\n"
        with tempfile.TemporaryDirectory() as tmp:
            runtime = PlanRuntime.initialize(prompt, run_dir=tmp)
            node = runtime.state["nodes"]["reverse_inventory_assets"]

        self.assertEqual(node["action"]["args"]["path"], "/work/demo/assets")
        self.assertEqual(runtime.state["facts"]["task.asset_path"]["value"], "/work/demo/assets")

    def test_unchanged_result_keeps_planned_node_runnable(self):
        prompt = "Reverse challenge\nOfficial assets: /work/demo/assets\n"
        with tempfile.TemporaryDirectory() as tmp:
            runtime = PlanRuntime.initialize(prompt, run_dir=tmp)
            controller = ProgressController()
            args = {"pattern": "**/*", "path": "/work/demo/assets"}
            preflight = controller.before_tool(tool_name="list_files", args=args, turn=1)
            execution = runtime.start_execution(tool_name="list_files", args=args, turn=1)
            summary = runtime.observe_tool_result(
                tool_name="list_files",
                args=args,
                result={"status": "unchanged"},
                turn=1,
                execution_id=execution["execution_id"],
                progress_controller=controller,
                progress_preflight=preflight,
            )

            node = runtime.state["nodes"]["reverse_inventory_assets"]
            self.assertFalse(summary["useful_progress"])
            self.assertEqual(node["status"], "runnable")
            self.assertEqual(node["no_progress_count"], 1)


if __name__ == "__main__":
    unittest.main()
