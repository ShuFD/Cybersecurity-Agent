import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import agent_loop
from agent_loop import BaseHandler, StepOutcome, agent_runner_loop, tool_meta


class StubHandler(BaseHandler):
    def __init__(self, single_task=False):
        self.parent = type("Parent", (), {"task_dir": None, "single_task": single_task})()
        self._done_hooks = []
        self.max_turns = 1

    @tool_meta()
    def do_no_tool(self, args, response):
        return StepOutcome(None, next_prompt="\n")


class StubResponse:
    def __init__(self, content=""):
        self.content = content
        self.thinking = ""
        self.tool_calls = []


class StubClient:
    last_tools = ""

    def __init__(self, response):
        self.response = response
        self.chat_calls = []

    def chat(self, messages, tools):
        self.chat_calls.append(list(messages))
        if False:
            yield ""
        return self.response


class JudgeIntegrationTests(unittest.TestCase):
    def setUp(self):
        agent_loop._judge_test_evaluate = None

    def _exhaust(self, gen):
        out = []
        try:
            while True:
                out.append(next(gen))
        except StopIteration as exc:
            return out, exc.value
        return out, None

    def test_judge_invoked_every_n_turns(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = Path(tmp) / ".secheur-agent" / "desktop-config.json"
            cfg_path.parent.mkdir(parents=True)
            cfg_path.write_text(json.dumps({"judge": {"every_n_turns": 3}}), encoding="utf-8")
            chat_calls = []
            client = StubClient(StubResponse(content="noop"))

            def stub_chat(messages, tools):
                chat_calls.append(list(messages))
                if False:
                    yield ""
                return client.response
            client.chat = stub_chat
            handler = StubHandler()
            handler.parent = type("Parent", (), {
                "task_dir": None,
                "single_task": False,
                "project_root": tmp,
            })()
            max_turns = 12
            list(agent_loop.agent_runner_loop(
                client, "sys", "user", handler, lambda: [],
                max_turns=max_turns, max_cost=None, cost_provider=lambda: None,
                verbose=False, initial_user_content=None, yield_info=False,
            ))
        # Count only judge chat calls (those containing the judge prompt marker).
        judge_calls = [
            msgs for msgs in chat_calls
            if any("## Original task" in (m.get("content") or "") for m in msgs)
        ]
        expected = (max_turns + 3 - 1) // 3  # ceil(max_turns / 3)
        self.assertEqual(len(judge_calls), expected)

    def test_judge_reminder_appended_to_messages(self):
        verdict = agent_loop.JudgeVerdict(
            status="off_track", summary="wrong path", suggestion="re-read task", confidence=0.9,
        )

        def fake_evaluate(client, messages, handler, project_root=None, turn=None):
            return verdict

        client = StubClient(StubResponse(content="noop"))
        handler = StubHandler()
        with mock.patch.object(agent_loop, "evaluate_progress", side_effect=fake_evaluate):
            self._exhaust(agent_loop.agent_runner_loop(
                client, "sys", "user", handler, lambda: [],
                max_turns=5, max_cost=None, cost_provider=lambda: None,
                verbose=False, initial_user_content=None, yield_info=False,
            ))
        last_user = next(
            (m for m in reversed(client.chat_calls[-1]) if m.get("role") == "user"),
            None,
        )
        self.assertIsNotNone(last_user)
        self.assertIn("status=off_track", last_user["content"])
        self.assertIn("re-read task", last_user["content"])

    def test_judge_failure_does_not_crash(self):
        def fake_evaluate(client, messages, handler, project_root=None, turn=None):
            raise RuntimeError("boom")

        client = StubClient(StubResponse(content="ok"))
        handler = StubHandler()
        with mock.patch.object(agent_loop, "evaluate_progress", side_effect=fake_evaluate):
            out, _ = self._exhaust(agent_loop.agent_runner_loop(
                client, "sys", "user", handler, lambda: [],
                max_turns=5, max_cost=None, cost_provider=lambda: None,
                verbose=False, initial_user_content=None, yield_info=False,
            ))
        self.assertTrue(any("boom" in str(chunk) or isinstance(chunk, str) for chunk in out))

    def test_judge_disabled_no_calls(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = Path(tmp) / ".secheur-agent" / "desktop-config.json"
            cfg_path.parent.mkdir(parents=True)
            cfg_path.write_text(json.dumps({"judge": {"enabled": False}}), encoding="utf-8")

            def fake_evaluate(client, messages, handler, project_root=None, turn=None):
                raise AssertionError("should not be called when disabled")

            client = StubClient(StubResponse(content="ok"))
            handler = StubHandler()
            handler.parent = type("Parent", (), {
                "task_dir": None,
                "single_task": False,
                "project_root": tmp,
            })()
            with mock.patch.object(agent_loop, "evaluate_progress", side_effect=fake_evaluate):
                self._exhaust(agent_loop.agent_runner_loop(
                    client, "sys", "user", handler, lambda: [],
                    max_turns=6, max_cost=None, cost_provider=lambda: None,
                    verbose=False, initial_user_content=None, yield_info=False,
                ))

    def test_judge_skipped_in_sub_agent(self):
        def fake_evaluate(client, messages, handler, project_root=None, turn=None):
            raise AssertionError("should not be called in sub-agent")

        client = StubClient(StubResponse(content="ok"))
        handler = StubHandler(single_task=True)
        with mock.patch.object(agent_loop, "evaluate_progress", side_effect=fake_evaluate):
            self._exhaust(agent_loop.agent_runner_loop(
                client, "sys", "user", handler, lambda: [],
                max_turns=6, max_cost=None, cost_provider=lambda: None,
                verbose=False, initial_user_content=None, yield_info=False,
            ))

    def test_off_track_with_knowledge_query_forces_recall(self):
        verdict = agent_loop.JudgeVerdict(
            status="off_track",
            summary="wrong path",
            suggestion="re-read task",
            confidence=0.9,
            knowledge_query="glibc tcache double free safe linking",
        )

        def fake_evaluate(client, messages, handler, project_root=None, turn=None):
            return verdict

        client = StubClient(StubResponse(content="noop"))
        handler = StubHandler()
        with mock.patch.object(
            agent_loop, "evaluate_progress", side_effect=fake_evaluate
        ):
            with mock.patch.object(
                agent_loop, "_build_forced_knowledge_recall", return_value="RECALL_BODY"
            ) as recall:
                self._exhaust(agent_loop.agent_runner_loop(
                    client, "sys", "user", handler, lambda: [],
                    max_turns=5, max_cost=None, cost_provider=lambda: None,
                    verbose=False, initial_user_content=None, yield_info=False,
                ))
        recall.assert_called_once_with(
            "glibc tcache double free safe linking", memory_dir=None
        )
        user_contents = [
            str(m.get("content") or "")
            for call in client.chat_calls
            for m in call
            if m.get("role") == "user"
        ]
        self.assertTrue(any("RECALL_BODY" in text for text in user_contents))

    def test_off_track_without_knowledge_query_skips_recall(self):
        verdict = agent_loop.JudgeVerdict(
            status="off_track",
            summary="wrong path",
            suggestion="re-read task",
            confidence=0.9,
        )

        def fake_evaluate(client, messages, handler, project_root=None, turn=None):
            return verdict

        client = StubClient(StubResponse(content="noop"))
        handler = StubHandler()
        with mock.patch.object(
            agent_loop, "evaluate_progress", side_effect=fake_evaluate
        ):
            with mock.patch.object(
                agent_loop, "_build_forced_knowledge_recall", side_effect=AssertionError("should not run")
            ) as recall:
                self._exhaust(agent_loop.agent_runner_loop(
                    client, "sys", "user", handler, lambda: [],
                    max_turns=5, max_cost=None, cost_provider=lambda: None,
                    verbose=False, initial_user_content=None, yield_info=False,
                ))
        recall.assert_not_called()

    def test_knowledge_recall_skipped_when_memory_reference_disabled(self):
        verdict = agent_loop.JudgeVerdict(
            status="stuck",
            summary="no progress",
            suggestion="pivot",
            confidence=0.8,
            knowledge_query="heap exploit",
        )

        def fake_evaluate(client, messages, handler, project_root=None, turn=None):
            return verdict

        client = StubClient(StubResponse(content="noop"))
        handler = StubHandler()
        handler.parent = type("Parent", (), {
            "task_dir": None,
            "single_task": False,
            "project_root": None,
            "memory_reference_enabled": False,
        })()
        with mock.patch.object(
            agent_loop, "evaluate_progress", side_effect=fake_evaluate
        ):
            with mock.patch.object(
                agent_loop, "_build_forced_knowledge_recall", side_effect=AssertionError("should not run")
            ) as recall:
                self._exhaust(agent_loop.agent_runner_loop(
                    client, "sys", "user", handler, lambda: [],
                    max_turns=5, max_cost=None, cost_provider=lambda: None,
                    verbose=False, initial_user_content=None, yield_info=False,
                ))
        recall.assert_not_called()

    def test_same_knowledge_query_recalled_once_per_task(self):
        verdict = agent_loop.JudgeVerdict(
            status="off_track",
            summary="wrong path",
            suggestion="re-read task",
            confidence=0.9,
            knowledge_query="tcache dup",
        )

        def fake_evaluate(client, messages, handler, project_root=None, turn=None):
            return verdict

        client = StubClient(StubResponse(content="noop"))
        handler = StubHandler()
        with mock.patch.object(
            agent_loop, "evaluate_progress", side_effect=fake_evaluate
        ):
            with mock.patch.object(
                agent_loop, "_build_forced_knowledge_recall", return_value="RECALL_BODY"
            ) as recall:
                self._exhaust(agent_loop.agent_runner_loop(
                    client, "sys", "user", handler, lambda: [],
                    max_turns=5, max_cost=None, cost_provider=lambda: None,
                    verbose=False, initial_user_content=None, yield_info=False,
                ))
        self.assertEqual(recall.call_count, 1)

    def test_knowledge_recall_failure_does_not_crash(self):
        verdict = agent_loop.JudgeVerdict(
            status="off_track",
            summary="wrong path",
            suggestion="re-read task",
            confidence=0.9,
            knowledge_query="missing topic",
        )

        def fake_evaluate(client, messages, handler, project_root=None, turn=None):
            return verdict

        client = StubClient(StubResponse(content="noop"))
        handler = StubHandler()
        with mock.patch.object(
            agent_loop, "evaluate_progress", side_effect=fake_evaluate
        ):
            with mock.patch.object(
                agent_loop, "_build_forced_knowledge_recall", side_effect=RuntimeError("boom")
            ):
                out, _ = self._exhaust(agent_loop.agent_runner_loop(
                    client, "sys", "user", handler, lambda: [],
                    max_turns=5, max_cost=None, cost_provider=lambda: None,
                    verbose=False, initial_user_content=None, yield_info=False,
                ))
        user_contents = [
            str(m.get("content") or "")
            for call in client.chat_calls
            for m in call
            if m.get("role") == "user"
        ]
        self.assertTrue(any("Knowledge search failed" in text for text in user_contents))


class ForcedKnowledgeRecallTests(unittest.TestCase):
    def test_build_forced_knowledge_recall_includes_matches(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "heap_sop.md").write_text(
                "# Heap\nUse tcache safe linking when targeting glibc heap.\n",
                encoding="utf-8",
            )
            text = agent_loop._build_forced_knowledge_recall(
                "tcache safe linking", memory_dir=root
            )
        self.assertIn("[Forced Knowledge Recall]", text)
        self.assertIn("heap_sop.md", text)
        self.assertIn("file_read", text)

    def test_build_forced_knowledge_recall_reports_no_match(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "other.md").write_text("Spreadsheet notes.\n", encoding="utf-8")
            text = agent_loop._build_forced_knowledge_recall(
                "missing heap topic", memory_dir=root
            )
        self.assertIn("[Forced Knowledge Recall]", text)
        self.assertIn("No local knowledge matched", text)

    def test_build_forced_knowledge_recall_respects_max_chars(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "long.md").write_text(
                "tcache " + ("x" * 2000), encoding="utf-8"
            )
            text = agent_loop._build_forced_knowledge_recall(
                "tcache", memory_dir=root, max_chars=300
            )
        self.assertLessEqual(len(text), 300)
        self.assertIn("[truncated]", text)
