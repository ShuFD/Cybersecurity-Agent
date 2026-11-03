"""Build a direct pwn technique index from Roderick's House-of-glibc article.

This importer intentionally follows the source article's own ``2.x House of``
classification.  It does not apply the general-purpose clean/distill pipeline:
each source section is stored as one local retrieval record.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from .schema import AttackMemoryRecord, stable_id

SOURCE_URL = "https://www.roderickchan.cn/zh-cn/2023-02-27-house-of-all-about-glibc-heap-exploitation/"
_SECTION_RE = re.compile(
    r"^##\s+2\.(?P<number>\d+)\s*[-.：:]?\s*(?P<title>House\s+of\s+.+?)\s*$",
    re.IGNORECASE | re.MULTILINE,
)
_ARTICLE_END_RE = re.compile(r"^##\s+3\s*[-.：:]?\s*总结\s*$", re.MULTILINE)
_GLIBC_RANGE_RE = re.compile(
    r"(?:glibc\s*[- ]?)?(2\.\d{1,2})\s*(?:-{1,2}|[–—]|——|至|to|~)\s*(?:(2\.\d{1,2})|(?:今|current))",
    re.IGNORECASE,
)


def records_from_article(markdown: str, *, source_url: str = SOURCE_URL) -> list[AttackMemoryRecord]:
    """Split the article into its source-defined House-of technique sections."""
    article = markdown or ""
    end_marker = _ARTICLE_END_RE.search(article)
    if end_marker:
        article = article[: end_marker.start()]
    matches = list(_SECTION_RE.finditer(article))
    records: list[AttackMemoryRecord] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(article)
        body = article[match.end() : end].strip()
        title = re.sub(r"\s+", " ", match.group("title")).strip()
        if not body:
            continue
        records.append(
            AttackMemoryRecord(
                id=stable_id("roderick-house", match.group("number"), title, source_url),
                event="Roderick glibc heap technique reference",
                challenge=title,
                source_title=title,
                category="pwn",
                crypto_type=["glibc heap"],
                attack_pattern=[title.lower()],
                text_chunk=body,
                code_snippet="",
                source_url=source_url,
                tags=["glibc", "heap exploitation", "house of"],
                libc_versions=_extract_glibc_versions(body),
                gate_score=1.0,
            )
        )
    return records


def _extract_glibc_versions(text: str) -> list[str]:
    versions = []
    for match in _GLIBC_RANGE_RE.finditer(text):
        start, end = match.groups()
        value = f"glibc {start}" + (f"-{end}" if end else "+")
        if value not in versions:
            versions.append(value)
    return versions


def records_from_cached_document(cache_path: str | Path) -> list[AttackMemoryRecord]:
    payload = json.loads(Path(cache_path).read_text(encoding="utf-8"))
    text = str(payload.get("text", ""))
    source_url = str(payload.get("final_url") or payload.get("url") or SOURCE_URL)
    return records_from_article(text, source_url=source_url)
