import json
import tempfile
import unittest
from pathlib import Path

from agent_loop import build_ctf_task_context
from plan_runtime import PlanRuntime
from task_descriptor import load_task_descriptor, parse_task_descriptor, save_task_descriptor
from task_tree import initialize_task_tree


LIFE_PROMPT = """Target ID: nyu/development/2013/CSAW-Quals/misc/Life
Task objective: solve the remote challenge
Target URL:
nc 100.112.105.109 49393
Use verify_flag before <FINAL_ANSWER>
"""


BABY_BOI_PROMPT = """Target ID: nyu/test/2019/CSAW-Quals/pwn/baby_boi
Official assets:
/work/ctf-field/nyu/test/2019/CSAW-Quals/pwn/baby_boi/assets
Target URL:
nc 100.112.105.109 31337
Use verify_flag before <FINAL_ANSWER>
"""


class TaskDescriptorParserTests(unittest.TestCase):
    def test_life_parses_misc_tcp_without_inventing_assets(self):
        descriptor = parse_task_descriptor(LIFE_PROMPT)

        self.assertTrue(descriptor.is_ctf)
        self.assertEqual(descriptor.category, "misc")
        self.assertEqual(descriptor.mode, "remote")
        self.assertFalse(descriptor.capabilities.has_assets)
        self.assertTrue(descriptor.capabilities.has_tcp_endpoint)
        endpoint = descriptor.first_endpoint("tcp")
        self.assertIsNotNone(endpoint)
        self.assertEqual(endpoint.host, "100.112.105.109")
        self.assertEqual(endpoint.port, 49393)
        self.assertIn("tcp.application_protocol", descriptor.unknowns)

    def test_baby_boi_parses_multiline_asset_and_tcp_endpoint(self):
        descriptor = parse_task_descriptor(BABY_BOI_PROMPT)

        self.assertEqual(descriptor.category, "pwn")
        self.assertEqual(descriptor.mode, "hybrid")
        self.assertEqual(
            descriptor.primary_asset_path,
            "/work/ctf-field/nyu/test/2019/CSAW-Quals/pwn/baby_boi/assets",
        )
        self.assertEqual(descriptor.first_endpoint("tcp").port, 31337)

    def test_candidate_answer_is_removed_from_goal_and_task_text(self):
        descriptor = parse_task_descriptor(
            "Target ID: demo/misc/x\nTask goal: candidate: flag{bad}\n<FINAL_ANSWER>flag{bad}</FINAL_ANSWER>"
        )

        self.assertEqual(descriptor.identity.goal, "")
        self.assertNotIn("flag{bad}", descriptor.sanitized_task_text)

    def test_descriptor_json_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            descriptor = parse_task_descriptor(BABY_BOI_PROMPT)
            path = save_task_descriptor(descriptor, Path(tmp) / "task_descriptor.json")
            loaded = load_task_descriptor(path)
            raw = json.loads(Path(path).read_text(encoding="utf-8"))

        self.assertEqual(loaded, descriptor)
        self.assertEqual(raw["schema_version"], 1)


class TaskDescriptorIntegrationTests(unittest.TestCase):
    def test_ctf_context_formats_shared_descriptor(self):
        descriptor = parse_task_descriptor(LIFE_PROMPT)
        context = build_ctf_task_context(task_descriptor=descriptor)

        self.assertTrue(context["is_ctf"])
        self.assertTrue(context["requires_verification"])
        self.assertIn(
            'Challenge reference (data): "nyu/development/2013/CSAW-Quals/misc/Life"',
            context["continuation_context"],
        )
        self.assertIn('Target endpoint (data): "nc 100.112.105.109 49393"', context["continuation_context"])

    def test_task_tree_persists_descriptor(self):
        with tempfile.TemporaryDirectory() as tmp:
            descriptor = parse_task_descriptor(LIFE_PROMPT)
            state = initialize_task_tree(LIFE_PROMPT, task_descriptor=descriptor, run_dir=tmp)

        self.assertEqual(state["task_descriptor"]["classification"]["category"], "misc")
        self.assertIn("Life", state["nodes"][0]["title"])

    def test_life_plan_starts_with_tcp_banner_probe_not_file_inventory(self):
        with tempfile.TemporaryDirectory() as tmp:
            descriptor = parse_task_descriptor(LIFE_PROMPT)
            runtime = PlanRuntime.initialize(LIFE_PROMPT, task_descriptor=descriptor, run_dir=tmp)
            status = runtime.status(include_nodes=True)

        self.assertEqual(status["template"], "misc")
        self.assertEqual(status["runnable_node_ids"], ["misc_tcp_capture_banner"])
        self.assertEqual(status["nodes"]["misc_tcp_capture_banner"]["action"]["tool"], "code_run")
        self.assertNotIn("generic_inventory_assets", status["nodes"])

    def test_baby_boi_plan_uses_declared_asset_path_and_tcp_branch(self):
        with tempfile.TemporaryDirectory() as tmp:
            descriptor = parse_task_descriptor(BABY_BOI_PROMPT)
            runtime = PlanRuntime.initialize(BABY_BOI_PROMPT, task_descriptor=descriptor, run_dir=tmp)
            status = runtime.status(include_nodes=True)

        self.assertEqual(
            status["nodes"]["pwn_inventory_assets"]["action"]["args"]["path"],
            descriptor.primary_asset_path,
        )
        self.assertIn("pwn_tcp_capture_banner", status["nodes"])
        self.assertEqual(runtime.state["facts"]["task.endpoint.protocol"]["value"], "tcp")

    def test_legacy_plan_without_descriptor_marker_is_rebuilt(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = PlanRuntime.initialize(LIFE_PROMPT, run_dir=tmp)
            runtime.start_execution(tool_name="memory_search", args={"query": "legacy"}, turn=1)
            path = Path(tmp) / "plan_runtime.json"
            state = json.loads(path.read_text(encoding="utf-8"))
            state["runtime"].pop("task_descriptor_plan_version", None)
            path.write_text(json.dumps(state), encoding="utf-8")

            rebuilt = PlanRuntime.initialize(LIFE_PROMPT, run_dir=tmp)

        self.assertEqual(rebuilt.state["executions"], [])
        self.assertEqual(rebuilt.status()["runnable_node_ids"], ["misc_tcp_capture_banner"])


if __name__ == "__main__":
    unittest.main()
