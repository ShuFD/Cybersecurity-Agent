from __future__ import annotations

import hashlib
import json
import threading


_usage_lock = threading.Lock()
_usage_by_thread = {}
_last_context_by_thread = {}
_last_cache_read_ratio_by_thread = {}
_usage_revision_by_thread = {}

CACHE_BREAK_PREVIOUS_RATIO = 0.70
CACHE_BREAK_CURRENT_RATIO = 0.20
CACHE_BREAK_MIN_INPUT_TOKENS = 1000


def _stable_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def _short_hash(value):
    return hashlib.sha256(_stable_json(value).encode("utf-8")).hexdigest()[:16]


def _tool_sort_key(tool):
    if not isinstance(tool, dict):
        return ("", "", _stable_json(tool))
    fn = tool.get("function") or tool
    return (
        str(fn.get("name", "")),
        str(fn.get("description", "")),
        _stable_json(fn.get("parameters", fn.get("input_schema", {}))),
    )


def _normalize_tool_schemas(tools):
    tools = tools or []
    return sorted((_stable_json(tool) for tool in tools), key=lambda item: _tool_sort_key(json.loads(item)))


def capture_prefix_shape(system_prompt, tools=None, rewrite_version=0):
    normalized_tools = _normalize_tool_schemas(tools)
    return {
        "system_hash": _short_hash(str(system_prompt or "")),
        "tools_hash": _short_hash(normalized_tools),
        "prefix_hash": _short_hash({
            "system": str(system_prompt or ""),
            "tools": normalized_tools,
        }),
        "log_rewrite_version": int(rewrite_version or 0),
        "tool_schema_tokens": len(_stable_json(normalized_tools)) // 4 if normalized_tools else 0,
    }


def compare_prefix_shape(previous, current):
    previous = previous or {}
    current = current or {}
    reasons = []
    if previous.get("system_hash") and previous.get("system_hash") != current.get("system_hash"):
        reasons.append("system")
    if previous.get("tools_hash") and previous.get("tools_hash") != current.get("tools_hash"):
        reasons.append("tools")
    if previous.get("log_rewrite_version", 0) != current.get("log_rewrite_version", 0):
        reasons.append("log_rewrite")
    return {
        "prefix_hash": current.get("prefix_hash", ""),
        "prefix_changed": bool(reasons),
        "prefix_change_reasons": reasons,
        "system_hash": current.get("system_hash", ""),
        "tools_hash": current.get("tools_hash", ""),
        "log_rewrite_version": int(current.get("log_rewrite_version", 0) or 0),
        "tool_schema_tokens": int(current.get("tool_schema_tokens", 0) or 0),
    }


def get_last_context_tokens(thread_name=None):
    """最近一次 API 请求结束时的上下文总 token（input+cache+output），作为 trim 决策的权威基准。"""
    thread_name = thread_name or threading.current_thread().name
    with _usage_lock:
        return _last_context_by_thread.get(thread_name, 0)


def get_usage_revision(thread_name=None):
    """当前线程 usage 上下文基线的递增版本号，用于区分新 usage 与旧缓存值。"""
    thread_name = thread_name or threading.current_thread().name
    with _usage_lock:
        return _usage_revision_by_thread.get(thread_name, 0)


def _empty_usage_stats():
    return {
        "requests": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_creation_tokens": 0,
        "cache_read_tokens": 0,
        "cache_break_warnings": 0,
    }


def _usage_int(usage, key):
    try:
        return int(usage.get(key, 0) or 0)
    except (TypeError, ValueError):
        return 0


def _nested_usage_int(usage, parent, key):
    return _usage_int(usage.get(parent) or {}, key)


def normalize_usage_delta(usage, api_mode):
    delta = _empty_usage_stats()
    if not usage:
        return delta
    if api_mode == "responses":
        delta["requests"] = 1
        cached = _nested_usage_int(usage, "input_tokens_details", "cached_tokens")
        inp = _usage_int(usage, "input_tokens")
        delta["input_tokens"] = max(0, inp - cached)
        delta["cache_read_tokens"] = cached
        delta["output_tokens"] = _usage_int(usage, "output_tokens")
    elif api_mode == "chat_completions":
        delta["requests"] = 1
        inp = _usage_int(usage, "prompt_tokens")
        if "prompt_cache_hit_tokens" in usage or "prompt_cache_miss_tokens" in usage:
            cached = _usage_int(usage, "prompt_cache_hit_tokens")
            fresh = _usage_int(usage, "prompt_cache_miss_tokens")
            if not fresh and inp:
                fresh = max(0, inp - cached)
        else:
            cached = _nested_usage_int(usage, "prompt_tokens_details", "cached_tokens")
            fresh = max(0, inp - cached)
        delta["input_tokens"] = fresh
        delta["cache_read_tokens"] = cached
        delta["output_tokens"] = _usage_int(usage, "completion_tokens")
    elif api_mode == "messages":
        has_input_side = any(key in usage for key in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
        delta["requests"] = 1 if has_input_side else 0
        delta["input_tokens"] = _usage_int(usage, "input_tokens")
        delta["cache_creation_tokens"] = _usage_int(usage, "cache_creation_input_tokens")
        delta["cache_read_tokens"] = _usage_int(usage, "cache_read_input_tokens")
        output_tokens = _usage_int(usage, "output_tokens")
        delta["output_tokens"] = 0 if has_input_side and output_tokens <= 1 else output_tokens
    return delta


def reset_usage_stats(thread_name=None):
    thread_name = thread_name or threading.current_thread().name
    with _usage_lock:
        _usage_by_thread.pop(thread_name, None)
        _last_context_by_thread.pop(thread_name, None)
        _last_cache_read_ratio_by_thread.pop(thread_name, None)
        _usage_revision_by_thread.pop(thread_name, None)


def get_usage_stats(thread_name=None):
    thread_name = thread_name or threading.current_thread().name
    with _usage_lock:
        return dict(_usage_by_thread.get(thread_name, _empty_usage_stats()))


def record_usage_totals(usage, api_mode, thread_name=None):
    if not usage:
        return get_usage_stats(thread_name)
    thread_name = thread_name or threading.current_thread().name
    delta = normalize_usage_delta(usage, api_mode)
    with _usage_lock:
        stats = _usage_by_thread.setdefault(thread_name, _empty_usage_stats())
        cache_base = delta["input_tokens"] + delta["cache_creation_tokens"] + delta["cache_read_tokens"]
        if delta["requests"] and cache_base >= CACHE_BREAK_MIN_INPUT_TOKENS:
            current_ratio = delta["cache_read_tokens"] / cache_base
            previous_ratio = _last_cache_read_ratio_by_thread.get(thread_name)
            if (
                previous_ratio is not None
                and previous_ratio >= CACHE_BREAK_PREVIOUS_RATIO
                and current_ratio <= CACHE_BREAK_CURRENT_RATIO
            ):
                stats["cache_break_warnings"] += 1
            _last_cache_read_ratio_by_thread[thread_name] = current_ratio
        for key, value in delta.items():
            stats[key] += value
        context_total = delta["input_tokens"] + delta["cache_creation_tokens"] + delta["cache_read_tokens"] + delta["output_tokens"]
        if delta["requests"]:
            _last_context_by_thread[thread_name] = context_total
            _usage_revision_by_thread[thread_name] = _usage_revision_by_thread.get(thread_name, 0) + 1
        elif delta["output_tokens"]:  # SSE 流式下 output 可能单独补报
            _last_context_by_thread[thread_name] = _last_context_by_thread.get(thread_name, 0) + delta["output_tokens"]
            _usage_revision_by_thread[thread_name] = _usage_revision_by_thread.get(thread_name, 0) + 1
        return dict(stats)


def _price_attr(backend, *names):
    for name in names:
        value = getattr(backend, name, None)
        if value is not None:
            try:
                return float(value)
            except (TypeError, ValueError):
                pass
    return None


def _default_model_prices_per_1m(model):
    ml = (model or "").lower()
    if "opus" in ml:
        return {"input": 15.0, "output": 75.0, "cache_read": 1.5, "cache_creation": 18.75}
    if "sonnet" in ml or "gpt-5" in ml or "gpt-4" in ml:
        return {"input": 3.0, "output": 15.0, "cache_read": 0.3, "cache_creation": 3.75}
    if "haiku" in ml or "mini" in ml:
        return {"input": 0.25, "output": 1.25, "cache_read": 0.025, "cache_creation": 0.3}
    return {"input": 1.0, "output": 5.0, "cache_read": 0.1, "cache_creation": 1.25}


def estimate_usage_cost(stats=None, backend=None):
    stats = stats or get_usage_stats()
    prices = _default_model_prices_per_1m(getattr(backend, "model", ""))
    if backend is not None:
        prices["input"] = _price_attr(backend, "input_cost_per_1m", "input_price_per_1m") or prices["input"]
        prices["output"] = _price_attr(backend, "output_cost_per_1m", "output_price_per_1m") or prices["output"]
        prices["cache_read"] = _price_attr(backend, "cache_read_cost_per_1m", "cache_read_price_per_1m") or prices["cache_read"]
        prices["cache_creation"] = _price_attr(backend, "cache_creation_cost_per_1m", "cache_creation_price_per_1m") or prices["cache_creation"]
    return round(
        (int(stats.get("input_tokens", 0) or 0) * prices["input"]
         + int(stats.get("output_tokens", 0) or 0) * prices["output"]
         + int(stats.get("cache_read_tokens", 0) or 0) * prices["cache_read"]
         + int(stats.get("cache_creation_tokens", 0) or 0) * prices["cache_creation"]) / 1_000_000,
        6,
    )


def format_usage_summary(stats, cost):
    stats = stats or {}
    input_tokens = int(stats.get('input_tokens', 0) or 0)
    cache_creation_tokens = int(stats.get('cache_creation_tokens', 0) or 0)
    cache_read_tokens = int(stats.get('cache_read_tokens', 0) or 0)
    cache_break_warnings = int(stats.get('cache_break_warnings', 0) or 0)
    cache_base = input_tokens + cache_creation_tokens + cache_read_tokens
    cache_read_ratio = (cache_read_tokens / cache_base * 100) if cache_base else 0.0
    summary = (
        "Usage summary\n"
        f"requests: {int(stats.get('requests', 0) or 0)}\n"
        f"input_tokens: {input_tokens}\n"
        f"output_tokens: {int(stats.get('output_tokens', 0) or 0)}\n"
        f"cache_creation_tokens: {cache_creation_tokens}\n"
        f"cache_read_tokens: {cache_read_tokens}\n"
        f"cache_read_ratio: {cache_read_ratio:.1f}%\n"
        f"estimated_cost: ${float(cost or 0):.6f}"
    )
    if cache_break_warnings:
        summary += f"\ncache_break_warnings: {cache_break_warnings}"
    return summary
