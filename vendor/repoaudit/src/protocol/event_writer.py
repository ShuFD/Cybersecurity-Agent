"""Thread-safe JSONL writer for RepoAudit analysis events."""

from __future__ import annotations

import sys
import threading
from typing import Any, Dict, Optional, TextIO, Tuple

from .errors import StructuredError
from .events import AnalysisEvent
from .models import (
    CandidateId,
    PathId,
    RunId,
    validate_candidate_id,
    validate_path_id,
    validate_run_id,
)


DEFAULT_MAX_EVENT_BYTES = 64 * 1024
MIN_MAX_EVENT_BYTES = 1024


class EventWriteError(RuntimeError):
    """Raised when the event stream cannot accept a complete JSONL record."""


class EventWriter:
    """Write one compact JSON object per line to an event-only stream."""

    def __init__(
        self,
        event_stream: Optional[TextIO] = None,
        log_stream: Optional[TextIO] = None,
        max_event_bytes: int = DEFAULT_MAX_EVENT_BYTES,
        flush: bool = True,
    ) -> None:
        self.event_stream = event_stream if event_stream is not None else sys.stdout
        self.log_stream = log_stream if log_stream is not None else sys.stderr
        if self.event_stream is self.log_stream:
            raise ValueError("event_stream and log_stream must be different streams")
        if (
            not isinstance(max_event_bytes, int)
            or isinstance(max_event_bytes, bool)
            or max_event_bytes < MIN_MAX_EVENT_BYTES
        ):
            raise ValueError(f"max_event_bytes must be at least {MIN_MAX_EVENT_BYTES}")
        if not isinstance(flush, bool):
            raise TypeError("flush must be a boolean")

        self.max_event_bytes = max_event_bytes
        self.flush = flush
        self._sequence = 0
        self._lock = threading.Lock()

    @property
    def last_sequence(self) -> int:
        with self._lock:
            return self._sequence

    def emit(
        self,
        event_type: str,
        run_id: Optional[RunId],
        payload: Optional[Dict[str, Any]] = None,
        candidate_id: Optional[CandidateId] = None,
        path_id: Optional[PathId] = None,
    ) -> AnalysisEvent:
        """Build and write one event, returning the event actually emitted."""

        with self._lock:
            self._sequence += 1
            sequence = self._sequence
            try:
                event = AnalysisEvent(
                    event_type=event_type,
                    sequence=sequence,
                    run_id=run_id,
                    candidate_id=candidate_id,
                    path_id=path_id,
                    payload={} if payload is None else payload,
                )
                line, byte_count = self._serialize(event)
            except Exception as error:
                event = self._failure_event(
                    sequence=sequence,
                    code="EVENT_SERIALIZATION_FAILED",
                    message="The analysis event could not be serialized.",
                    event_type=event_type,
                    run_id=run_id,
                    candidate_id=candidate_id,
                    path_id=path_id,
                    cause_type=type(error).__name__,
                )
                line, byte_count = self._serialize_fallback(event)

            if byte_count > self.max_event_bytes:
                event = self._failure_event(
                    sequence=sequence,
                    code="EVENT_SIZE_LIMIT_EXCEEDED",
                    message="The analysis event exceeded the configured size limit.",
                    event_type=event_type,
                    run_id=run_id,
                    candidate_id=candidate_id,
                    path_id=path_id,
                    details={
                        "actual_bytes": byte_count,
                        "max_event_bytes": self.max_event_bytes,
                    },
                )
                line, _ = self._serialize_fallback(event)

            self._write_line(line)
            return event

    def write_log(self, *parts: Any) -> None:
        """Write an ordinary diagnostic to the non-event stream."""

        message = " ".join(str(part) for part in parts)
        with self._lock:
            try:
                self.log_stream.write(message + "\n")
                if self.flush:
                    self.log_stream.flush()
            except Exception as error:
                raise EventWriteError("Unable to write RepoAudit diagnostic") from error

    def _serialize(self, event: AnalysisEvent) -> Tuple[str, int]:
        line = event.to_json()
        return line, len(line.encode("utf-8"))

    def _serialize_fallback(self, event: AnalysisEvent) -> Tuple[str, int]:
        try:
            line, byte_count = self._serialize(event)
        except Exception as error:
            self._write_internal_diagnostic("fallback serialization failed")
            raise EventWriteError(
                "Unable to serialize fallback analysis event"
            ) from error
        if byte_count > self.max_event_bytes:
            self._write_internal_diagnostic("fallback event exceeded size limit")
            raise EventWriteError("Fallback analysis event exceeded size limit")
        return line, byte_count

    def _write_line(self, line: str) -> None:
        try:
            self.event_stream.write(line + "\n")
            if self.flush:
                self.event_stream.flush()
        except Exception as error:
            self._write_internal_diagnostic("event stream write failed")
            raise EventWriteError("Unable to write analysis event") from error

    def _write_internal_diagnostic(self, message: str) -> None:
        try:
            self.log_stream.write(f"RepoAudit EventWriter: {message}\n")
            if self.flush:
                self.log_stream.flush()
        except Exception:
            pass

    def _failure_event(
        self,
        sequence: int,
        code: str,
        message: str,
        event_type: Any,
        run_id: Optional[RunId],
        candidate_id: Optional[CandidateId],
        path_id: Optional[PathId],
        cause_type: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None,
    ) -> AnalysisEvent:
        safe_run_id = _valid_run_id_or_none(run_id)
        safe_candidate_id = _valid_candidate_id_or_none(
            candidate_id if safe_run_id is not None else None
        )
        safe_path_id = _valid_path_id_or_none(
            path_id if safe_candidate_id is not None else None
        )
        safe_details: Dict[str, Any] = {
            "original_event_type": _safe_event_type_hint(event_type)
        }
        if details:
            safe_details.update(details)
        error = StructuredError(
            code=code,
            message=message,
            stage="event_writer",
            retriable=False,
            details=safe_details,
            run_id=safe_run_id,
            candidate_id=safe_candidate_id,
            path_id=safe_path_id,
            cause_type=cause_type,
        )
        return AnalysisEvent(
            event_type="analysis_failed",
            sequence=sequence,
            run_id=safe_run_id,
            candidate_id=safe_candidate_id,
            path_id=safe_path_id,
            payload={"error": error},
        )


def _valid_run_id_or_none(value: Optional[RunId]) -> Optional[RunId]:
    if value is None:
        return None
    try:
        return validate_run_id(value)
    except (TypeError, ValueError):
        return None


def _valid_candidate_id_or_none(
    value: Optional[CandidateId],
) -> Optional[CandidateId]:
    if value is None:
        return None
    try:
        return validate_candidate_id(value)
    except (TypeError, ValueError):
        return None


def _valid_path_id_or_none(value: Optional[PathId]) -> Optional[PathId]:
    if value is None:
        return None
    try:
        return validate_path_id(value)
    except (TypeError, ValueError):
        return None


def _safe_event_type_hint(value: Any) -> str:
    if isinstance(value, str):
        return value[:64]
    return type(value).__name__[:64]
