"""Extract non-verbatim, challenge-bound pwn candidate cards from local evidence."""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from collections.abc import Iterable

from .filter import PWN_ATTACK_RULES, classify_pwn
from .schema import AttackMemoryRecord, stable_id

_GLIBC_RE = re.compile(r"\bglibc\s*(?:version\s*)?(2\.\d{1,2})(?:\s*(?:[-–—]|to|~)\s*(2\.\d{1,2}))?", re.I)
_BUG_RULES = (
    ("use-after-free", r"\b(?:use[ -]?after[ -]?free|uaf|edit[ -]?after[ -]?free)\b"),
    ("double-free", r"\bdouble[ -]?free\b"),
    ("heap-overflow", r"\b(?:heap\s+overflow|off[ -]?by[ -]?(?:one|null)|overflow\s+write)\b"),
    ("format-string", r"\bformat\s+string\b|%[0-9$+\-#.]*[pxn]"),
)
_PWN_WEIGHT = {rule.label.lower(): rule.weight for rule in PWN_ATTACK_RULES}

_STEP_RULES = (
    ("obtain an allocator or address leak", r"\b(?:leak|address disclosure|libc base|heap base)\b"),
    ("shape allocator state with controlled allocate/free operations", r"\b(?:malloc|calloc|allocate|free|tcache|fastbin|smallbin|largebin|unsortedbin)\b"),
    ("use the identified corruption primitive to redirect an allocation or pointer", r"\b(?:poison|overwrite|corrupt|forge|redirect|hijack)\b"),
    ("trigger the program path that consumes the modified object", r"\b(?:trigger|exit\s*\(|free\s*\(|malloc\s*\(|call)\b"),
)


@dataclass
class PwnCandidateCard:
    id: str
    challenge: str
    event: str
    source_url: str
    attack_family: str
    vulnerability_primitives: list[str]
    glibc_versions: list[str]
    exploit_steps: list[str]
    validation: list[str]
    source_record_ids: list[str]
    review_status: str = "candidate"
    rejection_reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def extract_pwn_candidates(records: Iterable[AttackMemoryRecord]) -> tuple[list[PwnCandidateCard], list[dict[str, object]]]:
    cards: list[PwnCandidateCard] = []
    rejected: list[dict[str, object]] = []
    for record in records:
        card, reasons = _card_from_record(record)
        if card is None:
            rejected.append({"id": record.id, "reasons": reasons})
        else:
            cards.append(card)
    return cards, rejected


def write_pwn_candidates(cards: Iterable[PwnCandidateCard], rejected: Iterable[dict[str, object]], output_dir: str | Path) -> None:
    base = Path(output_dir)
    base.mkdir(parents=True, exist_ok=True)
    _write_jsonl((card.to_dict() for card in cards), base / "candidates.jsonl")
    _write_jsonl(rejected, base / "rejected.jsonl")


def _card_from_record(record: AttackMemoryRecord) -> tuple[PwnCandidateCard | None, list[str]]:
    body = "\n".join((record.text_chunk, record.code_snippet))
    gate = classify_pwn(body)
    reasons: list[str] = []
    if not record.challenge or _looks_generic(record.challenge):
        reasons.append("missing_challenge_name")
    if not record.event:
        reasons.append("missing_event")
    if not record.source_url:
        reasons.append("missing_source_url")
    if not gate.keep or not gate.attack_pattern:
        reasons.append("requires_independent_attack_family")
    primitives = [name for name, regex in _BUG_RULES if re.search(regex, body, re.I)]
    if not primitives:
        reasons.append("missing_vulnerability_primitive")
    versions = _glibc_versions(body)
    if not versions:
        reasons.append("missing_glibc_version_constraint")
    steps = [step for step, regex in _STEP_RULES if re.search(regex, body, re.I)]
    if len(steps) < 2:
        reasons.append("insufficient_concrete_exploit_steps")
    if reasons:
        return None, reasons
    family = max(gate.attack_pattern, key=lambda item: (_PWN_WEIGHT.get(item.lower(), 0), item))
    validation = [
        "Confirm the allocator version and mitigation state match the stated constraints.",
        "Verify the intermediate primitive locally before attempting the final trigger.",
    ]
    return PwnCandidateCard(
        id=stable_id("pwn-candidate", record.event, record.challenge, family, record.source_url),
        challenge=record.challenge,
        event=record.event,
        source_url=record.source_url,
        attack_family=family,
        vulnerability_primitives=primitives,
        glibc_versions=versions,
        exploit_steps=steps,
        validation=validation,
        source_record_ids=[record.id],
    ), []


def _glibc_versions(text: str) -> list[str]:
    out = []
    for match in _GLIBC_RE.finditer(text or ""):
        start, end = match.groups()
        value = f"glibc {start}" + (f"-{end}" if end else "")
        if value not in out:
            out.append(value)
    return out


def _looks_generic(title: str) -> bool:
    return bool(re.search(r"摘要|前言|原理|参考|overview|summary|introduction", title or "", re.I))


def _write_jsonl(items: Iterable[dict[str, object]], path: Path) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for item in items:
            handle.write(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n")
