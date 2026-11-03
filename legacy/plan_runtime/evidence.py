from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Dict, Iterable, List

from .models import utc_now
from .extractors import extract_observation
from .extractors.base import result_data


SECRET_KEYS = {
    "access_token",
    "api_key",
    "apikey",
    "authorization",
    "client_secret",
    "cookie",
    "cookies",
    "password",
    "proxy_authorization",
    "refresh_token",
    "secret",
    "set_cookie",
    "set_cookies",
    "token",
    "x_api_key",
}
COMMON_FACT_FIELDS = {
    "architecture",
    "file_type",
    "forms",
    "headers",
    "parameters",
    "protections",
    "routes",
    "urls",
}


def _merge_values(previous: Any, incoming: Any, mode: str) -> Any:
    if mode == "dict" and isinstance(previous, dict) and isinstance(incoming, dict):
        return {**previous, **incoming}
    if mode == "union":
        left = previous if isinstance(previous, list) else ([] if previous in (None, "") else [previous])
        right = incoming if isinstance(incoming, list) else ([] if incoming in (None, "") else [incoming])
        out = []
        seen = set()
        for item in [*left, *right]:
            marker = json.dumps(item, ensure_ascii=False, sort_keys=True, default=str)
            if marker not in seen:
                seen.add(marker)
                out.append(item)
        return out
    return incoming


def _safe_id(value: Any) -> str:
    text = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(value or "")).strip("_")
    return text[:48] or "tool"


def _observation_status(result: Any) -> str:
    outer = "success"
    if isinstance(result, dict):
        outer = str(result.get("status") or outer).lower()
    data = result_data(result)
    nested_status = str(data.get("status") or "").lower() if isinstance(data, dict) else ""
    if nested_status in {"blocked", "error", "failed", "permission_denied", "permission_required"}:
        return nested_status
    if isinstance(data, dict) and data.get("timed_out") is True:
        return "failed"
    if isinstance(data, dict) and isinstance(data.get("exit_code"), int) and data.get("exit_code") != 0:
        return "failed"
    return outer


def _sanitize(value: Any, depth: int = 0) -> Any:
    if depth > 8:
        return "<max-depth>"
    if isinstance(value, dict):
        out = {}
        for key, child in list(value.items())[:40]:
            normalized_key = str(key).lower().replace("-", "_")
            if normalized_key in SECRET_KEYS:
                raw = str(child or "")
                digest = hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()[:10]
                out[str(key)] = f"<redacted:{len(raw)}:{digest}>"
            else:
                out[str(key)] = _sanitize(child, depth + 1)
        return out
    if isinstance(value, (list, tuple)):
        return [_sanitize(item, depth + 1) for item in list(value)[:40]]
    text = str(value or "") if not isinstance(value, (bool, int, float)) else value
    if isinstance(text, str) and len(text) > 4000:
        return text[:4000] + "..."
    return text


class EvidenceStore:
    def __init__(self, state: Dict[str, Any]):
        self.state = state

    def add_observation(self, *, tool_name: str, args: Dict[str, Any], result: Any, turn: int = 0) -> Dict[str, Any]:
        evidence = self.state.setdefault("evidence", {})
        base = f"ev_{_safe_id(tool_name)}_{int(turn or 0)}"
        evidence_id = base
        index = 2
        while evidence_id in evidence:
            evidence_id = f"{base}_{index}"
            index += 1
        status = _observation_status(result)
        record = {
            "id": evidence_id,
            "kind": "tool_observation",
            "source": str(tool_name or "unknown"),
            "turn": int(turn or 0),
            "status": status,
            "args": _sanitize(args or {}),
            "result": _sanitize(result),
            "created_at": utc_now(),
        }
        evidence[evidence_id] = record

        committed = []
        explicit = result.get("facts") if isinstance(result, dict) else None
        if isinstance(explicit, dict):
            claims = [{"key": key, "value": value, "evidence_refs": [evidence_id]} for key, value in explicit.items()]
            committed.extend(self.commit_facts(claims))
        if isinstance(result, dict):
            namespace = f"observation.{_safe_id(tool_name)}"
            claims = [
                {"key": f"{namespace}.{key}", "value": result[key], "evidence_refs": [evidence_id]}
                for key in COMMON_FACT_FIELDS
                if key in result
            ]
            committed.extend(self.commit_facts(claims))

        extracted = extract_observation(tool_name=tool_name, args=args or {}, result=result, state=self.state)
        extracted_facts = []
        for claim in extracted.get("facts") or []:
            item = dict(claim)
            item["evidence_refs"] = [evidence_id]
            extracted_facts.append(item)
        committed.extend(self.commit_facts(extracted_facts))
        extracted_hypotheses = []
        for claim in extracted.get("hypotheses") or []:
            item = dict(claim)
            item["evidence_refs"] = [evidence_id]
            extracted_hypotheses.append(item)
        committed_hypotheses = self.commit_hypotheses(extracted_hypotheses)

        count = len(evidence)
        self.state.setdefault("facts", {})["runtime.evidence_count"] = {
            "key": "runtime.evidence_count",
            "value": count,
            "confidence": 1.0,
            "evidence_refs": [evidence_id],
            "created_at": utc_now(),
            "updated_at": utc_now(),
        }
        return {
            "evidence_id": evidence_id,
            "status": status,
            "committed_facts": list(dict.fromkeys(committed)),
            "committed_hypotheses": committed_hypotheses,
        }

    def commit_facts(self, claims: Iterable[Dict[str, Any]]) -> List[str]:
        facts = self.state.setdefault("facts", {})
        evidence = self.state.setdefault("evidence", {})
        committed = []
        last_refs = []
        for claim in claims or []:
            key = str((claim or {}).get("key") or "").strip()
            refs = [str(item) for item in (claim or {}).get("evidence_refs") or []]
            if not key or not refs or any(ref not in evidence for ref in refs):
                raise ValueError(f"Fact {key or '<missing>'} must reference existing evidence")
            now = utc_now()
            previous = facts.get(key) if isinstance(facts.get(key), dict) else {}
            value = _merge_values(previous.get("value"), (claim or {}).get("value"), str((claim or {}).get("merge") or ""))
            facts[key] = {
                "key": key,
                "value": _sanitize(value),
                "confidence": max(0.0, min(1.0, float((claim or {}).get("confidence", 1.0)))),
                "evidence_refs": refs,
                "producer_node_id": (claim or {}).get("producer_node_id"),
                "created_at": previous.get("created_at") or now,
                "updated_at": now,
            }
            committed.append(key)
            last_refs = refs
        if committed:
            now = utc_now()
            useful_count = sum(
                1 for key in facts if not str(key).startswith("runtime.") and not str(key).startswith("observation.")
            )
            previous = facts.get("runtime.useful_fact_count") or {}
            facts["runtime.useful_fact_count"] = {
                "key": "runtime.useful_fact_count",
                "value": useful_count,
                "confidence": 1.0,
                "evidence_refs": last_refs,
                "created_at": previous.get("created_at") or now,
                "updated_at": now,
            }
        return committed

    def commit_hypotheses(self, claims: Iterable[Dict[str, Any]]) -> List[str]:
        hypotheses = self.state.setdefault("hypotheses", {})
        evidence = self.state.setdefault("evidence", {})
        committed = []
        for claim in claims or []:
            hypothesis_id = str((claim or {}).get("id") or "").strip()
            refs = [str(item) for item in (claim or {}).get("evidence_refs") or []]
            if not hypothesis_id or any(ref not in evidence for ref in refs):
                raise ValueError(f"Hypothesis {hypothesis_id or '<missing>'} references unknown evidence")
            hypotheses[hypothesis_id] = {
                "id": hypothesis_id,
                "claim": str((claim or {}).get("claim") or ""),
                "confidence": max(0.0, min(1.0, float((claim or {}).get("confidence", 0.5)))),
                "evidence_refs": refs,
                "allowed_use": "probe_only",
                "created_at": utc_now(),
            }
            committed.append(hypothesis_id)
        return committed
