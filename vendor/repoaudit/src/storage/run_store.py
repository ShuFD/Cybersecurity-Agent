"""Atomic, run-scoped persistence for staged RepoAudit results."""

from __future__ import annotations

import json
import os
import shutil
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, TypeVar

from protocol import (
    SCHEMA_VERSION,
    AnalysisEvent,
    AuditCandidate,
    AuditRun,
    DataFlowPath,
    DataFlowStep,
    RepositoryProfile,
    SourceLocation,
    SourceSinkPair,
    StructuredError,
    ValidationResult,
    validate_run_id,
)


DEFAULT_RUNS_ROOT = Path(__file__).resolve().parents[2] / "runs"

RUN_FILE = "run.json"
REPOSITORY_FILE = "repository.json"
CANDIDATES_FILE = "candidates.json"
PATHS_FILE = "paths.json"
VALIDATIONS_FILE = "validations.json"
EVENTS_FILE = "events.jsonl"
ERRORS_FILE = "errors.json"

_T = TypeVar("_T")


class RunStoreError(RuntimeError):
    """Raised with a safe public error when durable state cannot be used."""

    def __init__(self, error: StructuredError) -> None:
        super().__init__(error.message)
        self.error = error


class _StoredDataError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class RunSnapshot:
    """All durable public objects belonging to one completed run directory."""

    run: AuditRun
    repository: RepositoryProfile
    candidates: List[AuditCandidate]
    paths: List[DataFlowPath]
    validations: List[ValidationResult]
    events: List[AnalysisEvent]
    errors: List[StructuredError]


class RunStore:
    """Save and load staged results without allowing runs to overlap."""

    def __init__(self, root: Optional[Path] = None) -> None:
        configured_root = os.environ.get("REPOAUDIT_RUNS_ROOT")
        selected = (
            Path(configured_root)
            if root is None and configured_root
            else DEFAULT_RUNS_ROOT if root is None else Path(root)
        )
        self.root = selected.expanduser().resolve()
        self._lock = threading.RLock()

    def create_run(self, run: AuditRun) -> Path:
        """Publish a new run directory containing all seven contract files."""

        if not isinstance(run, AuditRun):
            raise TypeError("run must be an AuditRun")
        run_id = validate_run_id(run.run_id)
        with self._lock:
            try:
                self.root.mkdir(parents=True, exist_ok=True)
            except OSError as error:
                self._raise_error(
                    "RUN_STORE_ROOT_CREATE_FAILED",
                    "The runs root directory could not be created.",
                    run_id=run_id,
                    cause_type=type(error).__name__,
                )

            run_directory = self._run_directory(run_id)
            if run_directory.exists():
                self._raise_error(
                    "RUN_STORE_RUN_EXISTS",
                    "The requested run directory already exists.",
                    run_id=run_id,
                )

            staging = self.root / f".{run_id}.{uuid.uuid4().hex}.tmp"
            try:
                staging.mkdir(parents=False, exist_ok=False)
                self._atomic_write_json(staging / RUN_FILE, run.to_dict())
                self._atomic_write_json(
                    staging / REPOSITORY_FILE,
                    self._envelope(run_id, "repository", None),
                )
                self._atomic_write_json(
                    staging / CANDIDATES_FILE,
                    self._envelope(run_id, "candidates", []),
                )
                self._atomic_write_json(
                    staging / PATHS_FILE,
                    self._envelope(run_id, "paths", []),
                )
                self._atomic_write_json(
                    staging / VALIDATIONS_FILE,
                    self._envelope(run_id, "validations", []),
                )
                self._atomic_write_text(staging / EVENTS_FILE, "")
                self._atomic_write_json(
                    staging / ERRORS_FILE,
                    self._envelope(run_id, "errors", []),
                )
                staging.rename(run_directory)
            except FileExistsError as error:
                self._raise_error(
                    "RUN_STORE_RUN_EXISTS",
                    "The requested run directory already exists.",
                    run_id=run_id,
                    cause_type=type(error).__name__,
                )
            except RunStoreError:
                raise
            except (OSError, TypeError, ValueError) as error:
                self._raise_error(
                    "RUN_STORE_CREATE_FAILED",
                    "The run directory could not be initialized.",
                    run_id=run_id,
                    cause_type=type(error).__name__,
                )
            finally:
                if staging.exists():
                    shutil.rmtree(staging, ignore_errors=True)
            return run_directory

    def save_run(self, run: AuditRun) -> None:
        if not isinstance(run, AuditRun):
            raise TypeError("run must be an AuditRun")
        self._write_run_json(run.run_id, RUN_FILE, run.to_dict())

    def save_repository(self, repository: RepositoryProfile) -> None:
        if not isinstance(repository, RepositoryProfile):
            raise TypeError("repository must be a RepositoryProfile")
        self._write_run_json(
            repository.run_id,
            REPOSITORY_FILE,
            self._envelope(
                repository.run_id,
                "repository",
                repository.to_dict(),
            ),
        )

    def save_candidates(
        self,
        run_id: str,
        candidates: Sequence[AuditCandidate],
    ) -> None:
        values = self._validate_run_objects(run_id, candidates, AuditCandidate)
        self._reject_duplicate_ids(values, "candidate_id", run_id)
        ordered = sorted(values, key=lambda item: item.candidate_id)
        self._write_collection(run_id, CANDIDATES_FILE, "candidates", ordered)

    def save_paths(self, run_id: str, paths: Sequence[DataFlowPath]) -> None:
        values = self._validate_run_objects(run_id, paths, DataFlowPath)
        self._reject_duplicate_ids(values, "path_id", run_id)
        ordered = sorted(values, key=lambda item: item.path_id)
        self._write_collection(run_id, PATHS_FILE, "paths", ordered)

    def save_validations(
        self,
        run_id: str,
        validations: Sequence[ValidationResult],
    ) -> None:
        values = self._validate_run_objects(run_id, validations, ValidationResult)
        self._reject_duplicate_ids(values, "path_id", run_id)
        ordered = sorted(values, key=lambda item: item.path_id)
        self._write_collection(
            run_id,
            VALIDATIONS_FILE,
            "validations",
            ordered,
        )

    def save_errors(
        self,
        run_id: str,
        errors: Sequence[StructuredError],
    ) -> None:
        checked_run_id = validate_run_id(run_id)
        values = list(errors)
        if not all(isinstance(error, StructuredError) for error in values):
            raise TypeError("errors must contain only StructuredError objects")
        for error in values:
            if error.run_id != checked_run_id:
                raise ValueError("stored error run_id does not match target run")
        self._reject_duplicate_ids(values, "error_id", checked_run_id)
        ordered = sorted(values, key=lambda item: item.error_id)
        self._write_collection(checked_run_id, ERRORS_FILE, "errors", ordered)

    def save_events(
        self,
        run_id: str,
        events: Sequence[AnalysisEvent],
    ) -> None:
        checked_run_id = validate_run_id(run_id)
        values = list(events)
        self._validate_events(checked_run_id, values)
        text = "".join(event.to_json() + "\n" for event in values)
        with self._lock:
            path = self._require_run_file(checked_run_id, EVENTS_FILE)
            try:
                self._atomic_write_text(path, text)
            except OSError as error:
                self._raise_error(
                    "RUN_STORE_WRITE_FAILED",
                    "The event stream could not be saved.",
                    run_id=checked_run_id,
                    file_name=EVENTS_FILE,
                    cause_type=type(error).__name__,
                )

    def append_event(self, event: AnalysisEvent) -> None:
        if not isinstance(event, AnalysisEvent):
            raise TypeError("event must be an AnalysisEvent")
        if event.run_id is None:
            raise ValueError("run-scoped events must contain run_id")
        run_id = validate_run_id(event.run_id)
        line = event.to_json()
        if "\n" in line or "\r" in line:
            raise ValueError("event serialization must contain exactly one JSON line")

        with self._lock:
            existing = self.load_events(run_id)
            expected = 1 if not existing else existing[-1].sequence + 1
            if event.sequence != expected:
                self._raise_error(
                    "RUN_STORE_EVENT_SEQUENCE_INVALID",
                    "The event sequence is not contiguous for this run.",
                    run_id=run_id,
                    file_name=EVENTS_FILE,
                    details={"expected_sequence": expected},
                )
            path = self._require_run_file(run_id, EVENTS_FILE)
            try:
                with path.open("a", encoding="utf-8", newline="\n") as stream:
                    stream.write(line + "\n")
                    stream.flush()
                    os.fsync(stream.fileno())
            except OSError as error:
                self._raise_error(
                    "RUN_STORE_WRITE_FAILED",
                    "The event could not be appended.",
                    run_id=run_id,
                    file_name=EVENTS_FILE,
                    cause_type=type(error).__name__,
                )

    def load_run(self, run_id: str) -> AuditRun:
        return self._load_object(run_id, RUN_FILE, _decode_run)

    def load_repository(self, run_id: str) -> RepositoryProfile:
        data = self._read_json(run_id, REPOSITORY_FILE)
        payload = self._decode_envelope(run_id, data, "repository", REPOSITORY_FILE)
        if payload is None:
            self._raise_error(
                "RUN_STORE_STAGE_NOT_AVAILABLE",
                "Repository inspection has not been saved for this run.",
                run_id=run_id,
                file_name=REPOSITORY_FILE,
            )
        return self._decode_value(run_id, REPOSITORY_FILE, payload, _decode_repository)

    def load_candidates(self, run_id: str) -> List[AuditCandidate]:
        return self._load_collection(
            run_id,
            CANDIDATES_FILE,
            "candidates",
            _decode_candidate,
        )

    def load_paths(self, run_id: str) -> List[DataFlowPath]:
        return self._load_collection(run_id, PATHS_FILE, "paths", _decode_path)

    def load_validations(self, run_id: str) -> List[ValidationResult]:
        return self._load_collection(
            run_id,
            VALIDATIONS_FILE,
            "validations",
            _decode_validation,
        )

    def load_errors(self, run_id: str) -> List[StructuredError]:
        return self._load_collection(
            run_id,
            ERRORS_FILE,
            "errors",
            _decode_error,
        )

    def load_events(self, run_id: str) -> List[AnalysisEvent]:
        checked_run_id = validate_run_id(run_id)
        with self._lock:
            path = self._require_run_file(checked_run_id, EVENTS_FILE)
            try:
                lines = path.read_text(encoding="utf-8").splitlines()
            except OSError as error:
                self._raise_error(
                    "RUN_STORE_READ_FAILED",
                    "The event stream could not be read.",
                    run_id=checked_run_id,
                    file_name=EVENTS_FILE,
                    cause_type=type(error).__name__,
                )

            events: List[AnalysisEvent] = []
            for line_number, line in enumerate(lines, start=1):
                if not line.strip():
                    self._raise_error(
                        "RUN_STORE_JSONL_INVALID",
                        "The event stream contains an empty JSONL record.",
                        run_id=checked_run_id,
                        file_name=EVENTS_FILE,
                        details={"line_number": line_number},
                    )
                try:
                    data = json.loads(line)
                    event = _decode_event(data)
                except _StoredDataError as error:
                    self._raise_error(
                        error.code,
                        str(error),
                        run_id=checked_run_id,
                        file_name=EVENTS_FILE,
                        details={"line_number": line_number},
                    )
                except (json.JSONDecodeError, TypeError, ValueError) as error:
                    self._raise_error(
                        "RUN_STORE_JSONL_INVALID",
                        "The event stream contains an invalid JSONL record.",
                        run_id=checked_run_id,
                        file_name=EVENTS_FILE,
                        details={"line_number": line_number},
                        cause_type=type(error).__name__,
                    )
                if event.run_id != checked_run_id:
                    self._raise_error(
                        "RUN_STORE_RUN_ID_MISMATCH",
                        "An event belongs to another run.",
                        run_id=checked_run_id,
                        file_name=EVENTS_FILE,
                        details={"line_number": line_number},
                    )
                events.append(event)
            self._validate_event_sequence(checked_run_id, events)
            return events

    def load_snapshot(self, run_id: str) -> RunSnapshot:
        checked_run_id = validate_run_id(run_id)
        with self._lock:
            snapshot = RunSnapshot(
                run=self.load_run(checked_run_id),
                repository=self.load_repository(checked_run_id),
                candidates=self.load_candidates(checked_run_id),
                paths=self.load_paths(checked_run_id),
                validations=self.load_validations(checked_run_id),
                events=self.load_events(checked_run_id),
                errors=self.load_errors(checked_run_id),
            )
            self._validate_snapshot_references(checked_run_id, snapshot)
            return snapshot

    def _write_collection(
        self,
        run_id: str,
        file_name: str,
        key: str,
        values: Sequence[Any],
    ) -> None:
        payload = self._envelope(
            run_id,
            key,
            [value.to_dict() for value in values],
        )
        self._write_run_json(run_id, file_name, payload)

    def _write_run_json(
        self,
        run_id: str,
        file_name: str,
        payload: Mapping[str, Any],
    ) -> None:
        checked_run_id = validate_run_id(run_id)
        with self._lock:
            path = self._require_run_file(checked_run_id, file_name)
            try:
                self._atomic_write_json(path, payload)
            except (OSError, TypeError, ValueError) as error:
                self._raise_error(
                    "RUN_STORE_WRITE_FAILED",
                    "The run state file could not be saved.",
                    run_id=checked_run_id,
                    file_name=file_name,
                    cause_type=type(error).__name__,
                )

    def _load_object(
        self,
        run_id: str,
        file_name: str,
        decoder: Callable[[Any], _T],
    ) -> _T:
        data = self._read_json(run_id, file_name)
        return self._decode_value(run_id, file_name, data, decoder)

    def _load_collection(
        self,
        run_id: str,
        file_name: str,
        key: str,
        decoder: Callable[[Any], _T],
    ) -> List[_T]:
        data = self._read_json(run_id, file_name)
        payload = self._decode_envelope(run_id, data, key, file_name)
        if not isinstance(payload, list):
            self._raise_error(
                "RUN_STORE_DATA_INVALID",
                "The stored collection is not a JSON array.",
                run_id=run_id,
                file_name=file_name,
            )
        values = [
            self._decode_value(run_id, file_name, item, decoder) for item in payload
        ]
        for value in values:
            stored_run_id = getattr(value, "run_id", run_id)
            if stored_run_id != run_id:
                self._raise_error(
                    "RUN_STORE_RUN_ID_MISMATCH",
                    "A stored object belongs to another run.",
                    run_id=run_id,
                    file_name=file_name,
                )
        id_fields = {
            "candidates": "candidate_id",
            "paths": "path_id",
            "validations": "path_id",
            "errors": "error_id",
        }
        self._reject_duplicate_ids(
            values,
            id_fields[key],
            run_id,
            file_name=file_name,
        )
        return values

    def _read_json(self, run_id: str, file_name: str) -> Any:
        checked_run_id = validate_run_id(run_id)
        with self._lock:
            path = self._require_run_file(checked_run_id, file_name)
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as error:
                self._raise_error(
                    "RUN_STORE_JSON_INVALID",
                    "The run state file does not contain valid JSON.",
                    run_id=checked_run_id,
                    file_name=file_name,
                    cause_type=type(error).__name__,
                )
            except OSError as error:
                self._raise_error(
                    "RUN_STORE_READ_FAILED",
                    "The run state file could not be read.",
                    run_id=checked_run_id,
                    file_name=file_name,
                    cause_type=type(error).__name__,
                )

    def _decode_envelope(
        self,
        run_id: str,
        data: Any,
        key: str,
        file_name: str,
    ) -> Any:
        try:
            obj = _require_object(data)
            _require_schema(obj)
            stored_run_id = validate_run_id(obj.get("run_id"))
            if stored_run_id != run_id:
                raise _StoredDataError(
                    "RUN_STORE_RUN_ID_MISMATCH",
                    "Stored envelope belongs to another run.",
                )
            if key not in obj:
                raise _StoredDataError(
                    "RUN_STORE_DATA_INVALID",
                    f"Stored envelope is missing {key!r}.",
                )
            return obj[key]
        except _StoredDataError as error:
            self._raise_error(
                error.code,
                str(error),
                run_id=run_id,
                file_name=file_name,
            )
        except (TypeError, ValueError) as error:
            self._raise_error(
                "RUN_STORE_DATA_INVALID",
                "The stored envelope is invalid.",
                run_id=run_id,
                file_name=file_name,
                cause_type=type(error).__name__,
            )

    def _decode_value(
        self,
        run_id: str,
        file_name: str,
        data: Any,
        decoder: Callable[[Any], _T],
    ) -> _T:
        try:
            value = decoder(data)
        except _StoredDataError as error:
            self._raise_error(
                error.code,
                str(error),
                run_id=run_id,
                file_name=file_name,
            )
        except (TypeError, ValueError) as error:
            self._raise_error(
                "RUN_STORE_DATA_INVALID",
                "The stored public object is invalid.",
                run_id=run_id,
                file_name=file_name,
                cause_type=type(error).__name__,
            )
        stored_run_id = getattr(value, "run_id", run_id)
        if stored_run_id != run_id:
            self._raise_error(
                "RUN_STORE_RUN_ID_MISMATCH",
                "The stored public object belongs to another run.",
                run_id=run_id,
                file_name=file_name,
            )
        return value

    def _require_run_file(self, run_id: str, file_name: str) -> Path:
        run_directory = self._run_directory(run_id)
        if not run_directory.is_dir():
            self._raise_error(
                "RUN_STORE_RUN_NOT_FOUND",
                "The requested run directory does not exist.",
                run_id=run_id,
            )
        if run_directory.is_symlink():
            self._raise_error(
                "RUN_STORE_PATH_UNSAFE",
                "The run directory must not be a symbolic link.",
                run_id=run_id,
            )
        try:
            run_directory.resolve(strict=True).relative_to(self.root)
        except (OSError, ValueError) as error:
            self._raise_error(
                "RUN_STORE_PATH_UNSAFE",
                "The run directory resolves outside the runs root.",
                run_id=run_id,
                cause_type=type(error).__name__,
            )
        path = run_directory / file_name
        if not path.is_file():
            self._raise_error(
                "RUN_STORE_FILE_NOT_FOUND",
                "A required run state file is missing.",
                run_id=run_id,
                file_name=file_name,
            )
        if path.is_symlink():
            self._raise_error(
                "RUN_STORE_PATH_UNSAFE",
                "Run state files must not be symbolic links.",
                run_id=run_id,
                file_name=file_name,
            )
        return path

    def _run_directory(self, run_id: str) -> Path:
        return self.root / validate_run_id(run_id)

    def _validate_run_objects(
        self,
        run_id: str,
        values: Sequence[_T],
        expected_type: type,
    ) -> List[_T]:
        checked_run_id = validate_run_id(run_id)
        if isinstance(values, (str, bytes)):
            raise TypeError("stored objects must be a sequence")
        result = list(values)
        if not all(isinstance(value, expected_type) for value in result):
            raise TypeError(
                f"stored objects must contain only {expected_type.__name__} objects"
            )
        for value in result:
            if getattr(value, "run_id") != checked_run_id:
                raise ValueError("stored object run_id does not match target run")
        return result

    def _reject_duplicate_ids(
        self,
        values: Sequence[Any],
        field_name: str,
        run_id: str,
        *,
        file_name: Optional[str] = None,
    ) -> None:
        identifiers = [getattr(value, field_name) for value in values]
        if len(identifiers) != len(set(identifiers)):
            self._raise_error(
                "RUN_STORE_DUPLICATE_ID",
                "The stored collection contains duplicate identifiers.",
                run_id=run_id,
                file_name=file_name,
                details={"id_field": field_name},
            )

    def _validate_snapshot_references(
        self,
        run_id: str,
        snapshot: RunSnapshot,
    ) -> None:
        candidate_ids = {candidate.candidate_id for candidate in snapshot.candidates}
        path_references = {(path.candidate_id, path.path_id) for path in snapshot.paths}
        if any(path.candidate_id not in candidate_ids for path in snapshot.paths):
            self._raise_error(
                "RUN_STORE_REFERENCE_INVALID",
                "A stored path references an unknown candidate.",
                run_id=run_id,
                file_name=PATHS_FILE,
            )
        if any(
            (validation.candidate_id, validation.path_id) not in path_references
            for validation in snapshot.validations
        ):
            self._raise_error(
                "RUN_STORE_REFERENCE_INVALID",
                "A stored validation references an unknown path.",
                run_id=run_id,
                file_name=VALIDATIONS_FILE,
            )

    def _validate_events(
        self,
        run_id: str,
        events: Sequence[AnalysisEvent],
    ) -> None:
        if not all(isinstance(event, AnalysisEvent) for event in events):
            raise TypeError("events must contain only AnalysisEvent objects")
        for event in events:
            if event.run_id != run_id:
                raise ValueError("stored event run_id does not match target run")
        self._validate_event_sequence(run_id, events)

    def _validate_event_sequence(
        self,
        run_id: str,
        events: Sequence[AnalysisEvent],
    ) -> None:
        actual = [event.sequence for event in events]
        expected = list(range(1, len(events) + 1))
        if actual != expected:
            self._raise_error(
                "RUN_STORE_EVENT_SEQUENCE_INVALID",
                "Stored event sequences must be contiguous and start at 1.",
                run_id=run_id,
                file_name=EVENTS_FILE,
            )

    def _envelope(self, run_id: str, key: str, value: Any) -> Dict[str, Any]:
        return {
            "schema_version": SCHEMA_VERSION,
            "run_id": validate_run_id(run_id),
            key: value,
        }

    def _atomic_write_json(self, path: Path, payload: Mapping[str, Any]) -> None:
        text = json.dumps(
            payload,
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
            allow_nan=False,
        )
        self._atomic_write_text(path, text + "\n")

    def _atomic_write_text(self, path: Path, text: str) -> None:
        temporary = path.parent / f".{path.name}.{uuid.uuid4().hex}.tmp"
        try:
            with temporary.open("x", encoding="utf-8", newline="\n") as stream:
                stream.write(text)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass

    def _raise_error(
        self,
        code: str,
        message: str,
        *,
        run_id: Optional[str],
        file_name: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None,
        cause_type: Optional[str] = None,
    ) -> None:
        safe_details: Dict[str, Any] = {}
        if file_name is not None:
            safe_details["file_name"] = file_name
        if details:
            safe_details.update(details)
        raise RunStoreError(
            StructuredError(
                code=code,
                message=message,
                stage="storage",
                retriable=False,
                details=safe_details,
                run_id=run_id,
                cause_type=cause_type,
            )
        )


def _require_object(data: Any) -> Dict[str, Any]:
    if not isinstance(data, dict):
        raise _StoredDataError(
            "RUN_STORE_DATA_INVALID",
            "Stored value must be a JSON object.",
        )
    return dict(data)


def _require_schema(data: Mapping[str, Any]) -> None:
    version = data.get("schema_version")
    if version != SCHEMA_VERSION:
        raise _StoredDataError(
            "RUN_STORE_SCHEMA_UNSUPPORTED",
            "Stored schema_version is missing or unsupported.",
        )


def _model_data(data: Any) -> Dict[str, Any]:
    value = _require_object(data)
    _require_schema(value)
    value.pop("schema_version", None)
    return value


def _decode_location(data: Any) -> SourceLocation:
    return SourceLocation(**_model_data(data))


def _decode_pair(data: Any) -> SourceSinkPair:
    value = _model_data(data)
    value["source"] = _decode_location(value.get("source"))
    value["sink"] = _decode_location(value.get("sink"))
    return SourceSinkPair(**value)


def _decode_run(data: Any) -> AuditRun:
    return AuditRun(**_model_data(data))


def _decode_repository(data: Any) -> RepositoryProfile:
    return RepositoryProfile(**_model_data(data))


def _decode_candidate(data: Any) -> AuditCandidate:
    value = _model_data(data)
    value["source_sink_pair"] = _decode_pair(value.get("source_sink_pair"))
    return AuditCandidate(**value)


def _decode_step(data: Any) -> DataFlowStep:
    value = _model_data(data)
    value["location"] = _decode_location(value.get("location"))
    return DataFlowStep(**value)


def _decode_path(data: Any) -> DataFlowPath:
    value = _model_data(data)
    steps = value.get("steps")
    if not isinstance(steps, list):
        raise _StoredDataError(
            "RUN_STORE_DATA_INVALID",
            "Stored path steps must be a JSON array.",
        )
    value["steps"] = [_decode_step(step) for step in steps]
    return DataFlowPath(**value)


def _decode_validation(data: Any) -> ValidationResult:
    return ValidationResult(**_model_data(data))


def _decode_error(data: Any) -> StructuredError:
    return StructuredError(**_model_data(data))


def _decode_event(data: Any) -> AnalysisEvent:
    value = _model_data(data)
    payload = value.get("payload")
    if not isinstance(payload, dict):
        raise _StoredDataError(
            "RUN_STORE_DATA_INVALID",
            "Stored event payload must be a JSON object.",
        )
    event_type = value.get("event_type")
    converted = dict(payload)
    if event_type == "run_started" and "run" in converted:
        converted["run"] = _decode_run(converted["run"])
    elif event_type == "repository_inspected" and "repository" in converted:
        converted["repository"] = _decode_repository(converted["repository"])
    elif event_type == "candidate_extracted" and "candidate" in converted:
        converted["candidate"] = _decode_candidate(converted["candidate"])
    elif event_type == "function_selected" and "location" in converted:
        converted["location"] = _decode_location(converted["location"])
    elif event_type == "source_sink_matched" and "source_sink_pair" in converted:
        converted["source_sink_pair"] = _decode_pair(converted["source_sink_pair"])
    elif event_type == "dataflow_step_found" and "step" in converted:
        converted["step"] = _decode_step(converted["step"])
    elif event_type == "path_validated" and "validation" in converted:
        converted["validation"] = _decode_validation(converted["validation"])
    elif event_type == "analysis_failed" and "error" in converted:
        converted["error"] = _decode_error(converted["error"])
    value["payload"] = converted
    return AnalysisEvent(**value)
