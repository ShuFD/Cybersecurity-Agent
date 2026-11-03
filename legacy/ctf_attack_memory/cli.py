"""Command line interface for the CTF attack-memory pipeline."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .index import (
    DEFAULT_INDEX_DIR,
    HybridAttackMemoryIndex,
    build_index,
    search_attack_memory,
    search_knowledge_cards,
)
from .knowledge import save_cards


def _require_local_builder(module: str, names: tuple[str, ...]):
    """Load optional corpus-build tooling without breaking runtime retrieval."""

    try:
        imported = __import__(module, fromlist=list(names))
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "This command requires local knowledge-base build tooling, which is "
            "intentionally not included in the published runtime checkout."
        ) from exc
    return tuple(getattr(imported, name) for name in names)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ctf-attack-memory",
        description="Build/search a local crypto CTF attack-pattern memory bank.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    build = sub.add_parser(
        "build", help="Crawl CTFtime seed pages and build the crypto v1 index."
    )
    build.add_argument("seed", nargs="+", help="CTFtime crypto/event/writeup page URL.")
    _add_common_build_args(build)
    build.add_argument("--max-ctftime-pages", type=int, default=100)
    build.add_argument("--max-links", type=int, default=1000)
    build.add_argument("--max-documents", type=int, default=500)
    build.add_argument(
        "--delay",
        type=float,
        default=0.5,
        help="Delay between HTTP requests in seconds.",
    )

    local = sub.add_parser(
        "build-local", help="Build the index from local markdown/HTML/text files."
    )
    local.add_argument("path", nargs="+", help="Local writeup files to ingest.")
    _add_common_build_args(local)

    url = sub.add_parser(
        "build-url", help="Fetch one writeup/blog URL and build a category-specific index."
    )
    url.add_argument("url", help="HTTP(S) writeup or blog URL to fetch.")
    _add_common_build_args(url)
    url.add_argument("--delay", type=float, default=0.5)
    url.add_argument("--timeout", type=float, default=20.0)
    url.add_argument(
        "--insecure",
        action="store_true",
        help="Disable TLS certificate verification for this URL only (use only for a trusted source with a broken certificate).",
    )



    bulk = sub.add_parser(
        "bulk-build-ctftime",
        help="Crawl CTFtime global writeup pages, store a local corpus, and build the crypto-only KB.",
    )
    bulk.add_argument(
        "--index-dir",
        default=str(DEFAULT_INDEX_DIR),
        help="Output hybrid index directory.",
    )
    bulk.add_argument(
        "--corpus-dir",
        default="",
        help="Corpus directory. Defaults to <index-dir>/corpus.",
    )
    bulk.add_argument("--start-page", type=int, default=1)
    bulk.add_argument(
        "--max-pages", type=int, default=0, help="0 means crawl until empty/cutoff."
    )
    bulk.add_argument(
        "--since-year",
        type=int,
        default=0,
        help="Keep events from this year onward. Default: current year - 10.",
    )
    bulk.add_argument("--stop-after-old-pages", type=int, default=3)
    bulk.add_argument(
        "--max-entries", type=int, default=0, help="0 means no explicit entry cap."
    )
    bulk.add_argument("--delay", type=float, default=0.5)
    bulk.add_argument("--timeout", type=float, default=20.0)
    bulk.add_argument(
        "--force",
        action="store_true",
        help="Refetch entries already present in documents.jsonl.",
    )
    bulk.add_argument(
        "--no-index",
        action="store_true",
        help="Only crawl/store corpus; do not rebuild records.jsonl.",
    )
    bulk.add_argument("--min-gate-score", type=float, default=2.4)
    bulk.add_argument("--max-chunk-chars", type=int, default=4200)
    bulk.add_argument("--overlap-chars", type=int, default=500)

    search = sub.add_parser(
        "search", help="Search the local crypto attack-memory index."
    )
    search.add_argument(
        "query", help="Attack-centric query, e.g. 'RSA e=3 broadcast coppersmith'."
    )
    search.add_argument("--index-dir", default=str(DEFAULT_INDEX_DIR))
    search.add_argument("--top-k", type=int, default=5)
    search.add_argument(
        "--json", action="store_true", help="Emit JSON instead of text."
    )

    distill = sub.add_parser(
        "distill-cards",
        help="Create provenance-first, unverified crypto technique-card drafts from an existing index.",
    )
    distill.add_argument("--index-dir", default=str(DEFAULT_INDEX_DIR))
    distill.add_argument(
        "--output",
        default="",
        help="Output cards.jsonl path. Defaults to <index-dir>/knowledge/cards.jsonl.",
    )
    distill.add_argument(
        "--report",
        default="",
        help="Optional output JSON validation report. Defaults to <index-dir>/knowledge/review_report.json.",
    )

    crypto_kb = sub.add_parser(
        "distill-crypto-kb",
        help="Reclassify raw crypto records into sanitized, knowledge-point cards with audit artifacts.",
    )
    crypto_kb.add_argument("--index-dir", default=str(DEFAULT_INDEX_DIR))
    crypto_kb.add_argument("--min-score", type=int, default=70)
    crypto_kb.add_argument("--max-evidence-per-variant", type=int, default=3)

    clean = sub.add_parser(
        "clean", help="Stage locally cleaned candidates and remove unreviewed artifacts from runtime retrieval."
    )
    clean.add_argument("--category", choices=("pwn", "crypto"), required=True)
    clean.add_argument("--index-dir", required=True, help="Category index directory to clean.")

    pwn_cards = sub.add_parser(
        "distill-pwn-candidates",
        help="Create challenge-bound pwn candidate cards from independently gated records.",
    )
    pwn_cards.add_argument("--index-dir", required=True)
    pwn_cards.add_argument(
        "--output-dir", default="", help="Defaults to <index-dir>/knowledge/candidates."
    )

    pwn_seeds = sub.add_parser(
        "seed-pwn-candidates",
        help="Write challenge-bound pwn candidate seeds from project-local CTF references.",
    )
    pwn_seeds.add_argument("--index-dir", required=True)

    roderick = sub.add_parser(
        "build-roderick-pwn",
        help="Build a direct pwn index from the cached Roderick House-of-glibc article, preserving its source sections.",
    )
    roderick.add_argument("--index-dir", required=True)
    roderick.add_argument(
        "--cache-path",
        default="",
        help="Cached crawler JSON. Defaults to <index-dir>/fetch_cache/042de637053c2c9821bb1bc3.json.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.cmd == "build":
        AttackMemoryPipeline, = _require_local_builder(
            "ctf_attack_memory.pipeline", ("AttackMemoryPipeline",)
        )
        config = _config_from_args(args)
        config.max_ctftime_pages = args.max_ctftime_pages
        config.max_links = args.max_links
        config.max_documents = args.max_documents
        config.delay_seconds = args.delay
        _ensure_parent(config.index_dir)
        _ensure_parent(config.cache_dir)
        _index, report = AttackMemoryPipeline(config).run_from_ctftime_urls(args.seed)
        print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "build-local":
        AttackMemoryPipeline, = _require_local_builder(
            "ctf_attack_memory.pipeline", ("AttackMemoryPipeline",)
        )
        config = _config_from_args(args)
        _ensure_parent(config.index_dir)
        _index, report = AttackMemoryPipeline(config).run_from_documents(
            [Path(path) for path in args.path]
        )
        print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "build-url":
        WriteupCrawler, = _require_local_builder(
            "ctf_attack_memory.crawler", ("WriteupCrawler",)
        )
        AttackMemoryPipeline, = _require_local_builder(
            "ctf_attack_memory.pipeline", ("AttackMemoryPipeline",)
        )
        config = _config_from_args(args)
        config.delay_seconds = args.delay
        _ensure_parent(config.index_dir)
        _ensure_parent(config.cache_dir)
        crawler = WriteupCrawler(
            cache_dir=config.cache_dir,
            delay_seconds=config.delay_seconds,
            timeout_seconds=args.timeout,
            verify_tls=not args.insecure,
        )
        document = crawler.fetch(args.url)
        _index, report = AttackMemoryPipeline(config).run_from_documents([document])
        report.crawler_stats = crawler.stats.to_dict()
        print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "bulk-build-ctftime":
        BulkConfig, BulkCTFtimeBuilder = _require_local_builder(
            "ctf_attack_memory.bulk", ("BulkConfig", "BulkCTFtimeBuilder")
        )
        index_dir = Path(args.index_dir)
        corpus_dir = Path(args.corpus_dir) if args.corpus_dir else index_dir / "corpus"
        config = BulkConfig(
            index_dir=index_dir,
            corpus_dir=corpus_dir,
            start_page=args.start_page,
            max_pages=args.max_pages,
            since_year=args.since_year or BulkConfig().since_year,
            stop_after_old_pages=args.stop_after_old_pages,
            max_entries=args.max_entries,
            delay_seconds=args.delay,
            timeout_seconds=args.timeout,
            force=args.force,
            build_index=not args.no_index,
            min_gate_score=args.min_gate_score,
            max_chunk_chars=args.max_chunk_chars,
            overlap_chars=args.overlap_chars,
        )
        report = BulkCTFtimeBuilder(config).run()
        print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "build-roderick-pwn":
        records_from_cached_document, = _require_local_builder(
            "ctf_attack_memory.roderick_pwn", ("records_from_cached_document",)
        )
        index_dir = Path(args.index_dir)
        cache_path = Path(args.cache_path) if args.cache_path else index_dir / "fetch_cache" / "042de637053c2c9821bb1bc3.json"
        records = records_from_cached_document(cache_path)
        build_index(records, index_dir)
        print(json.dumps({"index_dir": str(index_dir), "cache_path": str(cache_path), "records": len(records), "mode": "direct_source_sections"}, ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "seed-pwn-candidates":
        local_pwn_seed_candidates, = _require_local_builder(
            "ctf_attack_memory.pwn_seed", ("local_pwn_seed_candidates",)
        )
        write_pwn_candidates, = _require_local_builder(
            "ctf_attack_memory.pwn_cards", ("write_pwn_candidates",)
        )
        output_dir = Path(args.index_dir) / "knowledge" / "candidates"
        cards = local_pwn_seed_candidates()
        write_pwn_candidates(cards, [], output_dir)
        print(json.dumps({"output_dir": str(output_dir), "candidates": len(cards), "status": "candidate_only"}, ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "distill-pwn-candidates":
        extract_pwn_candidates, write_pwn_candidates = _require_local_builder(
            "ctf_attack_memory.pwn_cards", ("extract_pwn_candidates", "write_pwn_candidates")
        )
        index_dir = Path(args.index_dir)
        cards, rejected = extract_pwn_candidates(HybridAttackMemoryIndex.load(index_dir).records)
        output_dir = Path(args.output_dir) if args.output_dir else index_dir / "knowledge" / "candidates"
        write_pwn_candidates(cards, rejected, output_dir)
        print(json.dumps({"output_dir": str(output_dir), "candidates": len(cards), "rejected": len(rejected)}, ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "distill-crypto-kb":
        write_crypto_kb_artifacts, = _require_local_builder(
            "ctf_attack_memory.crypto_kb", ("write_crypto_kb_artifacts",)
        )
        report, report_path = write_crypto_kb_artifacts(
            Path(args.index_dir),
            min_score=args.min_score,
            max_evidence_per_variant=args.max_evidence_per_variant,
        )
        print(json.dumps({"report_path": str(report_path), **report.to_dict()}, ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "clean":
        clean_index_directory, = _require_local_builder(
            "ctf_attack_memory.quality", ("clean_index_directory",)
        )
        report, report_path = clean_index_directory(args.index_dir, category=args.category)
        print(json.dumps({"report_path": str(report_path), **report.to_dict()}, ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "distill-cards":
        distill_crypto_records, = _require_local_builder(
            "ctf_attack_memory.distill", ("distill_crypto_records",)
        )
        validate_cards, = _require_local_builder(
            "ctf_attack_memory.validate", ("validate_cards",)
        )
        filter_publishable_cards, = _require_local_builder(
            "ctf_attack_memory.knowledge", ("filter_publishable_cards",)
        )
        index_dir = Path(args.index_dir)
        cards, report = distill_crypto_records(HybridAttackMemoryIndex.load(index_dir).records)
        cards, publication = filter_publishable_cards(cards)
        output_path = Path(args.output) if args.output else index_dir / "knowledge" / "cards.jsonl"
        report_path = Path(args.report) if args.report else index_dir / "knowledge" / "review_report.json"
        # Published cards retain hashes and source URLs, never untrusted writeup bodies.
        save_cards(cards, output_path, include_evidence_text=False)
        validations = [item.to_dict() for item in validate_cards(cards)]
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(
            json.dumps(
                {
                    "distillation": report.to_dict(),
                    "publication": {
                        "input_cards": publication.input_cards,
                        "published_cards": publication.published_cards,
                        "rejected_cards": publication.rejected_cards,
                        "merged_cards": publication.merged_cards,
                        "rejection_reasons": publication.rejection_reasons,
                    },
                    "validations": validations,
                },
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            ),
            encoding="utf-8",
        )
        print(
            json.dumps(
                {
                    "cards_path": str(output_path),
                    "report_path": str(report_path),
                    **report.to_dict(),
                    "published_cards": publication.published_cards,
                    "publication_rejections": publication.rejected_cards,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    if args.cmd == "search":
        index_dir = Path(args.index_dir)
        card_hits = search_knowledge_cards(
            args.query,
            cards_path=index_dir / "knowledge" / "cards.jsonl",
            top_k=args.top_k,
        )
        if card_hits:
            results = [
                {
                    "id": card.id,
                    "title": card.title,
                    "attack_family": card.attack_family,
                    "primitive": card.primitive,
                    "preconditions": card.preconditions,
                    "steps": card.steps,
                    "failure_modes": card.failure_modes,
                    "tools": card.tools,
                    "topic": card.topic,
                    "verification_status": card.verification_status,
                    "review_status": card.review_status,
                    "score": score,
                    "matched_terms": matched_terms,
                    "source_urls": list(
                        dict.fromkeys(
                            evidence.source_url
                            for evidence in card.evidence
                            if evidence.source_url
                        )
                    )[:5],
                }
                for card, score, matched_terms in card_hits
            ]
            if args.json:
                print(json.dumps(results, ensure_ascii=False, indent=2))
            else:
                for rank, result in enumerate(results, 1):
                    print(
                        f"{rank}. {result['title']} [{', '.join(result['primitive'])}] "
                        f"score={result['score']:.3f}"
                    )
                    print(f"   attack_pattern: {result['attack_family']}")
                    print(f"   preconditions: {'; '.join(result['preconditions'][:2])}")
            return 0

        hits = search_attack_memory(args.query, index_dir=index_dir, top_k=args.top_k)
        if args.json:
            print(json.dumps([hit.to_dict() for hit in hits], ensure_ascii=False, indent=2))
        else:
            for rank, hit in enumerate(hits, 1):
                rec = hit.record
                patterns = ", ".join(rec.attack_pattern) or "unknown pattern"
                crypto_type = ", ".join(rec.crypto_type) or "crypto"
                print(f"{rank}. {rec.event} / {rec.challenge} [{crypto_type}] score={hit.score:.3f}")
                print(f"   attack_pattern: {patterns}")
                print(f"   source: {rec.source_url}")
                if hit.snippet:
                    print(f"   snippet: {hit.snippet}")
        return 0
    parser.error(f"unknown command: {args.cmd}")
    return 2


def _add_common_build_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--index-dir", default=str(DEFAULT_INDEX_DIR), help="Output index directory."
    )
    parser.add_argument(
        "--category", choices=["crypto", "pwn"], default="crypto", help="Knowledge-base category and strong gate."
    )
    parser.add_argument(
        "--cache-dir",
        default="",
        help="HTTP fetch cache directory. Defaults to <index-dir>/fetch_cache.",
    )
    parser.add_argument("--max-chunk-chars", type=int, default=4200)
    parser.add_argument("--overlap-chars", type=int, default=500)
    parser.add_argument("--min-gate-score", type=float, default=2.4)
    parser.add_argument(
        "--llm-classifier-command",
        nargs="+",
        default=[],
        help="Optional local classifier command. Reads JSON on stdin and returns {'keep': bool, ...} JSON.",
    )
    parser.add_argument(
        "--llm-disagreement-mode", choices=["drop", "keep-rule"], default="drop"
    )


def _config_from_args(args: argparse.Namespace):
    PipelineConfig, = _require_local_builder(
        "ctf_attack_memory.pipeline", ("PipelineConfig",)
    )
    index_dir = Path(args.index_dir)
    cache_dir = (
        Path(args.cache_dir)
        if getattr(args, "cache_dir", "")
        else index_dir / "fetch_cache"
    )
    return PipelineConfig(
        category=args.category,
        index_dir=index_dir,
        cache_dir=cache_dir,
        max_chunk_chars=args.max_chunk_chars,
        overlap_chars=args.overlap_chars,
        min_gate_score=args.min_gate_score,
        llm_classifier_command=args.llm_classifier_command or [],
        llm_disagreement_mode=args.llm_disagreement_mode,
    )


def _ensure_parent(path: Path | None) -> None:
    if path is None:
        return
    path.mkdir(parents=True, exist_ok=True)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main(sys.argv[1:]))
