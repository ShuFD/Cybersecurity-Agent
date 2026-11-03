import os
import shlex
import subprocess
import sys
import tempfile
import time
import unittest
import ast
from pathlib import Path
from unittest.mock import Mock, patch

import agent_loop
import agentmain
import background_tasks
import llmcore
import secheur_core
from runtime_session_log import read_session_events, read_session_records, session_log_sidecar_path


def _is_git_ignored(root, path):
    rel = path.relative_to(root).as_posix()
    return subprocess.run(
        ["git", "check-ignore", "-q", "--", rel],
        cwd=root,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    ).returncode == 0


class RuntimeResourceCleanupTests(unittest.TestCase):
    def _run_generator(self, gen):
        chunks = []
        while True:
            try:
                chunks.append(next(gen))
            except StopIteration as done:
                return "".join(chunks), done.value

    def test_only_cli_and_tests_change_process_cwd(self):
        root = Path(__file__).resolve().parents[1]
        allowed = {"secheur_cli/cli.py"}
        offenders = []
        for path in root.rglob("*.py"):
            rel = path.relative_to(root).as_posix()
            if any(part in {".git", ".venv", "__pycache__", "temp"} for part in path.relative_to(root).parts):
                continue
            if _is_git_ignored(root, path):
                continue
            if rel.startswith("tests/") or rel in allowed:
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if (
                    isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "chdir"
                    and isinstance(node.func.value, ast.Name)
                    and node.func.value.id == "os"
                ):
                    offenders.append(f"{rel}:{node.lineno}")

        self.assertEqual(offenders, [])

    def test_code_run_does_not_close_stdout_from_background_thread(self):
        source = Path(secheur_core.__file__).read_text(encoding="utf-8")

        self.assertNotIn("threading.Thread(target=process.stdout.close", source)

    def test_agentmain_does_not_keep_unused_agent_lock(self):
        source = Path(agentmain.__file__).read_text(encoding="utf-8")

        self.assertNotIn("self.lock = threading.Lock()", source)

    def test_code_run_timeout_kills_child_process_group(self):
        if os.name == "nt":
            self.skipTest("POSIX process group behavior is tested on non-Windows")
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / "child-survived.txt"
            child_code = f"import pathlib,time; time.sleep(1); pathlib.Path({str(marker)!r}).write_text('alive')"
            parent_code = (
                "import subprocess,sys,time; "
                f"subprocess.Popen([sys.executable, '-c', {child_code!r}]); "
                "time.sleep(30)"
            )
            command = f"{shlex.quote(sys.executable)} -c {shlex.quote(parent_code)}"

            output, result = self._run_generator(secheur_core.code_run(command, code_type="bash", timeout=0.2, cwd=tmp))
            time.sleep(1.3)

        self.assertIn("Timeout Error", output)
        self.assertIn("Timeout Error", result["stdout"])
        self.assertFalse(marker.exists())

    def test_cleanup_old_files_removes_only_stale_matching_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            old_file = root / "model_responses_old.txt"
            recent_file = root / "model_responses_recent.txt"
            unrelated_old_file = root / "notes.txt"
            for path in (old_file, recent_file, unrelated_old_file):
                path.write_text("x", encoding="utf-8")
            old_time = time.time() - 40 * 24 * 60 * 60
            os.utime(old_file, (old_time, old_time))
            os.utime(unrelated_old_file, (old_time, old_time))

            removed = llmcore.cleanup_old_runtime_files(root, "model_responses_*.txt", retention_days=30)

            self.assertEqual(removed, 1)
            self.assertFalse(old_file.exists())
            self.assertTrue(recent_file.exists())
            self.assertTrue(unrelated_old_file.exists())

    def test_llm_log_writes_structured_content_as_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            log_path = Path(tmp) / "model_responses_1.txt"

            llmcore._write_llm_log("Response", [{"type": "text", "text": "hi"}], log_path)

            content = log_path.read_text(encoding="utf-8")
            self.assertIn('"type": "text"', content)
            self.assertNotIn("'type': 'text'", content)

    def test_llm_log_writes_structured_sidecar_events(self):
        with tempfile.TemporaryDirectory() as tmp:
            log_path = Path(tmp) / "model_responses_1.txt"
            prompt = {"role": "user", "content": [{"type": "text", "text": "hello"}]}
            response = [{"type": "text", "text": "hi"}]

            llmcore._write_llm_log("Prompt", prompt, log_path)
            llmcore._write_llm_log("Response", response, log_path)

            structured_path = session_log_sidecar_path(log_path)
            records = list(read_session_records(structured_path))
            events = list(read_session_events(structured_path))

            self.assertEqual([event.role for event in events], ["user", "assistant"])
            self.assertEqual([event.turn_id for event in events], [1, 2])
            self.assertEqual(events[0].content, prompt["content"])
            self.assertEqual(events[1].content, response)
            self.assertTrue(records[0]["uuid"])
            self.assertTrue(records[1]["uuid"])
            self.assertNotEqual(records[0]["uuid"], records[1]["uuid"])
            self.assertEqual(records[0]["parent_uuid"], "")
            self.assertEqual(records[1]["parent_uuid"], records[0]["uuid"])
            self.assertIn("timestamp", records[0])
            self.assertIn("model", records[0])

    def test_persist_long_tool_output_cleans_stale_tool_results(self):
        with tempfile.TemporaryDirectory() as tmp:
            tool_dir = Path(tmp) / "tool_results"
            tool_dir.mkdir()
            old_file = tool_dir / "code_run_old.txt"
            old_file.write_text("old", encoding="utf-8")
            old_time = time.time() - 40 * 24 * 60 * 60
            os.utime(old_file, (old_time, old_time))

            saved = Path(secheur_core._persist_long_tool_output("new", tmp))

            self.assertTrue(saved.exists())
            self.assertFalse(old_file.exists())

    def test_agent_loop_large_tool_result_cleans_stale_tool_results(self):
        with tempfile.TemporaryDirectory() as tmp:
            tool_dir = Path(tmp) / "tool_results"
            tool_dir.mkdir()
            old_file = tool_dir / "file_read_old.txt"
            old_file.write_text("old", encoding="utf-8")
            old_time = time.time() - 40 * 24 * 60 * 60
            os.utime(old_file, (old_time, old_time))
            handler = type("Handler", (), {"cwd": tmp})()

            result = agent_loop._persist_large_tool_result(
                handler,
                "file_read",
                "x" * (agent_loop.LARGE_TOOL_RESULT_THRESHOLD + 1),
            )
            saved_path_text = next(
                line.split(": ", 1)[1]
                for line in result.splitlines()
                if line.startswith("full_result_path: ")
            )
            saved_path = Path(saved_path_text)

            self.assertTrue(saved_path.exists())
            self.assertFalse(old_file.exists())

    def test_python_code_run_temp_script_stays_outside_run_cwd_and_keeps_imports(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "local_module.py").write_text("VALUE = 'local-ok'\n", encoding="utf-8")
            code = (
                "import pathlib\n"
                "import local_module\n"
                "pathlib.Path('marker.txt').write_text(local_module.VALUE, encoding='utf-8')\n"
            )

            _, result = self._run_generator(secheur_core.code_run(code, code_type="python", cwd=root, code_cwd=root))

            self.assertEqual(result["status"], "success")
            self.assertEqual((root / "marker.txt").read_text(encoding="utf-8"), "local-ok")
            self.assertEqual(list(root.glob("*.ai.py")), [])

    def test_background_task_launch_closes_parent_log_handles(self):
        log_handles = [Mock(), Mock()]
        pending_handles = list(log_handles)

        def fake_open(*_args, **_kwargs):
            return pending_handles.pop(0)

        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(agentmain, "script_dir", tmp), \
             patch.object(agentmain.subprocess, "Popen", return_value=Mock(pid=1234)) as popen, \
             patch("builtins.open", side_effect=fake_open):
            pid = agentmain.launch_background_task("job", ["--task", "job"])

        self.assertEqual(pid, 1234)
        self.assertEqual(popen.call_count, 1)
        self.assertEqual([handle.close.call_count for handle in log_handles], [1, 1])

    def test_background_task_stop_cleans_temp_python_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tmp_script = root / "pending.ai.py"
            tmp_script.write_text("import time; time.sleep(30)", encoding="utf-8")

            task = background_tasks.start_background_task(
                [sys.executable, "-u", str(tmp_script)],
                cwd=root,
                output_dir=root / "tasks",
                tmp_path=tmp_script,
            )
            try:
                background_tasks.stop_background_task(task.task_id)

                self.assertFalse(tmp_script.exists())
            finally:
                background_tasks.reset_background_tasks()

    def test_background_task_stop_kills_child_process_group_by_default(self):
        if os.name == "nt":
            self.skipTest("POSIX process group behavior is tested on non-Windows")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            spawned = root / "background-child-spawned.txt"
            marker = root / "background-child-survived.txt"
            child_code = f"import pathlib,time; time.sleep(1); pathlib.Path({str(marker)!r}).write_text('alive')"
            parent_code = (
                "import pathlib,subprocess,sys,time; "
                f"subprocess.Popen([sys.executable, '-c', {child_code!r}]); "
                f"pathlib.Path({str(spawned)!r}).write_text('spawned'); "
                "time.sleep(30)"
            )
            task = background_tasks.start_background_task(
                [sys.executable, "-u", "-c", parent_code],
                cwd=root,
                output_dir=root / "tasks",
            )
            try:
                deadline = time.time() + 2
                while time.time() < deadline and not spawned.exists():
                    time.sleep(0.02)
                self.assertTrue(spawned.exists())

                background_tasks.stop_background_task(task.task_id)
                time.sleep(1.3)

                self.assertFalse(marker.exists())
            finally:
                background_tasks.reset_background_tasks()


if __name__ == "__main__":
    unittest.main()
