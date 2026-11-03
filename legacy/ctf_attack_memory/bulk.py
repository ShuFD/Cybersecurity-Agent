"""Bulk CTFtime writeup crawler and crypto-only KB builder.

This module treats CTFtime as the index layer.  It first crawls the global
CTFtime writeup table by page, preserving event/task/tag metadata for every row;
then it fetches the CTFtime writeup page and its linked external writeup page;
finally it classifies the task-level content locally and writes only crypto
attack records into the hybrid index.
"""

from __future__ import annotations

import json
import re
import time
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable
from urllib.parse import urljoin, urlparse

import requests

from .clean import normalize_document
from .crawler import (
    DEFAULT_USER_AGENT,
    WriteupCrawler,
    extract_ctftime_links,
    normalize_url,
)
from .filter import classify_crypto
from .index import DEFAULT_INDEX_DIR, build_index
from .schema import AttackMemoryRecord, CTFtimeWriteupEntry, FetchedDocument, stable_id
from .segment import ChallengeSegment, records_from_segments

try:
    from bs4 import BeautifulSoup
except Exception:  # pragma: no cover - fallback parser is tested.
    BeautifulSoup = None


CTFTIME_BASE = "https://ctftime.org"
CRYPTO_TAGS = {"crypto", "cryptography"}
NON_CRYPTO_DIRECTION_TAGS = {
    "web",
    "pwn",
    "reversing",
    "reverse",
    "rev",
    "forensics",
    "forensic",
    "misc",
    "stego",
    "osint",
    "ppc",
    "hardware",
    "blockchain",
}
DIRECTION_TAGS = CRYPTO_TAGS | NON_CRYPTO_DIRECTION_TAGS
BINARY_URL_RE = re.compile(
    r"\.(?:pdf|zip|7z|rar|tar|gz|png|jpe?g|gif|webp|mp4|mov|avi|pcap|pcapng|bin|exe|dll|so|dylib)(?:$|[?#])",
    re.IGNORECASE,
)
DIRECTION_URL_RE = re.compile(
    r"(?:^|[-_/\s])(crypto|cryptography|web|pwn|reversing|reverse|rev|forensics|forensic|misc|stego|osint|ppc|hardware|blockchain)(?:$|[-_/\s])",
    re.IGNORECASE,
)
TASK_DIRECTION_PREFIX_RE = re.compile(
    r"^\s*(crypto|cryptography|web|pwn|reversing|reverse|rev|forensics|forensic|misc|stego|osint|ppc|hardware|blockchain)\b",
    re.IGNORECASE,
)
MIN_VALID_REPORT_CHARS = 120
MIN_VALID_REPORT_WORDS = 12
ERROR_PAGE_RE = re.compile(
    r"\b(?:404|403|not\s+found|page\s+not\s+found|access\s+denied|forbidden|bad\s+gateway|service\s+unavailable|just\s+a\s+moment|enable\s+javascript)\b",
    re.IGNORECASE,
)
REPORT_SIGNAL_RE = re.compile(
    r"\b(?:write[- ]?up|solution|solve|solved|flag|attack|recover|decrypt|encrypt|cipher|key|rsa|aes|ecc|lattice|prng|xor|sage|python|exploit|vulnerab)\b|```",
    re.IGNORECASE,
)
CODE_LIKE_RE = re.compile(
    r"```|(?:^|\n)\s{4,}\S|\b(?:from\s+\w+\s+import|import\s+\w+|def\s+\w+\(|print\(|assert\s+|sage:)\b",
    re.IGNORECASE,
)


@dataclass
class ReportValidity:
    keep: bool
    reason: str = ""
    metrics: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict[str, object]:
        return {
            "keep": self.keep,
            "reason": self.reason,
            "metrics": dict(self.metrics),
        }


@dataclass
class BulkConfig:
    corpus_dir: Path = DEFAULT_INDEX_DIR / "corpus"
    index_dir: Path = DEFAULT_INDEX_DIR
    start_page: int = 1
    max_pages: int = 0  # 0 means until empty/stop condition.
    since_year: int = datetime.now(timezone.utc).year - 10
    stop_after_old_pages: int = 3
    max_entries: int = 0
    max_external_docs: int = 0
    delay_seconds: float = 0.5
    timeout_seconds: float = 20.0
    user_agent: str = DEFAULT_USER_AGENT
    force: bool = False
    build_index: bool = True
    min_gate_score: float = 2.4
    max_chunk_chars: int = 4200
    overlap_chars: int = 500


@dataclass
class BulkReport:
    pages_seen: int = 0
    entries_seen: int = 0
    entries_kept_by_year: int = 0
    entries_skipped_existing: int = 0
    ctftime_pages_fetched: int = 0
    external_docs_fetched: int = 0
    external_docs_failed: int = 0
    crypto_tagged_entries: int = 0
    valid_reports: int = 0
    invalid_reports: int = 0
    crypto_records: int = 0
    rejected_non_crypto: int = 0
    index_dir: str = ""
    corpus_dir: str = ""
    stopped_reason: str = ""
    started_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    finished_at: str = ""

    def to_dict(self) -> dict[str, object]:
        return {
            "pages_seen": self.pages_seen,
            "entries_seen": self.entries_seen,
            "entries_kept_by_year": self.entries_kept_by_year,
            "entries_skipped_existing": self.entries_skipped_existing,
            "ctftime_pages_fetched": self.ctftime_pages_fetched,
            "external_docs_fetched": self.external_docs_fetched,
            "external_docs_failed": self.external_docs_failed,
            "crypto_tagged_entries": self.crypto_tagged_entries,
            "valid_reports": self.valid_reports,
            "invalid_reports": self.invalid_reports,
            "crypto_records": self.crypto_records,
            "rejected_non_crypto": self.rejected_non_crypto,
            "index_dir": self.index_dir,
            "corpus_dir": self.corpus_dir,
            "stopped_reason": self.stopped_reason,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }


class BulkCTFtimeBuilder:
    def __init__(
        self,
        config: BulkConfig | None = None,
        *,
        session: requests.Session | None = None,
    ):
        self.config = config or BulkConfig()
        self.session = session or requests.Session()
        self.session.headers.update({"User-Agent": self.config.user_agent})
        self.crawler = WriteupCrawler(
            cache_dir=self.config.corpus_dir / "fetch_cache",
            delay_seconds=self.config.delay_seconds,
            timeout_seconds=self.config.timeout_seconds,
            user_agent=self.config.user_agent,
            session=self.session,
        )
        self._ensure_dirs()

    def run(self) -> BulkReport:
        report = BulkReport(
            index_dir=str(self.config.index_dir), corpus_dir=str(self.config.corpus_dir)
        )
        seen_document_keys = (
            self._load_seen_document_keys() if not self.config.force else set()
        )
        entries_processed = 0
        old_page_streak = 0
        page = max(1, int(self.config.start_page or 1))

        while True:
            if self.config.max_pages and report.pages_seen >= self.config.max_pages:
                report.stopped_reason = "max_pages"
                break
            page_url = writeups_page_url(page)
            html = self._fetch_ctftime_index_page(page_url, page)
            if not html:
                report.stopped_reason = f"empty_or_failed_page_{page}"
                break
            report.pages_seen += 1
            entries = parse_writeup_index_page(html, page_url)
            if not entries:
                report.stopped_reason = f"no_entries_page_{page}"
                break
            report.entries_seen += len(entries)

            page_kept = 0
            page_old = 0
            for entry in entries:
                if (
                    self.config.max_entries
                    and entries_processed >= self.config.max_entries
                ):
                    report.stopped_reason = "max_entries"
                    break
                entry.event_year = self._event_year(entry)
                if (
                    self.config.since_year
                    and entry.event_year
                    and entry.event_year < self.config.since_year
                ):
                    page_old += 1
                    continue
                page_kept += 1
                report.entries_kept_by_year += 1
                key = entry.writeup_id or stable_id(
                    entry.writeup_url, entry.task, entry.event
                )
                if key in seen_document_keys:
                    report.entries_skipped_existing += 1
                    continue
                try:
                    result = self._process_entry(entry)
                except Exception as exc:
                    result = {"external_failed": True}
                    self._append_jsonl(
                        self.config.corpus_dir / "metadata" / "errors.jsonl",
                        {
                            "writeup_id": entry.writeup_id,
                            "writeup_url": entry.writeup_url,
                            "event": entry.event,
                            "task": entry.task,
                            "error": f"{type(exc).__name__}: {exc}",
                            "traceback": traceback.format_exc()[-4000:],
                            "at": datetime.now(timezone.utc).isoformat(),
                        },
                    )
                if result.get("ctftime_fetched"):
                    report.ctftime_pages_fetched += 1
                if result.get("external_fetched"):
                    report.external_docs_fetched += 1
                if result.get("external_failed"):
                    report.external_docs_failed += 1
                if result.get("crypto_tagged"):
                    report.crypto_tagged_entries += 1
                seen_document_keys.add(key)
                entries_processed += 1
            if report.stopped_reason:
                break
            if page_kept == 0 and page_old == len(entries):
                old_page_streak += 1
            else:
                old_page_streak = 0
            if self.config.since_year and old_page_streak >= max(
                1, self.config.stop_after_old_pages
            ):
                report.stopped_reason = "since_year_cutoff"
                break
            page += 1

        if self.config.build_index:
            records, rejected, valid_reports, invalid_reports = (
                self.build_crypto_index_from_corpus()
            )
            report.crypto_records = len(records)
            report.rejected_non_crypto = rejected
            report.valid_reports = valid_reports
            report.invalid_reports = invalid_reports
        report.finished_at = datetime.now(timezone.utc).isoformat()
        self._write_manifest(report)
        return report

    def build_crypto_index_from_corpus(
        self,
    ) -> tuple[list[AttackMemoryRecord], int, int, int]:
        records: list[AttackMemoryRecord] = []
        rejected = 0
        valid_reports = 0
        invalid_reports = 0
        rejected_path = (
            self.config.corpus_dir / "metadata" / "rejected_non_crypto.jsonl"
        )
        invalid_path = self.config.corpus_dir / "metadata" / "invalid_reports.jsonl"
        rejected_path.write_text("", encoding="utf-8")
        invalid_path.write_text("", encoding="utf-8")
        for item in self._iter_documents():
            entry = CTFtimeWriteupEntry.from_dict(item.get("entry") or {})
            markdown = str(item.get("markdown") or "")
            source_url = effective_source_url(item, entry)
            validity = classify_report_validity(
                item, markdown=markdown, source_url=source_url,
                status_code=int(item.get("external_status") or 0),
            )
            if not validity.keep:
                invalid_reports += 1
                self._append_invalid_report(invalid_path, entry, source_url, validity)
                continue
            valid_reports += 1
            direction = classify_direction(
                entry, source_url=source_url, title=str(item.get("title") or "")
            )
            if BINARY_URL_RE.search(source_url):
                rejected += 1
                self._append_rejection(
                    rejected_path, entry, source_url, "binary_source", None, direction
                )
                continue
            selected = select_task_markdown(markdown, entry.task)
            metadata_text = "\n".join(
                [entry.event, entry.task, " ".join(entry.tags), source_url, selected]
            )
            gate = classify_crypto(metadata_text, min_score=self.config.min_gate_score)
            if direction and direction != "crypto":
                rejected += 1
                self._append_rejection(
                    rejected_path,
                    entry,
                    source_url,
                    "explicit_non_crypto_direction",
                    gate,
                    direction,
                )
                continue
            if direction != "crypto" and not gate.keep:
                rejected += 1
                self._append_rejection(
                    rejected_path,
                    entry,
                    source_url,
                    "crypto_gate_rejected",
                    gate,
                    direction,
                )
                continue
            segment = ChallengeSegment(
                event=entry.event,
                challenge=entry.task or item.get("title", ""),
                title=entry.task or item.get("title", ""),
                markdown=selected,
                source_url=source_url,
                ctftime_url=entry.writeup_url,
                tags=entry.tags,
            )
            recs = records_from_segments(
                [segment],
                max_chars=self.config.max_chunk_chars,
                overlap_chars=self.config.overlap_chars,
                min_gate_score=self.config.min_gate_score,
            )
            # If CTFtime or source URL says crypto but the challenge text is terse,
            # still require a primitive/attack gate at record level to keep v1 low-noise.
            records.extend(recs)
        build_index(records, self.config.index_dir)
        return records, rejected, valid_reports, invalid_reports

    def _process_entry(self, entry: CTFtimeWriteupEntry) -> dict[str, bool]:
        status = {
            "ctftime_fetched": False,
            "external_fetched": False,
            "external_failed": False,
            "crypto_tagged": any(tag.lower() in CRYPTO_TAGS for tag in entry.tags),
        }
        ctftime_doc = self.crawler.fetch(entry.writeup_url)
        status["ctftime_fetched"] = bool(ctftime_doc.text)
        external_links = [
            link
            for link in extract_ctftime_links(
                ctftime_doc.text, base_url=entry.writeup_url
            )
            if link.link_type == "external_writeup"
        ]
        external_url = external_links[0].url if external_links else ""
        external_doc = FetchedDocument(url="")
        markdown = ctftime_doc.text
        if external_url:
            external_doc = self.crawler.fetch(external_url)
            if external_doc.text:
                markdown = external_doc.text
                status["external_fetched"] = True
            else:
                status["external_failed"] = True
        self._write_document(entry, markdown, ctftime_doc, external_doc, external_url)
        return status

    def _write_document(
        self,
        entry: CTFtimeWriteupEntry,
        markdown: str,
        ctftime_doc: FetchedDocument,
        external_doc: FetchedDocument,
        external_url: str,
    ) -> None:
        year = str(entry.event_year or "unknown")
        event_slug = slugify(entry.event or "unknown-event")
        task_slug = slugify(entry.task or entry.writeup_id or "unknown-task")
        writeup_id = entry.writeup_id or stable_id(entry.writeup_url, entry.task)
        rel_dir = Path("by_event") / year / event_slug / task_slug
        out_dir = self.config.corpus_dir / rel_dir
        out_dir.mkdir(parents=True, exist_ok=True)
        markdown_path = out_dir / f"{writeup_id}.md"
        metadata_path = out_dir / f"{writeup_id}.json"
        markdown_path.write_text(markdown, encoding="utf-8", errors="replace")
        payload = {
            "entry": entry.to_dict(),
            "ctftime_url": entry.writeup_url,
            "ctftime_status": ctftime_doc.status_code,
            "external_url": external_url,
            "external_final_url": external_doc.final_url,
            "external_status": external_doc.status_code,
            "title": external_doc.title or ctftime_doc.title,
            "markdown_path": str(markdown_path.relative_to(self.config.corpus_dir)),
            "markdown_chars": len(markdown),
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        }
        metadata_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        self._append_jsonl(
            self.config.corpus_dir / "metadata" / "writeup_entries.jsonl",
            entry.to_dict(),
        )
        self._append_jsonl(
            self.config.corpus_dir / "metadata" / "documents.jsonl",
            {**payload, "markdown": markdown},
        )

    def _append_rejection(
        self,
        path: Path,
        entry: CTFtimeWriteupEntry,
        source_url: str,
        reason: str,
        gate,
        direction: str,
    ) -> None:
        self._append_jsonl(
            path,
            {
                "writeup_id": entry.writeup_id,
                "event": entry.event,
                "task": entry.task,
                "tags": entry.tags,
                "source_url": source_url,
                "reason": reason,
                "direction": direction,
                "gate": gate.to_dict() if gate is not None else {},
            },
        )

    def _append_invalid_report(
        self,
        path: Path,
        entry: CTFtimeWriteupEntry,
        source_url: str,
        validity: ReportValidity,
    ) -> None:
        self._append_jsonl(
            path,
            {
                "writeup_id": entry.writeup_id,
                "event": entry.event,
                "task": entry.task,
                "tags": entry.tags,
                "source_url": source_url,
                "reason": validity.reason,
                "metrics": validity.metrics,
            },
        )

    def _iter_documents(self) -> Iterable[dict[str, object]]:
        path = self.config.corpus_dir / "metadata" / "documents.jsonl"
        if not path.is_file():
            return []
        docs = []
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    docs.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        return docs

    def _load_seen_document_keys(self) -> set[str]:
        seen = set()
        for item in self._iter_documents():
            entry = item.get("entry") or {}
            key = str(entry.get("writeup_id") or "") if isinstance(entry, dict) else ""
            if key:
                seen.add(key)
        return seen

    def _event_year(self, entry: CTFtimeWriteupEntry) -> int:
        if entry.event_year:
            return entry.event_year
        cache_path = self.config.corpus_dir / "metadata" / "event_years.json"
        cache = {}
        if cache_path.is_file():
            try:
                cache = json.loads(cache_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                cache = {}
        key = entry.event_id or entry.event_url
        if key and str(key) in cache:
            return int(cache[str(key)] or 0)
        year = 0
        if entry.event_url:
            html = self._request_text(entry.event_url)
            year = parse_event_year(html)
            self._write_text(
                self.config.corpus_dir
                / "ctftime_events"
                / f"{entry.event_id or stable_id(entry.event_url)}.html",
                html,
            )
        if key:
            cache[str(key)] = year
            cache_path.write_text(
                json.dumps(cache, ensure_ascii=False, indent=2, sort_keys=True),
                encoding="utf-8",
            )
        return year

    def _fetch_ctftime_index_page(self, url: str, page: int) -> str:
        html = self._request_text(url)
        if html:
            self._write_text(
                self.config.corpus_dir
                / "ctftime_index_pages"
                / f"page_{page:05d}.html",
                html,
            )
        return html

    def _request_text(self, url: str) -> str:
        if self.config.delay_seconds:
            time.sleep(self.config.delay_seconds)
        try:
            resp = self.session.get(
                url, timeout=self.config.timeout_seconds, allow_redirects=True
            )
        except requests.RequestException as e:
            return f"[Fetch Error] {type(e).__name__} for {url}"
        if resp.status_code >= 400:
            from http_status_utils import classify_for_agent
            c = classify_for_agent(resp.status_code, url=resp.url or url)
            return (
                f"[HTTP {resp.status_code} — {c['category']}] {c['meaning']}"
            )
        encoding = resp.encoding or "utf-8"
        try:
            return resp.content.decode(encoding, errors="replace")
        except LookupError:
            return resp.content.decode("utf-8", errors="replace")

    def _ensure_dirs(self) -> None:
        for sub in (
            self.config.corpus_dir,
            self.config.corpus_dir / "metadata",
            self.config.corpus_dir / "ctftime_index_pages",
            self.config.corpus_dir / "ctftime_events",
            self.config.corpus_dir / "by_event",
            self.config.index_dir,
        ):
            sub.mkdir(parents=True, exist_ok=True)

    def _write_manifest(self, report: BulkReport) -> None:
        path = self.config.corpus_dir / "manifest.json"
        path.write_text(
            json.dumps(report.to_dict(), ensure_ascii=False, indent=2, sort_keys=True),
            encoding="utf-8",
        )

    def _append_jsonl(self, path: Path, payload: dict[str, object]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")

    def _write_text(self, path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text or "", encoding="utf-8", errors="replace")


def writeups_page_url(page: int) -> str:
    page = max(1, int(page or 1))
    return (
        f"{CTFTIME_BASE}/writeups"
        if page == 1
        else f"{CTFTIME_BASE}/writeups?page={page}"
    )


def parse_writeup_index_page(html: str, source_page: str) -> list[CTFtimeWriteupEntry]:
    if not html:
        return []
    if BeautifulSoup is not None:
        soup = BeautifulSoup(html, "html.parser")
        table = soup.find("table", id="writeups_table") or soup.find("table")
        rows = table.find_all("tr") if table else []
        entries = []
        for row in rows:
            cells = row.find_all("td")
            if len(cells) < 5:
                continue
            event_link = cells[0].find("a")
            task_link = cells[1].find("a")
            writeup_link = cells[4].find("a", href=re.compile(r"/writeup/\d+"))
            if not writeup_link:
                continue
            tags = [
                span.get_text(" ", strip=True)
                for span in cells[2].find_all(class_=re.compile("label"))
            ]
            author = cells[3].get_text(" ", strip=True)
            entries.append(
                _entry_from_parts(
                    event_link, task_link, tags, author, writeup_link, source_page
                )
            )
        return entries
    return _parse_writeup_index_page_fallback(html, source_page)


def parse_event_year(html: str) -> int:
    if not html:
        return 0
    text = re.sub(r"<[^>]+>", " ", html)
    match = re.search(
        r"\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+\d{1,2}\s+\w+\s+(20\d{2})\b", text
    )
    if match:
        return int(match.group(1))
    years = [int(y) for y in re.findall(r"\b(20\d{2})\b", text)]
    return years[0] if years else 0


def effective_source_url(item: dict[str, object], entry: CTFtimeWriteupEntry) -> str:
    """Use external URL only when the external fetch succeeded.

    If an outbound link failed or was a false positive from code/text, the stored
    markdown is the CTFtime page fallback, so records should cite the CTFtime
    writeup URL instead of the failed external URL.
    """

    external_url = str(item.get("external_url") or "")
    try:
        external_status = int(item.get("external_status") or 0)
    except (TypeError, ValueError):
        external_status = 0
    if external_url and 200 <= external_status < 400:
        return external_url
    return str(item.get("ctftime_url") or entry.writeup_url or external_url)


def classify_report_validity(
    item: dict[str, object], *, markdown: str = "", source_url: str = "",
    status_code: int = 0,
) -> ReportValidity:
    """Conservatively filter fetched pages before crypto indexing.

    This keeps the corpus audit-friendly: link-only CTFtime shells, HTTP error
    pages, empty downloads, and very short pages without writeup/code signals are
    excluded before the stronger crypto gate runs.
    """

    text = str(markdown if markdown != "" else item.get("markdown") or "")
    stripped = text.strip()
    source_url = str(
        source_url or item.get("external_url") or item.get("ctftime_url") or ""
    )
    word_count = len(re.findall(r"[A-Za-z0-9_+#.-]{2,}", stripped))
    link_count = len(re.findall(r"https?://|\]\(", stripped))
    code_like = bool(CODE_LIKE_RE.search(stripped))
    metrics = {
        "chars": len(stripped),
        "words": word_count,
        "links": link_count,
        "code_like": int(code_like),
    }
    if not stripped:
        return ReportValidity(False, "empty_markdown", metrics)
    # Reject by HTTP status code first (more reliable than content regex)
    if status_code >= 400:
        from http_status_utils import is_retryable
        tag = "retryable_error" if is_retryable(status_code) else "http_error"
        return ReportValidity(False, tag, metrics)
    if BINARY_URL_RE.search(source_url):
        return ReportValidity(False, "binary_source", metrics)
    if ERROR_PAGE_RE.search(stripped[:4000]):
        return ReportValidity(False, "error_page", metrics)
    if _looks_like_external_fetch_placeholder(item, stripped, metrics):
        return ReportValidity(False, "external_fetch_placeholder", metrics)
    if len(stripped) < MIN_VALID_REPORT_CHARS and word_count < MIN_VALID_REPORT_WORDS:
        return ReportValidity(False, "too_short", metrics)
    if len(stripped) < 600 and not REPORT_SIGNAL_RE.search(stripped):
        return ReportValidity(False, "missing_writeup_signal", metrics)
    return ReportValidity(True, "valid", metrics)


def select_task_markdown(markdown: str, task: str) -> str:
    text = markdown or ""
    task_norm = normalize_title(task)
    if not text.strip() or not task_norm:
        return text
    headings = list(re.finditer(r"^(#{1,4})\s+(.+?)\s*$", text, re.MULTILINE))
    if not headings:
        return text
    best_idx = -1
    best_score = 0.0
    task_tokens = set(task_norm.split())
    for idx, heading in enumerate(headings):
        title_norm = normalize_title(heading.group(2))
        if not title_norm:
            continue
        score = 0.0
        if (
            task_norm == title_norm
            or task_norm in title_norm
            or title_norm in task_norm
        ):
            score = 1.0
        else:
            title_tokens = set(title_norm.split())
            if task_tokens and title_tokens:
                score = len(task_tokens & title_tokens) / max(len(task_tokens), 1)
        if score > best_score:
            best_score = score
            best_idx = idx
    if best_idx < 0 or best_score < 0.45:
        return text
    start = headings[best_idx].start()
    level = len(headings[best_idx].group(1))
    end = len(text)
    for next_heading in headings[best_idx + 1 :]:
        if len(next_heading.group(1)) <= level:
            end = next_heading.start()
            break
    selected = text[start:end].strip()
    return selected or text


def classify_direction(
    entry: CTFtimeWriteupEntry, *, source_url: str = "", title: str = ""
) -> str:
    tags = {tag.lower() for tag in entry.tags}
    if tags & CRYPTO_TAGS:
        return "crypto"
    non_crypto = tags & NON_CRYPTO_DIRECTION_TAGS
    if non_crypto:
        return sorted(non_crypto)[0]
    hay = " ".join(
        [source_url or "", title or "", entry.task or "", entry.event or ""]
    ).lower()
    for value in (entry.task or "", title or ""):
        prefix = TASK_DIRECTION_PREFIX_RE.search(value)
        if prefix:
            label = prefix.group(1).lower()
            return "crypto" if label in CRYPTO_TAGS else label
    hay = " ".join([source_url or "", title or "", entry.event or ""]).lower()
    match = DIRECTION_URL_RE.search(hay)
    if not match:
        return ""
    value = match.group(1).lower()
    if value in CRYPTO_TAGS:
        return "crypto"
    return value


def _looks_like_external_fetch_placeholder(
    item: dict[str, object], text: str, metrics: dict[str, int]
) -> bool:
    external_url = str(item.get("external_url") or "")
    if not external_url:
        return False
    try:
        external_status = int(item.get("external_status") or 0)
    except (TypeError, ValueError):
        external_status = 0
    if 200 <= external_status < 400:
        return False
    lower = text[:2000].lower()
    if "original writeup" in lower or "external writeup" in lower:
        return True
    # CTFtime wrapper pages are often just a title plus one outbound link.  Reject
    # those only when there is no code-like content and very little prose.
    return (
        metrics.get("links", 0) > 0
        and not metrics.get("code_like", 0)
        and metrics.get("chars", 0) < 900
        and metrics.get("words", 0) < 120
    )


def normalize_title(value: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9]+", " ", value or "").lower()
    return re.sub(r"\s+", " ", value).strip()


def slugify(value: str, *, max_len: int = 80) -> str:
    value = re.sub(r"[^a-zA-Z0-9._-]+", "-", value or "").strip("-._").lower()
    value = re.sub(r"-+", "-", value)
    return (value or "item")[:max_len]


def _entry_from_parts(
    event_link, task_link, tags, author, writeup_link, source_page: str
) -> CTFtimeWriteupEntry:
    event = (
        event_link.get_text(" ", strip=True) if hasattr(event_link, "get_text") else ""
    )
    task = task_link.get_text(" ", strip=True) if hasattr(task_link, "get_text") else ""
    event_href = event_link.get("href") if hasattr(event_link, "get") else ""
    task_href = task_link.get("href") if hasattr(task_link, "get") else ""
    writeup_href = writeup_link.get("href") if hasattr(writeup_link, "get") else ""
    event_url = normalize_url(urljoin(CTFTIME_BASE, event_href or ""))
    task_url = normalize_url(urljoin(CTFTIME_BASE, task_href or ""))
    writeup_url = normalize_url(urljoin(CTFTIME_BASE, writeup_href or ""))
    event_id = _id_from_path(event_url, "event")
    task_id = _id_from_path(task_url, "task")
    writeup_id = _id_from_path(writeup_url, "writeup")
    return CTFtimeWriteupEntry(
        writeup_id=writeup_id,
        writeup_url=writeup_url,
        event=event,
        event_url=event_url,
        event_id=event_id,
        task=task,
        task_url=task_url,
        task_id=task_id,
        tags=[str(tag).strip().lower() for tag in tags if str(tag).strip()],
        author_team=author,
        source_page=source_page,
    )


def _parse_writeup_index_page_fallback(
    html: str, source_page: str
) -> list[CTFtimeWriteupEntry]:
    entries = []
    tbody_match = re.search(r"<tbody[^>]*>([\s\S]*?)</tbody>", html, re.IGNORECASE)
    body = tbody_match.group(1) if tbody_match else html
    for row_match in re.finditer(r"<tr[^>]*>([\s\S]*?)</tr>", body, re.IGNORECASE):
        row = row_match.group(1)
        cells = re.findall(r"<td[^>]*>([\s\S]*?)</td>", row, re.IGNORECASE)
        if len(cells) < 5 or "/writeup/" not in cells[4]:
            continue
        event_href, event = _first_anchor(cells[0])
        task_href, task = _first_anchor(cells[1])
        writeup_href, _writeup = _first_anchor(cells[4])
        tags = [
            re.sub(r"<[^>]+>", " ", tag).strip().lower()
            for tag in re.findall(
                r"<span[^>]*class=['\"][^'\"]*label[^'\"]*['\"][^>]*>([\s\S]*?)</span>",
                cells[2],
                re.IGNORECASE,
            )
        ]
        author = re.sub(r"<[^>]+>", " ", cells[3])
        author = re.sub(r"\s+", " ", author).strip()
        entries.append(
            CTFtimeWriteupEntry(
                writeup_id=_id_from_path(writeup_href, "writeup"),
                writeup_url=normalize_url(urljoin(CTFTIME_BASE, writeup_href)),
                event=event,
                event_url=normalize_url(urljoin(CTFTIME_BASE, event_href)),
                event_id=_id_from_path(event_href, "event"),
                task=task,
                task_url=normalize_url(urljoin(CTFTIME_BASE, task_href)),
                task_id=_id_from_path(task_href, "task"),
                tags=[tag for tag in tags if tag],
                author_team=author,
                source_page=source_page,
            )
        )
    return entries


def _first_anchor(html: str) -> tuple[str, str]:
    match = re.search(
        r"<a\b[^>]*\bhref\s*=\s*(['\"])(.*?)\1[^>]*>([\s\S]*?)</a>",
        html or "",
        re.IGNORECASE,
    )
    if not match:
        return "", re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html or "")).strip()
    href = match.group(2)
    text = re.sub(r"<[^>]+>", " ", match.group(3))
    text = re.sub(r"\s+", " ", text).strip()
    return href, text


def _id_from_path(url_or_path: str, kind: str) -> str:
    path = (
        urlparse(url_or_path or "").path
        if re.match(r"^https?://", url_or_path or "")
        else (url_or_path or "")
    )
    return href, text


def _id_from_path(url_or_path: str, kind: str) -> str:
    path = (
        urlparse(url_or_path or "").path
        if re.match(r"^https?://", url_or_path or "")
        else (url_or_path or "")
    )
    match = re.search(rf"/{re.escape(kind)}/(\d+)", path)
    return match.group(1) if match else ""
