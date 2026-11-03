"""Syntactic candidate generation for staged RepoAudit runs.

This service converts the existing DFBScan source/sink extractor output into
stable public protocol objects.  It does not perform data-flow analysis, path
validation, full scanning, or LLM invocation.
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional, Tuple, Type

from protocol import (
    AuditCandidate,
    EventWriter,
    RepositoryProfile,
    SourceLocation,
    SourceSinkPair,
    StructuredError,
    make_candidate_id,
)
from tstool.analyzer.TS_analyzer import TSAnalyzer
from tstool.dfbscan_extractor.Cpp.Cpp_MLK_extractor import Cpp_MLK_Extractor
from tstool.dfbscan_extractor.Cpp.Cpp_NPD_extractor import Cpp_NPD_Extractor
from tstool.dfbscan_extractor.Cpp.Cpp_UAF_extractor import Cpp_UAF_Extractor
from tstool.dfbscan_extractor.Go.Go_NPD_extractor import Go_NPD_Extractor
from tstool.dfbscan_extractor.Java.Java_NPD_extractor import Java_NPD_Extractor
from tstool.dfbscan_extractor.Python.Python_NPD_extractor import (
    Python_NPD_Extractor,
)
from tstool.dfbscan_extractor.dfbscan_extractor import DFBScanExtractor
from memory.syntactic.function import Function
from memory.syntactic.value import Value


ExtractorKey = Tuple[str, str]

EXTRACTOR_TYPES: Dict[ExtractorKey, Type[DFBScanExtractor]] = {
    ("Cpp", "MLK"): Cpp_MLK_Extractor,
    ("Cpp", "NPD"): Cpp_NPD_Extractor,
    ("Cpp", "UAF"): Cpp_UAF_Extractor,
    ("Java", "NPD"): Java_NPD_Extractor,
    ("Python", "NPD"): Python_NPD_Extractor,
    ("Go", "NPD"): Go_NPD_Extractor,
}

BUG_RELATIONS = {
    "MLK": "must_reach",
    "NPD": "must_not_reach",
    "UAF": "must_not_reach",
}

CANDIDATE_REASON_CODES = {
    "MLK": ["ALLOCATION_SOURCE_EXTRACTED", "DEALLOCATION_SINK_EXTRACTED"],
    "NPD": ["NULL_SOURCE_EXTRACTED", "DEREFERENCE_SINK_EXTRACTED"],
    "UAF": ["DEALLOCATION_SOURCE_EXTRACTED", "USE_SINK_EXTRACTED"],
}


def generate_candidates(
    repository: RepositoryProfile,
    bug_type: str,
    ts_analyzer: TSAnalyzer,
    *,
    event_writer: Optional[EventWriter] = None,
) -> List[AuditCandidate]:
    """Generate deterministic source/sink candidates without neural analysis.

    The generator deliberately creates a syntactic superset: every extracted
    source is paired with every extracted sink.  Data-flow and reachability
    filtering belong to the single-candidate analysis and validation stages.
    """

    _validate_inputs(repository, bug_type, ts_analyzer)
    writer = _resolve_event_writer(event_writer)
    repository_root = _resolve_repository_root(repository.repository_root)
    extractor_type = EXTRACTOR_TYPES[(repository.language, bug_type)]

    try:
        sources, sinks = extractor_type(ts_analyzer).extract_all()
        candidates = _build_candidates(
            repository,
            bug_type,
            ts_analyzer,
            repository_root,
            sources,
            sinks,
        )
    except Exception as error:
        _emit_failure(writer, repository, error)
        raise

    for candidate in candidates:
        writer.emit(
            "candidate_extracted",
            repository.run_id,
            candidate_id=candidate.candidate_id,
            payload={"candidate": candidate},
        )
    return candidates


def _validate_inputs(
    repository: RepositoryProfile,
    bug_type: str,
    ts_analyzer: TSAnalyzer,
) -> None:
    if not isinstance(repository, RepositoryProfile):
        raise TypeError("repository must be a RepositoryProfile")
    if not isinstance(bug_type, str):
        raise TypeError("bug_type must be a string")
    if not isinstance(ts_analyzer, TSAnalyzer):
        raise TypeError("ts_analyzer must be a TSAnalyzer")

    extractor_key = (repository.language, bug_type)
    if extractor_key not in EXTRACTOR_TYPES:
        raise ValueError(
            f"Unsupported bug type {bug_type!r} for language "
            f"{repository.language!r}"
        )
    if bug_type not in repository.supported_bug_types:
        raise ValueError(
            f"Repository profile does not declare support for bug type {bug_type!r}"
        )
    if ts_analyzer.language_name != repository.language:
        raise ValueError(
            "ts_analyzer language does not match the repository profile language"
        )


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


def _build_candidates(
    repository: RepositoryProfile,
    bug_type: str,
    ts_analyzer: TSAnalyzer,
    repository_root: Path,
    sources: List[Value],
    sinks: List[Value],
) -> List[AuditCandidate]:
    candidates_by_id: Dict[str, AuditCandidate] = {}
    source_facts = [
        _value_facts(value, ts_analyzer, repository_root) for value in sources
    ]
    sink_facts = [_value_facts(value, ts_analyzer, repository_root) for value in sinks]

    for source, source_location, source_function in source_facts:
        for sink, sink_location, sink_function in sink_facts:
            source_sink_pair = SourceSinkPair(
                source=source_location,
                sink=sink_location,
                source_symbol=_normalise_symbol(source.name),
                sink_symbol=_normalise_symbol(sink.name),
                relation=BUG_RELATIONS[bug_type],
            )
            source_function_name = _function_name(source_function)
            sink_function_name = _function_name(sink_function)
            candidate_id = make_candidate_id(
                repository.run_id,
                bug_type,
                source_sink_pair,
                source_function_name,
                sink_function_name,
            )
            candidates_by_id[candidate_id] = AuditCandidate(
                run_id=repository.run_id,
                candidate_id=candidate_id,
                bug_type=bug_type,
                source_sink_pair=source_sink_pair,
                source_function=source_function_name,
                sink_function=sink_function_name,
                reason_codes=list(CANDIDATE_REASON_CODES[bug_type]),
            )

    return sorted(candidates_by_id.values(), key=_candidate_sort_key)


def _value_facts(
    value: Value,
    ts_analyzer: TSAnalyzer,
    repository_root: Path,
) -> Tuple[Value, SourceLocation, Optional[Function]]:
    if not isinstance(value, Value):
        raise TypeError("extractors must return Value objects")
    value_path = Path(value.file).expanduser().resolve()
    try:
        relative_path = value_path.relative_to(repository_root).as_posix()
    except ValueError as error:
        raise ValueError(
            "Extracted value path is outside the repository root"
        ) from error
    location = SourceLocation(
        relative_path=relative_path,
        start_line=value.line_number,
        end_line=value.line_number,
    )
    function = ts_analyzer.get_function_from_localvalue(value)
    return value, location, function


def _function_name(function: Optional[Function]) -> Optional[str]:
    return None if function is None else function.function_name


def _normalise_symbol(symbol: str) -> str:
    if not isinstance(symbol, str):
        raise TypeError("Extracted value names must be strings")
    normalised = symbol.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalised:
        raise ValueError("Extracted value names must not be empty")
    return normalised


def _candidate_sort_key(candidate: AuditCandidate) -> Tuple[object, ...]:
    pair = candidate.source_sink_pair
    return (
        pair.source.relative_path,
        pair.source.start_line,
        pair.source_symbol,
        pair.sink.relative_path,
        pair.sink.start_line,
        pair.sink_symbol,
        candidate.source_function or "",
        candidate.sink_function or "",
        candidate.candidate_id,
    )


def _emit_failure(
    writer: EventWriter,
    repository: RepositoryProfile,
    error: Exception,
) -> None:
    writer.write_log("RepoAudit candidate generation: CANDIDATE_EXTRACTION_FAILED")
    structured_error = StructuredError(
        code="CANDIDATE_EXTRACTION_FAILED",
        message="Syntactic candidate generation failed.",
        stage="candidates",
        retriable=False,
        details={
            "language": repository.language,
        },
        run_id=repository.run_id,
        cause_type=type(error).__name__,
    )
    writer.emit(
        "analysis_failed",
        repository.run_id,
        payload={"error": structured_error},
    )
