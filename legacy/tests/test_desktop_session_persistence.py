import unittest
from tempfile import TemporaryDirectory
from pathlib import Path

try:
    from frontends.desktop_bridge import AgentManager, desktop_sessions_path
except ModuleNotFoundError as exc:
    if exc.name != "aiohttp":
        raise
    AgentManager = None
    desktop_sessions_path = None


class DesktopSessionPersistenceTests(unittest.TestCase):
    def setUp(self):
        if AgentManager is None:
            self.skipTest("aiohttp is not installed")

    def test_sessions_restore_after_manager_restart(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            manager = AgentManager(project_root=root)
            sess = manager.create_session(title="Persist me", cwd=str(root), llm_no=2)
            manager.add_message(sess, "user", "查看 bilibili 热搜")
            manager.add_message(sess, "assistant", "可以，我来查询。")

            restored = AgentManager(project_root=root)

            self.assertTrue(desktop_sessions_path(root).is_file())
            self.assertEqual(restored.active_session_id, sess.id)
            self.assertIn(sess.id, restored.sessions)
            restored_sess = restored.sessions[sess.id]
            self.assertEqual(restored_sess.title, "Persist me")
            self.assertEqual(restored_sess.cwd, str(root))
            self.assertEqual(restored_sess.llm_no, 2)
            self.assertEqual(restored_sess.messages[0]["content"], "查看 bilibili 热搜")
            self.assertEqual(restored_sess.messages[1]["role"], "assistant")

    def test_running_session_restores_as_idle_without_live_runtime(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            manager = AgentManager(project_root=root)
            sess = manager.create_session(title="Running", cwd=str(root))
            sess.status = "running"
            sess.partial = {"id": 1, "role": "assistant", "content": "working", "partial": True}
            sess.cancel_requested = True
            manager.add_message(sess, "user", "排队输入", queued_status="queued")
            manager.save_sessions()

            restored = AgentManager(project_root=root)
            restored_sess = restored.sessions[sess.id]

            self.assertEqual(restored_sess.status, "idle")
            self.assertIsNone(restored_sess.partial)
            self.assertFalse(restored_sess.cancel_requested)
            self.assertIsNone(restored_sess.agent)
            self.assertIsNone(restored_sess.thread)
            self.assertEqual(restored_sess.messages[-1]["queued_status"], "cancelled")
            self.assertEqual(restored_sess.queued_prompts, [])


if __name__ == "__main__":
    unittest.main()
