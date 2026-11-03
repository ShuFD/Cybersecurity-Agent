"""Evidence-first crypto knowledge-base distillation.

This module deliberately does not trust ingest-time labels.  It reclassifies each
raw record, extracts small sanitized evidence spans, then groups evidence by a
stable knowledge-point/variant identifier before producing retrieval-safe cards.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from pathlib import Path

from .filter import ATTACK_RULES, classify_crypto
from .knowledge import AtomicClaim, EvidenceSpan, KnowledgeCard, filter_publishable_cards, save_cards
from .sanitize import sanitize_untrusted_text
from .schema import AttackMemoryRecord, stable_id

_SCORE_THRESHOLD = 70
_MAX_EVIDENCE = 3
_ACTION_RE = re.compile(r"\b(?:compute|derive|recover|solve|factor|decrypt|forge|query|iterate|brute.?force|interpolate|verify|check|re-?encrypt|substitute)\b", re.I)
_VERIFY_RE = re.compile(r"\b(?:verify|check|assert|re-?encrypt|substitute|predict|validate|pow\s*\()\b", re.I)
_EQUATION_RE = re.compile(r"(?:\b(?:mod|gcd|crt|phi|nonce|tag|padding|root)\b|==|=|\^|\*|small_roots|iroot|inverse\s*\()", re.I)
_SECRET_RE = re.compile(
    r"(?im)^.*(?:flag\s*:|team\s*token|api[_ -]?key|private\s+key|\brpc\s*(?:url|endpoint)?\s*[:=]|"
    r"\b0x[a-f0-9]{40,}\b|https?://[^\s]+:\d{2,5}\b).*$"
)

# Existing attack-family taxonomy remains the retrieval field.  ``variant_of``
# supplies the finer knowledge-point ID so variants never inherit generic steps.
_VARIANTS: dict[str, tuple[str, str, list[str], list[str], list[str]]] = {
    "rsa small exponent eth root": (
        "rsa.small_exponent.integer_root", "RSA", ["The message is unpadded and its e-th power is smaller than n."],
        ["Parse c, e, and n.", "Compute the exact integer e-th root of c.", "Require pow(m, e, n) == c before accepting m."], ["If the root is inexact, m^e wrapped modulo n; use a different attack model."]),
    "rsa common modulus": (
        "rsa.common_modulus.coprime_exponents", "RSA", ["The same message is encrypted under one modulus with coprime public exponents."],
        ["Use extended GCD to obtain a*e1 + b*e2 = 1.", "Use modular inverses for negative coefficients.", "Compute m = c1^a * c2^b mod n and verify both ciphertext relations."], ["This does not apply when messages differ or gcd(e1, e2) is not one."]),
    "rsa broadcast hastad": (
        "rsa.broadcast.hastad", "RSA", ["The same unpadded plaintext is sent to at least e pairwise-coprime RSA moduli."],
        ["CRT-combine ciphertexts modulo the product of moduli.", "Take the exact integer e-th root.", "Verify every ciphertext after re-encryption."], ["Padding or differing plaintexts invalidates the direct broadcast attack."]),
    "rsa wiener small d": (
        "rsa.small_private_exponent.wiener", "RSA", ["The private exponent is small enough for the continued-fraction bound."],
        ["Compute convergents of e/n.", "Test each candidate denominator as d by recovering phi and factors.", "Verify p*q == n and decrypt/re-encrypt a sample."], ["Do not treat any small-looking d as Wiener's bound without factor verification."]),
    "rsa fermat close primes": (
        "rsa.fermat.close_primes", "RSA", ["n = p*q and p and q are sufficiently close for a square difference search."],
        ["Set a = ceil(sqrt(n)) and increment a.", "Stop when a*a - n is a perfect square b*b.", "Set p=a-b and q=a+b; verify p*q == n before decrypting."], ["The iteration cost grows with |p-q|; switch factoring methods when the gap is large."]),
    "rsa coppersmith small roots": (
        "rsa.coppersmith.bounded_root", "RSA/Lattice", ["A polynomial relation modulo n has an unknown root whose bound satisfies the selected small-root construction."],
        ["Write the unknown portion as a bounded variable in f(x) over Zmod(n).", "Run a correctly bounded small_roots/LLL construction.", "Substitute every root into the original modular equation and verify the ciphertext relation."], ["A successful LLL reduction is not proof: reject roots outside the bound or failing substitution."]),
    "ecdsa nonce reuse": (
        "signature.ecdsa.reused_nonce", "ECC/Signature", ["Two signatures over the same curve order reuse nonce k, normally shown by the same r."],
        ["Group signatures by r and choose two distinct message hashes.", "Solve the two signature equations modulo the curve order for k and d.", "Recompute a signature or public key with d to verify recovery."], ["Do not apply the reuse formula to merely similar r values or different curve orders."]),
    "cbc padding oracle": (
        "block_cipher.cbc.padding_oracle", "BlockCipher", ["A controllable CBC ciphertext produces a repeatable padding-valid versus padding-invalid oracle."],
        ["Modify bytes of the previous ciphertext block from the end backward.", "Use valid padding responses to recover intermediate bytes.", "XOR the intermediate block with the original previous block and validate plaintext structure."], ["Authentication before decryption or indistinguishable errors removes the oracle."]),
    "cbc bit flipping": (
        "block_cipher.cbc.bit_flipping", "BlockCipher", ["CBC ciphertext or IV is malleable and modified plaintext is consumed without an integrity check."],
        ["Choose a known source plaintext block and desired target block.", "XOR their difference into the preceding ciphertext block or IV.", "Submit the modified ciphertext and verify the intended field is accepted."], ["The preceding plaintext block is corrupted; a MAC or AEAD rejects the modification."]),
    "ecb cut and paste": (
        "block_cipher.ecb.cut_and_paste", "BlockCipher", ["An ECB encryption oracle emits independently encrypted blocks and attacker-controlled input can align fields."],
        ["Determine the block size and align desired fields on block boundaries.", "Encrypt a block containing the target field.", "Splice whole ciphertext blocks and verify the parsed result."], ["This requires ECB; CBC/CTR ciphertext blocks cannot be rearranged this way."]),
    "gcm nonce reuse": (
        "block_cipher.gcm.reused_nonce", "BlockCipher/MAC", ["Two GCM ciphertext/tag pairs use the same nonce under one key."],
        ["Use the reused CTR keystream relation to derive plaintext differences where applicable.", "Build GHASH equations from the observed pairs.", "Verify any recovered relation or forged tag against a local GCM implementation."], ["Different keys or nonces invalidate the relation; preserve exact field and length encoding."]),
    "hash length extension": (
        "hash.merkle_damgard.length_extension", "Hash/MAC", ["The MAC is hash(secret || message) using a Merkle-Damgård hash and a plausible secret length can be tested."],
        ["Initialize the hash state from the known digest.", "Append glue padding for each candidate secret length and the desired suffix.", "Retain only a server-validated forged MAC."], ["HMAC and hash(message || secret) are not vulnerable to this construction."]),
    "prng state recovery": (
        "prng.state_recovery", "PRNG", ["Enough correctly ordered outputs from an identified deterministic generator are observable."],
        ["Normalize observed outputs to the generator's word representation.", "Apply the generator-specific state or seed recovery method.", "Predict a held-out output before using future predictions."], ["Wrong output truncation, order, or generator variant invalidates recovery."]),
    "stream cipher keystream reuse": (
        "stream_cipher.reused_keystream", "StreamCipher", ["Ciphertexts reuse a keystream/nonce or known plaintext reveals keystream bytes."],
        ["XOR ciphertexts to expose plaintext XOR plaintext.", "Use cribs or known structure to derive keystream bytes.", "Decrypt independent samples and validate their format."], ["Never assume key reuse implies nonce or keystream reuse without checking the mode."]),
}


@dataclass(frozen=True)
class CryptoKBDistillReport:
    input_records: int
    candidates: int
    review_queue: int
    rejected: int
    cards_created: int
    published: int
    rejection_reasons: dict[str, int]

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(frozen=True)
class CandidateEvidence:
    record_id: str
    knowledge_point: str
    attack_family: str
    score: int
    source_url: str
    challenge: str
    spans: dict[str, str]
    content_hash: str
    redacted_lines: int

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def distill_crypto_knowledge_base(records: Iterable[AttackMemoryRecord], *, min_score: int = _SCORE_THRESHOLD, max_evidence_per_variant: int = _MAX_EVIDENCE) -> tuple[list[KnowledgeCard], list[CandidateEvidence], list[dict[str, object]], list[CandidateEvidence], CryptoKBDistillReport]:
    """Return published cards plus candidate, rejected and review audit artifacts."""
    candidates: list[CandidateEvidence] = []
    review: list[CandidateEvidence] = []
    rejected: list[dict[str, object]] = []
    reasons: Counter[str] = Counter()
    all_records = list(records)
    for record in all_records:
        candidate, reason = extract_crypto_evidence(record)
        if candidate is None:
            rejected.append({"id": record.id, "status": "rejected", "reason": reason})
            reasons[reason] += 1
        elif candidate.score >= min_score:
            candidates.append(candidate)
        else:
            review.append(candidate)

    grouped: dict[str, list[CandidateEvidence]] = defaultdict(list)
    for candidate in candidates:
        grouped[candidate.knowledge_point].append(candidate)
    cards = [_card_from_evidence(point, _select_evidence(items, max_evidence_per_variant)) for point, items in sorted(grouped.items())]
    cards, publication = filter_publishable_cards(cards)
    # The legacy publication merger canonicalizes ``variant_of`` to the broad
    # attack family. Restore the stable knowledge-point key required by this KB.
    for card in cards:
        card.variant_of = _VARIANTS[card.attack_family][0]
    report = CryptoKBDistillReport(len(all_records), len(candidates), len(review), len(rejected), len(grouped), publication.published_cards, dict(sorted(reasons.items())))
    return cards, candidates, rejected, review, report


def extract_crypto_evidence(record: AttackMemoryRecord) -> tuple[CandidateEvidence | None, str]:
    if record.category.lower() != "crypto" or not record.source_url:
        return None, "missing_crypto_category_or_source"
    sanitized = sanitize_untrusted_text("\n".join((record.text_chunk, record.code_snippet)))
    body = _SECRET_RE.sub("[challenge-specific secret removed]", sanitized.text).strip()
    gate = classify_crypto(body)
    family = _choose_family(gate.attack_pattern, body)
    if not family:
        return None, "no_supported_knowledge_point"
    if not gate.keep:
        return None, "record_does_not_independently_match_crypto_gate"
    if not _ACTION_RE.search(body):
        return None, "missing_actionable_procedure"
    if not _EQUATION_RE.search(body):
        return None, "missing_cryptographic_relation"
    if not _VERIFY_RE.search(body):
        return None, "missing_verification_signal"
    spans = _extract_spans(body)
    if not spans["procedure"] or not spans["verification"]:
        return None, "incomplete_evidence_spans"
    point = _VARIANTS[family][0]
    score = min(100, 25 + 25 + 25 + 15 + (10 if record.code_snippet.strip() else 0))
    return CandidateEvidence(record.id, point, family, score, record.source_url, record.challenge, spans, hashlib.sha256(body.encode("utf-8", "ignore")).hexdigest(), sanitized.redacted_lines), ""


def write_crypto_kb_artifacts(index_dir: str | Path, *, min_score: int = _SCORE_THRESHOLD, max_evidence_per_variant: int = _MAX_EVIDENCE) -> tuple[CryptoKBDistillReport, Path]:
    base = Path(index_dir)
    records = _load_records(base / "records.jsonl")
    cards, candidates, rejected, review, report = distill_crypto_knowledge_base(records, min_score=min_score, max_evidence_per_variant=max_evidence_per_variant)
    evidence_dir = base / "evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    _write_jsonl((item.to_dict() for item in candidates), evidence_dir / "candidates.jsonl")
    _write_jsonl(rejected, evidence_dir / "rejected.jsonl")
    _write_jsonl((item.to_dict() for item in review), base / "knowledge" / "review_queue.jsonl")
    _ = save_cards(cards, base / "knowledge" / "cards.jsonl", include_evidence_text=False)
    report_path = evidence_dir / "distillation_report.json"
    report_path.write_text(json.dumps({"schema": "crypto-kb-distillation.v1", "min_score": min_score, "max_evidence_per_variant": max_evidence_per_variant, **report.to_dict()}, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    return report, report_path


def _choose_family(patterns: list[str], body: str) -> str:
    supported = [item.lower() for item in patterns if item.lower() in _VARIANTS]
    if not supported:
        supported = [rule.label for rule in ATTACK_RULES if rule.label in _VARIANTS and re.search(rule.regex, body, re.I)]
    return max(supported, key=len) if supported else ""


def _extract_spans(body: str) -> dict[str, str]:
    lines = [line.strip() for line in body.splitlines() if line.strip() and not line.startswith("[untrusted")]
    def first(pattern: re.Pattern[str]) -> str:
        return next((line[:700] for line in lines if pattern.search(line)), "")
    return {"precondition": first(re.compile(r"\b(?:if|when|requires?|same nonce|same message|close primes|bounded|pairwise)\b", re.I)), "relation": first(_EQUATION_RE), "procedure": first(_ACTION_RE), "verification": first(_VERIFY_RE)}


def _select_evidence(items: list[CandidateEvidence], limit: int) -> list[CandidateEvidence]:
    selected: list[CandidateEvidence] = []
    seen_urls: set[str] = set()
    seen_hashes: set[str] = set()
    for item in sorted(items, key=lambda candidate: (-candidate.score, candidate.source_url, candidate.record_id)):
        if item.source_url in seen_urls or item.content_hash in seen_hashes:
            continue
        selected.append(item)
        seen_urls.add(item.source_url)
        seen_hashes.add(item.content_hash)
        if len(selected) == limit:
            break
    return selected


def _card_from_evidence(point: str, evidence_items: list[CandidateEvidence]) -> KnowledgeCard:
    family = evidence_items[0].attack_family
    _point, primitive, preconditions, steps, failure_modes = _VARIANTS[family]
    evidence = [EvidenceSpan(source_id=item.record_id, source_url=item.source_url, locator="sanitized evidence package", content_hash=item.content_hash) for item in evidence_items]
    claim = AtomicClaim(text=f"Sanitized local evidence supports the preconditions and procedure for '{point}'.", claim_type="attack-procedure", evidence=evidence)
    return KnowledgeCard(id=stable_id("crypto-kb", point), title=f"{primitive}: {point}", category="crypto", attack_family=family, primitive=[primitive], preconditions=preconditions, steps=steps, failure_modes=failure_modes, evidence=evidence, claims=[claim], source_record_ids=[item.record_id for item in evidence_items], topic="", variant_of=point)


def _load_records(path: Path) -> list[AttackMemoryRecord]:
    if not path.is_file():
        return []
    records: list[AttackMemoryRecord] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            records.append(AttackMemoryRecord.from_dict(json.loads(line)))
        except (ValueError, TypeError, json.JSONDecodeError):
            continue
    return records


def _write_jsonl(items: Iterable[dict[str, object]], path: Path) -> None:
    _ = path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for item in items:
            handle.write(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n")
