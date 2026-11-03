import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from secheur_core import SecHeurAgentHandler


class DummyParent:
    task_dir = None
    verbose = False


class DummyResponse:
    content = ""


class FileFreshnessTests(unittest.TestCase):
    def _run_generator(self, gen):
        chunks = []
        while True:
            try:
                chunks.append(next(gen))
            except StopIteration as done:
                return "".join(chunks), done.value

    def test_file_patch_requires_prior_read_for_existing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "app.py"
            target.write_text("old\n", encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)

            output, outcome = self._run_generator(
                handler.do_file_patch({"path": "app.py", "old_content": "old\n", "new_content": "new\n"}, DummyResponse())
            )

        self.assertIn("必须先读取文件", output)
        self.assertEqual(outcome.data["status"], "stale_file")

    def test_file_patch_allowed_after_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "app.py"
            target.write_text("old\n", encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)

            self._run_generator(handler.do_file_read({"path": "app.py"}, DummyResponse()))
            output, outcome = self._run_generator(
                handler.do_file_patch({"path": "app.py", "old_content": "old\n", "new_content": "new\n"}, DummyResponse())
            )

            content = target.read_text(encoding="utf-8")

        self.assertIn("文件局部修改成功", output)
        self.assertEqual(outcome.data["status"], "success")
        self.assertEqual(content, "new\n")

    def test_file_read_returns_unchanged_stub_for_repeated_same_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "app.py"
            target.write_text("old\n", encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)

            first_output, first_outcome = self._run_generator(handler.do_file_read({"path": "app.py"}, DummyResponse()))
            second_output, second_outcome = self._run_generator(handler.do_file_read({"path": "app.py"}, DummyResponse()))

        self.assertIn("Reading file", first_output)
        self.assertIn("old", first_outcome.data)
        self.assertIn("内容未变，跳过重复读取", second_output)
        self.assertEqual(second_outcome.data["status"], "unchanged")
        self.assertIn("文件未变化", second_outcome.data["msg"])

    def test_file_read_normalizes_numeric_string_args_for_repeat_detection(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "app.py"
            target.write_text("old\n", encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)

            self._run_generator(handler.do_file_read({"path": "app.py", "start": 1, "count": 200}, DummyResponse()))
            output, outcome = self._run_generator(
                handler.do_file_read({"path": "app.py", "start": "1", "count": "200"}, DummyResponse())
            )

        self.assertIn("内容未变，跳过重复读取", output)
        self.assertEqual(outcome.data["status"], "unchanged")

    def test_file_read_normalizes_keyword_case_for_repeat_detection(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "app.py"
            target.write_text("alpha\nTODO item\nomega\n", encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)

            self._run_generator(handler.do_file_read({"path": "app.py", "keyword": "TODO"}, DummyResponse()))
            output, outcome = self._run_generator(
                handler.do_file_read({"path": "app.py", "keyword": "todo"}, DummyResponse())
            )

        self.assertIn("内容未变，跳过重复读取", output)
        self.assertEqual(outcome.data["status"], "unchanged")

    def test_file_read_force_bypasses_unchanged_stub(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "app.py"
            target.write_text("old\n", encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)

            self._run_generator(handler.do_file_read({"path": "app.py"}, DummyResponse()))
            output, outcome = self._run_generator(handler.do_file_read({"path": "app.py", "force": True}, DummyResponse()))

        self.assertNotIn("跳过重复读取", output)
        self.assertIn("old", outcome.data)

    def test_file_read_state_is_lru_bounded(self):
        with tempfile.TemporaryDirectory() as tmp:
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)
            first = Path(tmp) / "file_000.txt"
            for index in range(105):
                target = Path(tmp) / f"file_{index:03d}.txt"
                target.write_text(f"{index}\n", encoding="utf-8")
                self._run_generator(handler.do_file_read({"path": target.name}, DummyResponse()))

        self.assertLessEqual(len(handler._read_file_state), 100)
        self.assertNotIn(str(first.resolve()), handler._read_file_state)

    def test_file_read_state_refreshes_lru_on_unchanged_stub(self):
        with tempfile.TemporaryDirectory() as tmp:
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)
            handler.MAX_READ_FILE_STATE = 3
            paths = [Path(tmp) / name for name in ("app.py", "other0.py", "other1.py", "other2.py")]
            for path in paths:
                path.write_text(f"{path.name}\n", encoding="utf-8")

            for path in paths[:3]:
                self._run_generator(handler.do_file_read({"path": path.name}, DummyResponse()))

            app_path = os.path.abspath(paths[0])
            self._run_generator(handler.do_file_read({"path": paths[0].name}, DummyResponse()))
            self._run_generator(handler.do_file_read({"path": paths[3].name}, DummyResponse()))

        self.assertIn(app_path, handler._read_file_state)
        self.assertNotIn(os.path.abspath(paths[1]), handler._read_file_state)

    def test_file_read_call_state_refreshes_lru_on_unchanged_stub(self):
        with tempfile.TemporaryDirectory() as tmp:
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)
            handler.MAX_READ_CALL_STATE = 3
            paths = [Path(tmp) / name for name in ("app.py", "other0.py", "other1.py", "other2.py")]
            for path in paths:
                path.write_text(f"{path.name}\n", encoding="utf-8")

            for path in paths[:3]:
                self._run_generator(handler.do_file_read({"path": path.name}, DummyResponse()))

            app_key = (os.path.abspath(paths[0]), 1, 200, None, True)
            self._run_generator(handler.do_file_read({"path": paths[0].name}, DummyResponse()))
            self._run_generator(handler.do_file_read({"path": paths[3].name}, DummyResponse()))

        self.assertIn(app_key, handler._read_call_state)
        self.assertNotIn((os.path.abspath(paths[1]), 1, 200, None, True), handler._read_call_state)

    def test_file_write_blocks_when_file_changed_after_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "app.py"
            target.write_text("old\n", encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)

            self._run_generator(handler.do_file_read({"path": "app.py"}, DummyResponse()))
            time.sleep(0.01)
            target.write_text("changed elsewhere\n", encoding="utf-8")
            output, outcome = self._run_generator(
                handler.do_file_write({"path": "app.py", "content": "new\n"}, DummyResponse())
            )

        self.assertIn("文件已被外部修改", output)
        self.assertEqual(outcome.data["status"], "stale_file")

    def test_file_write_blocks_when_size_changes_even_if_mtime_matches(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "app.py"
            target.write_text("old\n", encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)

            self._run_generator(handler.do_file_read({"path": "app.py"}, DummyResponse()))
            original_mtime = target.stat().st_mtime
            target.write_text("changed elsewhere\n", encoding="utf-8")
            os.utime(target, (original_mtime, original_mtime))
            output, outcome = self._run_generator(
                handler.do_file_write({"path": "app.py", "content": "new\n"}, DummyResponse())
            )

        self.assertIn("文件已被外部修改", output)
        self.assertEqual(outcome.data["status"], "stale_file")

    def test_file_write_blocks_when_content_changes_with_same_mtime_and_size(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "app.py"
            target.write_text("abcd\n", encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)

            self._run_generator(handler.do_file_read({"path": "app.py"}, DummyResponse()))
            remembered = next(iter(handler._read_file_state.values()))
            target.write_text("wxyz\n", encoding="utf-8")
            os.utime(target, ns=(remembered[0], remembered[0]))
            self.assertEqual((target.stat().st_mtime_ns, target.stat().st_size), remembered[:2])
            output, outcome = self._run_generator(
                handler.do_file_write({"path": "app.py", "content": "new\n"}, DummyResponse())
            )

        self.assertIn("文件已被外部修改", output)
        self.assertEqual(outcome.data["status"], "stale_file")

    def test_file_write_keeps_original_when_write_fails_midway(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "app.py"
            target.write_text("original\n", encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)
            self._run_generator(handler.do_file_read({"path": "app.py"}, DummyResponse()))
            with patch("secheur_core.os.replace", side_effect=OSError("simulated replace failure")):
                output, outcome = self._run_generator(
                    handler.do_file_write({"path": "app.py", "content": "new\n"}, DummyResponse())
                )
            content = target.read_text(encoding="utf-8")

        self.assertIn("写入异常", output)
        self.assertEqual(outcome.data["status"], "error")
        self.assertEqual(content, "original\n")

    def test_file_write_prepend_preserves_existing_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "app.py"
            target.write_text("body\n", encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)

            self._run_generator(handler.do_file_read({"path": "app.py"}, DummyResponse()))
            output, outcome = self._run_generator(
                handler.do_file_write({"path": "app.py", "mode": "prepend", "content": "head\n"}, DummyResponse())
            )
            content = target.read_text(encoding="utf-8")

        self.assertIn("Prepend 成功", output)
        self.assertEqual(outcome.data["status"], "success")
        self.assertEqual(content, "head\nbody\n")

    def test_file_write_append_keeps_original_when_replace_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "app.py"
            target.write_text("body\n", encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)

            self._run_generator(handler.do_file_read({"path": "app.py"}, DummyResponse()))
            with patch("secheur_core.os.replace", side_effect=OSError("simulated replace failure")):
                output, outcome = self._run_generator(
                    handler.do_file_write({"path": "app.py", "mode": "append", "content": "tail\n"}, DummyResponse())
                )
            content = target.read_text(encoding="utf-8")

        self.assertIn("写入异常", output)
        self.assertEqual(outcome.data["status"], "error")
        self.assertEqual(content, "body\n")

    def test_file_write_append_preserves_existing_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "app.py"
            target.write_text("body\n", encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)

            self._run_generator(handler.do_file_read({"path": "app.py"}, DummyResponse()))
            output, outcome = self._run_generator(
                handler.do_file_write({"path": "app.py", "mode": "append", "content": "tail\n"}, DummyResponse())
            )
            content = target.read_text(encoding="utf-8")

        self.assertIn("Append 成功", output)
        self.assertEqual(outcome.data["status"], "success")
        self.assertEqual(content, "body\ntail\n")

    def test_file_write_preserves_existing_file_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "run.sh"
            target.write_text("#!/bin/sh\necho old\n", encoding="utf-8")
            os.chmod(target, 0o755)
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)

            self._run_generator(handler.do_file_read({"path": "run.sh"}, DummyResponse()))
            output, outcome = self._run_generator(
                handler.do_file_write({"path": "run.sh", "content": "#!/bin/sh\necho new\n"}, DummyResponse())
            )
            mode = target.stat().st_mode & 0o777

        self.assertIn("Overwrite 成功", output)
        self.assertEqual(outcome.data["status"], "success")
        self.assertEqual(mode, 0o755)


if __name__ == "__main__":
    unittest.main()
