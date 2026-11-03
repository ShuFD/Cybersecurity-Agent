from __future__ import annotations

from dataclasses import dataclass, field
import json
import os
from pathlib import Path
from typing import Any, Iterable
from uuid import uuid4


SCHEMA_VERSION = 1


@dataclass(frozen=True)
class SessionLogEvent:
    session_id: str
    turn_id: int
    role: str
    content: list[dict[str, Any]]
    source: str
    ts: float
    uuid: str = field(default_factory=lambda: str(uuid4()))
    parent_uuid: str = ""
    model: str = ""

    def to_record(self) -> dict[str, Any]:
        return {
            "schema_version": SCHEMA_VERSION,
            "type": "message",
            "uuid": str(self.uuid or ""),
            "parent_uuid": str(self.parent_uuid or ""),
            "session_id": self.session_id,
            "turn_id": int(self.turn_id),
            "role": self.role,
            "content": self.content,
            "source": self.source,
            "ts": float(self.ts),
            "timestamp": float(self.ts),
            "model": str(self.model or ""),
        }

    @classmethod
    def from_record(cls, record: dict[str, Any]) -> "SessionLogEvent":
        if record.get("schema_version") != SCHEMA_VERSION:
            raise ValueError(f"Unsupported session log schema: {record.get('schema_version')!r}")
        record_type = record.get("type") or "message"
        if record_type != "message":
            raise ValueError(f"Unsupported session message record type: {record_type!r}")
        content = record.get("content")
        if not isinstance(content, list):
            raise ValueError("Session log content must be a list")
        return cls(
            session_id=str(record.get("session_id") or ""),
            turn_id=int(record.get("turn_id") or 0),
            role=str(record.get("role") or ""),
            content=content,
            source=str(record.get("source") or ""),
            ts=float(record.get("ts") if record.get("ts") is not None else record.get("timestamp") or 0),
            uuid=str(record.get("uuid") or uuid4()),
            parent_uuid=str(record.get("parent_uuid") or ""),
            model=str(record.get("model") or ""),
        )


@dataclass(frozen=True)
class SessionCompactBoundary:
    session_id: str
    turn_id: int
    summary_content: list[dict[str, Any]]
    kept_from_turn_id: int
    source: str
    ts: float
    uuid: str = field(default_factory=lambda: str(uuid4()))
    parent_uuid: str = ""
    summary_uuid: str = ""
    kept_from_uuid: str = ""

    def to_record(self) -> dict[str, Any]:
        record_uuid = str(self.uuid or "")
        return {
            "schema_version": SCHEMA_VERSION,
            "type": "compact_boundary",
            "uuid": record_uuid,
            "parent_uuid": str(self.parent_uuid or ""),
            "session_id": self.session_id,
            "turn_id": int(self.turn_id),
            "summary_content": self.summary_content,
            "kept_from_turn_id": int(self.kept_from_turn_id),
            "summary_uuid": str(self.summary_uuid or record_uuid),
            "kept_from_uuid": str(self.kept_from_uuid or ""),
            "source": self.source,
            "ts": float(self.ts),
            "timestamp": float(self.ts),
        }

    @classmethod
    def from_record(cls, record: dict[str, Any]) -> "SessionCompactBoundary":
        if record.get("schema_version") != SCHEMA_VERSION:
            raise ValueError(f"Unsupported session log schema: {record.get('schema_version')!r}")
        if record.get("type") != "compact_boundary":
            raise ValueError(f"Unsupported compact boundary record type: {record.get('type')!r}")
        summary_content = record.get("summary_content")
        if not isinstance(summary_content, list):
            raise ValueError("Compact boundary summary_content must be a list")
        return cls(
            session_id=str(record.get("session_id") or ""),
            turn_id=int(record.get("turn_id") or 0),
            summary_content=summary_content,
            kept_from_turn_id=int(record.get("kept_from_turn_id") or 0),
            source=str(record.get("source") or ""),
            ts=float(record.get("ts") if record.get("ts") is not None else record.get("timestamp") or 0),
            uuid=str(record.get("uuid") or uuid4()),
            parent_uuid=str(record.get("parent_uuid") or ""),
            summary_uuid=str(record.get("summary_uuid") or ""),
            kept_from_uuid=str(record.get("kept_from_uuid") or ""),
        )


def legacy_session_log_sidecar_path(path: str | os.PathLike[str]) -> Path:
    return Path(path).with_suffix(".jsonl")


def session_log_sidecar_path(path: str | os.PathLike[str]) -> Path:
    source = Path(path)
    if source.parent.name == "sessions" and source.suffix == ".jsonl":
        return source
    if source.parent.name == "model_responses":
        session_dir = source.parent.parent / "sessions"
    else:
        session_dir = source.parent / "sessions"
    return session_dir / f"{source.stem}.jsonl"


def append_session_event(
    path: str | os.PathLike[str],
    event: SessionLogEvent | SessionCompactBoundary,
) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(event.to_record(), ensure_ascii=False, separators=(",", ":"))
    with target.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def _iter_session_records_with_line_numbers(
    path: str | os.PathLike[str],
) -> Iterable[tuple[int, dict[str, Any]]]:
    target = Path(path)
    if not target.exists():
        return
    with target.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                record = json.loads(stripped)
                if not isinstance(record, dict):
                    raise ValueError("Session log record must be an object")
                if record.get("schema_version") != SCHEMA_VERSION:
                    raise ValueError(f"Unsupported session log schema: {record.get('schema_version')!r}")
                yield line_no, record
            except (json.JSONDecodeError, ValueError, TypeError) as e:
                raise ValueError(f"Invalid session log line {line_no} in {target}: {e}") from e


def read_session_records(path: str | os.PathLike[str]) -> Iterable[dict[str, Any]]:
    for _, record in _iter_session_records_with_line_numbers(path):
        yield record


def read_recoverable_session_records(path: str | os.PathLike[str]) -> Iterable[dict[str, Any]]:
    target = Path(path)
    if not target.exists():
        return
    try:
        lines = target.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        try:
            record = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if isinstance(record, dict) and record.get("schema_version") == SCHEMA_VERSION:
            yield record


def read_session_events(path: str | os.PathLike[str]) -> Iterable[SessionLogEvent]:
    target = Path(path)
    for line_no, record in _iter_session_records_with_line_numbers(target):
        if record.get("type") == "compact_boundary":
            continue
        try:
            yield SessionLogEvent.from_record(record)
        except (ValueError, TypeError) as e:
            raise ValueError(f"Invalid session log line {line_no} in {target}: {e}") from e
