"""Local hybrid retrieval index for attack-centric CTF memory."""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Iterable

from .filter import classify_category, classify_crypto, classify_pwn
from .knowledge import KnowledgeCard, load_cards
from .schema import AttackMemoryRecord, SearchHit

DEFAULT_INDEX_DIR = (
    Path(__file__).resolve().parent.parent / "memory" / "attack_memory" / "crypto_v1"
)
RECORDS_FILE = "records.jsonl"
MANIFEST_FILE = "manifest.json"
EMBEDDINGS_FILE = "embeddings.jsonl"
KNOWLEDGE_CARDS_FILE = Path("knowledge") / "cards.jsonl"
TOKEN_RE = re.compile(r"[a-zA-Z0-9_+#.]+|[\u3400-\u4dbf\u4e00-\u9fff]+")
VECTOR_DIM = 384
SUPPORTED_ATTACK_MEMORY_CATEGORIES = ("crypto", "pwn", "web", "reverse")
ATTACK_FAMILY_RULES = {
    "web": (
        (
            "command injection",
            re.compile(r"\b(?:command|shell|os)[ -]?injection\b|命令注入", re.IGNORECASE),
            re.compile(r"\b(?:command|shell|os)[ -]?injection\b|命令注入|系统命令|命令拼接", re.IGNORECASE),
        ),
        (
            "csrf",
            re.compile(r"\bcsrf\b|cross[ -]site request forgery|跨站请求伪造", re.IGNORECASE),
            re.compile(r"\bcsrf\b|cross[ -]site request forgery|跨站请求伪造|跨站.*请求", re.IGNORECASE),
        ),
        (
            "sql injection",
            re.compile(r"\b(?:sql injection|sqli)\b|sql\s*注入", re.IGNORECASE),
            re.compile(r"\b(?:sql injection|sqli)\b|sql\s*注入", re.IGNORECASE),
        ),
        (
            "ssti",
            re.compile(r"\b(?:ssti|server[ -]side template injection)\b|模板注入", re.IGNORECASE),
            re.compile(r"\b(?:ssti|server[ -]side template injection)\b|模板注入", re.IGNORECASE),
        ),
        (
            "ssrf",
            re.compile(r"\b(?:ssrf|server[ -]side request forgery)\b|服务端请求伪造", re.IGNORECASE),
            re.compile(r"\b(?:ssrf|server[ -]side request forgery)\b|服务端请求伪造", re.IGNORECASE),
        ),
        (
            "xss",
            re.compile(r"\b(?:xss|cross[ -]site scripting)\b|跨站脚本", re.IGNORECASE),
            re.compile(r"\b(?:xss|cross[ -]site scripting)\b|跨站脚本", re.IGNORECASE),
        ),
        (
            "file upload",
            re.compile(r"\b(?:file upload|unrestricted upload)\b|文件上传", re.IGNORECASE),
            re.compile(r"\b(?:file upload|unrestricted upload)\b|文件上传|上传绕过", re.IGNORECASE),
        ),
        (
            "request smuggling",
            re.compile(r"\b(?:http )?request smuggling\b|请求走私", re.IGNORECASE),
            re.compile(r"\b(?:http )?request smuggling\b|请求走私|连接复用", re.IGNORECASE),
        ),
        (
            "path traversal",
            re.compile(r"\b(?:path|directory) traversal\b|路径穿越", re.IGNORECASE),
            re.compile(r"\b(?:path|directory) traversal\b|路径穿越|目录穿越", re.IGNORECASE),
        ),
    ),
    "pwn": (
        (
            "use after free",
            re.compile(r"\b(?:use[ -]after[ -]free|uaf)\b|释放后(?:使用|重用)", re.IGNORECASE),
            re.compile(r"\b(?:use[ -]after[ -]free|uaf)\b|释放后(?:使用|重用)|悬垂指针", re.IGNORECASE),
        ),
        (
            "double free",
            re.compile(r"\bdouble[ -]?free\b|双重释放", re.IGNORECASE),
            re.compile(r"\bdouble[ -]?free\b|双重释放|重复释放", re.IGNORECASE),
        ),
        (
            "tcache poisoning",
            re.compile(r"\btcache[ -](?:poisoning|poison)\b|tcache\s*投毒", re.IGNORECASE),
            re.compile(r"\btcache[ -](?:poisoning|poison)\b|tcache\s*投毒", re.IGNORECASE),
        ),
        (
            "off by one",
            re.compile(r"\boff[ -]by[ -](?:one|null)\b|单字节溢出", re.IGNORECASE),
            re.compile(r"\boff[ -]by[ -](?:one|null)\b|单字节溢出", re.IGNORECASE),
        ),
        (
            "rop",
            re.compile(r"\b(?:rop|return[ -]oriented programming|ret2libc)\b", re.IGNORECASE),
            re.compile(r"\b(?:rop|return[ -]oriented programming|ret2libc)\b", re.IGNORECASE),
        ),
        (
            "format string",
            re.compile(r"\bformat[ -]string\b|格式化字符串", re.IGNORECASE),
            re.compile(r"\bformat[ -]string\b|格式化字符串", re.IGNORECASE),
        ),
    ),
    "crypto": (
        (
            "rsa factorization",
            re.compile(
                r"(?=.*\b(?:rsa|modulus)\b)(?=.*\b(?:factor|factorize|factorise|factoring)\b)|rsa\s*分解|分解.*rsa",
                re.IGNORECASE,
            ),
            re.compile(
                r"(?=.*\brsa\b)(?=.*\b(?:fermat|factor|factorization|close primes?)\b)|rsa.*(?:分解|近素数)",
                re.IGNORECASE,
            ),
        ),
    ),
    "reverse": (
        (
            "crackme",
            re.compile(r"\b(?:crackme|keygen(?:me)?|serial checker)\b|注册码|序列号", re.IGNORECASE),
            re.compile(r"\b(?:crackme|keygen(?:me)?|serial checker|serial|license)\b|注册码|序列号", re.IGNORECASE),
        ),
        (
            "anti debugging",
            re.compile(r"\banti[ -]?debug(?:ging)?\b|反调试", re.IGNORECASE),
            re.compile(r"\banti[ -]?debug(?:ging)?\b|反调试", re.IGNORECASE),
        ),
        (
            "binary unpacking",
            re.compile(r"\b(?:binary )?unpack(?:ing)?\b|脱壳", re.IGNORECASE),
            re.compile(r"\b(?:binary )?unpack(?:ing)?\b|脱壳|加壳", re.IGNORECASE),
        ),
    ),
}


# Loaded indexes, keyed by directory: {(path, stamp): HybridAttackMemoryIndex}.
_INDEX_CACHE = {}


def _index_stamp(base):
    """Identify the on-disk inputs so a rebuilt index is not served stale."""
    stamp = []
    for name in (RECORDS_FILE, KNOWLEDGE_CARDS_FILE):
        try:
            stat = (base / name).stat()
        except OSError:
            continue
        stamp.append((name, stat.st_mtime_ns, stat.st_size))
    return tuple(stamp)


class HybridAttackMemoryIndex:
    """Small local hybrid index.

    The implementation is dependency-free for v1: BM25 is exact over local JSONL
    records and the vector side uses feature hashing.  A future external
    embedding provider can replace `_hash_embedding` without changing the stored
    `AttackMemoryRecord` schema.
    """

    def __init__(
        self,
        records: Iterable[AttackMemoryRecord] | None = None,
        *,
        vector_dim: int = VECTOR_DIM,
    ):
        self.records = list(records or [])
        self.vector_dim = int(vector_dim or VECTOR_DIM)
        self._doc_tokens: list[list[str]] = []
        self._term_freqs: list[Counter[str]] = []
        self._doc_freqs: Counter[str] = Counter()
        self._vectors: list[dict[int, float]] = []
        self._avgdl = 0.0
        self._build_runtime_index()

    @classmethod
    def load(cls, index_dir: str | Path | None = None) -> "HybridAttackMemoryIndex":
        """Load an index, reusing the one already built for this directory.

        Parsing crypto_v1 costs ~3.6s for its 6124 records, and the host
        answers one query per prompt, so without reuse every lookup pays that
        again and blows the caller's budget before the first candidate is scored.
        """
        base = Path(index_dir or DEFAULT_INDEX_DIR)
        key = str(base.resolve())
        stamp = _index_stamp(base)
        cached = _INDEX_CACHE.get(key)
        if cached is not None and cached[0] == stamp:
            return cached[1]
        records_path = base / RECORDS_FILE
        records = []
        if records_path.is_file():
            with records_path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        records.append(AttackMemoryRecord.from_dict(json.loads(line)))
                    except (TypeError, ValueError, json.JSONDecodeError):
                        continue
        seen_ids = {record.id for record in records}
        for record in _load_knowledge_card_records(base):
            if record.id not in seen_ids:
                records.append(record)
                seen_ids.add(record.id)
        index = cls(records)
        _INDEX_CACHE[key] = (stamp, index)
        return index

    def save(self, index_dir: str | Path | None = None) -> Path:
        base = Path(index_dir or DEFAULT_INDEX_DIR)
        base.mkdir(parents=True, exist_ok=True)
        records_path = base / RECORDS_FILE
        records_tmp = records_path.with_suffix(".jsonl.tmp")
        with records_tmp.open("w", encoding="utf-8") as f:
            for record in self.records:
                f.write(record.to_json() + "\n")
        records_tmp.replace(records_path)
        embeddings_path = base / EMBEDDINGS_FILE
        embeddings_tmp = embeddings_path.with_suffix(".jsonl.tmp")
        with embeddings_tmp.open("w", encoding="utf-8") as f:
            for record, vector in zip(self.records, self._vectors):
                f.write(
                    json.dumps(
                        {"id": record.id, "vector": sorted(vector.items())},
                        ensure_ascii=False,
                    )
                    + "\n"
                )
        embeddings_tmp.replace(embeddings_path)
        manifest = {
            "schema_version": "attack-memory-index.v1",
            "record_count": len(self.records),
            "vector_dim": self.vector_dim,
            "records_file": RECORDS_FILE,
            "embeddings_file": EMBEDDINGS_FILE,
            "retrieval": {
                "keyword": "BM25",
                "vector": "hashing-embedding",
                "rerank": "attack-pattern-field-boost",
            },
        }
        (base / MANIFEST_FILE).write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        return base

    def search(
        self,
        query: str,
        *,
        top_k: int = 5,
        rerank: bool = True,
        category: str | None = None,
        categories: Iterable[str] | str | None = None,
    ) -> list[SearchHit]:
        query = query or ""
        if not query.strip() or not self.records:
            return []
        category_filter = (
            normalize_attack_categories(category=category, categories=categories)
            if category is not None or categories is not None
            else None
        )
        if category_filter == ():
            return []
        query_tokens = tokenize(query)
        if not query_tokens:
            return []
        query_vector = _hash_embedding(query_tokens, dim=self.vector_dim)
        query_terms = set(query_tokens)
        query_gates = {}
        query_families_by_category = {}

        raw_hits: list[SearchHit] = []
        for idx, record in enumerate(self.records):
            record_category = str(record.category or "crypto").strip().lower()
            if category_filter is not None and record_category not in category_filter:
                continue
            query_gate = query_gates.get(record_category)
            if query_gate is None:
                query_gate = classify_category(query, category=record_category)
                query_gates[record_category] = query_gate
            query_families = query_families_by_category.get(record_category)
            if query_families is None:
                query_families = _query_attack_families(query, record_category)
                query_families_by_category[record_category] = query_families
            query_patterns = {item.lower() for item in query_gate.attack_pattern}
            query_crypto = {item.lower() for item in query_gate.crypto_type}
            bm25 = self._bm25_score(query_tokens, idx)
            vector = _cosine_sparse(query_vector, self._vectors[idx])
            boost, matched = (
                self._rerank_boost(
                    record,
                    query_terms,
                    query_patterns,
                    query_crypto,
                    query_families,
                )
                if rerank
                else (0.0, [])
            )
            score = bm25 + (3.0 * vector) + boost
            if score <= 0:
                continue
            raw_hits.append(
                SearchHit(
                    record=record,
                    score=round(score, 6),
                    bm25_score=round(bm25, 6),
                    vector_score=round(vector, 6),
                    rerank_score=round(boost, 6),
                    matched_patterns=matched,
                    snippet=_snippet(record, query_terms),
                )
            )
        raw_hits.sort(
            key=lambda hit: (
                -hit.score,
                hit.record.event.lower(),
                hit.record.challenge.lower(),
                hit.record.id,
            )
        )
        return raw_hits[: max(1, int(top_k or 5))]

    def _build_runtime_index(self) -> None:
        self._doc_tokens = []
        self._term_freqs = []
        self._doc_freqs = Counter()
        self._vectors = []
        total_len = 0
        for record in self.records:
            tokens = tokenize(_record_search_text(record))
            self._doc_tokens.append(tokens)
            tf = Counter(tokens)
            self._term_freqs.append(tf)
            self._doc_freqs.update(tf.keys())
            total_len += len(tokens)
            self._vectors.append(_hash_embedding(tokens, dim=self.vector_dim))
        self._avgdl = total_len / len(self.records) if self.records else 0.0

    def _bm25_score(self, query_tokens: list[str], doc_index: int) -> float:
        if not self.records or not self._avgdl:
            return 0.0
        k1 = 1.5
        b = 0.75
        score = 0.0
        tf = self._term_freqs[doc_index]
        dl = len(self._doc_tokens[doc_index]) or 1
        n_docs = len(self.records)
        for term in query_tokens:
            freq = tf.get(term, 0)
            if freq <= 0:
                continue
            df = self._doc_freqs.get(term, 0)
            idf = math.log(1 + (n_docs - df + 0.5) / (df + 0.5))
            denom = freq + k1 * (1 - b + b * dl / self._avgdl)
            score += idf * (freq * (k1 + 1)) / denom
        return score

    def _rerank_boost(
        self,
        record: AttackMemoryRecord,
        query_terms: set[str],
        query_patterns: set[str],
        query_crypto: set[str],
        query_families: set[str],
    ) -> tuple[float, list[str]]:
        score = 0.0
        matched: list[str] = []
        record_patterns = [pattern.lower() for pattern in record.attack_pattern]
        record_crypto = [ctype.lower() for ctype in record.crypto_type]
        for pattern in record_patterns:
            pattern_terms = set(tokenize(pattern))
            if pattern in query_patterns or (
                pattern_terms
                and len(pattern_terms & query_terms) >= min(2, len(pattern_terms))
            ):
                score += 4.0
                matched.append(pattern)
        for ctype in record_crypto:
            if ctype in query_crypto or set(tokenize(ctype)) & query_terms:
                score += 1.2
        alias_families = _record_attack_families(record, query_families)
        if alias_families:
            score += 8.0 * len(alias_families)
            focus_text = "\n".join(
                [
                    record.event,
                    record.source_title,
                    *record.crypto_type,
                    *record.tags,
                ]
            )
            focused_families = _text_attack_families(
                focus_text,
                str(record.category or "").lower(),
                alias_families,
            )
            score += 12.0 * len(focused_families) / max(1, len(record.crypto_type))
            matched.extend(sorted(alias_families))
        challenge_terms = set(tokenize(record.challenge))
        if challenge_terms & query_terms:
            score += 0.4
        libc_terms = set(tokenize(" ".join(record.libc_versions)))
        if libc_terms & query_terms:
            score += 2.0
        # Prefer records whose canonical labels are populated; v1 treats labels as
        # retrieval memory, not just display metadata.
        if record.attack_pattern:
            score += 0.25
        return score, list(dict.fromkeys(matched))


def build_index(
    records: Iterable[AttackMemoryRecord], index_dir: str | Path | None = None
) -> HybridAttackMemoryIndex:
    index = HybridAttackMemoryIndex(records)
    index.save(index_dir)
    return index


def search_attack_memory(
    query: str,
    *,
    index_dir: str | Path | None = None,
    top_k: int = 5,
    rerank: bool = True,
    category: str | None = None,
    categories: Iterable[str] | str | None = None,
) -> list[SearchHit]:
    return HybridAttackMemoryIndex.load(index_dir).search(
        query,
        top_k=top_k,
        rerank=rerank,
        category=category,
        categories=categories,
    )


def search_knowledge_cards(
    query: str, *, cards_path: str | Path, top_k: int = 5
) -> list[tuple[KnowledgeCard, float, list[str]]]:
    """Search sanitized, provenance-first crypto cards without returning WP text."""

    query_tokens = set(tokenize(query))
    if not query_tokens:
        return []
    query_gate = classify_crypto(query)
    query_patterns = {item.lower() for item in query_gate.attack_pattern}
    query_families = _query_attack_families(query, "crypto")
    hits: list[tuple[KnowledgeCard, float, list[str]]] = []
    for card in load_cards(cards_path):
        if card.category.lower() != "crypto":
            continue
        # A recognized attack taxonomy label is more reliable than lexical
        # overlap.  Without this gate, a missing GCM card could return an ECDSA
        # card merely because both mention "nonce reuse".
        if query_patterns and card.attack_family.lower() not in query_patterns:
            continue
        searchable = "\n".join(
            [
                card.title,
                card.attack_family,
                " ".join(card.primitive),
                " ".join(card.preconditions),
                " ".join(card.steps),
                " ".join(card.failure_modes),
                " ".join(card.tools),
            ]
        )
        card_tokens = set(tokenize(searchable))
        overlap = query_tokens & card_tokens
        if not overlap:
            continue
        family = card.attack_family.lower()
        score = float(len(overlap))
        if family in query_patterns:
            score += 8.0
        alias_families = _text_attack_families(
            searchable,
            "crypto",
            query_families,
        )
        if alias_families:
            score += 8.0 * len(alias_families)
        family_terms = set(tokenize(family))
        matched_family_terms = family_terms & query_tokens
        if family_terms:
            score += 3.0 * len(matched_family_terms) / len(family_terms)
            # Exact family terminology (for example ``gcm`` or ``ecdsa``) is
            # more specific than a shared symptom such as ``nonce reuse``.
            # Require a family-specific token before a generic card can win.
            distinctive = family_terms - {"nonce", "reuse", "small", "state", "recovery", "cipher", "key"}
            if distinctive and distinctive <= query_tokens:
                score += 6.0
        if card.verification_status == "verified":
            score += 0.5
        hits.append((card, round(score, 6), sorted(overlap)))
    hits.sort(key=lambda item: (-item[1], item[0].title.lower(), item[0].id))
    return hits[: max(1, int(top_k or 5))]


def _knowledge_card_match(
    card: KnowledgeCard,
    score: float,
    matched_terms: list[str],
    *,
    index_name: str,
    query_patterns: set[str],
    query_families: set[str],
    include_full_record: bool = False,
) -> dict[str, object]:
    """Expose curated card fields only; WP evidence text is deliberately excluded."""

    summary_parts = [
        f"Attack: {card.attack_family}.",
        "Preconditions: " + "; ".join(card.preconditions[:2]) if card.preconditions else "",
        "Steps: " + " ".join(card.steps[:2]) if card.steps else "",
        "Failure modes: " + " ".join(card.failure_modes[:1]) if card.failure_modes else "",
    ]
    source_urls = list(dict.fromkeys(item.source_url for item in card.evidence if item.source_url))
    searchable = "\n".join(
        [
            card.title,
            card.attack_family,
            " ".join(card.primitive),
            " ".join(card.preconditions),
            " ".join(card.steps),
            " ".join(card.failure_modes),
        ]
    )
    matched_aliases = _text_attack_families(
        searchable,
        card.category,
        query_families,
    )
    matched_patterns = []
    if card.attack_family.lower() in query_patterns:
        matched_patterns.append(card.attack_family)
    matched_patterns.extend(sorted(matched_aliases))
    match = {
        "path": f"attack_memory/{index_name}/knowledge/cards.jsonl",
        "record_id": card.id,
        "score": score,
        "snippet": " ".join(part for part in summary_parts if part),
        "kind": "knowledge_card",
        "category": card.category.lower(),
        "event": "knowledge-base",
        "challenge": card.title,
        "crypto_type": card.primitive,
        "attack_pattern": [card.attack_family],
        "source_url": source_urls[0] if source_urls else "",
        "source_urls": source_urls[:5],
        "label": card.attack_family,
        "matched_patterns": matched_patterns,
        "matched_terms": matched_terms,
        "why_matched": _why_matched(card.category, matched_patterns, matched_terms),
        "recognition_signals": list(
            dict.fromkeys(matched_patterns + matched_terms + card.primitive)
        )[:12],
        "preconditions": card.preconditions,
        "attack_steps": card.steps,
        "poc": "",
        "failure_modes": card.failure_modes,
        "topic": card.topic,
        "tools": card.tools,
        "verification_status": card.verification_status,
        "review_status": card.review_status,
        "evidence_count": len(card.evidence),
        "source_record_ids": card.source_record_ids,
    }
    if include_full_record:
        match["canonical_poc"] = ""
        match["full_record"] = {
            "record_id": card.id,
            "category": card.category.lower(),
            "attack_family": card.attack_family,
            "primitive": card.primitive,
            "preconditions": card.preconditions,
            "attack_steps": card.steps,
            "failure_modes": card.failure_modes,
            "source_urls": source_urls[:5],
            "review_status": card.review_status,
            "verification_status": card.verification_status,
            "topic": card.topic,
            "tools": card.tools,
        }
    return match


def knowledge_base_snapshot(memory_dir: str | Path | None = None) -> dict[str, object]:
    """Identify the exact corpus a retrieval read.

    Ablation runs must be comparable, so the audit trail needs a value that
    changes whenever the cards change. The corpus is split into one directory
    per category (``crypto_v1``, ``pwn_v1``, ...), so every one of them is
    fingerprinted and the aggregate is what identifies the snapshot.
    """

    base = (Path(memory_dir) / "attack_memory") if memory_dir is not None else DEFAULT_INDEX_DIR.parent
    try:
        index_dirs = sorted(path for path in base.glob("*_v*") if path.is_dir())
    except OSError:
        index_dirs = []
    if not index_dirs and base.is_dir():
        index_dirs = [base]

    per_category: dict[str, dict[str, object]] = {}
    total_records = 0
    schema_versions: set[str] = set()
    aggregate = hashlib.sha256()
    for index_dir in index_dirs:
        entry: dict[str, object] = {}
        try:
            manifest = json.loads((index_dir / MANIFEST_FILE).read_text(encoding="utf-8"))
        except Exception:
            manifest = None
        if isinstance(manifest, dict):
            schema_version = manifest.get("schema_version")
            if isinstance(schema_version, str) and schema_version:
                entry["schema_version"] = schema_version
                schema_versions.add(schema_version)
            record_count = manifest.get("record_count")
            if isinstance(record_count, int):
                entry["record_count"] = record_count
                total_records += record_count
        try:
            cards = (index_dir / KNOWLEDGE_CARDS_FILE).read_bytes()
        except Exception:
            cards = b""
        if cards:
            entry["card_fingerprint"] = hashlib.sha256(cards).hexdigest()[:16]
            entry["card_bytes"] = len(cards)
            # A published category may ship cards without a manifest: crypto
            # retrieves straight from the card file. Counting those lines keeps
            # the snapshot from reporting a corpus far smaller than the one the
            # agent can actually search.
            if not isinstance(manifest, dict) or not isinstance(manifest.get("record_count"), int):
                card_count = cards.count(b"\n")
                entry["record_count"] = card_count
                total_records += card_count
        if entry:
            per_category[index_dir.name] = entry
        aggregate.update(index_dir.name.encode("utf-8"))
        aggregate.update(repr(sorted(entry.items())).encode("utf-8"))

    snapshot: dict[str, object] = {}
    if len(schema_versions) == 1:
        snapshot["schema_version"] = schema_versions.pop()
    if total_records:
        snapshot["record_count"] = total_records
    if per_category:
        snapshot["category_count"] = len(per_category)
        snapshot["categories"] = sorted(per_category)
        # One value to compare across runs: it changes if any category's
        # manifest or card file changed.
        snapshot["card_fingerprint"] = aggregate.hexdigest()[:16]
    return snapshot


def assess_attack_memory_hits(
    matches: Iterable[dict[str, object]],
) -> dict[str, object]:
    """Summarize deterministic retrieval quality without an LLM fallback."""

    candidates = list(matches)
    accepted = [item for item in candidates if item.get("quality_status") == "accepted"]
    ambiguous = [item for item in candidates if item.get("quality_status") == "ambiguous"]
    if accepted:
        status = "accepted"
        reasons = ["one_or_more_strong_matches"]
    elif ambiguous:
        status = "ambiguous"
        reasons = ["only_weak_or_incomplete_matches"]
    else:
        status = "rejected"
        reasons = ["no_usable_matches"]
    scores = [float(item.get("score") or 0.0) for item in candidates]
    return {
        "status": status,
        "reasons": reasons,
        "candidate_count": len(candidates),
        "accepted_count": len(accepted),
        "ambiguous_count": len(ambiguous),
        "rejected_count": len(candidates) - len(accepted) - len(ambiguous),
        "accepted_record_ids": [str(item.get("record_id") or "") for item in accepted],
        "top_score": round(scores[0], 6) if scores else 0.0,
        "score_margin": round(scores[0] - scores[1], 6) if len(scores) > 1 else None,
    }


def attack_hits_for_memory_search(
    query: str,
    *,
    memory_dir: str | Path | None = None,
    limit: int = 5,
    category: str | None = None,
    categories: Iterable[str] | str | None = None,
    exclude_ids: Iterable[str] | None = None,
    include_full_record: bool = False,
) -> list[dict[str, object]]:
    """Return all available category index hits in `memory_search` result shape.

    ``exclude_ids`` removes already injected card/record IDs before the final
    truncation so deduplication does not silently shrink the top-k window.
    ``include_full_record`` adds ``canonical_poc`` and ``full_record`` payloads
    for the runtime knowledge coordinator; the default shape stays backward
    compatible with legacy callers.
    """

    base = Path(memory_dir) / "attack_memory" if memory_dir is not None else DEFAULT_INDEX_DIR.parent
    excluded_ids = {str(item).strip() for item in exclude_ids or () if str(item).strip()}
    # Fetch a larger candidate window when exclusions are present so the
    # deduplicated result can still fill the requested top-k.
    fetch_limit = max(1, int(limit or 5)) + len(excluded_ids)
    explicit_categories = category is not None or categories is not None
    requested_categories = normalize_attack_categories(
        category=category,
        categories=categories,
    )
    # Prevent noisy cross-category records from outranking a clearly identified
    # exploit family. An explicit caller filter is authoritative and is never
    # broadened or narrowed by query classification.
    if not explicit_categories:
        if classify_pwn(query).keep and "pwn" in requested_categories:
            requested_categories = ("pwn",)
        elif classify_crypto(query).keep and "crypto" in requested_categories:
            requested_categories = ("crypto",)
    out = []
    query_terms = set(tokenize(query))
    for category in requested_categories:
        index_dirs = sorted(p for p in base.glob(f"{category}_v*") if p.is_dir())
        if not index_dirs:
            continue
        for index_dir in index_dirs:
            # Every category, crypto included, searches the same record indexes.
            # Crypto was previously pinned to knowledge/cards.jsonl, a corpus of
            # 11 attack families; the records behind it describe 436, so topics
            # without a card (ECDSA nonce reuse, LFSR, ...) retrieved nothing.
            hits = search_attack_memory(
                query,
                index_dir=index_dir,
                top_k=fetch_limit,
                category=category,
            )
            for hit in hits:
                record = hit.record
                is_knowledge_card = record.schema_version.endswith("knowledge-card.v1")
                record_category = str(record.category or category).strip().lower()
                label = (
                    ", ".join(record.attack_pattern[:3])
                    or ", ".join(record.crypto_type[:3])
                    or f"{category} attack"
                )
                matched_terms = sorted(
                    query_terms
                    & set(
                        tokenize(
                            " ".join(
                                [
                                    record.challenge,
                                    *record.attack_pattern,
                                    *record.crypto_type,
                                    *record.libc_versions,
                                ]
                            )
                        )
                    )
                )
                record_fields = _record_knowledge_fields(record)
                match = {
                    "path": (
                        f"attack_memory/{index_dir.name}/knowledge/cards.jsonl"
                        if is_knowledge_card
                        else f"attack_memory/{index_dir.name}/records.jsonl"
                    ),
                    "record_id": record.id,
                    "score": hit.score,
                    "snippet": hit.snippet,
                    "kind": "attack_knowledge_card" if is_knowledge_card else "attack_memory",
                    "category": record_category,
                    "event": record.event,
                    "challenge": record.challenge,
                    "crypto_type": record.crypto_type,
                    "attack_pattern": record.attack_pattern,
                    "libc_versions": record.libc_versions,
                    "source_url": record.source_url,
                    "source_urls": [record.source_url] if record.source_url else [],
                    "label": label,
                    "matched_patterns": hit.matched_patterns,
                    "matched_terms": matched_terms,
                    "why_matched": _why_matched(
                        record_category,
                        hit.matched_patterns,
                        matched_terms,
                    ),
                    "recognition_signals": list(
                        dict.fromkeys(
                            hit.matched_patterns
                            + matched_terms
                            + record.crypto_type
                            + record.libc_versions
                            + record_fields["preconditions"]
                        )
                    )[:12],
                    "preconditions": record_fields["preconditions"],
                    "attack_steps": record_fields["attack_steps"],
                    "poc": (record.code_snippet or "")[:2000],
                    "failure_modes": record_fields["failure_modes"],
                    "tools": [],
                    "review_status": "unreviewed",
                    "verification_status": "unverified",
                    "evidence_count": 1 if record.source_url else 0,
                    "source_record_ids": [record.id],
                }
                if include_full_record:
                    match["canonical_poc"] = "" if is_knowledge_card else (record.code_snippet or "")[:4000]
                    match["full_record"] = {
                        "record_id": record.id,
                        "category": record_category,
                        "event": record.event,
                        "challenge": record.challenge,
                        "attack_pattern": record.attack_pattern,
                        "crypto_type": record.crypto_type,
                        "libc_versions": record.libc_versions,
                        "preconditions": record_fields["preconditions"],
                        "attack_steps": record_fields["attack_steps"],
                        "failure_modes": record_fields["failure_modes"],
                        "code_snippet": (record.code_snippet or "")[:4000],
                        "source_url": record.source_url,
                        "source_title": record.source_title,
                        "tags": record.tags,
                    }
                out.append(match)
    if excluded_ids:
        out = [item for item in out if str(item.get("record_id") or "") not in excluded_ids]
    out.sort(
        key=lambda item: (
            -float(item.get("score", 0)),
            str(item.get("path", "")),
            str(item.get("record_id", "")),
        )
    )
    for index, item in enumerate(out):
        score = float(item.get("score") or 0.0)
        next_score = (
            float(out[index + 1].get("score") or 0.0)
            if index + 1 < len(out)
            else None
        )
        score_margin = (
            max(0.0, min(1.0, (score - next_score) / max(score, 0.000001)))
            if next_score is not None
            else None
        )
        _attach_match_quality(
            item,
            query=query,
            score_margin=score_margin,
        )
    return out[: max(1, int(limit or 5))]


def _record_knowledge_fields(record: AttackMemoryRecord) -> dict[str, list[str]]:
    sections = _markdown_sections(record.text_chunk)
    preconditions = _section_values(
        sections,
        ("precondition", "recognition", "适用范围", "前提", "条件", "攻击模式", "题目特征"),
    )
    attack_steps = _section_values(
        sections,
        ("steps", "method", "procedure", "攻击方法", "利用方法", "利用原理", "步骤"),
    )
    failure_modes = _section_values(
        sections,
        ("failure", "limitation", "pitfall", "失败", "限制", "注意事项", "常见错误"),
    )
    category = str(record.category or "").strip().lower()
    if not preconditions:
        preconditions = _challenge_constraints(record.challenge)
    if category == "web" and not preconditions:
        preconditions = list(record.attack_pattern)
    if category == "reverse" and not attack_steps:
        attack_steps = list(record.attack_pattern)
    if category == "pwn" and not attack_steps and (
        len(record.attack_pattern) > 1
        or any(len(item) >= 80 for item in record.attack_pattern)
    ):
        attack_steps = list(record.attack_pattern)
    return {
        "preconditions": preconditions[:8],
        "attack_steps": attack_steps[:10],
        "failure_modes": failure_modes[:6],
    }


def _markdown_sections(text: str) -> dict[str, list[str]]:
    sections: dict[str, list[str]] = {}
    heading = ""
    in_fence = False
    for raw_line in (text or "").splitlines():
        line = raw_line.strip()
        if line.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        heading_match = re.match(r"^#{1,6}\s+(.+?)\s*$", line)
        if heading_match:
            heading = heading_match.group(1).strip().lower()
            sections.setdefault(heading, [])
            continue
        if heading and line:
            value = re.sub(r"^(?:[-*+]\s+|\d+[.)]\s+)", "", line).strip()
            if value and value not in sections[heading]:
                sections[heading].append(value[:500])
    return sections


def _section_values(
    sections: dict[str, list[str]],
    heading_markers: tuple[str, ...],
) -> list[str]:
    values = []
    for heading, items in sections.items():
        if not any(marker in heading for marker in heading_markers):
            continue
        for item in items:
            if item not in values:
                values.append(item)
    return values


def _challenge_constraints(challenge: str) -> list[str]:
    labels = "输入|前提|约束|隐藏问题|适用范围|input|preconditions?|constraints?"
    stop_labels = labels + "|目标|goal|objective"
    pattern = re.compile(
        rf"(?:^|[。.!?]\s*)(?:{labels})\s*[:：]\s*(.+?)(?=(?:{stop_labels})\s*[:：]|$)",
        re.IGNORECASE | re.DOTALL,
    )
    return [
        re.sub(r"\s+", " ", match.group(1)).strip(" ;；。")[:500]
        for match in pattern.finditer(challenge or "")
        if match.group(1).strip()
    ]


def _query_attack_families(query: str, category: str) -> set[str]:
    return {
        family
        for family, query_pattern, _record_pattern in ATTACK_FAMILY_RULES.get(
            str(category or "").lower(), ()
        )
        if query_pattern.search(query or "")
    }


def _record_attack_families(
    record: AttackMemoryRecord,
    requested_families: set[str],
) -> set[str]:
    return _text_attack_families(
        _record_search_text(record),
        str(record.category or "").lower(),
        requested_families,
    )


def _text_attack_families(
    searchable: str,
    category: str,
    requested_families: set[str],
) -> set[str]:
    if not requested_families:
        return set()
    return {
        family
        for family, _query_pattern, record_pattern in ATTACK_FAMILY_RULES.get(
            category, ()
        )
        if family in requested_families and record_pattern.search(searchable)
    }


def normalize_attack_categories(
    *,
    category: str | None = None,
    categories: Iterable[str] | str | None = None,
) -> tuple[str, ...]:
    """Normalize a caller-provided category filter without silently widening it."""

    values = []
    if category is not None:
        values.append(str(category))
    if categories is not None:
        if isinstance(categories, str):
            values.extend(re.split(r"[,;\s]+", categories))
        else:
            try:
                values.extend(str(item) for item in categories)
            except TypeError as exc:
                raise ValueError("categories must be a string or iterable of strings") from exc
    if category is None and categories is None:
        return SUPPORTED_ATTACK_MEMORY_CATEGORIES

    normalized = []
    invalid = []
    for item in values:
        value = item.strip().lower()
        if not value:
            continue
        if value not in SUPPORTED_ATTACK_MEMORY_CATEGORIES:
            invalid.append(value)
            continue
        if value not in normalized:
            normalized.append(value)
    if invalid:
        supported = ", ".join(SUPPORTED_ATTACK_MEMORY_CATEGORIES)
        raise ValueError(
            f"Unsupported attack memory category: {', '.join(dict.fromkeys(invalid))}. "
            f"Supported categories: {supported}."
        )
    return tuple(normalized)


def _why_matched(
    category: str,
    matched_patterns: Iterable[str],
    matched_terms: Iterable[str],
) -> str:
    patterns = [str(item) for item in matched_patterns if str(item)]
    terms = [str(item) for item in matched_terms if str(item)]
    if patterns:
        detail = "attack pattern " + ", ".join(patterns[:3])
    elif terms:
        detail = "terms " + ", ".join(terms[:6])
    else:
        detail = "hybrid lexical/vector similarity"
    return f"category={str(category or 'unknown').lower()}; matched {detail}"


_TRUSTED_REVIEW_STATUSES = {"approved", "published", "reviewed", "trusted"}
_REJECTED_REVIEW_STATUSES = {"deprecated", "invalid", "rejected"}
_TRUSTED_VERIFICATION_STATUSES = {"verified"}
_REJECTED_VERIFICATION_STATUSES = {"disproven", "failed", "invalid", "rejected"}
_PRECONDITION_STOP_WORDS = {
    "and",
    "are",
    "for",
    "from",
    "has",
    "have",
    "into",
    "not",
    "that",
    "the",
    "then",
    "this",
    "with",
}


def _query_supports_preconditions(query: str, preconditions: Iterable[str]) -> bool:
    query_terms = set(tokenize(query)) - _PRECONDITION_STOP_WORDS
    if not query_terms:
        return False
    for precondition in preconditions:
        terms = set(tokenize(str(precondition))) - _PRECONDITION_STOP_WORDS
        significant = {term for term in terms if len(term) >= 3 or not term.isascii()}
        if significant & query_terms:
            return True
    return False


def _precondition_conflicts(query: str, preconditions: Iterable[str]) -> list[str]:
    """Detect small, high-confidence contradictions without inventing target facts."""

    query_text = query or ""
    precondition_text = " ".join(str(item) for item in preconditions)
    conflicts = []
    requires_close_factors = re.search(
        r"\b(?:(?:close|near(?:by)?)\s+(?:prime|factor)s?|sufficiently\s+close|square\s+difference)\b",
        precondition_text,
        re.IGNORECASE,
    )
    if requires_close_factors and re.search(
        r"\b(?:(?:prime|factor)s?\s+(?:are\s+)?(?:far|distant|widely\s+separated)|not\s+close\s+(?:prime|factor)s?)\b",
        query_text,
        re.IGNORECASE,
    ):
        conflicts.append("close_prime_precondition_conflict")
    return conflicts


def _attach_match_quality(
    match: dict[str, object],
    *,
    query: str = "",
    score_margin: float | None = None,
) -> None:
    reasons = ["category_match"]
    text = " ".join(
        str(match.get(key) or "")
        for key in ("challenge", "snippet", "label")
    )
    quality_score = 0.0
    if "\ufffd" in text:
        status = "rejected"
        reasons.append("corrupted_text")
    elif not match.get("source_url"):
        status = "rejected"
        reasons.append("missing_provenance")
    elif not match.get("label") and not match.get("attack_pattern"):
        status = "rejected"
        reasons.append("missing_attack_family")
    elif not text.strip():
        status = "rejected"
        reasons.append("empty_body")
    else:
        quality_score += 0.1
        matched_patterns = list(match.get("matched_patterns") or [])
        matched_terms = list(match.get("matched_terms") or [])
        if matched_patterns:
            status = "accepted"
            quality_score += 0.55
            reasons.append("attack_pattern_match")
        elif len(matched_terms) >= 2:
            status = "ambiguous"
            quality_score += 0.35
            reasons.append("lexical_match_without_attack_pattern")
        else:
            status = "rejected"
            quality_score += 0.1
            reasons.append("weak_lexical_overlap")
        # Both crypto cards (_knowledge_card_match -> "knowledge_card") and
        # non-crypto card records (attack_hits_for_memory_search ->
        # "attack_knowledge_card") represent curated knowledge cards and must
        # enter the same structured quality gate.  Otherwise a draft/unreviewed
        # non-crypto card would be labelled accepted without any review,
        # verification, or precondition checks.
        if match.get("kind") in ("knowledge_card", "attack_knowledge_card"):
            required = ("preconditions", "attack_steps", "failure_modes")
            if not all(match.get(field) for field in required):
                status = "ambiguous" if status == "accepted" else status
                reasons.append("incomplete_knowledge_card")
            else:
                quality_score += 0.1
                reasons.append("structured_knowledge_card")
            review_status = str(match.get("review_status") or "").strip().lower()
            verification_status = str(match.get("verification_status") or "").strip().lower()
            if review_status in _REJECTED_REVIEW_STATUSES:
                status = "rejected"
                reasons.append(f"review_status_{review_status}")
            elif review_status in _TRUSTED_REVIEW_STATUSES:
                quality_score += 0.05
                reasons.append("review_status_trusted")
            else:
                reasons.append(f"review_status_{review_status or 'unknown'}")
            if verification_status in _REJECTED_VERIFICATION_STATUSES:
                status = "rejected"
                reasons.append(f"verification_status_{verification_status}")
            elif verification_status in _TRUSTED_VERIFICATION_STATUSES:
                quality_score += 0.05
                reasons.append("verification_status_verified")
            else:
                reasons.append(f"verification_status_{verification_status or 'unknown'}")

            preconditions = [str(item) for item in list(match.get("preconditions") or [])]
            conflicts = _precondition_conflicts(query, preconditions)
            if conflicts:
                status = "rejected"
                reasons.extend(conflicts)
            elif preconditions and _query_supports_preconditions(query, preconditions):
                quality_score += 0.1
                reasons.append("precondition_evidence_in_query")
            elif (
                preconditions
                and review_status not in _TRUSTED_REVIEW_STATUSES
                and verification_status not in _TRUSTED_VERIFICATION_STATUSES
            ):
                status = "ambiguous" if status == "accepted" else status
                reasons.append("unconfirmed_preconditions")
            elif preconditions:
                reasons.append("preconditions_require_runtime_validation")
        if score_margin is not None:
            if score_margin >= 0.15:
                quality_score += 0.05
                reasons.append("clear_score_margin")
            else:
                reasons.append("low_score_margin")
    quality = {
        "status": status,
        "score": round(min(1.0, quality_score), 3),
        "score_margin": round(score_margin, 6) if score_margin is not None else None,
        "reasons": reasons,
    }
    match["quality_status"] = status
    match["quality"] = quality


def _load_knowledge_card_records(index_dir: Path) -> list[AttackMemoryRecord]:
    path = index_dir / KNOWLEDGE_CARDS_FILE
    if not path.is_file():
        return []
    records = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                card = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(card, dict):
                continue
            attack_family = str(card.get("attack_family") or "").strip()
            title = str(card.get("title") or attack_family).strip()
            if not title or not attack_family:
                continue
            primitives = _card_strings(card.get("primitive"))
            preconditions = _card_strings(card.get("preconditions"))
            steps = _card_strings(card.get("steps"))
            failure_modes = _card_strings(card.get("failure_modes"))
            claims = [
                str(item.get("text") or "").strip()
                for item in card.get("claims") or []
                if isinstance(item, dict) and str(item.get("text") or "").strip()
            ]
            evidence = card.get("evidence") or []
            source_url = next(
                (
                    str(item.get("source_url") or "").strip()
                    for item in evidence
                    if isinstance(item, dict) and item.get("source_url")
                ),
                "",
            )
            sections = [title, f"Attack family: {attack_family}"]
            for heading, values in (
                ("Preconditions", preconditions),
                ("Steps", steps),
                ("Failure modes", failure_modes),
                ("Claims", claims),
            ):
                if values:
                    sections.append(f"{heading}: " + " ".join(values))
            records.append(
                AttackMemoryRecord(
                    id=str(card.get("id") or ""),
                    category=str(card.get("category") or "crypto"),
                    event="Curated Attack Knowledge",
                    challenge=title,
                    crypto_type=primitives,
                    attack_pattern=[attack_family],
                    text_chunk="\n".join(sections),
                    code_snippet="\n".join(steps),
                    source_url=source_url,
                    source_title=title,
                    tags=_card_strings(
                        [
                            card.get("topic"),
                            card.get("variant_of"),
                            card.get("review_status"),
                            card.get("verification_status"),
                        ]
                    ),
                    schema_version=str(card.get("schema_version") or "crypto-knowledge-card.v1"),
                )
            )
    return records


def _card_strings(value) -> list[str]:
    items = value if isinstance(value, (list, tuple)) else [value]
    return [str(item).strip() for item in items if item is not None and str(item).strip()]


def tokenize(text: str) -> list[str]:
    tokens: list[str] = []
    for raw in TOKEN_RE.findall((text or "").lower()):
        raw = raw.strip("._")
        if not raw:
            continue
        tokens.append(raw)
        if "." in raw or "_" in raw or "+" in raw or "#" in raw:
            tokens.extend(part for part in re.split(r"[._+#]+", raw) if len(part) > 1)
    # Preserve common crypto shorthand: e=3 often tokenizes as only 3, so add e3.
    if re.search(r"\be\s*=\s*3\b", text or "", re.IGNORECASE):
        tokens.append("e3")
    return [token for token in tokens if len(token) > 1 or token.isdigit()]


def _record_search_text(record: AttackMemoryRecord) -> str:
    pattern_text = "\n".join(record.attack_pattern * 5)
    crypto_text = "\n".join(record.crypto_type * 3)
    tag_text = "\n".join(record.tags)
    libc_text = "\n".join(record.libc_versions * 4)
    return "\n".join(
        [
            pattern_text,
            crypto_text,
            tag_text,
            libc_text,
            record.event,
            record.challenge,
            record.source_title,
            record.text_chunk,
            record.code_snippet,
        ]
    )


def _hash_embedding(tokens: list[str], *, dim: int) -> dict[int, float]:
    if not tokens:
        return {}
    counts = Counter(tokens)
    vector: dict[int, float] = defaultdict(float)
    for token, count in counts.items():
        digest = _stable_hash(token)
        idx = digest % dim
        sign = 1.0 if ((digest >> 10) & 1) == 0 else -1.0
        vector[idx] += sign * (1.0 + math.log(count))
    norm = math.sqrt(sum(value * value for value in vector.values()))
    if norm <= 0:
        return {}
    return {idx: value / norm for idx, value in vector.items() if value}


def _stable_hash(token: str) -> int:
    import hashlib

    data = hashlib.blake2b(token.encode("utf-8", "ignore"), digest_size=8).digest()
    return int.from_bytes(data, "big", signed=False)


def _cosine_sparse(left: dict[int, float], right: dict[int, float]) -> float:
    if not left or not right:
        return 0.0
    if len(left) > len(right):
        left, right = right, left
    return sum(value * right.get(idx, 0.0) for idx, value in left.items())


def _snippet(
    record: AttackMemoryRecord, query_terms: set[str], *, max_chars: int = 420
) -> str:
    text = re.sub(r"\s+", " ", record.text_chunk or record.code_snippet or "").strip()
    if not text:
        return ""
    lower = text.lower()
    positions = [lower.find(term) for term in query_terms if lower.find(term) >= 0]
    pos = min(positions) if positions else 0
    start = max(0, pos - max_chars // 3)
    end = min(len(text), start + max_chars)
    snippet = text[start:end].strip()
    if start > 0:
        snippet = "…" + snippet
    if end < len(text):
        snippet += "…"
    return snippet
