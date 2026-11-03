import json
import tempfile
import queue
import unittest
from pathlib import Path
from unittest.mock import patch

from secheur_core import SecHeurAgentHandler
from agentmain import SecHeurAgent
from agent_registry import reset_agent_cache
from agent_loop import StepOutcome


class DummyParent:
    task_dir = None
    verbose = False


class TemporaryRunnerParent(DummyParent):
    def __init__(self):
        self.calls = []

    def run_temporary_sub_agent(self, payload):
        self.calls.append(payload)
        yield '<temp_sub_agent_dialog id="tmp-1" agent="reviewer" status="running">\n'
        yield '<message role="master">the patch</message>\n'
        yield '<message role="agent">发现 1 个问题</message>\n'
        yield '<status>completed</status>\n'
        yield '</temp_sub_agent_dialog>\n'
        return StepOutcome(
            {"status": "completed", "agent": payload["agent"], "result": "发现 1 个问题"},
            next_prompt="[Sub-Agent:reviewer] 临时智能体已完成。\n\n发现 1 个问题",
        )


class PlainDictRunnerParent(DummyParent):
    def __init__(self):
        self.calls = []

    def run_temporary_sub_agent(self, payload):
        self.calls.append(payload)
        yield '<temp_sub_agent_dialog id="tmp-plain" agent="reviewer" status="running">\n'
        return {"status": "completed", "agent": payload["agent"], "result": "plain dict report"}


class PromptDictRunnerParent(DummyParent):
    def __init__(self):
        self.calls = []

    def run_temporary_sub_agent(self, payload):
        self.calls.append(payload)
        yield '<temp_sub_agent_dialog id="tmp-prompt" agent="reviewer" status="running">\n'
        return {
            "status": "completed",
            "agent": payload["agent"],
            "prompt": payload["prompt"],
            "result": "runner echoed payload",
        }


class PromptStepOutcomeRunnerParent(DummyParent):
    def __init__(self):
        self.calls = []

    def run_temporary_sub_agent(self, payload):
        self.calls.append(payload)
        yield '<temp_sub_agent_dialog id="tmp-step-prompt" agent="reviewer" status="running">\n'
        return StepOutcome(
            {
                "status": "completed",
                "agent": payload["agent"],
                "prompt": payload["prompt"],
                "result": "step outcome echoed payload",
            },
            next_prompt="[Sub-Agent:reviewer] step outcome report",
        )


class LeakyPromptStepOutcomeRunnerParent(DummyParent):
    def __init__(self):
        self.calls = []

    def run_temporary_sub_agent(self, payload):
        self.calls.append(payload)
        yield '<temp_sub_agent_dialog id="tmp-leaky-prompt" agent="reviewer" status="running">\n'
        return StepOutcome(
            {
                "status": "completed",
                "agent": payload["agent"],
                "result": "isolated review report",
            },
            next_prompt=f"[Sub-Agent:reviewer] {payload['prompt']}\n\nisolated review report",
        )


def write_agent(root, name, body, meta=None):
    meta = meta or {}
    path = Path(root) / f"{name}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = ["---"]
    for key, value in meta.items():
        lines.append(f"{key}: {value}")
    lines += ["---", "", body]
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


class SubAgentIntegrationTests(unittest.TestCase):
    def tearDown(self):
        reset_agent_cache()

    def _run_generator(self, gen):
        chunks = []
        while True:
            try:
                chunks.append(next(gen))
            except StopIteration as done:
                return "".join(chunks), done.value

    def test_cli_agent_runs_temporary_sub_agent_with_inherited_file_state(self):
        class FakeChildAgent:
            last_instance = None

            def __init__(self):
                self.task_queue = queue.Queue()
                self.inc_out = False
                self.verbose = True
                self.is_running = False
                self.stop_sig = False
                self.handler = None
                FakeChildAgent.last_instance = self

            def load_llm_sessions(self):
                pass

            def put_task(self, query, source="user", images=None):
                display_queue = queue.Queue()
                self.task_queue.put({"query": query, "source": source, "output": display_queue})
                return display_queue

            def run(self):
                task = self.task_queue.get()
                self.is_running = True
                task["output"].put({"next": "child says hello", "source": task["source"]})
                task["output"].put({"done": "child final report", "source": task["source"]})
                self.is_running = False
                self.task_queue.task_done()

            def abort(self):
                self.stop_sig = True
                self.is_running = False

        parent = SecHeurAgent.__new__(SecHeurAgent)
        parent.project_root = "/tmp/project"
        parent.permission_mode = "bypassPermissions"
        parent.memory_reference_enabled = False
        parent.llm_no = 0
        parent.allowed_tools = None

        with patch("agentmain.SecHeurAgent", FakeChildAgent):
            output, outcome = self._run_generator(parent.run_temporary_sub_agent({
                "agent": "reviewer",
                "task": "review patch",
                "prompt": "Review review patch",
                "allowed_tools": ["file_read"],
                "read_file_state": {"/tmp/app.py": (1, 2, "digest")},
                "read_call_state": {("/tmp/app.py", 1, 200, None, True): (1, 2, "digest")},
            }))

        self.assertIn("<temp_sub_agent_dialog", output)
        self.assertIn("child says hello", output)
        self.assertEqual(outcome.data["status"], "completed")
        self.assertIn("child final report", outcome.next_prompt)
        self.assertEqual(FakeChildAgent.last_instance.allowed_tools, ["file_read"])
        self.assertEqual(FakeChildAgent.last_instance.handler._read_file_state, {"/tmp/app.py": (1, 2, "digest")})
        self.assertEqual(
            FakeChildAgent.last_instance.handler._read_call_state,
            {("/tmp/app.py", 1, 200, None, True): (1, 2, "digest")},
        )

    def test_cli_temporary_sub_agent_writes_sidechain_transcript(self):
        class FakeChildAgent:
            def __init__(self):
                self.task_queue = queue.Queue()
                self.is_running = False
                self.stop_sig = False

            def load_llm_sessions(self):
                pass

            def put_task(self, query, source="user", images=None):
                display_queue = queue.Queue()
                self.task_queue.put({"query": query, "source": source, "output": display_queue})
                return display_queue

            def run(self):
                task = self.task_queue.get()
                self.is_running = True
                task["output"].put({"next": "child progress", "source": task["source"]})
                task["output"].put({"done": "child final report", "source": task["source"]})
                self.is_running = False
                self.task_queue.task_done()

            def abort(self):
                self.stop_sig = True
                self.is_running = False

        with tempfile.TemporaryDirectory() as tmp:
            parent = SecHeurAgent.__new__(SecHeurAgent)
            parent.project_root = tmp
            parent.permission_mode = "default"
            parent.memory_reference_enabled = True
            parent.llm_no = 0
            parent.allowed_tools = None

            with patch("agentmain.SecHeurAgent", FakeChildAgent):
                _, outcome = self._run_generator(parent.run_temporary_sub_agent({
                    "agent": "reviewer",
                    "task": "review patch",
                    "prompt": "Review review patch",
                    "allowed_tools": ["file_read"],
                }))

            transcript_path = Path(outcome.data["transcript_path"])
            self.assertEqual(transcript_path.parent, Path(tmp) / "temp" / "model_responses")
            self.assertTrue(transcript_path.exists())
            transcript_text = transcript_path.read_text(encoding="utf-8")
            self.assertIn("Review review patch", transcript_text)
            self.assertIn("child progress", transcript_text)
            self.assertIn("child final report", transcript_text)

    def test_do_sub_agent_fallback_saves_custom_agent_prompt_to_transcript(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent_dir = Path(tmp) / ".secheur-agent" / "agents"
            write_agent(agent_dir, "reviewer", "Review $TASK", {"description": "Reviewer"})
            handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
            handler.project_agent_dir = agent_dir
            handler.user_agent_dir = Path(tmp) / "none"

            output, outcome = self._run_generator(
                handler.do_sub_agent({"agent_type": "reviewer", "task": "the patch"}, None)
            )

        self.assertIn("Sub-agent `reviewer`", output)
        self.assertEqual(outcome.data["status"], "isolated_fallback")
        self.assertEqual(outcome.data["agent"], "reviewer")
        self.assertNotIn("Review the patch", outcome.next_prompt)
        self.assertIn("transcript", outcome.next_prompt)

    def test_do_sub_agent_fallback_saves_prompt_without_injecting_child_context(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            agent_dir = root / ".secheur-agent" / "agents"
            write_agent(agent_dir, "reviewer", "Review $TASK", {"description": "Reviewer"})
            parent = DummyParent()
            parent.project_root = root
            handler = SecHeurAgentHandler(parent, [], cwd=str(root))
            handler.project_agent_dir = agent_dir
            handler.user_agent_dir = root / "none"

            output, outcome = self._run_generator(
                handler.do_sub_agent({"agent_type": "reviewer", "task": "the patch"}, None)
            )

            transcript_path = Path(outcome.data["transcript_path"])
            transcript_exists = transcript_path.exists()
            transcript_text = transcript_path.read_text(encoding="utf-8")

        self.assertIn("saved", output)
        self.assertEqual(outcome.data["status"], "isolated_fallback")
        self.assertTrue(transcript_exists)
        self.assertIn("Review the patch", transcript_text)
        self.assertNotIn("Review the patch", outcome.next_prompt)
        self.assertIn("transcript", outcome.next_prompt)
        self.assertNotIn("prompt", outcome.data)

    def test_do_sub_agent_uses_temporary_runner_when_available(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent_dir = Path(tmp) / ".secheur-agent" / "agents"
            write_agent(agent_dir, "reviewer", "Review $TASK", {"description": "Reviewer"})
            parent = TemporaryRunnerParent()
            handler = SecHeurAgentHandler(parent, [], cwd="./temp")
            handler.project_agent_dir = agent_dir
            handler.user_agent_dir = Path(tmp) / "none"
            handler._read_file_state = {"/tmp/app.py": (1, 2, "digest")}
            handler._read_call_state = {("/tmp/app.py", 1, 200, None, True): (1, 2, "digest")}

            output, outcome = self._run_generator(
                handler.do_sub_agent({"agent_type": "reviewer", "task": "the patch"}, None)
            )

        self.assertEqual(len(parent.calls), 1)
        self.assertEqual(parent.calls[0]["read_file_state"], handler._read_file_state)
        self.assertEqual(parent.calls[0]["read_call_state"], handler._read_call_state)
        self.assertIsNot(parent.calls[0]["read_file_state"], handler._read_file_state)
        self.assertIsNot(parent.calls[0]["read_call_state"], handler._read_call_state)
        self.assertIn("<temp_sub_agent_dialog", output)
        self.assertIn('<status>completed</status>', output)
        self.assertEqual(outcome.data["status"], "completed")
        self.assertEqual(outcome.data["agent"], "reviewer")
        self.assertIn("发现 1 个问题", outcome.next_prompt)

    def test_do_sub_agent_plain_runner_result_does_not_reinject_prompt(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent_dir = Path(tmp) / ".secheur-agent" / "agents"
            write_agent(agent_dir, "reviewer", "Review $TASK", {"description": "Reviewer"})
            parent = PlainDictRunnerParent()
            handler = SecHeurAgentHandler(parent, [], cwd="./temp")
            handler.project_agent_dir = agent_dir
            handler.user_agent_dir = Path(tmp) / "none"

            output, outcome = self._run_generator(
                handler.do_sub_agent({"agent_type": "reviewer", "task": "the patch"}, None)
            )

        self.assertIn("<temp_sub_agent_dialog", output)
        self.assertEqual(outcome.data["status"], "completed")
        self.assertIn("plain dict report", outcome.data["result"])
        self.assertNotIn("Review the patch", outcome.next_prompt)
        self.assertNotIn("prompt", outcome.data)

    def test_do_sub_agent_strips_prompt_from_plain_runner_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent_dir = Path(tmp) / ".secheur-agent" / "agents"
            write_agent(agent_dir, "reviewer", "Review $TASK", {"description": "Reviewer"})
            parent = PromptDictRunnerParent()
            handler = SecHeurAgentHandler(parent, [], cwd="./temp")
            handler.project_agent_dir = agent_dir
            handler.user_agent_dir = Path(tmp) / "none"

            _, outcome = self._run_generator(
                handler.do_sub_agent({"agent_type": "reviewer", "task": "the patch"}, None)
            )

        self.assertNotIn("prompt", outcome.data)
        self.assertNotIn("Review the patch", json.dumps(outcome.data, ensure_ascii=False))

    def test_do_sub_agent_strips_prompt_from_step_outcome_runner_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent_dir = Path(tmp) / ".secheur-agent" / "agents"
            write_agent(agent_dir, "reviewer", "Review $TASK", {"description": "Reviewer"})
            parent = PromptStepOutcomeRunnerParent()
            handler = SecHeurAgentHandler(parent, [], cwd="./temp")
            handler.project_agent_dir = agent_dir
            handler.user_agent_dir = Path(tmp) / "none"

            _, outcome = self._run_generator(
                handler.do_sub_agent({"agent_type": "reviewer", "task": "the patch"}, None)
            )

        self.assertNotIn("prompt", outcome.data)
        self.assertNotIn("Review the patch", json.dumps(outcome.data, ensure_ascii=False))

    def test_do_sub_agent_strips_prompt_from_step_outcome_next_prompt(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent_dir = Path(tmp) / ".secheur-agent" / "agents"
            write_agent(agent_dir, "reviewer", "Review $TASK", {"description": "Reviewer"})
            parent = LeakyPromptStepOutcomeRunnerParent()
            handler = SecHeurAgentHandler(parent, [], cwd="./temp")
            handler.project_agent_dir = agent_dir
            handler.user_agent_dir = Path(tmp) / "none"

            _, outcome = self._run_generator(
                handler.do_sub_agent({"agent_type": "reviewer", "task": "the patch"}, None)
            )

        self.assertNotIn("Review the patch", outcome.next_prompt)
        self.assertIn("isolated review report", outcome.next_prompt)

    def test_do_sub_agent_reports_missing_agent(self):
        with tempfile.TemporaryDirectory() as tmp:
            handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
            handler.project_agent_dir = Path(tmp) / ".secheur-agent" / "agents"
            handler.user_agent_dir = Path(tmp) / "none"

            output, outcome = self._run_generator(handler.do_sub_agent({"agent_type": "missing", "task": "x"}, None))

        self.assertIn("Sub-agent not found", output)
        self.assertEqual(outcome.data["status"], "not_found")

    def test_do_sub_agent_can_use_builtin_agent(self):
        with tempfile.TemporaryDirectory() as tmp:
            handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
            handler.project_agent_dir = Path(tmp) / ".secheur-agent" / "agents"
            handler.user_agent_dir = Path(tmp) / "none"

            output, outcome = self._run_generator(
                handler.do_sub_agent({"agent_type": "planner", "task": "add budget controls"}, None)
            )

        self.assertIn("Sub-agent `planner`", output)
        self.assertEqual(outcome.data["status"], "isolated_fallback")
        self.assertEqual(outcome.data["agent"], "planner")
        self.assertNotIn("Plan add budget controls", outcome.next_prompt)
        self.assertIn("transcript", outcome.next_prompt)

    def test_do_sub_agent_uses_selected_project_root_by_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_root = Path(tmp) / "project"
            agent_dir = project_root / ".secheur-agent" / "agents"
            write_agent(agent_dir, "incident", "Handle $TASK", {"description": "Incident agent"})
            handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
            handler.project_root = project_root
            handler.user_agent_dir = Path(tmp) / "none"

            output, outcome = self._run_generator(
                handler.do_sub_agent({"agent_type": "incident", "task": "the alert"}, None)
            )

        self.assertIn("Sub-agent `incident`", output)
        self.assertEqual(outcome.data["status"], "isolated_fallback")
        self.assertEqual(outcome.data["agent"], "incident")
        self.assertNotIn("Handle the alert", outcome.next_prompt)
        self.assertIn("transcript", outcome.next_prompt)


if __name__ == "__main__":
    unittest.main()
