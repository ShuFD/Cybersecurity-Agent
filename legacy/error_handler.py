from __future__ import annotations

import hashlib
import json
import os
import re
import time
import urllib.parse
from pathlib import Path
from typing import Any, Dict, Optional


VERSION = 1
DISABLE_ENV = "SECHEUR_DISABLE_ERROR_HANDLER"
MAX_MESSAGE = 1200
MAX_PREVIEW = 500
SECRET_KEYS = {
    "api_key",
    "apikey",
    "authorization",
    "cookie",
    "password",
    "secret",
    "token",
}

ERROR_STATUSES = {
    "blocked",
    "denied",
    "error",
    "failed",
    "hook_blocked",
    "not_found",
    "parse_error",
    "permission_denied",
    "permission_required",
    "stale_file",
}

KNOWN_PATTERNS = [
    ("browser_no_tab", re.compile(r"no available browser tabs|没有可用的?浏览器标签页|浏览器标签全部丢失", re.I)),
    ("mcp_path_denied", re.compile(r"outside\s+CTF_WORKDIR|not in CTF_WORKDIR|path outside|路径.*拒绝|宿主路径|/tmp/.*拒", re.I)),
    ("tool_not_allowed", re.compile(r"not in allowlist|not allowed|not in allowed list|command .*allowed|不在\s*allowlist", re.I)),
    ("schema_error", re.compile(r"arguments validation error|schema|validation error|参数.*schema|参数.*校验", re.I)),
    ("dependency_missing", re.compile(r"executable not found|not found in PATH|command not found|No such file or directory", re.I)),
    ("network_timeout", re.compile(r"timed out|timeout|SSL handshake|read operation timed out|urlopen error timed out", re.I)),
    ("permission_denied", re.compile(r"permission denied|permission_required|权限.*拒绝|permission deny", re.I)),
]

PROMPT_TEMPLATES = {
    "browser_no_tab": (
        "[Error Recovery]\n"
        "{tool} has produced {category} {repeat_count} time(s) in this run.\n"
        "Tool health: {health_key} is {health_status}. Current branch: {branch_id}.\n\n"
        "Do not retry browser-tab-dependent tools such as web_scan or web_execute_js until a browser tab is restored.\n"
        "Backtrack to the parent evidence branch and continue with a non-browser route.\n\n"
        "Recommended alternatives:\n"
        "1. web_verb_call with web.fetch / web.extract_forms when Web Verb is enabled\n"
        "2. web_fetch with browser-like headers\n"
        "3. local source route search or API/static HTML fallback"
    ),
    "mcp_path_denied": (
        "[Error Recovery]\n"
        "{tool} failed with {category} {repeat_count} time(s).\n"
        "Do not retry the same host path.\n\n"
        "Required next step:\n"
        "Move/copy/map the artifact into the MCP-visible CTF_WORKDIR or switch to a host-side tool, then retry on the visible path."
    ),
    "tool_not_allowed": (
        "[Error Recovery]\n"
        "{health_key} is blocked by the tool allowlist.\n"
        "Do not retry the same command or minor variants.\n\n"
        "Required next step:\n"
        "Use an allowed equivalent tool, refresh/search the tool index, or choose a different evidence route."
    ),
    "schema_error": (
        "[Error Recovery]\n"
        "{tool} has failed with schema_error {repeat_count} time(s).\n"
        "Do not guess tool arguments.\n\n"
        "Required next step:\n"
        "Read or refresh the current tool schema, then issue one corrected call."
    ),
    "dependency_missing": (
        "[Error Recovery]\n"
        "{health_key} is unavailable in the current runtime environment.\n"
        "Do not keep retrying the same executable path.\n\n"
        "Required next step:\n"
        "Switch to another available tool/runtime, install the dependency if allowed, or use a host-side/MCP alternative."
    ),
    "network_timeout": (
        "[Error Recovery]\n"
        "{health_key} has produced network_timeout {repeat_count} time(s).\n"
        "Limit retries on the same host/path.\n\n"
        "Recommended alternatives:\n"
        "1. Try a lower-cost API or static endpoint for the same information\n"
        "2. Use cached/local evidence or source files\n"
        "3. Ask for user help if the target service itself appears unavailable"
    ),
    "permission_denied": (
        "[Error Recovery]\n"
        "{tool} hit permission_denied.\n"
        "Do not resubmit the same action unchanged.\n\n"
        "Required next step:\n"
        "Explain the permission boundary, adjust to an allowed action, or request explicit approval when appropriate."
    ),
    "oracle_rejected": (
        "[Error Recovery]\n"
        "Flag attempt {attempt_no} was rejected by the oracle.\n"
        "This is a failed hypothesis, not a formatting hint.\n\n"
        "Do not mutate or enumerate the rejected flag.\n"
        "Before another verify_flag/check_flag call, produce new evidence with file_read, code_run, web_verb_call, or MCP analysis."
    ),
    "oracle_unknown_challenge": (
        "[Error Recovery]\n"
        "The flag oracle does not know challenge_id={challenge_id}.\n"
        "Do not claim the answer is correct.\n\n"
        "Required next step:\n"
        "Report or correct the challenge_id, then retry verification only if a valid target id is available."
    ),
    "http_error": (
        "[Error Recovery]\n"
        "{tool} observed HTTP {http_status} {repeat_count} time(s) for {health_key}.\n"
        "Treat this as target/application evidence unless repeated probes produce no new information.\n\n"
        "Required next step:\n"
        "Compare with source routes, authentication state, and expected app behavior before blind retrying paths."
    ),
    "unknown_error": (
        "[Error Recovery]\n"
        "{tool} produced an unclassified error {repeat_count} time(s).\n"
        "Current branch: {branch_id}.\n\n"
        "Required next step:\n"
        "Summarize what failed, identify whether it is a tool/environment/assumption problem, then choose a different evidence-producing action."
    ),
    "low_value_branch": (
        "[Error Recovery]\n"
        "The current branch {branch_id} is now {branch_status}: {prune_reason}\n\n"
        "Do not continue drilling into this branch unless new evidence reopens it.\n"
        "Backtrack to the parent branch and compare sibling branches before the next tool call."
    ),
}


def error_handler_enabled(parent: Any = None) -> bool:
    if str(os.environ.get(DISABLE_ENV, "")).lower() in {"1", "true", "yes", "on"}:
        return False
    if parent is None:
        return True
    return bool(getattr(parent, "error_handler_enabled", True))


def observe_tool_result(
    parent: Any,
    *,
    tool_name: str,
    args: Optional[Dict[str, Any]] = None,
    data: Any = None,
    turn: int = 0,
    branch_id: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    if not error_handler_enabled(parent):
        return None
    event = classify_tool_result(parent, tool_name=tool_name, args=args or {}, data=data, turn=turn, branch_id=branch_id)
    if event is None:
        _note_success(parent, tool_name=tool_name, turn=turn, branch_id=branch_id)
        return None
    return _record_and_decide(parent, event)


def observe_flag_result(
    parent: Any,
    *,
    result: Optional[Dict[str, Any]] = None,
    candidate: str = "",
    turn: int = 0,
    branch_id: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    if not error_handler_enabled(parent):
        return None
    result = dict(result or {})
    if result.get("correct") or result.get("status") == "correct":
        _note_success(parent, tool_name="verify_flag", turn=turn, branch_id=branch_id)
        return None
    status = str(result.get("status") or "").lower()
    if status == "unknown_challenge":
        category = "oracle_unknown_challenge"
    elif status in {"incorrect", "attempt_limit_reached", "rejected", "wrong"} or result.get("correct") is False:
        category = "oracle_rejected"
    else:
        return None
    attempt = result.get("attempt_no") or result.get("attempt") or result.get("attempts_total") or "?"
    challenge_id = str(result.get("challenge_id") or result.get("challengeId") or "")
    event = _base_event(
        parent,
        tool_name="verify_flag",
        args={"challenge_id": challenge_id, "candidate_preview": _preview(candidate or result.get("candidate_preview") or "")},
        data=result,
        turn=turn,
        branch_id=branch_id,
        category=category,
    )
    event["attempt_no"] = attempt
    event["challenge_id"] = challenge_id
    return _record_and_decide(parent, event)


def classify_tool_result(
    parent: Any,
    *,
    tool_name: str,
    args: Dict[str, Any],
    data: Any,
    turn: int = 0,
    branch_id: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    status = _status_from_data(data)
    message = _message_from_data(data)
    category = _category_from_status_and_message(tool_name, status, message, data)
    if category is None:
        return None
    return _base_event(parent, tool_name=tool_name, args=args, data=data, turn=turn, branch_id=branch_id, category=category)


def _record_and_decide(parent: Any, event: Dict[str, Any]) -> Dict[str, Any]:
    state = _state(parent)
    counts = _update_counts(state, event)
    event["program_classification"]["total_count"] = counts["total_count"]
    event["program_classification"]["consecutive_count"] = counts["consecutive_count"]
    decision = _build_decision(state, event, counts)
    event["runtime_decision"] = decision
    _append_log(parent, event)
    _write_summary(parent, state)
    _record_tree_error(parent, event, decision)
    return {"event": event, "decision": decision, "next_prompt": decision.get("next_prompt", "")}


def _base_event(
    parent: Any,
    *,
    tool_name: str,
    args: Dict[str, Any],
    data: Any,
    turn: int,
    branch_id: Optional[str],
    category: str,
) -> Dict[str, Any]:
    raw_status = _status_from_data(data)
    raw_message = _message_from_data(data)
    health_key = _health_key(tool_name, args, data, category)
    signature = _signature(tool_name, category, health_key)
    return {
        "version": VERSION,
        "ts": _utc_now(),
        "run_id": _run_id(parent),
        "branch_id": branch_id or _current_branch_id(parent),
        "raw_event": {
            "turn": int(turn or 0),
            "tool": str(tool_name or ""),
            "raw_status": raw_status,
            "raw_message": _preview(raw_message, MAX_MESSAGE),
            "args_preview": _sanitize(args or {}),
            "data_preview": _preview_data(data),
        },
        "program_classification": {
            "category": category,
            "signature": signature,
            "severity": _severity(category),
            "health_key": health_key,
        },
        "llm_annotation": None,
        "runtime_decision": {},
    }


def _build_decision(state: Dict[str, Any], event: Dict[str, Any], counts: Dict[str, int]) -> Dict[str, Any]:
    pc = event["program_classification"]
    category = pc["category"]
    health_key = pc["health_key"]
    repeat = counts["total_count"]
    consecutive = counts["consecutive_count"]
    branch_id = event.get("branch_id") or "unknown"
    status = _tool_health_status(category, repeat, consecutive)
    health = {
        "scope": "run",
        "status": status,
        "category": category,
        "count": repeat,
        "consecutive_count": consecutive,
        "reason": _reason_for(category, event),
        "last_turn": event["raw_event"].get("turn", 0),
    }
    if status in {"degraded", "cooldown"}:
        health["expires_at_turn"] = int(event["raw_event"].get("turn") or 0) + 6
    state.setdefault("tool_health", {})[health_key] = health

    branch_status = ""
    prune_reason = ""
    action = _action_for(category, status)
    if category in {"browser_no_tab", "network_timeout", "unknown_error"} and repeat >= 5:
        branch_status = "low_value"
        prune_reason = f"{category} repeated {repeat} time(s) without useful evidence."
    if category == "unknown_error" and consecutive >= 7:
        branch_status = "abandoned"
        prune_reason = f"{category} repeated {consecutive} consecutive time(s)."

    template_key = "low_value_branch" if branch_status == "abandoned" else category
    next_prompt = _format_prompt(
        template_key,
        event,
        repeat_count=repeat,
        consecutive_count=consecutive,
        health_status=status,
        branch_status=branch_status or "active",
        prune_reason=prune_reason,
    )
    return {
        "action": action,
        "tool_health_key": health_key,
        "tool_health_status": status,
        "tool_health": health,
        "branch_status": branch_status,
        "prune_reason": prune_reason,
        "next_prompt": next_prompt,
        "next_prompt_injected": bool(next_prompt),
    }


def _format_prompt(template_key: str, event: Dict[str, Any], **values: Any) -> str:
    category = event["program_classification"]["category"]
    template = PROMPT_TEMPLATES.get(template_key) or PROMPT_TEMPLATES.get(category) or PROMPT_TEMPLATES["unknown_error"]
    raw = event.get("raw_event") or {}
    pc = event.get("program_classification") or {}
    data_preview = raw.get("data_preview") or {}
    vals = {
        "tool": raw.get("tool") or "",
        "category": category,
        "repeat_count": values.get("repeat_count") or 1,
        "consecutive_count": values.get("consecutive_count") or 1,
        "branch_id": event.get("branch_id") or "unknown",
        "branch_status": values.get("branch_status") or "active",
        "health_key": pc.get("health_key") or raw.get("tool") or "",
        "health_status": values.get("health_status") or "observed",
        "attempt_no": event.get("attempt_no") or "?",
        "challenge_id": event.get("challenge_id") or "",
        "http_status": data_preview.get("status_code") or data_preview.get("http_status") or "",
        "prune_reason": values.get("prune_reason") or "",
    }
    return template.format(**vals)


def _update_counts(state: Dict[str, Any], event: Dict[str, Any]) -> Dict[str, int]:
    signature = event["program_classification"]["signature"]
    turn = int((event.get("raw_event") or {}).get("turn") or 0)
    by_sig = state.setdefault("errors_by_signature", {})
    current = by_sig.get(signature) or {
        "category": event["program_classification"]["category"],
        "first_turn": turn,
        "total_count": 0,
        "consecutive_count": 0,
    }
    current["total_count"] = int(current.get("total_count") or 0) + 1
    if state.get("last_signature") == signature:
        current["consecutive_count"] = int(current.get("consecutive_count") or 0) + 1
    else:
        current["consecutive_count"] = 1
    current["last_turn"] = turn
    by_sig[signature] = current
    state["last_signature"] = signature

    branch_id = event.get("branch_id") or "unknown"
    branch = state.setdefault("branches", {}).setdefault(branch_id, {"error_count": 0, "no_progress_count": 0})
    branch["error_count"] = int(branch.get("error_count") or 0) + 1
    branch["no_progress_count"] = int(branch.get("no_progress_count") or 0) + 1
    branch["last_error"] = event["program_classification"]["category"]
    branch["last_turn"] = turn

    return {"total_count": current["total_count"], "consecutive_count": current["consecutive_count"]}


def _note_success(parent: Any, *, tool_name: str, turn: int = 0, branch_id: Optional[str] = None) -> None:
    if parent is None:
        return
    state = _state(parent)
    branch = state.setdefault("branches", {}).setdefault(branch_id or _current_branch_id(parent), {"error_count": 0, "no_progress_count": 0})
    branch["no_progress_count"] = 0
    branch["last_success_tool"] = str(tool_name or "")
    branch["last_success_turn"] = int(turn or 0)


def _record_tree_error(parent: Any, event: Dict[str, Any], decision: Dict[str, Any]) -> None:
    try:
        from task_tree import record_error_event

        record_error_event(parent, event=event, decision=decision)
    except Exception:
        return


def _append_log(parent: Any, event: Dict[str, Any]) -> None:
    path = _log_path(parent)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")


def _write_summary(parent: Any, state: Dict[str, Any]) -> None:
    path = _summary_path(parent)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": VERSION,
        "updated_at": _utc_now(),
        "run_id": _run_id(parent),
        "errors_by_signature": state.get("errors_by_signature") or {},
        "tool_health": state.get("tool_health") or {},
        "branches": state.get("branches") or {},
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")


def _state(parent: Any) -> Dict[str, Any]:
    current = getattr(parent, "error_handler_state", None)
    if isinstance(current, dict):
        return current
    current = {"version": VERSION, "errors_by_signature": {}, "tool_health": {}, "branches": {}}
    if parent is not None:
        setattr(parent, "error_handler_state", current)
        setattr(parent, "error_log_path", str(_log_path(parent)))
        setattr(parent, "error_summary_path", str(_summary_path(parent)))
    return current


def _category_from_status_and_message(tool_name: str, status: str, message: str, data: Any) -> Optional[str]:
    status_l = str(status or "").lower()
    message_l = str(message or "")
    if status_l in {"permission_denied", "permission_required"}:
        return "permission_denied"
    for category, pattern in KNOWN_PATTERNS:
        if pattern.search(message_l):
            return category
    http_status = _http_status(data)
    if http_status and http_status >= 400:
        return "http_error"
    if status_l in ERROR_STATUSES:
        return "unknown_error"
    return None


def _tool_health_status(category: str, repeat: int, consecutive: int) -> str:
    if category in {"tool_not_allowed", "permission_denied"}:
        return "blocked"
    if category == "mcp_path_denied":
        return "blocked" if repeat >= 2 else "observed"
    if category == "schema_error":
        return "needs_schema" if repeat >= 2 else "observed"
    if category in {"dependency_missing", "browser_no_tab"}:
        return "degraded" if repeat >= 2 else "observed"
    if category == "network_timeout":
        return "degraded" if repeat >= 3 else "observed"
    if category == "oracle_rejected":
        return "observed"
    if category == "http_error":
        return "degraded" if repeat >= 5 else "observed"
    if repeat >= 3:
        return "degraded"
    return "observed"


def _action_for(category: str, health_status: str) -> str:
    if category == "oracle_rejected":
        return "recover_evidence_chain"
    if category == "schema_error":
        return "refresh_schema"
    if category == "tool_not_allowed":
        return "switch_allowed_tool"
    if category == "mcp_path_denied":
        return "move_into_workdir"
    if health_status in {"blocked", "degraded", "needs_schema"}:
        return "degrade_tool_and_backtrack"
    return "record_and_continue"


def _severity(category: str) -> str:
    if category in {"tool_not_allowed", "permission_denied", "dependency_missing"}:
        return "hard"
    if category in {"oracle_rejected", "schema_error", "mcp_path_denied"}:
        return "recoverable"
    return "soft"


def _reason_for(category: str, event: Dict[str, Any]) -> str:
    message = ((event.get("raw_event") or {}).get("raw_message") or "").strip()
    if message:
        return _preview(message, 220)
    return f"{category} observed in {((event.get('raw_event') or {}).get('tool') or 'tool')}"


def _signature(tool_name: str, category: str, health_key: str) -> str:
    return f"{tool_name}:{category}:{health_key}"


def _health_key(tool_name: str, args: Dict[str, Any], data: Any, category: str) -> str:
    name = str(tool_name or "tool")
    command = _command_name(args)
    host = _host_from_args_or_data(args, data)
    if category == "tool_not_allowed" and command:
        return f"{name}:{command}"
    if category == "dependency_missing" and command:
        return f"command:{command}"
    if category == "network_timeout" and host:
        return f"host:{host}"
    if category == "http_error":
        status = _http_status(data) or "http"
        return f"{host or name}:http_{status}"
    if category == "mcp_path_denied":
        return f"{name}:outside_workdir"
    if category == "browser_no_tab":
        return "browser_tabs"
    return name


def _command_name(args: Dict[str, Any]) -> str:
    for key in ("command", "cmd", "tool", "program"):
        value = args.get(key)
        if value:
            if isinstance(value, list):
                return str(value[0]) if value else ""
            return str(value).strip().split()[0]
    script = str(args.get("script") or "")
    if script.strip():
        return script.strip().split()[0]
    return ""


def _host_from_args_or_data(args: Dict[str, Any], data: Any) -> str:
    candidates = []
    for key in ("url", "base_url", "source_url"):
        candidates.append(args.get(key))
    if isinstance(data, dict):
        for key in ("url", "source_url", "base_url"):
            candidates.append(data.get(key))
        nested = data.get("data")
        if isinstance(nested, dict):
            for key in ("url", "source_url", "base_url"):
                candidates.append(nested.get(key))
    for value in candidates:
        host = _host(value)
        if host:
            return host
    return ""


def _host(value: Any) -> str:
    text = str(value or "").strip()
    if not text or "://" not in text:
        return ""
    try:
        parsed = urllib.parse.urlparse(text)
    except Exception:
        return ""
    return parsed.netloc.lower()


def _http_status(data: Any) -> int:
    if isinstance(data, dict):
        for key in ("status_code", "http_status"):
            try:
                value = int(data.get(key) or 0)
            except Exception:
                value = 0
            if value:
                return value
        nested = data.get("data")
        if isinstance(nested, dict):
            return _http_status(nested)
    return 0


def _status_from_data(data: Any) -> str:
    if isinstance(data, dict):
        status = str(data.get("status") or data.get("result") or "").strip().lower()
        if status:
            return status
        if data.get("correct") is False:
            return "incorrect"
    if data is None:
        return "empty"
    return "success"


def _message_from_data(data: Any) -> str:
    if isinstance(data, dict):
        parts = []
        for key in ("msg", "message", "error", "reason", "stderr", "stdout", "content"):
            if data.get(key):
                parts.append(str(data.get(key)))
        nested = data.get("data")
        if isinstance(nested, dict):
            for key in ("msg", "message", "error", "text_preview", "preview"):
                if nested.get(key):
                    parts.append(str(nested.get(key)))
        return "\n".join(parts)[:8000]
    return str(data or "")[:8000]


def _preview_data(data: Any) -> Any:
    if isinstance(data, dict):
        out = {}
        for key in ("status", "result", "msg", "message", "error", "reason", "status_code", "http_status", "trace_id", "full_result_path"):
            if key in data:
                out[key] = _sanitize(data.get(key))
        nested = data.get("data")
        if isinstance(nested, dict):
            for key in ("status_code", "http_status", "url", "content_type", "trace_id"):
                if key in nested and key not in out:
                    out[key] = _sanitize(nested.get(key))
        return out
    return _preview(data)


def _sanitize(value: Any) -> Any:
    if isinstance(value, dict):
        out = {}
        for key, child in value.items():
            if str(key).lower() in SECRET_KEYS:
                out[key] = _secret_preview(child)
            else:
                out[key] = _sanitize(child)
        return out
    if isinstance(value, list):
        return [_sanitize(item) for item in value[:20]]
    if isinstance(value, tuple):
        return [_sanitize(item) for item in value[:20]]
    return _preview(value)


def _secret_preview(value: Any) -> str:
    text = str(value or "")
    if not text:
        return ""
    digest = hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:10]
    return f"<redacted:{len(text)}:{digest}>"


def _preview(value: Any, limit: int = MAX_PREVIEW) -> str:
    text = str(value or "")
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit] + ("..." if len(text) > limit else "")


def _run_dir(parent: Any) -> Path:
    if parent is not None:
        for attr in ("task_dir",):
            value = getattr(parent, attr, None)
            if value:
                return Path(str(value)).expanduser().resolve(strict=False)
        tree_path = getattr(parent, "task_tree_path", None)
        if tree_path:
            return Path(str(tree_path)).expanduser().resolve(strict=False).parent
        project_root = getattr(parent, "project_root", None)
        run_id = _run_id(parent)
        if project_root:
            return Path(str(project_root)).expanduser().resolve(strict=False) / "temp" / "error_logs" / run_id
    return Path.cwd() / "temp" / "error_logs" / "default"


def _log_path(parent: Any) -> Path:
    return _run_dir(parent) / "error_log.jsonl"


def _summary_path(parent: Any) -> Path:
    return _run_dir(parent) / "error_summary.json"


def _run_id(parent: Any) -> str:
    for attr in ("oracle_run_id", "run_id", "session_id"):
        value = getattr(parent, attr, None) if parent is not None else None
        if value:
            return re.sub(r"[^A-Za-z0-9_.:-]+", "_", str(value))[:80]
    return "run"


def _current_branch_id(parent: Any) -> str:
    state = getattr(parent, "task_tree_state", None) if parent is not None else None
    if isinstance(state, dict):
        return str(state.get("current_node_id") or "unknown")
    return "unknown"


def _utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
