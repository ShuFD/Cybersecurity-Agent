import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from background_tasks import get_background_task, start_background_task


class BackgroundTaskStorageTests(unittest.TestCase):
    def test_private_storage_keeps_command_cwd(self):
        with tempfile.TemporaryDirectory() as root:
            cwd = Path(root) / "workspace"
            cwd.mkdir()
            storage = Path(root) / "state"
            blocked = Path(root) / "blocked"
            blocked.write_text("not a directory")
            with patch.dict(os.environ, {"SECHEUR_COMMAND_TASK_OUTPUT_DIR": str(storage)}):
                task = start_background_task([sys.executable, "-c", "import os; print(os.getcwd())"], cwd, blocked)
                for _ in range(100):
                    result = get_background_task(task.task_id)
                    if result["status"] != "running":
                        break
                    time.sleep(0.01)
                self.assertEqual(result["status"], "completed")
                self.assertEqual(Path(task.output_path).parent, storage)
                self.assertEqual(Path(task.output_path).read_text().strip(), str(cwd))
                self.assertEqual(list(cwd.iterdir()), [])

    def test_creation_failure_cleans_temporary_script(self):
        with tempfile.TemporaryDirectory() as root:
            blocked = Path(root) / "blocked"
            blocked.write_text("not a directory")
            script = Path(root) / "temporary-script.py"
            script.write_text("print('unused')")
            with patch.dict(os.environ, {"SECHEUR_COMMAND_TASK_OUTPUT_DIR": str(blocked / "tasks")}):
                with self.assertRaises(OSError):
                    start_background_task([sys.executable, str(script)], root, root, tmp_path=script)
            self.assertFalse(script.exists())


if __name__ == "__main__":
    unittest.main()
