from __future__ import annotations

from typing import Any, Dict, List

from .forensics import extract_forensics
from .generic import extract_generic
from .pwn import extract_pwn
from .reverse import extract_reverse
from .web import extract_web


def extract_observation(
    *, tool_name: str, args: Dict[str, Any], result: Any, state: Dict[str, Any]
) -> Dict[str, List[Dict[str, Any]]]:
    facts: List[Dict[str, Any]] = []
    hypotheses: List[Dict[str, Any]] = []
    for extractor in (extract_generic, extract_web, extract_pwn, extract_reverse, extract_forensics):
        extracted = extractor(tool_name=tool_name, args=args or {}, result=result, state=state) or {}
        facts.extend(extracted.get("facts") or [])
        hypotheses.extend(extracted.get("hypotheses") or [])

    deduped_facts = {}
    for claim in facts:
        key = str((claim or {}).get("key") or "")
        if key:
            deduped_facts[key] = claim
    deduped_hypotheses = {}
    for claim in hypotheses:
        hypothesis_id = str((claim or {}).get("id") or "")
        if hypothesis_id:
            deduped_hypotheses[hypothesis_id] = claim
    return {"facts": list(deduped_facts.values()), "hypotheses": list(deduped_hypotheses.values())}


__all__ = ["extract_observation"]
