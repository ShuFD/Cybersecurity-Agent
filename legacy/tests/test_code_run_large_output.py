import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

from secheur_core import code_run


class CodeRunLargeOutputTests(unittest.TestCase):
    def _run_generator(self, gen):
        chunks = []
        with redirect_stdout(StringIO()):
            while True:
                try:
                    chunks.append(next(gen))
                except StopIteration as done:
                    return "".join(chunks), done.value

    def test_code_run_persists_stdout_when_larger_than_maxlen(self):
        with tempfile.TemporaryDirectory() as tmp:
            code = "print('x' * 400)"
            output, result = self._run_generator(code_run(code, code_type="python", cwd=tmp, code_cwd=tmp, maxlen=80))
            saved_path = Path(result["full_stdout_path"])

            saved = saved_path.read_text(encoding="utf-8")

        self.assertEqual(result["status"], "success")
        self.assertTrue(saved_path.name.startswith("code_run_"))
        self.assertIn("Full stdout saved", output)
        self.assertIn("x" * 400, saved)
        self.assertIn("[omitted long output]", result["stdout"])

    def test_code_run_does_not_persist_short_stdout(self):
        with tempfile.TemporaryDirectory() as tmp:
            output, result = self._run_generator(code_run("print('ok')", code_type="python", cwd=tmp, code_cwd=tmp, maxlen=80))

        self.assertNotIn("full_stdout_path", result)
        self.assertNotIn("Full stdout saved", output)
        self.assertEqual(result["stdout"].strip(), "ok")


if __name__ == "__main__":
    unittest.main()
