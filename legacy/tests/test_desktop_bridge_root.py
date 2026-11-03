import asyncio
import contextlib
import io
import importlib
import json
import queue
import sys
import threading
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from aiohttp import web

from frontends import desktop_bridge
from frontends.desktop_settings import save_api_config
from frontends.desktop_bridge import (
    AgentManager,
    cors_middleware,
    delete_agent_config_handler,
    delete_api_config_handler,
    fetch_api_models_handler,
    delete_mcp_config_handler,
    delete_skill_config_handler,
    desktop_config_path,
    messages_handler,
    new_session_handler,
    permission_handler,
    prompt_handler,
    registry_handler,
    save_agent_config_handler,
    save_api_config_handler,
    save_config_handler,
    save_mcp_config_handler,
    save_registry_handler,
    save_skill_config_handler,
    save_desktop_config,
    session_model_handler,
    session_permission_mode_handler,
    session_export_handler,
    session_runtime_log_handler,
    session_runtime_reset_handler,
)


class BadJsonRequest:
    can_read_body = True

    def __init__(self, match_info=None):
        self.match_info = match_info or {}

    async def json(self):
        raise ValueError("broken json")


class ListJsonRequest:
    can_read_body = True

    def __init__(self, match_info=None):
        self.match_info = match_info or {}

    async def json(self):
        return []


class NoBodyRequest:
    can_read_body = False


class QueryRequest:
    def __init__(self, query):
        self.query = query
        self.match_info = {"sid": "sess-missing"}


class JsonRequest:
    can_read_body = True

    def __init__(self, data, match_info=None, headers=None, method="POST"):
        self._data = data
        self.match_info = match_info or {}
        self.headers = headers or {}
        self.method = method

    async def json(self):
        return self._data


def json_response_payload(response):
    return json.loads(response.text)


class DesktopBridgeRootTests(unittest.TestCase):
    def test_parse_api_test_response_reads_responses_output_text_items(self):
        text = desktop_bridge.parse_api_test_response_payload({
            "output": [
                {"type": "output_text", "text": "OK from item"},
            ],
        }, "responses")

        self.assertEqual(text, "OK from item")

    def test_parse_api_test_response_reads_reasoning_only_chat_message(self):
        text = desktop_bridge.parse_api_test_response_payload({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "",
                    "reasoning_content": "reasoning proves the model responded",
                },
                "finish_reason": "length",
            }],
        }, "chat_completions")

        self.assertEqual(text, "reasoning proves the model responded")

    def test_agent_manager_exposes_project_root(self):
        manager = AgentManager()

        manager.project_root = "/tmp/project"

        self.assertEqual(manager.project_root, "/tmp/project")
        self.assertEqual(manager.mykey_path, str(Path("/tmp/project") / "mykey.py"))

    def test_agent_output_idle_timeout_defaults_to_600_seconds(self):
        manager = AgentManager()

        self.assertEqual(manager.agent_output_idle_timeout_seconds(), 600)

    def test_running_session_prompt_is_queued_without_interrupting_current_turn(self):
        manager = AgentManager(project_root=desktop_bridge.DEFAULT_PROJECT_ROOT)
        sess = manager.create_session(cwd=".")
        sess.status = "running"
        sess.partial = {"id": 1, "role": "assistant", "content": "working", "partial": True}

        result = manager.submit_prompt(sess.id, "补充要求：先别停，工具结束后再看。")

        self.assertTrue(result["accepted"])
        self.assertTrue(result["queued"])
        self.assertFalse(result["interrupted"])
        self.assertEqual(sess.status, "running")
        self.assertEqual(len(sess.queued_prompts), 1)
        self.assertEqual(sess.messages[-1]["queued_status"], "queued")
        self.assertIn("补充要求", sess.queued_prompts[0]["prompt"])

    def test_drain_queued_prompts_formats_user_messages_for_next_tool_boundary(self):
        manager = AgentManager(project_root=desktop_bridge.DEFAULT_PROJECT_ROOT)
        sess = manager.create_session(cwd=".")
        sess.status = "running"
        sess.partial = {"id": 1, "role": "assistant", "content": "working", "partial": True}
        manager.submit_prompt(sess.id, "第一条补充")
        manager.submit_prompt(sess.id, "第二条补充")

        injected = manager.drain_queued_prompts_for_agent(sess)

        self.assertIn("<queued_user_messages>", injected)
        self.assertIn("第一条补充", injected)
        self.assertIn("第二条补充", injected)
        self.assertEqual(sess.queued_prompts, [])
        self.assertEqual([m.get("queued_status") for m in sess.messages if m.get("queued_status")], ["delivered", "delivered"])

    def test_submit_prompt_stores_display_prompt_but_runs_backend_prompt(self):
        manager = AgentManager(project_root=desktop_bridge.DEFAULT_PROJECT_ROOT)
        sess = manager.create_session(cwd=".")
        captured = {}

        def fake_run_agent_turn(run_sess, prompt, images=None, done_callback=None, turn_id=None):
            captured["session_id"] = run_sess.id
            captured["prompt"] = prompt
            captured["images"] = images
            captured["turn_id"] = turn_id

        with patch.object(manager, "run_agent_turn", side_effect=fake_run_agent_turn):
            result = manager.submit_prompt(
                sess.id,
                "请先调用 skill 工具执行 heuristic-learning。\n\n修复登录 bug",
                display_prompt="修复登录 bug",
            )
            sess.thread.join(1)

        self.assertTrue(result["accepted"])
        self.assertEqual(sess.messages[0]["content"], "修复登录 bug")
        self.assertEqual(sess.title, "修复登录 bug")
        self.assertIn("heuristic-learning", captured["prompt"])
        self.assertEqual(captured["session_id"], sess.id)

    def test_queued_prompt_stores_display_prompt_but_keeps_backend_prompt_for_agent(self):
        manager = AgentManager(project_root=desktop_bridge.DEFAULT_PROJECT_ROOT)
        sess = manager.create_session(cwd=".")
        sess.status = "running"
        sess.partial = {"id": 1, "role": "assistant", "content": "working", "partial": True}

        result = manager.submit_prompt(
            sess.id,
            "请先调用 skill 工具执行 heuristic-learning。\n\n补充：加测试",
            display_prompt="补充：加测试",
        )

        self.assertTrue(result["queued"])
        self.assertEqual(sess.messages[-1]["content"], "补充：加测试")
        self.assertIn("heuristic-learning", sess.queued_prompts[0]["prompt"])
        self.assertEqual(sess.queued_prompts[0]["display_prompt"], "补充：加测试")

    def test_session_snapshot_includes_cairn_style_blackboard_graph(self):
        manager = AgentManager(project_root=desktop_bridge.DEFAULT_PROJECT_ROOT)
        sess = manager.create_session(cwd=".")

        manager.add_message(sess, "user", "分析 example.com 并拿到 flag")
        manager.add_message(sess, "permission", "需要运行 nmap", title="运行 bash 命令", status="pending")
        manager.add_message(sess, "assistant", "<function_calls><invoke name=\"code_run\"><parameter name=\"args\">nmap example.com</parameter></invoke></function_calls>\n\n扫描发现 80 端口开放，需要继续验证 Web 服务。")
        manager.add_message(sess, "user", "补充：优先看 Web 登录口")
        sess.status = "running"
        sess.partial = {"id": sess.msg_seq + 1, "role": "assistant", "content": "正在验证登录绕过", "partial": True}

        graph = manager.snapshot(sess)["blackboardGraph"]

        self.assertEqual(graph["project"]["origin"], "分析 example.com 并拿到 flag")
        self.assertIn("flag", graph["project"]["goal"])
        self.assertEqual(graph["facts"][0]["id"], "origin")
        self.assertEqual(graph["facts"][1]["id"], "goal")
        self.assertTrue(any(fact["sourceMessageId"] == 3 for fact in graph["facts"]))
        self.assertTrue(any(intent["status"] == "running" for intent in graph["intents"]))
        self.assertTrue(any(intent["description"] == "运行 bash 命令" for intent in graph["intents"]))
        self.assertEqual(graph["hints"][0]["content"], "补充：优先看 Web 登录口")
        self.assertEqual(graph["summary"]["hintCount"], 1)
        self.assertGreaterEqual(graph["summary"]["factCount"], 3)

    def test_blackboard_graph_summarizes_assistant_result_without_internal_logs(self):
        manager = AgentManager(project_root=desktop_bridge.DEFAULT_PROJECT_ROOT)
        sess = manager.create_session(cwd=".")

        manager.add_message(sess, "user", "查看 bilibili 热搜")
        manager.add_message(sess, "assistant", """
**LLM Running (Turn 1) ...**
<summary>The user wants to see the Bilibili hot search.</summary>

🛠️ Tool: `code_run`  📥 args:
````text
{
  "type": "python",
  "script": "import urllib.request\\n# Bilibili hot search API"
}
````
`````
[Action] Running python in agent
[Status] ✅ Exit Code: 0
[Stdout]
🔥 Bilibili 热搜榜

 1. 地球往事  (12245136)
 2. 葡萄牙今晚能否首胜  (7039025)
`````

**LLM Running (Turn 2) ...**

🔥 **Bilibili 热搜榜** (2026-06-23)

| # | 热搜词 | 热度 |
|---|--------|------|
| 1 | 地球往事 | 1224万 |
| 2 | 葡萄牙今晚能否首胜 | 704万 |

今日热搜以世界杯相关话题和高考查分为主。
""")

        graph = manager.snapshot(sess)["blackboardGraph"]
        assistant_fact = next(fact for fact in graph["facts"] if fact.get("sourceMessageId") == 2)
        description = assistant_fact["description"]

        self.assertIn("Bilibili 热搜榜", description)
        self.assertIn("地球往事", description)
        self.assertNotIn("LLM Running", description)
        self.assertNotIn("Tool:", description)
        self.assertNotIn("code_run", description)
        self.assertNotIn("script", description)
        self.assertNotIn("**", description)

    def test_prompt_handler_passes_display_prompt_to_manager(self):
        sess = desktop_bridge.manager.create_session(cwd=".")
        try:
            with patch.object(desktop_bridge.manager, "submit_prompt", return_value={"ok": True, "accepted": True}) as submit:
                response = asyncio.run(prompt_handler(JsonRequest({
                    "prompt": "backend prompt",
                    "displayPrompt": "visible prompt",
                }, {"sid": sess.id})))
                payload = json_response_payload(response)
        finally:
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(sess.id)

        self.assertTrue(payload["ok"])
        submit.assert_called_once()
        self.assertEqual(submit.call_args.args[:2], (sess.id, "backend prompt"))
        self.assertEqual(submit.call_args.kwargs["display_prompt"], "visible prompt")

    def test_session_export_and_runtime_log_are_session_specific(self):
        manager = AgentManager(project_root=desktop_bridge.DEFAULT_PROJECT_ROOT)
        sess = manager.create_session(cwd="/tmp/project", title="导出测试")
        manager.add_message(sess, "user", "hello")
        manager.add_message(sess, "assistant", "world")
        log_payload = manager.session_runtime_log(sess.id)
        export_payload = manager.export_session(sess.id)

        self.assertEqual(export_payload["session"]["id"], sess.id)
        self.assertEqual(export_payload["session"]["title"], "导出测试")
        self.assertEqual([m["content"] for m in export_payload["messages"]], ["hello", "world"])
        self.assertIn("runtimeLog", export_payload)
        self.assertGreaterEqual(len(log_payload["events"]), 3)
        self.assertTrue(all(event["sessionId"] == sess.id for event in log_payload["events"]))
        self.assertIn("message:user", [event["event"] for event in log_payload["events"]])

    def test_session_export_and_runtime_log_handlers_return_payloads(self):
        sess = desktop_bridge.manager.create_session(cwd=".", title="handler export")
        try:
            desktop_bridge.manager.add_message(sess, "user", "hello")
            export_response = asyncio.run(session_export_handler(JsonRequest({}, {"sid": sess.id}, method="GET")))
            log_response = asyncio.run(session_runtime_log_handler(JsonRequest({}, {"sid": sess.id}, method="GET")))
            export_payload = json_response_payload(export_response)
            log_payload = json_response_payload(log_response)
        finally:
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(sess.id)

        self.assertEqual(export_payload["sessionId"], sess.id)
        self.assertEqual(export_payload["messages"][0]["content"], "hello")
        self.assertEqual(log_payload["sessionId"], sess.id)
        self.assertTrue(log_payload["events"])

    def test_temporary_sub_agent_runner_streams_dialog_and_result(self):
        class FakeAgent:
            last_instance = None

            def __init__(self):
                self.task_queue = queue.Queue()
                self.inc_out = False
                self.verbose = True
                self.is_running = False
                self.stop_sig = False
                self.llmclient = None
                FakeAgent.last_instance = self

            def next_llm(self, llm_no):
                self.llm_no = llm_no

            def put_task(self, query, source="user", images=None):
                display_queue = queue.Queue()
                self.task_queue.put({"query": query, "source": source, "output": display_queue})
                return display_queue

            def run(self):
                task = self.task_queue.get()
                self.is_running = True
                out = task["output"]
                out.put({"next": "child says hello", "source": task["source"]})
                out.put({"done": "child final report", "source": task["source"]})
                self.is_running = False
                self.task_queue.task_done()

            def abort(self):
                self.stop_sig = True

        old_agentmain = sys.modules.get("agentmain")
        sys.modules["agentmain"] = SimpleNamespace(SecHeurAgent=FakeAgent)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / "mykey.py").write_text("", encoding="utf-8")
                manager = AgentManager(project_root=root)
                sess = desktop_bridge.Session(
                    id="sess-temp",
                    cwd=str(root),
                    llm_no=2,
                    permission_mode="bypassPermissions",
                    memory_reference_enabled=False,
                )
                chunks = []
                gen = manager.run_temporary_sub_agent(
                    sess,
                    {
                        "agent": "reviewer",
                        "task": "review patch",
                        "prompt": "Review review patch",
                        "allowed_tools": ["file_read"],
                        "read_file_state": {"/tmp/app.py": (1, 2, "digest")},
                        "read_call_state": {("/tmp/app.py", 1, 200, None, True): (1, 2, "digest")},
                    },
                )
                while True:
                    try:
                        chunks.append(next(gen))
                    except StopIteration as done:
                        outcome = done.value
                        break
                transcript_path = Path(outcome.data["transcript_path"])
                transcript_parent = transcript_path.parent
                transcript_exists = transcript_path.exists()
                transcript_text = transcript_path.read_text(encoding="utf-8")

            output = "".join(chunks)
            self.assertIn("<temp_sub_agent_dialog", output)
            self.assertIn("child says hello", output)
            self.assertIn('state="completed"', output)
            self.assertEqual(outcome.data["status"], "completed")
            self.assertIn("child final report", outcome.next_prompt)
            self.assertEqual(transcript_parent, root / "temp" / "model_responses")
            self.assertTrue(transcript_exists)
            self.assertIn("Review review patch", transcript_text)
            self.assertIn("child says hello", transcript_text)
            self.assertIn("child final report", transcript_text)
            self.assertEqual(FakeAgent.last_instance.allowed_tools, ["file_read"])
            self.assertEqual(FakeAgent.last_instance.llm_no, 2)
            self.assertEqual(FakeAgent.last_instance.handler._read_file_state, {"/tmp/app.py": (1, 2, "digest")})
            self.assertEqual(
                FakeAgent.last_instance.handler._read_call_state,
                {("/tmp/app.py", 1, 200, None, True): (1, 2, "digest")},
            )
        finally:
            if old_agentmain is None:
                sys.modules.pop("agentmain", None)
            else:
                sys.modules["agentmain"] = old_agentmain

    def test_ensure_project_import_path_clears_stale_mykey_module(self):
        old_sys_path = list(sys.path)
        old_mykey = sys.modules.pop("mykey", None)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                old_root = Path(tmp) / "old"
                new_root = Path(tmp) / "new"
                old_root.mkdir()
                new_root.mkdir()
                (old_root / "mykey.py").write_text("VALUE = 'old'\n", encoding="utf-8")
                (new_root / "mykey.py").write_text("VALUE = 'new'\n", encoding="utf-8")
                sys.path.insert(0, str(old_root))
                imported_old = importlib.import_module("mykey")
                self.assertEqual(imported_old.VALUE, "old")

                manager = AgentManager(project_root=new_root)
                manager.ensure_project_import_path()
                imported_new = importlib.import_module("mykey")

            self.assertEqual(imported_new.VALUE, "new")
            self.assertEqual(Path(imported_new.__file__).resolve(), (new_root / "mykey.py").resolve())
        finally:
            sys.path[:] = old_sys_path
            sys.modules.pop("mykey", None)
            if old_mykey is not None:
                sys.modules["mykey"] = old_mykey

    def test_ensure_project_import_path_promotes_project_root_before_stale_paths(self):
        old_sys_path = list(sys.path)
        old_mykey = sys.modules.pop("mykey", None)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                old_root = Path(tmp) / "old"
                new_root = Path(tmp) / "new"
                old_root.mkdir()
                new_root.mkdir()
                (old_root / "mykey.py").write_text("VALUE = 'old'\n", encoding="utf-8")
                (new_root / "mykey.py").write_text("VALUE = 'new'\n", encoding="utf-8")
                sys.path.insert(0, str(new_root.resolve()))
                sys.path.insert(0, str(old_root.resolve()))
                imported_old = importlib.import_module("mykey")
                self.assertEqual(imported_old.VALUE, "old")

                manager = AgentManager(project_root=new_root)
                manager.ensure_project_import_path()
                imported = importlib.import_module("mykey")

            self.assertEqual(imported.VALUE, "new")
            self.assertEqual(Path(imported.__file__).resolve(), (new_root / "mykey.py").resolve())
        finally:
            sys.path[:] = old_sys_path
            sys.modules.pop("mykey", None)
            if old_mykey is not None:
                sys.modules["mykey"] = old_mykey

    def test_ensure_project_import_path_clears_stale_llmcore_mykeys(self):
        old_sys_path = list(sys.path)
        old_mykey = sys.modules.pop("mykey", None)
        import llmcore
        old_llmcore_state = (
            getattr(llmcore, "_mykey_path", None),
            getattr(llmcore, "_mykey_mtime", None),
            getattr(llmcore, "mykeys", None),
            "mykeys" in vars(llmcore),
        )
        try:
            with tempfile.TemporaryDirectory() as tmp:
                old_root = Path(tmp) / "old"
                new_root = Path(tmp) / "new"
                old_root.mkdir()
                new_root.mkdir()
                (old_root / "mykey.py").write_text("VALUE = 'old'\n", encoding="utf-8")
                (new_root / "mykey.py").write_text("this is not valid python\n", encoding="utf-8")
                sys.path.insert(0, str(old_root.resolve()))
                llmcore._mykey_path = None
                llmcore._mykey_mtime = None
                vars(llmcore).pop("mykeys", None)
                loaded_old, _ = llmcore.reload_mykeys()
                self.assertEqual(loaded_old["VALUE"], "old")

                manager = AgentManager(project_root=new_root)
                manager.ensure_project_import_path()
                loaded_new, _ = llmcore.reload_mykeys()

            self.assertNotIn("VALUE", loaded_new)
        finally:
            sys.path[:] = old_sys_path
            sys.modules.pop("mykey", None)
            if old_mykey is not None:
                sys.modules["mykey"] = old_mykey
            old_path, old_mtime, old_mykeys, had_mykeys = old_llmcore_state
            llmcore._mykey_path = old_path
            llmcore._mykey_mtime = old_mtime
            if had_mykeys:
                llmcore.mykeys = old_mykeys
            else:
                vars(llmcore).pop("mykeys", None)

    def test_project_root_payload_uses_secheur_project_root_name(self):
        old_root = desktop_bridge.manager.project_root
        try:
            desktop_bridge.manager.project_root = "/tmp/project"

            payload = desktop_bridge.project_root_payload()
        finally:
            desktop_bridge.manager.project_root = old_root

        self.assertEqual(payload["projectRoot"], "/tmp/project")
        self.assertNotIn("gaRoot", payload)
        self.assertEqual(payload["mykeyPath"], str(Path("/tmp/project") / "mykey.py"))

    def test_desktop_config_persists_under_project_state_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            saved = save_desktop_config(root, {"theme": "white", "uiScale": 115})

            manager = AgentManager(project_root=root)

        self.assertEqual(saved, {"theme": "white", "uiScale": 115})
        self.assertEqual(manager.config["theme"], "white")
        self.assertEqual(manager.config["uiScale"], 115)
        self.assertEqual(desktop_config_path(root), root / ".secheur-agent" / "desktop-config.json")

    def test_desktop_config_save_replaces_obsolete_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            manager = AgentManager(project_root=root)
            manager.save_config({"theme": "white", "obsolete": True})

            saved = manager.save_config({"theme": "dark"})
            reloaded = AgentManager(project_root=root)

        self.assertEqual(saved, {"theme": "dark"})
        self.assertEqual(reloaded.config, {"theme": "dark"})

    def test_save_config_syncs_live_session_runtime_preferences(self):
        old_root = desktop_bridge.manager.project_root
        old_config = dict(desktop_bridge.manager.config)
        old_sessions = desktop_bridge.manager.sessions
        old_active = desktop_bridge.manager.active_session_id
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            custom_dir = Path(tmp) / "extra-skills"
            custom_dir.mkdir(parents=True)
            try:
                desktop_bridge.manager.project_root = root
                desktop_bridge.manager.sessions = {}
                desktop_bridge.manager.active_session_id = None
                sess = desktop_bridge.manager.create_session(memory_reference_enabled=True)
                sess.agent = SimpleNamespace(
                    custom_skill_dirs="",
                    memory_reference_enabled=True,
                    permission_mode="default",
                    max_turns=80,
                    max_cost=None,
                    llmclient=SimpleNamespace(
                        last_tools="cached",
                        backend=SimpleNamespace(thinking_type=None, thinking_budget_tokens=None),
                    ),
                )

                response = asyncio.run(save_config_handler(JsonRequest({
                    "config": {
                        "customSkillDirectories": str(custom_dir),
                        "memoryReferenceEnabled": False,
                        "permissionMode": "bypassPermissions",
                        "maxTurns": 12,
                        "maxCost": "1.25",
                        "thinkingMode": "enabled",
                        "thinkingBudget": "2048",
                    }
                })))
                payload = json_response_payload(response)
            finally:
                desktop_bridge.manager.project_root = old_root
                desktop_bridge.manager.config = old_config
                desktop_bridge.manager.sessions = old_sessions
                desktop_bridge.manager.active_session_id = old_active

        self.assertTrue(payload["ok"])
        self.assertFalse(sess.memory_reference_enabled)
        self.assertFalse(sess.agent.memory_reference_enabled)
        self.assertEqual(sess.permission_mode, "bypassPermissions")
        self.assertEqual(sess.agent.permission_mode, "bypassPermissions")
        self.assertEqual(sess.agent.custom_skill_dirs, str(custom_dir))
        self.assertEqual(sess.agent.max_turns, 12)
        self.assertEqual(sess.agent.max_cost, 1.25)
        self.assertEqual(sess.agent.llmclient.backend.thinking_type, "enabled")
        self.assertEqual(sess.agent.llmclient.backend.thinking_budget_tokens, 2048)
        self.assertEqual(sess.agent.llmclient.last_tools, "")

    def test_save_config_does_not_change_running_session_permission_mode(self):
        old_root = desktop_bridge.manager.project_root
        old_config = dict(desktop_bridge.manager.config)
        old_sessions = desktop_bridge.manager.sessions
        old_active = desktop_bridge.manager.active_session_id
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            try:
                desktop_bridge.manager.project_root = root
                desktop_bridge.manager.sessions = {}
                desktop_bridge.manager.active_session_id = None
                sess = desktop_bridge.manager.create_session(permission_mode="default")
                sess.status = "running"
                sess.agent = SimpleNamespace(permission_mode="default")

                response = asyncio.run(save_config_handler(JsonRequest({
                    "config": {"permissionMode": "bypassPermissions"}
                })))
                payload = json_response_payload(response)
            finally:
                desktop_bridge.manager.project_root = old_root
                desktop_bridge.manager.config = old_config
                desktop_bridge.manager.sessions = old_sessions
                desktop_bridge.manager.active_session_id = old_active

        self.assertTrue(payload["ok"])
        self.assertEqual(sess.permission_mode, "default")
        self.assertEqual(sess.agent.permission_mode, "default")

    def test_save_config_clears_live_agent_max_cost_when_blank(self):
        old_root = desktop_bridge.manager.project_root
        old_config = dict(desktop_bridge.manager.config)
        old_sessions = desktop_bridge.manager.sessions
        old_active = desktop_bridge.manager.active_session_id
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            try:
                desktop_bridge.manager.project_root = root
                desktop_bridge.manager.sessions = {}
                desktop_bridge.manager.active_session_id = None
                sess = desktop_bridge.manager.create_session(memory_reference_enabled=True)
                sess.agent = SimpleNamespace(
                    max_turns=80,
                    max_cost=1.25,
                    llmclient=SimpleNamespace(last_tools="cached"),
                )

                response = asyncio.run(save_config_handler(JsonRequest({
                    "config": {"maxCost": ""}
                })))
                payload = json_response_payload(response)
            finally:
                desktop_bridge.manager.project_root = old_root
                desktop_bridge.manager.config = old_config
                desktop_bridge.manager.sessions = old_sessions
                desktop_bridge.manager.active_session_id = old_active

        self.assertTrue(payload["ok"])
        self.assertIsNone(sess.agent.max_cost)

    def test_save_config_ignores_invalid_runtime_values_when_syncing_live_agent(self):
        old_root = desktop_bridge.manager.project_root
        old_config = dict(desktop_bridge.manager.config)
        old_sessions = desktop_bridge.manager.sessions
        old_active = desktop_bridge.manager.active_session_id
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            try:
                desktop_bridge.manager.project_root = root
                desktop_bridge.manager.sessions = {}
                desktop_bridge.manager.active_session_id = None
                sess = desktop_bridge.manager.create_session(memory_reference_enabled=True)
                sess.agent = SimpleNamespace(
                    max_turns=80,
                    max_cost=None,
                    llmclient=SimpleNamespace(last_tools="cached"),
                )

                response = asyncio.run(save_config_handler(JsonRequest({
                    "config": {
                        "maxTurns": "bad",
                        "maxCost": "bad",
                        "thinkingMode": "always",
                        "thinkingBudget": "bad",
                    }
                })))
                payload = json_response_payload(response)
            finally:
                desktop_bridge.manager.project_root = old_root
                desktop_bridge.manager.config = old_config
                desktop_bridge.manager.sessions = old_sessions
                desktop_bridge.manager.active_session_id = old_active

        self.assertTrue(payload["ok"])
        self.assertEqual(sess.agent.max_turns, 80)
        self.assertIsNone(sess.agent.max_cost)
        self.assertEqual(sess.agent.llmclient.last_tools, "")

    def test_empty_desktop_config_removes_persisted_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            manager = AgentManager(project_root=root)
            manager.save_config({"theme": "white"})

            saved = manager.save_config({})
            reloaded = AgentManager(project_root=root)

        self.assertEqual(saved, {})
        self.assertEqual(reloaded.config, {})
        self.assertFalse(desktop_config_path(root).exists())

    def test_registry_handler_reads_custom_skill_directories_from_desktop_config(self):
        old_root = desktop_bridge.manager.project_root
        old_config = dict(desktop_bridge.manager.config)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            custom_dir = Path(tmp) / "extra-skills"
            skill_dir = custom_dir / "incident"
            skill_dir.mkdir(parents=True)
            (skill_dir / "SKILL.md").write_text("---\nname: incident\n---\nHandle incident.", encoding="utf-8")
            try:
                desktop_bridge.manager.project_root = root
                save_desktop_config(root, {"customSkillDirectories": str(custom_dir)})

                response = asyncio.run(registry_handler(NoBodyRequest()))
                payload = json_response_payload(response)
            finally:
                desktop_bridge.manager.project_root = old_root
                desktop_bridge.manager.config = old_config

        self.assertIn("incident", [item["name"] for item in payload["skills"]])
        self.assertIn(str(custom_dir), payload["sources"]["skillDirs"])

    def test_save_config_rejects_bad_json_without_clearing_existing_config(self):
        old_root = desktop_bridge.manager.project_root
        old_config = dict(desktop_bridge.manager.config)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            try:
                desktop_bridge.manager.project_root = root
                desktop_bridge.manager.save_config({"theme": "white"})

                with self.assertRaises(web.HTTPBadRequest):
                    asyncio.run(save_config_handler(BadJsonRequest()))

                reloaded = AgentManager(project_root=root)
            finally:
                desktop_bridge.manager.project_root = old_root
                desktop_bridge.manager.config = old_config

        self.assertEqual(reloaded.config, {"theme": "white"})

    def test_messages_handler_rejects_invalid_integer_query(self):
        with self.assertRaises(web.HTTPBadRequest):
            asyncio.run(messages_handler(QueryRequest({"after": "abc"})))

    def test_messages_handler_rejects_negative_limit(self):
        with self.assertRaises(web.HTTPBadRequest):
            asyncio.run(messages_handler(QueryRequest({"limit": "-1"})))

    def test_session_model_handler_rejects_missing_llm_no_without_updating_session(self):
        sess = desktop_bridge.manager.create_session(cwd=".", llm_no=2)
        try:
            with self.assertRaises(web.HTTPBadRequest):
                asyncio.run(session_model_handler(JsonRequest({}, {"sid": sess.id})))
        finally:
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(sess.id)

        self.assertEqual(sess.llm_no, 2)

    def test_session_runtime_reset_handler_discards_current_agent(self):
        sess = desktop_bridge.manager.create_session(cwd=".")

        class Agent:
            abort_called = False

            def abort(self):
                self.abort_called = True

        agent = Agent()
        sess.agent = agent
        sess.agent_poisoned = True
        try:
            response = asyncio.run(session_runtime_reset_handler(JsonRequest({}, {"sid": sess.id})))
            payload = json_response_payload(response)
        finally:
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(sess.id)

        self.assertTrue(payload["ok"])
        self.assertTrue(payload["runtimeReset"])
        self.assertTrue(agent.abort_called)
        self.assertIsNone(sess.agent)
        self.assertFalse(sess.agent_poisoned)

    def test_session_model_handler_rejects_invalid_llm_no_without_updating_session(self):
        sess = desktop_bridge.manager.create_session(cwd=".", llm_no=2)
        try:
            with self.assertRaises(web.HTTPBadRequest):
                asyncio.run(session_model_handler(JsonRequest({"llmNo": "bad"}, {"sid": sess.id})))
        finally:
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(sess.id)

        self.assertEqual(sess.llm_no, 2)

    def test_session_model_handler_rejects_negative_llm_no_without_updating_session(self):
        sess = desktop_bridge.manager.create_session(cwd=".", llm_no=2)
        try:
            with self.assertRaises(web.HTTPBadRequest):
                asyncio.run(session_model_handler(JsonRequest({"llmNo": -1}, {"sid": sess.id})))
        finally:
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(sess.id)

        self.assertEqual(sess.llm_no, 2)

    def test_list_model_profiles_returns_empty_when_agent_has_no_llms(self):
        manager = AgentManager()

        class EmptyAgent:
            def list_llms(self):
                raise ZeroDivisionError("integer modulo by zero")

        fake_module = SimpleNamespace(SecHeurAgent=EmptyAgent)
        stderr = io.StringIO()
        with patch.dict(sys.modules, {"agentmain": fake_module}), patch("sys.stderr", stderr):
            self.assertEqual(manager.list_model_profiles(), [])
        self.assertEqual(stderr.getvalue(), "")

    def test_new_session_handler_rejects_invalid_llm_no_without_creating_session(self):
        before = set(desktop_bridge.manager.sessions)

        with self.assertRaises(web.HTTPBadRequest):
            asyncio.run(new_session_handler(JsonRequest({"llmNo": "bad"})))

        self.assertEqual(set(desktop_bridge.manager.sessions), before)

    def test_new_session_handler_defaults_llm_no_from_saved_config(self):
        old_config = dict(desktop_bridge.manager.config)
        desktop_bridge.manager.save_config({"llmNo": 2})
        response = asyncio.run(new_session_handler(JsonRequest({})))
        payload = json_response_payload(response)
        session_id = payload["sessionId"]
        try:
            self.assertEqual(payload["session"]["llmNo"], 2)
            self.assertEqual(desktop_bridge.manager.sessions[session_id].llm_no, 2)
        finally:
            desktop_bridge.manager.config = old_config
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(session_id)

    def test_new_session_handler_uses_permission_mode(self):
        response = asyncio.run(new_session_handler(JsonRequest({"permissionMode": "bypassPermissions"})))
        payload = json_response_payload(response)
        session_id = payload["sessionId"]
        try:
            self.assertEqual(payload["session"]["permissionMode"], "bypassPermissions")
            self.assertEqual(desktop_bridge.manager.sessions[session_id].permission_mode, "bypassPermissions")
        finally:
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(session_id)

    def test_new_session_handler_defaults_permission_mode_from_saved_config(self):
        old_config = dict(desktop_bridge.manager.config)
        desktop_bridge.manager.save_config({"permissionMode": "bypassPermissions"})
        response = asyncio.run(new_session_handler(JsonRequest({})))
        payload = json_response_payload(response)
        session_id = payload["sessionId"]
        try:
            self.assertEqual(payload["session"]["permissionMode"], "bypassPermissions")
            self.assertEqual(desktop_bridge.manager.sessions[session_id].permission_mode, "bypassPermissions")
        finally:
            desktop_bridge.manager.config = old_config
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(session_id)

    def test_new_session_handler_uses_memory_reference_enabled(self):
        response = asyncio.run(new_session_handler(JsonRequest({"memoryReferenceEnabled": False})))
        payload = json_response_payload(response)
        session_id = payload["sessionId"]
        try:
            self.assertFalse(payload["session"]["memoryReferenceEnabled"])
            self.assertFalse(desktop_bridge.manager.sessions[session_id].memory_reference_enabled)
        finally:
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(session_id)

    def test_new_session_handler_defaults_memory_reference_from_saved_config(self):
        old_config = dict(desktop_bridge.manager.config)
        desktop_bridge.manager.save_config({"memoryReferenceEnabled": False})
        response = asyncio.run(new_session_handler(JsonRequest({})))
        payload = json_response_payload(response)
        session_id = payload["sessionId"]
        try:
            self.assertFalse(payload["session"]["memoryReferenceEnabled"])
            self.assertFalse(desktop_bridge.manager.sessions[session_id].memory_reference_enabled)
        finally:
            desktop_bridge.manager.config = old_config
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(session_id)

    def test_new_session_handler_rejects_invalid_memory_reference_enabled_without_creating_session(self):
        before = set(desktop_bridge.manager.sessions)

        with self.assertRaises(web.HTTPBadRequest):
            asyncio.run(new_session_handler(JsonRequest({"memoryReferenceEnabled": "maybe"})))

        self.assertEqual(set(desktop_bridge.manager.sessions), before)

    def test_new_session_handler_rejects_invalid_permission_mode_without_creating_session(self):
        before = set(desktop_bridge.manager.sessions)

        with self.assertRaises(web.HTTPBadRequest):
            asyncio.run(new_session_handler(JsonRequest({"permissionMode": "bad"})))

        self.assertEqual(set(desktop_bridge.manager.sessions), before)

    def test_new_session_handler_rejects_bad_json_without_creating_session(self):
        before = set(desktop_bridge.manager.sessions)

        with self.assertRaises(web.HTTPBadRequest):
            asyncio.run(new_session_handler(BadJsonRequest()))

        self.assertEqual(set(desktop_bridge.manager.sessions), before)

    def test_new_session_handler_allows_missing_json_body(self):
        sess = asyncio.run(new_session_handler(NoBodyRequest()))
        session_id = json_response_payload(sess)["sessionId"]
        try:
            self.assertIn(session_id, desktop_bridge.manager.sessions)
        finally:
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(session_id)

    def test_prompt_handler_rejects_invalid_llm_no_without_updating_session(self):
        sess = desktop_bridge.manager.create_session(cwd=".", llm_no=2)
        try:
            with self.assertRaises(web.HTTPBadRequest):
                asyncio.run(prompt_handler(JsonRequest({"prompt": "hello", "llmNo": "bad"}, {"sid": sess.id})))
        finally:
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(sess.id)

        self.assertEqual(sess.llm_no, 2)
        self.assertEqual(sess.status, "idle")
        self.assertEqual(sess.messages, [])

    def test_prompt_handler_rejects_bad_json_without_updating_session(self):
        sess = desktop_bridge.manager.create_session(cwd=".")
        try:
            with self.assertRaises(web.HTTPBadRequest):
                asyncio.run(prompt_handler(BadJsonRequest({"sid": sess.id})))
        finally:
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(sess.id)

        self.assertEqual(sess.status, "idle")
        self.assertEqual(sess.messages, [])

    def test_prompt_handler_rejects_empty_prompt_without_updating_session(self):
        sess = desktop_bridge.manager.create_session(cwd=".")
        try:
            with self.assertRaises(web.HTTPBadRequest):
                asyncio.run(prompt_handler(JsonRequest({}, {"sid": sess.id})))
        finally:
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(sess.id)

        self.assertEqual(sess.status, "idle")
        self.assertEqual(sess.messages, [])

    def test_prompt_handler_rejects_prompt_list_that_normalizes_empty(self):
        sess = desktop_bridge.manager.create_session(cwd=".")
        try:
            with self.assertRaises(web.HTTPBadRequest):
                asyncio.run(prompt_handler(JsonRequest({
                    "prompt": [{"type": "text", "text": "   "}, {"type": "image"}],
                }, {"sid": sess.id})))
        finally:
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(sess.id)

        self.assertEqual(sess.status, "idle")
        self.assertEqual(sess.messages, [])

    def test_prompt_handler_rejects_image_item_without_data_url_after_normalization(self):
        sess = desktop_bridge.manager.create_session(cwd=".")
        try:
            with self.assertRaises(web.HTTPBadRequest):
                asyncio.run(prompt_handler(JsonRequest({
                    "images": [{"id": "img-empty"}],
                }, {"sid": sess.id})))
        finally:
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(sess.id)

        self.assertEqual(sess.status, "idle")
        self.assertEqual(sess.messages, [])

    def test_prompt_handler_rejects_non_list_images_without_updating_session(self):
        sess = desktop_bridge.manager.create_session(cwd=".")
        try:
            with self.assertRaises(web.HTTPBadRequest):
                asyncio.run(prompt_handler(JsonRequest({"prompt": "hello", "images": "bad"}, {"sid": sess.id})))
        finally:
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(sess.id)

        self.assertEqual(sess.status, "idle")
        self.assertEqual(sess.messages, [])

    def test_prompt_handler_checks_session_before_saving_images(self):
        image_id = "img-nosession"
        image_path = desktop_bridge._UPLOAD_DIR / f"{image_id}.png"
        with contextlib.suppress(FileNotFoundError):
            image_path.unlink()

        with self.assertRaises(web.HTTPNotFound):
            asyncio.run(prompt_handler(JsonRequest({
                "prompt": "hello",
                "images": [{"id": image_id, "dataUrl": "data:image/png;base64,aGVsbG8="}],
            }, {"sid": "sess-missing"})))

        self.assertFalse(image_path.exists())

    def test_prompt_handler_rejects_invalid_image_data_without_updating_session(self):
        sess = desktop_bridge.manager.create_session(cwd=".")
        try:
            with self.assertRaises(web.HTTPBadRequest):
                asyncio.run(prompt_handler(JsonRequest({
                    "prompt": "hello",
                    "images": [{"id": "img-valid", "dataUrl": "data:image/png;base64,not-base64!"}],
                }, {"sid": sess.id})))
        finally:
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(sess.id)

        self.assertEqual(sess.status, "idle")
        self.assertEqual(sess.messages, [])

    def test_prompt_handler_rejects_unsafe_image_id_without_updating_session(self):
        sess = desktop_bridge.manager.create_session(cwd=".")
        try:
            with self.assertRaises(web.HTTPBadRequest):
                asyncio.run(prompt_handler(JsonRequest({
                    "prompt": "hello",
                    "images": [{"id": "../escape", "dataUrl": "data:image/png;base64,aGVsbG8="}],
                }, {"sid": sess.id})))
        finally:
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(sess.id)

        self.assertEqual(sess.status, "idle")
        self.assertEqual(sess.messages, [])

    def test_prompt_handler_rejects_too_many_images_without_updating_session(self):
        sess = desktop_bridge.manager.create_session(cwd=".")
        images = [
            {"id": f"img-many-{idx}", "dataUrl": "data:image/png;base64,aGVsbG8="}
            for idx in range(desktop_bridge.MAX_PROMPT_IMAGES + 1)
        ]
        try:
            with self.assertRaises(web.HTTPBadRequest):
                asyncio.run(prompt_handler(JsonRequest({"prompt": "hello", "images": images}, {"sid": sess.id})))
        finally:
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(sess.id)

        self.assertEqual(sess.status, "idle")
        self.assertEqual(sess.messages, [])

    def test_prompt_handler_rejects_oversized_image_without_updating_session(self):
        sess = desktop_bridge.manager.create_session(cwd=".")
        image_id = "img-too-large"
        image_path = desktop_bridge._UPLOAD_DIR / f"{image_id}.png"
        with contextlib.suppress(FileNotFoundError):
            image_path.unlink()
        payload = b"x" * (desktop_bridge.MAX_PROMPT_IMAGE_BYTES + 1)
        data_url = "data:image/png;base64," + desktop_bridge.base64.b64encode(payload).decode("ascii")
        try:
            with self.assertRaises(web.HTTPBadRequest):
                asyncio.run(prompt_handler(JsonRequest({
                    "prompt": "hello",
                    "images": [{"id": image_id, "dataUrl": data_url}],
                }, {"sid": sess.id})))
        finally:
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(sess.id)

        self.assertFalse(image_path.exists())
        self.assertEqual(sess.status, "idle")
        self.assertEqual(sess.messages, [])

    def test_prompt_handler_rejects_oversized_prompt_without_updating_session(self):
        sess = desktop_bridge.manager.create_session(cwd=".")
        try:
            with self.assertRaises(web.HTTPBadRequest):
                asyncio.run(prompt_handler(JsonRequest({
                    "prompt": "x" * (desktop_bridge.MAX_PROMPT_TEXT_CHARS + 1),
                }, {"sid": sess.id})))
        finally:
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(sess.id)

        self.assertEqual(sess.status, "idle")
        self.assertEqual(sess.messages, [])

    def test_normalize_prompt_saves_non_image_file_attachment(self):
        file_id = "file-note"
        file_path = desktop_bridge._UPLOAD_DIR / f"{file_id}-note.txt"
        with contextlib.suppress(FileNotFoundError):
            file_path.unlink()

        prompt, image_ids, file_refs = desktop_bridge.normalize_prompt(
            "请分析附件",
            files=[{
                "id": file_id,
                "name": "note.txt",
                "type": "text/plain",
                "dataUrl": "data:text/plain;base64,aGVsbG8=",
            }],
        )

        self.assertEqual(image_ids, [])
        self.assertEqual(len(file_refs), 1)
        self.assertTrue(file_path.exists())
        self.assertEqual(file_path.read_text(encoding="utf-8"), "hello")
        self.assertIn('<uploaded_file name="note.txt" type="text/plain" size="5">', prompt)
        self.assertIn(str(file_path), prompt)
        with contextlib.suppress(FileNotFoundError):
            file_path.unlink()

    def test_normalize_prompt_rejects_unsafe_file_attachment_name(self):
        with self.assertRaises(web.HTTPBadRequest):
            desktop_bridge.normalize_prompt(
                "hello",
                files=[{
                    "id": "file-bad",
                    "name": "../secret.txt",
                    "dataUrl": "data:text/plain;base64,aGVsbG8=",
                }],
            )

    def test_submit_prompt_accepts_file_only_attachment_and_records_metadata(self):
        manager = AgentManager(project_root=desktop_bridge.DEFAULT_PROJECT_ROOT)
        sess = manager.create_session(cwd=".")

        class DummyAgent:
            inc_out = False

            def put_task(self, prompt, images=None):
                q = queue.Queue()
                q.put({"done": "ok"})
                return q

        manager.make_agent = lambda _sess: DummyAgent()
        result = manager.submit_prompt(
            sess.id,
            "",
            files=[{
                "id": "file-only",
                "name": "report.bin",
                "type": "application/octet-stream",
                "dataUrl": "data:application/octet-stream;base64,Ymlu",
            }],
        )

        self.assertTrue(result["accepted"])
        self.assertEqual(sess.messages[0]["role"], "user")
        self.assertIn("<uploaded_file", sess.messages[0]["content"])
        self.assertEqual(sess.messages[0]["file_attachments"][0]["name"], "report.bin")
        self.assertTrue(Path(sess.messages[0]["file_attachments"][0]["path"]).is_file())

    def test_submit_prompt_passes_saved_image_paths_to_agent(self):
        manager = AgentManager(project_root=desktop_bridge.DEFAULT_PROJECT_ROOT)
        sess = manager.create_session(cwd=".")
        captured = {}

        class DummyAgent:
            inc_out = False

            def put_task(self, prompt, images=None):
                captured["prompt"] = prompt
                captured["images"] = list(images or [])
                q = queue.Queue()
                q.put({"done": "ok"})
                return q

        image_id = "img-direct-path"
        image_path = desktop_bridge._UPLOAD_DIR / f"{image_id}.png"
        with contextlib.suppress(FileNotFoundError):
            image_path.unlink()

        manager.make_agent = lambda _sess: DummyAgent()
        result = manager.submit_prompt(
            sess.id,
            "请识别图片",
            images=[{"id": image_id, "dataUrl": "data:image/png;base64,aGVsbG8="}],
        )
        sess.thread.join(1)

        self.assertTrue(result["accepted"])
        self.assertEqual(captured["images"], [{"id": image_id, "path": str(image_path)}])
        self.assertIn(f"[image:{image_path}]", captured["prompt"])
        self.assertTrue(image_path.is_file())

    def test_test_api_response_posts_chat_completion_and_returns_text(self):
        async def run_case():
            seen = {}

            async def handler(request):
                seen["path"] = request.path
                seen["authorization"] = request.headers.get("Authorization")
                body = await request.json()
                seen["body"] = body
                return web.json_response({
                    "model": body.get("model"),
                    "choices": [{"message": {"content": "OK"}}],
                })

            app = web.Application()
            app.router.add_post("/v1/chat/completions", handler)
            runner = web.AppRunner(app)
            await runner.setup()
            site = web.TCPSite(runner, "127.0.0.1", 0)
            await site.start()
            port = site._server.sockets[0].getsockname()[1]
            try:
                result = await desktop_bridge.test_api_response({
                    "type": "native_oai",
                    "apikey": "sk-response",
                    "apibase": f"http://127.0.0.1:{port}/v1",
                    "model": "fake-chat",
                    "api_mode": "chat_completions",
                })
            finally:
                await site.stop()
                await runner.cleanup()

            self.assertTrue(result["ok"])
            self.assertEqual(result["model"], "fake-chat")
            self.assertEqual(result["text"], "OK")
            self.assertEqual(seen["path"], "/v1/chat/completions")
            self.assertEqual(seen["authorization"], "Bearer sk-response")
            self.assertEqual(seen["body"]["messages"][0]["content"], desktop_bridge.API_TEST_PROMPT)

        asyncio.run(run_case())

    def test_test_api_response_treats_empty_text_as_reachable_response(self):
        async def run_case():
            async def handler(request):
                body = await request.json()
                return web.json_response({
                    "model": body.get("model"),
                    "choices": [{"message": {"content": None}}],
                })

            app = web.Application()
            app.router.add_post("/v1/chat/completions", handler)
            runner = web.AppRunner(app)
            await runner.setup()
            site = web.TCPSite(runner, "127.0.0.1", 0)
            await site.start()
            port = site._server.sockets[0].getsockname()[1]
            try:
                result = await desktop_bridge.test_api_response({
                    "type": "native_oai",
                    "apikey": "sk-empty",
                    "apibase": f"http://127.0.0.1:{port}/v1",
                    "model": "fake-empty",
                    "api_mode": "chat_completions",
                })
            finally:
                await site.stop()
                await runner.cleanup()

            self.assertTrue(result["ok"])
            self.assertTrue(result["emptyText"])
            self.assertEqual(result["text"], "")
            self.assertIn('"choices"', result["rawPreview"])

        asyncio.run(run_case())

    def test_test_api_response_rejects_success_json_that_is_not_model_response(self):
        async def run_case():
            async def handler(request):
                return web.json_response({
                    "code": 0,
                    "msg": "gateway is reachable but not wired to a model",
                    "data": None,
                })

            app = web.Application()
            app.router.add_post("/v1/chat/completions", handler)
            runner = web.AppRunner(app)
            await runner.setup()
            site = web.TCPSite(runner, "127.0.0.1", 0)
            await site.start()
            port = site._server.sockets[0].getsockname()[1]
            try:
                with self.assertRaisesRegex(ValueError, "不是兼容的模型响应"):
                    await desktop_bridge.test_api_response({
                        "type": "native_oai",
                        "apikey": "sk-fake",
                        "apibase": f"http://127.0.0.1:{port}/v1",
                        "model": "fake-model",
                        "api_mode": "chat_completions",
                    })
            finally:
                await site.stop()
                await runner.cleanup()

        asyncio.run(run_case())

    def test_create_app_sets_request_body_size_limit(self):
        app = desktop_bridge.create_app()

        self.assertEqual(app._client_max_size, desktop_bridge.MAX_REQUEST_BYTES)

    def test_cors_middleware_rejects_non_localhost_origin_before_handler(self):
        async def handler(_request):
            raise AssertionError("handler should not run for untrusted origin")

        request = JsonRequest({}, headers={"Origin": "https://example.com"}, method="POST")
        response = asyncio.run(cors_middleware(request, handler))

        self.assertEqual(response.status, 403)

    def test_cors_middleware_allows_localhost_origin(self):
        async def handler(_request):
            return web.Response(text="ok")

        request = JsonRequest({}, headers={"Origin": "http://127.0.0.1:14168"}, method="POST")
        response = asyncio.run(cors_middleware(request, handler))

        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers.get("Access-Control-Allow-Origin"), "http://127.0.0.1:14168")

    def test_cors_middleware_allows_remote_same_origin_host(self):
        async def handler(_request):
            return web.Response(text="ok")

        request = JsonRequest(
            {},
            headers={
                "Origin": "http://198.51.100.10:14168",
                "Host": "198.51.100.10:14168",
            },
            method="POST",
        )
        response = asyncio.run(cors_middleware(request, handler))

        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers.get("Access-Control-Allow-Origin"), "http://198.51.100.10:14168")

    def test_session_permission_mode_handler_rejects_missing_mode_without_updating_session(self):
        sess = desktop_bridge.manager.create_session(cwd=".")
        sess.permission_mode = "plan"
        try:
            with self.assertRaises(web.HTTPBadRequest):
                asyncio.run(session_permission_mode_handler(JsonRequest({}, {"sid": sess.id})))
        finally:
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(sess.id)

        self.assertEqual(sess.permission_mode, "plan")

    def test_session_permission_mode_handler_rejects_non_string_mode_without_updating_session(self):
        sess = desktop_bridge.manager.create_session(cwd=".")
        sess.permission_mode = "plan"
        try:
            with self.assertRaises(web.HTTPBadRequest):
                asyncio.run(session_permission_mode_handler(JsonRequest({"mode": 1}, {"sid": sess.id})))
        finally:
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(sess.id)

        self.assertEqual(sess.permission_mode, "plan")

    def test_permission_handler_rejects_missing_decision_without_resolving_request(self):
        sess = desktop_bridge.manager.create_session(cwd=".")
        request_id = "perm-test"
        sess.permission_requests[request_id] = {"status": "pending"}
        try:
            with self.assertRaises(web.HTTPBadRequest):
                asyncio.run(permission_handler(JsonRequest({}, {"sid": sess.id, "rid": request_id})))

            self.assertEqual(sess.permission_requests[request_id]["status"], "pending")
            self.assertNotIn(request_id, sess.permission_decisions)
        finally:
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(sess.id)

    def test_permission_handler_rejects_non_string_decision_without_resolving_request(self):
        sess = desktop_bridge.manager.create_session(cwd=".")
        request_id = "perm-test"
        sess.permission_requests[request_id] = {"status": "pending"}
        try:
            with self.assertRaises(web.HTTPBadRequest):
                asyncio.run(permission_handler(JsonRequest({"decision": 1}, {"sid": sess.id, "rid": request_id})))

            self.assertEqual(sess.permission_requests[request_id]["status"], "pending")
            self.assertNotIn(request_id, sess.permission_decisions)
        finally:
            with contextlib.suppress(Exception):
                desktop_bridge.manager.delete_session(sess.id)

    def test_cancel_idle_session_is_noop(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".")

        result = manager.cancel(sess.id)

        self.assertTrue(result["ok"])
        self.assertFalse(result["cancelled"])
        self.assertEqual(result["status"], "idle")
        self.assertEqual(sess.status, "idle")
        self.assertFalse(sess.cancel_requested)

    def test_cancel_running_session_marks_cancelled(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".")
        sess.status = "running"
        sess.partial = {"id": 1, "role": "assistant", "content": "", "partial": True}

        result = manager.cancel(sess.id)

        self.assertTrue(result["ok"])
        self.assertTrue(result["cancelled"])
        self.assertEqual(result["status"], "cancelled")
        self.assertEqual(sess.status, "cancelled")
        self.assertIsNone(sess.partial)
        self.assertTrue(sess.cancel_requested)

    def test_reset_runtime_releases_running_session(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".")
        sess.status = "running"
        sess.partial = {"id": 1, "role": "assistant", "content": "stuck", "partial": True}
        sess.turn_generation = 1
        sess.active_turn_id = 1

        class Agent:
            abort_called = False

            def abort(self):
                self.abort_called = True

        agent = Agent()
        sess.agent = agent

        result = manager.reset_session_runtime(sess.id)

        self.assertTrue(result["ok"])
        self.assertTrue(result["runtimeReset"])
        self.assertTrue(result["wasRunning"])
        self.assertEqual(sess.status, "idle")
        self.assertIsNone(sess.partial)
        self.assertTrue(sess.cancel_requested)
        self.assertEqual(sess.active_turn_id, 0)
        self.assertTrue(agent.abort_called)
        self.assertIsNone(sess.agent)

    def test_submit_prompt_assigns_current_turn_generation(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".")

        with patch.object(manager, "run_agent_turn", return_value=None):
            result = manager.submit_prompt(sess.id, "hi")
            sess.thread.join(1)

        self.assertTrue(result["ok"])
        self.assertEqual(sess.turn_generation, 1)
        self.assertEqual(sess.active_turn_id, 1)

    def test_submit_prompt_force_replaces_stuck_turn_without_dropping_history(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".")
        first_message = manager.add_message(sess, "user", "first")
        sess.status = "running"
        sess.partial = {"id": 2, "role": "assistant", "content": "stuck", "partial": True}
        sess.turn_generation = 1
        sess.active_turn_id = 1

        class Agent:
            abort_called = False

            def abort(self):
                self.abort_called = True

        old_agent = Agent()
        sess.agent = old_agent

        with patch.object(manager, "run_agent_turn", return_value=None):
            result = manager.submit_prompt(sess.id, "second", force=True)
            sess.thread.join(1)

        self.assertTrue(result["ok"])
        self.assertTrue(result["interrupted"])
        self.assertEqual(sess.status, "running")
        self.assertEqual(sess.active_turn_id, 3)
        self.assertEqual(sess.messages[0], first_message)
        self.assertEqual(sess.messages[-1]["role"], "user")
        self.assertEqual(sess.messages[-1]["content"], "second")
        self.assertTrue(old_agent.abort_called)
        self.assertIsNone(sess.agent)

    def test_stale_agent_turn_does_not_overwrite_current_session_state(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".")
        sess.status = "running"
        sess.turn_generation = 2
        sess.active_turn_id = 2
        sess.partial = {"id": 4, "role": "assistant", "content": "current", "partial": True}

        class Agent:
            inc_out = True
            is_running = False

            def put_task(self, prompt, images=None):
                q = queue.Queue()
                q.put({"done": "stale answer"})
                return q

        sess.agent = Agent()

        manager.run_agent_turn(sess, "old", turn_id=1)

        self.assertEqual(sess.status, "running")
        self.assertEqual(sess.active_turn_id, 2)
        self.assertEqual(sess.partial["content"], "current")
        self.assertNotEqual(sess.messages[-1]["role"] if sess.messages else None, "assistant")

    def test_run_agent_turn_finishes_when_agent_stops_without_done_event(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".")
        sess.status = "running"
        sess.partial = {"id": 1, "role": "assistant", "content": "", "partial": True}

        class Agent:
            inc_out = True
            is_running = False

            def put_task(self, prompt, images=None):
                q = queue.Queue()
                q.put({"next": "partial answer"})
                return q

        sess.agent = Agent()

        thread = threading.Thread(target=manager.run_agent_turn, args=(sess, "hi"), daemon=True)
        thread.start()
        thread.join(1.5)

        self.assertFalse(thread.is_alive())
        self.assertEqual(sess.status, "idle")
        self.assertIsNone(sess.partial)
        self.assertEqual(sess.messages[-1]["role"], "assistant")
        self.assertEqual(sess.messages[-1]["content"], "partial answer")

    def test_run_agent_turn_errors_when_first_output_times_out(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".")
        sess.status = "running"
        sess.partial = {"id": 1, "role": "assistant", "content": "", "partial": True}

        class Agent:
            inc_out = True
            is_running = True
            abort_called = False

            def abort(self):
                self.abort_called = True

            def put_task(self, prompt, images=None):
                return queue.Queue()

        agent = Agent()
        sess.agent = agent

        with patch.object(desktop_bridge, "AGENT_FIRST_OUTPUT_TIMEOUT_SECONDS", 1):
            manager.run_agent_turn(sess, "hi")

        self.assertEqual(sess.status, "error")
        self.assertIsNone(sess.partial)
        self.assertTrue(sess.agent_poisoned)
        self.assertIsNone(sess.agent)
        self.assertTrue(agent.abort_called)
        self.assertIn("模型首个输出超时", sess.last_error)
        self.assertIn("API Base", sess.last_error)
        self.assertEqual(sess.messages[-1]["role"], "error")
        self.assertIn("模型首个输出超时", sess.messages[-1]["content"])

    def test_run_agent_turn_restarts_after_output_idle_timeout_and_continues(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".")
        sess.status = "running"
        sess.partial = {"id": 1, "role": "assistant", "content": "", "partial": True}

        class FirstAgent:
            inc_out = True
            is_running = True
            abort_called = False

            def abort(self):
                self.abort_called = True

            def put_task(self, prompt, images=None):
                q = queue.Queue()
                q.put({"next": "partial answer"})
                return q

        class RetryAgent:
            inc_out = True
            is_running = False
            prompt = ""

            def put_task(self, prompt, images=None):
                self.prompt = prompt
                q = queue.Queue()
                q.put({"done": " continued"})
                return q

        first_agent = FirstAgent()
        retry_agent = RetryAgent()
        sess.agent = first_agent

        with patch.object(desktop_bridge, "AGENT_OUTPUT_IDLE_TIMEOUT_SECONDS", 1), \
             patch.object(manager, "make_agent", return_value=retry_agent):
            manager.run_agent_turn(sess, "hi")

        self.assertEqual(sess.status, "idle")
        self.assertIsNone(sess.partial)
        self.assertFalse(sess.agent_poisoned)
        self.assertIs(sess.agent, retry_agent)
        self.assertTrue(first_agent.abort_called)
        self.assertEqual(sess.last_error, "")
        self.assertEqual(sess.messages[-1]["role"], "assistant")
        self.assertEqual(sess.messages[-1]["content"], "partial answer continued")
        self.assertIn("继续完成原任务", retry_agent.prompt)
        self.assertIn("partial answer", retry_agent.prompt)

    def test_agent_timeouts_prefer_desktop_config_over_module_defaults(self):
        manager = AgentManager()
        manager.config["agentFirstOutputTimeoutSeconds"] = 7
        manager.config["agentOutputIdleTimeoutSeconds"] = 11

        with patch.object(desktop_bridge, "AGENT_FIRST_OUTPUT_TIMEOUT_SECONDS", 120), \
             patch.object(desktop_bridge, "AGENT_OUTPUT_IDLE_TIMEOUT_SECONDS", 180):
            self.assertEqual(manager.agent_first_output_timeout_seconds(), 7)
            self.assertEqual(manager.agent_output_idle_timeout_seconds(), 11)

    def test_model_switch_resets_poisoned_session_runtime(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".")

        class Agent:
            next_llm_called = False
            abort_called = False

            def next_llm(self, llm_no):
                self.next_llm_called = True

            def abort(self):
                self.abort_called = True

        agent = Agent()
        sess.agent = agent
        sess.agent_poisoned = True

        result = manager.set_session_model(sess.id, 2)

        self.assertEqual(result["llmNo"], 2)
        self.assertTrue(result["runtimeReset"])
        self.assertFalse(agent.next_llm_called)
        self.assertTrue(agent.abort_called)
        self.assertFalse(sess.agent_poisoned)
        self.assertIsNone(sess.agent)

    def test_model_switch_to_same_llm_reloads_existing_agent(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".", llm_no=2)

        class Agent:
            def __init__(self):
                self.next_llm_calls = []

            def next_llm(self, llm_no):
                self.next_llm_calls.append(llm_no)

        agent = Agent()
        sess.agent = agent

        result = manager.set_session_model(sess.id, 2)

        self.assertEqual(result["llmNo"], 2)
        self.assertFalse(result["runtimeReset"])
        self.assertEqual(agent.next_llm_calls, [2])

    def test_model_switch_while_running_resets_runtime_without_dropping_context(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".")
        first_message = manager.add_message(sess, "user", "keep this context")
        sess.status = "running"
        sess.partial = {"id": 2, "role": "assistant", "content": "stuck", "partial": True}
        sess.turn_generation = 1
        sess.active_turn_id = 1

        class Agent:
            abort_called = False
            next_llm_called = False

            def abort(self):
                self.abort_called = True

            def next_llm(self, llm_no):
                self.next_llm_called = True

        agent = Agent()
        sess.agent = agent

        result = manager.set_session_model(sess.id, 3)

        self.assertEqual(result["llmNo"], 3)
        self.assertTrue(result["runtimeReset"])
        self.assertTrue(result["wasRunning"])
        self.assertEqual(sess.llm_no, 3)
        self.assertEqual(sess.status, "idle")
        self.assertIsNone(sess.partial)
        self.assertEqual(sess.active_turn_id, 0)
        self.assertTrue(sess.cancel_requested)
        self.assertTrue(agent.abort_called)
        self.assertFalse(agent.next_llm_called)
        self.assertEqual(sess.messages[0], first_message)
        self.assertIsNone(sess.agent)

    def test_next_turn_recreates_agent_after_poisoned_runtime_reset(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".")
        sess.status = "running"
        sess.partial = {"id": 1, "role": "assistant", "content": "", "partial": True}
        made = []

        class Agent:
            inc_out = True
            is_running = False

            def put_task(self, prompt, images=None):
                q = queue.Queue()
                q.put({"done": "new runtime ok"})
                return q

        def make_agent(session):
            agent = Agent()
            made.append(agent)
            return agent

        sess.agent = None
        sess.agent_poisoned = True

        with patch.object(manager, "make_agent", make_agent):
            manager.run_agent_turn(sess, "hi")

        self.assertEqual(len(made), 1)
        self.assertFalse(sess.agent_poisoned)
        self.assertIs(sess.agent, made[0])
        self.assertEqual(sess.status, "idle")
        self.assertEqual(sess.messages[-1]["content"], "new runtime ok")

    def test_cancel_session_resolves_pending_permission_message(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".")
        request_id = "perm-test"
        event = threading.Event()
        sess.permission_requests[request_id] = {"status": "pending"}
        sess.permission_events[request_id] = event
        msg = manager.add_message(sess, "permission", "需要权限确认", request_id=request_id, status="pending")

        result = manager.cancel(sess.id)

        self.assertTrue(result["cancelled"])
        self.assertTrue(event.is_set())
        self.assertEqual(sess.permission_requests[request_id]["status"], "resolved")
        self.assertEqual(sess.permission_requests[request_id]["decision"], "deny")
        self.assertEqual(sess.permission_decisions[request_id], "deny")
        self.assertEqual(msg["status"], "resolved")
        self.assertEqual(msg["decision"], "deny")
        self.assertEqual(msg["decision_label"], "已拒绝")

    def test_delete_running_session_marks_closed_and_aborts_agent(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".")
        sess.status = "running"
        sess.partial = {"id": 1, "role": "assistant", "content": "", "partial": True}

        class Agent:
            aborted = False

            def abort(self):
                self.aborted = True

        sess.agent = Agent()

        result = manager.delete_session(sess.id)

        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "closed")
        self.assertEqual(sess.status, "closed")
        self.assertIsNone(sess.partial)
        self.assertTrue(sess.cancel_requested)
        self.assertTrue(sess.agent.aborted)
        self.assertNotIn(sess.id, manager.sessions)

    def test_delete_session_wakes_permission_waiters(self):
        manager = AgentManager()
        sess = manager.create_session(cwd=".")
        event = threading.Event()
        request_id = "perm-test"
        sess.permission_requests[request_id] = {"status": "pending"}
        sess.permission_events[request_id] = event
        msg = manager.add_message(sess, "permission", "需要权限确认", request_id=request_id, status="pending")

        manager.delete_session(sess.id)

        self.assertTrue(event.is_set())
        self.assertEqual(sess.permission_requests[request_id]["status"], "resolved")
        self.assertEqual(sess.permission_requests[request_id]["decision"], "deny")
        self.assertEqual(sess.permission_decisions[request_id], "deny")
        self.assertEqual(msg["status"], "resolved")
        self.assertEqual(msg["decision"], "deny")
        self.assertEqual(msg["decision_label"], "已拒绝")

    def test_save_config_rejects_non_object_json_without_clearing_existing_config(self):
        old_root = desktop_bridge.manager.project_root
        old_config = dict(desktop_bridge.manager.config)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            try:
                desktop_bridge.manager.project_root = root
                desktop_bridge.manager.save_config({"theme": "white"})

                with self.assertRaises(web.HTTPBadRequest):
                    asyncio.run(save_config_handler(ListJsonRequest()))

                reloaded = AgentManager(project_root=root)
            finally:
                desktop_bridge.manager.project_root = old_root
                desktop_bridge.manager.config = old_config

        self.assertEqual(reloaded.config, {"theme": "white"})

    def test_save_config_rejects_nested_non_object_config_without_clearing_existing_config(self):
        old_root = desktop_bridge.manager.project_root
        old_config = dict(desktop_bridge.manager.config)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            try:
                desktop_bridge.manager.project_root = root
                desktop_bridge.manager.save_config({"theme": "white"})

                with self.assertRaises(web.HTTPBadRequest):
                    asyncio.run(save_config_handler(JsonRequest({"config": []})))

                reloaded = AgentManager(project_root=root)
            finally:
                desktop_bridge.manager.project_root = old_root
                desktop_bridge.manager.config = old_config

        self.assertEqual(reloaded.config, {"theme": "white"})

    def test_save_api_config_rejects_nested_non_object_config_without_overwriting_mykey(self):
        old_root = desktop_bridge.manager.project_root
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            mykey = root / "mykey.py"
            root.mkdir(parents=True)
            mykey.write_text("llm_api = {'name': 'old'}\n", encoding="utf-8")
            try:
                desktop_bridge.manager.project_root = root

                with self.assertRaises(web.HTTPBadRequest):
                    asyncio.run(save_api_config_handler(JsonRequest({"config": []})))
            finally:
                desktop_bridge.manager.project_root = old_root

            self.assertEqual(mykey.read_text(encoding="utf-8"), "llm_api = {'name': 'old'}\n")

    def test_delete_api_config_handler_removes_profile_and_returns_safe_config(self):
        old_root = desktop_bridge.manager.project_root
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            try:
                desktop_bridge.manager.project_root = root
                asyncio.run(save_api_config_handler(JsonRequest({
                    "config": {
                        "name": "openai",
                        "type": "native_oai",
                        "apikey": "sk-openai",
                        "apibase": "https://api.openai.example/v1",
                        "model": "gpt-test",
                    }
                })))
                asyncio.run(save_api_config_handler(JsonRequest({
                    "config": {
                        "name": "anthropic",
                        "type": "native_anthropic",
                        "apikey": "sk-anthropic",
                        "apibase": "https://api.anthropic.example",
                        "model": "claude-test",
                    }
                })))

                response = asyncio.run(delete_api_config_handler(JsonRequest({}, {"name": "anthropic"})))
                payload = json_response_payload(response)
            finally:
                desktop_bridge.manager.project_root = old_root

        self.assertTrue(payload["ok"])
        self.assertEqual([profile["name"] for profile in payload["profiles"]], ["openai"])
        self.assertNotIn("sk-anthropic", json.dumps(payload, ensure_ascii=False))

    def test_fetch_api_models_handler_returns_models_without_saving_key(self):
        old_fetch = desktop_bridge.fetch_api_models
        calls = []

        async def fake_fetch(config):
            calls.append(config)
            return [{"id": "gpt-test", "name": "gpt-test"}]

        try:
            desktop_bridge.fetch_api_models = fake_fetch
            response = asyncio.run(fetch_api_models_handler(JsonRequest({
                "config": {
                    "type": "native_oai",
                    "apikey": "sk-secret",
                    "apibase": "https://api.example.com/v1",
                }
            })))
            payload = json_response_payload(response)
        finally:
            desktop_bridge.fetch_api_models = old_fetch

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["models"], [{"id": "gpt-test", "name": "gpt-test"}])
        self.assertEqual(calls[0]["apikey"], "sk-secret")

    def test_fetch_api_models_handler_uses_saved_api_key_when_form_key_is_blank(self):
        old_root = desktop_bridge.manager.project_root
        old_fetch = desktop_bridge.fetch_api_models
        calls = []

        async def fake_fetch(config):
            calls.append(config)
            return [{"id": "gpt-saved", "name": "gpt-saved"}]

        try:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                desktop_bridge.manager.project_root = str(root)
                save_api_config(root, {
                    "type": "native_oai",
                    "name": "saved-openai",
                    "apikey": "sk-saved",
                    "apibase": "https://api.example.com/v1",
                    "model": "gpt-old",
                })
                desktop_bridge.fetch_api_models = fake_fetch

                response = asyncio.run(fetch_api_models_handler(JsonRequest({
                    "config": {
                        "type": "native_oai",
                        "name": "saved-openai",
                        "apikey": "",
                        "apibase": "https://api.example.com/v1",
                    }
                })))
                payload = json_response_payload(response)
        finally:
            desktop_bridge.fetch_api_models = old_fetch
            desktop_bridge.manager.project_root = old_root

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["models"], [{"id": "gpt-saved", "name": "gpt-saved"}])
        self.assertEqual(calls[0]["apikey"], "sk-saved")
        self.assertEqual(calls[0]["name"], "saved-openai")

    def test_parse_api_models_payload_supports_openai_and_anthropic_shapes(self):
        models = desktop_bridge.parse_api_models_payload({
            "data": [
                {"id": "gpt-a"},
                {"id": "claude-a", "display_name": "Claude A"},
                "raw-model",
            ]
        })

        self.assertEqual(
            models,
            [
                {"id": "gpt-a", "name": "gpt-a"},
                {"id": "claude-a", "name": "Claude A"},
                {"id": "raw-model", "name": "raw-model"},
            ],
        )

    def test_fetch_api_models_calls_models_endpoint_with_api_key(self):
        seen = {}

        async def run_case():
            async def models_handler(request):
                seen["path"] = request.path
                seen["auth"] = request.headers.get("Authorization")
                return web.json_response({"data": [{"id": "gpt-local"}]})

            app = web.Application()
            app.router.add_get("/v1/models", models_handler)
            runner = web.AppRunner(app)
            await runner.setup()
            site = web.TCPSite(runner, "127.0.0.1", 0)
            await site.start()
            port = site._server.sockets[0].getsockname()[1]
            try:
                return await desktop_bridge.fetch_api_models({
                    "type": "native_oai",
                    "apikey": "sk-local",
                    "apibase": f"http://127.0.0.1:{port}/v1",
                })
            finally:
                await runner.cleanup()

        models = asyncio.run(run_case())

        self.assertEqual(models, [{"id": "gpt-local", "name": "gpt-local"}])
        self.assertEqual(seen["path"], "/v1/models")
        self.assertEqual(seen["auth"], "Bearer sk-local")

    def test_test_api_response_calls_chat_completion_endpoint(self):
        seen = {}

        async def run_case():
            async def completions_handler(request):
                body = await request.json()
                seen["path"] = request.path
                seen["auth"] = request.headers.get("Authorization")
                seen["body"] = body
                return web.json_response({
                    "choices": [
                        {"message": {"content": "OK"}}
                    ],
                    "model": body.get("model"),
                })

            app = web.Application()
            app.router.add_post("/v1/chat/completions", completions_handler)
            runner = web.AppRunner(app)
            await runner.setup()
            site = web.TCPSite(runner, "127.0.0.1", 0)
            await site.start()
            port = site._server.sockets[0].getsockname()[1]
            try:
                return await desktop_bridge.test_api_response({
                    "type": "native_oai",
                    "apikey": "sk-local",
                    "apibase": f"http://127.0.0.1:{port}/v1",
                    "model": "gpt-local",
                    "api_mode": "chat_completions",
                })
            finally:
                await runner.cleanup()

        result = asyncio.run(run_case())

        self.assertTrue(result["ok"])
        self.assertEqual(result["model"], "gpt-local")
        self.assertEqual(result["text"], "OK")
        self.assertGreaterEqual(result["elapsedMs"], 0)
        self.assertEqual(seen["path"], "/v1/chat/completions")
        self.assertEqual(seen["auth"], "Bearer sk-local")
        self.assertEqual(seen["body"]["messages"][-1]["content"], "只回复 OK，用于测试 API 是否可用。")

    def test_test_api_config_handler_uses_saved_api_key_when_form_key_is_blank(self):
        old_root = desktop_bridge.manager.project_root
        old_test = desktop_bridge.test_api_response
        calls = []

        async def fake_test(config):
            calls.append(config)
            return {"ok": True, "model": config["model"], "text": "OK", "elapsedMs": 1}

        try:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                desktop_bridge.manager.project_root = str(root)
                save_api_config(root, {
                    "type": "native_oai",
                    "name": "saved-openai",
                    "apikey": "sk-saved",
                    "apibase": "https://api.example.com/v1",
                    "model": "gpt-saved",
                })
                desktop_bridge.test_api_response = fake_test

                response = asyncio.run(desktop_bridge.test_api_config_handler(JsonRequest({
                    "config": {
                        "type": "native_oai",
                        "name": "saved-openai",
                        "apikey": "",
                        "apibase": "https://api.example.com/v1",
                        "model": "gpt-saved",
                    }
                })))
                payload = json_response_payload(response)
        finally:
            desktop_bridge.test_api_response = old_test
            desktop_bridge.manager.project_root = old_root

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["text"], "OK")
        self.assertEqual(calls[0]["apikey"], "sk-saved")
        self.assertEqual(calls[0]["name"], "saved-openai")

    def test_agent_output_idle_timeout_default_is_600_seconds(self):
        manager = AgentManager()

        self.assertEqual(desktop_bridge.AGENT_OUTPUT_IDLE_TIMEOUT_SECONDS, 600)
        self.assertEqual(manager.agent_output_idle_timeout_seconds(), 600)

    def test_save_mcp_config_handler_writes_project_mcp_config_and_returns_registry(self):
        old_root = desktop_bridge.manager.project_root
        old_config = dict(desktop_bridge.manager.config)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            try:
                desktop_bridge.manager.project_root = root

                response = asyncio.run(save_mcp_config_handler(JsonRequest({
                    "config": {"name": "fs", "command": "python", "args": "-m server"}
                })))
                payload = json_response_payload(response)
                config_exists = (root / ".secheur-agent" / "mcp.json").is_file()
            finally:
                desktop_bridge.manager.project_root = old_root
                desktop_bridge.manager.config = old_config

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["saved"]["name"], "fs")
        self.assertIn("fs", [item["name"] for item in payload["mcpServers"]])
        self.assertTrue(config_exists)

    def test_save_mcp_config_rejects_nested_non_object_config_without_writing_file(self):
        old_root = desktop_bridge.manager.project_root
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            try:
                desktop_bridge.manager.project_root = root

                with self.assertRaises(web.HTTPBadRequest):
                    asyncio.run(save_mcp_config_handler(JsonRequest({"config": []})))
            finally:
                desktop_bridge.manager.project_root = old_root

        self.assertFalse((root / ".secheur-agent" / "mcp.json").exists())

    def test_save_skill_config_handler_writes_project_skill_and_returns_registry(self):
        old_root = desktop_bridge.manager.project_root
        old_config = dict(desktop_bridge.manager.config)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            try:
                desktop_bridge.manager.project_root = root

                response = asyncio.run(save_skill_config_handler(JsonRequest({
                    "config": {"name": "audit", "description": "Audit", "context": "inline", "body": "Audit $ARGUMENTS."}
                })))
                payload = json_response_payload(response)
                skill_exists = (root / ".secheur-agent" / "skills" / "audit" / "SKILL.md").is_file()
            finally:
                desktop_bridge.manager.project_root = old_root
                desktop_bridge.manager.config = old_config

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["saved"]["name"], "audit")
        self.assertIn("audit", [item["name"] for item in payload["skills"]])
        self.assertTrue(skill_exists)

    def test_save_agent_config_handler_writes_project_agent_and_returns_registry(self):
        old_root = desktop_bridge.manager.project_root
        old_config = dict(desktop_bridge.manager.config)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            try:
                desktop_bridge.manager.project_root = root

                response = asyncio.run(save_agent_config_handler(JsonRequest({
                    "config": {
                        "name": "audit-agent",
                        "description": "Audit",
                        "allowedTools": "file_read,grep_search",
                        "body": "Audit $TASK.",
                    }
                })))
                payload = json_response_payload(response)
                agent_exists = (root / ".secheur-agent" / "agents" / "audit-agent.md").is_file()
            finally:
                desktop_bridge.manager.project_root = old_root
                desktop_bridge.manager.config = old_config

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["saved"]["name"], "audit-agent")
        self.assertIn("audit-agent", [item["name"] for item in payload["agents"]])
        self.assertTrue(agent_exists)

    def test_delete_project_resource_handlers_remove_project_owned_entries(self):
        old_root = desktop_bridge.manager.project_root
        old_config = dict(desktop_bridge.manager.config)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            try:
                desktop_bridge.manager.project_root = root

                asyncio.run(save_mcp_config_handler(JsonRequest({
                    "config": {"name": "fs", "command": "python"}
                })))
                asyncio.run(save_skill_config_handler(JsonRequest({
                    "config": {"name": "audit", "body": "Audit $ARGUMENTS."}
                })))
                asyncio.run(save_agent_config_handler(JsonRequest({
                    "config": {"name": "audit-agent", "body": "Audit $TASK."}
                })))

                mcp_response = asyncio.run(delete_mcp_config_handler(JsonRequest({}, {"name": "fs"})))
                skill_response = asyncio.run(delete_skill_config_handler(JsonRequest({}, {"name": "audit"})))
                agent_response = asyncio.run(delete_agent_config_handler(JsonRequest({}, {"name": "audit-agent"})))

                mcp_payload = json_response_payload(mcp_response)
                skill_payload = json_response_payload(skill_response)
                agent_payload = json_response_payload(agent_response)
            finally:
                desktop_bridge.manager.project_root = old_root
                desktop_bridge.manager.config = old_config

        self.assertTrue(mcp_payload["ok"])
        self.assertTrue(skill_payload["ok"])
        self.assertTrue(agent_payload["ok"])
        self.assertNotIn("fs", [item["name"] for item in mcp_payload["mcpServers"]])
        self.assertNotIn("audit", [item["name"] for item in skill_payload["skills"]])
        self.assertNotIn("audit-agent", [item["name"] for item in agent_payload["agents"]])

    def test_save_skill_config_rejects_nested_non_object_config_without_writing_file(self):
        old_root = desktop_bridge.manager.project_root
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            try:
                desktop_bridge.manager.project_root = root

                with self.assertRaises(web.HTTPBadRequest):
                    asyncio.run(save_skill_config_handler(JsonRequest({"config": []})))
            finally:
                desktop_bridge.manager.project_root = old_root

        self.assertFalse((root / ".secheur-agent" / "skills").exists())

    def test_save_agent_config_rejects_nested_non_object_config_without_writing_file(self):
        old_root = desktop_bridge.manager.project_root
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            try:
                desktop_bridge.manager.project_root = root

                with self.assertRaises(web.HTTPBadRequest):
                    asyncio.run(save_agent_config_handler(JsonRequest({"config": []})))
            finally:
                desktop_bridge.manager.project_root = old_root

        self.assertFalse((root / ".secheur-agent" / "agents").exists())

    def test_save_registry_rejects_non_object_registry_sections_without_writing_state(self):
        old_root = desktop_bridge.manager.project_root
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            try:
                desktop_bridge.manager.project_root = root

                with self.assertRaises(web.HTTPBadRequest):
                    asyncio.run(save_registry_handler(JsonRequest({"tools": []})))
                with self.assertRaises(web.HTTPBadRequest):
                    asyncio.run(save_registry_handler(JsonRequest({"agents": []})))
            finally:
                desktop_bridge.manager.project_root = old_root

            self.assertFalse((root / ".secheur-agent" / "settings.json").exists())

    def test_save_registry_accepts_agent_enabled_state(self):
        old_root = desktop_bridge.manager.project_root
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            try:
                desktop_bridge.manager.project_root = root

                response = asyncio.run(save_registry_handler(JsonRequest({"agents": {"reviewer": False}})))
                payload = json_response_payload(response)
            finally:
                desktop_bridge.manager.project_root = old_root

        self.assertTrue(payload["ok"])
        reviewer = next(item for item in payload["agents"] if item["name"] == "reviewer")
        self.assertFalse(reviewer["enabled"])

    def test_save_config_rejects_missing_json_body_without_clearing_existing_config(self):
        old_root = desktop_bridge.manager.project_root
        old_config = dict(desktop_bridge.manager.config)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            try:
                desktop_bridge.manager.project_root = root
                desktop_bridge.manager.save_config({"theme": "white"})

                with self.assertRaises(web.HTTPBadRequest):
                    asyncio.run(save_config_handler(NoBodyRequest()))

                reloaded = AgentManager(project_root=root)
            finally:
                desktop_bridge.manager.project_root = old_root
                desktop_bridge.manager.config = old_config

        self.assertEqual(reloaded.config, {"theme": "white"})


if __name__ == "__main__":
    unittest.main()
