"""Backward-compatible crypto attack-memory distillation API."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Iterable

from .crypto_kb import distill_crypto_knowledge_base
from .knowledge import KnowledgeCard
from .schema import AttackMemoryRecord


@dataclass(frozen=True)
class CryptoDistillReport:
    input_records: int
    eligible_records: int
    rejected_records: int
    review_records: int
    cards_created: int

    def to_dict(self) -> dict[str, int]:
        return asdict(self)


def distill_crypto_records(
    records: Iterable[AttackMemoryRecord],
) -> tuple[list[KnowledgeCard], CryptoDistillReport]:
    """Adapt the original two-value API to the evidence-first KB pipeline."""

    source_records = list(records)
    cards, candidates, rejected, review, _report = distill_crypto_knowledge_base(
        source_records
    )
    return cards, CryptoDistillReport(
        input_records=len(source_records),
        eligible_records=len(candidates),
        rejected_records=len(rejected) + len(review),
        review_records=len(review),
        cards_created=len(cards),
    )
