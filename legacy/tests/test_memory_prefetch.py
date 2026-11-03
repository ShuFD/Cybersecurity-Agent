import tempfile
import queue
import sys
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

from agentmain import (
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    SecHeurAgent,
    build_initial_user_content,
    build_memory_prefetch,
    build_task_system_prompt,
    get_system_prompt,
    start_memory_prefetch,
)


class MemoryPrefetchTests(unittest.TestCase):
    def test_build_memory_prefetch_includes_relevant_snippets(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "tmwebdriver_sop.md").write_text(
                "# TMWebDriver\nUse CDP for browser tabs and cross-tab automation.\n",
                encoding="utf-8",
            )
            (root / "other.md").write_text("Spreadsheet export notes.\n", encoding="utf-8")

            prefetch = build_memory_prefetch("cdp browser", memory_dir=root)

        self.assertIn("# Memory Prefetch", prefetch)
        self.assertIn("tmwebdriver_sop.md", prefetch)
        self.assertIn("CDP", prefetch)

    def test_build_memory_prefetch_returns_empty_when_nothing_matches(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "other.md").write_text("Spreadsheet export notes.\n", encoding="utf-8")

            prefetch = build_memory_prefetch("cdp browser", memory_dir=root)

        self.assertEqual(prefetch, "")

    def test_build_memory_prefetch_respects_max_chars(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "long.md").write_text("cdp " + ("x" * 2000), encoding="utf-8")

            prefetch = build_memory_prefetch("cdp", memory_dir=root, max_chars=220)

        self.assertLessEqual(len(prefetch), 220)
        self.assertIn("[truncated]", prefetch)

    def test_task_system_prompt_appends_memory_prefetch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "tmwebdriver_sop.md").write_text(
                "Use CDP for browser tabs and cross-tab automation.\n",
                encoding="utf-8",
            )

            with mock.patch("agentmain.get_system_prompt", return_value="BASE\n"):
                prompt = build_task_system_prompt("Need cdp browser help", memory_dir=root)

        self.assertTrue(prompt.startswith("BASE\n"))
        self.assertIn("# Memory Prefetch", prompt)
        self.assertIn("tmwebdriver_sop.md", prompt)

    def test_system_prompt_places_dynamic_context_after_cache_boundary(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            prompt = get_system_prompt(project_root=root)

        self.assertIn(SYSTEM_PROMPT_DYNAMIC_BOUNDARY, prompt)
        static_part, dynamic_part = prompt.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 1)
        self.assertNotIn("Today:", static_part)
        self.assertIn("Today:", dynamic_part)

    def test_system_prompt_keeps_project_rules_and_skill_metadata_before_cache_boundary(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            rules_dir = root / ".secheur-agent"
            rules_dir.mkdir()
            (rules_dir / "rules").mkdir()
            (rules_dir / "rules" / "main.md").write_text("Use project rule.", encoding="utf-8")
            write_skill_dir = rules_dir / "skills" / "local-skill"
            write_skill_dir.mkdir(parents=True)
            (write_skill_dir / "SKILL.md").write_text(
                "---\nname: local-skill\ndescription: Local skill metadata\n---\nBody should not load.",
                encoding="utf-8",
            )

            prompt = get_system_prompt(project_root=root)

        static_part, dynamic_part = prompt.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 1)
        self.assertIn("Use project rule.", static_part)
        self.assertIn("/local-skill: Local skill metadata", static_part)
        self.assertNotIn("Use project rule.", dynamic_part)
        self.assertNotIn("/local-skill: Local skill metadata", dynamic_part)

    def test_task_system_prompt_uses_prefetched_memory_without_recomputing(self):
        with mock.patch("agentmain.get_system_prompt", return_value="BASE\n"):
            with mock.patch("agentmain.build_memory_prefetch", side_effect=AssertionError("should not recompute")):
                prompt = build_task_system_prompt("query", prefetched_memory="# Memory Prefetch\n- cached")

        self.assertIn("- cached", prompt)

    def test_task_system_prompt_includes_goal_plan_protocol_for_complex_tasks(self):
        with mock.patch("agentmain.get_system_prompt", return_value="BASE\n"):
            prompt = build_task_system_prompt("修复上传文件并验证", prefetched_memory="")

        self.assertIn("目标执行协议", prompt)
        self.assertIn("<goal_plan>", prompt)
        self.assertIn('<item status="pending">', prompt)
        self.assertIn('<item status="running">', prompt)
        self.assertIn('<item status="done">', prompt)
        self.assertIn("简单任务不要拆分", prompt)

    def test_task_system_prompt_includes_resume_slash_commands(self):
        with mock.patch("agentmain.get_system_prompt", return_value="BASE\n"):
            prompt = build_task_system_prompt("继续上次任务", prefetched_memory="")

        self.assertIn("/resume-list", prompt)
        self.assertIn("/resume", prompt)
        self.assertIn("/resume <path>", prompt)
        self.assertIn("恢复最新可用会话", prompt)

    def test_task_system_prompt_includes_harness_engineering_principles(self):
        with mock.patch("agentmain.get_system_prompt", return_value="BASE\n"):
            prompt = build_task_system_prompt("实现复杂功能", prefetched_memory="")

        self.assertIn("Harness 思维", prompt)
        self.assertIn("模型负责判断，harness 负责提供工具、上下文和边界", prompt)
        self.assertIn("保持一个核心 agent loop", prompt)
        self.assertIn("不要用硬编码流程替代模型判断", prompt)
        self.assertIn("知识按需加载", prompt)
        self.assertIn("子 Agent 使用干净上下文", prompt)
        self.assertIn("权限边界先于自由行动", prompt)
        self.assertIn("错误是恢复入口", prompt)
        self.assertNotIn("\n\n\n", prompt)
        self.assertEqual(prompt.count("简单任务不要拆分"), 1)

    def test_task_system_prompt_keeps_stable_protocols_before_cache_boundary(self):
        base = f"STATIC{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}DYNAMIC\n"
        with mock.patch("agentmain.get_system_prompt", return_value=base):
            prompt = build_task_system_prompt("实现复杂功能", prefetched_memory="# Memory Prefetch\n- cached")

        static_part, dynamic_part = prompt.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 1)
        self.assertIn("STATIC", static_part)
        self.assertIn("Harness 思维", static_part)
        self.assertIn("目标执行协议", static_part)
        self.assertIn("DYNAMIC", dynamic_part)
        self.assertIn("# Memory Prefetch", dynamic_part)

    def test_start_memory_prefetch_computes_in_background(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "tmwebdriver_sop.md").write_text("CDP browser setup.\n", encoding="utf-8")

            prefetch = start_memory_prefetch("cdp browser", memory_dir=root)
            text = prefetch.result(timeout=2)

        self.assertIn("# Memory Prefetch", text)
        self.assertIn("tmwebdriver_sop.md", text)

    def test_put_task_attaches_memory_prefetch_handle(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "tmwebdriver_sop.md").write_text("CDP browser setup.\n", encoding="utf-8")
            agent = SecHeurAgent.__new__(SecHeurAgent)
            agent.task_queue = queue.Queue()
            agent.memory_dir = root

            agent.put_task("cdp browser", source="user")
            task = agent.task_queue.get_nowait()
            text = task["memory_prefetch"].result(timeout=2)

        self.assertIn("memory_prefetch", task)
        self.assertIn("tmwebdriver_sop.md", text)

    def test_put_task_skips_memory_prefetch_when_memory_references_disabled(self):
        agent = SecHeurAgent.__new__(SecHeurAgent)
        agent.task_queue = queue.Queue()
        agent.memory_reference_enabled = False

        agent.put_task("cdp browser", source="user")
        task = agent.task_queue.get_nowait()

        self.assertIsNone(task["memory_prefetch"])

    def test_build_initial_user_content_adds_image_tags_as_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "sample.png"
            image_path.write_bytes(b"fake-png")

            content = build_initial_user_content(
                "Long user prompt saved to temp/user_prompt.md. Read and execute.",
                image_tag_text=f"describe this\n[image:{image_path}]",
            )

        self.assertEqual(content[0]["type"], "text")
        self.assertIn("Long user prompt saved", content[0]["text"])
        self.assertEqual(content[1]["type"], "image")
        self.assertEqual(content[1]["source"]["media_type"], "image/png")
        self.assertEqual(content[1]["source"]["data"], "ZmFrZS1wbmc=")


if __name__ == "__main__":
    unittest.main()
