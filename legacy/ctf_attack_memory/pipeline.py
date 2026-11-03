"""Offline pipeline: CTFtime index -> writeups -> attack-pattern chunks -> local hybrid index."""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from .clean import normalize_document
from .crawler import WriteupCrawler
from .filter import classify_category
from .index import DEFAULT_INDEX_DIR, HybridAttackMemoryIndex, build_index
from .schema import AttackMemoryRecord, CTFtimeLink, FetchedDocument
from .segment import records_from_segments, segment_challenges


@dataclass
class PipelineConfig:
    category: str = "crypto"
    index_dir: Path = DEFAULT_INDEX_DIR
    cache_dir: Path | None = None
    max_ctftime_pages: int = 100
    max_links: int = 1000
    max_documents: int = 500
    max_chunk_chars: int = 4200
    overlap_chars: int = 500
    min_gate_score: float = 2.4
    delay_seconds: float = 0.5
    llm_classifier_command: list[str] = field(default_factory=list)
    llm_disagreement_mode: str = "drop"  # drop | keep-rule


@dataclass
class PipelineReport:
    discovered_links: int = 0
    fetched_documents: int = 0
    segments: int = 0
    kept_records: int = 0
    dropped_by_llm: int = 0
    index_dir: str = ""
    crawler_stats: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict[str, object]:
        return {
            "discovered_links": self.discovered_links,
            "fetched_documents": self.fetched_documents,
            "segments": self.segments,
            "kept_records": self.kept_records,
            "dropped_by_llm": self.dropped_by_llm,
            "index_dir": self.index_dir,
            "crawler_stats": self.crawler_stats,
        }


class OptionalLLMClassifier:
    """Thin adapter for a local/small classifier command.

    The command receives one JSON object on stdin:
    `{text, crypto_type, attack_pattern, source_url}` and should return JSON with
    `{"keep": true/false}` plus optional `crypto_type`/`attack_pattern` lists.
    This keeps v1 offline by default while leaving a clean hook for a small local
    model or private classifier service wrapper.
    """

    def __init__(
        self, command: Iterable[str] | None = None, *, timeout_seconds: float = 30.0
    ):
        self.command = [str(part) for part in (command or []) if str(part)]
        self.timeout_seconds = timeout_seconds

    @property
    def enabled(self) -> bool:
        return bool(self.command)

    def classify(self, record: AttackMemoryRecord) -> dict[str, object]:
        if not self.enabled:
            return {"keep": True}
        payload = {
            "text": record.text_chunk[:8000],
            "crypto_type": record.crypto_type,
            "attack_pattern": record.attack_pattern,
            "source_url": record.source_url,
            "event": record.event,
            "challenge": record.challenge,
        }
        try:
            proc = subprocess.run(
                self.command,
                input=json.dumps(payload, ensure_ascii=False),
                text=True,
                capture_output=True,
                timeout=self.timeout_seconds,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return {"keep": True, "error": "classifier_failed"}
        if proc.returncode != 0:
            return {
                "keep": True,
                "error": "classifier_nonzero",
                "stderr": proc.stderr[-1000:],
            }
        try:
            parsed = json.loads(proc.stdout.strip() or "{}")
        except json.JSONDecodeError:
            return {
                "keep": True,
                "error": "classifier_bad_json",
                "stdout": proc.stdout[-1000:],
            }
        return parsed if isinstance(parsed, dict) else {"keep": True}


class AttackMemoryPipeline:
    def __init__(self, config: PipelineConfig | None = None):
        self.config = config or PipelineConfig()
        if self.config.cache_dir is None:
            self.config.cache_dir = self.config.index_dir / "fetch_cache"
        self.llm_classifier = OptionalLLMClassifier(self.config.llm_classifier_command)

    def run_from_ctftime_urls(
        self, seeds: Iterable[str]
    ) -> tuple[HybridAttackMemoryIndex, PipelineReport]:
        crawler = WriteupCrawler(
            cache_dir=self.config.cache_dir, delay_seconds=self.config.delay_seconds
        )
        links = crawler.discover_from_ctftime(
            seeds,
            max_pages=self.config.max_ctftime_pages,
            max_links=self.config.max_links,
        )
        docs = crawler.fetch_documents(links, max_documents=self.config.max_documents)
        index, report = self.run_from_documents(docs, links=links)
        report.crawler_stats = crawler.stats.to_dict()
        return index, report

    def run_from_documents(
        self,
        documents: Iterable[FetchedDocument | str | Path],
        *,
        links: Iterable[CTFtimeLink] | None = None,
    ) -> tuple[HybridAttackMemoryIndex, PipelineReport]:
        link_by_url = {link.url: link for link in (links or [])}
        report = PipelineReport(discovered_links=len(link_by_url))
        records: list[AttackMemoryRecord] = []
        for item in documents:
            doc = _coerce_document(item)
            if not doc.text:
                continue
            report.fetched_documents += 1
            link = link_by_url.get(doc.url) or link_by_url.get(doc.final_url)
            ctftime_url = link.source_url if link else ""
            event = _event_from_link(link) if link else ""
            segments = segment_challenges(
                doc.text,
                source_url=doc.final_url or doc.url,
                event=event,
                ctftime_url=ctftime_url,
            )
            report.segments += len(segments)
            doc_records = records_from_segments(
                segments,
                max_chars=self.config.max_chunk_chars,
                overlap_chars=self.config.overlap_chars,
                min_gate_score=self.config.min_gate_score,
                category=self.config.category,
            )
            for record in doc_records:
                final_record = self._apply_optional_classifier(record)
                if final_record is None:
                    report.dropped_by_llm += 1
                    continue
                records.append(final_record)
        index = build_index(records, self.config.index_dir)
        report.kept_records = len(records)
        report.index_dir = str(self.config.index_dir)
        return index, report

    def run_from_raw_markdown(
        self,
        markdown: str,
        *,
        source_url: str = "memory://inline",
        event: str = "",
    ) -> tuple[list[AttackMemoryRecord], PipelineReport]:
        doc = FetchedDocument(
            url=source_url,
            final_url=source_url,
            text=normalize_document(markdown, source_url=source_url),
        )
        segments = segment_challenges(doc.text, source_url=source_url, event=event)
        records = records_from_segments(
            segments,
            max_chars=self.config.max_chunk_chars,
            overlap_chars=self.config.overlap_chars,
            min_gate_score=self.config.min_gate_score,
            category=self.config.category,
        )
        kept: list[AttackMemoryRecord] = []
        report = PipelineReport(fetched_documents=1, segments=len(segments))
        for record in records:
            final_record = self._apply_optional_classifier(record)
            if final_record is None:
                report.dropped_by_llm += 1
                continue
            kept.append(final_record)
        report.kept_records = len(kept)
        return kept, report

    def _apply_optional_classifier(
        self, record: AttackMemoryRecord
    ) -> AttackMemoryRecord | None:
        if not self.llm_classifier.enabled:
            return record
        decision = self.llm_classifier.classify(record)
        if (
            decision.get("keep") is False
            and self.config.llm_disagreement_mode != "keep-rule"
        ):
            return None
        crypto_type = decision.get("crypto_type")
        attack_pattern = decision.get("attack_pattern")
        if isinstance(crypto_type, list) and crypto_type:
            record.crypto_type = [str(item) for item in crypto_type]
        if isinstance(attack_pattern, list) and attack_pattern:
            record.attack_pattern = [str(item) for item in attack_pattern]
        # Re-check the final text with the category rule gate so an overly
        # permissive LLM command cannot inject unrelated chunks into the index.
        if not classify_category(
            record.text_chunk,
            category=self.config.category,
            min_score=self.config.min_gate_score,
        ).keep:
            return None
        return record


def _coerce_document(item: FetchedDocument | str | Path) -> FetchedDocument:
    if isinstance(item, FetchedDocument):
        return item
    path = Path(item)
    if path.is_file():
        text = path.read_text(encoding="utf-8", errors="replace")
        normalized = normalize_document(text, source_url=str(path))
        return FetchedDocument(
            url=str(path),
            final_url=str(path),
            title=path.stem,
            text=normalized,
            content_type="text/markdown",
        )
    text = str(item or "")
    normalized = normalize_document(text, source_url="memory://inline")
    return FetchedDocument(
        url="memory://inline",
        final_url="memory://inline",
        text=normalized,
        content_type="text/markdown",
    )


def _event_from_link(link: CTFtimeLink | None) -> str:
    if not link:
        return ""
    title = link.title or ""
    # CTFtime anchor titles often include challenge names.  Keep only strong event
    # hints here; challenge segmentation can still infer the rest from headings.
    if "CTF" in title.upper() or "Qual" in title or "Final" in title:
        return title[:120]
    return ""
