import tempfile
import unittest
import os
import queue
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import agentmain
from agent_loop import StepOutcome
from secheur_core import SecHeurAgentHandler
from skill_registry import reset_skill_cache


class DummyParent:
    task_dir = None
    verbose = False


class TemporaryRunnerParent(DummyParent):
    def __init__(self):
        self.calls = []

    def run_temporary_sub_agent(self, payload):
        self.calls.append(payload)
        yield '<temp_sub_agent_dialog id="tmp-skill" agent="skill:deep-review" status="running">\n'
        yield '<message role="agent">skill review result</message>\n'
        yield '<status>completed</status>\n'
        yield '</temp_sub_agent_dialog>\n'
        return StepOutcome(
            {"status": "completed", "skill": payload["skill"], "result": "skill review result"},
            next_prompt="[Skill:deep-review] fork skill finished.\n\nskill review result",
        )


class PromptDictRunnerParent(DummyParent):
    def __init__(self):
        self.calls = []

    def run_temporary_sub_agent(self, payload):
        self.calls.append(payload)
        yield '<temp_sub_agent_dialog id="tmp-skill-prompt" agent="skill:deep-review" status="running">\n'
        return {
            "status": "completed",
            "skill": payload["skill"],
            "prompt": payload["prompt"],
            "result": "skill runner echoed payload",
        }


class PromptStepOutcomeRunnerParent(DummyParent):
    def __init__(self):
        self.calls = []

    def run_temporary_sub_agent(self, payload):
        self.calls.append(payload)
        yield '<temp_sub_agent_dialog id="tmp-skill-step-prompt" agent="skill:deep-review" status="running">\n'
        return StepOutcome(
            {
                "status": "completed",
                "skill": payload["skill"],
                "prompt": payload["prompt"],
                "result": "skill step outcome echoed payload",
            },
            next_prompt="[Skill:deep-review] step outcome report",
        )


class LeakyPromptStepOutcomeRunnerParent(DummyParent):
    def __init__(self):
        self.calls = []

    def run_temporary_sub_agent(self, payload):
        self.calls.append(payload)
        yield '<temp_sub_agent_dialog id="tmp-skill-leaky-prompt" agent="skill:deep-review" status="running">\n'
        return StepOutcome(
            {
                "status": "completed",
                "skill": payload["skill"],
                "result": "isolated skill report",
            },
            next_prompt=f"[Skill:deep-review] {payload['prompt']}\n\nisolated skill report",
        )


class OneTaskQueue:
    def __init__(self, task):
        self.task = task
        self.done_count = 0
        self.used = False

    def get(self):
        if self.used:
            raise StopIteration
        self.used = True
        return self.task

    def task_done(self):
        self.done_count += 1


class DisplayQueue:
    def __init__(self):
        self.items = []

    def put(self, item):
        self.items.append(item)


def write_skill(root, folder, body, meta=None):
    meta = meta or {}
    path = Path(root) / folder / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = ["---"]
    for key, value in meta.items():
        lines.append(f"{key}: {value}")
    lines += ["---", "", body]
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


class SkillIntegrationTests(unittest.TestCase):
    def tearDown(self):
        reset_skill_cache()

    def _run_generator(self, gen):
        chunks = []
        while True:
            try:
                chunks.append(next(gen))
            except StopIteration as done:
                return "".join(chunks), done.value

    def test_do_skill_returns_resolved_prompt(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = Path(tmp) / "skills"
            write_skill(
                project_dir,
                "commit",
                "Commit prompt for $ARGUMENTS",
                {"name": "commit", "description": "Commit staged changes"},
            )
            handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
            handler.project_skill_dir = project_dir
            handler.user_skill_dir = Path(tmp) / "none"

            output, outcome = self._run_generator(handler.do_skill({"skill_name": "commit", "args": "diff"}, None))

        self.assertIn("Commit prompt for diff", output)
        self.assertEqual(outcome.data["status"], "success")
        self.assertEqual(outcome.data["skill"], "commit")
        self.assertIn("Commit prompt for diff", outcome.next_prompt)

    def test_do_skill_fork_context_saves_prompt_without_injecting_child_context(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project_dir = root / "skills"
            write_skill(
                project_dir,
                "deep-review",
                "Review prompt for $ARGUMENTS",
                {"name": "deep-review", "description": "Deep review", "context": "fork"},
            )
            parent = DummyParent()
            parent.project_root = root
            handler = SecHeurAgentHandler(parent, [], cwd=str(root))
            handler.project_skill_dir = project_dir
            handler.user_skill_dir = root / "none"

            output, outcome = self._run_generator(handler.do_skill({"skill_name": "deep-review", "args": "diff"}, None))
            transcript_path = Path(outcome.data["transcript_path"])
            transcript_exists = transcript_path.exists()
            transcript_text = transcript_path.read_text(encoding="utf-8")

        self.assertIn("fork-return skill task", output)
        self.assertNotIn("Review prompt for diff", output)
        self.assertEqual(outcome.data["context"], "fork")
        self.assertEqual(outcome.data["status"], "isolated_fallback")
        self.assertTrue(transcript_exists)
        self.assertIn("Review prompt for diff", transcript_text)
        self.assertNotIn("Review prompt for diff", outcome.next_prompt)
        self.assertNotIn("prompt", outcome.data)
        self.assertIn("transcript", outcome.next_prompt)

    def test_do_skill_fork_context_uses_temporary_runner_when_available(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project_dir = root / "skills"
            write_skill(
                project_dir,
                "deep-review",
                "Review prompt for $ARGUMENTS",
                {
                    "name": "deep-review",
                    "description": "Deep review",
                    "context": "fork",
                    "allowed-tools": "file_read,code_run",
                },
            )
            parent = TemporaryRunnerParent()
            parent.project_root = root
            handler = SecHeurAgentHandler(parent, [], cwd=str(root))
            handler.project_skill_dir = project_dir
            handler.user_skill_dir = root / "none"
            handler._read_file_state = {"/tmp/app.py": (1, 2, "digest")}
            handler._read_call_state = {("/tmp/app.py", 1, 200, None, True): (1, 2, "digest")}

            output, outcome = self._run_generator(handler.do_skill({"skill_name": "deep-review", "args": "diff"}, None))

        self.assertEqual(len(parent.calls), 1)
        payload = parent.calls[0]
        self.assertEqual(payload["skill"], "deep-review")
        self.assertEqual(payload["agent"], "skill:deep-review")
        self.assertEqual(payload["allowed_tools"], ["file_read", "code_run"])
        self.assertIn("Review prompt for diff", payload["prompt"])
        self.assertEqual(payload["read_file_state"], handler._read_file_state)
        self.assertEqual(payload["read_call_state"], handler._read_call_state)
        self.assertIsNot(payload["read_file_state"], handler._read_file_state)
        self.assertIsNot(payload["read_call_state"], handler._read_call_state)
        self.assertIn("<temp_sub_agent_dialog", output)
        self.assertNotIn("prompt saved", output)
        self.assertEqual(outcome.data["status"], "completed")
        self.assertEqual(outcome.data["skill"], "deep-review")
        self.assertIn("skill review result", outcome.next_prompt)

    def test_do_skill_fork_strips_prompt_from_plain_runner_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project_dir = root / "skills"
            write_skill(
                project_dir,
                "deep-review",
                "Review prompt for $ARGUMENTS",
                {"name": "deep-review", "description": "Deep review", "context": "fork"},
            )
            parent = PromptDictRunnerParent()
            parent.project_root = root
            handler = SecHeurAgentHandler(parent, [], cwd=str(root))
            handler.project_skill_dir = project_dir
            handler.user_skill_dir = root / "none"

            _, outcome = self._run_generator(handler.do_skill({"skill_name": "deep-review", "args": "diff"}, None))

        self.assertNotIn("prompt", outcome.data)
        self.assertNotIn("Review prompt for diff", json.dumps(outcome.data, ensure_ascii=False))

    def test_do_skill_fork_strips_prompt_from_step_outcome_runner_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project_dir = root / "skills"
            write_skill(
                project_dir,
                "deep-review",
                "Review prompt for $ARGUMENTS",
                {"name": "deep-review", "description": "Deep review", "context": "fork"},
            )
            parent = PromptStepOutcomeRunnerParent()
            parent.project_root = root
            handler = SecHeurAgentHandler(parent, [], cwd=str(root))
            handler.project_skill_dir = project_dir
            handler.user_skill_dir = root / "none"

            _, outcome = self._run_generator(handler.do_skill({"skill_name": "deep-review", "args": "diff"}, None))

        self.assertNotIn("prompt", outcome.data)
        self.assertNotIn("Review prompt for diff", json.dumps(outcome.data, ensure_ascii=False))

    def test_do_skill_fork_strips_prompt_from_step_outcome_next_prompt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project_dir = root / "skills"
            write_skill(
                project_dir,
                "deep-review",
                "Review prompt for $ARGUMENTS",
                {"name": "deep-review", "description": "Deep review", "context": "fork"},
            )
            parent = LeakyPromptStepOutcomeRunnerParent()
            parent.project_root = root
            handler = SecHeurAgentHandler(parent, [], cwd=str(root))
            handler.project_skill_dir = project_dir
            handler.user_skill_dir = root / "none"

            _, outcome = self._run_generator(handler.do_skill({"skill_name": "deep-review", "args": "diff"}, None))

        self.assertNotIn("Review prompt for diff", outcome.next_prompt)
        self.assertIn("isolated skill report", outcome.next_prompt)

    def test_cli_fork_skill_runs_isolated_temporary_agent_and_writes_transcript(self):
        class FakeChildAgent:
            last_instance = None

            def __init__(self):
                self.task_queue = queue.Queue()
                self.is_running = False
                self.stop_sig = False
                self.handler = None
                FakeChildAgent.last_instance = self

            def put_task(self, query, source="user", images=None):
                display_queue = queue.Queue()
                self.task_queue.put({"query": query, "source": source, "output": display_queue})
                return display_queue

            def run(self):
                task = self.task_queue.get()
                self.is_running = True
                task["output"].put({"next": "child observed isolated prompt", "source": task["source"]})
                task["output"].put({"done": "child final skill report", "source": task["source"]})
                self.is_running = False
                self.task_queue.task_done()

            def abort(self):
                self.stop_sig = True
                self.is_running = False

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project_dir = root / ".secheur-agent" / "skills"
            app_path = root / "app.py"
            write_skill(
                project_dir,
                "deep-review",
                "Review prompt for $ARGUMENTS",
                {
                    "name": "deep-review",
                    "description": "Deep review",
                    "context": "fork",
                    "allowed-tools": "file_read",
                },
            )

            parent = agentmain.SecHeurAgent.__new__(agentmain.SecHeurAgent)
            parent.project_root = str(root)
            parent.permission_mode = "default"
            parent.memory_reference_enabled = False
            parent.force_non_stream = False
            parent.max_turns = 3
            parent.max_cost = None
            parent.peer_hint = False
            parent.custom_skill_dirs = ""
            parent.llm_no = 0
            parent.allowed_tools = None
            parent.stop_sig = False

            handler = SecHeurAgentHandler(parent, [], cwd=str(root))
            handler.project_root = str(root)
            handler.project_skill_dir = project_dir
            handler.user_skill_dir = root / "none"
            handler._read_file_state = {str(app_path): (1, 2, "digest")}
            handler._read_call_state = {(str(app_path), 1, 200, None, True): (1, 2, "digest")}

            with patch("agentmain.SecHeurAgent", FakeChildAgent):
                output, outcome = self._run_generator(
                    handler.do_skill({"skill_name": "deep-review", "args": "diff"}, None)
                )

            transcript_path = Path(outcome.data["transcript_path"])
            transcript_text = transcript_path.read_text(encoding="utf-8")

        self.assertIn("<temp_sub_agent_dialog", output)
        self.assertIn('agent="skill:deep-review"', output)
        self.assertIn("child observed isolated prompt", output)
        self.assertEqual(outcome.data["status"], "completed")
        self.assertEqual(outcome.data["agent"], "skill:deep-review")
        self.assertEqual(outcome.data["allowed_tools"], ["file_read"])
        self.assertEqual(FakeChildAgent.last_instance.allowed_tools, ["file_read"])
        self.assertEqual(FakeChildAgent.last_instance.handler._read_file_state, {str(app_path): (1, 2, "digest")})
        self.assertEqual(
            FakeChildAgent.last_instance.handler._read_call_state,
            {(str(app_path), 1, 200, None, True): (1, 2, "digest")},
        )
        self.assertEqual(transcript_path.parent, root / "temp" / "model_responses")
        self.assertIn("Review prompt for diff", transcript_text)
        self.assertIn("child final skill report", transcript_text)
        self.assertIn("child final skill report", outcome.next_prompt)

    def test_do_skill_reports_missing_skill(self):
        with tempfile.TemporaryDirectory() as tmp:
            handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
            handler.project_skill_dir = Path(tmp) / "skills"
            handler.user_skill_dir = Path(tmp) / "none"

            output, outcome = self._run_generator(handler.do_skill({"skill_name": "missing"}, None))

        self.assertIn("Skill not found", output)
        self.assertEqual(outcome.data["status"], "not_found")

    def test_task_system_prompt_uses_selected_project_skill_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_root = Path(tmp) / "project"
            write_skill(
                project_root / ".secheur-agent" / "skills",
                "project-only",
                "Project-only prompt.",
                {"name": "project-only", "description": "Local project skill"},
            )

            prompt = agentmain.build_task_system_prompt(
                "use project skill",
                prefetched_memory="",
                project_root=project_root,
            )

        self.assertIn("/project-only: Local project skill", prompt)
        self.assertIn("When a skill is relevant, call the `skill` tool before continuing", prompt)
        self.assertIn("The list below is only metadata", prompt)
        self.assertNotIn("Project-only prompt.", prompt)

    def test_task_system_prompt_reports_selected_project_root_as_cwd(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_root = Path(tmp) / "project"
            project_root.mkdir()

            prompt = agentmain.build_task_system_prompt(
                "check cwd",
                prefetched_memory="",
                project_root=project_root,
            )

        self.assertIn(f"cwd = {project_root}", prompt)
        self.assertNotIn("/agent/temp", prompt)

    def test_task_system_prompt_reports_real_memory_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_root = Path(tmp) / "project"
            project_root.mkdir()

            prompt = agentmain.build_task_system_prompt(
                "check memory path",
                prefetched_memory="",
                project_root=project_root,
            )

        memory_dir = Path(agentmain.script_dir) / "memory"
        self.assertIn(f"[Memory] ({memory_dir})", prompt)
        self.assertIn(str(memory_dir / "global_mem_insight.txt"), prompt)
        self.assertNotIn("../memory/global_mem_insight.txt", prompt)

    def test_task_system_prompt_describes_ctf_docker_mcp_tools(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_root = Path(tmp) / "project"
            project_root.mkdir()

            prompt = agentmain.build_task_system_prompt(
                "solve ctf challenge",
                prefetched_memory="",
                project_root=project_root,
            )

        self.assertIn("CTF Docker MCP", prompt)
        self.assertIn("list_tools", prompt)
        self.assertIn("binwalk", prompt)
        self.assertIn("pwndbg", prompt)
        self.assertIn("sage", prompt)

    def test_long_term_memory_update_reads_sop_from_agent_memory_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_root = Path(tmp) / "project"
            project_root.mkdir()
            old_cwd = os.getcwd()
            try:
                os.chdir(project_root)
                handler = SecHeurAgentHandler(DummyParent(), [], cwd=str(project_root))
                output, outcome = self._run_generator(handler.do_start_long_term_update({}, None))
            finally:
                os.chdir(old_cwd)

        self.assertIn("Start distilling good memory", output)
        self.assertIn("This is L0:", outcome.data)
        self.assertNotIn("Memory Management SOP not found", outcome.data)

    def test_agent_run_uses_selected_project_root_as_tool_working_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_root = Path(tmp) / "project"
            project_root.mkdir()
            display = DisplayQueue()
            captured = {}

            def fake_runner(_client, _system_prompt, _user_input, handler, _tools_schema, **_kwargs):
                captured["handler_cwd"] = handler.cwd
                yield {"turn": 1}
                yield "done"

            agent = object.__new__(agentmain.SecHeurAgent)
            agent.task_queue = OneTaskQueue({
                "query": "list files",
                "source": "user",
                "output": display,
                "memory_prefetch": None,
                "images": [],
            })
            agent.memory_reference_enabled = False
            agent.history = []
            agent.llmclient = SimpleNamespace(backend=SimpleNamespace(extra_sys_prompt=""), last_tools="", log_path="")
            agent.log_path = str(project_root / "agent.log")
            agent.peer_hint = False
            agent.force_non_stream = False
            agent.max_turns = 1
            agent.max_cost = None
            agent.verbose = False
            agent.inc_out = False
            agent.stop_sig = False
            agent.is_running = False
            agent.task_dir = None
            agent.project_root = str(project_root)
            agent.custom_skill_dirs = ""
            agent.plan_file_path = None
            agent.handler = None
            agent.activated_tools = set()
            agent.base_tools_schema = []
            agent.mcp_tool_schemas = []
            agent._turn_end_hooks = {}

            with patch.object(agentmain, "agent_runner_loop", fake_runner):
                with self.assertRaises(StopIteration):
                    agent.run()

        self.assertEqual(Path(captured["handler_cwd"]).resolve(), project_root.resolve())

    def test_agent_run_passes_prompt_image_tags_to_runner_initial_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_root = Path(tmp) / "project"
            project_root.mkdir()
            image_path = project_root / "prompt.png"
            image_path.write_bytes(b"image-bytes")
            display = DisplayQueue()
            captured = {}

            def fake_runner(_client, _system_prompt, _user_input, _handler, _tools_schema, **kwargs):
                captured["initial_user_content"] = kwargs.get("initial_user_content")
                yield {"turn": 1}
                yield "done"

            agent = object.__new__(agentmain.SecHeurAgent)
            agent.task_queue = OneTaskQueue({
                "query": f"describe this\n[image:{image_path}]",
                "source": "user",
                "output": display,
                "memory_prefetch": None,
                "images": [],
            })
            agent.memory_reference_enabled = False
            agent.history = []
            agent.llmclient = SimpleNamespace(backend=SimpleNamespace(extra_sys_prompt=""), last_tools="", log_path="")
            agent.log_path = str(project_root / "agent.log")
            agent.peer_hint = False
            agent.force_non_stream = False
            agent.max_turns = 1
            agent.max_cost = None
            agent.verbose = False
            agent.inc_out = False
            agent.stop_sig = False
            agent.is_running = False
            agent.task_dir = None
            agent.project_root = str(project_root)
            agent.custom_skill_dirs = ""
            agent.plan_file_path = None
            agent.handler = None
            agent.activated_tools = set()
            agent.base_tools_schema = []
            agent.mcp_tool_schemas = []
            agent._turn_end_hooks = {}

            with patch.object(agentmain, "agent_runner_loop", fake_runner):
                with self.assertRaises(StopIteration):
                    agent.run()

        content = captured["initial_user_content"]
        self.assertEqual(content[0]["type"], "text")
        self.assertIn("[image:", content[0]["text"])
        self.assertEqual(content[1]["type"], "image")
        self.assertEqual(content[1]["source"]["media_type"], "image/png")
        self.assertEqual(content[1]["source"]["data"], "aW1hZ2UtYnl0ZXM=")

    def test_agent_run_inherits_read_state_from_previous_handler(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_root = Path(tmp) / "project"
            project_root.mkdir()
            display = DisplayQueue()
            captured = {}
            previous_handler = SimpleNamespace(
                working={},
                _read_file_state={str(project_root / "app.py"): (1, 2, "digest")},
                _read_call_state={(str(project_root / "app.py"), 1, 200, None, True): (1, 2, "digest")},
            )

            def fake_runner(_client, _system_prompt, _user_input, handler, _tools_schema, **_kwargs):
                captured["read_file_state"] = handler._read_file_state
                captured["read_call_state"] = handler._read_call_state
                captured["backend_compact_read_file_state"] = getattr(_client.backend, "compact_read_file_state", None)
                captured["backend_compact_read_call_state"] = getattr(_client.backend, "compact_read_call_state", None)
                yield {"turn": 1}
                yield "done"

            agent = object.__new__(agentmain.SecHeurAgent)
            agent.task_queue = OneTaskQueue({
                "query": "continue editing",
                "source": "user",
                "output": display,
                "memory_prefetch": None,
                "images": [],
            })
            agent.memory_reference_enabled = False
            agent.history = []
            agent.llmclient = SimpleNamespace(backend=SimpleNamespace(extra_sys_prompt=""), last_tools="", log_path="")
            agent.log_path = str(project_root / "agent.log")
            agent.peer_hint = False
            agent.force_non_stream = False
            agent.max_turns = 1
            agent.max_cost = None
            agent.verbose = False
            agent.inc_out = False
            agent.stop_sig = False
            agent.is_running = False
            agent.task_dir = None
            agent.project_root = str(project_root)
            agent.custom_skill_dirs = ""
            agent.plan_file_path = None
            agent.handler = previous_handler
            agent.activated_tools = set()
            agent.base_tools_schema = []
            agent.mcp_tool_schemas = []
            agent._turn_end_hooks = {}

            with patch.object(agentmain, "agent_runner_loop", fake_runner):
                with self.assertRaises(StopIteration):
                    agent.run()

        self.assertEqual(captured["read_file_state"], previous_handler._read_file_state)
        self.assertEqual(captured["read_call_state"], previous_handler._read_call_state)
        self.assertEqual(captured["backend_compact_read_file_state"], captured["read_file_state"])
        self.assertEqual(captured["backend_compact_read_call_state"], captured["read_call_state"])
        self.assertIsNot(captured["read_file_state"], previous_handler._read_file_state)
        self.assertIsNot(captured["read_call_state"], previous_handler._read_call_state)


if __name__ == "__main__":
    unittest.main()
