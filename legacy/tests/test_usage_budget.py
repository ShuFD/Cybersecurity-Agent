import unittest
import sys
import types
from contextlib import redirect_stdout
from io import StringIO

if "requests" not in sys.modules:
    sys.modules["requests"] = types.SimpleNamespace()
if "urllib3" not in sys.modules:
    sys.modules["urllib3"] = types.SimpleNamespace(
        disable_warnings=lambda *a, **k: None,
        exceptions=types.SimpleNamespace(InsecureRequestWarning=Warning),
    )

import llmcore
from llmcore import estimate_usage_cost, get_usage_stats, record_usage_totals, reset_usage_stats


class UsageBudgetTests(unittest.TestCase):
    def tearDown(self):
        reset_usage_stats()

    def test_record_usage_totals_normalizes_openai_chat_usage(self):
        reset_usage_stats()

        record_usage_totals(
            {
                "prompt_tokens": 1000,
                "completion_tokens": 200,
                "prompt_tokens_details": {"cached_tokens": 100},
            },
            "chat_completions",
        )
        stats = get_usage_stats()

        self.assertEqual(stats["input_tokens"], 900)
        self.assertEqual(stats["cache_read_tokens"], 100)
        self.assertEqual(stats["output_tokens"], 200)

    def test_record_usage_totals_normalizes_deepseek_chat_usage(self):
        reset_usage_stats()

        record_usage_totals(
            {
                "prompt_tokens": 1000,
                "completion_tokens": 200,
                "prompt_cache_hit_tokens": 900,
                "prompt_cache_miss_tokens": 100,
            },
            "chat_completions",
        )
        stats = get_usage_stats()

        self.assertEqual(stats["input_tokens"], 100)
        self.assertEqual(stats["cache_read_tokens"], 900)
        self.assertEqual(stats["output_tokens"], 200)

    def test_estimate_usage_cost_uses_backend_price_overrides(self):
        stats = {"input_tokens": 1_000_000, "output_tokens": 500_000, "cache_read_tokens": 0, "cache_creation_tokens": 0}

        class Backend:
            input_cost_per_1m = 2.0
            output_cost_per_1m = 10.0

        self.assertEqual(estimate_usage_cost(stats, Backend()), 7.0)

    def test_record_usage_totals_counts_streaming_messages_output_without_extra_request(self):
        reset_usage_stats()

        record_usage_totals({"input_tokens": 100, "output_tokens": 1}, "messages")
        record_usage_totals({"output_tokens": 200}, "messages")
        stats = get_usage_stats()

        self.assertEqual(stats["requests"], 1)
        self.assertEqual(stats["input_tokens"], 100)
        self.assertEqual(stats["output_tokens"], 200)

    def test_record_usage_prints_cache_break_warning(self):
        reset_usage_stats()
        llmcore._record_usage(
            {"input_tokens": 1000, "cache_read_input_tokens": 4000, "output_tokens": 1},
            "messages",
        )

        out = StringIO()
        with redirect_stdout(out):
            llmcore._record_usage(
                {"input_tokens": 5000, "cache_read_input_tokens": 0, "output_tokens": 1},
                "messages",
            )

        self.assertIn("[CacheBreak]", out.getvalue())

    def test_record_usage_prints_deepseek_cache_hit_and_miss(self):
        reset_usage_stats()

        out = StringIO()
        with redirect_stdout(out):
            llmcore._record_usage(
                {
                    "prompt_tokens": 1000,
                    "completion_tokens": 200,
                    "prompt_cache_hit_tokens": 900,
                    "prompt_cache_miss_tokens": 100,
                },
                "chat_completions",
            )

        self.assertIn("[Cache] input=1000 cached=900 fresh=100", out.getvalue())

    def test_record_usage_prints_prefix_change_reason_on_cache_break(self):
        reset_usage_stats()
        backend = types.SimpleNamespace(
            system="system-a",
            tools=[{"type": "function", "function": {"name": "alpha", "parameters": {}}}],
            _prefix_rewrite_version=0,
        )
        llmcore._capture_session_prefix_shape(backend)
        llmcore._record_usage(
            {
                "prompt_tokens": 5000,
                "completion_tokens": 1,
                "prompt_cache_hit_tokens": 4000,
                "prompt_cache_miss_tokens": 1000,
            },
            "chat_completions",
        )

        backend.system = "system-b"
        llmcore._capture_session_prefix_shape(backend)
        out = StringIO()
        with redirect_stdout(out):
            llmcore._record_usage(
                {
                    "prompt_tokens": 5000,
                    "completion_tokens": 1,
                    "prompt_cache_hit_tokens": 0,
                    "prompt_cache_miss_tokens": 5000,
                },
                "chat_completions",
            )

        self.assertIn("cache prefix changed: system", out.getvalue())

    def test_openai_prefix_capture_ignores_first_non_system_message(self):
        system_prompt, tools = llmcore._oai_prefix_parts(
            {
                "messages": [
                    {"role": "user", "content": "first question"},
                    {"role": "assistant", "content": "answer"},
                ]
            }
        )

        self.assertEqual(system_prompt, "")
        self.assertIsNone(tools)


if __name__ == "__main__":
    unittest.main()
