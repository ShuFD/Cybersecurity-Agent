import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import secheur_pi_bridge


class PiSchedulerBridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.reflect = self.root / "reflect"
        self.reflect.mkdir()
        (self.root / "sche_tasks").mkdir()
        secheur_pi_bridge._scheduler_module = None
        secheur_pi_bridge._scheduler_path = None
        secheur_pi_bridge._scheduler_mtime_ns = None
        self.parent = SimpleNamespace(project_root=str(self.root))

    def tearDown(self):
        secheur_pi_bridge._scheduler_module = None
        secheur_pi_bridge._scheduler_path = None
        secheur_pi_bridge._scheduler_mtime_ns = None
        self.tmp.cleanup()

    def write_scheduler(self, label):
        path = self.reflect / "scheduler.py"
        path.write_text(
            "from pathlib import Path\n"
            "INTERVAL = 1\n"
            "TASKS = 'wrong'\n"
            "DONE = 'wrong'\n"
            "PENDING = 'wrong'\n"
            f"def check(): return '{label}|' + TASKS + '|' + DONE + '|' + PENDING\n"
            "def on_done(result): return [result]\n",
            encoding="utf-8",
        )
        return path

    def test_internal_calls_redirect_paths_and_clamp_interval(self):
        self.write_scheduler("v1")

        checked = secheur_pi_bridge._dispatch_internal(self.parent, "__scheduler_check", {})
        completed = secheur_pi_bridge._dispatch_internal(
            self.parent,
            "__scheduler_done",
            {"result": "报告已完成"},
        )

        task_root = self.root / "sche_tasks"
        self.assertEqual(checked.data["interval"], 5)
        self.assertEqual(
            checked.data["task"],
            f"v1|{task_root}|{task_root / 'done'}|{task_root / 'pending'}",
        )
        self.assertEqual(secheur_pi_bridge._scheduler_module._LOG, str(task_root / "scheduler.log"))
        self.assertEqual(completed.data, {"written": ["报告已完成"]})

    def test_scheduler_source_is_reloaded_after_its_mtime_changes(self):
        path = self.write_scheduler("v1")
        first = secheur_pi_bridge._dispatch_internal(self.parent, "__scheduler_check", {})
        first_mtime = path.stat().st_mtime_ns
        self.write_scheduler("v2")
        os.utime(path, ns=(first_mtime + 1_000_000, first_mtime + 1_000_000))

        second = secheur_pi_bridge._dispatch_internal(self.parent, "__scheduler_check", {})

        self.assertTrue(first.data["task"].startswith("v1|"))
        self.assertTrue(second.data["task"].startswith("v2|"))


if __name__ == "__main__":
    unittest.main()
