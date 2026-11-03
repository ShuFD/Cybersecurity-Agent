import sys
import threading
import time
import types
import unittest
import ast
import inspect
import textwrap
from unittest.mock import patch

if "requests" not in sys.modules:
    sys.modules["requests"] = types.SimpleNamespace()
if "urllib3" not in sys.modules:
    sys.modules["urllib3"] = types.SimpleNamespace(
        disable_warnings=lambda *a, **k: None,
        exceptions=types.SimpleNamespace(InsecureRequestWarning=Warning),
    )

from llmcore import BaseSession, MixinSession, _retry_delay, _stream_with_retry, _try_parse_tool_args


class FakeResponse:
    headers = {}
    text = "overloaded"

    def __init__(self, status_code):
        self.status_code = status_code

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class FakeBackend:
    def __init__(self, name):
        self.name = name
        self.history = []
        self.max_retries = 3

    def raw_ask(self, *_args, **_kwargs):
        if False:
            yield ""
        return []


class FakeClient:
    def __init__(self, backend):
        self.backend = backend


class InterleavingSession(BaseSession):
    def __init__(self):
        super().__init__({"apikey": "k", "apibase": "https://example.test"})
        self.first_started = threading.Event()
        self.release_first = threading.Event()

    def make_messages(self, history):
        return list(history)

    def raw_ask(self, messages):
        prompt = messages[-1]["content"][0]["text"]
        if prompt == "first":
            self.first_started.set()
            self.release_first.wait(timeout=2)
        if False:
            yield ""
        yield f"answer-{prompt}"
        return []


class RetryDelayTests(unittest.TestCase):
    def test_base_session_defaults_to_three_retries(self):
        session = BaseSession({"apikey": "k", "apibase": "https://example.test"})

        self.assertEqual(session.max_retries, 3)

    def test_base_session_serializes_complete_api_rounds(self):
        session = InterleavingSession()
        outputs = []

        def run_prompt(prompt):
            outputs.append("".join(session.ask(prompt)))

        first = threading.Thread(target=run_prompt, args=("first",))
        second = threading.Thread(target=run_prompt, args=("second",))
        first.start()
        self.assertTrue(session.first_started.wait(timeout=1))
        second.start()
        time.sleep(0.05)
        session.release_first.set()
        first.join(timeout=1)
        second.join(timeout=1)

        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(outputs, ["answer-first", "answer-second"])
        self.assertEqual(
            [(msg["role"], msg["content"][0]["text"]) for msg in session.history],
            [
                ("user", "first"),
                ("assistant", "answer-first"),
                ("user", "second"),
                ("assistant", "answer-second"),
            ],
        )

    def test_retry_delay_prefers_retry_after_header(self):
        response = types.SimpleNamespace(headers={"retry-after": "7"})

        self.assertEqual(_retry_delay(response, attempt=2, jitter_fn=lambda: 0), 7)

    def test_retry_delay_uses_exponential_backoff_with_jitter(self):
        low = _retry_delay(None, attempt=2, base_delay=1.5, jitter_fn=lambda: 0.0)
        high = _retry_delay(None, attempt=2, base_delay=1.5, jitter_fn=lambda: 1.0)

        self.assertEqual(low, 4.8)
        self.assertEqual(high, 7.2)

    def test_background_priority_does_not_retry_overload_errors(self):
        session = types.SimpleNamespace(
            max_retries=3,
            stream=False,
            connect_timeout=1,
            read_timeout=5,
            proxies=None,
            verify=True,
        )
        calls = []

        def fake_post(*_args, **_kwargs):
            calls.append(1)
            return FakeResponse(529)

        with patch("llmcore.requests.post", side_effect=fake_post, create=True), \
             patch("llmcore.time.sleep") as sleep:
            result = list(_stream_with_retry(
                session,
                "https://example.test",
                {},
                {},
                lambda _response: iter(()),
                priority="background",
            ))

        self.assertEqual(len(calls), 1)
        self.assertEqual(sleep.call_count, 0)
        self.assertEqual(result[0], "!!!Error: HTTP 529: overloaded")

    def test_tool_arg_parser_does_not_catch_base_exception(self):
        source = textwrap.dedent(inspect.getsource(_try_parse_tool_args))
        tree = ast.parse(source)
        bare_handlers = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.ExceptHandler) and node.type is None
        ]

        self.assertEqual(bare_handlers, [])

    def test_mixin_session_does_not_share_history_lists_between_backends(self):
        primary = FakeBackend("primary")
        fallback = FakeBackend("fallback")
        primary.history.append({"role": "user", "content": "original"})

        mixin = MixinSession(
            [FakeClient(primary), FakeClient(fallback)],
            {"llm_nos": ["primary", "fallback"], "max_retries": 1},
        )

        self.assertIsNot(mixin.primary.history, primary.history)
        self.assertIsNot(mixin._sessions[1].history, fallback.history)
        self.assertEqual(mixin.primary.history, primary.history)
        mixin.history = [{"role": "user", "content": "fresh"}]

        self.assertIsNot(mixin._sessions[0].history, mixin._sessions[1].history)
        mixin._sessions[0].history.append({"role": "assistant", "content": "primary only"})
        self.assertEqual(mixin._sessions[1].history, [{"role": "user", "content": "fresh"}])


if __name__ == "__main__":
    unittest.main()
