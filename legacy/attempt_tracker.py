import hashlib
import json
import math
import os
import re
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional


SCHEMA_VERSION = 2
MAX_LEDGER_PREVIEW_CHARS = 4000
MAX_KNOWN_RESULTS = 512
MAX_DIRECTORY_STATE_ENTRIES = 1024

_INTERNAL_ARG_KEYS = {"_index", "_tool_num", "tool_call_id", "tool_use_id"}
_SECRET_KEY_RE = re.compile(
    r"(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key)",
    re.IGNORECASE,
)
_CONTENT_KEYS = {
    "code",
    "content",
    "effective_code",
    "effective_content",
    "effective_script",
    "script",
}
_SECRET_TEXT_PATTERNS = (
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/-]+=*"),
    re.compile(r"(?i)((?:api[_-]?key|password|passwd|secret|token)\s*[:=]\s*)\S+"),
)
_PATH_KEYS = {
    "path",
    "file",
    "filename",
    "file_path",
    "directory",
    "dir",
    "cwd",
    "root",
    "project_root",
    "output_path",
    "input_path",
    "source_path",
    "destination_path",
}
_UNTRACKED_TOOLS = {
    "no_tool",
    "bad_json",
    "ask_user",
    "task_output",
    "task_stop",
    "mcp_refresh",
    "exit_plan_mode",
    "update_working_checkpoint",
    "start_long_term_update",
}
_STABLE_WORKING_KEYS = {
    "key_info",
    "related_sop",
    "in_plan_mode",
    "web_verbs",
    "tool_experience",
}
_VOLATILE_ENTRY_NAMES = {
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "__pycache__",
    "attempt_ledgers",
    "dist",
    "model_responses",
    "node_modules",
    "tool_results",
    "venv",
}
_TRACKER_INIT_LOCK = threading.Lock()


def _canonicalize(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, bytes):
        return {"bytes_sha256": hashlib.sha256(value).hexdigest(), "size": len(value)}
    if isinstance(value, dict):
        return {
            str(key): _canonicalize(item)
            for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
        }
    if isinstance(value, (list, tuple)):
        return [_canonicalize(item) for item in value]
    if isinstance(value, (set, frozenset)):
        items = [_canonicalize(item) for item in value]
        return sorted(items, key=_canonical_json)
    if isinstance(value, Path):
        return str(value)
    return {"type": type(value).__name__, "repr": repr(value)}


def _canonical_json(value: Any) -> str:
    return json.dumps(_canonicalize(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def fingerprint(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _extract_last_code_block(text: str, languages: Optional[str] = None) -> Optional[str]:
    language_pattern = languages or r"[^\n]*"
    matches = re.findall(rf"```(?:{language_pattern})\n([\s\S]*?)```", str(text or ""), re.IGNORECASE)
    return matches[-1].strip() if matches else None


def _extract_file_content(text: str) -> Optional[str]:
    tags = re.findall(r"<file_content[^>]*>(.*?)</file_content>", str(text or ""), re.DOTALL)
    if tags:
        return tags[-1].strip()
    return _extract_last_code_block(text)


def canonical_operation(handler, tool_name: str, args: dict, response=None) -> dict:
    clean_args = {
        str(key): value
        for key, value in dict(args or {}).items()
        if str(key) not in _INTERNAL_ARG_KEYS and not str(key).startswith("_")
    }
    response_text = str(getattr(response, "content", "") or "")
    if tool_name == "code_run" and not (clean_args.get("code") or clean_args.get("script")):
        code_type = str(clean_args.get("type") or "python")
        languages = {
            "python": r"python|py",
            "powershell": r"powershell|ps1|pwsh",
            "bash": r"bash|sh|shell",
        }.get(code_type, re.escape(code_type))
        effective_code = _extract_last_code_block(response_text, languages)
        if effective_code is not None:
            clean_args["effective_code"] = effective_code
    elif tool_name == "file_write" and not clean_args.get("content"):
        effective_content = _extract_file_content(response_text)
        if effective_content is not None:
            clean_args["effective_content"] = effective_content
    elif tool_name == "web_execute_js" and not clean_args.get("script"):
        effective_script = _extract_last_code_block(response_text, r"javascript|js")
        if effective_script is not None:
            clean_args["effective_script"] = effective_script
    return {"tool": str(tool_name or ""), "args": _canonicalize(clean_args)}


def _secret_marker(value: Any) -> str:
    return f"<redacted sha256:{fingerprint(value)[:12]}>"


def _redact_text(value: str) -> str:
    redacted = str(value)
    for pattern in _SECRET_TEXT_PATTERNS:
        redacted = pattern.sub(r"\1<redacted>", redacted)
    return redacted


def _ledger_preview(value: Any, key: str = "") -> Any:
    if key and _SECRET_KEY_RE.search(key):
        return _secret_marker(value)
    if key in _CONTENT_KEYS:
        return f"<content sha256:{fingerprint(value)[:12]} chars:{len(str(value))}>"
    if isinstance(value, dict):
        return {str(k): _ledger_preview(v, str(k)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_ledger_preview(item) for item in value]
    if isinstance(value, str) and len(value) > MAX_LEDGER_PREVIEW_CHARS:
        value = value[:MAX_LEDGER_PREVIEW_CHARS] + f"...[{len(value)} chars]"
    if isinstance(value, str):
        return _redact_text(value)
    return _canonicalize(value)


def _ledger_state(state: dict) -> dict:
    public = dict(state or {})
    working = public.get("working") or {}
    public["working"] = {
        "keys": sorted(str(key) for key in working),
        "fingerprint": fingerprint(working),
    }
    return _ledger_preview(public)


def _normalize_path(handler, raw_path: str) -> Optional[str]:
    text = str(raw_path or "").strip()
    if not text or re.match(r"^[a-z][a-z0-9+.-]*://", text, re.IGNORECASE):
        return None
    try:
        path = Path(text).expanduser()
        if not path.is_absolute():
            path = Path(getattr(handler, "cwd", None) or ".") / path
        return str(path.resolve(strict=False))
    except (OSError, RuntimeError, ValueError):
        return None


def _collect_resource_paths(handler, args: Any) -> list[str]:
    paths = set()

    def collect(value: Any, key: str = ""):
        if isinstance(value, dict):
            for child_key, child_value in value.items():
                collect(child_value, str(child_key).lower())
        elif isinstance(value, (list, tuple)):
            for child in value:
                collect(child, key)
        elif isinstance(value, str) and key in _PATH_KEYS:
            normalized = _normalize_path(handler, value)
            if normalized:
                paths.add(normalized)

    collect(args or {})
    cwd = _normalize_path(handler, getattr(handler, "cwd", None) or ".")
    if cwd:
        paths.add(cwd)
    for path in (getattr(handler, "_read_file_state", None) or {}).keys():
        normalized = _normalize_path(handler, path)
        if normalized:
            paths.add(normalized)
    return sorted(paths)


@dataclass(frozen=True)
class AttemptTicket:
    attempt_id: str
    key: tuple[str, str]
    tool_name: str
    operation: dict
    operation_fingerprint: str
    state_before: dict
    state_fingerprint: str
    turn: int
    started_at: float


@dataclass(frozen=True)
class DuplicateAttempt:
    prior_attempt_id: str
    prior_status: str
    prior_turn: int
    operation_fingerprint: str
    state_fingerprint: str
    ledger_path: str


class AttemptTracker:
    def __init__(self, ledger_dir: Path | str, run_id: str = ""):
        self.run_id = str(run_id or uuid.uuid4().hex)
        self.ledger_dir = Path(ledger_dir)
        safe_run_id = re.sub(r"[^A-Za-z0-9_.-]+", "_", self.run_id).strip("_") or uuid.uuid4().hex
        self.ledger_path = self.ledger_dir / f"attempts_v{SCHEMA_VERSION}_{safe_run_id}.jsonl"
        self._lock = threading.RLock()
        self._seen: dict[tuple[str, str], dict] = {}
        self._known_result_digests: set[str] = set()
        self._known_results_by_operation: dict[str, set[str]] = {}
        self._file_digest_cache: dict[str, tuple[int, int, str]] = {}
        self.records: list[dict] = []
        self.last_write_error = ""
        self.disabled_reason = ""
        self._load_finished_records()

    def _load_finished_records(self) -> None:
        if not self.ledger_path.is_file():
            return
        try:
            lines = self.ledger_path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError as exc:
            self.disabled_reason = f"{type(exc).__name__}: {exc}"
            return
        for line in lines:
            try:
                record = json.loads(line)
            except (TypeError, ValueError):
                continue
            if record.get("version") != SCHEMA_VERSION or record.get("event") != "finished":
                continue
            state_fp = str(record.get("state_fingerprint") or "")
            operation_fp = str(record.get("operation_fingerprint") or "")
            attempt_id = str(record.get("attempt_id") or "")
            if not (state_fp and operation_fp and attempt_id):
                continue
            self._seen[(state_fp, operation_fp)] = {
                "attempt_id": attempt_id,
                "status": str(record.get("status") or "completed"),
                "turn": int(record.get("turn") or 0),
            }
            result_digest = str(record.get("result_digest") or "")
            if result_digest and len(self._known_result_digests) < MAX_KNOWN_RESULTS:
                self._known_result_digests.add(result_digest)
                self._known_results_by_operation.setdefault(operation_fp, set()).add(result_digest)

    def disable(self, reason: str, ticket: Optional[AttemptTicket] = None) -> None:
        with self._lock:
            self.disabled_reason = str(reason or "attempt tracker disabled")
            if ticket is not None:
                self._seen.pop(ticket.key, None)
            self._seen.clear()

    def should_track(self, tool_name: str) -> bool:
        return str(tool_name or "") not in _UNTRACKED_TOOLS

    def _known_results_state(self, exclude_operation_fingerprint: str = "") -> dict:
        with self._lock:
            digests = sorted({
                digest
                for operation_fp, operation_digests in self._known_results_by_operation.items()
                if operation_fp != exclude_operation_fingerprint
                for digest in operation_digests
            })
        return {"count": len(digests), "fingerprint": fingerprint(digests)}

    def _file_state(self, raw_path: str) -> dict:
        path = Path(raw_path)
        try:
            stat = path.stat()
        except (OSError, ValueError):
            return {"path": str(path), "kind": "missing"}
        if path.is_dir():
            entries = []
            truncated = False
            try:
                ledger_path = self.ledger_path.resolve(strict=False)
                pending = [path]
                while pending and len(entries) < MAX_DIRECTORY_STATE_ENTRIES:
                    current = pending.pop()
                    children = sorted(current.iterdir(), key=lambda item: item.name.casefold(), reverse=True)
                    for child in children:
                        if child.name in _VOLATILE_ENTRY_NAMES or child.resolve(strict=False) == ledger_path:
                            continue
                        if len(entries) >= MAX_DIRECTORY_STATE_ENTRIES:
                            truncated = True
                            break
                        relative = str(child.relative_to(path))
                        try:
                            child_stat = child.stat()
                            if child.is_symlink():
                                kind = "symlink"
                            elif child.is_dir():
                                kind = "dir"
                                pending.append(child)
                            else:
                                kind = "file"
                            entries.append({
                                "name": relative,
                                "kind": kind,
                                "size": child_stat.st_size,
                                "mtime_ns": child_stat.st_mtime_ns,
                            })
                        except OSError:
                            entries.append({"name": relative, "kind": "unavailable"})
                truncated = truncated or bool(pending)
            except OSError:
                entries = [{"error": "unavailable"}]
            return {
                "path": str(path),
                "kind": "directory",
                "entries_fingerprint": fingerprint(entries),
                "entry_count_sampled": len(entries),
                "truncated": truncated,
            }
        cache_key = str(path)
        cached = self._file_digest_cache.get(cache_key)
        if cached and cached[:2] == (stat.st_mtime_ns, stat.st_size):
            digest = cached[2]
        else:
            try:
                hasher = hashlib.sha256()
                with path.open("rb") as handle:
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        hasher.update(chunk)
                digest = hasher.hexdigest()
                self._file_digest_cache[cache_key] = (stat.st_mtime_ns, stat.st_size, digest)
            except OSError:
                digest = "unavailable"
        return {
            "path": str(path),
            "kind": "file",
            "size": stat.st_size,
            "sha256": digest,
        }

    def capture_state(
        self,
        handler,
        args: Optional[dict] = None,
        exclude_operation_fingerprint: str = "",
    ) -> dict:
        parent = getattr(handler, "parent", None)
        working = getattr(handler, "working", None) or {}
        stable_working = {
            key: working[key]
            for key in sorted(_STABLE_WORKING_KEYS)
            if key in working
        }
        user_texts = list(getattr(parent, "desktop_user_texts", None) or [])
        approved_prompts = list(getattr(parent, "approved_plan_allowed_prompts", None) or [])
        mcp_diagnostics = {}
        mcp_manager = getattr(parent, "mcp_manager", None)
        diagnostics_getter = getattr(mcp_manager, "get_diagnostics", None)
        if callable(diagnostics_getter):
            try:
                mcp_diagnostics = diagnostics_getter() or {}
            except Exception:
                mcp_diagnostics = {"status": "unavailable"}
        resources = [self._file_state(path) for path in _collect_resource_paths(handler, args or {})]
        return {
            "task": {
                "challenge_id": str(getattr(parent, "oracle_challenge_id", "") or ""),
                "run_id": str(getattr(parent, "oracle_run_id", "") or ""),
                "session_title": str(getattr(parent, "session_title", "") or ""),
            },
            "cwd": str(Path(getattr(handler, "cwd", None) or ".").resolve(strict=False)),
            "working": _canonicalize(stable_working),
            "permissions": {
                "mode": str(getattr(parent, "permission_mode", "") or ""),
                "approved_prompts_fingerprint": fingerprint(approved_prompts),
            },
            "dynamic_capabilities": {
                "activated_tools": sorted(str(item) for item in (getattr(parent, "activated_tools", None) or [])),
                "mcp_refresh_generation": int(getattr(parent, "_mcp_refresh_generation", 0) or 0),
                "mcp_schemas_fingerprint": fingerprint(getattr(parent, "mcp_tool_schemas", None) or []),
                "mcp_diagnostics_fingerprint": fingerprint(mcp_diagnostics),
            },
            "user_information": {
                "count": len(user_texts),
                "fingerprint": fingerprint(user_texts),
            },
            "resources": resources,
            "known_results": self._known_results_state(exclude_operation_fingerprint),
        }

    def _append_record(self, record: dict) -> bool:
        with self._lock:
            try:
                self.ledger_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
                payload = json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n"
                descriptor = os.open(
                    self.ledger_path,
                    os.O_APPEND | os.O_CREAT | os.O_WRONLY,
                    0o600,
                )
                with os.fdopen(descriptor, "a", encoding="utf-8") as handle:
                    handle.write(payload)
                try:
                    os.chmod(self.ledger_path, 0o600)
                except OSError:
                    pass
            except Exception as exc:
                self.last_write_error = f"{type(exc).__name__}: {exc}"
                return False
            self.records.append(record)
            return True

    def begin(self, handler, tool_name: str, args: dict, response=None) -> tuple[Optional[AttemptTicket], Optional[DuplicateAttempt]]:
        if self.disabled_reason or not self.should_track(tool_name):
            return None, None
        operation = canonical_operation(handler, tool_name, args, response)
        operation_fp = fingerprint(operation)
        state_before = self.capture_state(handler, args, operation_fp)
        state_fp = fingerprint(state_before)
        key = (state_fp, operation_fp)
        turn = int(getattr(handler, "current_turn", 0) or 0)
        started_at = time.time()
        with self._lock:
            prior = self._seen.get(key)
            if prior:
                duplicate = DuplicateAttempt(
                    prior_attempt_id=prior["attempt_id"],
                    prior_status=prior.get("status", "reserved"),
                    prior_turn=int(prior.get("turn", 0) or 0),
                    operation_fingerprint=operation_fp,
                    state_fingerprint=state_fp,
                    ledger_path=str(self.ledger_path),
                )
                blocked_record = {
                    "version": SCHEMA_VERSION,
                    "event": "blocked",
                    "run_id": self.run_id,
                    "attempt_id": uuid.uuid4().hex,
                    "prior_attempt_id": duplicate.prior_attempt_id,
                    "prior_status": duplicate.prior_status,
                    "turn": turn,
                    "tool": str(tool_name),
                    "operation_fingerprint": operation_fp,
                    "state_fingerprint": state_fp,
                    "status": "duplicate_attempt_blocked",
                    "timestamp": started_at,
                }
                if not self._append_record(blocked_record):
                    self.disable(self.last_write_error)
                    return None, None
                return None, duplicate
            attempt_id = uuid.uuid4().hex
            ticket = AttemptTicket(
                attempt_id=attempt_id,
                key=key,
                tool_name=str(tool_name),
                operation=operation,
                operation_fingerprint=operation_fp,
                state_before=state_before,
                state_fingerprint=state_fp,
                turn=turn,
                started_at=started_at,
            )
            reservation = {"attempt_id": attempt_id, "status": "reserved", "turn": turn}
            self._seen[key] = reservation
        if not self._append_record({
            "version": SCHEMA_VERSION,
            "event": "reserved",
            "run_id": self.run_id,
            "attempt_id": ticket.attempt_id,
            "turn": ticket.turn,
            "tool": ticket.tool_name,
            "operation": _ledger_preview(ticket.operation),
            "operation_fingerprint": ticket.operation_fingerprint,
            "state_before": _ledger_state(ticket.state_before),
            "state_fingerprint": ticket.state_fingerprint,
            "status": "reserved",
            "started_at": ticket.started_at,
        }):
            self.disable(self.last_write_error, ticket)
            return None, None
        return ticket, None

    def finish(self, handler, ticket: Optional[AttemptTicket], outcome, output: str = "") -> None:
        if ticket is None:
            return
        result_data = getattr(outcome, "data", None)
        result_payload = {"tool": ticket.tool_name, "data": _canonicalize(result_data)}
        result_digest = fingerprint(result_payload)
        status = "completed"
        result_status = ""
        if isinstance(result_data, dict):
            result_status = str(result_data.get("status") or "")
            if result_status in {"error", "failed", "permission_denied", "hook_blocked"}:
                status = "error"
        state_after = self.capture_state(
            handler,
            ticket.operation.get("args") or {},
            ticket.operation_fingerprint,
        )
        finished_at = time.time()
        result_json = _canonical_json(result_data)
        output_text = str(output or "")
        if not self._append_record({
            "version": SCHEMA_VERSION,
            "event": "finished",
            "run_id": self.run_id,
            "attempt_id": ticket.attempt_id,
            "turn": ticket.turn,
            "tool": ticket.tool_name,
            "operation_fingerprint": ticket.operation_fingerprint,
            "state_fingerprint": ticket.state_fingerprint,
            "state_after": _ledger_state(state_after),
            "state_after_fingerprint": fingerprint(state_after),
            "status": status,
            "result_status": _redact_text(result_status)[:256] if result_status else None,
            "result_digest": result_digest,
            "result_summary": {
                "type": type(result_data).__name__,
                "serialized_chars": len(result_json),
            },
            "output_summary": {
                "chars": len(output_text),
                "sha256": fingerprint(output_text),
            },
            "started_at": ticket.started_at,
            "finished_at": finished_at,
            "duration_ms": round((finished_at - ticket.started_at) * 1000, 3),
        }):
            self.disable(self.last_write_error, ticket)
            return
        with self._lock:
            if len(self._known_result_digests) < MAX_KNOWN_RESULTS:
                self._known_result_digests.add(result_digest)
                self._known_results_by_operation.setdefault(ticket.operation_fingerprint, set()).add(result_digest)
            current = self._seen.get(ticket.key)
            if current and current.get("attempt_id") == ticket.attempt_id:
                current["status"] = status


def _ledger_dir_for_handler(handler) -> Path:
    parent = getattr(handler, "parent", None)
    configured = getattr(parent, "attempt_ledger_dir", None)
    if configured:
        return Path(configured)
    task_dir = getattr(parent, "task_dir", None)
    if task_dir:
        return Path(task_dir) / "attempt_ledgers"
    log_path = getattr(parent, "log_path", None)
    if log_path:
        log_parent = Path(log_path).parent
        if log_parent.name == "model_responses":
            log_parent = log_parent.parent
        return log_parent / "attempt_ledgers"
    return Path(tempfile.gettempdir()) / "secheur-agent" / "attempt_ledgers"


def get_attempt_tracker(handler) -> Optional[AttemptTracker]:
    parent = getattr(handler, "parent", None)
    if getattr(parent, "attempt_dedup_enabled", False) is not True:
        return None
    tracker = getattr(parent, "_attempt_tracker", None) or getattr(handler, "_attempt_tracker", None)
    if tracker is not None:
        handler._attempt_tracker = tracker
        return None if tracker.disabled_reason else tracker
    with _TRACKER_INIT_LOCK:
        tracker = getattr(parent, "_attempt_tracker", None) or getattr(handler, "_attempt_tracker", None)
        if tracker is None:
            run_id = str(getattr(parent, "oracle_run_id", "") or uuid.uuid4().hex)
            tracker = AttemptTracker(_ledger_dir_for_handler(handler), run_id=run_id)
            parent._attempt_tracker = tracker
        handler._attempt_tracker = tracker
        parent.attempt_ledger_path = str(tracker.ledger_path)
        handler.attempt_ledger_path = str(tracker.ledger_path)
    return None if tracker.disabled_reason else tracker
