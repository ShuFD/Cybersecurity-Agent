"""Long-transaction session recorder for pwn/re workflows.

A pwn session is multi-step (probe -> leak -> control -> ROP -> exec).
We don't pretend each step is an atomic primitive; instead we record
the full transcript alongside key milestones, then let the experience
layer decide which sub-step pattern was load-bearing.

Endpoints:
- pwn.open_session(path, recipe_hint) -> {session_id, transcript_path}
- pwn.append_event(session_id, kind, payload) -> {recorded}
- pwn.close_session(session_id, summary) -> {events_count, summary_path}
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from ._spec import VerbSpec


SESSION_VERBS: Dict[str, VerbSpec] = {}
SESSIONS_DIRNAME = "ctf_sessions"


def _register(spec: VerbSpec) -> VerbSpec:
    SESSION_VERBS[spec.name] = spec
    return spec


def _root(context: Dict[str, Any]) -> Path:
    base = Path(str(context.get("run_dir") or context.get("cwd") or ".")).resolve()
    return base / "tool_results" / SESSIONS_DIRNAME


def _session_path(context: Dict[str, Any], session_id: str) -> Path:
    return _root(context) / f"{session_id}.jsonl"


def _meta_path(context: Dict[str, Any], session_id: str) -> Path:
    return _root(context) / f"{session_id}.meta.json"


def _safe_secret(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    if not value:
        return value
    digest = hashlib.sha256(value.encode()).hexdigest()[:12]
    return f"<secret sha256:{digest}>"


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(k): (_safe_secret(v) if str(k).lower() in {"payload", "password", "token"} else _redact(v))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [_redact(item) for item in value]
    if isinstance(value, bytes):
        return f"<bytes len={len(value)}>"
    return value


def _append(path: Path, entry: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")


def _read_meta(meta_path: Path) -> Optional[Dict[str, Any]]:
    if not meta_path.is_file():
        return None
    try:
        return json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return None


def verb_open_session(args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    path = str(args.get("path") or "").strip()
    recipe_hint = str(args.get("recipe_hint") or "").strip()
    session_id = "psn_" + uuid.uuid4().hex[:12]
    meta_path = _meta_path(context, session_id)
    transcript = _session_path(context, session_id)
    meta = {
        "session_id": session_id,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "path": path,
        "recipe_hint": recipe_hint,
        "transcript_path": str(transcript),
        "events_count": 0,
        "session_status": "open",
    }
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    transcript.touch(exist_ok=True)
    parent = context.get("parent")
    if parent is not None:
        open_list = list(getattr(parent, "ctf_sessions_open", []) or [])
        open_list.append(session_id)
        setattr(parent, "ctf_sessions_open", open_list[-16:])
    return meta


def verb_append_event(args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    session_id = str(args.get("session_id") or "").strip()
    kind = str(args.get("kind") or "").strip()
    payload = args.get("payload")
    if not session_id:
        raise ValueError("session_id is required")
    if not kind:
        raise ValueError("kind is required")
    meta_path = _meta_path(context, session_id)
    meta = _read_meta(meta_path)
    if not meta or meta.get("session_status") != "open":
        return {
            "status": "error",
            "session_id": session_id,
            "message": "session not found or already closed",
        }
    transcript = _session_path(context, session_id)
    entry = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "kind": kind,
        "payload": _redact(payload),
    }
    _append(transcript, entry)
    meta["events_count"] = int(meta.get("events_count", 0)) + 1
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "status": "recorded",
        "session_id": session_id,
        "kind": kind,
        "events_count": meta["events_count"],
    }


def verb_close_session(args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    session_id = str(args.get("session_id") or "").strip()
    summary = args.get("summary")
    if not isinstance(summary, dict):
        summary = {}
    meta_path = _meta_path(context, session_id)
    meta = _read_meta(meta_path)
    if not meta:
        return {
            "status": "error",
            "session_id": session_id,
            "message": "session not found",
        }
    transcript = _session_path(context, session_id)
    events_count = int(meta.get("events_count", 0))
    summary_record = {
        "session_id": session_id,
        "closed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "summary": summary,
        "events_count": events_count,
        "transcript_path": str(transcript),
        "transcript_size": transcript.stat().st_size if transcript.exists() else 0,
    }
    summary_path = meta_path.with_suffix(".summary.json")
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary_record, ensure_ascii=False, indent=2), encoding="utf-8")
    meta["session_status"] = "closed"
    meta["summary_path"] = str(summary_path)
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    parent = context.get("parent")
    if parent is not None:
        open_list = [
            sid for sid in (getattr(parent, "ctf_sessions_open", []) or []) if sid != session_id
        ]
        setattr(parent, "ctf_sessions_open", open_list)
        used_list = list(getattr(parent, "ctf_sessions_used", []) or [])
        used_list.append(
            {
                "session_id": session_id,
                "events_count": events_count,
                "summary_path": str(summary_path),
                "outcome": str(summary.get("outcome") or ""),
                "ts": summary_record["closed_at"],
            }
        )
        setattr(parent, "ctf_sessions_used", used_list[-16:])
    return {
        "status": "closed",
        "session_id": session_id,
        "events_count": events_count,
        "summary_path": str(summary_path),
    }


_register(
    VerbSpec(
        "pwn.open_session",
        "Open a long-transaction pwn session and create a transcript file (do not chain atomic verbs for multi-step pwn recipes).",
        ("read_only", "file_write"),
        ("path",),
        verb_open_session,
        category="pwn",
    )
)
_register(
    VerbSpec(
        "pwn.append_event",
        "Append a kind+payload event to an open pwn session transcript.",
        ("read_only", "file_write"),
        ("session_id", "kind"),
        verb_append_event,
        category="pwn",
    )
)
_register(
    VerbSpec(
        "pwn.close_session",
        "Close a pwn session, write its summary, and remember it on the parent for experience replay.",
        ("read_only", "file_write"),
        ("session_id",),
        verb_close_session,
        category="pwn",
    )
)
