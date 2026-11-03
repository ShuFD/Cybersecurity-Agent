"""Structured, JSON-safe errors for staged RepoAudit operations."""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from .models import (
    SCHEMA_VERSION,
    CandidateId,
    PathId,
    RunId,
    _JsonSerializable,
    _ensure_json_safe,
    _require_text,
    _validate_optional_text,
    validate_candidate_id,
    validate_path_id,
    validate_run_id,
)


ErrorId = str

_ERROR_ID_PATTERN = re.compile(r"^err_[0-9a-f]{32}$")


def new_error_id() -> ErrorId:
    return f"err_{uuid.uuid4().hex}"


def validate_error_id(value: str) -> ErrorId:
    if not isinstance(value, str) or _ERROR_ID_PATTERN.fullmatch(value) is None:
        raise ValueError(f"Invalid error_id: {value!r}")
    return value


@dataclass
class StructuredError(_JsonSerializable):
    """A safe public error record without traceback, prompt, or secret fields."""

    schema_version: str = field(default=SCHEMA_VERSION, init=False)
    code: str
    message: str
    stage: str
    error_id: ErrorId = field(default_factory=new_error_id)
    retriable: bool = False
    details: Dict[str, Any] = field(default_factory=dict)
    run_id: Optional[RunId] = None
    candidate_id: Optional[CandidateId] = None
    path_id: Optional[PathId] = None
    cause_type: Optional[str] = None

    def __post_init__(self) -> None:
        validate_error_id(self.error_id)
        _require_text(self.code, "code")
        _require_text(self.message, "message")
        _require_text(self.stage, "stage")
        if not isinstance(self.retriable, bool):
            raise TypeError("retriable must be a boolean")
        if not isinstance(self.details, dict):
            raise TypeError("details must be a dictionary")
        _ensure_json_safe(self.details)
        if self.run_id is not None:
            validate_run_id(self.run_id)
        if self.candidate_id is not None:
            validate_candidate_id(self.candidate_id)
        if self.path_id is not None:
            validate_path_id(self.path_id)
        _validate_optional_text(self.cause_type, "cause_type")
