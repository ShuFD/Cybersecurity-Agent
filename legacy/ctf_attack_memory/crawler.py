"""CTFtime/writeup crawling helpers for the offline attack-memory pipeline."""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable
from urllib.parse import urldefrag, urljoin, urlparse

import requests

from .clean import extract_title, normalize_document
from .schema import CTFtimeLink, FetchedDocument, stable_id

try:
    from bs4 import BeautifulSoup
except Exception:  # pragma: no cover
    BeautifulSoup = None


DEFAULT_USER_AGENT = (
    "SecHeur-Agent attack-memory-crawler/1.0 (+offline CTF writeup indexing)"
)
CTFTIME_HOSTS = {"ctftime.org", "www.ctftime.org"}
SKIP_HREF_RE = re.compile(r"^(?:javascript:|mailto:|tel:|#)", re.IGNORECASE)
SKIP_EXTERNAL_HOST_RE = re.compile(
    r"(?:twitter|facebook|linkedin|discord|youtube|youtu\.be|t\.me|telegram|ctftime\.org/(?:team|user|stats|login|logout|signup|calendar))",
    re.IGNORECASE,
)
WRITEUP_HINT_RE = re.compile(
    r"\b(write[- ]?up|solution|solve|crypto|cryptography|rsa|ecc|lattice|prng)\b",
    re.IGNORECASE,
)
EVENT_PATH_RE = re.compile(r"^/(?:event|ctf)/(\d+)")
WRITEUP_PATH_RE = re.compile(r"^/writeup/(\d+)")
RAW_TEXT_CONTENT_TYPES = (
    "text/plain",
    "text/markdown",
    "application/octet-stream",
    "application/json",
)
BINARY_URL_RE = re.compile(
    r"\.(?:pdf|zip|7z|rar|tar|gz|png|jpe?g|gif|webp|mp4|mov|avi|pcap|pcapng|bin|exe|dll|so|dylib)(?:$|[?#])",
    re.IGNORECASE,
)
BINARY_CONTENT_RE = re.compile(
    r"(?:application/pdf|application/zip|application/x-7z|application/octet-stream|image/|video/)",
    re.IGNORECASE,
)


@dataclass
class CrawlStats:
    seed_count: int = 0
    ctftime_pages: int = 0
    discovered_links: int = 0
    fetched_documents: int = 0
    skipped: int = 0

    def to_dict(self) -> dict[str, int]:
        return {
            "seed_count": self.seed_count,
            "ctftime_pages": self.ctftime_pages,
            "discovered_links": self.discovered_links,
            "fetched_documents": self.fetched_documents,
            "skipped": self.skipped,
        }


class WriteupCrawler:
    """Small respectful crawler for CTFtime-indexed writeups.

    v1 intentionally keeps crawling shallow and deterministic: CTFtime pages are
    treated as an index layer, and external writeup pages are fetched once.
    """

    def __init__(
        self,
        *,
        cache_dir: str | Path | None = None,
        delay_seconds: float = 0.5,
        timeout_seconds: float = 20.0,
        user_agent: str = DEFAULT_USER_AGENT,
        verify_tls: bool = True,
        session: requests.Session | None = None,
    ):
        self.cache_dir = Path(cache_dir) if cache_dir else None
        self.delay_seconds = max(0.0, float(delay_seconds or 0.0))
        self.timeout_seconds = max(1.0, float(timeout_seconds or 20.0))
        self.session = session or requests.Session()
        self.verify_tls = bool(verify_tls)
        # Keep `get()` calls compatible with lightweight test/custom sessions.
        # Requests applies this setting to every request from its session.
        if hasattr(self.session, "verify"):
            self.session.verify = self.verify_tls
        self.session.headers.update({"User-Agent": user_agent})
        self.stats = CrawlStats()
        if self.cache_dir:
            self.cache_dir.mkdir(parents=True, exist_ok=True)

    def discover_from_ctftime(
        self, seeds: Iterable[str], *, max_pages: int = 100, max_links: int = 1000
    ) -> list[CTFtimeLink]:
        """Discover event/writeup/external links from CTFtime seed pages."""

        queue = list(
            dict.fromkeys(str(seed).strip() for seed in seeds if str(seed).strip())
        )
        self.stats.seed_count += len(queue)
        seen_pages: set[str] = set()
        links: dict[str, CTFtimeLink] = {}

        while queue and len(seen_pages) < max_pages and len(links) < max_links:
            url = queue.pop(0)
            normalized = normalize_url(url)
            if normalized in seen_pages or not _is_ctftime_url(normalized):
                continue
            seen_pages.add(normalized)
            doc = self.fetch(normalized)
            if not doc.text:
                continue
            self.stats.ctftime_pages += 1
            page_links = extract_ctftime_links(
                doc.text, base_url=doc.final_url or normalized
            )
            for link in page_links:
                if len(links) >= max_links:
                    break
                key = normalize_url(link.url)
                if not key:
                    continue
                if (
                    link.link_type in {"event", "ctftime_writeup"}
                    and _is_ctftime_url(key)
                    and key not in seen_pages
                ):
                    queue.append(key)
                if link.link_type in {"external_writeup", "ctftime_writeup"}:
                    links.setdefault(key, link)
        self.stats.discovered_links += len(links)
        return list(links.values())

    def fetch_documents(
        self, links: Iterable[CTFtimeLink], *, max_documents: int = 500
    ) -> list[FetchedDocument]:
        docs: list[FetchedDocument] = []
        seen = set()
        for link in links:
            if len(docs) >= max_documents:
                break
            url = normalize_url(link.url)
            if not url or url in seen:
                continue
            seen.add(url)
            if link.link_type == "event":
                self.stats.skipped += 1
                continue
            doc = self.fetch(url)
            if not doc.text:
                self.stats.skipped += 1
                continue
            docs.append(doc)
            self.stats.fetched_documents += 1
        return docs

    def fetch(self, url: str) -> FetchedDocument:
        url = github_raw_url(normalize_url(url))
        if not url:
            return FetchedDocument(url=url)
        if BINARY_URL_RE.search(url):
            return FetchedDocument(url=url, content_type="binary/skipped")
        cached = self._read_cache(url)
        if cached:
            return cached
        if self.delay_seconds:
            time.sleep(self.delay_seconds)
        try:
            resp = self.session.get(
                url, timeout=self.timeout_seconds, allow_redirects=True
            )
        except requests.RequestException:
            return FetchedDocument(url=url)
        content_type = resp.headers.get("Content-Type", "")
        text = _response_text(resp, content_type, url=resp.url or url)
        normalized = normalize_document(
            text, content_type=content_type, source_url=resp.url or url
        )
        doc = FetchedDocument(
            url=url,
            final_url=resp.url or url,
            status_code=resp.status_code,
            content_type=content_type,
            title=extract_title(text, content_type=content_type),
            text=normalized,
        )
        self._write_cache(doc, raw_text=text)
        return doc

    def _cache_path(self, url: str) -> Path | None:
        if not self.cache_dir:
            return None
        return self.cache_dir / f"{stable_id(url, length=24)}.json"

    def _read_cache(self, url: str) -> FetchedDocument | None:
        path = self._cache_path(url)
        if not path or not path.is_file():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            return FetchedDocument(
                **{
                    key: payload.get(key, "")
                    for key in FetchedDocument.__dataclass_fields__
                }
            )
        except (OSError, TypeError, json.JSONDecodeError):
            return None

    def _write_cache(self, doc: FetchedDocument, *, raw_text: str = "") -> None:
        path = self._cache_path(doc.url)
        if not path:
            return
        payload = {
            "url": doc.url,
            "final_url": doc.final_url,
            "status_code": doc.status_code,
            "content_type": doc.content_type,
            "title": doc.title,
            "text": doc.text,
            "raw_path": doc.raw_path,
            "raw_text_prefix": raw_text[:2000],
        }
        try:
            path.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except OSError:
            pass


def extract_ctftime_links(
    html_or_markdown: str, *, base_url: str = "https://ctftime.org/"
) -> list[CTFtimeLink]:
    """Extract event, CTFtime writeup, and external writeup URLs from a CTFtime page."""

    links: list[CTFtimeLink] = []
    seen: set[str] = set()
    for href, title in _iter_links(html_or_markdown, base_url=base_url):
        url = normalize_url(href)
        if not url or url in seen:
            continue
        seen.add(url)
        parsed = urlparse(url)
        host = parsed.netloc.lower()
        path = parsed.path or "/"
        if host in CTFTIME_HOSTS:
            if EVENT_PATH_RE.match(path):
                links.append(
                    CTFtimeLink(
                        url=url, link_type="event", title=title, source_url=base_url
                    )
                )
            elif WRITEUP_PATH_RE.match(path):
                links.append(
                    CTFtimeLink(
                        url=url,
                        link_type="ctftime_writeup",
                        title=title,
                        source_url=base_url,
                    )
                )
            continue
        if _looks_like_writeup_url(url, title):
            links.append(
                CTFtimeLink(
                    url=url,
                    link_type="external_writeup",
                    title=title,
                    source_url=base_url,
                )
            )
    return links


def normalize_url(url: str) -> str:
    url = str(url or "").strip()
    if not url:
        return ""
    url, _fragment = urldefrag(url)
    if url.startswith("//"):
        url = "https:" + url
    if not re.match(r"^https?://", url, re.IGNORECASE):
        return ""
    try:
        parsed = urlparse(url)
    except ValueError:
        return ""
    if not parsed.netloc:
        return ""
    path = parsed.path or "/"
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")
    rebuilt = parsed._replace(
        scheme=parsed.scheme.lower(), netloc=parsed.netloc.lower(), path=path
    ).geturl()
    return rebuilt


def github_raw_url(url: str) -> str:
    """Convert common GitHub blob URLs to raw content URLs."""

    try:
        parsed = urlparse(url or "")
    except ValueError:
        return ""
    if parsed.netloc.lower() != "github.com":
        return url
    parts = parsed.path.strip("/").split("/")
    if len(parts) >= 5 and parts[2] == "blob":
        owner, repo, _blob, branch = parts[:4]
        rest = "/".join(parts[4:])
        return f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{rest}"
    return url


def _iter_links(html_or_markdown: str, *, base_url: str) -> Iterable[tuple[str, str]]:
    text = html_or_markdown or ""
    if "<a" in text.lower():
        if BeautifulSoup is not None:
            soup = BeautifulSoup(text, "html.parser")
            for anchor in soup.find_all("a"):
                href = anchor.get("href") or ""
                if SKIP_HREF_RE.match(href):
                    continue
                yield urljoin(base_url, href), anchor.get_text(" ", strip=True)
            return
        for match in re.finditer(
            r"<a\b[^>]*\bhref\s*=\s*(['\"])(.*?)\1[^>]*>(.*?)</a>",
            text,
            re.IGNORECASE | re.DOTALL,
        ):
            href = match.group(2).strip()
            if SKIP_HREF_RE.match(href):
                continue
            title = re.sub(r"<[^>]+>", " ", match.group(3))
            title = re.sub(r"\s+", " ", title).strip()
            yield urljoin(base_url, href), title
        return
    # Markdown/plain-text fallback.  CTFtime links are often relative, and the
    # HTML normalizer preserves them as `[title](/writeup/123)`, so resolve via
    # `base_url` here instead of only accepting absolute URLs.
    for match in re.finditer(r"\[([^\]]{0,160})\]\(([^)\s]+)\)", text):
        href = match.group(2).strip("'\"")
        if SKIP_HREF_RE.match(href):
            continue
        yield urljoin(base_url, href), match.group(1)
    for match in re.finditer(r"https?://[^\s)\]>'\"]+", text):
        yield match.group(0), ""


def _looks_like_writeup_url(url: str, title: str = "") -> bool:
    hay = f"{title} {url}"
    if SKIP_EXTERNAL_HOST_RE.search(hay):
        return False
    try:
        host = urlparse(url).netloc.lower()
    except ValueError:
        return False
    if not host or host in CTFTIME_HOSTS:
        return False
    trusted_hosts = (
        "github.com",
        "raw.githubusercontent.com",
        "gitlab.com",
        "gist.github.com",
        "ctf-wiki.org",
        "blog",
        "medium.com",
        "hackmd.io",
        "notion.site",
    )
    return WRITEUP_HINT_RE.search(hay) is not None or any(
        item in host for item in trusted_hosts
    )


def _is_ctftime_url(url: str) -> bool:
    return urlparse(url or "").netloc.lower() in CTFTIME_HOSTS


def _response_text(resp: requests.Response, content_type: str, *, url: str = "") -> str:
    if resp.status_code >= 400:
        from http_status_utils import classify_for_agent
        c = classify_for_agent(resp.status_code, url=url or resp.url)
        return (
            f"[HTTP {resp.status_code} — {c['category']}] {c['meaning']} "
            f"({resp.reason or 'no reason'})"
        )
    if BINARY_URL_RE.search(url or ""):
        return ""
    if BINARY_CONTENT_RE.search(content_type or "") and not any(
        kind in (content_type or "").lower()
        for kind in ("text", "json", "xml", "html", "markdown")
    ):
        return ""
    encoding = resp.encoding or _charset_from_content_type(content_type) or "utf-8"
    try:
        return resp.content.decode(encoding, errors="replace")
    except LookupError:
        return resp.content.decode("utf-8", errors="replace")


def _charset_from_content_type(content_type: str) -> str:
    match = re.search(
        r"(?:^|;)\s*charset\s*=\s*['\"]?([^;'\"]+)", content_type or "", re.IGNORECASE
    )
    return match.group(1).strip() if match else ""
