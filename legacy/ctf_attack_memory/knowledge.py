"""Provenance-first crypto knowledge cards distilled from writeup records.

Cards are deliberately separate from ``AttackMemoryRecord``.  The latter is a
retrieval evidence chunk; a card is a reviewable, reusable technique variant
whose claims always point back to those chunks.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .sanitize import sanitize_untrusted_text
from .schema import AttackMemoryRecord, stable_id

CARD_SCHEMA_VERSION = "crypto-knowledge-card.v1"

# A card is an attack-family method, not a bag of every primitive mentioned in
# a source writeup.  The distiller may observe incidental crypto terms in a
# multi-challenge article; publishing those terms makes a card misleading.
CARD_FAMILY_METADATA: dict[str, tuple[list[str], str]] = {
    "rsa small exponent eth root": (["RSA"], "rsa-attacks.md"),
    "rsa common modulus": (["RSA"], "rsa-attacks.md"),
    "rsa broadcast hastad": (["RSA"], "rsa-attacks.md"),
    "rsa wiener small d": (["RSA"], "rsa-attacks.md"),
    "rsa fermat close primes": (["RSA"], "rsa-attacks.md"),
    "rsa coppersmith small roots": (["RSA", "Lattice"], "rsa-attacks.md"),
    "rsa oracle multiplicative": (["RSA"], "rsa-attacks.md"),
    "rsa crt fault": (["RSA"], "rsa-attacks.md"),
    "rsa batch gcd shared prime": (["RSA"], "rsa-attacks.md"),
    "ecdsa nonce reuse": (["ECC", "ECC/Signature"], "ecc-attacks.md"),
    "ecc small subgroup invalid curve": (["ECC", "ECC/NumberTheory"], "ecc-attacks.md"),
    "discrete log smooth order": (["ECC/NumberTheory"], "ecc-attacks.md"),
    "lattice lll coppersmith": (["Lattice"], "lattice-and-lwe.md"),
    "lwe ring-lwe cvp": (["Lattice/LWE"], "lattice-and-lwe.md"),
    "prng state recovery": (["PRNG"], "prng.md"),
    "stream cipher keystream reuse": (["StreamCipher"], "stream-ciphers.md"),
    "xor key recovery": (["Classic/XOR"], "classic-ciphers.md"),
    "cbc padding oracle": (["BlockCipher"], "modern-ciphers.md"),
    "cbc bit flipping": (["BlockCipher"], "modern-ciphers.md"),
    "ecb cut and paste": (["BlockCipher"], "modern-ciphers.md"),
    "gcm nonce reuse": (["BlockCipher/MAC"], "modern-ciphers.md"),
    "hash length extension": (["Hash/MAC"], "modern-ciphers.md"),
    "crc linear forgery": (["Hash/MAC"], "modern-ciphers.md"),
    "mac forgery linearity": (["Hash/MAC"], "modern-ciphers.md"),
    "shamir secret sharing misuse": (["SecretSharing"], "zkp-and-advanced.md"),
    "zk proof forgery": (["ZKP"], "zkp-and-advanced.md"),
}


@dataclass
class EvidenceSpan:
    source_id: str
    source_url: str
    locator: str
    text: str = ""
    content_hash: str = ""

    def to_dict(self, *, include_text: bool = True) -> dict[str, Any]:
        data = asdict(self)
        if not include_text:
            data.pop("text", None)
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "EvidenceSpan":
        known = set(cls.__dataclass_fields__)
        return cls(**{key: value for key, value in data.items() if key in known})


@dataclass
class AtomicClaim:
    text: str
    claim_type: str
    evidence: list[EvidenceSpan] = field(default_factory=list)
    confidence: str = "rule-derived"
    status: str = "unverified"

    def to_dict(self, *, include_evidence_text: bool = True) -> dict[str, Any]:
        return {
            **asdict(self),
            "evidence": [
                item.to_dict(include_text=include_evidence_text)
                for item in self.evidence
            ],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AtomicClaim":
        payload = dict(data)
        payload["evidence"] = [
            EvidenceSpan.from_dict(item)
            for item in payload.get("evidence", [])
            if isinstance(item, dict)
        ]
        known = set(cls.__dataclass_fields__)
        return cls(**{key: value for key, value in payload.items() if key in known})


@dataclass
class KnowledgeCard:
    """A technique variant, with explicit provenance and review lifecycle."""

    id: str
    title: str
    category: str
    attack_family: str
    primitive: list[str]
    preconditions: list[str]
    steps: list[str]
    failure_modes: list[str]
    evidence: list[EvidenceSpan]
    claims: list[AtomicClaim]
    source_record_ids: list[str]
    tools: list[str] = field(default_factory=list)
    topic: str = ""
    variant_of: str = ""
    verification_status: str = "unverified"
    review_status: str = "draft"
    schema_version: str = CARD_SCHEMA_VERSION

    def __post_init__(self) -> None:
        self.primitive = _dedupe(self.primitive)
        self.preconditions = _dedupe(self.preconditions)
        self.steps = _dedupe(self.steps)
        self.failure_modes = _dedupe(self.failure_modes)
        self.source_record_ids = _dedupe(self.source_record_ids)
        self.tools = _dedupe(self.tools)
        if not self.id:
            self.id = stable_id(self.category, self.attack_family, self.variant_of, self.title)

    def to_dict(self, *, include_evidence_text: bool = True) -> dict[str, Any]:
        return {
            **asdict(self),
            "evidence": [
                item.to_dict(include_text=include_evidence_text)
                for item in self.evidence
            ],
            "claims": [
                item.to_dict(include_evidence_text=include_evidence_text)
                for item in self.claims
            ],
        }

    def to_json(self, *, include_evidence_text: bool = True) -> str:
        return json.dumps(
            self.to_dict(include_evidence_text=include_evidence_text),
            ensure_ascii=False,
            sort_keys=True,
        )

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "KnowledgeCard":
        payload = dict(data)
        payload["evidence"] = [
            EvidenceSpan.from_dict(item)
            for item in payload.get("evidence", [])
            if isinstance(item, dict)
        ]
        payload["claims"] = [
            AtomicClaim.from_dict(item)
            for item in payload.get("claims", [])
            if isinstance(item, dict)
        ]
        for key in ("primitive", "preconditions", "steps", "failure_modes", "source_record_ids", "tools"):
            if isinstance(payload.get(key), str):
                payload[key] = [payload[key]]
            payload.setdefault(key, [])
        known = set(cls.__dataclass_fields__)
        return cls(**{key: value for key, value in payload.items() if key in known})


def evidence_for_record(record: AttackMemoryRecord, *, locator: str = "retrieval chunk") -> EvidenceSpan:
    import hashlib

    text = sanitize_untrusted_text(record.text_chunk or record.code_snippet).text
    return EvidenceSpan(
        source_id=record.id,
        source_url=record.source_url,
        locator=locator,
        text=text,
        content_hash=hashlib.sha256(text.encode("utf-8", "ignore")).hexdigest(),
    )


def load_cards(path: str | Path) -> list[KnowledgeCard]:
    cards_path = Path(path)
    if not cards_path.is_file():
        return []
    cards = []
    for line in cards_path.read_text(encoding="utf-8").splitlines():
        try:
            item = json.loads(line)
            if isinstance(item, dict):
                cards.append(KnowledgeCard.from_dict(item))
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
    return cards


@dataclass(frozen=True)
class CardFilterReport:
    input_cards: int
    published_cards: int
    rejected_cards: int
    merged_cards: int
    rejection_reasons: dict[str, int]


def filter_publishable_cards(
    cards: Iterable[KnowledgeCard],
) -> tuple[list[KnowledgeCard], CardFilterReport]:
    """Reject malformed cards and merge valid variants into one card per family.

    This is a release gate rather than a cryptanalytic verifier.  It rejects
    entries that cannot safely support retrieval, and canonicalizes incidental
    primitive labels using the maintained attack-family taxonomy.
    """

    rejected: dict[str, int] = {}
    grouped: dict[str, list[KnowledgeCard]] = {}
    input_cards = 0
    for card in cards:
        input_cards += 1
        reason = _publication_rejection_reason(card)
        if reason:
            rejected[reason] = rejected.get(reason, 0) + 1
            continue
        grouped.setdefault(card.attack_family.lower(), []).append(card)

    published = [_merge_card_family(family, variants) for family, variants in grouped.items()]
    published.sort(key=lambda card: (card.attack_family.lower(), card.id))
    report = CardFilterReport(
        input_cards=input_cards,
        published_cards=len(published),
        rejected_cards=sum(rejected.values()),
        merged_cards=sum(max(0, len(variants) - 1) for variants in grouped.values()),
        rejection_reasons=dict(sorted(rejected.items())),
    )
    return published, report


def _publication_rejection_reason(card: KnowledgeCard) -> str:
    if card.category.lower() != "crypto":
        return "non_crypto_category"
    if card.attack_family.lower() not in CARD_FAMILY_METADATA:
        return "unknown_attack_family"
    if not card.title or not card.preconditions or not card.steps or not card.failure_modes:
        return "incomplete_method"
    if not card.evidence:
        return "missing_evidence"
    if any(not item.source_id or not item.source_url or not item.content_hash for item in card.evidence):
        return "invalid_provenance"
    return ""


def _merge_card_family(family: str, variants: list[KnowledgeCard]) -> KnowledgeCard:
    primitives, topic = CARD_FAMILY_METADATA[family]
    template = min(
        variants,
        key=lambda card: (-len(card.evidence), card.id),
    )
    evidence_by_key: dict[tuple[str, str, str], EvidenceSpan] = {}
    source_ids: list[str] = []
    tools: list[str] = []
    for variant in variants:
        source_ids.extend(variant.source_record_ids)
        tools.extend(variant.tools)
        for item in variant.evidence:
            evidence_by_key.setdefault(
                (item.source_id, item.source_url, item.content_hash), item
            )
    evidence = sorted(
        evidence_by_key.values(),
        key=lambda item: (item.source_url, item.source_id, item.content_hash),
    )
    # The published provenance set is authoritative after deduplication; keeping
    # stale duplicate source IDs would make the card fail its own consistency
    # rule and obscure the actual evidence count.
    source_ids = [item.source_id for item in evidence]
    claim = AtomicClaim(
        text=(
            f"The cited evidence was classified as '{family}'. "
            "Verify the listed preconditions against the current challenge before use."
        ),
        claim_type="attack-classification",
        evidence=evidence,
    )
    return KnowledgeCard(
        id=stable_id("crypto", "published", family),
        title=f"{', '.join(primitives)}: {family}",
        category="crypto",
        attack_family=family,
        primitive=primitives,
        preconditions=template.preconditions,
        steps=template.steps,
        failure_modes=template.failure_modes,
        evidence=evidence,
        claims=[claim],
        source_record_ids=source_ids,
        tools=tools,
        topic=topic,
        variant_of=family,
        verification_status="unverified",
        review_status="draft",
    )


def save_cards(
    cards: Iterable[KnowledgeCard],
    path: str | Path,
    *,
    include_evidence_text: bool = True,
) -> Path:
    """Persist cards; release artifacts keep provenance but omit WP body text."""

    cards_path = Path(path)
    cards_path.parent.mkdir(parents=True, exist_ok=True)
    with cards_path.open("w", encoding="utf-8") as handle:
        for card in cards:
            handle.write(
                card.to_json(include_evidence_text=include_evidence_text) + "\n"
            )
    return cards_path


def _dedupe(items: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        text = str(item or "").strip()
        if text and text.lower() not in seen:
            seen.add(text.lower())
            result.append(text)
    return result
