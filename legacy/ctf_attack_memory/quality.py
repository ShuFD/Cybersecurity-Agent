"""Deterministic release gates for local attack-memory artifacts.

Raw records remain evidence only.  This module creates small, auditable candidate
and published sets without trusting ingest-time labels or generic section titles.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from pathlib import Path

from .filter import PWN_ATTACK_RULES, classify_pwn
from .knowledge import KnowledgeCard, load_cards, save_cards
from .schema import AttackMemoryRecord

_GENERIC_TITLE_RE = re.compile(
    r"ai\s*(?:summary|摘要)|摘要|summary|tl;?dr|前言|介绍|简介|"
    r"利用原理|漏洞成因|利用效果|相关技巧|参考|references?|overview|contents?",
    re.IGNORECASE,
)
_PWN_ACTION_RE = re.compile(
    r"\b(?:allocate|malloc|calloc|free|edit|write|overwrite|leak|trigger|"
    r"corrupt|poison|forge|bypass|redirect|hijack|execute|unsorted|tcache)\b|"
    r"(?:分配|释放|编辑|覆盖|泄漏|触发|伪造|劫持|绕过)",
    re.IGNORECASE,
)
_GENERIC_CARD_PRECONDITION = "The challenge exposes the attack-specific relation described by this method."
_GENERIC_CARD_STEP = "Extract the exact parameters and equations for the named attack."
_PWN_WEIGHT = {rule.label.lower(): rule.weight for rule in PWN_ATTACK_RULES}


@dataclass(frozen=True)
class QualityDecision:
    status: str  # candidate | rejected | published
    score: int
    reasons: list[str]


@dataclass(frozen=True)
class CleaningReport:
    artifact: str
    input_items: int
    candidates: int
    published: int
    rejected: int
    reasons: dict[str, int]

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def evaluate_pwn_record(record: AttackMemoryRecord) -> tuple[AttackMemoryRecord | None, QualityDecision]:
    """Reclassify one pwn chunk; never inherit labels from a parent section."""
    reasons: list[str] = []
    title = " ".join((record.challenge, record.source_title)).strip()
    body = "\n".join((record.text_chunk, record.code_snippet)).strip()
    if not record.source_url:
        reasons.append("missing_source_url")
    if not body:
        reasons.append("empty_content")
    if _GENERIC_TITLE_RE.search(title):
        reasons.append("generic_or_summary_title")
    gate = classify_pwn(body)
    if not gate.keep:
        reasons.append("chunk_does_not_independently_match_pwn_rule")
    if not _PWN_ACTION_RE.search(body) and len(record.code_snippet.strip()) < 24:
        reasons.append("no_exploitation_action_or_code")
    if reasons:
        return None, QualityDecision("rejected", 0, reasons)

    primary = max(gate.attack_pattern, key=lambda item: (_PWN_WEIGHT.get(item.lower(), 0), item))
    cleaned = AttackMemoryRecord(
        id=record.id,
        event=record.event,
        challenge=record.challenge,
        crypto_type=gate.crypto_type,
        attack_pattern=[primary],
        text_chunk=record.text_chunk,
        code_snippet=record.code_snippet,
        source_url=record.source_url,
        category="pwn",
        ctftime_url=record.ctftime_url,
        source_title=record.source_title,
        tags=record.tags,
        gate_score=gate.score,
    )
    score = 55 + min(25, int(gate.score * 4)) + (10 if record.code_snippet.strip() else 0)
    if record.event:
        score += 5
    if record.ctftime_url:
        score += 5
    return cleaned, QualityDecision("candidate", min(score, 100), [])


def clean_pwn_records(records: Iterable[AttackMemoryRecord]) -> tuple[list[AttackMemoryRecord], list[dict[str, object]], CleaningReport]:
    candidates: list[AttackMemoryRecord] = []
    rejected: list[dict[str, object]] = []
    seen: set[tuple[str, str, str]] = set()
    reasons: Counter[str] = Counter()
    total = 0
    for record in records:
        total += 1
        cleaned, decision = evaluate_pwn_record(record)
        if cleaned is None:
            rejected.append(_rejection(record.id, decision))
            reasons.update(decision.reasons)
            continue
        fingerprint = _fingerprint(cleaned.text_chunk + "\n" + cleaned.code_snippet)
        key = (cleaned.source_url, cleaned.attack_pattern[0], fingerprint)
        if key in seen:
            decision = QualityDecision("rejected", 0, ["duplicate_source_chunk"])
            rejected.append(_rejection(record.id, decision))
            reasons.update(decision.reasons)
            continue
        seen.add(key)
        candidates.append(cleaned)
    report = CleaningReport("pwn_records", total, len(candidates), 0, len(rejected), dict(sorted(reasons.items())))
    return candidates, rejected, report


def clean_crypto_cards(cards: Iterable[KnowledgeCard]) -> tuple[list[KnowledgeCard], list[dict[str, object]], CleaningReport]:
    published: list[KnowledgeCard] = []
    rejected: list[dict[str, object]] = []
    reasons: Counter[str] = Counter()
    total = 0
    for card in cards:
        total += 1
        card_reasons: list[str] = []
        if not card.evidence:
            card_reasons.append("missing_evidence")
        if _GENERIC_CARD_PRECONDITION in card.preconditions:
            card_reasons.append("generic_preconditions")
        if _GENERIC_CARD_STEP in card.steps:
            card_reasons.append("generic_steps")
        if not any("verify" in step.lower() or "验证" in step for step in card.steps):
            card_reasons.append("missing_validation_step")
        if card_reasons:
            decision = QualityDecision("rejected", 0, card_reasons)
            rejected.append(_rejection(card.id, decision))
            reasons.update(card_reasons)
            continue
        published.append(card)
    report = CleaningReport("crypto_cards", total, len(published), len(published), len(rejected), dict(sorted(reasons.items())))
    return published, rejected, report


def clean_index_directory(index_dir: str | Path, *, category: str) -> tuple[CleaningReport, Path]:
    """Write staged artifacts and replace only the runtime-safe published artifact."""
    base = Path(index_dir)
    evidence_dir = base / "evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    if category == "pwn":
        records_path = base / "records.jsonl"
        records = _load_records(records_path)
        candidates, rejected, report = clean_pwn_records(records)
        _backup_once(records_path, evidence_dir / "original_records.jsonl")
        _write_jsonl((record.to_dict() for record in candidates), evidence_dir / "candidates.jsonl")
        _write_jsonl(rejected, evidence_dir / "rejected.jsonl")
        # Candidate evidence must not be served by the runtime retrieval index.
        _write_jsonl((), records_path)
    elif category == "crypto":
        cards_path = base / "knowledge" / "cards.jsonl"
        cards = load_cards(cards_path)
        published, rejected, report = clean_crypto_cards(cards)
        _backup_once(cards_path, evidence_dir / "original_cards.jsonl")
        _write_jsonl((card.to_dict(include_evidence_text=False) for card in cards if card not in published), evidence_dir / "card_candidates.jsonl")
        _write_jsonl(rejected, evidence_dir / "card_rejected.jsonl")
        save_cards(published, cards_path, include_evidence_text=False)
    else:
        raise ValueError(f"Unsupported category: {category}")
    report_path = evidence_dir / "cleaning_report.json"
    report_path.write_text(json.dumps(report.to_dict(), ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    return report, report_path


def _load_records(path: Path) -> list[AttackMemoryRecord]:
    if not path.is_file():
        return []
    records = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            records.append(AttackMemoryRecord.from_dict(json.loads(line)))
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
    return records


def _backup_once(source: Path, destination: Path) -> None:
    if source.is_file() and not destination.exists():
        destination.write_bytes(source.read_bytes())


def _write_jsonl(items: Iterable[dict[str, object]], path: Path) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for item in items:
            handle.write(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n")


def _fingerprint(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").lower()).strip()[:1200]


def _rejection(item_id: str, decision: QualityDecision) -> dict[str, object]:
    return {"id": item_id, "status": decision.status, "score": decision.score, "reasons": decision.reasons}
