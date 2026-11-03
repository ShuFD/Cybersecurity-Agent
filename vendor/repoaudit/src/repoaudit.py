import argparse
import glob
import json
import math
import os
import sys
import threading
from dataclasses import replace
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from agent.dfbscan import *
from agent.dfbscan import _TeeEventStream
from agent.metascan import *
from llmtool.dfbscan.intra_dataflow_analyzer import IntraDataFlowAnalyzer
from llmtool.dfbscan.path_validator import PathValidator
from protocol import (
    AnalysisEvent,
    AuditCandidate,
    AuditRun,
    DataFlowPath,
    EventWriter,
    RepositoryProfile,
    StructuredError,
    new_run_id,
    utc_now,
    validate_candidate_id,
    validate_path_id,
    validate_run_id,
)
from service import (
    analyze_candidate,
    extract_candidates,
    inspect_repository,
    validate_path,
)
from service.analysis_service import (
    CandidateAnalysisError,
    _load_candidate_context,
    _register_candidate_batch,
)
from service.candidate_service import _load_profile_sources, _resolve_repository_root
from service.repository_inspector import ANALYZER_TYPES
from service.validation_service import PathValidationError
from storage import RunStore, RunStoreError
from tstool.analyzer.Cpp_TS_analyzer import *
from tstool.analyzer.Go_TS_analyzer import *
from tstool.analyzer.Java_TS_analyzer import *
from tstool.analyzer.Python_TS_analyzer import *
from tstool.analyzer.TS_analyzer import *


default_dfbscan_checkers = {
    "Cpp": ["MLK", "NPD", "UAF"],
    "Java": ["NPD"],
    "Python": ["NPD"],
    "Go": ["NPD"],
}

STAGED_COMMANDS = frozenset(
    {"inspect", "candidates", "analyze", "validate", "full-scan"}
)


class RepoAudit:
    def __init__(
        self,
        args: argparse.Namespace,
    ):
        """
        Initialize BatchScan object with project details.
        """
        # argument format check
        self.args = args
        self.dfb_engine = getattr(args, "dfb_engine", "legacy")
        is_input_valid, error_messages = self.validate_inputs()

        if not is_input_valid:
            print("\n".join(error_messages))
            exit(1)

        self.project_path = args.project_path
        self.language = args.language
        self.code_in_files: Dict[str, str] = {}

        self.model_name = args.model_name
        self.temperature = args.temperature
        self.call_depth = args.call_depth
        self.max_symbolic_workers = args.max_symbolic_workers
        self.max_neural_workers = args.max_neural_workers
        supplied_run_id = getattr(args, "run_id", None)
        self.run_id = (
            None if supplied_run_id is None else validate_run_id(supplied_run_id)
        )

        self.bug_type = args.bug_type
        self.is_reachable = args.is_reachable

        self.ts_analyzer: Optional[TSAnalyzer] = None
        if self.args.scan_type == "dfbscan" and self.dfb_engine == "staged":
            return

        suffixs = []
        if self.language == "Cpp":
            suffixs = ["cpp", "cc", "hpp", "c", "h"]
        elif self.language == "Go":
            suffixs = ["go"]
        elif self.language == "Java":
            suffixs = ["java"]
        elif self.language == "Python":
            suffixs = ["py"]
        else:
            raise ValueError("Invalid language setting")

        # Load all files with the specified suffix in the project path
        self.traverse_files(self.project_path, suffixs)

        if self.language == "Cpp":
            self.ts_analyzer = Cpp_TSAnalyzer(
                self.code_in_files, self.language, self.max_symbolic_workers
            )
        elif self.language == "Go":
            self.ts_analyzer = Go_TSAnalyzer(
                self.code_in_files, self.language, self.max_symbolic_workers
            )
        elif self.language == "Java":
            self.ts_analyzer = Java_TSAnalyzer(
                self.code_in_files, self.language, self.max_symbolic_workers
            )
        elif self.language == "Python":
            self.ts_analyzer = Python_TSAnalyzer(
                self.code_in_files, self.language, self.max_symbolic_workers
            )
        return

    def start_repo_auditing(self) -> None:
        """
        Start the batch scan process.
        """
        self._emit_progress("scan_started")
        if self.args.scan_type == "metascan":
            assert self.ts_analyzer is not None
            metascan_pipeline = MetaScanAgent(
                self.project_path,
                self.language,
                self.ts_analyzer,
            )
            metascan_pipeline.start_scan()

        if self.args.scan_type == "dfbscan":
            if self.dfb_engine == "staged":
                run_full_scan(
                    self.project_path,
                    self.language,
                    self.bug_type,
                    self.model_name,
                    is_reachable=self.is_reachable,
                    temperature=self.temperature,
                    call_depth=self.call_depth,
                    max_symbolic_workers=self.max_symbolic_workers,
                    max_neural_workers=self.max_neural_workers,
                    run_id=self.run_id,
                )
                return
            assert self.ts_analyzer is not None
            dfbscan_agent = DFBScanAgent(
                self.bug_type,
                self.is_reachable,
                self.project_path,
                self.language,
                self.ts_analyzer,
                self.model_name,
                self.temperature,
                self.call_depth,
                self.max_neural_workers,
                run_id=self.run_id,
            )
            dfbscan_agent.start_scan()
        self._emit_progress("scan_completed")
        return

    def _emit_progress(self, stage: str) -> None:
        if self.run_id is None:
            return
        print(
            json.dumps(
                {
                    "repoaudit_progress": {
                        "run_id": self.run_id,
                        "stage": stage,
                    }
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            flush=True,
        )

    def traverse_files(self, project_path: str, suffixs: List) -> None:
        """
        Traverse all files in the project path.
        """
        for root, dirs, files in os.walk(project_path):
            excluded_dirs = {
                # Common
                ".git",
                ".vscode",
                ".idea",
                "build",
                "dist",
                "out",
                "bin",
                # Python
                "__pycache__",
                ".pytest_cache",
                ".mypy_cache",
                ".coverage",
                "venv",
                "env",
                # Java
                "target",
                ".gradle",
                ".m2",
                ".settings",
                "classes",
                # C++
                "CMakeFiles",
                ".deps",
                "Debug",
                "Release",
                "obj",
                # Go
                "vendor",
                "pkg",
            }
            dirs[:] = [
                d for d in dirs if not d.startswith(".") and d not in excluded_dirs
            ]

            for file in files:
                if any(file.endswith(f".{suffix}") for suffix in suffixs):
                    file_path = os.path.join(root, file)
                    # if "test" in file_path.lower() or "example" in file_path.lower():
                    #     continue

                    try:
                        with open(
                            file_path, "r", encoding="utf-8", errors="ignore"
                        ) as source_file:
                            source_file_content = source_file.read()
                            self.code_in_files[file_path] = source_file_content
                    except Exception as e:
                        print(f"Error reading file {file_path}: {e}")
        return

    def validate_inputs(self) -> Tuple[bool, List[str]]:
        err_messages = []

        # For each scan type, check required parameters.
        if self.args.scan_type == "dfbscan":
            if self.dfb_engine not in {"legacy", "staged"}:
                err_messages.append("Error: Invalid DFB engine provided.")
            if not self.args.model_name:
                err_messages.append("Error: --model-name is required for dfbscan.")
            if not self.args.bug_type:
                err_messages.append("Error: --bug -type is required for dfbscan.")
            if self.args.bug_type not in default_dfbscan_checkers[self.args.language]:
                err_messages.append("Error: Invalid bug type provided.")
        elif self.args.scan_type == "metascan":
            return (True, [])
        else:
            err_messages.append("Error: Unknown scan type provided.")
        return (len(err_messages) == 0, err_messages)


class _SilentToolLogger:
    """Keep staged model prompts and raw responses out of CLI output."""

    def print_log(self, *args: object) -> None:
        return None

    def print_console(self, *args: object) -> None:
        return None


class _CliEventWriter(EventWriter):
    """Continue a persisted event sequence and retain newly emitted events."""

    def __init__(self, event_stream, initial_sequence: int) -> None:
        super().__init__(event_stream=event_stream, log_stream=sys.stderr)
        self._sequence = initial_sequence
        self.events: List[AnalysisEvent] = []
        self._record_lock = threading.Lock()

    def emit(
        self,
        event_type: str,
        run_id: Optional[str],
        payload: Optional[Dict[str, object]] = None,
        candidate_id: Optional[str] = None,
        path_id: Optional[str] = None,
    ) -> AnalysisEvent:
        event = super().emit(
            event_type,
            run_id,
            payload=payload,
            candidate_id=candidate_id,
            path_id=path_id,
        )
        with self._record_lock:
            self.events.append(event)
        return event


class _CliCommandFailed(RuntimeError):
    def __init__(self, error: StructuredError, emitted: bool = False) -> None:
        super().__init__(error.message)
        self.error = error
        self.emitted = emitted


class _RunEventSession:
    """Append one CLI stage to stdout and the run's durable event stream."""

    def __init__(self, store: RunStore, run_id: str) -> None:
        self.store = store
        self.run_id = validate_run_id(run_id)
        self.stream: Optional[_TeeEventStream] = None

    def __enter__(self) -> _CliEventWriter:
        events = self.store.load_events(self.run_id)
        initial_sequence = events[-1].sequence if events else 0
        event_file = self.store.root / self.run_id / "events.jsonl"
        self.stream = _TeeEventStream(sys.stdout, event_file)
        self.stream.__enter__()
        if self.stream.open_error is not None:
            self.stream.__exit__(None, None, None)
            raise self.stream.open_error
        return _CliEventWriter(self.stream, initial_sequence)

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        if self.stream is None:
            return
        self.stream.__exit__(exc_type, exc_value, traceback)
        if exc_value is None and self.stream.mirror_error is not None:
            raise self.stream.mirror_error


def _configure_legacy_args(argv: Optional[Sequence[str]] = None):
    parser = argparse.ArgumentParser(
        description="RepoAudit: Run metascan or dfbscan on a project."
    )
    parser.add_argument(
        "--scan-type",
        required=True,
        choices=["metascan", "dfbscan"],
        help="The type of scan to perform.",
    )
    # Common parameters of metascan and dfbscan
    parser.add_argument("--project-path", required=True, help="Project path")
    parser.add_argument("--language", required=True, help="Programming language")
    parser.add_argument(
        "--max-symbolic-workers",
        type=int,
        default=4,
        help="Max symbolic workers for parsing-based analysis",
    )

    # Common parameters for dfbscan
    parser.add_argument("--model-name", help="The name of LLMs")
    parser.add_argument(
        "--temperature", type=float, default=0.5, help="Temperature for inference"
    )
    parser.add_argument("--call-depth", type=int, default=3, help="Call depth setting")
    parser.add_argument(
        "--max-neural-workers",
        type=int,
        default=1,
        help="Max neural workers for prompting-based analysis",
    )
    parser.add_argument("--bug-type", help="Bug type for dfbscan)")
    parser.add_argument(
        "--is-reachable", action="store_true", help="Flag for bugscan reachability"
    )
    parser.add_argument(
        "--dfb-engine",
        choices=["legacy", "staged"],
        default="legacy",
        help="DFB engine implementation; legacy preserves the original behavior",
    )
    parser.add_argument(
        "--run-id",
        help="Optional run_<uuid> identifier used for isolated runtime artifacts.",
    )
    return parser.parse_args(argv)


def _add_output_format(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--output-format",
        choices=["jsonl"],
        default="jsonl",
        help="Write the structured event stream as JSON Lines (JSONL).",
    )


def _add_model_options(
    parser: argparse.ArgumentParser, *, include_call_depth: bool = False
) -> None:
    parser.add_argument(
        "--model-name", required=True, help="LLM name used by this neural stage."
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.5,
        help="Inference temperature (default: 0.5).",
    )
    if include_call_depth:
        parser.add_argument(
            "--call-depth",
            type=int,
            default=3,
            help="Maximum interprocedural call depth (default: 3).",
        )


def _add_symbolic_workers(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--max-symbolic-workers",
        type=int,
        default=4,
        help="Workers used to rebuild syntactic context (default: 4).",
    )


def _configure_staged_args(argv: Sequence[str]):
    parser = argparse.ArgumentParser(
        prog="repoaudit",
        description="Run one persisted RepoAudit stage or a complete staged scan.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    inspect_parser = subparsers.add_parser(
        "inspect",
        help="Inspect a repository without invoking an LLM or vulnerability scan.",
        description="Inspect a repository, create a run, and save its public profile.",
    )
    inspect_parser.add_argument(
        "--project-path", required=True, help="Repository path."
    )
    inspect_parser.add_argument(
        "--language",
        required=True,
        choices=list(default_dfbscan_checkers),
        help="Repository language.",
    )
    _add_symbolic_workers(inspect_parser)
    _add_output_format(inspect_parser)

    candidates_parser = subparsers.add_parser(
        "candidates",
        help="Generate and persist candidates for an inspected run.",
        description="Load a profile by run ID and persist one candidate superset.",
    )
    candidates_parser.add_argument("--run-id", required=True, help="Persisted run ID.")
    candidates_parser.add_argument(
        "--bug-type", required=True, help="Vulnerability type to extract."
    )
    _add_symbolic_workers(candidates_parser)
    _add_output_format(candidates_parser)

    analyze_parser = subparsers.add_parser(
        "analyze",
        help="Analyze one persisted candidate by ID.",
        description="Rebuild context and analyze only the requested candidate.",
    )
    analyze_parser.add_argument("--run-id", required=True, help="Persisted run ID.")
    analyze_parser.add_argument(
        "--candidate-id", required=True, help="Candidate ID within the run."
    )
    _add_model_options(analyze_parser, include_call_depth=True)
    _add_symbolic_workers(analyze_parser)
    _add_output_format(analyze_parser)

    validate_parser = subparsers.add_parser(
        "validate",
        help="Validate one persisted data-flow path by ID.",
        description="Restore one path without rerunning candidate analysis.",
    )
    validate_parser.add_argument("--run-id", required=True, help="Persisted run ID.")
    validate_parser.add_argument(
        "--candidate-id", required=True, help="Candidate ID within the run."
    )
    validate_parser.add_argument(
        "--path-id", required=True, help="Path ID within the candidate."
    )
    _add_model_options(validate_parser)
    _add_symbolic_workers(validate_parser)
    _add_output_format(validate_parser)

    full_scan_parser = subparsers.add_parser(
        "full-scan",
        help="Run the complete staged inspection-to-validation pipeline.",
        description=(
            "Run the staged engine and retain the legacy detect_info.json artifact. "
            "Use the option-based syntax to select the old engine."
        ),
    )
    full_scan_parser.add_argument(
        "--project-path", required=True, help="Repository path."
    )
    full_scan_parser.add_argument(
        "--run-id", help="Optional run_<uuid> identifier supplied by an orchestrator."
    )
    full_scan_parser.add_argument(
        "--language",
        required=True,
        choices=list(default_dfbscan_checkers),
        help="Repository language.",
    )
    full_scan_parser.add_argument(
        "--bug-type", required=True, help="Vulnerability type to scan."
    )
    _add_model_options(full_scan_parser, include_call_depth=True)
    _add_symbolic_workers(full_scan_parser)
    full_scan_parser.add_argument(
        "--max-neural-workers",
        type=int,
        default=1,
        help="Maximum neural workers (default: 1).",
    )
    full_scan_parser.add_argument(
        "--is-reachable",
        action="store_true",
        help="Treat reachable paths as findings instead of unreachable paths.",
    )
    _add_output_format(full_scan_parser)
    return parser.parse_args(argv)


def configure_args(argv: Optional[Sequence[str]] = None):
    effective_argv = list(sys.argv[1:] if argv is None else argv)
    if effective_argv and effective_argv[0] in STAGED_COMMANDS:
        return _configure_staged_args(effective_argv)
    return _configure_legacy_args(effective_argv)


def _validate_id_or_fail(
    value: str,
    field_name: str,
    *,
    run_id: Optional[str] = None,
    candidate_id: Optional[str] = None,
) -> str:
    validators = {
        "run_id": validate_run_id,
        "candidate_id": validate_candidate_id,
        "path_id": validate_path_id,
    }
    try:
        return validators[field_name](value)
    except (TypeError, ValueError) as error:
        raise _CliCommandFailed(
            StructuredError(
                code=f"INVALID_{field_name.upper()}",
                message=f"The supplied {field_name} is invalid.",
                stage="cli",
                retriable=False,
                details={"field": field_name},
                run_id=run_id,
                candidate_id=candidate_id,
                cause_type=type(error).__name__,
            )
        ) from error


def _validate_neural_options(args: argparse.Namespace) -> None:
    if not isinstance(args.model_name, str) or not args.model_name.strip():
        raise ValueError("model_name must be a non-empty string")
    if not math.isfinite(args.temperature):
        raise ValueError("temperature must be finite")
    if hasattr(args, "call_depth") and args.call_depth < 0:
        raise ValueError("call_depth must be a non-negative integer")


def _updated_run(
    run: AuditRun,
    stage: str,
    *,
    bug_type: Optional[str] = None,
    error_ids: Optional[List[str]] = None,
) -> AuditRun:
    return replace(
        run,
        stage=stage,
        status="running",
        bug_type=run.bug_type if bug_type is None else bug_type,
        updated_at=utc_now(),
        completed_at=None,
        error_ids=list(run.error_ids if error_ids is None else error_ids),
    )


def _require_resumable_run(run: AuditRun) -> None:
    if run.status != "running":
        raise _CliCommandFailed(
            StructuredError(
                code="RUN_NOT_RESUMABLE",
                message="The requested run is not available for another stage.",
                stage="cli",
                run_id=run.run_id,
                retriable=False,
                details={"status": run.status},
            )
        )


def _restore_analysis_context(
    store: RunStore,
    run_id: str,
    writer: EventWriter,
    max_symbolic_workers: int,
) -> Tuple[RepositoryProfile, List[AuditCandidate]]:
    profile = store.load_repository(run_id)
    candidates = store.load_candidates(run_id)
    repository_root = _resolve_repository_root(profile.repository_root)
    code_in_files = _load_profile_sources(profile, repository_root)
    if not code_in_files:
        raise RuntimeError("Persisted repository profile contains no source files")
    analyzer = ANALYZER_TYPES[profile.language](
        code_in_files, profile.language, max_symbolic_workers
    )
    _register_candidate_batch(profile, analyzer, candidates, writer)
    return profile, candidates


def _find_candidate(
    candidates: Sequence[AuditCandidate], candidate_id: str, run_id: str
) -> AuditCandidate:
    for candidate in candidates:
        if candidate.candidate_id == candidate_id:
            return candidate
    raise _CliCommandFailed(
        StructuredError(
            code="CANDIDATE_NOT_FOUND",
            message="The requested candidate was not found in this run.",
            stage="cli",
            run_id=run_id,
            candidate_id=candidate_id,
            retriable=False,
            details={"failure_stage": "candidate_load"},
        )
    )


def _find_path(
    paths: Sequence[DataFlowPath], candidate_id: str, path_id: str, run_id: str
) -> DataFlowPath:
    for path in paths:
        if path.candidate_id == candidate_id and path.path_id == path_id:
            return path
    raise _CliCommandFailed(
        StructuredError(
            code="PATH_NOT_FOUND",
            message="The requested path was not found for this candidate.",
            stage="cli",
            run_id=run_id,
            candidate_id=candidate_id,
            path_id=path_id,
            retriable=False,
            details={"failure_stage": "path_load"},
        )
    )


def _error_from_exception(
    error: BaseException,
    stage: str,
    *,
    run_id: Optional[str] = None,
    candidate_id: Optional[str] = None,
    path_id: Optional[str] = None,
) -> StructuredError:
    if isinstance(error, _CliCommandFailed):
        return error.error
    if isinstance(error, (RunStoreError, CandidateAnalysisError, PathValidationError)):
        return error.error
    return StructuredError(
        code=f"CLI_{stage.upper().replace('-', '_')}_FAILED",
        message=f"The {stage} command failed.",
        stage="cli",
        run_id=run_id,
        candidate_id=candidate_id,
        path_id=path_id,
        retriable=False,
        details={"failure_stage": stage},
        cause_type=type(error).__name__,
    )


def _writer_has_error(writer: _CliEventWriter, error_id: str) -> bool:
    for event in writer.events:
        error = event.payload.get("error")
        if isinstance(error, StructuredError) and error.error_id == error_id:
            return True
    return False


def _persist_event_errors(
    store: RunStore, run: AuditRun, writer: _CliEventWriter
) -> AuditRun:
    by_id = {error.error_id: error for error in store.load_errors(run.run_id)}
    for event in writer.events:
        error = event.payload.get("error")
        if isinstance(error, StructuredError):
            by_id[error.error_id] = error
    store.save_errors(run.run_id, list(by_id.values()))
    error_ids = sorted(by_id)
    if error_ids != sorted(run.error_ids):
        run = replace(run, error_ids=error_ids, updated_at=utc_now())
        store.save_run(run)
    return run


def _run_existing_stage(store: RunStore, run: AuditRun, stage: str, operation):
    run = _updated_run(run, stage)
    store.save_run(run)
    with _RunEventSession(store, run.run_id) as writer:
        try:
            result = operation(writer)
        except Exception as exception:
            error = _error_from_exception(exception, stage, run_id=run.run_id)
            if not _writer_has_error(writer, error.error_id):
                writer.emit("analysis_failed", run.run_id, payload={"error": error})
            _persist_event_errors(store, run, writer)
            raise _CliCommandFailed(error, emitted=True) from exception
        _persist_event_errors(store, run, writer)
        return result


def _run_inspect_command(args: argparse.Namespace) -> int:
    repository_root = Path(args.project_path).expanduser().resolve(strict=True)
    if not repository_root.is_dir():
        raise NotADirectoryError("project_path must resolve to a directory")
    run = AuditRun(
        run_id=new_run_id(),
        repository_root=repository_root.as_posix(),
        language=args.language,
        stage="inspect",
        status="running",
    )
    store = RunStore()
    store.create_run(run)
    with _RunEventSession(store, run.run_id) as writer:
        try:
            writer.emit("run_started", run.run_id, payload={"run": run})
            profile = inspect_repository(
                repository_root,
                args.language,
                run_id=run.run_id,
                event_writer=writer,
                max_symbolic_workers=args.max_symbolic_workers,
            )
            store.save_repository(profile)
            store.save_run(run)
        except Exception as exception:
            error = _error_from_exception(exception, "inspect", run_id=run.run_id)
            if not _writer_has_error(writer, error.error_id):
                writer.emit("analysis_failed", run.run_id, payload={"error": error})
            _persist_event_errors(store, run, writer)
            raise _CliCommandFailed(error, emitted=True) from exception
        _persist_event_errors(store, run, writer)
    return 0


def _run_candidates_command(args: argparse.Namespace) -> int:
    run_id = _validate_id_or_fail(args.run_id, "run_id")
    store = RunStore()
    run = store.load_run(run_id)
    _require_resumable_run(run)
    if run.bug_type is not None and run.bug_type != args.bug_type:
        raise _CliCommandFailed(
            StructuredError(
                code="RUN_BUG_TYPE_CONFLICT",
                message="The run is already associated with another bug type.",
                stage="cli",
                run_id=run_id,
                retriable=False,
                details={"existing_bug_type": run.bug_type},
            )
        )
    if store.load_paths(run_id):
        raise _CliCommandFailed(
            StructuredError(
                code="RUN_STAGE_CONFLICT",
                message="Candidates cannot be regenerated after paths are persisted.",
                stage="cli",
                run_id=run_id,
                retriable=False,
                details={"stage": "candidates"},
            )
        )

    def operation(writer: EventWriter):
        profile = store.load_repository(run_id)
        candidates = extract_candidates(
            profile,
            args.bug_type,
            event_writer=writer,
            max_symbolic_workers=args.max_symbolic_workers,
        )
        store.save_candidates(run_id, candidates)
        store.save_run(_updated_run(run, "candidates", bug_type=args.bug_type))
        writer.write_log(
            "RepoAudit staged candidates saved:", len(candidates), "run_id:", run_id
        )
        return candidates

    _run_existing_stage(store, run, "candidates", operation)
    return 0


def _run_analyze_command(args: argparse.Namespace) -> int:
    run_id = _validate_id_or_fail(args.run_id, "run_id")
    candidate_id = _validate_id_or_fail(
        args.candidate_id, "candidate_id", run_id=run_id
    )
    _validate_neural_options(args)
    store = RunStore()
    run = store.load_run(run_id)
    _require_resumable_run(run)
    _find_candidate(store.load_candidates(run_id), candidate_id, run_id)
    if any(
        result.candidate_id == candidate_id for result in store.load_validations(run_id)
    ):
        raise _CliCommandFailed(
            StructuredError(
                code="RUN_STAGE_CONFLICT",
                message="A validated candidate cannot be analyzed again in place.",
                stage="cli",
                run_id=run_id,
                candidate_id=candidate_id,
                retriable=False,
                details={"stage": "analyze"},
            )
        )

    def operation(writer: EventWriter):
        _, candidates = _restore_analysis_context(
            store, run_id, writer, args.max_symbolic_workers
        )
        _find_candidate(candidates, candidate_id, run_id)
        intra_analyzer = IntraDataFlowAnalyzer(
            args.model_name,
            args.temperature,
            run.language,
            5,
            _SilentToolLogger(),
        )
        paths = analyze_candidate(
            run_id,
            candidate_id,
            intra_dataflow_analyzer=intra_analyzer,
            event_writer=writer,
            call_depth=args.call_depth,
        )
        existing = [
            path
            for path in store.load_paths(run_id)
            if path.candidate_id != candidate_id
        ]
        store.save_paths(run_id, [*existing, *paths])
        writer.write_log(
            "RepoAudit staged paths saved:", len(paths), "candidate_id:", candidate_id
        )
        return paths

    _run_existing_stage(store, run, "analyze", operation)
    return 0


def _run_validate_command(args: argparse.Namespace) -> int:
    run_id = _validate_id_or_fail(args.run_id, "run_id")
    candidate_id = _validate_id_or_fail(
        args.candidate_id, "candidate_id", run_id=run_id
    )
    path_id = _validate_id_or_fail(
        args.path_id,
        "path_id",
        run_id=run_id,
        candidate_id=candidate_id,
    )
    _validate_neural_options(args)
    store = RunStore()
    run = store.load_run(run_id)
    _require_resumable_run(run)
    _find_candidate(store.load_candidates(run_id), candidate_id, run_id)
    target_path = _find_path(store.load_paths(run_id), candidate_id, path_id, run_id)

    def operation(writer: EventWriter):
        _restore_analysis_context(store, run_id, writer, args.max_symbolic_workers)
        context, _ = _load_candidate_context(run_id, candidate_id)
        context.paths.setdefault(candidate_id, {})[path_id] = target_path
        path_validator = PathValidator(
            args.model_name,
            args.temperature,
            run.language,
            5,
            _SilentToolLogger(),
        )
        result = validate_path(
            run_id,
            candidate_id,
            path_id,
            path_validator=path_validator,
            event_writer=writer,
        )
        existing = [
            validation
            for validation in store.load_validations(run_id)
            if validation.path_id != path_id
        ]
        store.save_validations(run_id, [*existing, result])
        return result

    _run_existing_stage(store, run, "validate", operation)
    return 0


def _run_full_scan_command(args: argparse.Namespace) -> int:
    _validate_neural_options(args)
    run = run_full_scan(
        args.project_path,
        args.language,
        args.bug_type,
        args.model_name,
        is_reachable=args.is_reachable,
        temperature=args.temperature,
        call_depth=args.call_depth,
        max_symbolic_workers=args.max_symbolic_workers,
        max_neural_workers=args.max_neural_workers,
        run_id=args.run_id,
    )
    return 0 if run.status == "completed" else 1


def _emit_cli_error(error: StructuredError) -> None:
    if error.run_id is not None:
        emitted = False
        try:
            store = RunStore()
            run = store.load_run(error.run_id)
            with _RunEventSession(store, error.run_id) as writer:
                writer.emit(
                    "analysis_failed",
                    error.run_id,
                    payload={"error": error},
                    candidate_id=error.candidate_id,
                    path_id=error.path_id,
                )
                emitted = True
                _persist_event_errors(store, run, writer)
            return
        except Exception:
            if emitted:
                return
    EventWriter().emit(
        "analysis_failed",
        error.run_id,
        payload={"error": error},
        candidate_id=error.candidate_id,
        path_id=error.path_id,
    )


def _valid_id_or_none(value, validator):
    if not isinstance(value, str):
        return None
    try:
        return validator(value)
    except (TypeError, ValueError):
        return None


def _run_staged_command(args: argparse.Namespace) -> int:
    handlers = {
        "inspect": _run_inspect_command,
        "candidates": _run_candidates_command,
        "analyze": _run_analyze_command,
        "validate": _run_validate_command,
        "full-scan": _run_full_scan_command,
    }
    try:
        return handlers[args.command](args)
    except _CliCommandFailed as error:
        if not error.emitted:
            _emit_cli_error(error.error)
        return 1
    except (RunStoreError, CandidateAnalysisError, PathValidationError) as error:
        _emit_cli_error(error.error)
        return 1
    except Exception as error:
        run_id = _valid_id_or_none(getattr(args, "run_id", None), validate_run_id)
        candidate_id = _valid_id_or_none(
            getattr(args, "candidate_id", None), validate_candidate_id
        )
        path_id = _valid_id_or_none(getattr(args, "path_id", None), validate_path_id)
        _emit_cli_error(
            _error_from_exception(
                error,
                args.command,
                run_id=run_id,
                candidate_id=candidate_id if run_id is not None else None,
                path_id=(
                    path_id if run_id is not None and candidate_id is not None else None
                ),
            )
        )
        return 1


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = configure_args(argv)
    if hasattr(args, "command"):
        return _run_staged_command(args)
    repoaudit = RepoAudit(args)
    repoaudit.start_repo_auditing()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
