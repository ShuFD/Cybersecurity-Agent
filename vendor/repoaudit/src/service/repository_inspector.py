"""Repository inspection service for staged RepoAudit runs.

The service performs source discovery and Tree-sitter analysis only.  It does
not construct an audit agent, invoke an LLM, or start a complete scan.
"""

from __future__ import annotations

import os
from collections import Counter
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple, Type, Union

from tree_sitter import Language, Parser

from protocol import (
    EventWriter,
    RepositoryProfile,
    RunId,
    StructuredError,
    new_run_id,
    validate_run_id,
)
from tstool.analyzer.Cpp_TS_analyzer import Cpp_TSAnalyzer
from tstool.analyzer.Go_TS_analyzer import Go_TSAnalyzer
from tstool.analyzer.Java_TS_analyzer import Java_TSAnalyzer
from tstool.analyzer.Python_TS_analyzer import Python_TSAnalyzer
from tstool.analyzer.TS_analyzer import TSAnalyzer


PathInput = Union[str, os.PathLike[str]]

DEFAULT_MAX_SYMBOLIC_WORKERS = 4

LANGUAGE_SUFFIXES = {
    "Cpp": ("cpp", "cc", "hpp", "c", "h"),
    "Java": ("java",),
    "Python": ("py",),
    "Go": ("go",),
}

SUPPORTED_BUG_TYPES = {
    "Cpp": ("MLK", "NPD", "UAF"),
    "Java": ("NPD",),
    "Python": ("NPD",),
    "Go": ("NPD",),
}

TREE_SITTER_LANGUAGE_NAMES = {
    "Cpp": "cpp",
    "Java": "java",
    "Python": "python",
    "Go": "go",
}

EXCLUDED_DIRECTORY_NAMES = frozenset(
    {
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
        # C/C++
        "CMakeFiles",
        ".deps",
        "Debug",
        "Release",
        "obj",
        # Go
        "vendor",
        "pkg",
    }
)


class _RepositoryParsingMixin:
    """Keep staged inspection diagnostics off the JSONL stdout channel."""

    def _parse_single_file(self, file_path: str, source_code: str) -> Tuple[str, str]:
        tree = self.parser.parse(bytes(source_code, "utf8"))
        self.extract_function_info(file_path, source_code, tree)
        self.extract_global_info(file_path, source_code, tree)
        return file_path, source_code


class _RepositoryCppAnalyzer(_RepositoryParsingMixin, Cpp_TSAnalyzer):
    pass


class _RepositoryJavaAnalyzer(_RepositoryParsingMixin, Java_TSAnalyzer):
    pass


class _RepositoryPythonAnalyzer(_RepositoryParsingMixin, Python_TSAnalyzer):
    pass


class _RepositoryGoAnalyzer(_RepositoryParsingMixin, Go_TSAnalyzer):
    pass


ANALYZER_TYPES: Dict[str, Type[TSAnalyzer]] = {
    "Cpp": _RepositoryCppAnalyzer,
    "Java": _RepositoryJavaAnalyzer,
    "Python": _RepositoryPythonAnalyzer,
    "Go": _RepositoryGoAnalyzer,
}


def inspect_repository(
    project_path: PathInput,
    language: str,
    *,
    run_id: Optional[RunId] = None,
    event_writer: Optional[EventWriter] = None,
    max_symbolic_workers: int = DEFAULT_MAX_SYMBOLIC_WORKERS,
) -> RepositoryProfile:
    """Inspect a repository without invoking an LLM or a complete scan.

    The two-argument form creates a new run ID and writes the resulting
    ``repository_inspected`` event through a default :class:`EventWriter`.
    Callers coordinating multiple stages can pass an existing ``run_id`` and
    writer as keyword-only arguments.
    """

    repository_root = _validate_repository_path(project_path)
    _validate_language(language)
    _validate_worker_count(max_symbolic_workers)

    effective_run_id = new_run_id() if run_id is None else validate_run_id(run_id)
    writer = _resolve_event_writer(event_writer)

    loaded_files, ignored_directories, load_failed_files = _load_source_files(
        repository_root, LANGUAGE_SUFFIXES[language], effective_run_id, writer
    )
    parseable_files, parse_failed_files = _partition_parseable_files(
        repository_root,
        language,
        loaded_files,
        effective_run_id,
        writer,
    )

    function_count = 0
    call_relation_count = 0
    if parseable_files:
        try:
            analyzer = ANALYZER_TYPES[language](
                parseable_files, language, max_symbolic_workers
            )
        except Exception as error:
            _emit_failure(
                writer,
                effective_run_id,
                code="REPOSITORY_ANALYSIS_FAILED",
                message="Repository syntactic analysis failed.",
                cause_type=type(error).__name__,
            )
            raise
        function_count = len(analyzer.function_env)
        call_relation_count = _count_call_relations(analyzer)

    source_files = sorted(
        _relative_path(repository_root, Path(file_path))
        for file_path in parseable_files
    )
    all_failed_files = sorted(load_failed_files | parse_failed_files)
    file_type_counts = dict(
        sorted(Counter(Path(file_path).suffix for file_path in source_files).items())
    )

    profile = RepositoryProfile(
        run_id=effective_run_id,
        repository_root=repository_root.as_posix(),
        language=language,
        source_files=source_files,
        file_type_counts=file_type_counts,
        function_count=function_count,
        call_relation_count=call_relation_count,
        ignored_directories=sorted(ignored_directories),
        parse_failed_files=all_failed_files,
        supported_bug_types=list(SUPPORTED_BUG_TYPES[language]),
    )
    writer.emit(
        "repository_inspected",
        effective_run_id,
        payload={"repository": profile},
    )
    return profile


def _validate_repository_path(project_path: PathInput) -> Path:
    if not isinstance(project_path, (str, os.PathLike)):
        raise TypeError("project_path must be a string or path-like object")
    try:
        repository_root = Path(project_path).expanduser().resolve(strict=True)
    except FileNotFoundError as error:
        raise FileNotFoundError(
            f"Repository path does not exist: {project_path}"
        ) from error
    if not repository_root.is_dir():
        raise NotADirectoryError(f"Repository path is not a directory: {project_path}")
    return repository_root


def _validate_language(language: str) -> None:
    if not isinstance(language, str):
        raise TypeError("language must be a string")
    if language not in LANGUAGE_SUFFIXES:
        supported = ", ".join(LANGUAGE_SUFFIXES)
        raise ValueError(
            f"Unsupported language: {language!r}; expected one of {supported}"
        )


def _validate_worker_count(max_symbolic_workers: int) -> None:
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


def _load_source_files(
    repository_root: Path,
    suffixes: Tuple[str, ...],
    run_id: RunId,
    writer: EventWriter,
) -> Tuple[Dict[str, str], Set[str], Set[str]]:
    code_in_files: Dict[str, str] = {}
    ignored_directories: Set[str] = set()
    failed_files: Set[str] = set()

    def raise_walk_error(error: OSError) -> None:
        raise error

    for root, directories, files in os.walk(repository_root, onerror=raise_walk_error):
        root_path = Path(root)
        directories.sort()
        files.sort()

        included_directories: List[str] = []
        for directory in directories:
            directory_path = root_path / directory
            if directory.startswith(".") or directory in EXCLUDED_DIRECTORY_NAMES:
                ignored_directories.add(_relative_path(repository_root, directory_path))
            else:
                included_directories.append(directory)
        directories[:] = included_directories

        for file_name in files:
            if not file_name.endswith(tuple(f".{suffix}" for suffix in suffixes)):
                continue
            file_path = root_path / file_name
            relative_path = _relative_path(repository_root, file_path)
            try:
                code_in_files[str(file_path)] = file_path.read_text(
                    encoding="utf-8", errors="ignore"
                )
            except OSError as error:
                failed_files.add(relative_path)
                _emit_file_failure(
                    writer,
                    run_id,
                    relative_path,
                    code="SOURCE_READ_FAILED",
                    message="A source file could not be read for inspection.",
                    cause_type=type(error).__name__,
                )

    return code_in_files, ignored_directories, failed_files


def _partition_parseable_files(
    repository_root: Path,
    language: str,
    code_in_files: Dict[str, str],
    run_id: RunId,
    writer: EventWriter,
) -> Tuple[Dict[str, str], Set[str]]:
    if not code_in_files:
        return {}, set()

    parser = _create_parser(language)
    parseable_files: Dict[str, str] = {}
    failed_files: Set[str] = set()
    for file_path, source_code in code_in_files.items():
        relative_path = _relative_path(repository_root, Path(file_path))
        try:
            # Tree-sitter recovery trees containing ERROR nodes remain usable and
            # are not treated as hard parser failures.
            parser.parse(bytes(source_code, "utf8"))
        except Exception as error:
            failed_files.add(relative_path)
            _emit_file_failure(
                writer,
                run_id,
                relative_path,
                code="SOURCE_PARSE_FAILED",
                message="A source file could not be parsed for inspection.",
                cause_type=type(error).__name__,
            )
        else:
            parseable_files[file_path] = source_code
    return parseable_files, failed_files


def _create_parser(language: str) -> Parser:
    language_library = (
        Path(__file__).resolve().parents[2] / "lib" / "build" / "my-languages.so"
    )
    if not language_library.is_file():
        raise FileNotFoundError(
            f"Tree-sitter language library does not exist: {language_library}"
        )
    parser = Parser()
    parser.set_language(
        Language(str(language_library), TREE_SITTER_LANGUAGE_NAMES[language])
    )
    return parser


def _count_call_relations(analyzer: TSAnalyzer) -> int:
    function_relations = sum(
        len(callees) for callees in analyzer.function_caller_callee_map.values()
    )
    api_relations = sum(
        len(callees) for callees in analyzer.function_caller_api_callee_map.values()
    )
    return function_relations + api_relations


def _relative_path(repository_root: Path, path: Path) -> str:
    return path.relative_to(repository_root).as_posix()


def _emit_file_failure(
    writer: EventWriter,
    run_id: RunId,
    relative_path: str,
    *,
    code: str,
    message: str,
    cause_type: str,
) -> None:
    writer.write_log(f"RepoAudit repository inspection: {code} ({relative_path})")
    _emit_failure(
        writer,
        run_id,
        code=code,
        message=message,
        cause_type=cause_type,
        details={"relative_path": relative_path},
    )


def _emit_failure(
    writer: EventWriter,
    run_id: RunId,
    *,
    code: str,
    message: str,
    cause_type: str,
    details: Optional[Dict[str, str]] = None,
) -> None:
    error = StructuredError(
        code=code,
        message=message,
        stage="inspect",
        retriable=False,
        details={} if details is None else details,
        run_id=run_id,
        cause_type=cause_type,
    )
    writer.emit("analysis_failed", run_id, payload={"error": error})
