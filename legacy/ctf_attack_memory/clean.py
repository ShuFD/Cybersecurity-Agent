"""Markdown normalization and low-risk HTML-to-Markdown conversion."""

from __future__ import annotations

import html
import re
from urllib.parse import urlparse

from .sanitize import sanitize_untrusted_text

try:
    from bs4 import BeautifulSoup
except Exception:  # pragma: no cover - dependency is declared, fallback stays safe.
    BeautifulSoup = None


BOILERPLATE_LINE_RE = re.compile(
    r"^\s*(?:"
    r"sign\s+in|sign\s+up|log\s+in|register|subscribe|share|tweet|"
    r"previous|next|home|back\s+to\s+top|table\s+of\s+contents|"
    r"comments?|leave\s+a\s+comment|powered\s+by|copyright|"
    r"github|ctftime\.org|all\s+rights\s+reserved"
    r")\s*$",
    re.IGNORECASE,
)

NAV_WORD_RE = re.compile(
    r"\b(?:navigation|navbar|sidebar|footer|header|cookie|advertisement)\b",
    re.IGNORECASE,
)


def normalize_markdown(text: str) -> str:
    """Normalize markdown/plain text and remove obvious page boilerplate."""

    if not text:
        return ""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = html.unescape(text)
    text = re.sub(r"\t", "    ", text)
    text = re.sub(r"[ \u00a0]+\n", "\n", text)

    lines: list[str] = []
    blank_count = 0
    in_fence = False
    previous_line = None
    for raw in text.split("\n"):
        line = raw.rstrip()
        stripped = line.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
        if not in_fence:
            if BOILERPLATE_LINE_RE.match(stripped):
                continue
            if len(stripped) < 64 and NAV_WORD_RE.search(stripped):
                continue
            # Collapse exact duplicate short lines frequently emitted by nav bars.
            if previous_line == stripped and len(stripped) < 120:
                continue
        if stripped:
            blank_count = 0
            lines.append(line)
            previous_line = stripped
        else:
            blank_count += 1
            if blank_count <= 2:
                lines.append("")
    text = "\n".join(lines).strip()
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    return sanitize_untrusted_text(text).text


def html_to_markdown(raw_html: str, *, source_url: str = "") -> str:
    """Convert common writeup HTML into readable markdown.

    This intentionally avoids a heavy dependency.  It preserves headings,
    links, lists, paragraphs, and code blocks well enough for downstream
    attack-pattern filtering and challenge segmentation.
    """

    if not raw_html:
        return ""
    if BeautifulSoup is None:
        return normalize_markdown(_strip_tags(raw_html))

    soup = BeautifulSoup(raw_html, "html.parser")
    for tag in soup(["script", "style", "noscript", "svg", "form", "iframe"]):
        tag.decompose()
    for selector in ("nav", "footer", "header", "aside"):
        for tag in soup.find_all(selector):
            tag.decompose()
    for tag in soup.find_all(attrs={"class": NAV_WORD_RE}):
        tag.decompose()
    for tag in soup.find_all(attrs={"id": NAV_WORD_RE}):
        tag.decompose()

    main = _select_main_content(soup, source_url)
    chunks: list[str] = []
    for child in main.children if getattr(main, "children", None) is not None else []:
        rendered = _render_node(child, source_url=source_url).strip("\n")
        if rendered:
            chunks.append(rendered)
    if not chunks:
        chunks.append(main.get_text("\n"))
    return normalize_markdown("\n\n".join(chunks))


def normalize_document(
    content: str, *, content_type: str = "", source_url: str = ""
) -> str:
    """Normalize fetched content, dispatching HTML vs markdown/plain text."""

    content_type = (content_type or "").lower()
    head = (content or "")[:500].lower()
    is_html = (
        "html" in content_type
        or "<html" in head
        or "<article" in head
        or "<body" in head
    )
    if is_html:
        return html_to_markdown(content, source_url=source_url)
    return normalize_markdown(content)


def extract_title(content: str, *, content_type: str = "") -> str:
    if BeautifulSoup is None:
        match = re.search(
            r"<title[^>]*>(.*?)</title>", content or "", re.IGNORECASE | re.DOTALL
        )
        return (
            html.unescape(re.sub(r"\s+", " ", match.group(1))).strip() if match else ""
        )
    if "<" not in (content or "")[:2000] and "html" not in (content_type or "").lower():
        for line in (content or "").splitlines():
            stripped = line.strip().lstrip("#").strip()
            if stripped:
                return stripped[:160]
        return ""
    soup = BeautifulSoup(content or "", "html.parser")
    if soup.title and soup.title.string:
        return re.sub(r"\s+", " ", soup.title.string).strip()
    heading = soup.find(["h1", "h2"])
    return re.sub(r"\s+", " ", heading.get_text(" ")).strip() if heading else ""


def _select_main_content(soup, source_url: str):
    host = urlparse(source_url or "").netloc.lower()
    selectors = []
    if "github.com" in host:
        selectors.extend(
            [
                "article.markdown-body",
                "div.markdown-body",
                "readme-toc + div",
            ]
        )
    selectors.extend(
        [
            "article",
            "main",
            "div.markdown-body",
            "div.post-content",
            "div.entry-content",
            "div.article-content",
            "div.content",
            "body",
        ]
    )
    for selector in selectors:
        found = soup.select_one(selector)
        if found and len(found.get_text(" ").strip()) >= 80:
            return found
    return soup.body or soup


def _render_node(node, *, source_url: str = "") -> str:
    name = getattr(node, "name", None)
    if name is None:
        return str(node)
    if name in {"h1", "h2", "h3", "h4", "h5", "h6"}:
        level = int(name[1])
        text = node.get_text(" ", strip=True)
        return f"{'#' * level} {text}\n"
    if name in {"p", "div", "section", "article"}:
        parts = [
            _render_node(child, source_url=source_url).strip("\n")
            for child in node.children
        ]
        return "\n\n".join(part for part in parts if part)
    if name == "br":
        return "\n"
    if name in {"ul", "ol"}:
        lines = []
        ordered = name == "ol"
        for idx, li in enumerate(node.find_all("li", recursive=False), 1):
            item = _render_node(li, source_url=source_url).strip().replace("\n", "\n  ")
            prefix = f"{idx}." if ordered else "-"
            if item:
                lines.append(f"{prefix} {item}")
        return "\n".join(lines) + "\n"
    if name == "li":
        return " ".join(
            _render_node(child, source_url=source_url).strip()
            for child in node.children
            if _render_node(child, source_url=source_url).strip()
        )
    if name == "pre":
        code = node.get_text("\n").strip("\n")
        return f"```\n{code}\n```\n" if code else ""
    if name == "code":
        if node.find_parent("pre"):
            return node.get_text()
        code = node.get_text(" ", strip=True)
        return f"`{code}`" if code else ""
    if name == "a":
        text = node.get_text(" ", strip=True)
        href = node.get("href") or ""
        if not text:
            return href
        if href and href != text and not href.startswith("#"):
            return f"[{text}]({href})"
        return text
    if name in {"table", "thead", "tbody", "tr", "td", "th"}:
        return node.get_text(" | ", strip=True)
    return "".join(
        _render_node(child, source_url=source_url) for child in node.children
    )


def _strip_tags(raw: str) -> str:
    raw = re.sub(r"(?is)<(script|style).*?>.*?</\1>", "", raw or "")

    def anchor_repl(match):
        href = match.group(2).strip()
        label = re.sub(r"<[^>]+>", " ", match.group(3))
        label = re.sub(r"\s+", " ", html.unescape(label)).strip() or href
        return f"[{label}]({href})"

    def pre_repl(match):
        code = re.sub(r"<[^>]+>", "", match.group(1))
        code = html.unescape(code).strip("\n")
        return f"\n```\n{code}\n```\n" if code.strip() else "\n"

    def heading_repl(match):
        level = max(1, min(6, int(match.group(1))))
        label = re.sub(r"<[^>]+>", " ", match.group(2))
        label = re.sub(r"\s+", " ", html.unescape(label)).strip()
        return f"\n{'#' * level} {label}\n" if label else "\n"

    raw = re.sub(r"(?is)<pre[^>]*>(.*?)</pre>", pre_repl, raw)
    raw = re.sub(r"(?is)<h([1-6])[^>]*>(.*?)</h\1>", heading_repl, raw)
    raw = re.sub(
        r"(?is)<a\b[^>]*\bhref\s*=\s*(['\"])(.*?)\1[^>]*>(.*?)</a>", anchor_repl, raw
    )
    raw = re.sub(r"(?i)<br\s*/?>", "\n", raw)
    raw = re.sub(r"(?i)</(?:p|div|li|tr)>", "\n", raw)
    raw = re.sub(r"<[^>]+>", " ", raw)
    return raw
