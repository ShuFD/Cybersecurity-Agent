"""Challenge-level segmentation and record chunking."""

from __future__ import annotations

import re
from typing import Iterable

from .filter import classify_category
from .schema import AttackMemoryRecord, ChallengeSegment, GateResult, stable_id


HEADING_RE = re.compile(r"^(#{1,4})\s+(.+?)\s*$", re.MULTILINE)
CODE_FENCE_RE = re.compile(r"```[\w+-]*\n([\s\S]*?)\n```", re.MULTILINE)
CATEGORY_TAG_RE = re.compile(
    r"\b(?:crypto|cryptography|rsa|ecc|lattice|prng|misc|web|pwn|rev|forensics)\b",
    re.IGNORECASE,
)
EVENT_HINT_RE = re.compile(
    r"\b(?:CTF|Capture\s+the\s+Flag|Quals?|Finals?)\b", re.IGNORECASE
)


def segment_challenges(
    markdown: str, *, source_url: str = "", event: str = "", ctftime_url: str = ""
) -> list[ChallengeSegment]:
    """Split a weakly structured writeup into likely challenge sections."""

    text = markdown or ""
    headings = list(HEADING_RE.finditer(text))
    if not headings:
        title = _first_nonempty_line(text) or _challenge_from_url(source_url)
        return (
            [
                ChallengeSegment(
                    event=event,
                    challenge=title,
                    title=title,
                    markdown=text.strip(),
                    source_url=source_url,
                    ctftime_url=ctftime_url,
                )
            ]
            if text.strip()
            else []
        )

    # Treat every h1-h3 section as a candidate challenge.  h4 sections usually
    # describe substeps and stay inside their parent section.
    selected = [m for m in headings if len(m.group(1)) <= 3]
    if not selected:
        selected = headings

    segments: list[ChallengeSegment] = []
    doc_title = (
        _clean_heading(selected[0].group(2))
        if selected
        else _challenge_from_url(source_url)
    )
    inferred_event = event or _infer_event_from_title(doc_title)

    for idx, match in enumerate(selected):
        start = match.start()
        end = selected[idx + 1].start() if idx + 1 < len(selected) else len(text)
        section = text[start:end].strip()
        title = _clean_heading(match.group(2))
        if not section:
            continue
        # If the first heading looks like the event/blog title and the next
        # sections contain challenge-like headings, keep it as event metadata but
        # do not discard it: the gate will decide.
        challenge = title
        section_event = inferred_event
        if idx == 0 and len(selected) > 1 and _looks_like_event_title(title):
            section_event = title
        segments.append(
            ChallengeSegment(
                event=section_event,
                challenge=challenge,
                title=title,
                markdown=section,
                source_url=source_url,
                ctftime_url=ctftime_url,
                tags=_extract_tags(section[:1200] + "\n" + title),
            )
        )

    if not segments and text.strip():
        title = doc_title or _challenge_from_url(source_url)
        segments.append(
            ChallengeSegment(
                event=inferred_event,
                challenge=title,
                title=title,
                markdown=text.strip(),
                source_url=source_url,
                ctftime_url=ctftime_url,
            )
        )
    return segments


def records_from_segments(
    segments: Iterable[ChallengeSegment],
    *,
    max_chars: int = 4200,
    overlap_chars: int = 500,
    min_gate_score: float = 2.4,
    category: str = "crypto",
) -> list[AttackMemoryRecord]:
    """Apply a category strong gate and chunk kept challenge segments into records."""

    records: list[AttackMemoryRecord] = []
    for segment in segments:
        gate = classify_category(segment.markdown, category=category, min_score=min_gate_score)
        if not gate.keep:
            continue
        chunks = chunk_markdown(
            segment.markdown, max_chars=max_chars, overlap_chars=overlap_chars
        )
        for idx, chunk in enumerate(chunks):
            chunk_gate = classify_category(chunk, category=category, min_score=min_gate_score)
            # Preserve challenge-level labels for small continuation chunks that
            # may omit the primitive name but still belong to a gated solution.
            labels = chunk_gate if chunk_gate.keep else gate
            code = extract_code_snippet(chunk)
            text_chunk = _trim_chunk(chunk, max_chars)
            record = AttackMemoryRecord(
                event=segment.event,
                challenge=segment.challenge or segment.title,
                crypto_type=labels.crypto_type,
                attack_pattern=labels.attack_pattern,
                text_chunk=text_chunk,
                code_snippet=code,
                source_url=segment.source_url,
                ctftime_url=segment.ctftime_url,
                source_title=segment.title,
                tags=segment.tags,
                gate_score=labels.score,
                category=category,
                id=stable_id(
                    segment.source_url,
                    segment.challenge,
                    idx,
                    ",".join(labels.attack_pattern),
                    text_chunk[:300],
                ),
            )
            records.append(record)
    return records


def chunk_markdown(
    markdown: str, *, max_chars: int = 4200, overlap_chars: int = 500
) -> list[str]:
    """Chunk markdown by paragraphs/headings while trying not to split code fences."""

    text = (markdown or "").strip()
    if not text:
        return []
    if len(text) <= max_chars:
        return [text]

    blocks = _split_blocks_preserving_fences(text)
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for block in blocks:
        block_len = len(block) + 2
        if current and current_len + block_len > max_chars:
            chunk = "\n\n".join(current).strip()
            if chunk:
                chunks.append(chunk)
            overlap = _suffix_overlap(chunk, overlap_chars)
            current = [overlap] if overlap else []
            current_len = len(overlap)
        if block_len > max_chars:
            for piece in _hard_wrap(
                block, max_chars=max_chars, overlap_chars=overlap_chars
            ):
                if current:
                    chunk = "\n\n".join(current).strip()
                    if chunk:
                        chunks.append(chunk)
                    current = []
                    current_len = 0
                chunks.append(piece)
            continue
        current.append(block)
        current_len += block_len
    if current:
        chunk = "\n\n".join(current).strip()
        if chunk:
            chunks.append(chunk)
    return chunks


def extract_code_snippet(markdown: str, *, max_chars: int = 2400) -> str:
    snippets = [
        m.group(1).strip()
        for m in CODE_FENCE_RE.finditer(markdown or "")
        if m.group(1).strip()
    ]
    if not snippets:
        # Fallback: collect indented code-ish lines.
        lines = []
        for line in (markdown or "").splitlines():
            stripped = line.strip()
            if line.startswith(("    ", "\t")) and (
                "=" in stripped
                or "(" in stripped
                or stripped.startswith(("from ", "import ", "sage:"))
            ):
                lines.append(stripped)
        snippets = ["\n".join(lines)] if lines else []
    text = "\n\n---\n\n".join(snippets)
    return text[:max_chars].rstrip()


def _split_blocks_preserving_fences(text: str) -> list[str]:
    blocks: list[str] = []
    current: list[str] = []
    in_fence = False
    for line in text.splitlines():
        if line.strip().startswith(("```", "~~~")):
            in_fence = not in_fence
        if not in_fence and not line.strip():
            if current:
                blocks.append("\n".join(current).strip())
                current = []
            continue
        current.append(line)
    if current:
        blocks.append("\n".join(current).strip())
    return [block for block in blocks if block]


def _hard_wrap(text: str, *, max_chars: int, overlap_chars: int) -> list[str]:
    pieces = []
    pos = 0
    while pos < len(text):
        end = min(len(text), pos + max_chars)
        pieces.append(text[pos:end].strip())
        if end >= len(text):
            break
        pos = max(0, end - overlap_chars)
    return [piece for piece in pieces if piece]


def _suffix_overlap(text: str, overlap_chars: int) -> str:
    if overlap_chars <= 0 or not text:
        return ""
    suffix = text[-overlap_chars:]
    # Avoid starting in the middle of a fenced block marker when possible.
    line_start = suffix.find("\n")
    return suffix[line_start + 1 :].strip() if line_start >= 0 else suffix.strip()


def _trim_chunk(text: str, max_chars: int) -> str:
    text = text.strip()
    if len(text) <= max_chars:
        return text
    return text[:max_chars].rstrip() + "\n...[chunk truncated]"


def _clean_heading(title: str) -> str:
    title = re.sub(r"\s+", " ", title or "").strip()
    title = re.sub(r"^[#*\-\s]+", "", title)
    return title[:180]


def _first_nonempty_line(text: str) -> str:
    for line in (text or "").splitlines():
        stripped = _clean_heading(line)
        if stripped:
            return stripped
    return ""


def _challenge_from_url(url: str) -> str:
    value = (url or "").rstrip("/").split("/")[-1]
    value = re.sub(r"[-_]+", " ", value)
    return value[:120] or "unknown challenge"


def _infer_event_from_title(title: str) -> str:
    title = title or ""
    if EVENT_HINT_RE.search(title):
        return title[:120]
    return ""


def _looks_like_event_title(title: str) -> bool:
    title = title or ""
    return bool(
        EVENT_HINT_RE.search(title) or re.search(r"writeups?$", title, re.IGNORECASE)
    )

def _extract_tags(text: str) -> list[str]:
    tags = []
    for match in CATEGORY_TAG_RE.finditer(text or ""):
        value = match.group(0).lower()
        if value not in tags:
            tags.append(value)
    return tags[:12]
