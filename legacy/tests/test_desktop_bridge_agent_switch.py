import unittest
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

try:
    from frontends.desktop_bridge import AgentManager
except ModuleNotFoundError as exc:
    if exc.name != "aiohttp":
        raise
    AgentManager = None


class DummyAgent:
    def __init__(self):
        self.selected = None
        self.max_turns = 80
        self.max_cost = None
        self.llmclient = SimpleNamespace(
            last_tools="cached",
            backend=SimpleNamespace(thinking_type=None, thinking_budget_tokens=None),
        )

    def next_llm(self, llm_no):
        self.selected = llm_no

    def run(self):
        return None


class DesktopBridgeAgentSwitchTests(unittest.TestCase):
    def setUp(self):
        if AgentManager is None:
            self.skipTest("aiohttp is not installed")

    def test_set_session_model_updates_session_and_live_agent(self):
        manager = AgentManager()
        sess = manager.create_session(llm_no=0)
        sess.agent = DummyAgent()

        result = manager.set_session_model(sess.id, 2)

        self.assertTrue(result["ok"])
        self.assertEqual(result["llmNo"], 2)
        self.assertEqual(sess.llm_no, 2)
        self.assertEqual(sess.agent.selected, 2)

    def test_set_session_model_resets_running_session(self):
        manager = AgentManager()
        sess = manager.create_session()
        sess.status = "running"
        sess.partial = {"id": 1, "role": "assistant", "content": "stuck", "partial": True}
        sess.agent = DummyAgent()

        result = manager.set_session_model(sess.id, 1)

        self.assertTrue(result["ok"])
        self.assertEqual(result["llmNo"], 1)
        self.assertTrue(result["runtimeReset"])
        self.assertTrue(result["wasRunning"])
        self.assertEqual(sess.llm_no, 1)
        self.assertEqual(sess.status, "idle")
        self.assertIsNone(sess.partial)
        self.assertIsNone(sess.agent)

    def test_make_agent_sets_selected_project_root_on_agent(self):
        bridge_root = Path(__file__).resolve().parents[1]
        with TemporaryDirectory() as tmp:
            project_root = Path(tmp) / "selected-project"
            project_root.mkdir()
            manager = AgentManager(project_root=bridge_root)
            sess = manager.create_session(cwd=str(project_root))

            with patch("frontends.desktop_bridge.importlib.import_module", return_value=SimpleNamespace(SecHeurAgent=DummyAgent)):
                agent = manager.make_agent(sess)

            self.assertEqual(agent.project_root, str(project_root.resolve()))

    def test_make_agent_does_not_change_process_cwd(self):
        bridge_root = Path(__file__).resolve().parents[1]
        with TemporaryDirectory() as tmp:
            project_root = Path(tmp) / "selected-project"
            project_root.mkdir()
            manager = AgentManager(project_root=bridge_root)
            sess = manager.create_session(cwd=str(project_root))
            bridge_module = sys.modules[AgentManager.__module__]

            with patch("frontends.desktop_bridge.importlib.import_module", return_value=SimpleNamespace(SecHeurAgent=DummyAgent)), \
                 patch.object(bridge_module.os, "chdir") as chdir:
                manager.make_agent(sess)

            chdir.assert_not_called()

    def test_temporary_agent_does_not_change_process_cwd(self):
        bridge_root = Path(__file__).resolve().parents[1]
        with TemporaryDirectory() as tmp:
            project_root = Path(tmp) / "selected-project"
            project_root.mkdir()
            manager = AgentManager(project_root=bridge_root)
            sess = manager.create_session(cwd=str(project_root))
            bridge_module = sys.modules[AgentManager.__module__]

            with patch("frontends.desktop_bridge.importlib.import_module", return_value=SimpleNamespace(SecHeurAgent=DummyAgent)), \
                 patch.object(bridge_module.os, "chdir") as chdir:
                child = manager._make_temporary_agent(sess, "tmp-test")

            self.assertEqual(child.project_root, str(project_root.resolve()))
            chdir.assert_not_called()

    def test_make_agent_applies_saved_runtime_config_to_new_agent(self):
        with TemporaryDirectory() as tmp:
            bridge_root = Path(tmp) / "bridge-root"
            project_root = Path(tmp) / "selected-project"
            custom_dir = Path(tmp) / "extra-skills"
            bridge_root.mkdir()
            project_root.mkdir()
            custom_dir.mkdir()
            manager = AgentManager(project_root=bridge_root)
            manager.save_config({
                "customSkillDirectories": str(custom_dir),
                "maxTurns": 11,
                "maxCost": "2.5",
                "thinkingMode": "enabled",
                "thinkingBudget": "1024",
                "attemptDedupEnabled": True,
            })
            sess = manager.create_session(cwd=str(project_root), memory_reference_enabled=False)

            def apply_thinking_settings(agent, mode, budget=None):
                agent.llmclient.backend.thinking_type = mode
                agent.llmclient.backend.thinking_budget_tokens = budget

            fake_module = SimpleNamespace(SecHeurAgent=DummyAgent, apply_thinking_settings=apply_thinking_settings)
            with patch.object(sys, "path", list(sys.path)), \
                 patch("frontends.desktop_bridge.importlib.import_module", return_value=fake_module):
                agent = manager.make_agent(sess)

            self.assertEqual(agent.custom_skill_dirs, str(custom_dir))
            self.assertFalse(agent.memory_reference_enabled)
            self.assertEqual(agent.max_turns, 11)
            self.assertEqual(agent.max_cost, 2.5)
            self.assertEqual(agent.llmclient.backend.thinking_type, "enabled")
            self.assertEqual(agent.llmclient.backend.thinking_budget_tokens, 1024)
            self.assertEqual(agent.llmclient.last_tools, "")
            self.assertTrue(agent.attempt_dedup_enabled)

    def test_attempt_dedup_defaults_off_and_syncs_to_live_agent(self):
        with TemporaryDirectory() as tmp:
            manager = AgentManager(project_root=tmp)
            sess = manager.create_session()
            sess.agent = DummyAgent()

            manager.sync_agent_runtime_config(sess.agent, sess)
            self.assertFalse(sess.agent.attempt_dedup_enabled)

            manager.save_config({"attemptDedupEnabled": True})
            self.assertTrue(sess.agent.attempt_dedup_enabled)

            manager.save_config({})
            self.assertFalse(sess.agent.attempt_dedup_enabled)


if __name__ == "__main__":
    unittest.main()
