"""Structured analysis events exposed by the staged RepoAudit engine."""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from .errors import StructuredError
from .models import (
    SCHEMA_VERSION,
    AuditCandidate,
    AuditRun,
    CandidateId,
    DataFlowStep,
    PathId,
    RepositoryProfile,
    RunId,
    SourceLocation,
    SourceSinkPair,
    ValidationResult,
    _JsonSerializable,
    _ensure_json_safe,
    _require_non_negative_int,
    _require_positive_int,
    _require_text,
    _validate_codes,
    utc_now,
    validate_candidate_id,
    validate_path_id,
    validate_run_id,
)


EventId = str

EVENT_TYPES = frozenset(
    {
        "run_started",
        "repository_inspected",
        "candidate_extracted",
        "candidate_analysis_started",
        "function_selected",
        "source_sink_matched",
        "dataflow_step_found",
        "path_validation_started",
        "path_validated",
        "candidate_rejected",
        "analysis_failed",
        "run_completed",
    }
)

EVENTS_REQUIRING_CANDIDATE = frozenset(
    {
        "candidate_extracted",
        "candidate_analysis_started",
        "function_selected",
        "source_sink_matched",
        "dataflow_step_found",
        "path_validation_started",
        "path_validated",
        "candidate_rejected",
    }
)

EVENTS_REQUIRING_PATH = frozenset({"path_validation_started", "path_validated"})

EVENT_REQUIRED_PAYLOAD_KEYS = {
    "run_started": frozenset({"run"}),
    "repository_inspected": frozenset({"repository"}),
    "candidate_extracted": frozenset({"candidate"}),
    "candidate_analysis_started": frozenset(),
    "function_selected": frozenset({"function_name", "location"}),
    "source_sink_matched": frozenset({"source_sink_pair"}),
    "dataflow_step_found": frozenset({"step"}),
    "path_validation_started": frozenset(),
    "path_validated": frozenset({"validation"}),
    "candidate_rejected": frozenset({"reason_codes"}),
    "analysis_failed": frozenset({"error"}),
    "run_completed": frozenset({"status", "finding_count", "error_count"}),
}

RUN_COMPLETION_STATUSES = frozenset(
    {"success_with_findings", "success_no_findings", "failed"}
)

_EVENT_ID_PATTERN = re.compile(r"^evt_[0-9a-f]{32}$")


def new_event_id() -> EventId:
    return f"evt_{uuid.uuid4().hex}"


def validate_event_id(value: str) -> EventId:
    if not isinstance(value, str) or _EVENT_ID_PATTERN.fullmatch(value) is None:
        raise ValueError(f"Invalid event_id: {value!r}")
    return value


@dataclass
class AnalysisEvent(_JsonSerializable):
    """One independently parseable event in the analysis JSONL stream."""

    schema_version: str = field(default=SCHEMA_VERSION, init=False)
    event_type: str
    sequence: int
    run_id: Optional[RunId]
    event_id: EventId = field(default_factory=new_event_id)
    emitted_at: str = field(default_factory=utc_now)
    candidate_id: Optional[CandidateId] = None
    path_id: Optional[PathId] = None
    payload: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        validate_event_id(self.event_id)
        _require_text(self.event_type, "event_type")
        if self.event_type not in EVENT_TYPES:
            raise ValueError(f"Unsupported event_type: {self.event_type!r}")
        _require_positive_int(self.sequence, "sequence")
        _require_text(self.emitted_at, "emitted_at")

        if self.run_id is not None:
            validate_run_id(self.run_id)
        elif self.event_type != "analysis_failed":
            raise ValueError("run_id may be null only for analysis_failed")

        if self.candidate_id is not None:
            if self.run_id is None:
                raise ValueError("candidate_id requires run_id")
            validate_candidate_id(self.candidate_id)
        elif self.event_type in EVENTS_REQUIRING_CANDIDATE:
            raise ValueError(f"{self.event_type} requires candidate_id")

        if self.path_id is not None:
            if self.candidate_id is None:
                raise ValueError("path_id requires candidate_id")
            validate_path_id(self.path_id)
        elif self.event_type in EVENTS_REQUIRING_PATH:
            raise ValueError(f"{self.event_type} requires path_id")

        if not isinstance(self.payload, dict):
            raise TypeError("payload must be a dictionary")
        _ensure_json_safe(self.payload)
        missing_keys = (
            EVENT_REQUIRED_PAYLOAD_KEYS[self.event_type] - self.payload.keys()
        )
        if missing_keys:
            missing = ", ".join(sorted(missing_keys))
            raise ValueError(f"{self.event_type} payload is missing: {missing}")
        self._validate_payload_types()

    def _validate_payload_types(self) -> None:
        expected_objects = {
            "run_started": ("run", AuditRun),
            "repository_inspected": ("repository", RepositoryProfile),
            "candidate_extracted": ("candidate", AuditCandidate),
            "source_sink_matched": ("source_sink_pair", SourceSinkPair),
            "dataflow_step_found": ("step", DataFlowStep),
            "path_validated": ("validation", ValidationResult),
            "analysis_failed": ("error", StructuredError),
        }
        expected = expected_objects.get(self.event_type)
        if expected is not None:
            key, expected_type = expected
            if not isinstance(self.payload[key], expected_type):
                raise TypeError(
                    f"{self.event_type} payload.{key} must be "
                    f"{expected_type.__name__}"
                )

        if self.event_type == "function_selected":
            _require_text(self.payload["function_name"], "payload.function_name")
            if not isinstance(self.payload["location"], SourceLocation):
                raise TypeError(
                    "function_selected payload.location must be SourceLocation"
                )
        elif self.event_type == "candidate_rejected":
            _validate_codes(self.payload["reason_codes"], "payload.reason_codes")
        elif self.event_type == "run_completed":
            status = self.payload["status"]
            _require_text(status, "payload.status")
            if status not in RUN_COMPLETION_STATUSES:
                raise ValueError(f"Unsupported run completion status: {status!r}")
            _require_non_negative_int(
                self.payload["finding_count"], "payload.finding_count"
            )
            _require_non_negative_int(
                self.payload["error_count"], "payload.error_count"
            )
