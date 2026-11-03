from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from functools import wraps
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from task_descriptor import TaskDescriptor, coerce_task_descriptor


VERSION = 1
DISABLE_ENV = "SECHEUR_DISABLE_TASK_TREE"
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
_STATE_LOCKS: Dict[str, threading.RLock] = {}
_STATE_LOCKS_GUARD = threading.Lock()


def _mutation_lock(state: Optional[Dict[str, Any]], parent: Any = None) -> threading.RLock:
    path = str((state or {}).get("path") or f"parent:{id(parent)}")
    key = str(Path(path).resolve(strict=False)) if not path.startswith("parent:") else path
    with _STATE_LOCKS_GUARD:
        return _STATE_LOCKS.setdefault(key, threading.RLock())


def _serialized_tree_mutation(func):
    @wraps(func)
    def wrapped(parent: Any, *args: Any, **kwargs: Any):
        state = _state_from(parent)
        with _mutation_lock(state, parent):
            return func(parent, *args, **kwargs)

    return wrapped


def task_tree_enabled(parent: Any = None) -> bool:
    if str(os.environ.get(DISABLE_ENV, "")).lower() in {"1", "true", "yes", "on"}:
        return False
    if parent is None:
        return True
    return bool(getattr(parent, "task_tree_enabled", False))


def initialize_task_tree(
    prompt: Any,
    *,
    task_descriptor: Optional[TaskDescriptor] = None,
    run_dir: Optional[str] = None,
    project_root: Optional[str] = None,
    tool_experience_context: Optional[Dict[str, Any]] = None,
    web_verb_context: Optional[Dict[str, Any]] = None,
    enabled: bool = True,
) -> Dict[str, Any]:
    """Create a structured evidence tree for one agent task.

    The tree is intentionally simple: it records task-level branches and
    automatic evidence nodes. The model receives the operating rules in its
    prompt, while the runtime persists events for later inspection.
    """
    root_dir = _state_dir(run_dir=run_dir, project_root=project_root)
    root_dir.mkdir(parents=True, exist_ok=True)
    path = root_dir / "task_tree.json"
    events_path = root_dir / "task_tree_events.jsonl"
    now = _utc_now()
    prompt_text = str(prompt or "")
    prompt_preview = _preview(prompt_text, 1000)
    prompt_digest = hashlib.sha256(prompt_text.encode("utf-8", errors="replace")).hexdigest()[:16]
    descriptor = coerce_task_descriptor(
        task_descriptor,
        prompt=prompt_text,
        project_root=project_root,
        task_dir=run_dir,
    )

    state: Dict[str, Any] = {
        "version": VERSION,
        "enabled": bool(enabled),
        "created_at": now,
        "updated_at": now,
        "path": str(path),
        "events_path": str(events_path),
        "project_root": str(project_root or ""),
        "prompt_digest": prompt_digest,
        "prompt_preview": prompt_preview,
        "task_descriptor": descriptor.to_dict(),
        "root_id": "root",
        "current_node_id": "collect_evidence",
        "oracle": {"attempts": 0, "last_status": ""},
        "nodes": [
            {
                "id": "root",
                "parent_id": None,
                "kind": "root",
                "title": f"Solve {descriptor.identity.target_id or descriptor.identity.title or 'the task'}",
                "status": "active",
                "goal": "Solve the task using evidence, then verify any final flag with the oracle.",
                "created_at": now,
                "updated_at": now,
                "evidence": [],
            },
            {
                "id": "collect_evidence",
                "parent_id": "root",
                "kind": "evidence",
                "title": "Collect and check evidence",
                "status": "active",
                "goal": "Identify assets, entry points, constraints, and reproducible observations before deriving a flag.",
                "created_at": now,
                "updated_at": now,
                "evidence": [],
            },
            {
                "id": "derive_candidate",
                "parent_id": "root",
                "kind": "hypothesis",
                "title": "Derive candidate from evidence",
                "status": "pending",
                "goal": "Turn verified evidence into one supported candidate answer.",
                "created_at": now,
                "updated_at": now,
                "evidence": [],
            },
            {
                "id": "verify_candidate",
                "parent_id": "root",
                "kind": "oracle",
                "title": "Verify candidate flag",
                "status": "pending",
                "goal": "Call verify_flag/check_flag exactly when a candidate is evidence-backed.",
                "created_at": now,
                "updated_at": now,
                "evidence": [],
            },
        ],
        "events": [],
    }

    _attach_tool_experience_branch(state, tool_experience_context)
    _attach_web_verb_branch(state, web_verb_context)
    _write_state(state)
    _append_event(state, "tree_initialized", {"prompt_digest": prompt_digest})
    return state


def bind_tree_to_parent(parent: Any, state: Optional[Dict[str, Any]]) -> None:
    if parent is None or not state:
        return
    setattr(parent, "task_tree_state", state)
    setattr(parent, "task_tree_path", state.get("path"))
    setattr(parent, "task_tree_events_path", state.get("events_path"))


def format_task_tree_prompt(state: Optional[Dict[str, Any]]) -> str:
    if not state or not state.get("enabled"):
        return ""
    branches = []
    for node in state.get("nodes") or []:
        if node.get("parent_id") not in {"root", "collect_evidence"}:
            continue
        prefix = "- " if node.get("parent_id") == "root" else "  - "
        detail = ""
        if node.get("recommended_tools"):
            detail += " tools=" + ", ".join(node.get("recommended_tools")[:8])
        if node.get("recommended_verbs"):
            detail += " verbs=" + ", ".join(node.get("recommended_verbs")[:8])
        branches.append(f"{prefix}{node.get('id')}: {node.get('title')} [{node.get('status')}]{detail}")
    descriptor = state.get("task_descriptor") or {}
    identity = descriptor.get("identity") or {}
    classification = descriptor.get("classification") or {}
    endpoints = descriptor.get("endpoints") or []
    endpoint_text = ", ".join(
        str(item.get("raw") or item.get("url") or "") for item in endpoints[:3] if isinstance(item, dict)
    )
    assets = descriptor.get("assets") or []
    asset_text = ", ".join(str(item.get("path") or "") for item in assets[:3] if isinstance(item, dict))
    task_lines = [
        f"Task descriptor: target_id={identity.get('target_id') or '(unknown)'}; "
        f"category={classification.get('category') or 'generic'}; mode={descriptor.get('mode') or 'unknown'}",
    ]
    if endpoint_text:
        task_lines.append(f"Declared endpoints: {endpoint_text}")
    if asset_text:
        task_lines.append(f"Declared assets: {asset_text}")
    return "\n".join(
        [
            "[Structured Evidence Task Tree]",
            "A task-tree controller is enabled for this run. It complements, but does not replace, plan.md Plan Mode.",
            f"State file: {state.get('path')}",
            f"Events file: {state.get('events_path')}",
            *task_lines,
            "Initial branches:",
            *branches,
            "Operating rules:",
            "1. Treat every child node as a hypothesis or evidence checkpoint.",
            "2. If a child action fails, return to its parent, name the failed assumption, and choose a different child or tool route.",
            "3. A rejected flag is not a signal to mutate or enumerate flags. It fails the current hypothesis and opens a recovery child under evidence collection.",
            "4. Before another flag attempt, add new evidence with a non-trivial tool action and revise the evidence chain.",
            "5. For Web tasks, use recommended Web Verbs when the Web Verb switch is enabled.",
        ]
    )


def format_task_tree_status_prompt(parent: Any = None, state: Optional[Dict[str, Any]] = None) -> str:
    state = _state_from(parent, state)
    if not state or not state.get("enabled"):
        return ""
    current = _node_by_id(state, state.get("current_node_id")) or _node_by_id(state, "root") or {}
    recent = list(state.get("events") or [])[-5:]
    lines = [
        "[Task Tree Status]",
        f"Current node: {current.get('id', 'root')} / {current.get('title', 'root')} / status={current.get('status', 'active')}",
        f"Active path: {' > '.join(active_path(state, current.get('id') or 'root'))}",
    ]
    attempts = ((state.get("oracle") or {}).get("attempts")) or 0
    if attempts:
        lines.append(f"Oracle attempts so far: {attempts}; last_status={(state.get('oracle') or {}).get('last_status') or 'unknown'}")
    if recent:
        bits = []
        for event in recent:
            detail = event.get("detail") or {}
            bits.append(f"{event.get('type')}:{detail.get('tool') or detail.get('status') or detail.get('node_id') or ''}".rstrip(":"))
        lines.append("Recent tree events: " + "; ".join(bits))
    lines.append("Next step must either add evidence to the current node or explicitly backtrack to its parent with the reason.")
    return "\n".join(lines)


@_serialized_tree_mutation
def record_tool_result(
    parent: Any,
    *,
    tool_name: str,
    args: Optional[Dict[str, Any]] = None,
    data: Any = None,
    turn: int = 0,
    useful_progress: Optional[bool] = None,
) -> Dict[str, Any]:
    state = _state_from(parent)
    if not state or not state.get("enabled") or str(tool_name or "") in {"no_tool", "verify_flag", "check_flag"}:
        return {"status": "disabled"}

    status = _status_from_data(data)
    parent_id = _tool_parent_id(state, tool_name)
    failed = status in {"error", "failed", "permission_denied", "permission_required", "blocked", "stale_file"}
    node_id = _unique_node_id(state, f"tool_{_safe_id(tool_name)}")
    node = {
        "id": node_id,
        "parent_id": parent_id,
        "kind": "tool",
        "title": f"{tool_name} result",
        "status": "failed" if failed else "done",
        "tool": str(tool_name or ""),
        "turn": int(turn or 0),
        "args_preview": _sanitize(args or {}),
        "result_status": status,
        "result_preview": _preview_result(data),
        "created_at": _utc_now(),
        "updated_at": _utc_now(),
        "evidence": [],
        "useful_progress": useful_progress,
    }
    state.setdefault("nodes", []).append(node)
    if failed:
        state["current_node_id"] = parent_id
        note = (
            f"[Task Tree] Child node {node_id} failed under parent {parent_id}. "
            "Backtrack to the parent, name the failed assumption, and choose a different evidence-producing route."
        )
    elif useful_progress is False:
        parent_node = _node_by_id(state, parent_id)
        if parent_node:
            parent_node["no_progress_count"] = int(parent_node.get("no_progress_count") or 0) + 1
            parent_node["updated_at"] = _utc_now()
        note = ""
    else:
        parent_node = _node_by_id(state, parent_id)
        if parent_node:
            parent_node["useful_evidence_count"] = int(parent_node.get("useful_evidence_count") or 0) + 1
            parent_node["no_progress_count"] = 0
            parent_node["updated_at"] = _utc_now()
        _activate_node(state, parent_id)
        note = ""
    _touch(state)
    _write_state(state)
    _append_event(
        state,
        "tool_result",
        {
            "node_id": node_id,
            "parent_id": parent_id,
            "tool": str(tool_name or ""),
            "status": status,
            "turn": int(turn or 0),
            "useful_progress": useful_progress,
        },
    )
    return {"status": "recorded", "node_id": node_id, "parent_id": parent_id, "failed": failed, "next_prompt": note}


@_serialized_tree_mutation
def record_flag_result(
    parent: Any,
    *,
    result: Optional[Dict[str, Any]] = None,
    candidate: str = "",
    turn: int = 0,
) -> Dict[str, Any]:
    state = _state_from(parent)
    if not state or not state.get("enabled"):
        return {"status": "disabled"}
    result = dict(result or {})
    correct = bool(result.get("correct") or result.get("status") == "correct")
    attempt = result.get("attempt_no") or result.get("attempt") or result.get("attempts_total")
    try:
        attempt_i = int(attempt)
    except Exception:
        attempt_i = int(((state.get("oracle") or {}).get("attempts") or 0) + 1)
    status = "correct" if correct else str(result.get("status") or "incorrect")
    state["oracle"] = {"attempts": max(attempt_i, int(((state.get("oracle") or {}).get("attempts") or 0))), "last_status": status}

    verify_parent = "verify_candidate"
    node_id = _unique_node_id(state, f"flag_attempt_{attempt_i}")
    state.setdefault("nodes", []).append(
        {
            "id": node_id,
            "parent_id": verify_parent,
            "kind": "flag_attempt",
            "title": f"Flag attempt {attempt_i}",
            "status": "done" if correct else "failed",
            "turn": int(turn or 0),
            "candidate_preview": _preview(candidate or result.get("candidate_preview") or result.get("candidatePreview") or "", 120),
            "oracle_status": status,
            "created_at": _utc_now(),
            "updated_at": _utc_now(),
            "evidence": [],
        }
    )
    _mark_node(state, verify_parent, "done" if correct else "pending")
    if correct:
        _mark_node(state, "root", "solved")
        state["current_node_id"] = node_id
        note = "[Task Tree] Oracle accepted the flag. Mark the root solved and stop."
    else:
        recovery_id = _unique_node_id(state, f"recovery_after_attempt_{attempt_i}")
        state.setdefault("nodes", []).append(
            {
                "id": recovery_id,
                "parent_id": "collect_evidence",
                "kind": "recovery",
                "title": f"Recover after rejected flag attempt {attempt_i}",
                "status": "active",
                "goal": "Audit the evidence chain, identify the failed assumption, and gather fresh evidence before any new flag attempt.",
                "turn": int(turn or 0),
                "rejected_attempt_node": node_id,
                "created_at": _utc_now(),
                "updated_at": _utc_now(),
                "evidence": [],
            }
        )
        _activate_node(state, "collect_evidence")
        state["current_node_id"] = recovery_id
        note = (
            f"[Task Tree] Oracle rejected attempt {attempt_i}. Node {node_id} is failed; "
            f"continue in recovery node {recovery_id} under collect_evidence. "
            "Do not mutate the rejected flag. Rebuild the evidence chain and run a non-trivial evidence tool first."
        )
    _touch(state)
    _write_state(state)
    _append_event(
        state,
        "flag_result",
        {"node_id": node_id, "status": status, "correct": correct, "attempt": attempt_i, "turn": int(turn or 0)},
    )
    return {"status": "recorded", "node_id": node_id, "correct": correct, "next_prompt": note}


def active_path(state: Dict[str, Any], node_id: str) -> List[str]:
    nodes = {node.get("id"): node for node in state.get("nodes") or []}
    out = []
    seen = set()
    current = nodes.get(node_id)
    while current and current.get("id") not in seen:
        seen.add(current.get("id"))
        out.append(str(current.get("id")))
        parent_id = current.get("parent_id")
        current = nodes.get(parent_id)
    return list(reversed(out)) or ["root"]


@_serialized_tree_mutation
def record_error_event(parent: Any, *, event: Dict[str, Any], decision: Dict[str, Any]) -> Dict[str, Any]:
    state = _state_from(parent)
    if not state or not state.get("enabled"):
        return {"status": "disabled"}
    event = event if isinstance(event, dict) else {}
    decision = decision if isinstance(decision, dict) else {}
    branch_id = str(event.get("branch_id") or state.get("current_node_id") or "collect_evidence")
    node = _node_by_id(state, branch_id) or _node_by_id(state, "collect_evidence")
    if node is None:
        return {"status": "missing_node"}

    pc = event.get("program_classification") or {}
    raw = event.get("raw_event") or {}
    category = str(pc.get("category") or "unknown_error")
    node["error_count"] = int(node.get("error_count") or 0) + 1
    node["no_progress_count"] = int(node.get("no_progress_count") or 0) + 1
    node["last_error"] = category
    node["value_score"] = max(0.0, round(float(node.get("value_score", 1.0)) - _error_penalty(category), 3))
    errors = list(node.get("errors") or [])
    errors.append(
        {
            "ts": event.get("ts") or _utc_now(),
            "turn": raw.get("turn"),
            "tool": raw.get("tool"),
            "category": category,
            "signature": pc.get("signature"),
            "health_key": pc.get("health_key"),
            "message": raw.get("raw_message"),
        }
    )
    node["errors"] = errors[-12:]

    branch_status = str(decision.get("branch_status") or "")
    if branch_status in {"low_value", "abandoned"}:
        node["status"] = branch_status
        node["prune_reason"] = decision.get("prune_reason") or f"{category} repeated without useful evidence."
        if branch_status == "abandoned":
            parent_id = node.get("parent_id") or "root"
            if _node_by_id(state, parent_id):
                state["current_node_id"] = parent_id
    node["updated_at"] = _utc_now()
    _touch(state)
    _write_state(state)
    _append_event(
        state,
        "error_event",
        {
            "node_id": node.get("id"),
            "tool": raw.get("tool"),
            "category": category,
            "health_key": pc.get("health_key"),
            "branch_status": branch_status,
            "turn": raw.get("turn"),
        },
    )
    return {"status": "recorded", "node_id": node.get("id"), "branch_status": branch_status}


def _attach_tool_experience_branch(state: Dict[str, Any], context: Optional[Dict[str, Any]]) -> None:
    if not context or not context.get("enabled"):
        return
    recommendations = context.get("recommendations") or {}
    fingerprint = context.get("fingerprint") or {}
    now = _utc_now()
    state.setdefault("nodes", []).append(
        {
            "id": "tool_experience",
            "parent_id": "collect_evidence",
            "kind": "control",
            "title": "Reuse fingerprint-matched tool experience",
            "status": "pending",
            "goal": "Use challenge-intrinsic fingerprint matches to select skills, MCP tools, and built-in tools.",
            "fingerprint_digest": fingerprint.get("digest"),
            "fingerprint_traits": list(fingerprint.get("traits") or [])[:20],
            "recommended_tools": list(recommendations.get("tools") or [])[:16],
            "recommended_mcp_tools": list(recommendations.get("mcp_tools") or [])[:16],
            "recommended_skills": list(recommendations.get("skills") or [])[:12],
            "created_at": now,
            "updated_at": now,
            "evidence": [],
        }
    )


def _attach_web_verb_branch(state: Dict[str, Any], context: Optional[Dict[str, Any]]) -> None:
    if not context or not context.get("enabled") or not context.get("is_web_task"):
        return
    now = _utc_now()
    state.setdefault("nodes", []).append(
        {
            "id": "web_verbs",
            "parent_id": "collect_evidence",
            "kind": "control",
            "title": "Use typed Web Verb actions",
            "status": "pending",
            "goal": "Prefer structured Web Verb calls for Web/HTTP/browser evidence before ad-hoc low-level probing.",
            "web_digest": context.get("digest"),
            "web_traits": list(context.get("traits") or [])[:20],
            "urls": list(context.get("urls") or [])[:12],
            "recommended_tools": list(context.get("recommended_tools") or [])[:8],
            "recommended_verbs": list(context.get("recommended_verbs") or [])[:16],
            "created_at": now,
            "updated_at": now,
            "evidence": [],
        }
    )


def _state_from(parent: Any = None, state: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    if state:
        return state
    if parent is None or not task_tree_enabled(parent):
        return None
    current = getattr(parent, "task_tree_state", None)
    if isinstance(current, dict):
        return current
    path = getattr(parent, "task_tree_path", None)
    if path:
        try:
            loaded = json.loads(Path(path).read_text(encoding="utf-8"))
            setattr(parent, "task_tree_state", loaded)
            return loaded
        except Exception:
            return None
    return None


def _tool_parent_id(state: Dict[str, Any], tool_name: str) -> str:
    name = str(tool_name or "")
    if name == "web_verb_call" and _node_by_id(state, "web_verbs"):
        return "web_verbs"
    if name in {"mcp_refresh", "skill", "tool_search"} and _node_by_id(state, "tool_experience"):
        return "tool_experience"
    current = state.get("current_node_id")
    if current and _node_by_id(state, current):
        return current
    return "collect_evidence"


def _status_from_data(data: Any) -> str:
    if isinstance(data, dict):
        status = str(data.get("status") or data.get("result") or "").strip().lower()
        if status:
            return status
        if data.get("correct") is True:
            return "correct"
    if data is None:
        return "empty"
    return "success"


def _preview_result(data: Any) -> Dict[str, Any]:
    if isinstance(data, dict):
        out = {"keys": sorted(str(k) for k in data.keys())[:30]}
        for key in ("status", "result", "msg", "message", "error", "full_result_path", "trace_id", "verb"):
            if key in data:
                out[key] = _sanitize(data.get(key))
        return out
    return {"preview": _preview(data)}


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


def _safe_id(value: Any) -> str:
    text = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(value or "").strip())
    return text.strip("_")[:48] or "node"


def _unique_node_id(state: Dict[str, Any], prefix: str) -> str:
    existing = {node.get("id") for node in state.get("nodes") or []}
    base = _safe_id(prefix)
    if base not in existing:
        return base
    i = 2
    while f"{base}_{i}" in existing:
        i += 1
    return f"{base}_{i}"


def _node_by_id(state: Dict[str, Any], node_id: str) -> Optional[Dict[str, Any]]:
    for node in state.get("nodes") or []:
        if node.get("id") == node_id:
            return node
    return None


def _mark_node(state: Dict[str, Any], node_id: str, status: str) -> None:
    node = _node_by_id(state, node_id)
    if node:
        node["status"] = status
        node["updated_at"] = _utc_now()


def _activate_node(state: Dict[str, Any], node_id: str) -> None:
    node = _node_by_id(state, node_id)
    if node and node.get("status") in {"pending", "failed"}:
        node["status"] = "active"
        node["updated_at"] = _utc_now()
    state["current_node_id"] = node_id


def _error_penalty(category: str) -> float:
    if category in {"tool_not_allowed", "permission_denied", "dependency_missing"}:
        return 0.08
    if category in {"schema_error", "mcp_path_denied", "oracle_rejected"}:
        return 0.12
    if category in {"browser_no_tab", "network_timeout", "unknown_error"}:
        return 0.18
    return 0.1


def _touch(state: Dict[str, Any]) -> None:
    state["updated_at"] = _utc_now()


def _write_state(state: Dict[str, Any]) -> None:
    path = Path(str(state.get("path") or "task_tree.json"))
    path.parent.mkdir(parents=True, exist_ok=True)
    serializable = dict(state)
    serializable["events"] = list(serializable.get("events") or [])[-40:]
    payload = json.dumps(serializable, ensure_ascii=False, indent=2, sort_keys=True)
    temp_path = path.with_name(f"{path.name}.{threading.get_ident()}.tmp")
    temp_path.write_text(payload, encoding="utf-8")
    for attempt in range(5):
        try:
            os.replace(temp_path, path)
            break
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(0.01 * (attempt + 1))
    state["events"] = serializable["events"]


def _append_event(state: Dict[str, Any], event_type: str, detail: Dict[str, Any]) -> None:
    event = {"ts": _utc_now(), "type": event_type, "detail": detail}
    state.setdefault("events", []).append(event)
    state["events"] = state["events"][-40:]
    path = Path(str(state.get("events_path") or "task_tree_events.jsonl"))
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
    _write_state(state)


def _state_dir(*, run_dir: Optional[str], project_root: Optional[str]) -> Path:
    if run_dir:
        return Path(run_dir).expanduser().resolve(strict=False)
    root = Path(project_root or os.getcwd()).expanduser().resolve(strict=False)
    return root / "temp" / "task_tree"


def _utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
