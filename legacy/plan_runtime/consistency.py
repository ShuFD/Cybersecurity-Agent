from __future__ import annotations

import hashlib
import json
import os
import urllib.parse
import uuid
from typing import Any, Dict, Optional

from .models import utc_now


CONTROL_TOOLS = {"plan_expand", "plan_revise", "plan_status"}
EXPLORATORY_TOOLS = {
    "file_read",
    "grep_search",
    "list_files",
    "memory_search",
    "mcp_refresh",
    "tool_search",
    "web_fetch",
    "web_scan",
    "web_verb_call",
}
INTERNAL_ARG_KEYS = {"_index", "_tool_num"}


def _normalize_url(value: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError:
        return value
    if not parsed.scheme or not parsed.netloc:
        return value
    query = urllib.parse.urlencode(sorted(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)))
    path = parsed.path or "/"
    return urllib.parse.urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), path, query, ""))


def _normalize_value(key: str, value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): _normalize_value(str(k), v) for k, v in sorted(value.items()) if str(k) not in INTERNAL_ARG_KEYS}
    if isinstance(value, list):
        return [_normalize_value(key, item) for item in value]
    if isinstance(value, tuple):
        return [_normalize_value(key, item) for item in value]
    if isinstance(value, str):
        text = value.strip()
        if key.lower() in {"url", "base_url", "source_url", "action"}:
            return _normalize_url(text)
        if key.lower() in {"path", "file", "filename", "file_path", "cwd", "target"}:
            return os.path.normpath(text).replace("\\", "/")
        return text
    return value


def normalize_args(args: Dict[str, Any]) -> Dict[str, Any]:
    return {
        str(key): _normalize_value(str(key), value)
        for key, value in sorted((args or {}).items())
        if str(key) not in INTERNAL_ARG_KEYS
    }


def args_digest(tool_name: str, args: Dict[str, Any]) -> str:
    payload = json.dumps([str(tool_name or ""), normalize_args(args)], ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode("utf-8", errors="replace")).hexdigest()[:16]


def _args_match(expected: Dict[str, Any], actual: Dict[str, Any]) -> bool:
    expected_n = normalize_args(expected)
    actual_n = normalize_args(actual)
    return all(actual_n.get(key) == value for key, value in expected_n.items())


def matching_runnable_node(state: Dict[str, Any], tool_name: str, args: Dict[str, Any]) -> Optional[str]:
    candidates = []
    for node_id in state.get("runtime", {}).get("runnable_node_ids") or []:
        node = state.get("nodes", {}).get(node_id) or {}
        if node.get("status") != "runnable":
            continue
        action = node.get("action") or {}
        if action.get("tool") == tool_name:
            candidates.append((node_id, action.get("args") or {}))
    exact = [node_id for node_id, expected in candidates if _args_match(expected, args)]
    if exact:
        return exact[0]
    if len(candidates) == 1 and not candidates[0][1]:
        return candidates[0][0]
    return None


def _is_exploratory(tool_name: str, args: Dict[str, Any]) -> bool:
    if tool_name in EXPLORATORY_TOOLS:
        return True
    lowered = str(tool_name or "").lower()
    if lowered.startswith("mcp__"):
        return any(
            marker in lowered
            for marker in ("identify", "file", "checksec", "strings", "binwalk", "metadata", "readelf", "headers", "routes")
        )
    return False


def classify_tool_call(state: Dict[str, Any], *, tool_name: str, args: Dict[str, Any], turn: int = 0) -> Dict[str, Any]:
    tool_name = str(tool_name or "")
    digest = args_digest(tool_name, args)
    matched = matching_runnable_node(state, tool_name, args)
    if tool_name in CONTROL_TOOLS:
        classification = "control"
    elif matched:
        classification = "planned"
    else:
        previous = next(
            (
                item
                for item in reversed(state.get("executions") or [])
                if item.get("args_digest") == digest and item.get("status") in {"completed", "failed", "no_progress"}
            ),
            None,
        )
        if previous and int(previous.get("new_fact_count") or 0) == 0:
            classification = "repeated"
        elif _is_exploratory(tool_name, args):
            classification = "exploratory"
        else:
            classification = "deviation"
    return {
        "execution_id": "exec_" + uuid.uuid4().hex[:12],
        "classification": classification,
        "tool": tool_name,
        "args": normalize_args(args),
        "args_digest": digest,
        "turn": int(turn or 0),
        "matched_node_id": matched,
        "current_node_id": (state.get("runtime") or {}).get("current_node_id"),
        "status": "started",
        "started_at": utc_now(),
    }


def build_replan_hint(
    *, classification: str, changed_fact_keys: list[str], newly_runnable: list[str], current_node_id: Optional[str]
) -> Dict[str, Any]:
    if classification == "repeated":
        return {
            "replan_needed": True,
            "reason": "repeated_without_new_facts",
            "suggested_action": "plan_revise",
            "suggested_parent_id": current_node_id,
        }
    if classification in {"exploratory", "deviation"} and changed_fact_keys:
        return {
            "replan_needed": True,
            "reason": "new_evidence_from_unplanned_action",
            "new_facts": changed_fact_keys,
            "newly_runnable": newly_runnable,
            "suggested_action": "plan_expand",
            "suggested_parent_id": "investigation_body",
        }
    if newly_runnable:
        return {
            "replan_needed": False,
            "reason": "existing_branch_unlocked",
            "newly_runnable": newly_runnable,
        }
    return {"replan_needed": False, "reason": "no_plan_change"}
