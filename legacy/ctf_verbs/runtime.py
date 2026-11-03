"""Runtime dispatcher for CTF verbs.

Mirrors `web_verbs.runtime` so the verb contract is uniform across
domains: structured args in, structured data + trace record out,
secret-aware redaction, and clear failure paths with `status: error`.
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List

from .registry import get_specs


def list_verbs(category: str | None = None) -> List[Dict[str, Any]]:
    out = []
    for spec in sorted(get_specs().values(), key=lambda item: item.name):
        if category and not spec.name.startswith(f"{category}."):
            continue
        out.append(
            {
                "name": spec.name,
                "description": spec.description,
                "policy_tags": list(spec.policy_tags),
                "required_args": list(spec.required_args),
                "category": spec.category,
            }
        )
    return out


def call_verb(verb: str, args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    specs = get_specs()
    verb = str(verb or "").strip()
    args = args or {}
    trace_id = "ct_" + uuid.uuid4().hex[:12]
    started = time.time()
    spec = specs.get(verb)
    if spec is None:
        result = {
            "status": "error",
            "verb": verb,
            "error": f"unknown ctf verb: {verb}",
            "available_verbs": [item["name"] for item in list_verbs()],
            "trace_id": trace_id,
        }
        _write_trace(context, trace_id, verb, args, (), "unknown", result, started)
        return result

    missing = [name for name in spec.required_args if args.get(name) in (None, "")]
    if missing:
        result = {
            "status": "error",
            "verb": verb,
            "error": f"missing required args: {', '.join(missing)}",
            "trace_id": trace_id,
        }
        _write_trace(
            context, trace_id, verb, args, spec.policy_tags, "precondition", result, started
        )
        return result

    try:
        data = spec.handler(args, context)
        inner_status = data.pop("status", None) if isinstance(data, dict) else None
        result = {
            "status": inner_status or "success",
            "verb": verb,
            "trace_id": trace_id,
            "policy_tags": list(spec.policy_tags),
            "data": data,
        }
    except Exception as exc:
        result = {
            "status": "error",
            "verb": verb,
            "trace_id": trace_id,
            "policy_tags": list(spec.policy_tags),
            "error": f"{type(exc).__name__}: {exc}",
        }

    _remember_used_verb(context, verb, result)
    _write_trace(
        context,
        trace_id,
        verb,
        args,
        spec.policy_tags,
        spec.category,
        result,
        started,
        category=spec.category,
    )
    return result


def trace_path_for(context: Dict[str, Any]) -> Path:
    base = Path(str(context.get("run_dir") or context.get("cwd") or ".")).resolve()
    return base / "ctf_verb_trace.jsonl"


def _remember_used_verb(context: Dict[str, Any], verb: str, result: Dict[str, Any]) -> None:
    parent = context.get("parent")
    if parent is None:
        return
    used = list(getattr(parent, "ctf_verbs_used", []) or [])
    used.append(
        {
            "verb": verb,
            "status": result.get("status"),
            "trace_id": result.get("trace_id"),
            "ts": _utc_now(),
        }
    )
    setattr(parent, "ctf_verbs_used", used[-80:])


def _write_trace(
    context: Dict[str, Any],
    trace_id: str,
    verb: str,
    args: Dict[str, Any],
    policy_tags,
    backend: str,
    result: Dict[str, Any],
    started: float,
    *,
    category: str = "ctf",
) -> None:
    try:
        path = trace_path_for(context)
        path.parent.mkdir(parents=True, exist_ok=True)
        entry = {
            "ts": _utc_now(),
            "trace_id": trace_id,
            "verb": verb,
            "args_preview": _preview_args(args),
            "policy_tags": list(policy_tags or []),
            "category": category,
            "backend": backend,
            "status": result.get("status"),
            "duration_ms": int((time.time() - started) * 1000),
        }
        if result.get("error"):
            entry["error"] = str(result.get("error"))[:500]
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")
    except Exception:
        return


def _preview_args(args: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for key, value in (args or {}).items():
        key_l = str(key).lower()
        if key_l in {"password", "token", "authorization", "cookie", "payload"}:
            out[key] = _secret_preview(value)
        elif isinstance(value, (bytes, bytearray)):
            out[key] = f"<bytes len={len(value)} sha256={_sha256_bytes(bytes(value))[:12]}>"
        elif isinstance(value, dict):
            out[key] = {
                str(k): _secret_preview(v) if str(k).lower() in {"password", "token"} else _short(v)
                for k, v in value.items()
            }
        else:
            out[key] = _short(value)
    return out


def _short(value: Any, limit: int = 500) -> Any:
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    text = str(value)
    return text[:limit] + ("..." if len(text) > limit else "")


def _secret_preview(value: Any) -> str:
    text = str(value or "")
    if not text:
        return ""
    import hashlib

    digest = hashlib.sha256(text.encode()).hexdigest()[:12]
    return f"<secret sha256:{digest}>"


def _sha256_bytes(data: bytes) -> str:
    import hashlib

    return hashlib.sha256(data or b"").hexdigest()


def _utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
