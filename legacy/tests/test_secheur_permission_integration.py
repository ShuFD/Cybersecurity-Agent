import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import background_tasks
from agent_loop import agent_runner_loop
from permission_guard import reset_permission_cache
from secheur_core import SecHeurAgentHandler


class DummyParent:
    task_dir = None
    verbose = False


class DummyResponse:
    content = "plain answer without summary"
    thinking = ""
    tool_calls = []


class DummyClient:
    last_tools = ""

    def chat(self, messages, tools):
        if False:
            yield ""
        return DummyResponse()


class SecHeurPermissionIntegrationTests(unittest.TestCase):
    def tearDown(self):
        reset_permission_cache()
        background_tasks.reset_background_tasks()

    def _run_generator(self, gen):
        chunks = []
        while True:
            try:
                chunks.append(next(gen))
            except StopIteration as done:
                return "".join(chunks), done.value

    def test_cost_budget_exit_with_no_tools_does_not_crash_turn_end_callback(self):
        handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
        result = agent_runner_loop(
            DummyClient(),
            "system",
            "user",
            handler,
            [],
            max_turns=3,
            max_cost=0.10,
            cost_provider=lambda: 0.25,
            verbose=False,
        )

        output, exit_reason = self._run_generator(result)

        self.assertIn("Cost budget exceeded", output)
        self.assertEqual(exit_reason["result"], "MAX_COST_EXCEEDED")
        self.assertIn("[Agent]", handler.history_info[-1])

    def test_permission_block_turns_dangerous_code_into_confirmation_prompt(self):
        handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
        handler.permission_settings_paths = []

        message, outcome = handler._permission_block(
            "code_run",
            {"script": "rm -rf /tmp/secheur-test-old", "type": "bash"},
        )

        self.assertIn("需要确认", message)
        self.assertEqual(outcome.data["status"], "permission_required")
        self.assertIn("ask_user", outcome.next_prompt)

    def test_permission_block_uses_desktop_callback(self):
        parent = DummyParent()
        calls = []
        parent.desktop_permission_callback = lambda request: calls.append(request) or {"allowed": True, "decision": "allow_once"}
        handler = SecHeurAgentHandler(parent, [], cwd="./temp")
        handler.permission_settings_paths = []

        blocked = handler._permission_block(
            "code_run",
            {"script": "rm -rf /tmp/secheur-test-old", "type": "bash"},
        )

        self.assertIsNone(blocked)
        self.assertEqual(calls[0]["tool_name"], "code_run")

    def test_permission_block_shows_approved_plan_prompts_for_unmatched_shell_command(self):
        parent = DummyParent()
        parent.approved_plan_allowed_prompts = [{"tool": "Bash", "prompt": "run tests"}]
        calls = []
        parent.desktop_permission_callback = lambda request: calls.append(request) or {"allowed": True, "decision": "allow_once"}
        handler = SecHeurAgentHandler(parent, [], cwd="./temp")
        handler.permission_settings_paths = []

        blocked = handler._permission_block(
            "code_run",
            {"script": "python build.py", "type": "bash"},
        )

        self.assertIsNone(blocked)
        self.assertIn("python build.py", calls[0]["detail"])
        self.assertIn("run tests", calls[0]["detail"])
        self.assertIn("匹配的非破坏测试命令可自动放行", calls[0]["detail"])

    def test_approved_plan_run_tests_prompt_allows_common_test_command(self):
        parent = DummyParent()
        parent.approved_plan_allowed_prompts = [{"tool": "Bash", "prompt": "run tests"}]
        handler = SecHeurAgentHandler(parent, [], cwd="./temp")
        handler.permission_settings_paths = []

        blocked = handler._permission_block(
            "code_run",
            {"script": "uv run python -m pytest tests/test_shell_risk.py", "type": "bash"},
        )

        self.assertIsNone(blocked)

    def test_approved_plan_run_tests_prompt_does_not_allow_destructive_shell(self):
        parent = DummyParent()
        parent.approved_plan_allowed_prompts = [{"tool": "Bash", "prompt": "run tests"}]
        handler = SecHeurAgentHandler(parent, [], cwd="./temp")
        handler.permission_settings_paths = []

        blocked = handler._permission_block(
            "code_run",
            {"script": "rm -rf /tmp/secheur-test-old", "type": "bash"},
        )

        self.assertIsNotNone(blocked)

    def test_approved_plan_run_tests_prompt_does_not_allow_sensitive_env_prefix(self):
        parent = DummyParent()
        parent.approved_plan_allowed_prompts = [{"tool": "Bash", "prompt": "run tests"}]
        handler = SecHeurAgentHandler(parent, [], cwd="./temp")
        handler.permission_settings_paths = []

        blocked = handler._permission_block(
            "code_run",
            {"script": "PATH=/tmp/hijack pytest -q", "type": "bash"},
        )

        self.assertIsNotNone(blocked)

    def test_ask_user_preserves_desktop_choice_answer(self):
        parent = DummyParent()
        calls = []
        parent.desktop_ask_user_callback = lambda request: calls.append(request) or {"decision": "answer", "allowed": True, "answer": "是"}
        handler = SecHeurAgentHandler(parent, [], cwd="./temp")

        output, outcome = self._run_generator(handler.do_ask_user({
            "question": "确定删除 1.txt 吗？",
            "candidates": ["是", "否"],
        }, None))

        self.assertEqual(output, "")
        self.assertEqual(calls[0]["tool_name"], "ask_user")
        self.assertEqual(calls[0]["choices"], ["是", "否"])
        self.assertEqual(outcome.data["answer"], "是")
        self.assertIn("是", outcome.next_prompt)

    def test_ask_user_auto_answers_in_bypass_mode_without_desktop_callback(self):
        parent = DummyParent()
        parent.permission_mode = "bypassPermissions"
        handler = SecHeurAgentHandler(parent, [], cwd="./temp")

        output, outcome = self._run_generator(handler.do_ask_user({
            "question": "继续吗？",
            "candidates": ["是", "否"],
        }, None))

        self.assertEqual(output, "")
        self.assertEqual(outcome.data["status"], "ANSWERED")
        self.assertEqual(outcome.data["answer"], "是")
        self.assertFalse(outcome.should_exit)
        self.assertIn("是", outcome.next_prompt)

    def test_code_run_uses_long_default_timeout_in_bypass_mode(self):
        parent = DummyParent()
        parent.permission_mode = "bypassPermissions"
        parent.llmclient = type("Client", (), {"backend": type("Backend", (), {"history": []})()})()
        handler = SecHeurAgentHandler(parent, [], cwd="./temp")
        captured = {}

        def fake_code_run(code, code_type, timeout, cwd, **kwargs):
            captured["timeout"] = timeout
            if False:
                yield ""
            return {"status": "success"}

        with patch("secheur_core.code_run", fake_code_run):
            output, outcome = self._run_generator(handler.do_code_run({
                "type": "bash",
                "script": "sleep 90 && echo ok",
            }, None))

        self.assertEqual(output, "")
        self.assertGreaterEqual(captured["timeout"], 1200)
        self.assertEqual(outcome.data["status"], "success")

    def test_code_run_can_start_background_task_and_read_output(self):
        parent = DummyParent()
        parent.permission_mode = "bypassPermissions"
        handler = SecHeurAgentHandler(parent, [], cwd="./temp")
        handler.permission_settings_paths = []
        script = "import time; print('start', flush=True); time.sleep(0.2); print('done', flush=True)"

        started = time.perf_counter()
        output, outcome = self._run_generator(handler.do_code_run({
            "type": "python",
            "script": script,
            "run_in_background": True,
        }, None))
        elapsed = time.perf_counter() - started

        self.assertLess(elapsed, 0.2)
        self.assertIn("Background", output)
        self.assertEqual(outcome.data["status"], "running")
        self.assertTrue(outcome.data["task_id"])
        self.assertTrue(Path(outcome.data["output_path"]).exists())

        task_id = outcome.data["task_id"]
        final = None
        for _ in range(20):
            _, final = self._run_generator(handler.do_task_output({"task_id": task_id}, None))
            if final.data["status"] == "completed":
                break
            time.sleep(0.05)

        self.assertEqual(final.data["status"], "completed")
        self.assertEqual(final.data["exit_code"], 0)
        self.assertIn("start", final.data["stdout"])
        self.assertIn("done", final.data["stdout"])

    def test_code_run_background_output_uses_project_temp_tasks_not_run_cwd(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run_dir = root / "subdir"
            run_dir.mkdir()
            parent = DummyParent()
            parent.permission_mode = "bypassPermissions"
            parent.project_root = str(root)
            handler = SecHeurAgentHandler(parent, [], cwd=str(root))
            handler.permission_settings_paths = []

            _, outcome = self._run_generator(handler.do_code_run({
                "type": "python",
                "script": "print('background path check', flush=True)",
                "cwd": "subdir",
                "run_in_background": True,
            }, None))

            output_path = Path(outcome.data["output_path"]).resolve()

        self.assertEqual(output_path.parent, (root / "temp" / "tasks").resolve())
        self.assertNotEqual(output_path.parent, (run_dir / "tasks").resolve())

    def test_code_run_background_invalid_cwd_returns_structured_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = DummyParent()
            parent.permission_mode = "bypassPermissions"
            parent.project_root = tmp
            handler = SecHeurAgentHandler(parent, [], cwd=tmp)
            handler.permission_settings_paths = []

            output, outcome = self._run_generator(handler.do_code_run({
                "type": "python",
                "script": "print('never starts')",
                "cwd": "missing",
                "run_in_background": True,
            }, None))

        self.assertIn("Background", output)
        self.assertEqual(outcome.data["status"], "error")
        self.assertIn("missing", outcome.data["msg"])

    def test_task_stop_terminates_background_task(self):
        parent = DummyParent()
        parent.permission_mode = "bypassPermissions"
        handler = SecHeurAgentHandler(parent, [], cwd="./temp")
        handler.permission_settings_paths = []
        script = "import time; print('start', flush=True); time.sleep(5)"

        _, started = self._run_generator(handler.do_code_run({
            "type": "python",
            "script": script,
            "run_in_background": True,
        }, None))

        output, stopped = self._run_generator(handler.do_task_stop({"task_id": started.data["task_id"]}, None))

        self.assertIn("stopped", output)
        self.assertEqual(stopped.data["status"], "stopped")
        self.assertEqual(stopped.data["task_id"], started.data["task_id"])

    def test_turn_end_callback_injects_completed_background_task_notice_once(self):
        parent = DummyParent()
        parent.permission_mode = "bypassPermissions"
        handler = SecHeurAgentHandler(parent, [], cwd="./temp")
        handler.permission_settings_paths = []
        response = type("Response", (), {"content": "<summary>继续</summary>"})()

        _, started = self._run_generator(handler.do_code_run({
            "type": "python",
            "script": "print('background done', flush=True)",
            "run_in_background": True,
        }, None))

        task_id = started.data["task_id"]
        for _ in range(20):
            task = background_tasks.get_background_task(task_id)
            if task and task["status"] == "completed":
                break
            time.sleep(0.05)

        prompt = handler.turn_end_callback(response, [], [], 1, "next", {})
        repeated = handler.turn_end_callback(response, [], [], 2, "next", {})

        self.assertIn("[Background Task]", prompt)
        self.assertIn(task_id, prompt)
        self.assertIn("status=completed", prompt)
        self.assertIn("background done", prompt)
        self.assertNotIn(task_id, repeated)

    def test_inline_eval_is_denied_outside_bypass_mode(self):
        parent = DummyParent()
        parent.llmclient = type("Client", (), {"backend": type("Backend", (), {"history": []})()})()
        handler = SecHeurAgentHandler(parent, [], cwd="./temp")
        handler.permission_settings_paths = []

        output, outcome = self._run_generator(handler.do_code_run({
            "type": "python",
            "script": "1 + 1",
            "inline_eval": True,
        }, None))

        self.assertIn("权限拒绝", output)
        self.assertEqual(outcome.data["status"], "permission_denied")
        self.assertIn("inline_eval", outcome.data["msg"])

    def test_inline_eval_is_allowed_in_bypass_mode(self):
        parent = DummyParent()
        parent.permission_mode = "bypassPermissions"
        parent.llmclient = type("Client", (), {"backend": type("Backend", (), {"history": []})()})()
        handler = SecHeurAgentHandler(parent, [], cwd="./temp")

        output, outcome = self._run_generator(handler.do_code_run({
            "type": "python",
            "script": "1 + 1",
            "inline_eval": True,
        }, None))

        self.assertEqual(output, "")
        self.assertEqual(outcome.data, "2")

    def test_permission_block_enforces_plan_mode_for_file_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan_path = Path(tmp) / "plan.md"
            plan_path.write_text("- [ ] step\n", encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)
            handler.permission_settings_paths = []
            handler.enter_plan_mode(str(plan_path))

            message, outcome = handler._permission_block(
                "file_write",
                {"path": str(Path(tmp) / "app.py")},
            )

        self.assertIn("权限拒绝", message)
        self.assertEqual(outcome.data["status"], "permission_denied")
        self.assertIn("plan mode", outcome.data["msg"])

    def test_plan_mode_allows_handler_read_only_tool_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            plan_path = root / "plan.md"
            plan_path.write_text("- [ ] step\n", encoding="utf-8")
            (root / "notes.txt").write_text("hello\n", encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)
            handler.permission_settings_paths = []
            handler.enter_plan_mode(str(plan_path))

            output, outcome = self._run_generator(handler.do_list_files({"pattern": "*.txt"}, None))

        self.assertIn("notes.txt", output)
        self.assertEqual(outcome.data["status"], "success")

    def test_exit_plan_mode_tool_requires_user_approval_and_restores_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan_path = Path(tmp) / "plan.md"
            plan_path.write_text("- [ ] step\n", encoding="utf-8")
            parent = DummyParent()
            parent.permission_mode = "plan"
            parent.plan_file_path = str(plan_path)
            parent._slash_plan_mode_active = True
            parent._slash_plan_previous_permission_mode = "bypassPermissions"
            calls = []
            parent.desktop_ask_user_callback = lambda request: calls.append(request) or {"decision": "allow_once", "allowed": True, "answer": "批准"}
            handler = SecHeurAgentHandler(parent, [], cwd=tmp)
            handler.enter_plan_mode(str(plan_path))

            output, outcome = self._run_generator(handler.do_exit_plan_mode({"plan": "按计划执行"}, None))

        self.assertIn("退出 Plan Mode", output)
        self.assertEqual(outcome.data["status"], "approved")
        self.assertFalse(handler._in_plan_mode())
        self.assertIsNone(parent.plan_file_path)
        self.assertEqual(parent.permission_mode, "bypassPermissions")
        self.assertEqual(calls[0]["tool_name"], "exit_plan_mode")
        self.assertIn("批准", calls[0]["choices"])

    def test_exit_plan_mode_tool_archives_plan_snapshot_on_approval(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            plan_path = root / "docs" / "plan.md"
            plan_path.parent.mkdir()
            plan_text = "# Plan\n\n- [x] review\n"
            plan_path.write_text(plan_text, encoding="utf-8")
            parent = DummyParent()
            parent.permission_mode = "plan"
            parent.plan_file_path = str(plan_path)
            parent.desktop_ask_user_callback = lambda _request: {"decision": "allow_once", "allowed": True, "answer": "批准"}
            handler = SecHeurAgentHandler(parent, [], cwd=tmp)
            handler.enter_plan_mode(str(plan_path))

            _, outcome = self._run_generator(handler.do_exit_plan_mode({"plan": "按计划执行"}, None))

            archive_path = Path(outcome.data["archive_path"])
            self.assertEqual(outcome.data["status"], "approved")
            self.assertEqual(archive_path.parent, root / "temp" / "plan_archives")
            self.assertTrue(archive_path.exists())
            self.assertEqual(archive_path.read_text(encoding="utf-8"), plan_text)
            self.assertEqual(plan_path.read_text(encoding="utf-8"), plan_text)

    def test_exit_plan_mode_tool_preserves_allowed_prompts_on_approval(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan_path = Path(tmp) / "plan.md"
            plan_path.write_text("- [ ] step\n", encoding="utf-8")
            parent = DummyParent()
            parent.permission_mode = "plan"
            parent.plan_file_path = str(plan_path)
            calls = []
            parent.desktop_ask_user_callback = lambda request: calls.append(request) or {"decision": "allow_once", "allowed": True, "answer": "批准"}
            handler = SecHeurAgentHandler(parent, [], cwd=tmp)
            handler.enter_plan_mode(str(plan_path))

            _, outcome = self._run_generator(handler.do_exit_plan_mode({
                "plan": "按计划执行",
                "allowedPrompts": [
                    {"tool": "Bash", "prompt": "run tests"},
                    {"tool": "Bash", "prompt": "install dependencies"},
                ],
            }, None))

        allowed_prompts = [
            {"tool": "Bash", "prompt": "run tests"},
            {"tool": "Bash", "prompt": "install dependencies"},
        ]
        self.assertEqual(calls[0]["args"]["allowedPrompts"], allowed_prompts)
        self.assertIn("run tests", calls[0]["detail"])
        self.assertEqual(outcome.data["allowedPrompts"], allowed_prompts)
        self.assertEqual(parent.approved_plan_allowed_prompts, allowed_prompts)
        self.assertIn("run tests", outcome.next_prompt)

    def test_exit_plan_mode_tool_denial_keeps_plan_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan_path = Path(tmp) / "plan.md"
            plan_path.write_text("- [ ] step\n", encoding="utf-8")
            parent = DummyParent()
            parent.permission_mode = "plan"
            parent.plan_file_path = str(plan_path)
            parent.desktop_ask_user_callback = lambda _request: {"decision": "deny", "allowed": False, "answer": "拒绝"}
            handler = SecHeurAgentHandler(parent, [], cwd=tmp)
            handler.enter_plan_mode(str(plan_path))

            output, outcome = self._run_generator(handler.do_exit_plan_mode({"plan": "按计划执行"}, None))

        self.assertIn("继续保持 Plan Mode", output)
        self.assertEqual(outcome.data["status"], "denied")
        self.assertEqual(handler._in_plan_mode(), str(plan_path))
        self.assertEqual(parent.plan_file_path, str(plan_path))

    def test_exit_plan_mode_answer_reject_keeps_plan_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan_path = Path(tmp) / "plan.md"
            plan_path.write_text("- [ ] step\n", encoding="utf-8")
            parent = DummyParent()
            parent.permission_mode = "plan"
            parent.plan_file_path = str(plan_path)
            parent.desktop_ask_user_callback = lambda _request: {"decision": "answer", "allowed": False, "answer": "拒绝"}
            handler = SecHeurAgentHandler(parent, [], cwd=tmp)
            handler.enter_plan_mode(str(plan_path))

            _, outcome = self._run_generator(handler.do_exit_plan_mode({"plan": "按计划执行"}, None))

        self.assertEqual(outcome.data["status"], "denied")
        self.assertEqual(handler._in_plan_mode(), str(plan_path))

    def test_plan_mode_zero_checkboxes_requires_exit_tool_by_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan_path = Path(tmp) / "plan.md"
            plan_path.write_text("- [x] step\n", encoding="utf-8")
            parent = DummyParent()
            parent.permission_mode = "plan"
            parent.plan_file_path = str(plan_path)
            handler = SecHeurAgentHandler(parent, [], cwd=tmp)
            handler.enter_plan_mode(str(plan_path))
            response = type("Response", (), {"content": "计划已经整理好。", "thinking": ""})()

            output, outcome = self._run_generator(handler.do_no_tool({}, response))

        self.assertIn("Plan Mode", output)
        self.assertEqual(handler._in_plan_mode(), str(plan_path))
        self.assertEqual(parent.plan_file_path, str(plan_path))
        self.assertIn("exit_plan_mode", outcome.next_prompt)

    def test_plan_mode_zero_checkboxes_auto_exits_when_enabled(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan_path = Path(tmp) / "plan.md"
            plan_path.write_text("- [x] step\n", encoding="utf-8")
            parent = DummyParent()
            parent.permission_mode = "plan"
            parent.plan_file_path = str(plan_path)
            parent._slash_plan_mode_active = True
            parent._slash_plan_previous_permission_mode = "bypassPermissions"
            parent.auto_exit_plan_mode = True
            handler = SecHeurAgentHandler(parent, [], cwd=tmp)
            handler.enter_plan_mode(str(plan_path))
            response = type("Response", (), {"content": "计划已经整理好。", "thinking": ""})()

            output, outcome = self._run_generator(handler.do_no_tool({}, response))

        self.assertIn("Plan完成", output)
        self.assertIsNone(handler._in_plan_mode())
        self.assertIsNone(parent.plan_file_path)
        self.assertEqual(parent.permission_mode, "bypassPermissions")
        self.assertIsNone(outcome.next_prompt)

    def test_permission_mode_prefers_parent_setting_over_environment(self):
        parent = DummyParent()
        parent.permission_mode = "dontAsk"
        handler = SecHeurAgentHandler(parent, [], cwd="./temp")
        handler.permission_settings_paths = []

        message, outcome = handler._permission_block(
            "code_run",
            {"script": "rm -rf /tmp/secheur-test-old", "type": "bash"},
        )

        self.assertIn("权限拒绝", message)
        self.assertEqual(outcome.data["status"], "permission_denied")
        self.assertIn("dontAsk", outcome.data["msg"])

    def test_file_read_honors_read_deny_rule(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "private.txt"
            target.write_text("secret\n", encoding="utf-8")
            settings = Path(tmp) / "settings.json"
            settings.write_text('{"permissions": {"deny": ["Read(*private*)"]}}', encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)
            handler.permission_settings_paths = [settings]

            output, outcome = self._run_generator(handler.do_file_read({"path": "private.txt"}, None))

        self.assertIn("权限拒绝", output)
        self.assertEqual(outcome.data["status"], "permission_denied")

    def test_file_read_uses_selected_project_permission_settings_by_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "private.txt"
            settings_dir = root / ".secheur-agent"
            settings_dir.mkdir()
            target.write_text("secret\n", encoding="utf-8")
            (settings_dir / "settings.json").write_text(
                '{"permissions": {"deny": ["Read(*private*)"]}}',
                encoding="utf-8",
            )
            reset_permission_cache()
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)
            handler.project_root = root

            output, outcome = self._run_generator(handler.do_file_read({"path": "private.txt"}, None))

        self.assertIn("权限拒绝", output)
        self.assertEqual(outcome.data["status"], "permission_denied")

    def test_file_read_blocks_symlink_to_denied_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            private = root / "private.txt"
            public_link = root / "public.txt"
            private.write_text("secret\n", encoding="utf-8")
            try:
                public_link.symlink_to(private)
            except (OSError, NotImplementedError):
                self.skipTest("symlink not supported")
            settings = root / "settings.json"
            settings.write_text('{"permissions": {"deny": ["Read(*private*)"]}}', encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)
            handler.permission_settings_paths = [settings]

            output, outcome = self._run_generator(handler.do_file_read({"path": "public.txt"}, None))

        self.assertIn("权限拒绝", output)
        self.assertEqual(outcome.data["status"], "permission_denied")

    def test_file_read_blocks_parent_symlink_to_denied_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            private_dir = root / "private_dir"
            private_dir.mkdir()
            (private_dir / "note.txt").write_text("secret\n", encoding="utf-8")
            public_dir = root / "public_dir"
            try:
                public_dir.symlink_to(private_dir, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("symlink not supported")
            settings = root / "settings.json"
            settings.write_text('{"permissions": {"deny": ["Read(*private_dir*)"]}}', encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)
            handler.permission_settings_paths = [settings]

            output, outcome = self._run_generator(handler.do_file_read({"path": "public_dir/note.txt"}, None))

        self.assertIn("权限拒绝", output)
        self.assertEqual(outcome.data["status"], "permission_denied")

    def test_list_files_filters_paths_denied_by_read_rule(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "public.txt").write_text("public\n", encoding="utf-8")
            Path(tmp, "private.txt").write_text("secret\n", encoding="utf-8")
            settings = Path(tmp) / "settings.json"
            settings.write_text('{"permissions": {"deny": ["Read(*private*)"]}}', encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)
            handler.permission_settings_paths = [settings]

            output, outcome = self._run_generator(handler.do_list_files({"pattern": "*.txt"}, None))

        self.assertIn("public.txt", output)
        self.assertNotIn("private.txt", output)
        self.assertEqual(outcome.data["status"], "success")
        self.assertEqual(outcome.data["permission_skipped"], 1)

    def test_grep_search_skips_paths_denied_by_read_rule(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "public.txt").write_text("needle public\n", encoding="utf-8")
            Path(tmp, "private.txt").write_text("needle secret\n", encoding="utf-8")
            settings = Path(tmp) / "settings.json"
            settings.write_text('{"permissions": {"deny": ["Read(*private*)"]}}', encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)
            handler.permission_settings_paths = [settings]

            output, outcome = self._run_generator(handler.do_grep_search({"pattern": "needle", "include": "*.txt"}, None))

        self.assertIn("public.txt:1:needle public", output)
        self.assertNotIn("private.txt", output)
        self.assertNotIn("needle secret", output)
        self.assertEqual(outcome.data["status"], "success")
        self.assertEqual(outcome.data["permission_skipped"], 1)

    def test_file_write_blocks_denied_file_reference_expansion(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "out.txt"
            private = Path(tmp) / "private.txt"
            private.write_text("secret\n", encoding="utf-8")
            settings = Path(tmp) / "settings.json"
            settings.write_text('{"permissions": {"deny": ["Read(*private*)"]}}', encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)
            handler.permission_settings_paths = [settings]

            output, outcome = self._run_generator(
                handler.do_file_write({"path": "out.txt", "content": "{{file:private.txt:1:1}}"}, None)
            )

        self.assertIn("权限拒绝", output)
        self.assertEqual(outcome.data["status"], "permission_denied")
        self.assertFalse(target.exists())

    def test_file_patch_blocks_denied_file_reference_expansion(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "app.txt"
            private = Path(tmp) / "private.txt"
            target.write_text("old\n", encoding="utf-8")
            private.write_text("secret\n", encoding="utf-8")
            settings = Path(tmp) / "settings.json"
            settings.write_text('{"permissions": {"deny": ["Read(*private*)"]}}', encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)
            handler.permission_settings_paths = [settings]

            self._run_generator(handler.do_file_read({"path": "app.txt"}, None))
            output, outcome = self._run_generator(
                handler.do_file_patch(
                    {"path": "app.txt", "old_content": "old\n", "new_content": "{{file:private.txt:1:1}}"},
                    None,
                )
            )
            target_content = target.read_text(encoding="utf-8")

        self.assertIn("权限拒绝", output)
        self.assertEqual(outcome.data["status"], "permission_denied")
        self.assertEqual(target_content, "old\n")

    def test_web_execute_js_blocks_denied_script_file_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "private.js"
            script.write_text("return document.title;", encoding="utf-8")
            settings = Path(tmp) / "settings.json"
            settings.write_text(
                '{"permissions": {"allow": ["web_execute_js"], "deny": ["Read(*private*)"]}}',
                encoding="utf-8",
            )
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)
            handler.permission_settings_paths = [settings]

            output, outcome = self._run_generator(handler.do_web_execute_js({"script": "private.js"}, None))

        self.assertIn("权限拒绝", output)
        self.assertEqual(outcome.data["status"], "permission_denied")

    def test_web_execute_js_blocks_denied_save_to_file_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = Path(tmp) / "settings.json"
            settings.write_text(
                '{"permissions": {"allow": ["web_execute_js"], "deny": ["Write(*secret*)"]}}',
                encoding="utf-8",
            )
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)
            handler.permission_settings_paths = [settings]

            with patch("secheur_core.web_execute_js", return_value={"status": "success", "js_return": "secret value"}):
                output, outcome = self._run_generator(
                    handler.do_web_execute_js({"script": "return 1", "save_to_file": "secret.txt"}, None)
                )
            saved = (Path(tmp) / "secret.txt").exists()

        self.assertIn("权限拒绝", output)
        self.assertEqual(outcome.data["status"], "permission_denied")
        self.assertFalse(saved)

    def test_web_execute_js_save_to_file_keeps_original_when_replace_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "result.txt"
            target.write_text("original\n", encoding="utf-8")
            settings = Path(tmp) / "settings.json"
            settings.write_text('{"permissions": {"allow": ["web_execute_js"]}}', encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)
            handler.permission_settings_paths = [settings]

            with patch("secheur_core.web_execute_js", return_value={"status": "success", "js_return": "new\n"}):
                with patch("secheur_core.os.replace", side_effect=OSError("simulated replace failure")):
                    output, outcome = self._run_generator(
                        handler.do_web_execute_js({"script": "return 1", "save_to_file": "result.txt"}, None)
                    )
            content = target.read_text(encoding="utf-8")

        self.assertIn("保存失败", output)
        self.assertIn('"status": "success"', outcome.data)
        self.assertEqual(content, "original\n")


if __name__ == "__main__":
    unittest.main()
