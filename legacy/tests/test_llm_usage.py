from types import SimpleNamespace

import llm_usage
from llm_usage import (
    capture_prefix_shape,
    compare_prefix_shape,
    estimate_usage_cost,
    format_usage_summary,
    get_last_context_tokens,
    get_usage_stats,
    record_usage_totals,
    reset_usage_stats,
)


def test_usage_stats_and_cost_are_calculated_from_prices():
    reset_usage_stats()
    record_usage_totals({
        "input_tokens": 1000,
        "output_tokens": 500,
        "cache_creation_input_tokens": 100,
        "cache_read_input_tokens": 200,
    }, "messages")
    backend = SimpleNamespace(
        input_cost_per_1m=2.0,
        output_cost_per_1m=8.0,
        cache_creation_cost_per_1m=1.0,
        cache_read_cost_per_1m=0.5,
    )

    stats = get_usage_stats()
    cost = estimate_usage_cost(stats, backend)

    assert stats["requests"] == 1
    assert stats["input_tokens"] == 1000
    assert round(cost, 6) == 0.0062
    assert "estimated_cost: $0.006200" in format_usage_summary(stats, cost)
    assert "cache_read_ratio: 15.4%" in format_usage_summary(stats, cost)


def test_streaming_messages_output_does_not_count_extra_request():
    reset_usage_stats()

    record_usage_totals({"input_tokens": 100, "output_tokens": 1}, "messages")
    record_usage_totals({"output_tokens": 200}, "messages")

    assert get_usage_stats()["requests"] == 1
    assert get_usage_stats()["output_tokens"] == 200


def test_deepseek_chat_usage_uses_top_level_prompt_cache_fields():
    reset_usage_stats()

    record_usage_totals({
        "prompt_tokens": 1000,
        "completion_tokens": 200,
        "prompt_cache_hit_tokens": 900,
        "prompt_cache_miss_tokens": 100,
    }, "chat_completions")

    stats = get_usage_stats()

    assert stats["input_tokens"] == 100
    assert stats["cache_read_tokens"] == 900
    assert stats["output_tokens"] == 200
    assert "cache_read_ratio: 90.0%" in format_usage_summary(stats, 0)


def test_last_context_tokens_tracks_request_and_streaming_output():
    reset_usage_stats()

    record_usage_totals({
        "input_tokens": 100,
        "cache_creation_input_tokens": 20,
        "cache_read_input_tokens": 30,
        "output_tokens": 1,
    }, "messages")
    assert get_last_context_tokens() == 150

    record_usage_totals({"output_tokens": 40}, "messages")
    assert get_last_context_tokens() == 190

    reset_usage_stats()
    assert get_last_context_tokens() == 0


def test_usage_revision_changes_only_when_context_usage_changes():
    reset_usage_stats()
    start_revision = llm_usage.get_usage_revision()

    record_usage_totals({}, "messages")
    assert llm_usage.get_usage_revision() == start_revision

    record_usage_totals({"input_tokens": 100, "output_tokens": 1}, "messages")
    request_revision = llm_usage.get_usage_revision()
    assert request_revision > start_revision

    record_usage_totals({"output_tokens": 40}, "messages")
    assert llm_usage.get_usage_revision() > request_revision


def test_usage_stats_warn_when_cache_read_ratio_drops_sharply():
    reset_usage_stats()

    record_usage_totals({
        "input_tokens": 1000,
        "cache_read_input_tokens": 4000,
        "output_tokens": 1,
    }, "messages")
    record_usage_totals({
        "input_tokens": 5000,
        "cache_read_input_tokens": 0,
        "output_tokens": 1,
    }, "messages")

    stats = get_usage_stats()

    assert stats["cache_break_warnings"] == 1
    assert "cache_break_warnings: 1" in format_usage_summary(stats, 0)


def test_prefix_shape_hash_is_stable_for_tool_order():
    tools_a = [
        {"type": "function", "function": {"name": "zeta", "description": "Z", "parameters": {"type": "object"}}},
        {"type": "function", "function": {"name": "alpha", "description": "A", "parameters": {"type": "object"}}},
    ]
    tools_b = list(reversed(tools_a))

    shape_a = capture_prefix_shape("system", tools_a, rewrite_version=0)
    shape_b = capture_prefix_shape("system", tools_b, rewrite_version=0)

    assert shape_a["tools_hash"] == shape_b["tools_hash"]
    assert shape_a["prefix_hash"] == shape_b["prefix_hash"]


def test_compare_prefix_shape_reports_system_tools_and_rewrite_changes():
    previous = capture_prefix_shape("system-a", [{"function": {"name": "alpha"}}], rewrite_version=0)
    current = capture_prefix_shape("system-b", [{"function": {"name": "beta"}}], rewrite_version=1)

    diagnostics = compare_prefix_shape(previous, current)

    assert diagnostics["prefix_changed"] is True
    assert diagnostics["prefix_change_reasons"] == ["system", "tools", "log_rewrite"]
