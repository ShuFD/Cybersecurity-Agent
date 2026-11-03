"""Stable, JSON-safe data contracts shared by RepoAudit entry points."""

from __future__ import annotations

import hashlib
import json
import math
import re
import uuid
from dataclasses import dataclass, field, fields
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence


SCHEMA_VERSION = "1.0.0"

RunId = str
CandidateId = str
PathId = str

_RUN_ID_PATTERN = re.compile(r"^run_[0-9a-f]{32}$")
_CANDIDATE_ID_PATTERN = re.compile(r"^cand_[0-9a-f]{24}$")
_PATH_ID_PATTERN = re.compile(r"^path_[0-9a-f]{24}$")
_WINDOWS_DRIVE_PATTERN = re.compile(r"^[A-Za-z]:")

RUN_STATUSES = frozenset({"created", "running", "completed", "failed"})
RUN_STAGES = frozenset(
    {"created", "inspect", "candidates", "analyze", "validate", "full_scan"}
)
PAIR_RELATIONS = frozenset({"must_reach", "must_not_reach"})
PATH_STATUSES = frozenset({"complete", "partial"})
VALIDATION_VERDICTS = frozenset({"reachable", "not_reachable", "inconclusive"})


def utc_now() -> str:
    """Return a JSON-friendly UTC timestamp in RFC 3339 form."""

    return (
        datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    )


def new_run_id() -> RunId:
    """Create a unique run identifier that remains stable for the run lifetime."""

    return f"run_{uuid.uuid4().hex}"


def validate_run_id(value: str) -> RunId:
    return _validate_id(value, _RUN_ID_PATTERN, "run_id")


def validate_candidate_id(value: str) -> CandidateId:
    return _validate_id(value, _CANDIDATE_ID_PATTERN, "candidate_id")


def validate_path_id(value: str) -> PathId:
    return _validate_id(value, _PATH_ID_PATTERN, "path_id")


def _validate_id(value: str, pattern: re.Pattern[str], field_name: str) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise ValueError(f"Invalid {field_name}: {value!r}")
    return value


def _require_text(value: str, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} must be a non-empty string")
    return value


def _validate_optional_text(value: Optional[str], field_name: str) -> None:
    if value is not None:
        _require_text(value, field_name)


def _validate_codes(values: Sequence[str], field_name: str) -> None:
    if isinstance(values, (str, bytes)):
        raise TypeError(f"{field_name} must be a sequence of strings")
    for value in values:
        _require_text(value, field_name)


def _require_positive_int(value: int, field_name: str) -> None:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ValueError(f"{field_name} must be a positive integer")


def _require_non_negative_int(value: int, field_name: str) -> None:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"{field_name} must be a non-negative integer")


def _normalise_relative_path(value: str, field_name: str) -> str:
    _require_text(value, field_name)
    candidate = value.replace("\\", "/")
    if (
        candidate.startswith("/")
        or candidate.startswith("//")
        or _WINDOWS_DRIVE_PATTERN.match(candidate)
    ):
        raise ValueError(f"{field_name} must be relative to the repository root")

    parts = [part for part in candidate.split("/") if part not in {"", "."}]
    if not parts or ".." in parts:
        raise ValueError(f"{field_name} must not escape the repository root")
    return "/".join(parts)


def _normalise_paths(values: Sequence[str], field_name: str) -> List[str]:
    if isinstance(values, (str, bytes)):
        raise TypeError(f"{field_name} must be a sequence of relative paths")
    return [_normalise_relative_path(value, field_name) for value in values]


def _location_identity(location: "SourceLocation") -> Dict[str, Any]:
    return {
        "relative_path": location.relative_path,
        "start_line": location.start_line,
        "end_line": location.end_line,
        "start_column": location.start_column,
        "end_column": location.end_column,
    }


def _json_value(value: Any) -> Any:
    if isinstance(value, _JsonSerializable):
        return value.to_dict()
    if isinstance(value, Mapping):
        result: Dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError("JSON object keys must be strings")
            result[key] = _json_value(item)
        return result
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        raise TypeError("Non-finite floats are not valid JSON values")
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise TypeError(f"Unsupported JSON value type: {type(value).__name__}")


def _ensure_json_safe(value: Any) -> None:
    _json_value(value)


class _JsonSerializable:
    """Small serialization surface shared by every public protocol object."""

    def to_dict(self) -> Dict[str, Any]:
        return {
            item.name: _json_value(getattr(self, item.name)) for item in fields(self)
        }

    def to_json(self, *, indent: Optional[int] = None) -> str:
        return json.dumps(
            self.to_dict(),
            ensure_ascii=False,
            indent=indent,
            sort_keys=True,
        )


@dataclass
class SourceLocation(_JsonSerializable):
    """A repository-relative, one-based source span."""

    schema_version: str = field(default=SCHEMA_VERSION, init=False)
    relative_path: str
    start_line: int
    end_line: Optional[int] = None
    start_column: Optional[int] = None
    end_column: Optional[int] = None

    def __post_init__(self) -> None:
        self.relative_path = _normalise_relative_path(
            self.relative_path, "relative_path"
        )
        _require_positive_int(self.start_line, "start_line")
        if self.end_line is not None:
            _require_positive_int(self.end_line, "end_line")
            if self.end_line < self.start_line:
                raise ValueError("end_line must be greater than or equal to start_line")
        if self.start_column is not None:
            _require_positive_int(self.start_column, "start_column")
        if self.end_column is not None:
            _require_positive_int(self.end_column, "end_column")
        if (
            self.start_column is not None
            and self.end_column is not None
            and (self.end_line is None or self.end_line == self.start_line)
            and self.end_column < self.start_column
        ):
            raise ValueError(
                "end_column must not precede start_column on the same line"
            )


@dataclass
class SourceSinkPair(_JsonSerializable):
    """A normalized source/sink relationship used to form a candidate."""

    schema_version: str = field(default=SCHEMA_VERSION, init=False)
    source: SourceLocation
    sink: SourceLocation
    source_symbol: str
    sink_symbol: str
    relation: str

    def __post_init__(self) -> None:
        if not isinstance(self.source, SourceLocation):
            raise TypeError("source must be a SourceLocation")
        if not isinstance(self.sink, SourceLocation):
            raise TypeError("sink must be a SourceLocation")
        _require_text(self.source_symbol, "source_symbol")
        _require_text(self.sink_symbol, "sink_symbol")
        _require_text(self.relation, "relation")
        if self.relation not in PAIR_RELATIONS:
            raise ValueError(f"Unsupported source/sink relation: {self.relation!r}")


@dataclass
class RepositoryProfile(_JsonSerializable):
    """Repository facts collected without running neural analysis."""

    schema_version: str = field(default=SCHEMA_VERSION, init=False)
    run_id: RunId
    repository_root: str
    language: str
    source_files: List[str] = field(default_factory=list)
    file_type_counts: Dict[str, int] = field(default_factory=dict)
    function_count: int = 0
    call_relation_count: int = 0
    ignored_directories: List[str] = field(default_factory=list)
    parse_failed_files: List[str] = field(default_factory=list)
    supported_bug_types: List[str] = field(default_factory=list)
    inspected_at: str = field(default_factory=utc_now)

    def __post_init__(self) -> None:
        validate_run_id(self.run_id)
        _require_text(self.repository_root, "repository_root")
        _require_text(self.language, "language")
        self.source_files = _normalise_paths(self.source_files, "source_files")
        self.ignored_directories = _normalise_paths(
            self.ignored_directories, "ignored_directories"
        )
        self.parse_failed_files = _normalise_paths(
            self.parse_failed_files, "parse_failed_files"
        )
        if not isinstance(self.file_type_counts, dict):
            raise TypeError("file_type_counts must be a dictionary")
        for suffix, count in self.file_type_counts.items():
            _require_text(suffix, "file_type_counts key")
            _require_non_negative_int(count, "file_type_counts value")
        _require_non_negative_int(self.function_count, "function_count")
        _require_non_negative_int(self.call_relation_count, "call_relation_count")
        _validate_codes(self.supported_bug_types, "supported_bug_types")
        _require_text(self.inspected_at, "inspected_at")


@dataclass
class AuditRun(_JsonSerializable):
    """Lifecycle record for one staged or full RepoAudit execution."""

    schema_version: str = field(default=SCHEMA_VERSION, init=False)
    run_id: RunId
    repository_root: str
    language: str
    bug_type: Optional[str] = None
    stage: str = "created"
    status: str = "created"
    created_at: str = field(default_factory=utc_now)
    updated_at: str = field(default_factory=utc_now)
    completed_at: Optional[str] = None
    error_ids: List[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        validate_run_id(self.run_id)
        _require_text(self.repository_root, "repository_root")
        _require_text(self.language, "language")
        _validate_optional_text(self.bug_type, "bug_type")
        _require_text(self.stage, "stage")
        _require_text(self.status, "status")
        if self.stage not in RUN_STAGES:
            raise ValueError(f"Unsupported run stage: {self.stage!r}")
        if self.status not in RUN_STATUSES:
            raise ValueError(f"Unsupported run status: {self.status!r}")
        _require_text(self.created_at, "created_at")
        _require_text(self.updated_at, "updated_at")
        _validate_optional_text(self.completed_at, "completed_at")
        _validate_codes(self.error_ids, "error_ids")


@dataclass
class AuditCandidate(_JsonSerializable):
    """A source/sink candidate that can be analyzed independently."""

    schema_version: str = field(default=SCHEMA_VERSION, init=False)
    run_id: RunId
    candidate_id: CandidateId
    bug_type: str
    source_sink_pair: SourceSinkPair
    source_function: Optional[str] = None
    sink_function: Optional[str] = None
    reason_codes: List[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        validate_run_id(self.run_id)
        validate_candidate_id(self.candidate_id)
        _require_text(self.bug_type, "bug_type")
        if not isinstance(self.source_sink_pair, SourceSinkPair):
            raise TypeError("source_sink_pair must be a SourceSinkPair")
        _validate_optional_text(self.source_function, "source_function")
        _validate_optional_text(self.sink_function, "sink_function")
        _validate_codes(self.reason_codes, "reason_codes")


@dataclass
class DataFlowStep(_JsonSerializable):
    """One normalized step in a data-flow path."""

    schema_version: str = field(default=SCHEMA_VERSION, init=False)
    step_index: int
    kind: str
    location: SourceLocation
    function_name: Optional[str] = None
    value: Optional[str] = None
    description: Optional[str] = None

    def __post_init__(self) -> None:
        _require_positive_int(self.step_index, "step_index")
        _require_text(self.kind, "kind")
        if not isinstance(self.location, SourceLocation):
            raise TypeError("location must be a SourceLocation")
        _validate_optional_text(self.function_name, "function_name")
        _validate_optional_text(self.value, "value")
        _validate_optional_text(self.description, "description")


@dataclass
class DataFlowPath(_JsonSerializable):
    """A candidate-scoped path produced by the analysis stage."""

    schema_version: str = field(default=SCHEMA_VERSION, init=False)
    run_id: RunId
    candidate_id: CandidateId
    path_id: PathId
    steps: List[DataFlowStep]
    status: str = "complete"
    interprocedural: bool = False
    reason_codes: List[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        validate_run_id(self.run_id)
        validate_candidate_id(self.candidate_id)
        validate_path_id(self.path_id)
        if not isinstance(self.steps, list) or not self.steps:
            raise ValueError("steps must contain at least one DataFlowStep")
        if not all(isinstance(step, DataFlowStep) for step in self.steps):
            raise TypeError("steps must contain only DataFlowStep objects")
        expected_indexes = list(range(1, len(self.steps) + 1))
        actual_indexes = [step.step_index for step in self.steps]
        if actual_indexes != expected_indexes:
            raise ValueError("step_index values must be contiguous and start at 1")
        _require_text(self.status, "status")
        if self.status not in PATH_STATUSES:
            raise ValueError(f"Unsupported path status: {self.status!r}")
        if not isinstance(self.interprocedural, bool):
            raise TypeError("interprocedural must be a boolean")
        _validate_codes(self.reason_codes, "reason_codes")


@dataclass
class ValidationResult(_JsonSerializable):
    """Public result of validating exactly one data-flow path."""

    schema_version: str = field(default=SCHEMA_VERSION, init=False)
    run_id: RunId
    candidate_id: CandidateId
    path_id: PathId
    verdict: str
    summary: str
    reason_codes: List[str] = field(default_factory=list)
    evidence: List[str] = field(default_factory=list)
    retry_count: int = 0
    validator: Optional[str] = None
    validated_at: str = field(default_factory=utc_now)

    def __post_init__(self) -> None:
        validate_run_id(self.run_id)
        validate_candidate_id(self.candidate_id)
        validate_path_id(self.path_id)
        _require_text(self.verdict, "verdict")
        if self.verdict not in VALIDATION_VERDICTS:
            raise ValueError(f"Unsupported validation verdict: {self.verdict!r}")
        _require_text(self.summary, "summary")
        _validate_codes(self.reason_codes, "reason_codes")
        _validate_codes(self.evidence, "evidence")
        _require_non_negative_int(self.retry_count, "retry_count")
        _validate_optional_text(self.validator, "validator")
        _require_text(self.validated_at, "validated_at")


def make_candidate_id(
    run_id: RunId,
    bug_type: str,
    source_sink_pair: SourceSinkPair,
    source_function: Optional[str] = None,
    sink_function: Optional[str] = None,
) -> CandidateId:
    """Derive a deterministic, run-scoped candidate identifier."""

    validate_run_id(run_id)
    _require_text(bug_type, "bug_type")
    if not isinstance(source_sink_pair, SourceSinkPair):
        raise TypeError("source_sink_pair must be a SourceSinkPair")
    _validate_optional_text(source_function, "source_function")
    _validate_optional_text(sink_function, "sink_function")
    payload = {
        "run_id": run_id,
        "bug_type": bug_type,
        "source": _location_identity(source_sink_pair.source),
        "sink": _location_identity(source_sink_pair.sink),
        "source_symbol": source_sink_pair.source_symbol,
        "sink_symbol": source_sink_pair.sink_symbol,
        "relation": source_sink_pair.relation,
        "source_function": source_function,
        "sink_function": sink_function,
    }
    return _stable_id("cand", payload)


def make_path_id(
    run_id: RunId,
    candidate_id: CandidateId,
    steps: Sequence[DataFlowStep],
) -> PathId:
    """Derive a deterministic path identifier from structural step facts."""

    validate_run_id(run_id)
    validate_candidate_id(candidate_id)
    if not steps or not all(isinstance(step, DataFlowStep) for step in steps):
        raise ValueError("steps must contain at least one DataFlowStep")
    payload = {
        "run_id": run_id,
        "candidate_id": candidate_id,
        "steps": [
            {
                "step_index": step.step_index,
                "kind": step.kind,
                "location": _location_identity(step.location),
                "function_name": step.function_name,
                "value": step.value,
            }
            for step in steps
        ],
    }
    return _stable_id("path", payload)


def _stable_id(prefix: str, payload: Mapping[str, Any]) -> str:
    serialized = json.dumps(
        _json_value(payload),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    digest = hashlib.sha256(serialized).hexdigest()[:24]
    return f"{prefix}_{digest}"
