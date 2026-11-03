import json
import tempfile
import threading
import unittest
from datetime import datetime as RealDateTime
from pathlib import Path
from types import SimpleNamespace

from reflect import scheduler
from frontends import desktop_bridge


class FixedDateTime(RealDateTime):
    fixed_now = RealDateTime(2026, 6, 4, 16, 52)

    @classmethod
    def now(cls):
        return cls.fixed_now


class SchedulerRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.old_state = {
            "TASKS": scheduler.TASKS,
            "DONE": scheduler.DONE,
            "PENDING": getattr(scheduler, "PENDING", None),
            "datetime": scheduler.datetime,
            "_l4_t": scheduler._l4_t,
            "_active_tid": getattr(scheduler, "_active_tid", None),
        }
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.tasks = root / "sche_tasks"
        self.done = self.tasks / "done"
        self.pending = self.tasks / "pending"
        self.tasks.mkdir()
        self.done.mkdir()
        scheduler.TASKS = str(self.tasks)
        scheduler.DONE = str(self.done)
        scheduler.PENDING = str(self.pending)
        scheduler.datetime = FixedDateTime
        scheduler._l4_t = RealDateTime.now().timestamp()
        scheduler._active_tid = None

    def tearDown(self):
        scheduler.TASKS = self.old_state["TASKS"]
        scheduler.DONE = self.old_state["DONE"]
        if self.old_state["PENDING"] is None:
            del scheduler.PENDING
        else:
            scheduler.PENDING = self.old_state["PENDING"]
        scheduler.datetime = self.old_state["datetime"]
        scheduler._l4_t = self.old_state["_l4_t"]
        scheduler._active_tid = self.old_state["_active_tid"]
        self.tmp.cleanup()

    def write_due_task(self, name="github_trending"):
        (self.tasks / f"{name}.json").write_text(
            json.dumps(
                {
                    "enabled": True,
                    "repeat": "daily",
                    "schedule": "16:52",
                    "max_delay_hours": 6,
                    "prompt": "整理 GitHub Trending。",
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

    def test_due_task_creates_pending_marker_and_does_not_retrigger_before_done(self):
        self.write_due_task()

        first = scheduler.check()
        second = scheduler.check()

        self.assertIn("[定时任务] github_trending", first)
        self.assertTrue((self.pending / "github_trending.json").exists())
        self.assertIsNone(second)

    def test_on_done_writes_report_removes_pending_and_cools_down_task(self):
        self.write_due_task()
        prompt = scheduler.check()

        scheduler.on_done("执行报告内容")
        second = scheduler.check()

        self.assertIn("[报告路径]", prompt)
        reports = list(self.done.glob("*_github_trending.md"))
        self.assertEqual(len(reports), 1)
        self.assertIn("执行报告内容", reports[0].read_text(encoding="utf-8"))
        self.assertFalse((self.pending / "github_trending.json").exists())
        self.assertIsNone(second)


class FakeScheduler:
    INTERVAL = 1

    def __init__(self):
        self.check_calls = 0
        self.done_results = []

    def check(self):
        self.check_calls += 1
        return "[定时任务] demo\n执行测试任务"

    def on_done(self, result):
        self.done_results.append(result)


class FakeManager:
    def __init__(self):
        self.lock = threading.RLock()
        self.project_root = "/tmp/project"
        self.config = {
            "permissionMode": "bypassPermissions",
            "memoryReferenceEnabled": True,
        }
        self.sessions = {}
        self.active_session_id = None
        self.submissions = []

    def create_session(
        self,
        cwd=None,
        llm_no=0,
        permission_mode="default",
        memory_reference_enabled=True,
        title="New chat",
        activate=True,
    ):
        sid = f"sess-{len(self.sessions) + 1}"
        sess = SimpleNamespace(
            id=sid,
            title=title,
            status="idle",
            cwd=cwd,
            llm_no=llm_no,
            permission_mode=permission_mode,
            memory_reference_enabled=memory_reference_enabled,
        )
        self.sessions[sid] = sess
        if activate:
            self.active_session_id = sid
        return sess

    def submit_prompt(self, sid, prompt, images=None, llm_no=None, source="user", done_callback=None):
        self.submissions.append(
            {
                "sid": sid,
                "prompt": prompt,
                "source": source,
                "done_callback": done_callback,
            }
        )
        return {"ok": True}


class DesktopSchedulerBridgeTests(unittest.TestCase):
    def test_tick_submits_due_scheduler_prompt_to_idle_session(self):
        fake_scheduler = FakeScheduler()
        manager = FakeManager()
        poller = desktop_bridge.SchedulerPoller(manager, scheduler_module=fake_scheduler)

        result = poller.tick()
        manager.submissions[0]["done_callback"]("报告已完成")

        self.assertTrue(result["submitted"])
        self.assertEqual(fake_scheduler.check_calls, 1)
        self.assertEqual(manager.submissions[0]["source"], "scheduler")
        self.assertIn("[定时任务] demo", manager.submissions[0]["prompt"])
        self.assertEqual(fake_scheduler.done_results, ["报告已完成"])

    def test_tick_uses_dedicated_scheduler_session_without_stealing_active_session(self):
        fake_scheduler = FakeScheduler()
        manager = FakeManager()
        user_sess = manager.create_session()
        user_sess.title = "用户会话"
        manager.active_session_id = user_sess.id
        poller = desktop_bridge.SchedulerPoller(manager, scheduler_module=fake_scheduler)

        result = poller.tick()

        self.assertTrue(result["submitted"])
        self.assertEqual(manager.active_session_id, user_sess.id)
        self.assertNotEqual(manager.submissions[0]["sid"], user_sess.id)
        scheduler_sess = manager.sessions[manager.submissions[0]["sid"]]
        self.assertEqual(scheduler_sess.title, "定时任务")

    def test_tick_does_not_claim_due_task_when_active_session_is_running(self):
        fake_scheduler = FakeScheduler()
        manager = FakeManager()
        sess = manager.create_session()
        sess.status = "running"
        poller = desktop_bridge.SchedulerPoller(manager, scheduler_module=fake_scheduler)

        result = poller.tick()

        self.assertFalse(result["submitted"])
        self.assertEqual(result["reason"], "busy")
        self.assertEqual(fake_scheduler.check_calls, 0)
        self.assertEqual(manager.submissions, [])


if __name__ == "__main__":
    unittest.main()
