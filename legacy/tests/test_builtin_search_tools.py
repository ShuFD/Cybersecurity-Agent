import tempfile
import urllib.error
import unittest
from pathlib import Path
from unittest.mock import patch

from secheur_core import SecHeurAgentHandler

PUBLIC_DNS_RESULT = [(None, None, None, None, ("93.184.216.34", 0))]


class DummyParent:
    task_dir = None
    verbose = False


class BypassParent(DummyParent):
    permission_mode = "bypassPermissions"


class HandlerToolTests(unittest.TestCase):
    def _run_generator(self, gen):
        chunks = []
        while True:
            try:
                chunks.append(next(gen))
            except StopIteration as done:
                return "".join(chunks), done.value

    def test_do_list_files_lists_matching_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a.py").write_text("print(1)", encoding="utf-8")
            (root / "b.txt").write_text("text", encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)

            output, outcome = self._run_generator(handler.do_list_files({"pattern": "*.py"}, None))

        self.assertIn("a.py", output)
        self.assertNotIn("b.txt", output)
        self.assertEqual(outcome.data["status"], "success")

    def test_do_grep_search_returns_matching_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a.py").write_text("alpha\nneedle\n", encoding="utf-8")
            (root / "b.py").write_text("none\n", encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)

            output, outcome = self._run_generator(handler.do_grep_search({"pattern": "needle", "include": "*.py"}, None))

        self.assertIn("a.py:2:needle", output)
        self.assertEqual(outcome.data["status"], "success")

    def test_search_tools_skip_generated_and_dependency_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "src").mkdir()
            (root / "src" / "app.py").write_text("needle\n", encoding="utf-8")
            (root / ".venv" / "lib").mkdir(parents=True)
            (root / ".venv" / "lib" / "site.py").write_text("needle\n", encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)

            list_output, list_outcome = self._run_generator(handler.do_list_files({"pattern": "**/*.py"}, None))
            grep_output, grep_outcome = self._run_generator(handler.do_grep_search({"pattern": "needle", "include": "*.py"}, None))

        self.assertIn("src/app.py", list_output)
        self.assertNotIn(".venv", list_output)
        self.assertEqual(list_outcome.data["status"], "success")
        self.assertIn("src/app.py:1:needle", grep_output)
        self.assertNotIn(".venv", grep_output)
        self.assertEqual(grep_outcome.data["status"], "success")

    def test_do_web_fetch_fetches_and_strips_html(self):
        handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
        url = "data:text/html,<html><body><h1>Hello</h1><script>bad()</script></body></html>"
        output, outcome = self._run_generator(handler.do_web_fetch({"url": url}, None))

        self.assertIn("Hello", output)
        self.assertNotIn("bad()", output)
        self.assertEqual(outcome.data["status"], "success")

    def test_do_web_fetch_rejects_local_file_urls(self):
        with tempfile.TemporaryDirectory() as tmp:
            secret = Path(tmp) / "secret.txt"
            secret.write_text("SECRET_TOKEN=abc\n", encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd=tmp)

            output, outcome = self._run_generator(handler.do_web_fetch({"url": secret.as_uri()}, None))

        self.assertIn("Unsupported URL scheme", output)
        self.assertEqual(outcome.data["status"], "error")

    def test_do_web_fetch_rejects_local_and_private_network_urls(self):
        handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
        blocked = [
            "http://localhost:8000",
            "http://localhost.:8000",
            "http://metadata.google.internal/",
            "http://127.0.0.1:8000",
            "http://2130706433/",
            "http://0x7f000001/",
            "http://0177.0.0.1/",
            "http://127.1/",
            "http://[::1]:8000",
            "http://[fd00::1]/",
            "http://10.0.0.1/",
            "http://172.16.0.1/",
            "http://192.168.1.1/",
            "http://169.254.169.254/latest/meta-data/",
        ]

        for url in blocked:
            with self.subTest(url=url):
                output, outcome = self._run_generator(handler.do_web_fetch({"url": url}, None))
                self.assertIn("Blocked private network URL", output)
                self.assertEqual(outcome.data["status"], "error")

    def test_do_web_fetch_allows_private_network_urls_in_bypass_mode(self):
        handler = SecHeurAgentHandler(BypassParent(), [], cwd="./temp")

        class FakeResponse:
            headers = {"Content-Type": "text/plain"}

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self, size=-1):
                return b"local ok"

        class FakeOpener:
            def open(self, req, timeout=30):
                return FakeResponse()

        with patch("urllib.request.build_opener", return_value=FakeOpener()):
            output, outcome = self._run_generator(handler.do_web_fetch({"url": "http://127.0.0.1:8000/status"}, None))

        self.assertIn("local ok", output)
        self.assertEqual(outcome.data["status"], "success")

    def test_do_web_fetch_rejects_redirects_to_private_network_urls(self):
        handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")

        def redirect_response(req, timeout=30):
            raise urllib.error.HTTPError(
                req.full_url,
                302,
                "Found",
                {"Location": "http://127.0.0.1/admin"},
                None,
            )

        class FakeOpener:
            def open(self, req, timeout=30):
                return redirect_response(req, timeout=timeout)

        with (
            patch("socket.getaddrinfo", return_value=PUBLIC_DNS_RESULT),
            patch("urllib.request.urlopen", redirect_response),
            patch("urllib.request.build_opener", return_value=FakeOpener()),
        ):
            output, outcome = self._run_generator(handler.do_web_fetch({"url": "http://example.test/start"}, None))

        self.assertIn("Blocked private network URL", output)
        self.assertEqual(outcome.data["status"], "error")

    def test_do_web_fetch_rejects_hostname_resolving_to_private_network(self):
        handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")

        with patch("socket.getaddrinfo", return_value=[(None, None, None, None, ("127.0.0.1", 0))]):
            output, outcome = self._run_generator(handler.do_web_fetch({"url": "http://internal.example.test/"}, None))

        self.assertIn("Blocked private network URL", output)
        self.assertEqual(outcome.data["status"], "error")

    def test_do_web_fetch_reads_only_max_length_plus_one_bytes(self):
        handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
        read_sizes = []

        class FakeResponse:
            headers = {"Content-Type": "text/plain"}

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self, size=-1):
                read_sizes.append(size)
                return b"a" * 100

        class FakeOpener:
            def open(self, req, timeout=30):
                return FakeResponse()

        with (
            patch("socket.getaddrinfo", return_value=PUBLIC_DNS_RESULT),
            patch("urllib.request.build_opener", return_value=FakeOpener()),
        ):
            output, outcome = self._run_generator(
                handler.do_web_fetch({"url": "http://example.test/large", "max_length": 10}, None)
            )

        self.assertEqual(read_sizes, [11])
        self.assertIn("[... truncated at 10 characters]", output)
        self.assertEqual(outcome.data["status"], "success")

    def test_do_web_fetch_rejects_invalid_max_length(self):
        handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
        invalid_values = ["not-a-number", 0, -1, 200001]

        for value in invalid_values:
            with self.subTest(value=value):
                output, outcome = self._run_generator(
                    handler.do_web_fetch({"url": "data:text/plain,hello", "max_length": value}, None)
                )

                self.assertIn("Invalid max_length", output)
                self.assertEqual(outcome.data["status"], "error")

    def test_do_web_fetch_decodes_declared_charset(self):
        handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")

        class FakeResponse:
            headers = {"Content-Type": "text/html; charset=gbk"}

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self, size=-1):
                return b"<html><body>\xd6\xd0\xce\xc4</body></html>"

        class FakeOpener:
            def open(self, req, timeout=30):
                return FakeResponse()

        with (
            patch("socket.getaddrinfo", return_value=PUBLIC_DNS_RESULT),
            patch("urllib.request.build_opener", return_value=FakeOpener()),
        ):
            output, outcome = self._run_generator(handler.do_web_fetch({"url": "http://example.test/gbk"}, None))

        self.assertIn("\u4e2d\u6587", output)
        self.assertEqual(outcome.data["status"], "success")


if __name__ == "__main__":
    unittest.main()
