#!/usr/bin/env python3
"""Offline ranking ablation for the attack-memory shards (R10 evaluation).

The plan asks whether stronger Chinese retrieval, semantic retrieval, or extra
reranking is worth implementing. This script answers it with numbers instead of
intuition: it replays each shard, uses a card's own text as a self-retrieval
query, and compares the scoring components the index already ships with.

    python legacy/scripts/evaluate_attack_memory_ranking.py
    python legacy/scripts/evaluate_attack_memory_ranking.py --category web --samples 200
    python legacy/scripts/evaluate_attack_memory_ranking.py --json

Configurations (all reuse index.py internals; nothing is retrained):

    bm25          keyword score only
    bm25+vector   keyword + hashing embedding (the semantic component)
    bm25+rerank   keyword + attack-pattern field boost
    full          score = bm25 + 3*vector + boost (what search() uses)

`rerank` and `semantic` columns therefore answer the two R10 questions
directly: does the semantic channel earn its weight, and does reranking change
the top of the list?
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

LEGACY_ROOT = Path(__file__).resolve().parents[1]
if str(LEGACY_ROOT) not in sys.path:
    sys.path.insert(0, str(LEGACY_ROOT))

from ctf_attack_memory.index import (  # noqa: E402
    _cosine_sparse,
    _hash_embedding,
    _query_attack_families,
    HybridAttackMemoryIndex,
    classify_category,
    tokenize,
)

CATEGORIES = ("web", "pwn", "crypto", "reverse")
TOP_KS = (1, 5, 10)
CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
VECTOR_WEIGHT = 3.0


def latest_shard(memory_root: Path, category: str) -> Path | None:
    versions = []
    for candidate in memory_root.glob(f"{category}_v*"):
        if not candidate.is_dir():
            continue
        suffix = candidate.name[len(category) + 2 :]
        if suffix.isdigit():
            versions.append((int(suffix), candidate))
    if not versions:
        return None
    return max(versions)[1]


def score_all(index: HybridAttackMemoryIndex, query: str, category: str) -> dict[str, list[int]]:
    """Return the ranked record indexes for each configuration."""
    query_tokens = tokenize(query)
    if not query_tokens:
        return {}
    query_vector = _hash_embedding(query_tokens, dim=index.vector_dim)
    query_terms = set(query_tokens)
    gate = classify_category(query, category=category)
    patterns = {item.lower() for item in gate.attack_pattern}
    crypto = {item.lower() for item in gate.crypto_type}
    families = _query_attack_families(query, category)

    rows: list[tuple[float, float, float, int]] = []
    for idx, record in enumerate(index.records):
        bm25 = index._bm25_score(query_tokens, idx)
        vector = _cosine_sparse(query_vector, index._vectors[idx])
        boost, _matched = index._rerank_boost(record, query_terms, patterns, crypto, families)
        rows.append((bm25, vector, boost, idx))

    def ranked(key) -> list[int]:
        ordered = sorted(rows, key=lambda row: (-key(row), row[3]))
        return [row[3] for row in ordered]

    return {
        "bm25": ranked(lambda row: row[0]),
        "bm25+vector": ranked(lambda row: row[0] + VECTOR_WEIGHT * row[1]),
        "bm25+rerank": ranked(lambda row: row[0] + row[2]),
        "full": ranked(lambda row: row[0] + VECTOR_WEIGHT * row[1] + row[2]),
    }


def evaluate_config(rankings: dict[str, list[int]], target: int) -> dict[str, float]:
    position = rankings.index(target) if target in rankings else -1
    rank = position + 1
    result = {f"recall@{top_k}": 1.0 if 0 < rank <= top_k else 0.0 for top_k in TOP_KS}
    result["mrr"] = 1.0 / rank if rank > 0 else 0.0
    return result


def sample_records(records, samples: int, cjk_only: bool) -> list[int]:
    picked = [
        idx
        for idx, record in enumerate(records)
        if not cjk_only or CJK_RE.search(record.challenge or "")
    ]
    if samples <= 0 or samples >= len(picked):
        return picked
    stride = max(1, len(picked) // samples)
    return picked[::stride][:samples]


def build_query(record, bucket: str, query_mode: str) -> str:
    """Self-retrieval saturates BM25, so the default probe drops the challenge
    text and keeps only taxonomy signals: the query then has to generalise
    instead of echoing the card back at the index."""
    if bucket == "cjk":
        # Partial phrase: only the first CJK run of the challenge. This is what
        # a Chinese prompt actually looks like.
        match = CJK_RE.search(record.challenge or "")
        literal = (record.challenge or "")[match.start() :] if match else ""
        return literal[: max(6, len(literal) // 2)]
    pattern = " ".join(record.attack_pattern or [])
    if query_mode == "paraphrase":
        parts = [pattern, " ".join(record.crypto_type or []), " ".join((record.tags or [])[:2])]
        return " ".join(part for part in parts if part).strip()
    return f"{record.challenge} {(record.attack_pattern or [''])[0]}".strip()


def run_category(
    memory_root: Path,
    category: str,
    samples: int,
    query_mode: str,
) -> dict[str, dict[str, dict[str, float]]]:
    shard = latest_shard(memory_root, category)
    if shard is None:
        return {}
    index = HybridAttackMemoryIndex.load(shard)
    cjk_only = query_mode == "cjk"
    buckets = {"latin": sample_records(index.records, samples, False), "cjk": sample_records(index.records, samples, True)}
    report: dict[str, dict[str, dict[str, float]]] = {}
    for bucket, indexes in buckets.items():
        if not indexes:
            continue
        totals: dict[str, list[dict[str, float]]] = {}
        for idx in indexes:
            record = index.records[idx]
            query = build_query(record, bucket, query_mode)
            if not query.strip():
                continue
            rankings = score_all(index, query, category)
            if not rankings:
                continue
            for name, order in rankings.items():
                totals.setdefault(name, []).append(evaluate_config(order, idx))
        if not totals:
            continue
        aggregated: dict[str, dict[str, float]] = {}
        for name, rows in totals.items():
            aggregated[name] = {
                metric: round(sum(row[metric] for row in rows) / len(rows), 4) for metric in rows[0]
            }
            aggregated[name]["queries"] = len(rows)
        report[bucket] = aggregated
    report["_meta"] = {  # type: ignore[assignment]
        "shard": shard.name,
        "records": len(index.records),
        "query_mode": query_mode,
    }
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--memory-root", default=str(LEGACY_ROOT / "memory" / "attack_memory"))
    parser.add_argument("--category", choices=[*CATEGORIES, "all"], default="all")
    parser.add_argument("--samples", type=int, default=150)
    parser.add_argument(
        "--query-mode",
        choices=("self", "paraphrase"),
        default="self",
        help="self echoes the card text; paraphrase keeps only taxonomy signals",
    )
    parser.add_argument("--json", action="store_true", help="emit machine-readable output")
    args = parser.parse_args()

    memory_root = Path(args.memory_root)
    categories = CATEGORIES if args.category == "all" else (args.category,)
    results = {}
    for category in categories:
        report = run_category(memory_root, category, args.samples, args.query_mode)
        if report:
            results[category] = report

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return 0

    for category, report in results.items():
        meta = report["_meta"]  # type: ignore[index]
        print(
            f"\n=== {category}  shard={meta['shard']}  records={meta['records']}"
            f"  query_mode={meta['query_mode']} ==="
        )
        for bucket in ("latin", "cjk"):
            block = report.get(bucket)
            if not block:
                continue
            print(f"  [{bucket}] queries={block['full']['queries']}")
            print(f"    {'config':<14}{'R@1':>7}{'R@5':>7}{'R@10':>7}{'MRR':>7}")
            for name in ("bm25", "bm25+vector", "bm25+rerank", "full"):
                row = block[name]
                print(
                    f"    {name:<14}{row['recall@1']:>7.3f}{row['recall@5']:>7.3f}"
                    f"{row['recall@10']:>7.3f}{row['mrr']:>7.3f}"
                )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
