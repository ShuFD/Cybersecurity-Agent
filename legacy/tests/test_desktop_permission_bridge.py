import threading
import time
import unittest

from frontends.desktop_bridge import AgentManager


class DesktopPermissionBridgeTests(unittest.TestCase):
    def test_add_message_moves_partial_id_past_inserted_message(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".")
        manager.add_message(sess, "user", "delete file")
        sess.partial = {"id": sess.msg_seq + 1, "role": "assistant", "content": "", "partial": True}

        inserted = manager.add_message(sess, "permission", "需要权限确认")

        self.assertEqual(inserted["id"], 2)
        self.assertEqual(sess.partial["id"], 3)

    def test_permission_decision_unblocks_waiter(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".")
        result = {}

        def wait_for_permission():
            result.update(manager.request_permission(
                sess.id,
                {"tool_name": "code_run", "args": {"script": "rm -rf /tmp/secheur-test-old", "type": "bash"}, "message": "danger"},
            ))

        thread = threading.Thread(target=wait_for_permission)
        thread.start()
        deadline = time.time() + 3
        request_id = None
        while time.time() < deadline:
            with manager.lock:
                request_id = next(iter(sess.permission_requests), None)
            if request_id:
                break
            time.sleep(0.02)

        self.assertIsNotNone(request_id)
        response = manager.resolve_permission(sess.id, request_id, "allow_once")
        thread.join(timeout=3)

        self.assertFalse(thread.is_alive())
        self.assertTrue(result["allowed"])
        self.assertEqual(result["decision"], "allow_once")
        self.assertEqual(response["message"]["status"], "resolved")

    def test_allow_session_reuses_same_signature(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".")
        request = {"tool_name": "code_run", "args": {"script": "rm -rf /tmp/secheur-test-old", "type": "bash"}, "message": "danger"}
        result = {}

        thread = threading.Thread(target=lambda: result.update(manager.request_permission(sess.id, request)))
        thread.start()
        deadline = time.time() + 3
        request_id = None
        while time.time() < deadline:
            with manager.lock:
                request_id = next(iter(sess.permission_requests), None)
            if request_id:
                break
            time.sleep(0.02)
        self.assertIsNotNone(request_id)
        manager.resolve_permission(sess.id, request_id, "allow_session")
        thread.join(timeout=3)

        remembered = manager.request_permission(sess.id, request)

        self.assertTrue(result["allowed"])
        self.assertTrue(remembered["allowed"])
        self.assertTrue(remembered["remembered"])

    def test_permission_detail_includes_approved_plan_allowed_prompts(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".")
        sess.approved_plan_allowed_prompts = [{"tool": "Bash", "prompt": "run tests"}]
        request = {"tool_name": "code_run", "args": {"script": "pytest -q", "type": "bash"}, "message": "danger"}
        result = {}

        thread = threading.Thread(target=lambda: result.update(manager.request_permission(sess.id, request)))
        thread.start()
        deadline = time.time() + 3
        request_id = None
        while time.time() < deadline:
            with manager.lock:
                request_id = next(iter(sess.permission_requests), None)
                detail = sess.permission_requests[request_id]["detail"] if request_id else ""
            if request_id:
                break
            time.sleep(0.02)
        self.assertIsNotNone(request_id)
        manager.resolve_permission(sess.id, request_id, "deny")
        thread.join(timeout=3)

        self.assertFalse(thread.is_alive())
        self.assertFalse(result["allowed"])
        self.assertIn("pytest -q", detail)
        self.assertIn("run tests", detail)
        self.assertIn("匹配的非破坏测试命令可自动放行", detail)

    def test_exit_plan_mode_approval_records_allowed_prompts_on_session(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".")
        allowed_prompts = [{"tool": "Bash", "prompt": "run tests"}]
        request = {
            "tool_name": "exit_plan_mode",
            "args": {"allowedPrompts": allowed_prompts},
            "message": "批准计划",
        }
        result = {}

        thread = threading.Thread(target=lambda: result.update(manager.request_permission(sess.id, request)))
        thread.start()
        deadline = time.time() + 3
        request_id = None
        while time.time() < deadline:
            with manager.lock:
                request_id = next(iter(sess.permission_requests), None)
            if request_id:
                break
            time.sleep(0.02)
        self.assertIsNotNone(request_id)
        manager.resolve_permission(sess.id, request_id, "allow_once")
        thread.join(timeout=3)

        class Agent:
            permission_mode = "default"

        agent = Agent()
        manager.sync_agent_runtime_config(agent, sess)

        self.assertTrue(result["allowed"])
        self.assertEqual(sess.approved_plan_allowed_prompts, allowed_prompts)
        self.assertEqual(agent.approved_plan_allowed_prompts, allowed_prompts)

    def test_exit_plan_mode_answer_reject_is_not_allowed(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".")
        sess.approved_plan_allowed_prompts = [{"tool": "Bash", "prompt": "run tests"}]
        request = {
            "tool_name": "exit_plan_mode",
            "args": {"allowedPrompts": [{"tool": "Bash", "prompt": "run tests"}]},
            "message": "批准计划",
            "choices": ["批准", "拒绝"],
        }
        result = {}

        thread = threading.Thread(target=lambda: result.update(manager.request_permission(sess.id, request)))
        thread.start()
        deadline = time.time() + 3
        request_id = None
        while time.time() < deadline:
            with manager.lock:
                request_id = next(iter(sess.permission_requests), None)
            if request_id:
                break
            time.sleep(0.02)
        self.assertIsNotNone(request_id)
        manager.resolve_permission(sess.id, request_id, "answer", "拒绝")
        thread.join(timeout=3)

        self.assertFalse(thread.is_alive())
        self.assertEqual(result["decision"], "answer")
        self.assertFalse(result["allowed"])
        self.assertEqual(result["answer"], "拒绝")
        self.assertEqual(sess.approved_plan_allowed_prompts, [])

    def test_answer_decision_returns_original_choice(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".")
        result = {}
        request = {"tool_name": "ask_user", "args": {"question": "继续吗？"}, "message": "继续吗？", "choices": ["是", "否"]}

        thread = threading.Thread(target=lambda: result.update(manager.request_permission(sess.id, request)))
        thread.start()
        deadline = time.time() + 3
        request_id = None
        while time.time() < deadline:
            with manager.lock:
                request_id = next(iter(sess.permission_requests), None)
            if request_id:
                break
            time.sleep(0.02)
        self.assertIsNotNone(request_id)
        manager.resolve_permission(sess.id, request_id, "answer", "是")
        thread.join(timeout=3)

        self.assertFalse(thread.is_alive())
        self.assertTrue(result["allowed"])
        self.assertEqual(result["decision"], "answer")
        self.assertEqual(result["answer"], "是")

    def test_bypass_permission_mode_auto_answers_ask_user_without_pending_request(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".", permission_mode="bypassPermissions")
        request = {"tool_name": "ask_user", "args": {"question": "继续吗？"}, "message": "继续吗？", "choices": ["是", "否"]}
        result = {}

        thread = threading.Thread(target=lambda: result.update(manager.request_permission(sess.id, request)))
        thread.start()
        thread.join(timeout=0.2)
        if thread.is_alive():
            sess.cancel_requested = True
            with manager.lock:
                events = list(sess.permission_events.values())
            for event in events:
                event.set()
            thread.join(timeout=1)

        self.assertFalse(thread.is_alive())
        self.assertTrue(result["allowed"])
        self.assertEqual(result["decision"], "answer")
        self.assertEqual(result["answer"], "是")
        self.assertEqual(sess.permission_requests, {})
        self.assertEqual(sess.permission_events, {})

    def test_set_session_permission_mode_updates_session_and_agent(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".")
        class Agent:
            permission_mode = "default"
        sess.agent = Agent()

        result = manager.set_session_permission_mode(sess.id, "bypassPermissions")

        self.assertEqual(result["permissionMode"], "bypassPermissions")
        self.assertEqual(sess.permission_mode, "bypassPermissions")
        self.assertEqual(sess.agent.permission_mode, "bypassPermissions")

    def test_set_session_permission_mode_rejects_running_session(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".")
        sess.status = "running"

        with self.assertRaises(Exception):
            manager.set_session_permission_mode(sess.id, "bypassPermissions")


if __name__ == "__main__":
    unittest.main()
