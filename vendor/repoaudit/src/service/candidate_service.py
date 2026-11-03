"""Public candidate extraction service for staged RepoAudit runs."""

from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional

from protocol import AuditCandidate, EventWriter, RepositoryProfile, StructuredError

from .candidate_generator import EXTRACTOR_TYPES, generate_candidates
from .repository_inspector import (
    ANALYZER_TYPES,
    DEFAULT_MAX_SYMBOLIC_WORKERS,
)


def extract_candidates(
    profile: RepositoryProfile,
    bug_type: str,
    *,
    event_writer: Optional[EventWriter] = None,
    max_symbolic_workers: int = DEFAULT_MAX_SYMBOLIC_WORKERS,
) -> List[AuditCandidate]:
    """Build an analyzer from ``profile`` and return public audit candidates.

    The two-argument form is the stable staged-service interface.  Optional
    keyword arguments allow a composed run to share its event sequence and
    symbolic worker setting without changing that primary call form.
    """

    _validate_inputs(profile, bug_type, max_symbolic_workers)
    writer = _resolve_event_writer(event_writer)
    repository_root = _resolve_repository_root(profile.repository_root)

    try:
        code_in_files = _load_profile_sources(profile, repository_root)
        if not code_in_files:
            return []
        analyzer = ANALYZER_TYPES[profile.language](
            code_in_files,
            profile.language,
            max_symbolic_workers,
        )
    except Exception as error:
        _emit_preparation_failure(writer, profile, error)
        raise

    candidates = generate_candidates(
        profile,
        bug_type,
        analyzer,
        event_writer=writer,
    )
    from .analysis_service import _register_candidate_batch

    _register_candidate_batch(profile, analyzer, candidates, writer)
    return candidates


def _validate_inputs(
    profile: RepositoryProfile,
    bug_type: str,
    max_symbolic_workers: int,
) -> None:
    if not isinstance(profile, RepositoryProfile):
        raise TypeError("profile must be a RepositoryProfile")
    if not isinstance(bug_type, str):
        raise TypeError("bug_type must be a string")
    if (profile.language, bug_type) not in EXTRACTOR_TYPES:
        raise ValueError(
            f"Unsupported bug type {bug_type!r} for language {profile.language!r}"
        )
    if bug_type not in profile.supported_bug_types:
        raise ValueError(
            f"Repository profile does not declare support for bug type {bug_type!r}"
        )
    if profile.language not in ANALYZER_TYPES:
        raise ValueError(f"Unsupported repository language: {profile.language!r}")
    if (
        not isinstance(max_symbolic_workers, int)
        or isinstance(max_symbolic_workers, bool)
        or max_symbolic_workers < 1
    ):
        raise ValueError("max_symbolic_workers must be a positive integer")


def _resolve_event_writer(event_writer: Optional[EventWriter]) -> EventWriter:
    if event_writer is None:
        return EventWriter()
    if not isinstance(event_writer, EventWriter):
        raise TypeError("event_writer must be an EventWriter")
    return event_writer


def _resolve_repository_root(repository_root: str) -> Path:
    try:
        root = Path(repository_root).expanduser().resolve(strict=True)
    except FileNotFoundError as error:
        raise FileNotFoundError(
            f"Repository profile root does not exist: {repository_root}"
        ) from error
    if not root.is_dir():
        raise NotADirectoryError(
            f"Repository profile root is not a directory: {repository_root}"
        )
    return root


def _load_profile_sources(
    profile: RepositoryProfile,
    repository_root: Path,
) -> Dict[str, str]:
    code_in_files: Dict[str, str] = {}
    for relative_path in profile.source_files:
        try:
            source_path = (repository_root / relative_path).resolve(strict=True)
        except FileNotFoundError as error:
            raise FileNotFoundError(
                f"Profile source file does not exist: {relative_path}"
            ) from error
        try:
            source_path.relative_to(repository_root)
        except ValueError as error:
            raise ValueError(
                "Profile source path escapes the repository root"
            ) from error
        if not source_path.is_file():
            raise FileNotFoundError(f"Profile source is not a file: {relative_path}")
        code_in_files[str(source_path)] = source_path.read_text(
            encoding="utf-8",
            errors="ignore",
        )
    return code_in_files


def _emit_preparation_failure(
    writer: EventWriter,
    profile: RepositoryProfile,
    error: Exception,
) -> None:
    writer.write_log("RepoAudit candidate extraction: CANDIDATE_PREPARATION_FAILED")
    structured_error = StructuredError(
        code="CANDIDATE_PREPARATION_FAILED",
        message="Candidate extraction inputs could not be prepared.",
        stage="candidates",
        retriable=False,
        details={"language": profile.language},
        run_id=profile.run_id,
        cause_type=type(error).__name__,
    )
    writer.emit(
        "analysis_failed",
        profile.run_id,
        payload={"error": structured_error},
    )
