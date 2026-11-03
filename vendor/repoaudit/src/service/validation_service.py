"""Independent validation of one staged RepoAudit data-flow path."""

from __future__ import annotations

import re
import threading
from pathlib import Path
from typing import TYPE_CHECKING, Dict, List, Optional, Tuple

from memory.syntactic.function import Function
from memory.syntactic.value import Value, ValueLabel
from protocol import (
    DataFlowPath,
    DataFlowStep,
    EventWriter,
    StructuredError,
    ValidationResult,
    validate_candidate_id,
    validate_path_id,
    validate_run_id,
)

from .analysis_service import (
    _RunAnalysisContext,
    _load_path_context,
    _store_validation_result,
)

if TYPE_CHECKING:
    from llmtool.dfbscan.path_validator import PathValidator


class PathValidationError(RuntimeError):
    """Raised after validation failure has been emitted safely."""

    def __init__(self, error: StructuredError) -> None:
        super().__init__(error.message)
        self.error = error


class _SuppressedModelLogger:
    """Prevent the legacy tool from logging prompts or raw responses."""

    def print_log(self, *args: object) -> None:
        return None

    def print_console(self, *args: object) -> None:
        return None


_VALIDATOR_INVOKE_LOCK = threading.RLock()


def validate_path(
    run_id: str,
    candidate_id: str,
    path_id: str,
    *,
    path_validator: Optional["PathValidator"] = None,
    event_writer: Optional[EventWriter] = None,
) -> ValidationResult:
    """Load and validate exactly one path identified by public IDs.

    The three positional IDs are the stable public call form.  The configured
    legacy validator is keyword-only because its model and logger settings
    belong to the composing caller rather than the public path protocol.
    """

    writer = _resolve_initial_writer(event_writer)
    try:
        validate_run_id(run_id)
        validate_candidate_id(candidate_id)
        validate_path_id(path_id)
        try:
            context, candidate, path = _load_path_context(
                run_id,
                candidate_id,
                path_id,
            )
        except FileNotFoundError:
            _raise_validation_error(
                writer,
                code="PATH_NOT_FOUND",
                message="The requested path was not found for this candidate.",
                run_id=run_id,
                candidate_id=candidate_id,
                path_id=path_id,
                retriable=False,
                details={"failure_stage": "path_load"},
            )
        except KeyError:
            _raise_validation_error(
                writer,
                code="CANDIDATE_NOT_FOUND",
                message="The requested candidate was not found in this run.",
                run_id=run_id,
                candidate_id=candidate_id,
                path_id=path_id,
                retriable=False,
                details={"failure_stage": "path_load"},
            )
        except LookupError:
            _raise_validation_error(
                writer,
                code="RUN_CONTEXT_NOT_FOUND",
                message="The requested run is not available for validation.",
                run_id=run_id,
                candidate_id=candidate_id,
                path_id=path_id,
                retriable=False,
                details={"failure_stage": "path_load"},
            )

        writer = _resolve_context_writer(event_writer, context.event_writer)
        writer.emit(
            "path_validation_started",
            run_id,
            candidate_id=candidate_id,
            path_id=path_id,
        )

        if path.status != "complete":
            result = _inconclusive_partial_result(path)
            return _store_and_emit_result(context, writer, result)

        if path_validator is None:
            _raise_validation_error(
                writer,
                code="VALIDATION_RUNTIME_NOT_CONFIGURED",
                message="The path validator was not configured.",
                run_id=run_id,
                candidate_id=candidate_id,
                path_id=path_id,
                retriable=False,
                details={"required_dependency": "PathValidator"},
            )

        values, values_to_functions = _rebuild_internal_path(context, path)
        return _invoke_validator(
            context,
            candidate.bug_type,
            path,
            values,
            values_to_functions,
            path_validator,
            writer,
        )
    except PathValidationError:
        raise
    except Exception as error:
        safe_run_id = _valid_run_id_or_none(run_id)
        safe_candidate_id = (
            _valid_candidate_id_or_none(candidate_id)
            if safe_run_id is not None
            else None
        )
        safe_path_id = (
            _valid_path_id_or_none(path_id) if safe_candidate_id is not None else None
        )
        _raise_validation_error(
            writer,
            code="PATH_VALIDATION_FAILED",
            message="Single-path validation failed.",
            run_id=safe_run_id,
            candidate_id=safe_candidate_id,
            path_id=safe_path_id,
            retriable=False,
            details={"failure_stage": "validate"},
            cause_type=type(error).__name__,
        )


def _invoke_validator(
    context: _RunAnalysisContext,
    bug_type: str,
    path: DataFlowPath,
    values: List[Value],
    values_to_functions: Dict[Value, Optional[Function]],
    path_validator: "PathValidator",
    writer: EventWriter,
) -> ValidationResult:
    from llmtool.dfbscan.path_validator import PathValidatorInput, PathValidatorOutput

    validator_input = PathValidatorInput(
        bug_type,
        values,
        values_to_functions,
    )
    query_count_before = _query_count(path_validator)
    try:
        output = _invoke_without_sensitive_logs(
            path_validator,
            validator_input,
            PathValidatorOutput,
        )
    except Exception as error:
        _raise_validation_error(
            writer,
            code="PATH_VALIDATOR_INVOCATION_FAILED",
            message="The configured path validator invocation failed.",
            run_id=path.run_id,
            candidate_id=path.candidate_id,
            path_id=path.path_id,
            retriable=True,
            details={
                "failure_stage": "path_validator",
                "retry_count": _retry_count(path_validator, query_count_before),
                "response_included": False,
            },
            cause_type=type(error).__name__,
        )

    retry_count = _retry_count(path_validator, query_count_before)
    parsed_reachability = _strict_reachability(output)
    if parsed_reachability is None:
        error = _emit_model_parse_failure(writer, path, retry_count)
        result = ValidationResult(
            run_id=path.run_id,
            candidate_id=path.candidate_id,
            path_id=path.path_id,
            verdict="inconclusive",
            summary="The validator did not return a parseable reachability verdict.",
            reason_codes=[error.code],
            evidence=_public_path_evidence(path),
            retry_count=retry_count,
            validator="PathValidator",
        )
        return _store_and_emit_result(context, writer, result)

    verdict = "reachable" if parsed_reachability else "not_reachable"
    reason_code = (
        "PATH_VALIDATOR_REACHABLE"
        if parsed_reachability
        else "PATH_VALIDATOR_NOT_REACHABLE"
    )
    summary = (
        "The validator reported the selected path as reachable."
        if parsed_reachability
        else "The validator reported the selected path as not reachable."
    )
    result = ValidationResult(
        run_id=path.run_id,
        candidate_id=path.candidate_id,
        path_id=path.path_id,
        verdict=verdict,
        summary=summary,
        reason_codes=[reason_code],
        evidence=_public_path_evidence(path),
        retry_count=retry_count,
        validator="PathValidator",
    )
    return _store_and_emit_result(context, writer, result)


def _rebuild_internal_path(
    context: _RunAnalysisContext,
    path: DataFlowPath,
) -> Tuple[List[Value], Dict[Value, Optional[Function]]]:
    repository_root = (
        Path(context.profile.repository_root).expanduser().resolve(strict=True)
    )
    values: List[Value] = []
    values_to_functions: Dict[Value, Optional[Function]] = {}
    for step in path.steps:
        value = _step_to_value(step, repository_root)
        function = context.analyzer.get_function_from_localvalue(value)
        if step.function_name is not None:
            if function is None or function.function_name != step.function_name:
                raise ValueError("path step function no longer matches analyzer state")
        value = _recover_value_index(context, step, value, function)
        values.append(value)
        values_to_functions[value] = function
    return values, values_to_functions


def _recover_value_index(
    context: _RunAnalysisContext,
    step: DataFlowStep,
    value: Value,
    function: Optional[Function],
) -> Value:
    if function is None or step.kind not in {"argument", "parameter", "return"}:
        return value

    candidates: List[Value] = []
    if step.kind == "parameter":
        candidates.extend(function.paras or set())
    elif step.kind == "return":
        candidates.extend(function.retvals or set())
    else:
        call_sites = list(function.function_call_site_nodes)
        call_sites.extend(function.api_call_site_nodes)
        for call_site in call_sites:
            candidates.extend(
                context.analyzer.get_arguments_at_callsite(function, call_site)
            )

    matches = [
        candidate
        for candidate in candidates
        if candidate.line_number == value.line_number
        and _normalise_value(candidate.name) == _normalise_value(value.name)
    ]
    if not matches:
        return value
    selected = sorted(matches, key=lambda item: (item.index, item.name))[0]
    return Value(
        value.name,
        value.line_number,
        value.label,
        value.file,
        selected.index,
    )


def _step_to_value(step: DataFlowStep, repository_root: Path) -> Value:
    if step.value is None:
        raise ValueError("path step does not contain a public value")
    absolute_path = (repository_root / step.location.relative_path).resolve(strict=True)
    try:
        absolute_path.relative_to(repository_root)
    except ValueError as error:
        raise ValueError("path step escapes the repository root") from error
    if not absolute_path.is_file():
        raise FileNotFoundError("path step source file is not a regular file")
    return Value(
        step.value,
        step.location.start_line,
        _value_label(step.kind),
        str(absolute_path),
    )


def _value_label(kind: str) -> ValueLabel:
    mapping = {
        "source": ValueLabel.SRC,
        "sink": ValueLabel.SINK,
        "argument": ValueLabel.ARG,
        "parameter": ValueLabel.PARA,
        "return": ValueLabel.RET,
        "call_result": ValueLabel.OUT,
        "local_value": ValueLabel.LOCAL,
        "global_value": ValueLabel.GLOBAL,
        "buffer_access": ValueLabel.BUF_ACCESS_EXPR,
        "value_access": ValueLabel.NON_BUF_ACCESS_EXPR,
    }
    try:
        return mapping[kind]
    except KeyError as error:
        raise ValueError(f"unsupported public data-flow step kind: {kind!r}") from error


def _normalise_value(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n").strip()


def _inconclusive_partial_result(path: DataFlowPath) -> ValidationResult:
    return ValidationResult(
        run_id=path.run_id,
        candidate_id=path.candidate_id,
        path_id=path.path_id,
        verdict="inconclusive",
        summary="Partial data-flow paths are not submitted to PathValidator.",
        reason_codes=["PARTIAL_PATH_NOT_VALIDATED"],
        evidence=_public_path_evidence(path),
        retry_count=0,
        validator=None,
    )


def _public_path_evidence(path: DataFlowPath) -> List[str]:
    first = path.steps[0]
    last = path.steps[-1]
    function_names = sorted(
        {step.function_name for step in path.steps if step.function_name is not None}
    )
    return [
        _endpoint_evidence("first path step", first),
        _endpoint_evidence("last path step", last),
        (
            f"Path contains {len(path.steps)} public steps across "
            f"{len(function_names)} functions."
        ),
    ]


def _endpoint_evidence(role: str, step: DataFlowStep) -> str:
    function = "unknown function" if step.function_name is None else step.function_name
    return (
        f"Selected {role} is {step.location.relative_path}:"
        f"{step.location.start_line} in {function}."
    )


def _store_and_emit_result(
    context: _RunAnalysisContext,
    writer: EventWriter,
    result: ValidationResult,
) -> ValidationResult:
    _store_validation_result(context, result)
    writer.emit(
        "path_validated",
        result.run_id,
        candidate_id=result.candidate_id,
        path_id=result.path_id,
        payload={"validation": result},
    )
    return result


def _emit_model_parse_failure(
    writer: EventWriter,
    path: DataFlowPath,
    retry_count: int,
) -> StructuredError:
    error = StructuredError(
        code="MODEL_RESPONSE_PARSE_FAILED",
        message="The validator response could not be parsed after retrying.",
        stage="validate",
        retriable=True,
        details={
            "retry_count": retry_count,
            "response_included": False,
        },
        run_id=path.run_id,
        candidate_id=path.candidate_id,
        path_id=path.path_id,
        cause_type=None,
    )
    writer.write_log("RepoAudit path validation:", error.code)
    writer.emit(
        "analysis_failed",
        path.run_id,
        candidate_id=path.candidate_id,
        path_id=path.path_id,
        payload={"error": error},
    )
    return error


def _query_count(path_validator: object) -> int:
    value = getattr(path_validator, "total_query_num", 0)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        return 0
    return value


def _invoke_without_sensitive_logs(
    path_validator: object, validator_input, output_type
):
    """Invoke the legacy validator while suppressing prompt/response logs."""

    with _VALIDATOR_INVOKE_LOCK:
        logger = getattr(path_validator, "logger", None)
        model = getattr(path_validator, "model", None)
        model_logger = getattr(model, "logger", None) if model is not None else None
        suppressed = _SuppressedModelLogger()
        try:
            if logger is not None:
                path_validator.logger = suppressed
            if model_logger is not None:
                model.logger = suppressed
            return path_validator.invoke(validator_input, output_type)
        finally:
            if logger is not None:
                path_validator.logger = logger
            if model_logger is not None:
                model.logger = model_logger


def _strict_reachability(output: object) -> Optional[bool]:
    if output is None:
        return None
    response = getattr(output, "explanation_str", None)
    if not isinstance(response, str):
        return None
    answers = re.findall(r"Answer:\s*(Yes|No)\b", response, flags=re.IGNORECASE)
    normalised = {answer.lower() for answer in answers}
    if len(normalised) != 1:
        return None
    return normalised.pop() == "yes"


def _retry_count(path_validator: object, query_count_before: int) -> int:
    attempts = max(0, _query_count(path_validator) - query_count_before)
    return max(0, attempts - 1)


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


def _raise_validation_error(
    writer: EventWriter,
    *,
    code: str,
    message: str,
    run_id: Optional[str],
    candidate_id: Optional[str],
    path_id: Optional[str],
    retriable: bool,
    details: Dict[str, object],
    cause_type: Optional[str] = None,
) -> None:
    writer.write_log("RepoAudit path validation:", code)
    error = StructuredError(
        code=code,
        message=message,
        stage="validate",
        retriable=retriable,
        details=details,
        run_id=run_id,
        candidate_id=candidate_id,
        path_id=path_id,
        cause_type=cause_type,
    )
    writer.emit(
        "analysis_failed",
        run_id,
        candidate_id=candidate_id,
        path_id=path_id,
        payload={"error": error},
    )
    raise PathValidationError(error)


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


def _valid_path_id_or_none(value: object) -> Optional[str]:
    try:
        return validate_path_id(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
