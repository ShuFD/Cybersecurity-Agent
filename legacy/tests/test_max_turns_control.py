import queue
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

if "requests" not in sys.modules:
    sys.modules["requests"] = types.SimpleNamespace()
if "urllib3" not in sys.modules:
    sys.modules["urllib3"] = types.SimpleNamespace(
        disable_warnings=lambda *a, **k: None,
        exceptions=types.SimpleNamespace(InsecureRequestWarning=Warning),
    )

from agentmain import SecHeurAgent, apply_thinking_settings, load_project_permission_mode, resolve_plan_path


class DummyBackend:
    def __init__(self):
        self.thinking_type = None
        self.thinking_budget_tokens = None
        self.context_win = 200000
        self.history = []

    def compact_history_summary(self, _messages):
        return [{"type": "text", "text": "manual compact summary"}]


class DummyClient:
    def __init__(self):
        self.backend = DummyBackend()


class MaxTurnsControlTests(unittest.TestCase):
    def _agent(self):
        agent = SecHeurAgent.__new__(SecHeurAgent)
        agent.max_turns = 80
        agent.max_cost = None
        agent.permission_mode = "default"
        agent.project_root = None
        agent.plan_file_path = None
        agent.handler = None
        agent.llmclient = DummyClient()
        return agent

    def test_load_project_permission_mode_reads_desktop_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_dir = root / ".secheur-agent"
            config_dir.mkdir()
            (config_dir / "desktop-config.json").write_text('{"permissionMode": "bypassPermissions"}', encoding="utf-8")

            with mock.patch.dict("os.environ", {}, clear=True):
                mode = load_project_permission_mode(root)

        self.assertEqual(mode, "bypassPermissions")

    def test_load_project_permission_mode_prefers_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_dir = root / ".secheur-agent"
            config_dir.mkdir()
            (config_dir / "desktop-config.json").write_text('{"permissionMode": "bypassPermissions"}', encoding="utf-8")

            with mock.patch.dict("os.environ", {"SECHEUR_PERMISSION_MODE": "dontAsk"}, clear=True):
                mode = load_project_permission_mode(root)

        self.assertEqual(mode, "dontAsk")

    def test_max_turns_slash_command_updates_agent_limit(self):
        agent = self._agent()
        display = queue.Queue()

        result = agent._handle_slash_cmd("/max-turns 12", display)

        self.assertIsNone(result)
        self.assertEqual(agent.max_turns, 12)
        self.assertIn("max_turns = 12", display.get_nowait()["done"])

    def test_max_turns_slash_command_rejects_invalid_value(self):
        agent = self._agent()
        display = queue.Queue()

        result = agent._handle_slash_cmd("/max-turns nope", display)

        self.assertIsNone(result)
        self.assertEqual(agent.max_turns, 80)
        self.assertIn("用法", display.get_nowait()["done"])

    def test_max_turns_slash_command_clamps_to_reasonable_range(self):
        agent = self._agent()
        display = queue.Queue()

        result = agent._handle_slash_cmd("/max-turns 9999", display)

        self.assertIsNone(result)
        self.assertEqual(agent.max_turns, 200)

    def test_max_cost_slash_command_updates_agent_limit(self):
        agent = self._agent()
        display = queue.Queue()

        result = agent._handle_slash_cmd("/max-cost 1.25", display)

        self.assertIsNone(result)
        self.assertEqual(agent.max_cost, 1.25)
        self.assertIn("max_cost = $1.2500", display.get_nowait()["done"])

    def test_max_cost_slash_command_rejects_invalid_value(self):
        agent = self._agent()
        display = queue.Queue()

        result = agent._handle_slash_cmd("/max-cost nope", display)

        self.assertIsNone(result)
        self.assertIsNone(agent.max_cost)
        self.assertIn("用法", display.get_nowait()["done"])

    def test_usage_slash_command_reports_current_usage_and_estimated_cost(self):
        agent = self._agent()
        display = queue.Queue()

        with mock.patch(
            "agentmain.get_usage_stats",
            return_value={
                "requests": 2,
                "input_tokens": 1000,
                "output_tokens": 200,
                "cache_creation_tokens": 30,
                "cache_read_tokens": 400,
            },
        ):
            with mock.patch("agentmain.estimate_usage_cost", return_value=0.123456):
                result = agent._handle_slash_cmd("/usage", display)

        self.assertIsNone(result)
        message = display.get_nowait()["done"]
        self.assertIn("requests: 2", message)
        self.assertIn("input_tokens: 1000", message)
        self.assertIn("estimated_cost: $0.123456", message)

    def test_permission_mode_slash_command_updates_agent_mode(self):
        agent = self._agent()
        display = queue.Queue()

        result = agent._handle_slash_cmd("/permission-mode dontAsk", display)

        self.assertIsNone(result)
        self.assertEqual(agent.permission_mode, "dontAsk")
        self.assertIn("permission_mode = dontAsk", display.get_nowait()["done"])

    def test_permission_mode_slash_command_accepts_plan_mode(self):
        agent = self._agent()
        display = queue.Queue()

        result = agent._handle_slash_cmd("/permission-mode plan", display)

        self.assertIsNone(result)
        self.assertEqual(agent.permission_mode, "plan")
        self.assertIn("permission_mode = plan", display.get_nowait()["done"])

    def test_permission_mode_slash_command_rejects_invalid_mode(self):
        agent = self._agent()
        display = queue.Queue()

        result = agent._handle_slash_cmd("/permission-mode unsafe", display)

        self.assertIsNone(result)
        self.assertEqual(agent.permission_mode, "default")
        self.assertIn("可选", display.get_nowait()["done"])

    def test_apply_thinking_settings_updates_backend(self):
        agent = self._agent()

        apply_thinking_settings(agent, "enabled", 2048)

        self.assertEqual(agent.llmclient.backend.thinking_type, "enabled")
        self.assertEqual(agent.llmclient.backend.thinking_budget_tokens, 2048)

    def test_apply_thinking_settings_uses_default_budget_for_enabled(self):
        agent = self._agent()

        apply_thinking_settings(agent, "enabled")

        self.assertEqual(agent.llmclient.backend.thinking_type, "enabled")
        self.assertEqual(agent.llmclient.backend.thinking_budget_tokens, 4096)

    def test_thinking_slash_command_updates_backend(self):
        agent = self._agent()
        display = queue.Queue()

        result = agent._handle_slash_cmd("/thinking adaptive", display)

        self.assertIsNone(result)
        self.assertEqual(agent.llmclient.backend.thinking_type, "adaptive")
        self.assertIsNone(agent.llmclient.backend.thinking_budget_tokens)
        self.assertIn("thinking = adaptive", display.get_nowait()["done"])

    def test_thinking_slash_command_accepts_enabled_budget(self):
        agent = self._agent()
        display = queue.Queue()

        result = agent._handle_slash_cmd("/thinking enabled 4096", display)

        self.assertIsNone(result)
        self.assertEqual(agent.llmclient.backend.thinking_type, "enabled")
        self.assertEqual(agent.llmclient.backend.thinking_budget_tokens, 4096)

    def test_thinking_slash_command_rejects_invalid_mode(self):
        agent = self._agent()
        display = queue.Queue()

        result = agent._handle_slash_cmd("/thinking always", display)

        self.assertIsNone(result)
        self.assertIsNone(agent.llmclient.backend.thinking_type)
        self.assertIn("可选", display.get_nowait()["done"])

    def test_plan_slash_command_creates_plan_file_and_enables_plan_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent = self._agent()
            agent.project_root = tmp
            display = queue.Queue()

            result = agent._handle_slash_cmd("/plan docs/plan.md", display)

            plan_path = Path(tmp) / "docs" / "plan.md"
            self.assertIsNone(result)
            self.assertEqual(agent.permission_mode, "plan")
            self.assertEqual(agent.plan_file_path, str(plan_path))
            self.assertTrue(plan_path.exists())
            self.assertIn("Plan Mode", display.get_nowait()["done"])

    def test_plan_slash_command_clears_previous_approved_prompts_without_handler(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent = self._agent()
            agent.project_root = tmp
            agent.approved_plan_allowed_prompts = [{"tool": "Bash", "prompt": "run tests"}]
            display = queue.Queue()

            result = agent._handle_slash_cmd("/plan docs/plan.md", display)

            self.assertIsNone(result)
            self.assertEqual(agent.approved_plan_allowed_prompts, [])

    def test_exit_plan_slash_command_clears_slash_plan_mode(self):
        agent = self._agent()
        display = queue.Queue()

        agent.permission_mode = "bypassPermissions"
        agent._handle_slash_cmd("/plan /tmp/plan.md", display)
        display.get_nowait()
        result = agent._handle_slash_cmd("/exit-plan", display)

        self.assertIsNone(result)
        self.assertIsNone(agent.plan_file_path)
        self.assertEqual(agent.permission_mode, "bypassPermissions")
        self.assertIn("退出 Plan Mode", display.get_nowait()["done"])

    def test_exit_plan_slash_command_clears_approved_plan_prompts(self):
        agent = self._agent()
        display = queue.Queue()
        agent.plan_file_path = "/tmp/plan.md"
        agent.permission_mode = "plan"
        agent._slash_plan_mode_active = True
        agent._slash_plan_previous_permission_mode = "default"
        agent.approved_plan_allowed_prompts = [{"tool": "Bash", "prompt": "run tests"}]

        result = agent._handle_slash_cmd("/exit-plan", display)

        self.assertIsNone(result)
        self.assertEqual(agent.approved_plan_allowed_prompts, [])

    def test_plan_auto_exit_slash_command_toggles_auto_mode(self):
        agent = self._agent()
        display = queue.Queue()

        result = agent._handle_slash_cmd("/plan-auto-exit on", display)
        enabled_message = display.get_nowait()["done"]
        result2 = agent._handle_slash_cmd("/plan-auto-exit off", display)
        disabled_message = display.get_nowait()["done"]

        self.assertIsNone(result)
        self.assertIsNone(result2)
        self.assertFalse(agent.auto_exit_plan_mode)
        self.assertIn("开启", enabled_message)
        self.assertIn("关闭", disabled_message)

    def test_resolve_plan_path_defaults_under_project_temp(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = resolve_plan_path(project_root=tmp)

        self.assertEqual(path, str(Path(tmp) / "temp" / "plan.md"))

    def test_resume_slash_command_restores_latest_session(self):
        agent = self._agent()
        display = queue.Queue()
        restored_history = [{"role": "user", "content": [{"type": "text", "text": "old task"}]}]
        agent.llmclient.backend._usage_tokens = 1200
        agent.llmclient.backend._usage_history_len = 8

        with mock.patch(
            "agentmain.restore_latest_history",
            return_value=types.SimpleNamespace(path=Path("/tmp/model_responses_1.txt"), history=restored_history),
        ):
            result = agent._handle_slash_cmd("/resume", display)

        self.assertIsNone(result)
        self.assertEqual(agent.llmclient.backend.history, restored_history)
        self.assertFalse(hasattr(agent.llmclient.backend, "_usage_tokens"))
        self.assertFalse(hasattr(agent.llmclient.backend, "_usage_history_len"))
        self.assertIn("restored 1 messages", display.get_nowait()["done"])

    def test_resume_slash_command_clears_in_memory_read_state(self):
        agent = self._agent()
        display = queue.Queue()
        restored_history = [{"role": "user", "content": [{"type": "text", "text": "old task"}]}]
        agent.handler = types.SimpleNamespace(
            _read_file_state={"/tmp/current.py": ("sig",)},
            _read_call_state={("/tmp/current.py", 1, 200, None, True): ("sig",)},
        )
        agent.llmclient.backend.compact_read_file_state = agent.handler._read_file_state
        agent.llmclient.backend.compact_read_call_state = agent.handler._read_call_state

        with mock.patch(
            "agentmain.restore_latest_history",
            return_value=types.SimpleNamespace(path=Path("/tmp/model_responses_1.txt"), history=restored_history),
        ):
            result = agent._handle_slash_cmd("/resume", display)

        self.assertIsNone(result)
        self.assertEqual(agent.handler._read_file_state, {})
        self.assertEqual(agent.handler._read_call_state, {})
        self.assertEqual(agent.llmclient.backend.compact_read_file_state, {})
        self.assertEqual(agent.llmclient.backend.compact_read_call_state, {})

    def test_resume_slash_command_restores_specific_log(self):
        agent = self._agent()
        display = queue.Queue()
        restored_history = [{"role": "user", "content": [{"type": "text", "text": "specific"}]}]

        with mock.patch("agentmain.restore_history_from_log", return_value=restored_history) as restore:
            result = agent._handle_slash_cmd("/resume /tmp/model_responses_2.txt", display)

        self.assertIsNone(result)
        restore.assert_called_once_with("/tmp/model_responses_2.txt")
        self.assertEqual(agent.llmclient.backend.history, restored_history)
        self.assertIn("model_responses_2.txt", display.get_nowait()["done"])

    def test_resume_list_slash_command_outputs_structured_list(self):
        agent = self._agent()
        display = queue.Queue()

        with mock.patch("agentmain.format_resume_list", return_value="[Resume] 最近可恢复会话：\n1. /tmp/log.jsonl") as formatter:
            result = agent._handle_slash_cmd("/resume-list", display)

        self.assertIsNone(result)
        formatter.assert_called_once_with()
        self.assertIn("最近可恢复会话", display.get_nowait()["done"])

    def test_compact_slash_command_compacts_backend_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent = self._agent()
            display = queue.Queue()
            agent.log_path = str(Path(tmp) / "model_responses_compact_test.txt")
            agent.llmclient.backend.history = [
                {"role": "user", "content": [{"type": "text", "text": f"message-{idx}"}]}
                for idx in range(10)
            ]

            result = agent._handle_slash_cmd("/compact", display)

        self.assertIsNone(result)
        self.assertTrue(agent.llmclient.backend.history[0]["is_compact_boundary"])
        self.assertEqual(agent.llmclient.backend.history[1]["content"][0]["text"], "manual compact summary")
        self.assertTrue(agent.llmclient.backend.history[1]["is_compact_summary"])
        self.assertLess(len(agent.llmclient.backend.history), 10)
        self.assertIn("compacted", display.get_nowait()["done"])


if __name__ == "__main__":
    unittest.main()
