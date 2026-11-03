import json
import os
import tempfile
import unittest
from pathlib import Path

from judge_agent import JudgeVerdict, _parse_verdict


PROJECT_ROOT = Path(__file__).resolve().parent.parent


class JudgeVerdictTests(unittest.TestCase):
    def test_defaults(self):
        v = JudgeVerdict(status="on_track", summary="ok", suggestion="")
        self.assertEqual(v.status, "on_track")
        self.assertEqual(v.summary, "ok")
        self.assertEqual(v.suggestion, "")
        self.assertEqual(v.confidence, 0.0)
        self.assertEqual(v.raw_text, "")
        self.assertEqual(v.knowledge_query, "")

    def test_confidence_clamped_in_dataclass_is_not_enforced(self):
        # dataclass does not validate ranges; parser is responsible
        v = JudgeVerdict(status="stuck", summary="x", suggestion="y", confidence=1.5)
        self.assertEqual(v.confidence, 1.5)


class ParseVerdictTests(unittest.TestCase):
    def test_strict_json(self):
        raw = json.dumps({
            "status": "stuck",
            "summary": "last 3 calls repeated same args",
            "suggestion": "switch to a different tool",
            "confidence": 0.9,
            "knowledge_query": "glibc tcache double free safe linking",
        })
        v = _parse_verdict(raw)
        self.assertEqual(v.status, "stuck")
        self.assertEqual(v.suggestion, "switch to a different tool")
        self.assertEqual(v.confidence, 0.9)
        self.assertEqual(v.raw_text, raw)
        self.assertEqual(v.knowledge_query, "glibc tcache double free safe linking")

    def test_json_embedded_in_prose(self):
        raw = (
            "Here is my assessment:\n"
            "```json\n"
            '{"status": "off_track", "summary": "wrong dir", "suggestion": "re-read task", "confidence": 0.8, "knowledge_query": "tcache dup safe linking"}\n'
            "```\n"
            "Done."
        )
        v = _parse_verdict(raw)
        self.assertEqual(v.status, "off_track")
        self.assertEqual(v.suggestion, "re-read task")
        self.assertEqual(v.knowledge_query, "tcache dup safe linking")

    def test_garbage_falls_back_to_on_track(self):
        v = _parse_verdict("not json at all, just prose")
        self.assertEqual(v.status, "on_track")
        self.assertEqual(v.suggestion, "")
        self.assertEqual(v.confidence, 0.0)
        self.assertIn("judge parse failed", v.summary)

    def test_missing_fields_default_safely(self):
        raw = json.dumps({"status": "flag_found"})
        v = _parse_verdict(raw)
        self.assertEqual(v.status, "flag_found")
        self.assertEqual(v.summary, "")
        self.assertEqual(v.suggestion, "")
        self.assertEqual(v.knowledge_query, "")

    def test_unknown_status_treated_as_on_track(self):
        raw = json.dumps({"status": "wat"})
        v = _parse_verdict(raw)
        self.assertEqual(v.status, "on_track")


class ShouldInterveneTests(unittest.TestCase):
    def test_only_on_track_returns_false(self):
        from judge_agent import should_intervene
        self.assertFalse(should_intervene(JudgeVerdict(status="on_track", summary="", suggestion="")))
        for s in ("course_correct", "stuck", "flag_found", "off_track"):
            self.assertTrue(should_intervene(JudgeVerdict(status=s, summary="", suggestion="")))


class FormatReminderTests(unittest.TestCase):
    def test_on_track_returns_empty_string(self):
        from judge_agent import format_judge_reminder
        v = JudgeVerdict(status="on_track", summary="fine", suggestion="ignored")
        self.assertEqual(format_judge_reminder(v), "")

    def test_off_track_includes_suggestion(self):
        from judge_agent import format_judge_reminder
        v = JudgeVerdict(status="off_track", summary="wrong path", suggestion="re-read task", confidence=0.9)
        text = format_judge_reminder(v)
        self.assertIn("<system-reminder>", text)
        self.assertIn("status=off_track", text)
        self.assertIn("confidence=0.9", text)
        self.assertIn("re-read task", text)
        self.assertIn("wrong path", text)

    def test_flag_found_omits_suggestion_block(self):
        from judge_agent import format_judge_reminder
        v = JudgeVerdict(status="flag_found", summary="flag captured", suggestion="")
        text = format_judge_reminder(v)
        self.assertIn("status=flag_found", text)
        self.assertNotIn("suggestion:", text)


class BuildSystemPromptTests(unittest.TestCase):
    def test_default_when_no_override(self):
        from judge_agent import _build_judge_system_prompt
        with tempfile.TemporaryDirectory() as tmp:
            text = _build_judge_system_prompt(Path(tmp))
            self.assertIn("progress judge", text)
            self.assertIn("Respond with a single JSON object", text)

    def test_override_takes_precedence(self):
        from judge_agent import _build_judge_system_prompt
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            override_dir = tmp_path / ".secheur-agent"
            override_dir.mkdir()
            (override_dir / "judge_prompt.md").write_text("OVERRIDE_PROMPT_MARKER\n", encoding="utf-8")
            text = _build_judge_system_prompt(tmp_path)
            self.assertIn("OVERRIDE_PROMPT_MARKER", text)

    def test_default_prompt_documents_knowledge_query(self):
        from judge_agent import _build_judge_system_prompt
        with tempfile.TemporaryDirectory() as tmp:
            text = _build_judge_system_prompt(Path(tmp))
        self.assertIn("knowledge_query", text)
        self.assertIn("off_track or stuck", text)


class LoadConfigTests(unittest.TestCase):
    def test_defaults_when_no_file(self):
        from judge_agent import load_judge_config
        cfg = load_judge_config(handler=None)
        self.assertEqual(cfg["enabled"], True)
        self.assertEqual(cfg["every_n_turns"], 5)
        self.assertIsNone(cfg["model_profile"])
        self.assertEqual(cfg["max_history_messages"], 8)


class LoadConfigBoundsTests(unittest.TestCase):
    def _write_cfg(self, tmp, block):
        cfg_path = Path(tmp) / ".secheur-agent" / "desktop-config.json"
        cfg_path.parent.mkdir(parents=True, exist_ok=True)
        cfg_path.write_text(json.dumps({"judge": block}), encoding="utf-8")
        return cfg_path

    def _handler(self, project_root):
        return type("Handler", (), {"parent": type("Parent", (), {"project_root": project_root})()})()

    def test_every_n_turns_clamped_to_bounds(self):
        from judge_agent import load_judge_config
        with tempfile.TemporaryDirectory() as tmp:
            self._write_cfg(tmp, {"every_n_turns": 0})
            cfg = load_judge_config(handler=self._handler(tmp))
            self.assertEqual(cfg["every_n_turns"], 1)
            self._write_cfg(tmp, {"every_n_turns": 1000})
            cfg = load_judge_config(handler=self._handler(tmp))
            self.assertEqual(cfg["every_n_turns"], 50)

    def test_max_history_clamped_to_bounds(self):
        from judge_agent import load_judge_config
        with tempfile.TemporaryDirectory() as tmp:
            self._write_cfg(tmp, {"max_history_messages": 0})
            cfg = load_judge_config(handler=self._handler(tmp))
            self.assertEqual(cfg["max_history_messages"], 2)
            self._write_cfg(tmp, {"max_history_messages": 1000})
            cfg = load_judge_config(handler=self._handler(tmp))
            self.assertEqual(cfg["max_history_messages"], 20)


class _StubBackend:
    def __init__(self):
        self.model = "main-model"


class _StubChatClient:
    def __init__(self, content="{}"):
        self.backend = _StubBackend()
        self.chat_calls = []
        self._content = content

    def chat(self, messages, tools):
        self.chat_calls.append(list(messages))
        response = type("Resp", (), {"content": self._content})()
        yield ""
        return response


class _StubHandler:
    def __init__(self, project_root=None, single_task=False):
        self.parent = type("Parent", (), {"project_root": project_root, "single_task": single_task})()


class EvaluateGatingTests(unittest.TestCase):
    def _write_cfg(self, tmp, block):
        cfg_path = Path(tmp) / ".secheur-agent" / "desktop-config.json"
        cfg_path.parent.mkdir(parents=True, exist_ok=True)
        cfg_path.write_text(json.dumps({"judge": block}), encoding="utf-8")

    def test_every_n_turns_gates_call(self):
        from judge_agent import evaluate_progress
        with tempfile.TemporaryDirectory() as tmp:
            self._write_cfg(tmp, {"every_n_turns": 5})
            handler = _StubHandler(project_root=tmp)
            client = _StubChatClient()
            messages = [{"role": "system", "content": "sys"}, {"role": "user", "content": "task"}]
            v = evaluate_progress(client=client, messages=messages, handler=handler, project_root=tmp, turn=5)
            self.assertIsNotNone(v)
            self.assertEqual(len(client.chat_calls), 1)
            client2 = _StubChatClient()
            v2 = evaluate_progress(client=client2, messages=messages, handler=handler, project_root=tmp, turn=4)
            self.assertIsNone(v2)
            self.assertEqual(len(client2.chat_calls), 0)

    def test_disabled_returns_none_without_calling_chat(self):
        from judge_agent import evaluate_progress
        with tempfile.TemporaryDirectory() as tmp:
            self._write_cfg(tmp, {"enabled": False})
            handler = _StubHandler(project_root=tmp)
            client = _StubChatClient()
            messages = [{"role": "system", "content": "sys"}, {"role": "user", "content": "task"}]
            v = evaluate_progress(client=client, messages=messages, handler=handler, project_root=tmp, turn=1)
            self.assertIsNone(v)
            self.assertEqual(len(client.chat_calls), 0)

    def test_sub_agent_skips_without_calling_chat(self):
        from judge_agent import evaluate_progress
        handler = _StubHandler(project_root=None, single_task=True)
        client = _StubChatClient()
        messages = [{"role": "system", "content": "sys"}, {"role": "user", "content": "task"}]
        v = evaluate_progress(client=client, messages=messages, handler=handler, turn=1)
        self.assertIsNone(v)
        self.assertEqual(len(client.chat_calls), 0)


class BuildJudgeInputTests(unittest.TestCase):
    def test_splits_summary_and_recent(self):
        from judge_agent import _build_judge_input
        messages = [{"role": "system", "content": "sys"}] + [
            {"role": "user", "content": f"old {i}"} for i in range(20)
        ] + [
            {"role": "assistant", "content": f"recent {i}"} for i in range(3)
        ]
        summary, recent = _build_judge_input(messages, k=3)
        self.assertIsInstance(summary, str)
        self.assertEqual(len(recent), 3)
        self.assertTrue(all("recent" in m["content"] for m in recent))
        # Summary must contain at least one older message
        self.assertIn("old", summary)


if __name__ == "__main__":
    unittest.main()
