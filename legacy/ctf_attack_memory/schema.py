"""Data models for the CTF attack-centric memory bank."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from typing import Any

SCHEMA_VERSION = "attack-memory.v1"
DEFAULT_CATEGORY = "crypto"


def stable_id(*parts: object, length: int = 16) -> str:
    payload = "\x1f".join(str(part or "") for part in parts)
    return hashlib.sha1(payload.encode("utf-8", "ignore")).hexdigest()[:length]


@dataclass
class CTFtimeLink:
    """A URL discovered from a CTFtime index/event/writeup page."""

    url: str
    link_type: str = "writeup"
    title: str = ""
    source_url: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class CTFtimeWriteupEntry:
    """One row from CTFtime's global writeup table."""

    writeup_id: str
    writeup_url: str
    event: str = ""
    event_url: str = ""
    event_id: str = ""
    event_year: int = 0
    task: str = ""
    task_url: str = ""
    task_id: str = ""
    tags: list[str] = field(default_factory=list)
    author_team: str = ""
    source_page: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CTFtimeWriteupEntry":
        payload = dict(data)
        payload.setdefault("tags", [])
        if isinstance(payload.get("tags"), str):
            payload["tags"] = [payload["tags"]]
        known = set(cls.__dataclass_fields__.keys())
        return cls(**{key: value for key, value in payload.items() if key in known})


@dataclass
class FetchedDocument:
    """Raw fetched content plus normalized metadata."""

    url: str
    final_url: str = ""
    status_code: int = 0
    content_type: str = ""
    title: str = ""
    text: str = ""
    raw_path: str = ""


@dataclass
class GateResult:
    """Crypto strong-gate output."""

    keep: bool
    score: float = 0.0
    crypto_type: list[str] = field(default_factory=list)
    attack_pattern: list[str] = field(default_factory=list)
    primitive_hits: list[str] = field(default_factory=list)
    attack_hits: list[str] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ChallengeSegment:
    """A challenge-level segment extracted from a weakly structured writeup."""

    event: str = ""
    challenge: str = ""
    title: str = ""
    markdown: str = ""
    source_url: str = ""
    ctftime_url: str = ""
    tags: list[str] = field(default_factory=list)


@dataclass
class AttackMemoryRecord:
    """Canonical v1 attack pattern chunk stored in the local hybrid index."""

    event: str
    challenge: str
    crypto_type: list[str]
    attack_pattern: list[str]
    text_chunk: str
    code_snippet: str
    source_url: str
    id: str = ""
    category: str = DEFAULT_CATEGORY
    ctftime_url: str = ""
    source_title: str = ""
    tags: list[str] = field(default_factory=list)
    libc_versions: list[str] = field(default_factory=list)
    gate_score: float = 0.0
    schema_version: str = SCHEMA_VERSION

    def __post_init__(self) -> None:
        self.crypto_type = _dedupe_list(self.crypto_type)
        self.attack_pattern = _dedupe_list(self.attack_pattern)
        self.tags = _dedupe_list(self.tags)
        self.libc_versions = _dedupe_list(self.libc_versions)
        if not self.id:
            self.id = stable_id(
                self.event,
                self.challenge,
                ",".join(self.attack_pattern),
                self.source_url,
                self.text_chunk[:512],
            )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, sort_keys=True)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AttackMemoryRecord":
        payload = dict(data)
        payload.setdefault("event", "")
        payload.setdefault("challenge", "")
        payload.setdefault("crypto_type", [])
        payload.setdefault("attack_pattern", [])
        payload.setdefault("text_chunk", "")
        payload.setdefault("code_snippet", "")
        payload.setdefault("source_url", "")
        if isinstance(payload.get("crypto_type"), str):
            payload["crypto_type"] = [payload["crypto_type"]]
        if isinstance(payload.get("attack_pattern"), str):
            payload["attack_pattern"] = [payload["attack_pattern"]]
        if isinstance(payload.get("tags"), str):
            payload["tags"] = [payload["tags"]]
        if isinstance(payload.get("libc_versions"), str):
            payload["libc_versions"] = [payload["libc_versions"]]
        payload.setdefault("libc_versions", [])
        known = set(cls.__dataclass_fields__.keys())
        return cls(**{key: value for key, value in payload.items() if key in known})


@dataclass
class SearchHit:
    """One ranked retrieval result from the hybrid local index."""

    record: AttackMemoryRecord
    score: float
    bm25_score: float = 0.0
    vector_score: float = 0.0
    rerank_score: float = 0.0
    matched_patterns: list[str] = field(default_factory=list)
    snippet: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.record.id,
            "score": self.score,
            "bm25_score": self.bm25_score,
            "vector_score": self.vector_score,
            "rerank_score": self.rerank_score,
            "matched_patterns": list(self.matched_patterns),
            "snippet": self.snippet,
            "record": self.record.to_dict(),
        }


def _dedupe_list(items: list[str] | tuple[str, ...] | None) -> list[str]:
    seen = set()
    out = []
    for item in items or []:
        value = str(item or "").strip()
        if not value:
            continue
        key = value.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(value)
    return out
