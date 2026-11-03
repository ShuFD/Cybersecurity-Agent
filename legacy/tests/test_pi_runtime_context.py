import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import secheur_pi_bridge
from secheur_core import SecHeurAgentHandler


class PiRuntimeContextTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.state_dir = self.root / ".secheur-agent"
        rules_dir = self.state_dir / "rules"
        rules_dir.mkdir(parents=True)
        (rules_dir / "project.md").write_text("PROJECT_RUNTIME_RULE", encoding="utf-8")
        self.parent = secheur_pi_bridge._Parent(str(self.root), "default")
        self.handler = SecHeurAgentHandler(self.parent, cwd=str(self.root))
        self.environment = patch.dict(
            os.environ,
            {
                "SECHEUR_DISABLE_TASK_TREE": "0",
                "SECHEUR_DISABLE_ERROR_HANDLER": "0",
                "SECHEUR_DISABLE_TOOL_EXPERIENCE": "0",
                "SECHEUR_TOOL_EXPERIENCE_MEMORY_DIR": str(self.state_dir / "memory"),
                "SECHEUR_WEB_VERB_MEMORY_DIR": str(self.state_dir / "memory"),
                "SECHEUR_CTF_VERB_MEMORY_DIR": str(self.state_dir / "memory"),
            },
        )
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.tmp.cleanup()

    def start_task(self, attempt_dedup_enabled=False):
        return secheur_pi_bridge._dispatch_internal(
            self.parent,
            "__task_start",
            {
                "prompt": "Target ID: intercode-ctf/1\nReturn the answer in <FINAL_ANSWER> after verify_flag.",
                "session_id": "session/test",
                "state_dir": str(self.state_dir),
                "ctf_verbs_enabled": True,
                "attempt_dedup_enabled": attempt_dedup_enabled,
            },
            self.handler,
        )

    def test_parent_knowledge_settings_default_off(self):
        self.assertFalse(self.parent.memoryReferenceEnabled)
        self.assertFalse(self.parent.knowledgeBaseEnabled)

    def test_request_fields_synchronize_independent_knowledge_settings(self):
        first = secheur_pi_bridge._handle(
            self.handler,
            {
                "id": 1,
                "tool": "__turn_start",
                "args": {"turn": 1},
                "memoryReferenceEnabled": True,
            },
        )

        self.assertTrue(first["ok"])
        self.assertTrue(self.parent.memoryReferenceEnabled)
        self.assertFalse(self.parent.knowledgeBaseEnabled)

        second = secheur_pi_bridge._handle(
            self.handler,
            {
                "id": 2,
                "tool": "__turn_start",
                "args": {"turn": 2},
                "knowledgeBaseEnabled": True,
            },
        )

        self.assertTrue(second["ok"])
        self.assertTrue(self.parent.memoryReferenceEnabled)
        self.assertTrue(self.parent.knowledgeBaseEnabled)

    def test_task_start_initializes_server_supervision_for_the_pi_session(self):
        outcome = self.start_task()

        self.assertEqual(outcome.data["status"], "success")
        self.assertEqual(outcome.data["diagnostics"], [])
        self.assertIn("PROJECT_RUNTIME_RULE", outcome.next_prompt)
        self.assertIn("# Available Sub-Agents", outcome.next_prompt)
        self.assertIn("[CTF Fixed Context]", outcome.next_prompt)
        self.assertIn("[Structured Evidence Task Tree]", outcome.next_prompt)
        self.assertIn("[Evidence-Grounded Program Plan]", outcome.next_prompt)
        self.assertTrue(Path(self.parent.task_tree_path).is_file())
        self.assertTrue(Path(self.parent.plan_runtime_path).is_file())
        self.assertIn("session-test", self.parent.task_dir)
        self.assertTrue(self.handler._ctf_task)
        self.assertFalse(self.parent.attempt_dedup_enabled)

        _chunks, status = secheur_pi_bridge._consume_dispatch(
            self.handler.dispatch("plan_status", {"include_nodes": True}, None)
        )
        self.assertNotEqual(status.data["status"], "disabled")

    def test_task_start_applies_attempt_dedup_setting(self):
        self.start_task(attempt_dedup_enabled=True)

        self.assertTrue(self.parent.attempt_dedup_enabled)

    def test_task_start_resets_task_scoped_handler_state_only(self):
        self.handler._empty_ct = 2
        self.handler._done_hooks.append("stale hook")
        self.handler.working["stale"] = True
        self.handler._read_file_state["kept"] = (1, 2)
        self.handler.history_info.append("prior summary")

        self.start_task()

        self.assertFalse(hasattr(self.handler, "_empty_ct"))
        self.assertEqual(self.handler._done_hooks, [])
        self.assertNotIn("stale", self.handler.working)
        self.assertEqual(self.handler._read_file_state["kept"], (1, 2))
        self.assertIn("prior summary", self.handler.history_info)

    def test_external_pi_tools_feed_the_task_tree_plan_and_error_handler(self):
        self.start_task()
        secheur_pi_bridge._dispatch_internal(
            self.parent,
            "__turn_start",
            {"turn": 1},
            self.handler,
        )

        observed = secheur_pi_bridge._dispatch_internal(
            self.parent,
            "__observe_external_tool",
            {
                "tool_name": "bash",
                "args": {"command": "missing-tool"},
                "data": {"status": "error", "message": "command not found"},
            },
            self.handler,
        )

        self.assertEqual(self.handler.current_turn, 1)
        self.assertEqual(observed.data["status"], "observed")
        self.assertIsNotNone(observed.data["task_tree"])
        self.assertIsNotNone(observed.data["plan_runtime"])
        self.assertEqual(observed.data["error_handler"]["last_category"], "dependency_missing")
        self.assertIn("[Error Recovery]", observed.next_prompt)

    def test_external_mcp_tools_update_catalog_and_preserve_structured_facts(self):
        self.start_task()
        schemas = [
            {
                "type": "function",
                "function": {
                    "name": "mcp__ctf_toolbox__identify_file",
                    "description": "Identify a file",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ]

        secheur_pi_bridge._dispatch_internal(
            self.parent,
            "__observe_external_tool",
            {
                "tool_name": "mcp_refresh",
                "args": {},
                "data": {
                    "status": "success",
                    "tools": ["mcp__ctf_toolbox__identify_file"],
                },
                "available_tools": schemas,
            },
            self.handler,
        )
        secheur_pi_bridge._dispatch_internal(
            self.parent,
            "__observe_external_tool",
            {
                "tool_name": "mcp__ctf_toolbox__identify_file",
                "args": {"path": "target.bin"},
                "data": {
                    "status": "success",
                    "result": {
                        "path": "/work/target.bin",
                        "size": 4096,
                        "file": "ELF 64-bit LSB executable, x86-64",
                    },
                },
                "available_tools": schemas,
            },
            self.handler,
        )

        catalog = self.parent.plan_runtime_state["runtime"]["tool_catalog"]
        self.assertEqual(self.parent.mcp_tool_schemas, schemas)
        self.assertEqual(catalog["identify_file"], "mcp__ctf_toolbox__identify_file")
        self.assertEqual(
            self.parent.plan_runtime_state["facts"]["artifact.file_types"]["value"]["target.bin"],
            "ELF 64-bit LSB executable, x86-64",
        )

    def test_memory_prefetch_does_not_create_tool_evidence(self):
        memory_dir = self.root / "memory"
        memory_dir.mkdir()
        (memory_dir / "runtime-note.md").write_text(
            "Runtime memory contains the ALPHA_PREFETCH_MARKER.",
            encoding="utf-8",
        )
        self.start_task()
        tree_nodes_before = len(self.parent.task_tree_state["nodes"])
        evidence_before = len(self.parent.plan_runtime_state.get("evidence") or [])

        prefetched = secheur_pi_bridge._dispatch_internal(
            self.parent,
            "__memory_prefetch",
            {"query": "ALPHA_PREFETCH_MARKER", "limit": 5},
            self.handler,
        )

        self.assertEqual(prefetched.data["status"], "success")
        self.assertIn("runtime-note.md", prefetched.next_prompt)
        self.assertEqual(len(self.parent.task_tree_state["nodes"]), tree_nodes_before)
        self.assertEqual(len(self.parent.plan_runtime_state.get("evidence") or []), evidence_before)

    def test_unverified_assistant_flag_is_rejected_by_the_legacy_answer_gate(self):
        self.start_task()
        inspected = secheur_pi_bridge._dispatch_internal(
            self.parent,
            "__assistant_response",
            {"content": "The flag is flag{unsupported_guess}", "thinking": ""},
            self.handler,
        )

        self.assertEqual(inspected.data["status"], "guarded")
        self.assertIn("答案门禁", inspected.next_prompt)

    def test_empty_assistant_response_is_retried_by_the_legacy_guard(self):
        self.start_task()

        inspected = secheur_pi_bridge._dispatch_internal(
            self.parent,
            "__assistant_response",
            {"content": "", "thinking": ""},
            self.handler,
        )

        self.assertEqual(inspected.data["status"], "guarded")
        self.assertIn("Blank response", inspected.next_prompt)

    def test_ctf_actionless_responses_are_bounded_and_tool_activity_resets_them(self):
        self.start_task()

        first = secheur_pi_bridge._dispatch_internal(
            self.parent,
            "__assistant_response",
            {"content": "I will investigate the challenge next.", "thinking": ""},
            self.handler,
        )
        self.assertIn("[CTF Action Required]", first.next_prompt)
        self.assertEqual(self.handler._ctf_no_action_count, 1)

        secheur_pi_bridge._dispatch_internal(
            self.parent,
            "__observe_external_tool",
            {
                "tool_name": "read",
                "args": {"path": "evidence.txt"},
                "data": {"status": "success", "content": "evidence"},
            },
            self.handler,
        )
        self.assertEqual(self.handler._ctf_no_action_count, 0)

        first_after_tool = secheur_pi_bridge._dispatch_internal(
            self.parent,
            "__assistant_response",
            {"content": "I still need another step.", "thinking": ""},
            self.handler,
        )
        self.assertIn("[CTF Action Required]", first_after_tool.next_prompt)
        second = secheur_pi_bridge._dispatch_internal(
            self.parent,
            "__assistant_response",
            {"content": "I still have no concrete action.", "thinking": ""},
            self.handler,
        )
        self.assertIn("final recovery", second.next_prompt)
        stopped = secheur_pi_bridge._dispatch_internal(
            self.parent,
            "__assistant_response",
            {"content": "No action was taken.", "thinking": ""},
            self.handler,
        )
        self.assertTrue(stopped.should_exit)
        self.assertEqual(stopped.data["status"], "stopped")

    def test_tool_turn_restores_periodic_task_and_plan_context(self):
        self.start_task()
        secheur_pi_bridge._dispatch_internal(
            self.parent,
            "__turn_start",
            {"turn": 1},
            self.handler,
        )

        finished = secheur_pi_bridge._dispatch_internal(
            self.parent,
            "__turn_end",
            {
                "turn": 1,
                "content": "Inspecting the target.",
                "tool_calls": [{"tool_name": "bash", "args": {"command": "pwd"}}],
            },
            self.handler,
        )

        self.assertEqual(finished.data["status"], "finished")
        self.assertEqual(finished.data["tool_count"], 1)
        self.assertIn("[Task Tree Status]", finished.next_prompt)
        self.assertIn("[Program Plan Status]", finished.next_prompt)

    def test_tool_turn_delivers_completed_background_task_notice(self):
        self.start_task()
        completed_task = {
            "task_id": "task_pi_bridge_notice",
            "status": "completed",
            "exit_code": 0,
            "output_path": str(self.root / "temp" / "tasks" / "task_pi_bridge_notice.out"),
            "stdout": "background result",
        }

        with patch(
            "secheur_core.drain_completed_background_tasks",
            side_effect=[[completed_task], []],
        ):
            finished = secheur_pi_bridge._dispatch_internal(
                self.parent,
                "__turn_end",
                {
                    "turn": 1,
                    "content": "<summary>等待后台结果</summary>",
                    "tool_calls": [{"tool_name": "task_output", "args": {}}],
                },
                self.handler,
            )
            repeated = secheur_pi_bridge._dispatch_internal(
                self.parent,
                "__turn_end",
                {
                    "turn": 2,
                    "content": "<summary>继续</summary>",
                    "tool_calls": [{"tool_name": "task_output", "args": {}}],
                },
                self.handler,
            )

        self.assertIn("[Background Task] task_pi_bridge_notice", finished.next_prompt)
        self.assertIn("status=completed exit_code=0", finished.next_prompt)
        self.assertIn("background result", finished.next_prompt)
        self.assertNotIn("task_pi_bridge_notice", repeated.next_prompt)

    def test_external_hook_bridge_applies_pi_tool_alias_and_argument_patch(self):
        hook_script = self.root / "rewrite_hook.py"
        hook_script.write_text(
            "import json\n"
            "print(json.dumps({'hookSpecificOutput': {'updatedInput': {'command': 'printf rewritten'}}}))\n",
            encoding="utf-8",
        )
        (self.state_dir / "settings.json").write_text(
            json.dumps({
                "hooks": {
                    "PreToolUse": [{
                        "matcher": "Bash",
                        "hooks": [{"type": "command", "command": [sys.executable, str(hook_script)]}],
                    }],
                },
            }),
            encoding="utf-8",
        )

        outcome = secheur_pi_bridge._dispatch_internal(
            self.parent,
            "__hook",
            {"event": "tool_before", "tool_name": "bash", "args": {"command": "printf original"}},
            self.handler,
        )

        self.assertEqual(outcome.data["status"], "success")
        self.assertEqual(outcome.data["args"], {"command": "printf rewritten"})

    def test_external_hook_bridge_forwards_images_and_reports_blocking(self):
        marker = self.root / "prompt_hook_payload.json"
        hook_script = self.root / "prompt_hook.py"
        hook_script.write_text(
            "import json, pathlib, sys\n"
            "payload = json.load(sys.stdin)\n"
            f"pathlib.Path({str(marker)!r}).write_text(json.dumps(payload), encoding='utf-8')\n"
            "print(json.dumps({'prompt': 'rewritten prompt', 'additional_context': 'hook context'}))\n",
            encoding="utf-8",
        )
        block_script = self.root / "block_hook.py"
        block_script.write_text(
            "import sys\n"
            "sys.stderr.write('blocked by policy')\n"
            "raise SystemExit(2)\n",
            encoding="utf-8",
        )
        (self.state_dir / "settings.json").write_text(
            json.dumps({
                "hooks": {
                    "UserPromptSubmit": [{"command": [sys.executable, str(hook_script)]}],
                    "PreToolUse": [{"matcher": "Read", "command": [sys.executable, str(block_script)]}],
                },
            }),
            encoding="utf-8",
        )

        prompt = secheur_pi_bridge._dispatch_internal(
            self.parent,
            "__hook",
            {
                "event": "user_prompt_submit",
                "prompt": "original prompt",
                "images": [{"type": "image", "mimeType": "image/png", "data": "AA=="}],
                "source": "rpc",
            },
            self.handler,
        )
        blocked = secheur_pi_bridge._dispatch_internal(
            self.parent,
            "__hook",
            {"event": "tool_before", "tool_name": "read", "args": {"path": "secret.txt"}},
            self.handler,
        )

        payload = json.loads(marker.read_text(encoding="utf-8"))
        self.assertEqual(payload["images"][0]["mimeType"], "image/png")
        self.assertEqual(prompt.data["prompt"], "rewritten prompt")
        self.assertEqual(prompt.data["additional_context"], "hook context")
        self.assertTrue(blocked.data["blocked"])
        self.assertIn("blocked by policy", blocked.data["message"])


if __name__ == "__main__":
    unittest.main()
