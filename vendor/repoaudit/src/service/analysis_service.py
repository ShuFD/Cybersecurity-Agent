"""Single-candidate data-flow analysis for staged RepoAudit runs.

The public identity boundary is ``(run_id, candidate_id)``.  Until TASK-008
introduces durable run storage, candidate extraction registers a private,
process-local context containing the public candidate and its Tree-sitter
analyzer.  No Tree-sitter object is exposed through the public protocol.
"""

from __future__ import annotations

import copy
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Dict, List, Optional, Sequence, Set, Tuple

from memory.syntactic.function import Function
from memory.syntactic.value import Value, ValueLabel
from protocol import (
    AuditCandidate,
    DataFlowPath,
    DataFlowStep,
    EventWriter,
    RepositoryProfile,
    SourceLocation,
    StructuredError,
    ValidationResult,
    make_path_id,
    validate_candidate_id,
    validate_run_id,
)
from tstool.analyzer.TS_analyzer import (
    CallContext,
    ContextLabel,
    Parenthesis,
    TSAnalyzer,
)

from .candidate_generator import EXTRACTOR_TYPES

if TYPE_CHECKING:
    from llmtool.dfbscan.intra_dataflow_analyzer import IntraDataFlowAnalyzer


DEFAULT_CALL_DEPTH = 3


class CandidateAnalysisError(RuntimeError):
    """Raised after a safe ``StructuredError`` has been emitted."""

    def __init__(self, error: StructuredError) -> None:
        super().__init__(error.message)
        self.error = error


@dataclass
class _RunAnalysisContext:
    profile: RepositoryProfile
    analyzer: TSAnalyzer
    candidates: Dict[str, AuditCandidate]
    event_writer: EventWriter
    paths: Dict[str, Dict[str, DataFlowPath]] = field(default_factory=dict)
    validations: Dict[str, Dict[str, ValidationResult]] = field(default_factory=dict)


@dataclass(frozen=True)
class _InternalStep:
    value: Value
    function: Optional[Function]
    description: str
    interprocedural: bool = False


@dataclass
class _PendingAnalysis:
    start_value: Value
    function: Function
    call_context: CallContext
    prefix: List[_InternalStep] = field(default_factory=list)
    transition_depth: int = 0


_CONTEXTS: Dict[str, _RunAnalysisContext] = {}
_CONTEXTS_LOCK = threading.RLock()


def analyze_candidate(
    run_id: str,
    candidate_id: str,
    *,
    intra_dataflow_analyzer: Optional["IntraDataFlowAnalyzer"] = None,
    event_writer: Optional[EventWriter] = None,
    call_depth: int = DEFAULT_CALL_DEPTH,
) -> List[DataFlowPath]:
    """Analyze exactly one candidate and return deterministic public paths.

    ``run_id`` and ``candidate_id`` are the stable public call form.  The
    keyword-only analyzer dependency carries model configuration owned by the
    caller; it is deliberately not inferred from environment variables or
    persisted before TASK-008.  A composed run may also pass its shared event
    writer and call-depth setting.
    """

    writer = _resolve_initial_writer(event_writer)
    try:
        validate_run_id(run_id)
        validate_candidate_id(candidate_id)
        _validate_call_depth(call_depth)
        try:
            context, candidate = _load_candidate_context(run_id, candidate_id)
        except KeyError:
            _raise_analysis_error(
                writer,
                code="CANDIDATE_NOT_FOUND",
                message="The requested candidate was not found in this run.",
                run_id=run_id,
                candidate_id=candidate_id,
                retriable=False,
                details={"failure_stage": "candidate_load"},
            )
        except LookupError:
            _raise_analysis_error(
                writer,
                code="RUN_CONTEXT_NOT_FOUND",
                message="The requested run is not available for analysis.",
                run_id=run_id,
                candidate_id=candidate_id,
                retriable=False,
                details={"failure_stage": "candidate_load"},
            )
        writer = _resolve_context_writer(event_writer, context.event_writer)
        if intra_dataflow_analyzer is None:
            _raise_analysis_error(
                writer,
                code="ANALYSIS_RUNTIME_NOT_CONFIGURED",
                message="The intra-procedural analyzer was not configured.",
                run_id=run_id,
                candidate_id=candidate_id,
                retriable=False,
                details={"required_dependency": "IntraDataFlowAnalyzer"},
            )
        return _analyze_loaded_candidate(
            context,
            candidate,
            intra_dataflow_analyzer,
            writer,
            call_depth,
        )
    except CandidateAnalysisError:
        raise
    except Exception as error:
        safe_run_id = _valid_run_id_or_none(run_id)
        safe_candidate_id = (
            _valid_candidate_id_or_none(candidate_id)
            if safe_run_id is not None
            else None
        )
        _raise_analysis_error(
            writer,
            code="CANDIDATE_ANALYSIS_FAILED",
            message="Single-candidate data-flow analysis failed.",
            run_id=safe_run_id,
            candidate_id=safe_candidate_id,
            retriable=False,
            details={"failure_stage": "analyze"},
            cause_type=type(error).__name__,
        )


def _register_candidate_batch(
    profile: RepositoryProfile,
    analyzer: TSAnalyzer,
    candidates: Sequence[AuditCandidate],
    event_writer: EventWriter,
) -> None:
    """Register transient candidate state without implementing TASK-008."""

    if not isinstance(profile, RepositoryProfile):
        raise TypeError("profile must be a RepositoryProfile")
    if not isinstance(analyzer, TSAnalyzer):
        raise TypeError("analyzer must be a TSAnalyzer")
    if not isinstance(event_writer, EventWriter):
        raise TypeError("event_writer must be an EventWriter")
    candidate_map: Dict[str, AuditCandidate] = {}
    for candidate in candidates:
        if not isinstance(candidate, AuditCandidate):
            raise TypeError("candidates must contain only AuditCandidate objects")
        if candidate.run_id != profile.run_id:
            raise ValueError("candidate run_id does not match repository profile")
        candidate_map[candidate.candidate_id] = candidate

    with _CONTEXTS_LOCK:
        existing = _CONTEXTS.get(profile.run_id)
        if existing is None:
            _CONTEXTS[profile.run_id] = _RunAnalysisContext(
                profile=profile,
                analyzer=analyzer,
                candidates=candidate_map,
                event_writer=event_writer,
            )
            return
        if (
            existing.profile.repository_root != profile.repository_root
            or existing.profile.language != profile.language
        ):
            raise ValueError("run_id is already registered for another repository")
        existing.profile = profile
        existing.analyzer = analyzer
        existing.event_writer = event_writer
        existing.candidates.update(candidate_map)


def _load_candidate_context(
    run_id: str,
    candidate_id: str,
) -> Tuple[_RunAnalysisContext, AuditCandidate]:
    """Load one candidate from the temporary TASK-006 boundary.

    TASK-008 may replace this function with a durable ``RunStore`` adapter
    without changing ``analyze_candidate`` or its public IDs.
    """

    with _CONTEXTS_LOCK:
        context = _CONTEXTS.get(run_id)
        if context is None:
            raise LookupError("run analysis context was not found")
        candidate = context.candidates.get(candidate_id)
        if candidate is None:
            raise KeyError("candidate was not found in the requested run")
        return context, candidate


def _load_path_context(
    run_id: str,
    candidate_id: str,
    path_id: str,
) -> Tuple[_RunAnalysisContext, AuditCandidate, DataFlowPath]:
    """Load exactly one transient path for TASK-007 validation."""

    with _CONTEXTS_LOCK:
        context = _CONTEXTS.get(run_id)
        if context is None:
            raise LookupError("run analysis context was not found")
        candidate = context.candidates.get(candidate_id)
        if candidate is None:
            raise KeyError("candidate was not found in the requested run")
        path = context.paths.get(candidate_id, {}).get(path_id)
        if path is None:
            raise FileNotFoundError("path was not found for the requested candidate")
        return context, candidate, path


def _store_validation_result(
    context: _RunAnalysisContext,
    result: ValidationResult,
) -> None:
    """Retain one public validation result until TASK-008 adds RunStore."""

    with _CONTEXTS_LOCK:
        candidate_results = context.validations.setdefault(result.candidate_id, {})
        candidate_results[result.path_id] = result


def _analyze_loaded_candidate(
    context: _RunAnalysisContext,
    candidate: AuditCandidate,
    intra_dataflow_analyzer: "IntraDataFlowAnalyzer",
    writer: EventWriter,
    call_depth: int,
) -> List[DataFlowPath]:
    from llmtool.dfbscan.intra_dataflow_analyzer import (
        IntraDataFlowAnalyzerInput,
        IntraDataFlowAnalyzerOutput,
    )

    writer.emit(
        "candidate_analysis_started",
        candidate.run_id,
        candidate_id=candidate.candidate_id,
    )

    repository_root = _resolve_repository_root(context.profile.repository_root)
    source_value, sink_value = _load_candidate_values(
        context,
        candidate,
        repository_root,
    )
    source_function = context.analyzer.get_function_from_localvalue(source_value)
    sink_function = context.analyzer.get_function_from_localvalue(sink_value)
    if source_function is None or sink_function is None:
        _raise_analysis_error(
            writer,
            code="CANDIDATE_FUNCTION_NOT_FOUND",
            message="A candidate endpoint could not be mapped to a function.",
            run_id=candidate.run_id,
            candidate_id=candidate.candidate_id,
            retriable=False,
            details={
                "source_function_found": source_function is not None,
                "sink_function_found": sink_function is not None,
            },
        )

    pending: List[_PendingAnalysis] = [
        _PendingAnalysis(
            start_value=source_value,
            function=source_function,
            call_context=CallContext(False),
            prefix=[
                _InternalStep(
                    value=source_value,
                    function=source_function,
                    description="Candidate source selected for analysis.",
                )
            ],
        )
    ]
    visited_states: Set[Tuple[object, ...]] = set()
    selected_functions: Set[int] = set()
    paths_by_id: Dict[str, DataFlowPath] = {}

    _emit_function_selected(
        writer,
        candidate,
        source_function,
        repository_root,
        selected_functions,
    )
    _emit_function_selected(
        writer,
        candidate,
        sink_function,
        repository_root,
        selected_functions,
    )

    while pending:
        current = pending.pop(0)
        if current.transition_depth > call_depth:
            continue
        state_key = _state_key(current)
        if state_key in visited_states:
            continue
        visited_states.add(state_key)

        _emit_function_selected(
            writer,
            candidate,
            current.function,
            repository_root,
            selected_functions,
        )
        analyzer_input = _build_analyzer_input(
            context.analyzer,
            current.function,
            current.start_value,
            sink_value,
            sink_function,
        )
        try:
            analyzer_output = intra_dataflow_analyzer.invoke(
                analyzer_input,
                IntraDataFlowAnalyzerOutput,
            )
        except Exception as error:
            _raise_analysis_error(
                writer,
                code="INTRA_DATAFLOW_INVOCATION_FAILED",
                message="The intra-procedural analyzer invocation failed.",
                run_id=candidate.run_id,
                candidate_id=candidate.candidate_id,
                retriable=True,
                details={
                    "failure_stage": "intra_dataflow",
                    "function_name": current.function.function_name,
                },
                cause_type=type(error).__name__,
            )
        if analyzer_output is None:
            _raise_analysis_error(
                writer,
                code="INTRA_DATAFLOW_NO_RESULT",
                message="The intra-procedural analyzer returned no result.",
                run_id=candidate.run_id,
                candidate_id=candidate.candidate_id,
                retriable=True,
                details={"function_name": current.function.function_name},
            )

        for reachable_values in analyzer_output.reachable_values:
            ordered_values = sorted(reachable_values, key=_value_sort_key)
            path_prefix = _extend_intra_steps(
                current.prefix,
                ordered_values,
                current.function,
            )
            if any(_same_endpoint(value, sink_value) for value in ordered_values):
                completed = _truncate_at_endpoint(path_prefix, sink_value)
                path = _build_public_path(
                    context.profile,
                    candidate,
                    completed,
                    repository_root,
                )
                paths_by_id[path.path_id] = path

            if current.transition_depth >= call_depth:
                continue
            for transition in _external_transitions(
                context.analyzer,
                current.function,
                current.call_context,
                ordered_values,
            ):
                next_value, next_function, next_context, description = transition
                pending.append(
                    _PendingAnalysis(
                        start_value=next_value,
                        function=next_function,
                        call_context=next_context,
                        prefix=_append_internal_step(
                            path_prefix,
                            _InternalStep(
                                value=next_value,
                                function=next_function,
                                description=description,
                                interprocedural=True,
                            ),
                        ),
                        transition_depth=current.transition_depth + 1,
                    )
                )

    paths = sorted(paths_by_id.values(), key=lambda item: item.path_id)
    _store_candidate_paths(context, candidate.candidate_id, paths)
    if not paths:
        writer.emit(
            "candidate_rejected",
            candidate.run_id,
            candidate_id=candidate.candidate_id,
            payload={
                "reason_codes": ["SOURCE_SINK_NOT_MATCHED"],
                "summary": "No data-flow path connected the selected endpoints.",
            },
        )
        return []

    writer.emit(
        "source_sink_matched",
        candidate.run_id,
        candidate_id=candidate.candidate_id,
        payload={"source_sink_pair": candidate.source_sink_pair},
    )
    for path in paths:
        for step in path.steps:
            writer.emit(
                "dataflow_step_found",
                candidate.run_id,
                candidate_id=candidate.candidate_id,
                path_id=path.path_id,
                payload={"step": step},
            )
    return paths


def _store_candidate_paths(
    context: _RunAnalysisContext,
    candidate_id: str,
    paths: Sequence[DataFlowPath],
) -> None:
    """Retain public path facts for TASK-007 within the current process."""

    with _CONTEXTS_LOCK:
        context.paths[candidate_id] = {path.path_id: path for path in paths}


def _build_analyzer_input(
    analyzer: TSAnalyzer,
    function: Function,
    start_value: Value,
    sink_value: Value,
    sink_function: Function,
):
    from llmtool.dfbscan.intra_dataflow_analyzer import IntraDataFlowAnalyzerInput

    sink_values: List[Tuple[str, int]] = []
    if function.function_id == sink_function.function_id:
        sink_values.append(
            (
                sink_value.name,
                sink_value.line_number - function.start_line_number + 1,
            )
        )

    call_statements: List[Tuple[str, int]] = []
    file_content = analyzer.code_in_files[function.file_path]
    for node in function.function_call_site_nodes:
        call_statements.append(
            (
                file_content[node.start_byte : node.end_byte],
                file_content[: node.start_byte].count("\n") + 1,
            )
        )
    call_statements.sort(key=lambda item: (item[1], item[0]))

    ret_values = [
        (
            value.name,
            value.line_number - function.start_line_number + 1,
        )
        for value in (function.retvals or set())
    ]
    ret_values.sort(key=lambda item: (item[1], item[0]))
    return IntraDataFlowAnalyzerInput(
        function,
        start_value,
        sink_values,
        call_statements,
        ret_values,
    )


def _external_transitions(
    analyzer: TSAnalyzer,
    function: Function,
    call_context: CallContext,
    values: Sequence[Value],
) -> List[Tuple[Value, Function, CallContext, str]]:
    transitions: List[Tuple[Value, Function, CallContext, str]] = []
    for value in values:
        if value.label == ValueLabel.ARG:
            transitions.extend(
                _argument_to_parameter_transitions(
                    analyzer,
                    function,
                    call_context,
                    value,
                )
            )
        elif value.label == ValueLabel.PARA:
            transitions.extend(
                _parameter_to_argument_transitions(
                    analyzer,
                    function,
                    call_context,
                    value,
                )
            )
        elif value.label == ValueLabel.RET:
            transitions.extend(
                _return_to_output_transitions(
                    analyzer,
                    function,
                    call_context,
                    value,
                )
            )
    transitions.sort(key=_transition_sort_key)
    return transitions


def _argument_to_parameter_transitions(
    analyzer: TSAnalyzer,
    function: Function,
    call_context: CallContext,
    value: Value,
) -> List[Tuple[Value, Function, CallContext, str]]:
    transitions = []
    for callee in analyzer.get_all_callee_functions(function):
        for call_site in analyzer.get_callsites_by_callee_name(
            function,
            callee.function_name,
        ):
            lower, upper = _node_line_span(analyzer, function, call_site)
            if not lower <= value.line_number <= upper:
                continue
            new_context = copy.deepcopy(call_context)
            label = ContextLabel(
                analyzer.functionToFile[function.function_id],
                lower,
                callee.function_id,
                Parenthesis.LEFT_PAR,
            )
            if not new_context.add_and_check_context(label):
                continue
            for parameter in callee.paras or set():
                if parameter.index == value.index:
                    transitions.append(
                        (
                            parameter,
                            callee,
                            new_context,
                            "Argument propagated to the matching callee parameter.",
                        )
                    )
    return transitions


def _parameter_to_argument_transitions(
    analyzer: TSAnalyzer,
    function: Function,
    call_context: CallContext,
    value: Value,
) -> List[Tuple[Value, Function, CallContext, str]]:
    transitions = []
    for caller in analyzer.get_all_caller_functions(function):
        for call_site in analyzer.get_callsites_by_callee_name(
            caller,
            function.function_name,
        ):
            lower, _ = _node_line_span(analyzer, caller, call_site)
            new_context = copy.deepcopy(call_context)
            if not _context_accepts_return(
                new_context,
                analyzer.functionToFile[caller.function_id],
                lower,
                function.function_id,
            ):
                continue
            for argument in analyzer.get_arguments_at_callsite(caller, call_site):
                if argument.index == value.index:
                    transitions.append(
                        (
                            argument,
                            caller,
                            new_context,
                            "Parameter side effect propagated to the caller argument.",
                        )
                    )
    return transitions


def _return_to_output_transitions(
    analyzer: TSAnalyzer,
    function: Function,
    call_context: CallContext,
    value: Value,
) -> List[Tuple[Value, Function, CallContext, str]]:
    transitions = []
    for caller in analyzer.get_all_caller_functions(function):
        for call_site in analyzer.get_callsites_by_callee_name(
            caller,
            function.function_name,
        ):
            lower, _ = _node_line_span(analyzer, caller, call_site)
            new_context = copy.deepcopy(call_context)
            if not _context_accepts_return(
                new_context,
                analyzer.functionToFile[caller.function_id],
                lower,
                function.function_id,
            ):
                continue
            transitions.append(
                (
                    analyzer.get_output_value_at_callsite(caller, call_site),
                    caller,
                    new_context,
                    "Return value propagated to the caller call result.",
                )
            )
    return transitions


def _context_accepts_return(
    call_context: CallContext,
    caller_file: str,
    call_site_line: int,
    callee_id: int,
) -> bool:
    top = call_context.get_top_unmatched_context_label()
    if top is not None and top.parenthesis == Parenthesis.LEFT_PAR:
        if (
            top.line_number != call_site_line
            or top.file_name != caller_file
            or top.function_id != callee_id
        ):
            return False
    label = ContextLabel(
        caller_file,
        call_site_line,
        callee_id,
        Parenthesis.RIGHT_PAR,
    )
    return call_context.add_and_check_context(label)


def _load_candidate_values(
    context: _RunAnalysisContext,
    candidate: AuditCandidate,
    repository_root: Path,
) -> Tuple[Value, Value]:
    extractor_type = EXTRACTOR_TYPES.get((context.profile.language, candidate.bug_type))
    if extractor_type is None:
        raise ValueError("candidate language and bug type are unsupported")
    sources, sinks = extractor_type(context.analyzer).extract_all()
    source = _find_endpoint(
        sources,
        candidate.source_sink_pair.source,
        candidate.source_sink_pair.source_symbol,
        repository_root,
    )
    sink = _find_endpoint(
        sinks,
        candidate.source_sink_pair.sink,
        candidate.source_sink_pair.sink_symbol,
        repository_root,
    )
    if source is None or sink is None:
        raise LookupError("candidate endpoint no longer matches extractor output")
    return source, sink


def _find_endpoint(
    values: Sequence[Value],
    location: SourceLocation,
    symbol: str,
    repository_root: Path,
) -> Optional[Value]:
    matches = [
        value
        for value in values
        if value.line_number == location.start_line
        and _normalise_symbol(value.name) == symbol
        and _relative_value_path(value, repository_root) == location.relative_path
    ]
    if not matches:
        return None
    return sorted(matches, key=_value_sort_key)[0]


def _build_public_path(
    profile: RepositoryProfile,
    candidate: AuditCandidate,
    internal_steps: Sequence[_InternalStep],
    repository_root: Path,
) -> DataFlowPath:
    public_steps: List[DataFlowStep] = []
    for index, internal in enumerate(internal_steps, start=1):
        public_steps.append(
            DataFlowStep(
                step_index=index,
                kind=_step_kind(internal.value),
                location=SourceLocation(
                    relative_path=_relative_value_path(
                        internal.value,
                        repository_root,
                    ),
                    start_line=internal.value.line_number,
                    end_line=internal.value.line_number,
                ),
                function_name=(
                    None
                    if internal.function is None
                    else internal.function.function_name
                ),
                value=_normalise_symbol(internal.value.name),
                description=internal.description,
            )
        )
    path_id = make_path_id(profile.run_id, candidate.candidate_id, public_steps)
    interprocedural = any(step.interprocedural for step in internal_steps)
    reason_codes = ["SOURCE_REACHES_SINK"]
    if interprocedural:
        reason_codes.append("INTERPROCEDURAL_PROPAGATION")
    return DataFlowPath(
        run_id=profile.run_id,
        candidate_id=candidate.candidate_id,
        path_id=path_id,
        steps=public_steps,
        status="complete",
        interprocedural=interprocedural,
        reason_codes=reason_codes,
    )


def _extend_intra_steps(
    prefix: Sequence[_InternalStep],
    values: Sequence[Value],
    function: Function,
) -> List[_InternalStep]:
    steps = list(prefix)
    for value in values:
        steps = _append_internal_step(
            steps,
            _InternalStep(
                value=value,
                function=function,
                description="Reachable value reported by IntraDataFlowAnalyzer.",
            ),
        )
    return steps


def _append_internal_step(
    steps: Sequence[_InternalStep],
    step: _InternalStep,
) -> List[_InternalStep]:
    result = list(steps)
    if result and _same_endpoint(result[-1].value, step.value):
        if step.interprocedural and not result[-1].interprocedural:
            result[-1] = step
        return result
    result.append(step)
    return result


def _truncate_at_endpoint(
    steps: Sequence[_InternalStep],
    endpoint: Value,
) -> List[_InternalStep]:
    for index, step in enumerate(steps):
        if _same_endpoint(step.value, endpoint):
            return list(steps[: index + 1])
    return list(steps)


def _emit_function_selected(
    writer: EventWriter,
    candidate: AuditCandidate,
    function: Function,
    repository_root: Path,
    emitted: Set[int],
) -> None:
    if function.function_id in emitted:
        return
    emitted.add(function.function_id)
    writer.emit(
        "function_selected",
        candidate.run_id,
        candidate_id=candidate.candidate_id,
        payload={
            "function_name": function.function_name,
            "location": SourceLocation(
                relative_path=_relative_file_path(
                    function.file_path,
                    repository_root,
                ),
                start_line=function.start_line_number,
                end_line=function.end_line_number,
            ),
        },
    )


def _node_line_span(analyzer: TSAnalyzer, function: Function, node) -> Tuple[int, int]:
    content = analyzer.code_in_files[function.file_path]
    return (
        content[: node.start_byte].count("\n") + 1,
        content[: node.end_byte].count("\n") + 1,
    )


def _state_key(pending: _PendingAnalysis) -> Tuple[object, ...]:
    return (
        pending.start_value.name,
        pending.start_value.file,
        pending.start_value.line_number,
        str(pending.start_value.label),
        pending.start_value.index,
        pending.function.function_id,
        str(pending.call_context),
    )


def _transition_sort_key(
    transition: Tuple[Value, Function, CallContext, str],
) -> Tuple[object, ...]:
    value, function, context, _ = transition
    return (_value_sort_key(value), function.function_id, str(context))


def _value_sort_key(value: Value) -> Tuple[object, ...]:
    return (
        str(Path(value.file)),
        value.line_number,
        value.label.value,
        value.index,
        value.name,
    )


def _same_endpoint(left: Value, right: Value) -> bool:
    return (
        Path(left.file).resolve() == Path(right.file).resolve()
        and left.line_number == right.line_number
        and _normalise_symbol(left.name) == _normalise_symbol(right.name)
    )


def _step_kind(value: Value) -> str:
    mapping = {
        ValueLabel.SRC: "source",
        ValueLabel.SINK: "sink",
        ValueLabel.ARG: "argument",
        ValueLabel.PARA: "parameter",
        ValueLabel.RET: "return",
        ValueLabel.OUT: "call_result",
        ValueLabel.LOCAL: "local_value",
        ValueLabel.GLOBAL: "global_value",
        ValueLabel.BUF_ACCESS_EXPR: "buffer_access",
        ValueLabel.NON_BUF_ACCESS_EXPR: "value_access",
    }
    return mapping.get(value.label, "value")


def _relative_value_path(value: Value, repository_root: Path) -> str:
    return _relative_file_path(value.file, repository_root)


def _relative_file_path(file_path: str, repository_root: Path) -> str:
    resolved = Path(file_path).expanduser().resolve()
    try:
        return resolved.relative_to(repository_root).as_posix()
    except ValueError as error:
        raise ValueError(
            "analysis value path is outside the repository root"
        ) from error


def _normalise_symbol(symbol: str) -> str:
    if not isinstance(symbol, str):
        raise TypeError("value names must be strings")
    normalised = symbol.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalised:
        raise ValueError("value names must not be empty")
    return normalised


def _resolve_repository_root(repository_root: str) -> Path:
    root = Path(repository_root).expanduser().resolve(strict=True)
    if not root.is_dir():
        raise NotADirectoryError("repository root is not a directory")
    return root


def _validate_call_depth(call_depth: int) -> None:
    if (
        not isinstance(call_depth, int)
        or isinstance(call_depth, bool)
        or call_depth < 0
    ):
        raise ValueError("call_depth must be a non-negative integer")


def _resolve_initial_writer(event_writer: Optional[EventWriter]) -> EventWriter:
    if event_writer is None:
        return EventWriter()
    if not isinstance(event_writer, EventWriter):
        raise TypeError("event_writer must be an EventWriter")
    return event_writer


def _resolve_context_writer(
    requested: Optional[EventWriter],
    registered: EventWriter,
) -> EventWriter:
    return registered if requested is None else requested


def _raise_analysis_error(
    writer: EventWriter,
    *,
    code: str,
    message: str,
    run_id: Optional[str],
    candidate_id: Optional[str],
    retriable: bool,
    details: Dict[str, object],
    cause_type: Optional[str] = None,
) -> None:
    writer.write_log("RepoAudit candidate analysis:", code)
    error = StructuredError(
        code=code,
        message=message,
        stage="analyze",
        retriable=retriable,
        details=details,
        run_id=run_id,
        candidate_id=candidate_id,
        cause_type=cause_type,
    )
    writer.emit(
        "analysis_failed",
        run_id,
        candidate_id=candidate_id,
        payload={"error": error},
    )
    raise CandidateAnalysisError(error)


def _valid_run_id_or_none(value: object) -> Optional[str]:
    try:
        return validate_run_id(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _valid_candidate_id_or_none(value: object) -> Optional[str]:
    try:
        return validate_candidate_id(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
