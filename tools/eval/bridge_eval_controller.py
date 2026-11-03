#!/usr/bin/env python3
"""Configured-lane CTF Field -> SecHeur bridge evaluation controller.

The default mode is read-only planning.  Execution is deliberately guarded by
both --execute and an exact confirmation string.  This controller never reads
gold answers and never infers success from model text; only the bridge's
structured verify-only terminal contract can produce a ``done`` record.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import contextvars
import dataclasses
import fcntl
import hashlib
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable


EXECUTE_CONFIRMATION = "RUN_3_LANE_EVAL"
DEFAULT_CONFIG_PATH = Path(__file__).with_name("bridge-eval-controller.json")
DEFAULT_ARTIFACT_ROOT = Path("/home/shared/eval-runner/bridge-eval-artifacts")
RUNNING_SESSION_STATES = {"running"}
SESSION_DELETE_RETRIES = 5
SESSION_DELETE_TIMEOUT_SECONDS = 10
FIELD_STOP_RETRIES = 3
PROFILE_PROBE_ATTEMPTS = 2
EVALUATION_MAX_TURNS = 800
PROFILE_PROBE_MAX_TURNS = 1
PROFILE_PROBE_TIMEOUT_SECONDS = 60
PROFILE_PROBE_ANSWER_EVIDENCE_GUARDS = (
    "Supervisor cannot finish the run without valid persisted answer evidence",
    "Supervisor cannot finish the run without persisted answer evidence",
)
PLANNING_TRACE_PAGE_SIZE = 100
DEFAULT_PROFILE_COOLDOWN_SECONDS = 90 * 60
SAFE_ID_RE = re.compile(r"[^A-Za-z0-9_.-]+")
PLANNING_RUN_ID_RE = re.compile(r"^planning_(?:cairn_)?[0-9a-f]{32}$")
PLANNING_RUN_STATUS_VALUES = {"created", "running", "paused", "blocked", "completed", "failed", "cancelled", "exhausted", "idle"}
RETENTION_CLASSES = {"pinned", "benchmark", "debug", "incomplete"}
EXECUTION_MODES = {"DIRECT", "PLAN_SINGLE", "PLAN_MULTI"}
EXPECTED_LEGACY_PLANNING_MODE = {
    "DIRECT": "off",
    "PLAN_SINGLE": "active",
    "PLAN_MULTI": "active",
}
_PROFILE_PROBE_HTTP_EVENTS: contextvars.ContextVar[list[dict[str, Any]] | None] = contextvars.ContextVar(
    "profile_probe_http_events", default=None
)


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def safe_id(value: str, limit: int = 96) -> str:
    cleaned = SAFE_ID_RE.sub("_", str(value or "")).strip("._")
    return (cleaned or "target")[:limit]


def safe_request_id(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"[^A-Za-z0-9_.:-]", "", value)[:128]


def profile_probe_request_id(headers: Any, payload: Any = None) -> str:
    for name in ("X-Request-ID", "Request-ID", "X-Correlation-ID"):
        value = headers.get(name) if headers is not None and hasattr(headers, "get") else None
        request_id = safe_request_id(value)
        if request_id:
            return request_id
    if isinstance(payload, dict):
        for key in ("requestId", "request_id", "correlationId"):
            request_id = safe_request_id(payload.get(key))
            if request_id:
                return request_id
    return ""


def record_profile_probe_http(status: Any, request_id: Any = "") -> None:
    events = _PROFILE_PROBE_HTTP_EVENTS.get()
    if events is None:
        return
    try:
        http_status = int(status) if status is not None else None
    except (TypeError, ValueError):
        http_status = None
    events.append({"httpStatus": http_status, "requestId": safe_request_id(request_id)})


def canonical_execution_mode(value: Any) -> str:
    return str(value or "").strip().upper().replace("-", "_")


def snapshot_execution_value(snapshot: dict[str, Any], camel: str, snake: str) -> Any:
    if camel in snapshot:
        return snapshot.get(camel)
    return snapshot.get(snake)


def execution_metadata(
    config: "ControllerConfig",
    snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return requested/effective execution fields for state and artifacts."""
    metadata: dict[str, Any] = {
        "requestedExecutionMode": canonical_execution_mode(config.execution_mode),
        "requestedExecutionCapacity": int(config.execution_capacity),
        "effectiveExecutionMode": "",
        "effectiveExecutionCapacity": None,
        "legacyPlanningMode": "",
        "controllerConcurrency": config.resolved_controller_concurrency(),
    }
    if not isinstance(snapshot, dict):
        return metadata
    raw_mode = snapshot_execution_value(snapshot, "executionMode", "execution_mode")
    raw_capacity = snapshot_execution_value(snapshot, "executionCapacity", "execution_capacity")
    raw_legacy = snapshot_execution_value(snapshot, "legacyPlanningMode", "legacy_planning_mode")
    if raw_mode is not None:
        metadata["effectiveExecutionMode"] = str(raw_mode)
    if raw_capacity is not None:
        try:
            metadata["effectiveExecutionCapacity"] = int(raw_capacity)
        except (TypeError, ValueError):
            metadata["effectiveExecutionCapacity"] = None
    if raw_legacy is not None:
        metadata["legacyPlanningMode"] = str(raw_legacy)
    return metadata


class ExecutionContractMismatch(RuntimeError):
    """Raised when Bridge did not honor the benchmark execution contract."""

    def __init__(self, *, requested_mode: str, requested_capacity: int, snapshot: dict[str, Any]):
        self.requested_mode = requested_mode
        self.requested_capacity = requested_capacity
        self.snapshot = dict(snapshot or {})
        self.effective_mode = snapshot_execution_value(self.snapshot, "executionMode", "execution_mode")
        self.effective_capacity = snapshot_execution_value(self.snapshot, "executionCapacity", "execution_capacity")
        self.legacy_planning_mode = snapshot_execution_value(
            self.snapshot, "legacyPlanningMode", "legacy_planning_mode"
        )
        super().__init__(
            "execution_contract_mismatch: "
            f"requested={requested_mode}/{requested_capacity}; "
            f"effective={self.effective_mode or '<missing>'}/"
            f"{self.effective_capacity if self.effective_capacity is not None else '<missing>'}; "
            f"legacyPlanningMode={self.legacy_planning_mode or '<missing>'}"
        )


def verify_execution_contract(config: "ControllerConfig", snapshot: dict[str, Any]) -> dict[str, Any]:
    """Validate Bridge's effective execution contract before prompt submit."""
    metadata = execution_metadata(config, snapshot)
    requested_mode = canonical_execution_mode(config.execution_mode)
    expected_legacy = EXPECTED_LEGACY_PLANNING_MODE[requested_mode]
    if (
        canonical_execution_mode(metadata["effectiveExecutionMode"]) != requested_mode
        or metadata["effectiveExecutionCapacity"] != int(config.execution_capacity)
        or str(metadata["legacyPlanningMode"] or "").strip().lower() != expected_legacy
    ):
        raise ExecutionContractMismatch(
            requested_mode=requested_mode,
            requested_capacity=int(config.execution_capacity),
            snapshot=snapshot,
        )
    return metadata


def field_start_diagnostic(payload: dict[str, Any], run_id: str | None = None) -> dict[str, Any]:
    """Bounded, redacted startup errors; never persist a whole field response."""
    text = "\n".join(str(payload[key]) for key in ("error", "message", "detail", "code")
                     if isinstance(payload.get(key), (str, int)))
    origin = "field_response"
    # evalctl intentionally returns only a reference. Resolve only the exact
    # current-run startup log, never an arbitrary response-supplied path.
    if run_id and re.fullmatch(r"[A-Za-z0-9_.-]+", run_id):
        expected = Path("/home/shared/eval-runner/runs") / run_id / "start.log"
        if str(expected) in text and expected.is_file() and not expected.is_symlink():
            if expected.parent.resolve() == Path("/home/shared/eval-runner/runs").resolve() / run_id:
                with expected.open("rb") as stream:
                    stream.seek(0, os.SEEK_END)
                    stream.seek(max(0, stream.tell() - 32768))
                    text += "\n" + stream.read(32768).decode("utf-8", errors="replace")
                origin = "current_run_start_log"
    digest = hashlib.sha256(text.encode()).hexdigest()
    text = re.sub(r"(?i)(authorization\s*['\"]?\s*[:=]\s*['\"]?)(?:bearer\s+)?[^\s,;'\"]+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)((?:api[_-]?key|access[_-]?token|password|secret|token)\s*['\"]?\s*[:=]\s*['\"]?)[^\s,;'\"]+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)\bsk[-_][A-Za-z0-9_-]{12,}", "[REDACTED]", text)
    text = re.sub(r"(https?://)[^/\s:@]+:[^/\s@]+@", r"\1[REDACTED]@", text)
    return {"source": origin, "responseSha256": digest, "preview": text[-4096:], "truncated": len(text) > 4096}


class FieldStartError(RuntimeError):
    """Preserve a safe diagnostic with a stable infrastructure category."""

    def __init__(self, payload: dict[str, Any], run_id: str | None = None):
        self.diagnostic = field_start_diagnostic(payload, run_id)
        text = self.diagnostic["preview"].lower()
        self.code = "field_start_failed"
        for needles, code in (
            (("no such image", "image not found", "manifest unknown", "pull access denied"), "field_image_unavailable"),
            (("address already in use", "port is already allocated", "already running", "resource busy"), "field_resource_busy"),
            (("cannot connect to the docker daemon", "daemon unavailable"), "field_daemon_unavailable"),
            (("timed out", "timeout"), "field_start_timeout"),
        ):
            if any(needle in text for needle in needles):
                self.code = code
                break
        super().__init__(self.code)


def safe_error_code(exc: BaseException) -> str:
    """Return a bounded diagnostic code without persisting response bodies."""
    if isinstance(exc, FieldStartError):
        return exc.code
    text = str(exc).lower()
    for status in (401, 403, 404, 408, 409, 429, 500, 502, 503, 504):
        if f"http {status}" in text:
            return f"http_{status}"
    if "rate limit" in text or "quota" in text:
        return "quota_or_rate_limit"
    if "timed out" in text or "timeout" in text:
        return "timeout"
    if "connection" in text or "urlerror" in text or "request failed" in text:
        return "connection_error"
    if "did not return sessionid" in text:
        return "missing_session_id"
    if "record" in text and "reject" in text:
        return "record_rejected"
    return safe_id(type(exc).__name__.lower(), 48)


@dataclasses.dataclass(frozen=True)
class Lane:
    index: int
    profiles: tuple[int, ...]

    def profile_for(self, ordinal: int) -> int:
        return self.profiles[ordinal % len(self.profiles)]


@dataclasses.dataclass(frozen=True)
class ControllerConfig:
    field_base: str
    bridge_base: str
    lanes: tuple[Lane, ...]
    debug_profile: int
    wall_timeout_seconds: int
    poll_seconds: float
    request_timeout_seconds: int
    work_root: Path
    state_root: Path
    cleanup_workspaces: bool = True
    artifact_root: Path | None = None
    retention_class: str = "pinned"
    git_commit: str = ""
    release: str = ""
    execution_mode: str = "DIRECT"
    execution_capacity: int = 1
    controller_concurrency: int | None = None
    profile_cooldown_seconds: float = DEFAULT_PROFILE_COOLDOWN_SECONDS
    max_turns: int = EVALUATION_MAX_TURNS
    memory_reference_enabled: bool = True
    web_verbs_enabled_for_web_only: bool = False
    heuristic_learning_enabled: bool = False
    require_progressive_planning_disabled: bool = False

    @classmethod
    def load(cls, path: Path) -> "ControllerConfig":
        raw = json.loads(path.read_text(encoding="utf-8"))
        if "capacity" in raw:
            raise ValueError("capacity is ambiguous; use executionCapacity or controllerConcurrency")
        lanes = tuple(
            Lane(index=index, profiles=tuple(int(profile) for profile in group))
            for index, group in enumerate(raw.get("lanes") or [])
        )
        raw_execution_mode = raw.get("executionMode") or "DIRECT"
        execution_mode = canonical_execution_mode(raw_execution_mode)
        try:
            execution_capacity = int(raw.get("executionCapacity", 1))
            controller_concurrency = int(raw.get("controllerConcurrency", len(lanes)))
        except (TypeError, ValueError) as exc:
            raise ValueError("executionCapacity and controllerConcurrency must be integers") from exc
        config = cls(
            field_base=str(raw.get("fieldBase") or "http://127.0.0.1:14200").rstrip("/"),
            bridge_base=str(raw.get("bridgeBase") or "http://127.0.0.1:14168").rstrip("/"),
            lanes=lanes,
            debug_profile=int(raw.get("debugProfile", 7)),
            wall_timeout_seconds=int(raw.get("wallTimeoutSeconds", 7200)),
            poll_seconds=float(raw.get("pollSeconds", 10)),
            request_timeout_seconds=int(raw.get("requestTimeoutSeconds", 300)),
            work_root=Path(str(raw.get("workRoot") or "/home/shared/secheur-agent/.secheur-agent/parallel-eval")),
            state_root=Path(str(raw.get("stateRoot") or "/home/shared/eval-runner/bridge-eval-state")),
            cleanup_workspaces=bool(raw.get("cleanupWorkspaces", True)),
            artifact_root=Path(str(raw.get("artifactRoot") or DEFAULT_ARTIFACT_ROOT)),
            retention_class=str(raw.get("retentionClass") or "pinned"),
            git_commit=str(raw.get("gitCommit") or os.environ.get("GIT_COMMIT") or ""),
            release=str(raw.get("release") or os.environ.get("SECHEUR_RELEASE") or ""),
            execution_mode=execution_mode,
            execution_capacity=execution_capacity,
            controller_concurrency=controller_concurrency,
            profile_cooldown_seconds=float(raw.get("profileCooldownSeconds", DEFAULT_PROFILE_COOLDOWN_SECONDS)),
            max_turns=int(raw.get("maxTurns", EVALUATION_MAX_TURNS)),
            memory_reference_enabled=bool(raw.get("memoryReferenceEnabled", True)),
            web_verbs_enabled_for_web_only=bool(raw.get("webVerbsEnabledForWebOnly", False)),
            heuristic_learning_enabled=bool(raw.get("heuristicLearningEnabled", False)),
            require_progressive_planning_disabled=bool(raw.get("requireProgressivePlanningDisabled", False)),
        )
        config.validate()
        return config

    def validate(self) -> None:
        if not 1 <= len(self.lanes) <= 7:
            raise ValueError("between one and seven lanes are required")
        if any(not lane.profiles for lane in self.lanes):
            raise ValueError("each lane requires at least one profile")
        profiles = [profile for lane in self.lanes for profile in lane.profiles]
        if len(profiles) != len(set(profiles)):
            raise ValueError("lane profiles must be unique")
        if self.debug_profile in profiles:
            raise ValueError("debug profile must not be assigned to an execution lane")
        if any(profile < 0 for profile in profiles) or self.debug_profile < 0:
            raise ValueError("profile ids must be non-negative")
        if self.wall_timeout_seconds <= 0 or self.poll_seconds <= 0:
            raise ValueError("timeouts must be positive")
        if self.max_turns <= 0:
            raise ValueError("max turns must be positive")
        if self.retention_class not in RETENTION_CLASSES:
            raise ValueError(f"retention class must be one of {sorted(RETENTION_CLASSES)}")
        mode = canonical_execution_mode(self.execution_mode)
        if mode not in EXECUTION_MODES:
            raise ValueError(f"executionMode must be one of {sorted(EXECUTION_MODES)}")
        if not isinstance(self.execution_capacity, int) or self.execution_capacity <= 0:
            raise ValueError("executionCapacity must be a positive integer")
        if mode in {"DIRECT", "PLAN_SINGLE"} and self.execution_capacity != 1:
            raise ValueError(f"{mode} requires executionCapacity=1")
        if mode == "PLAN_MULTI" and self.execution_capacity < 2:
            raise ValueError("PLAN_MULTI requires executionCapacity>=2")
        controller_concurrency = self.resolved_controller_concurrency()
        if controller_concurrency != len(self.lanes):
            raise ValueError(
                "controllerConcurrency must equal the configured lane count "
                f"({len(self.lanes)})"
            )
        if controller_concurrency <= 0:
            raise ValueError("controllerConcurrency must be positive")
        if self.heuristic_learning_enabled:
            raise ValueError(
                "heuristic-learning is browser-local; this controller only supports it disabled"
            )
        if self.profile_cooldown_seconds < 0:
            raise ValueError("profile cooldown must be non-negative")

    def resolved_artifact_root(self) -> Path:
        return (self.artifact_root or (self.state_root.parent / "bridge-eval-artifacts")).expanduser()

    def resolved_controller_concurrency(self) -> int:
        return self.controller_concurrency if self.controller_concurrency is not None else len(self.lanes)


class JsonHttpClient:
    def __init__(self, base_url: str, timeout: int):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    async def request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        query: dict[str, str] | None = None,
    ) -> Any:
        return await asyncio.to_thread(self._request_sync, method, path, payload, query)

    def _request_sync(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None,
        query: dict[str, str] | None,
    ) -> Any:
        url = f"{self.base_url}{path}"
        if query:
            url = f"{url}?{urllib.parse.urlencode(query)}"
        body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            # Deleting an already terminal session is housekeeping, not solving.
            # Use a real socket timeout so cancelled to_thread jobs cannot linger for 300s.
            timeout = min(self.timeout, SESSION_DELETE_TIMEOUT_SECONDS) if method == "DELETE" and path.startswith("/session/") else self.timeout
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read()
                status = getattr(response, "status", None)
                request_id = profile_probe_request_id(getattr(response, "headers", None))
            try:
                parsed = json.loads(raw.decode("utf-8")) if raw else {}
            except (UnicodeDecodeError, json.JSONDecodeError):
                record_profile_probe_http(status, request_id)
                raise
            request_id = request_id or profile_probe_request_id(None, parsed)
            record_profile_probe_http(status, request_id)
            return parsed
        except urllib.error.HTTPError as exc:
            detail = exc.read(1200).decode("utf-8", errors="replace")
            record_profile_probe_http(exc.code, profile_probe_request_id(getattr(exc, "headers", None)))
            raise RuntimeError(f"HTTP {exc.code} {method} {path}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            record_profile_probe_http(None)
            raise RuntimeError(f"HTTP request failed {method} {path}: {type(exc).__name__}") from exc


class FieldClient:
    def __init__(self, http: JsonHttpClient):
        self.http = http

    async def health(self) -> dict[str, Any]:
        return await self.http.request("GET", "/api/health")

    async def untested_targets(self) -> list[dict[str, Any]]:
        payload = await self.http.request("GET", "/api/targets", query={"status": "untested"})
        rows = payload.get("targets") if isinstance(payload, dict) else payload
        if not isinstance(rows, list):
            raise RuntimeError("CTF Field /api/targets did not return a list")
        return [row for row in rows if isinstance(row, dict) and row.get("ready")]

    async def all_targets(self) -> list[dict[str, Any]]:
        payload = await self.http.request("GET", "/api/targets")
        rows = payload.get("targets") if isinstance(payload, dict) else payload
        if not isinstance(rows, list):
            raise RuntimeError("CTF Field /api/targets did not return a list")
        return [row for row in rows if isinstance(row, dict)]

    async def start(self, target_id: str, run_id: str) -> dict[str, Any]:
        return await self.http.request("POST", "/api/start", {"target_id": target_id, "run_id": run_id})

    async def prompt(self, target_id: str) -> dict[str, Any]:
        return await self.http.request("POST", "/api/prompt", {"target_id": target_id})

    async def record(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self.http.request("POST", "/api/record", payload)

    async def stop(self, target_id: str, run_id: str) -> dict[str, Any]:
        return await self.http.request("POST", "/api/stop", {"target_id": target_id, "run_id": run_id})


class BridgeClient:
    def __init__(
        self,
        http: JsonHttpClient,
        *,
        max_turns: int = EVALUATION_MAX_TURNS,
        memory_reference_enabled: bool = True,
    ):
        self.http = http
        self.max_turns = int(max_turns)
        self.memory_reference_enabled = bool(memory_reference_enabled)

    async def status(self) -> dict[str, Any]:
        return await self.http.request("GET", "/status")

    async def profiles(self) -> list[dict[str, Any]]:
        payload = await self.http.request("GET", "/model-profiles")
        return list(payload.get("profiles") or [])

    async def create_session(
        self,
        profile: int,
        cwd: Path,
        *,
        execution_mode: str = "DIRECT",
        execution_capacity: int = 1,
        target_id: str | None = None,
        run_id: str | None = None,
    ) -> str:
        mode = canonical_execution_mode(execution_mode)
        if mode not in EXECUTION_MODES:
            raise ValueError(f"executionMode must be one of {sorted(EXECUTION_MODES)}")
        payload = {
            "llmNo": profile,
            "cwd": str(cwd),
            "permissionMode": "bypassPermissions",
            "interactionMode": "autonomous",
            "taskKind": "ctf",
            "executionMode": mode.lower(),
            "executionCapacity": int(execution_capacity),
            "maxTurns": self.max_turns,
            "memoryReferenceEnabled": self.memory_reference_enabled,
        }
        if target_id:
            payload["targetId"] = str(target_id)
        if run_id:
            payload["runId"] = str(run_id)
        payload = await self.http.request("POST", "/session/new", payload)
        session_id = str(payload.get("sessionId") or "")
        if not session_id:
            raise RuntimeError("bridge did not return sessionId")
        return session_id

    async def create_probe_session(self, profile: int, cwd: Path) -> str:
        payload = await self.http.request("POST", "/session/new", {
            "llmNo": profile,
            "cwd": str(cwd),
            "permissionMode": "bypassPermissions",
            "interactionMode": "autonomous",
            "taskKind": "general",
            "executionMode": "direct",
            "executionCapacity": 1,
            "maxTurns": PROFILE_PROBE_MAX_TURNS,
            "memoryReferenceEnabled": False,
        })
        session_id = str(payload.get("sessionId") or "")
        if not session_id:
            raise RuntimeError("bridge did not return sessionId")
        return session_id

    async def submit(
        self,
        session_id: str,
        prompt: str,
        profile: int,
        *,
        web_verbs_enabled: bool = False,
    ) -> dict[str, Any]:
        return await self.http.request("POST", f"/session/{urllib.parse.quote(session_id)}/prompt", {
            "prompt": prompt,
            "llmNo": profile,
            "webVerbsEnabled": bool(web_verbs_enabled),
        })

    async def plugins_catalog(self) -> dict[str, Any]:
        payload = await self.http.request("GET", "/plugins/catalog")
        return dict(payload) if isinstance(payload, dict) else {}

    async def snapshot(self, session_id: str) -> dict[str, Any]:
        payload = await self.http.request(
            "GET",
            f"/session/{urllib.parse.quote(session_id)}",
            query={"includeMessages": "false"},
        )
        return dict(payload.get("session") or {})

    async def runtime_log(
        self,
        session_id: str,
        *,
        after_event_id: int | None = None,
        after_message_id: int | None = None,
        log_epoch: str | None = None,
    ) -> dict[str, Any]:
        """Read one session's runtime-log delta using its independent cursor."""
        query: dict[str, str] = {"includeMessages": "false"}
        if after_event_id is not None:
            query["afterEventId"] = str(max(0, int(after_event_id)))
        if after_message_id is not None:
            query["afterMessageId"] = str(max(0, int(after_message_id)))
        if log_epoch:
            query["logEpoch"] = str(log_epoch)
        payload = await self.http.request(
            "GET",
            f"/session/{urllib.parse.quote(session_id)}/runtime/log",
            query=query,
        )
        return dict(payload or {})

    async def planning_trace(
        self,
        session_id: str,
        *,
        cursor: str | None = None,
        limit: int = PLANNING_TRACE_PAGE_SIZE,
    ) -> dict[str, Any]:
        query: dict[str, str] = {"limit": str(max(1, int(limit)))}
        if cursor is not None:
            query["cursor"] = str(cursor)
        payload = await self.http.request(
            "GET",
            f"/session/{urllib.parse.quote(session_id)}/planning/trace",
            query=query,
        )
        return dict(payload or {})

    async def export(self, session_id: str) -> dict[str, Any]:
        return await self.http.request("GET", f"/session/{urllib.parse.quote(session_id)}/export")

    async def cancel_timeout(self, session_id: str) -> dict[str, Any]:
        return await self.http.request("POST", f"/session/{urllib.parse.quote(session_id)}/cancel", {
            "reason": "wall_clock_timeout",
        })

    async def cancel_verified(self, session_id: str) -> dict[str, Any]:
        return await self.http.request("POST", f"/session/{urllib.parse.quote(session_id)}/cancel", {
            "source": "bridge_eval_controller",
            "reason": "trusted_verifier_success",
        })

    async def delete(self, session_id: str) -> dict[str, Any]:
        return await self.http.request("DELETE", f"/session/{urllib.parse.quote(session_id)}")


class StateStore:
    """Single-process durable lease state; authoritative results remain in CTF Field."""

    def __init__(self, root: Path):
        self.root = root
        self.path = root / "state.json"
        self.lock_path = root / "controller.lock"
        self._async_lock = asyncio.Lock()
        self.data: dict[str, Any] = {"version": 1, "lanes": {}, "targets": {}, "updatedAt": now_iso()}

    @contextlib.contextmanager
    def exclusive_process_lock(self):
        self.root.mkdir(parents=True, exist_ok=True)
        handle = self.lock_path.open("a+", encoding="utf-8")
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            handle.close()
            raise RuntimeError("another bridge evaluation controller is already running") from exc
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            handle.close()

    def load(self) -> None:
        if self.path.exists():
            loaded = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(loaded, dict) or loaded.get("version") != 1:
                raise RuntimeError("unsupported controller state format")
            self.data = loaded

    def record_profile_probe_attempt(self, record: dict[str, Any]) -> None:
        attempts = self.data.get("profileProbeAttempts")
        bounded = [item for item in attempts if isinstance(item, dict)] if isinstance(attempts, list) else []
        bounded.append(dict(record))
        self.data["profileProbeAttempts"] = bounded[-64:]
        self._write()

    def blocked_targets(self) -> set[str]:
        return {
            target_id
            for target_id, value in dict(self.data.get("targets") or {}).items()
            if isinstance(value, dict) and value.get("state") in {"running", "terminal"}
        }

    def terminal_targets(self) -> set[str]:
        return {
            target_id
            for target_id, value in dict(self.data.get("targets") or {}).items()
            if isinstance(value, dict) and value.get("state") == "terminal"
        }

    def running_targets(self) -> set[str]:
        return {
            target_id
            for target_id, value in dict(self.data.get("targets") or {}).items()
            if isinstance(value, dict) and value.get("state") == "running"
        }

    def running_records(self) -> list[dict[str, Any]]:
        records = []
        for target_id, value in dict(self.data.get("targets") or {}).items():
            if not isinstance(value, dict) or value.get("state") != "running":
                continue
            records.append({"targetId": target_id, **value})
        return sorted(records, key=lambda item: str(item.get("startedAt") or ""))

    def next_profile(self, lane: Lane) -> tuple[int, int]:
        lane_state = dict(self.data.get("lanes") or {}).get(str(lane.index)) or {}
        ordinal = int(lane_state.get("nextOrdinal") or 0)
        return lane.profile_for(ordinal), ordinal

    def profile_cooldown_remaining(self, profile: int, now: float | None = None) -> float:
        """Return remaining wall-clock cooldown for a profile, if any."""
        value = dict(self.data.get("profileCooldowns") or {}).get(str(profile))
        if not isinstance(value, dict):
            return 0.0
        try:
            until = float(value.get("untilEpoch") or 0.0)
        except (TypeError, ValueError):
            return 0.0
        return max(0.0, until - (time.time() if now is None else now))

    def active_profile_cooldowns(self, now: float | None = None) -> dict[int, float]:
        current = time.time() if now is None else now
        active: dict[int, float] = {}
        for raw_profile in dict(self.data.get("profileCooldowns") or {}):
            try:
                profile = int(raw_profile)
            except (TypeError, ValueError):
                continue
            remaining = self.profile_cooldown_remaining(profile, current)
            if remaining > 0:
                active[profile] = remaining
        return active

    async def cooldown_profile(self, profile: int, seconds: float, reason: str) -> float:
        """Persist a profile cooldown using wall-clock expiry for restart safety."""
        until = time.time() + max(0.0, float(seconds))
        async with self._async_lock:
            cooldowns = self.data.setdefault("profileCooldowns", {})
            cooldowns[str(profile)] = {
                "untilEpoch": until,
                "setAt": now_iso(),
                "reason": safe_id(reason, 48),
            }
            self._write()
        return until

    async def reserve(
        self,
        lane: Lane,
        target_id: str,
        profile: int,
        ordinal: int,
        run_id: str,
        *,
        allow_failed_retest: bool = False,
    ) -> None:
        async with self._async_lock:
            targets = self.data.setdefault("targets", {})
            current = targets.get(target_id)
            if isinstance(current, dict) and current.get("state") == "running":
                raise RuntimeError(f"target already leased: {target_id}")
            if (
                isinstance(current, dict)
                and current.get("state") == "terminal"
                and not allow_failed_retest
            ):
                raise RuntimeError(f"target already terminal: {target_id}")
            targets[target_id] = {
                "state": "running",
                "lane": lane.index,
                "profile": profile,
                "runId": run_id,
                "sessionId": "",
                "startedAt": now_iso(),
            }
            self.data.setdefault("lanes", {})[str(lane.index)] = {"nextOrdinal": ordinal + 1}
            self._write()

    async def update_run(self, target_id: str, run_id: str, patch: dict[str, Any]) -> None:
        """Durably update one running run without touching another lease."""
        async with self._async_lock:
            targets = self.data.setdefault("targets", {})
            current = targets.get(target_id)
            if not isinstance(current, dict) or str(current.get("runId") or "") != str(run_id):
                raise RuntimeError(f"run lease not found: target={target_id} run={run_id}")
            current.update(dict(patch))
            targets[target_id] = current
            self._write()

    async def bind_session(self, target_id: str, run_id: str, session_id: str) -> None:
        if not session_id:
            raise ValueError("session_id is required")
        await self.update_run(target_id, run_id, {"sessionId": str(session_id)})

    async def finish(self, target_id: str, result: dict[str, Any]) -> None:
        async with self._async_lock:
            current = dict(self.data.setdefault("targets", {}).get(target_id) or {})
            current.update({"state": "terminal", "finishedAt": now_iso(), **result})
            self.data["targets"][target_id] = current
            self._write()

    def _write(self) -> None:
        self.data["updatedAt"] = now_iso()
        self.root.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self.data, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        os.replace(tmp, self.path)


def strict_verified_done(snapshot: dict[str, Any]) -> bool:
    return (
        str(snapshot.get("taskKind") or "") == "ctf"
        and str(snapshot.get("terminalReason") or "") == "verified_true"
        and str(snapshot.get("verificationState") or "") == "accepted"
    )


def normalize_ctf_terminal_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Normalize a bridge terminal snapshot for this CTF-only controller.

    Older bridge exception paths could expose ``status=error`` without a
    terminal contract.  Such a contract violation is infrastructure failure,
    never model abandonment and never a verified result.
    """
    normalized = dict(snapshot or {})
    normalized["taskKind"] = "ctf"
    status = str(normalized.get("status") or "")
    reason = str(normalized.get("terminalReason") or "")
    verification = str(normalized.get("verificationState") or "")
    if verification not in {"accepted", "rejected", "error", "not_attempted"}:
        verification = "not_attempted"
    normalized["verificationState"] = verification
    # Planning failures carry their classification as structured metadata from
    # the Bridge.  Never infer this contract from the human-readable error.
    failure_source = normalized.get("failureSource") or normalized.get("failure_source")
    failure_stage = normalized.get("failureStage") or normalized.get("failure_stage")
    failure_code = normalized.get("failureCode") or normalized.get("failure_code")
    if isinstance(failure_source, str) and failure_source:
        normalized["failureSource"] = failure_source
    if isinstance(failure_stage, str) and failure_stage:
        normalized["failureStage"] = failure_stage
    if isinstance(failure_code, str) and failure_code:
        normalized["failureCode"] = failure_code
    if not reason and failure_source == "planning":
        reason = "planning_failed"
    elif not reason and status == "idle":
        reason = "verified_true" if verification == "accepted" else "unverified_idle"
    elif not reason and status != "running":
        reason = "infra_failed"
    normalized["terminalReason"] = reason
    if reason == "verified_true" and verification == "accepted":
        normalized["outcome"] = "solved"
    elif reason:
        normalized["outcome"] = "failed"
    return normalized


def terminal_snapshot_from_export(snapshot: dict[str, Any], export: dict[str, Any]) -> dict[str, Any]:
    """Prefer the monotonic accepted verifier contract from either source."""
    exported = export.get("session") if isinstance(export, dict) else {}
    candidates = [dict(snapshot or {}), dict(exported or {}) if isinstance(exported, dict) else {}]
    accepted = next((item for item in candidates if strict_verified_done(item)), None)
    if accepted is not None:
        merged = {**candidates[0], **accepted}
        merged.update({"taskKind": "ctf", "terminalReason": "verified_true", "verificationState": "accepted"})
        return normalize_ctf_terminal_snapshot(merged)
    merged = dict(candidates[0] or candidates[1])
    # Export/session metadata may be newer than the polling snapshot.  Only
    # fill missing structured failure fields; live status/reason stays authoritative.
    for key in ("failureSource", "failureStage", "failureCode", "failure_source", "failure_stage", "failure_code"):
        if not merged.get(key) and candidates[1].get(key):
            merged[key] = candidates[1][key]
    return normalize_ctf_terminal_snapshot(merged)


def profile_rate_limit_error_code(snapshot: dict[str, Any], export: dict[str, Any]) -> str:
    """Detect only provider quota/rate-limit signals for scheduler cooldown."""
    records: list[dict[str, Any]] = []
    if isinstance(snapshot, dict):
        records.append(snapshot)
    exported = export.get("session") if isinstance(export, dict) else {}
    if isinstance(exported, dict):
        records.append(exported)

    # Verifier quota is a terminal CTF result, not a model-provider limit.  Its
    # human-readable message contains "quota", so source/code must take
    # precedence over text matching before the scheduler applies a cooldown.
    for record in records:
        failure_source = str(record.get("failureSource") or "").strip().lower()
        failure_stage = str(record.get("failureStage") or "").strip().lower()
        failure_code = str(record.get("failureCode") or "").strip().lower()
        terminal_reason = str(record.get("terminalReason") or "").strip().lower()
        if (
            failure_source == "verifier"
            or failure_stage == "verifier"
            or failure_code.startswith("verifier_")
            or terminal_reason == "verifier_unavailable"
        ):
            return ""

    candidates: list[object] = []
    for record in records:
        candidates.extend(record.get(key) for key in ("lastError", "error", "errorMessage", "failureReason"))
    for value in candidates:
        text = str(value or "").lower()
        if not text:
            continue
        if re.search(r"\b429\b", text) or "rate limit" in text or "quota" in text:
            return "http_429"
    return ""


def is_provider_rate_limit_result(result: dict[str, Any]) -> bool:
    """Require both a rate-limit code and no structured verifier origin."""
    failure_source = str(result.get("failureSource") or "").strip().lower()
    failure_stage = str(result.get("failureStage") or "").strip().lower()
    failure_code = str(result.get("failureCode") or "").strip().lower()
    if failure_source == "verifier" or failure_stage == "verifier" or failure_code.startswith("verifier_"):
        return False
    return str(result.get("errorCode") or "") in {"http_429", "quota_or_rate_limit"}


def controlled_summary(
    snapshot: dict[str, Any],
    profile: int,
    metrics: dict[str, int] | None = None,
    *,
    started_at: str = "",
    ended_at: str = "",
    duration_seconds: float | None = None,
    max_turns: int = EVALUATION_MAX_TURNS,
) -> str:
    reason = str(snapshot.get("terminalReason") or "infra_failed")[:80]
    verification = str(snapshot.get("verificationState") or "not_attempted")[:80]
    outcome = str(snapshot.get("outcome") or "inconclusive")[:80]
    metrics = metrics or {"turns": 0, "tool_calls": 0}
    timing = ""
    if started_at:
        timing += f"; started_at={started_at}"
    if ended_at:
        timing += f"; ended_at={ended_at}"
    if duration_seconds is not None:
        timing += f"; duration_seconds={duration_seconds:g}"
    return (
        f"bridge evaluation: terminal={reason}; verification={verification}; outcome={outcome}; "
        f"profile={profile}; turns={metrics['turns']}; turns_used={metrics['turns']}; max_turns={max_turns}; "
        f"tool_calls={metrics['tool_calls']}{timing}"
    )


def controlled_failure_reason(snapshot: dict[str, Any]) -> str:
    reason = str(snapshot.get("terminalReason") or "infra_failed")[:120]
    verification = str(snapshot.get("verificationState") or "not_attempted")[:120]
    details = ""
    if snapshot.get("failureSource"):
        details += f"; failure_source={str(snapshot['failureSource'])[:80]}"
    if snapshot.get("failureStage"):
        details += f"; failure_stage={str(snapshot['failureStage'])[:120]}"
    if snapshot.get("failureCode"):
        details += f"; failure_code={str(snapshot['failureCode'])[:120]}"
    return f"{reason}; verification={verification}{details}"


def reconcile_planning_verification(result: dict[str, Any], trace_path: Path) -> dict[str, Any]:
    counts = {"accepted": 0, "rejected": 0, "blocked": 0, "error": 0}
    seen: set[tuple[str, str]] = set()
    for line in trace_path.read_text(encoding="utf-8").splitlines():
        try:
            event = json.loads(line)
        except (ValueError, TypeError):
            continue
        payload = event.get("payload") or {}
        if event.get("type") != "native_verification_observed" or payload.get("origin") != "native_tool":
            continue
        if payload.get("toolName") not in ("verify_flag", "check_flag"):
            continue
        identity = (str(event.get("runId") or payload.get("runId") or ""), str(payload.get("evidenceId") or ""))
        if not all(identity) or identity in seen:
            continue
        status = payload.get("status")
        if status not in counts or (status != "blocked" and payload.get("requestSent") is not True):
            continue
        seen.add(identity)
        counts[status] += 1
    updated = dict(result)
    updated["verificationSummary"] = {"source": "persisted_native_tool_events", "counts": counts, "attempts": counts["accepted"] + counts["rejected"] + counts["error"]}
    # Accepted authority remains the existing Bridge verifier gate.
    if updated.get("verificationState") != "accepted":
        if counts["rejected"]:
            updated["verificationState"] = "rejected"
        elif counts["error"]:
            updated["verificationState"] = "error"
    return updated


def failure_metadata(snapshot: dict[str, Any]) -> dict[str, str]:
    """Return only structured planning classification fields when present."""
    metadata: dict[str, str] = {}
    for output_key, snapshot_key in (
        ("failureSource", "failureSource"),
        ("failureStage", "failureStage"),
        ("failureCode", "failureCode"),
    ):
        value = snapshot.get(snapshot_key) or snapshot.get(output_key.replace("S", "_s").lower())
        if isinstance(value, str) and value:
            metadata[output_key] = value
    return metadata


def process_note_from_export(export: dict[str, Any]) -> str:
    return json.dumps(dict(export or {}), ensure_ascii=False, separators=(",", ":"))


def validate_record_response(
    response: Any,
    *,
    target_id: str,
    run_id: str,
    session_id: str,
    status: str,
    terminal_reason: str,
    verification_state: str,
    process_note: str,
) -> None:
    """Reject an acknowledgement that did not persist this run's result."""
    if not isinstance(response, dict) or response.get("ok") is False:
        raise RuntimeError("CTF Field record rejected")
    record = response.get("record")
    if not isinstance(record, dict):
        raise RuntimeError("CTF Field record response missing record")
    expected = {
        "target_id": target_id,
        "run_id": run_id,
        "session_id": session_id,
        "status": status,
        "terminal_reason": terminal_reason,
        "verification_state": verification_state,
    }
    mismatches = [
        key for key, value in expected.items()
        if str(record.get(key) or "") != str(value or "")
    ]
    if record.get("process_note") != process_note:
        mismatches.append("process_note")
    if mismatches:
        raise RuntimeError(
            "CTF Field record consistency check failed: " + ",".join(mismatches)
        )


def auditable_export(export: dict[str, Any], snapshot: dict[str, Any], export_error: str = "") -> dict[str, Any]:
    if export:
        return export
    return {
        "ok": False,
        "exportErrorClass": export_error or "Unavailable",
        "session": dict(snapshot or {}),
        "messages": [],
        "runtimeLog": [],
    }


def export_metrics(export: dict[str, Any]) -> dict[str, int]:
    """Derive audit metrics from the export, not only session.turnCount."""
    session = export.get("session") if isinstance(export, dict) else {}
    messages = export.get("messages") if isinstance(export, dict) else []
    session_turns = int((session or {}).get("turnCount") or 0)
    assistant_messages = [
        message for message in (messages or [])
        if isinstance(message, dict) and message.get("role") == "assistant"
    ]
    runtime_log = export.get("runtimeLog") if isinstance(export, dict) else []
    structured_calls = {
        str(event.get("toolCallId") or f"event-{index}")
        for index, event in enumerate(runtime_log or [])
        if isinstance(event, dict) and event.get("event") == "tool_execution_start"
    }
    legacy_calls = sum(
        1 for message in assistant_messages
        if str(message.get("content") or "").lstrip().startswith("<")
    )
    parent_tool_calls = len(structured_calls) if structured_calls else legacy_calls
    # A live durable ledger includes planning children and survives compaction.
    # Fall back to transcript counts for older bridges; never add parent twice.
    aggregate_tool_calls = (session or {}).get("toolCallCount")
    if isinstance(aggregate_tool_calls, int) and not isinstance(aggregate_tool_calls, bool) and aggregate_tool_calls >= 0:
        tool_calls = max(aggregate_tool_calls, parent_tool_calls)
    else:
        tool_calls = parent_tool_calls
    return {"turns": max(session_turns, len(assistant_messages)), "tool_calls": tool_calls}


def planning_trace_metrics(path: Path) -> dict[str, int]:
    """Persist outer counts even if cancellation disposed the Bridge runtime."""
    seen: set[str] = set()
    proposals = reasons = requests = executor = 0
    tools: set[str] = set()
    if not path.exists():
        return {"plannerCalls": 0, "executorTurns": 0, "toolCallsStarted": 0}
    for line in path.read_text().splitlines():
        try:
            event = json.loads(line)
        except (ValueError, TypeError):
            continue
        if not isinstance(event, dict):
            continue
        identity = event.get("eventId") or event.get("event_id") or event.get("id")
        if identity is not None:
            identity = str(identity)
            if identity in seen:
                continue
            seen.add(identity)
        kind = event.get("type")
        payload = event.get("payload") or {}
        if kind == "proposal_generation_end":
            proposals += 1
        if kind == "cairn_reason_start":
            reasons += 1
        if kind == "planning_model_request_end":
            requests += 1
        if kind in ("model_turn_completed", "cairn_model_turn_completed"):
            executor += 1
        if kind in ("executor_tool_execution_start", "cairn_executor_tool_execution_start"):
            call = payload.get("toolCallId") if isinstance(payload, dict) else None
            lease = payload.get("leaseId") if isinstance(payload, dict) else None
            tools.add(f"{lease}:{call or identity or len(tools)}")
    return {"plannerCalls": requests or proposals or reasons, "executorTurns": executor, "toolCallsStarted": len(tools)}


def write_json_atomic(path: Path, payload: Any) -> None:
    """Write a JSON artifact atomically so a controller crash cannot leave a partial file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


class RunArtifact:
    """Durable, self-contained archive for one target run."""

    def __init__(
        self,
        config: ControllerConfig,
        *,
        run_id: str,
        target_id: str,
        profile: int,
        lane: int,
        profile_provider: str = "",
        profile_model: str = "",
    ):
        self.root = config.resolved_artifact_root().expanduser().resolve()
        self.path = self.root / safe_id(run_id)
        if self.path.parent != self.root:
            raise RuntimeError("unsafe artifact path")
        self.manifest_path = self.path / "manifest.json"
        self.result_path = self.path / "result.json"
        self.events_path = self.path / "runtime-events.jsonl"
        self.planning_events_path = self.path / "planning-events.jsonl"
        self.export_path = self.path / "session-export.json"
        planning_applicable = canonical_execution_mode(config.execution_mode) != "DIRECT"
        self.manifest: dict[str, Any] = {
            "runId": run_id,
            "targetId": target_id,
            "sessionId": "",
            "profile": profile,
            "profileProvider": profile_provider,
            "profileModel": profile_model,
            "lane": lane,
            "gitCommit": config.git_commit,
            "release": config.release,
            **execution_metadata(config),
            "startedAt": now_iso(),
            "finishedAt": "",
            "artifactState": "running",
            "traceComplete": False,
            "traceGapReason": "",
            "retentionClass": config.retention_class,
            "logEpoch": "",
            "afterEventId": 0,
            "afterMessageId": 0,
            "planningRunId": "",
            "planningStatus": None,
            "planningTraceState": "unavailable" if planning_applicable else "not_applicable",
            "planningTraceEventCount": 0,
            "planningTraceComplete": not planning_applicable,
            "planningTraceErrorCode": "" if not planning_applicable else "not_exported",
        }
        self.finalized = False

    def initialize(self) -> None:
        self.path.mkdir(parents=True, exist_ok=False)
        self.events_path.touch(exist_ok=True)
        self.planning_events_path.touch(exist_ok=True)
        write_json_atomic(self.manifest_path, self.manifest)

    def update_manifest(self, **fields: Any) -> None:
        self.manifest.update(fields)
        write_json_atomic(self.manifest_path, self.manifest)

    def append_events(self, events: list[dict[str, Any]]) -> None:
        if not events:
            return
        self.path.mkdir(parents=True, exist_ok=True)
        with self.events_path.open("a", encoding="utf-8") as handle:
            for event in events:
                handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    def append_planning_events(self, events: list[dict[str, Any]]) -> None:
        if not events:
            return
        self.path.mkdir(parents=True, exist_ok=True)
        with self.planning_events_path.open("a", encoding="utf-8") as handle:
            for event in events:
                handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    def write_export(self, export: dict[str, Any]) -> None:
        write_json_atomic(self.export_path, export)

    def write_result(self, result: dict[str, Any]) -> None:
        write_json_atomic(self.result_path, result)

    def finalize(
        self,
        *,
        result: dict[str, Any],
        export: dict[str, Any],
        trace_complete: bool,
        trace_gap_reason: str,
        log_epoch: str,
        after_event_id: int,
        after_message_id: int,
    ) -> None:
        """Archive all run data, then atomically mark the manifest complete."""
        errors: list[Exception] = []
        for writer, value in ((self.write_export, export), (self.write_result, result)):
            try:
                writer(value)
            except Exception as exc:
                errors.append(exc)
        if errors:
            raise RuntimeError(
                "artifact archive write failed: "
                + ",".join(type(error).__name__ for error in errors)
            ) from errors[0]
        self.update_manifest(
            finishedAt=now_iso(),
            traceComplete=bool(trace_complete),
            traceGapReason=str(trace_gap_reason or ""),
            logEpoch=str(log_epoch or ""),
            afterEventId=int(after_event_id),
            afterMessageId=int(after_message_id),
            artifactState="complete",
        )
        self.finalized = True


class RuntimeTrace:
    """One-session incremental runtime-log cursor and durable event sink."""

    def __init__(
        self,
        bridge: BridgeClient,
        artifact: RunArtifact,
        state: StateStore,
        *,
        target_id: str,
        run_id: str,
        session_id: str,
    ):
        self.bridge = bridge
        self.artifact = artifact
        self.state = state
        self.target_id = target_id
        self.run_id = run_id
        self.session_id = session_id
        self.log_epoch = ""
        self.after_event_id = 0
        self.after_message_id = 0
        self.trace_complete = True
        self.trace_gap_reason = ""
        self.initialized = False
        self._seen_event_ids: set[int] = set()
        self._seen_event_signatures: set[str] = set()

    async def poll(self) -> None:
        """Fetch and append one delta; trace failures never terminate the agent run."""
        try:
            payload = await self.bridge.runtime_log(
                self.session_id,
                after_event_id=self.after_event_id if self.initialized else None,
                after_message_id=self.after_message_id if self.initialized else None,
                log_epoch=self.log_epoch if self.initialized and self.log_epoch else None,
            )
            self._consume(payload)
            await self._persist_cursor()
        except Exception as exc:
            self._mark_gap(f"runtime_log_error:{safe_id(type(exc).__name__, 48)}")
            await self._persist_cursor()

    def _consume(self, payload: dict[str, Any]) -> None:
        if not isinstance(payload, dict):
            self._mark_gap("invalid_runtime_log_payload")
            return

        if self.initialized and payload.get("incremental") is not True:
            self._mark_gap("cursor_reset")
        previous_epoch = self.log_epoch
        response_epoch = str(payload.get("logEpoch") or "")
        if previous_epoch and response_epoch and response_epoch != previous_epoch:
            self._mark_gap("epoch_mismatch")
        for field, reason in (
            ("epochMismatch", "epoch_mismatch"),
            ("eventHistoryExpired", "event_history_expired"),
            ("cursorReset", "cursor_reset"),
        ):
            if payload.get(field) is True:
                self._mark_gap(reason)
        if payload.get("resetRequired") is True:
            if payload.get("epochMismatch") is True:
                self._mark_gap("epoch_mismatch")
            elif payload.get("eventHistoryExpired") is True:
                self._mark_gap("event_history_expired")
            elif payload.get("cursorReset") is True:
                self._mark_gap("cursor_reset")
            else:
                self._mark_gap("cursor_reset")

        event_start = _nonnegative_int(payload.get("eventStartId"))
        if self.initialized and event_start is not None and event_start > self.after_event_id + 1:
            self._mark_gap("event_history_expired")
        response_event_cursor = _nonnegative_int(payload.get("eventCursor"))
        response_message_cursor = _nonnegative_int(payload.get("messageCursor"))
        if self.initialized and response_event_cursor is not None and response_event_cursor < self.after_event_id:
            self._mark_gap("cursor_reset")
        if self.initialized and response_message_cursor is not None and response_message_cursor < self.after_message_id:
            self._mark_gap("cursor_reset")

        events = payload.get("events")
        incoming_event_ids: list[int] = []
        if isinstance(events, list):
            for event in events:
                if not isinstance(event, dict):
                    continue
                event_id = _nonnegative_int(event.get("id"))
                if event_id is not None:
                    incoming_event_ids.append(event_id)
            incoming_event_ids = sorted(set(incoming_event_ids))
        if self.initialized:
            if response_event_cursor is not None and response_event_cursor > self.after_event_id and not incoming_event_ids:
                self._mark_gap("event_history_expired")
            expected_event_id = self.after_event_id + 1
            for event_id in incoming_event_ids:
                if event_id > expected_event_id:
                    self._mark_gap("event_history_expired")
                expected_event_id = max(expected_event_id, event_id + 1)
        if isinstance(events, list):
            fresh_events: list[dict[str, Any]] = []
            for event in events:
                if not isinstance(event, dict):
                    self._mark_gap("invalid_runtime_event")
                    continue
                event_id = _nonnegative_int(event.get("id"))
                if event_id is not None:
                    if event_id in self._seen_event_ids:
                        continue
                    self._seen_event_ids.add(event_id)
                else:
                    signature = json.dumps(event, ensure_ascii=False, sort_keys=True)
                    if signature in self._seen_event_signatures:
                        continue
                    self._seen_event_signatures.add(signature)
                fresh_events.append(event)
            self.artifact.append_events(fresh_events)
            event_ids = [_nonnegative_int(event.get("id")) for event in fresh_events]
            event_ids = [event_id for event_id in event_ids if event_id is not None]
            if event_ids:
                self.after_event_id = max(self.after_event_id, max(event_ids))

        if response_event_cursor is not None:
            self.after_event_id = max(self.after_event_id, response_event_cursor)
        if response_message_cursor is not None:
            # Message cursors describe the current transcript, which may shrink
            # after compaction. Rebase the request cursor after a reset rather
            # than sending an impossible old cursor forever. Keep the gap flag:
            # event continuity alone does not prove complete message history.
            if payload.get("resetRequired") is True or response_message_cursor < self.after_message_id:
                self.after_message_id = response_message_cursor
            else:
                self.after_message_id = max(self.after_message_id, response_message_cursor)
        if response_epoch:
            self.log_epoch = response_epoch
        self.initialized = True
        self.artifact.update_manifest(
            traceComplete=bool(self.trace_complete),
            traceGapReason=self.trace_gap_reason,
            logEpoch=self.log_epoch,
            afterEventId=self.after_event_id,
            afterMessageId=self.after_message_id,
        )

    def _mark_gap(self, reason: str) -> None:
        self.trace_complete = False
        if not self.trace_gap_reason:
            self.trace_gap_reason = str(reason)
        self.artifact.manifest.update({
            "traceComplete": False,
            "traceGapReason": self.trace_gap_reason,
        })
        try:
            self.artifact.update_manifest(
                traceComplete=False,
                traceGapReason=self.trace_gap_reason,
            )
        except Exception:
            pass

    async def _persist_cursor(self) -> None:
        try:
            await self.state.update_run(
                self.target_id,
                self.run_id,
                {
                    "logEpoch": self.log_epoch,
                    "afterEventId": self.after_event_id,
                    "afterMessageId": self.after_message_id,
                    "traceComplete": self.trace_complete,
                    "traceGapReason": self.trace_gap_reason,
                },
            )
        except Exception:
            self._mark_gap("state_cursor_persist_failed")


class PlanningTraceExportError(RuntimeError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class PlanningTraceExport:
    """Fetch one PLAN_SINGLE planning run through the session-scoped Bridge API."""

    def __init__(
        self,
        bridge: BridgeClient,
        artifact: RunArtifact,
        config: ControllerConfig,
        *,
        session_id: str,
    ):
        self.bridge = bridge
        self.artifact = artifact
        self.config = config
        self.session_id = session_id
        self.planning_run_id = ""
        self.planning_status: str | None = None
        self.state = "unavailable"
        self.event_count = 0
        self.complete = False
        self.error_code = "not_exported"
        self._successful_pages = 0

    def fields(self) -> dict[str, Any]:
        return {
            "planningRunId": self.planning_run_id,
            "planningStatus": self.planning_status,
            "planningTraceState": self.state,
            "planningTraceEventCount": self.event_count,
            "planningTraceComplete": self.complete,
            "planningTraceErrorCode": self.error_code,
        }

    def _persist(self) -> None:
        # Planning export is diagnostic-only.  A manifest write failure must not
        # change the task result or prevent the normal cleanup path.
        with contextlib.suppress(Exception):
            self.artifact.update_manifest(**self.fields())

    async def collect(self) -> "PlanningTraceExport":
        if canonical_execution_mode(self.config.execution_mode) == "DIRECT":
            self.state = "not_applicable"
            self.complete = True
            self.error_code = ""
            self._persist()
            return self
        if not self.session_id:
            self.state = "unavailable"
            self.complete = False
            self.error_code = "planning_trace_no_session"
            self._persist()
            return self

        cursor: str | None = None
        last_sequence = -1
        seen_event_ids: set[str] = set()
        seen_sequences: set[int] = set()
        total_hint: int | None = None
        try:
            while True:
                payload = await self.bridge.planning_trace(
                    self.session_id,
                    cursor=cursor,
                    limit=PLANNING_TRACE_PAGE_SIZE,
                )
                if not isinstance(payload, dict) or payload.get("ok") is False:
                    raise PlanningTraceExportError("planning_trace_api_error")
                if str(payload.get("sessionId") or "") != self.session_id:
                    raise PlanningTraceExportError("planning_trace_session_mismatch")
                planning_run_id = str(payload.get("planningRunId") or "")
                if not planning_run_id:
                    status = str(payload.get("planningStatus") or "")
                    raise PlanningTraceExportError(
                        "planning_trace_run_not_started" if status in {"not_started", "not_applicable"}
                        else "planning_trace_run_missing"
                    )
                if not PLANNING_RUN_ID_RE.fullmatch(planning_run_id):
                    raise PlanningTraceExportError("planning_trace_invalid_run_id")
                if self.planning_run_id and planning_run_id != self.planning_run_id:
                    raise PlanningTraceExportError("planning_trace_run_mismatch")
                self.planning_run_id = planning_run_id
                raw_planning_status = payload.get("planningStatus")
                if raw_planning_status in (None, "", "unknown"):
                    if self.planning_status is None:
                        self.planning_status = "unknown"
                elif isinstance(raw_planning_status, str) and raw_planning_status in PLANNING_RUN_STATUS_VALUES:
                    self.planning_status = raw_planning_status
                else:
                    raise PlanningTraceExportError("planning_trace_invalid_status")
                page_count = _nonnegative_int(payload.get("eventCount"))
                if page_count is None:
                    raise PlanningTraceExportError("planning_trace_missing_event_count")
                total_hint = page_count
                events = payload.get("events")
                if not isinstance(events, list):
                    raise PlanningTraceExportError("planning_trace_invalid_events")
                page: list[dict[str, Any]] = []
                for event in events:
                    if not isinstance(event, dict):
                        raise PlanningTraceExportError("planning_trace_invalid_event")
                    if str(event.get("runId") or "") != self.planning_run_id:
                        raise PlanningTraceExportError("planning_trace_event_run_mismatch")
                    event_id = str(event.get("eventId") or "")
                    sequence = _nonnegative_int(event.get("sequence"))
                    if not event_id or sequence is None:
                        raise PlanningTraceExportError("planning_trace_event_identity_missing")
                    if event_id in seen_event_ids or sequence in seen_sequences or sequence <= last_sequence:
                        raise PlanningTraceExportError("planning_trace_event_order_invalid")
                    seen_event_ids.add(event_id)
                    seen_sequences.add(sequence)
                    last_sequence = sequence
                    page.append(event)
                next_cursor_value = payload.get("nextCursor")
                next_cursor = None if next_cursor_value in (None, "") else str(next_cursor_value)
                if next_cursor is not None and not next_cursor.isdigit():
                    raise PlanningTraceExportError("planning_trace_invalid_cursor")
                if not page and next_cursor is not None:
                    raise PlanningTraceExportError("planning_trace_empty_page")
                self.artifact.append_planning_events(page)
                self.event_count += len(page)
                self._successful_pages += 1
                self._persist()
                trace_complete = payload.get("traceComplete") is True
                if next_cursor is None:
                    if not trace_complete:
                        raise PlanningTraceExportError("planning_trace_incomplete")
                    if self.planning_status not in PLANNING_RUN_STATUS_VALUES:
                        raise PlanningTraceExportError("planning_trace_missing_status")
                    if total_hint != self.event_count:
                        raise PlanningTraceExportError("planning_trace_event_count_mismatch")
                    self.state = "available"
                    self.complete = True
                    self.error_code = ""
                    self._persist()
                    return self
                if trace_complete:
                    raise PlanningTraceExportError("planning_trace_cursor_inconsistent")
                if next_cursor == cursor:
                    raise PlanningTraceExportError("planning_trace_cursor_repeated")
                cursor = next_cursor
        except PlanningTraceExportError as exc:
            self.state = "partial" if self._successful_pages > 0 else "unavailable"
            self.complete = False
            self.error_code = exc.code
            self._persist()
            return self
        except Exception as exc:
            self.state = "partial" if self._successful_pages > 0 else "unavailable"
            self.complete = False
            self.error_code = f"planning_trace_{safe_error_code(exc)}"
            self._persist()
            return self


def _nonnegative_int(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


class ProfileProbeError(RuntimeError):
    def __init__(
        self,
        profile: int,
        phase: str,
        error_category: str,
        http_status: int | None,
        request_id: str,
    ):
        self.profile = profile
        self.phase = phase
        self.error_category = error_category
        self.http_status = http_status
        self.request_id = request_id
        super().__init__(f"{error_category}: profile={profile}")


def profile_probe_http_summary(events: list[dict[str, Any]]) -> tuple[int | None, str]:
    status = next(
        (event.get("httpStatus") for event in reversed(events) if isinstance(event.get("httpStatus"), int)),
        None,
    )
    request_id = next(
        (safe_request_id(event.get("requestId")) for event in reversed(events) if safe_request_id(event.get("requestId"))),
        "",
    )
    return status, request_id


def profile_probe_error_status(exc: BaseException, events: list[dict[str, Any]]) -> int | None:
    matched = re.search(r"\bHTTP\s+(\d{3})\b", str(exc), flags=re.IGNORECASE)
    if matched:
        return int(matched.group(1))
    return profile_probe_http_summary(events)[0]


def cancel_metadata(snapshot: dict[str, Any], context: dict[str, str], target_id: str, session_id: str) -> dict[str, str]:
    """Persist controller-known cancellation facts without inventing unknown values."""
    metadata = {
        "target_id": target_id,
        "session_id": session_id,
        "cancel_source": "",
        "cancel_reason": "",
        "cancel_at": "",
        "pre_cancel_status": "",
    }
    metadata.update({key: value for key, value in context.items() if key in metadata and value is not None})
    if str(snapshot.get("status") or "") == "cancelled":
        metadata["cancel_source"] = metadata["cancel_source"] or str(
            snapshot.get("cancelSource") or snapshot.get("cancel_source") or "unknown"
        )
        metadata["cancel_reason"] = metadata["cancel_reason"] or str(
            snapshot.get("cancelReason") or snapshot.get("cancel_reason") or ""
        )
        metadata["cancel_at"] = metadata["cancel_at"] or str(
            snapshot.get("cancelAt") or snapshot.get("cancel_at") or ""
        )
    return metadata


class EvaluationController:
    def __init__(
        self,
        config: ControllerConfig,
        field: FieldClient,
        bridge: BridgeClient,
        state: StateStore,
        *,
        allow_done_rerun: bool = False,
    ):
        self.config = config
        self.field = field
        self.bridge = bridge
        self.state = state
        self.allow_done_rerun = allow_done_rerun
        self.profile_failures: dict[int, str] = {}
        self.profile_probe_attempts: list[dict[str, Any]] = []
        self._profile_selections: dict[int, dict[str, str]] = {}
        self._cleanup_diagnostics: dict[str, dict[str, str]] = {}
        self._target_metadata: dict[str, dict[str, Any]] = {}

    def _is_web_target(self, target_id: str) -> bool:
        """Enable Web Verb only when CTF Field explicitly labels the target web."""
        row = self._target_metadata.get(target_id) or {}
        category = str(
            row.get("category")
            or row.get("challenge_type")
            or row.get("challengeType")
            or ""
        ).strip().lower()
        return category == "web"

    def _cleanup_workspace(
        self,
        cwd: Path | None,
        *,
        session_deleted: bool,
        record_saved: bool,
        target_stopped: bool = True,
    ) -> str:
        """Remove one run workspace only after its session and record are safe.

        Failed record/session cleanup deliberately preserves the workspace for
        diagnosis; the controller never removes the configured work root.
        """
        if cwd is None:
            return "not_created"
        if not self.config.cleanup_workspaces:
            return "disabled"
        if not record_saved:
            return "preserved_record_not_saved"
        if not target_stopped:
            return "preserved_target_stop_failed"
        if not session_deleted:
            return "preserved_session_cleanup_failed"
        root = self.config.work_root.resolve()
        target = cwd.absolute()
        if target == root or target.parent.resolve() != root or target.is_symlink():
            return "rejected_unsafe_path"
        if not target.exists():
            return "already_clean"
        try:
            shutil.rmtree(target)
        except Exception as exc:
            return f"failed:{safe_error_code(exc)}"
        return "removed"

    async def preflight(self, *, probe_profiles: bool = True) -> set[int]:
        self.profile_probe_attempts = []
        try:
            field_status, bridge_status, profiles = await asyncio.gather(
                self.field.health(), self.bridge.status(), self.bridge.profiles()
            )
        except RuntimeError as exc:
            raise RuntimeError(self._profile_probe_error(exc, None)) from exc
        if not field_status.get("ok"):
            raise RuntimeError("CTF Field health check failed")
        if not bridge_status.get("ready"):
            raise RuntimeError("bridge is not ready")
        if self.config.require_progressive_planning_disabled:
            catalog = await self.bridge.plugins_catalog()
            plugins = catalog.get("plugins") if isinstance(catalog, dict) else None
            planning = next(
                (
                    item for item in (plugins or [])
                    if isinstance(item, dict)
                    and str(item.get("id") or "") == "progressive-planning"
                ),
                None,
            )
            if not isinstance(planning, dict) or planning.get("effectiveEnabled") is not False:
                raise RuntimeError("progressive-planning must be disabled for this baseline")
        available = {int(item.get("id")) for item in profiles if str(item.get("id", "")).isdigit()}
        required = {profile for lane in self.config.lanes for profile in lane.profiles}
        self._profile_selections = {}
        for item in profiles:
            if not isinstance(item, dict) or not str(item.get("id", "")).isdigit():
                continue
            profile_id = int(item["id"])
            self._profile_selections[profile_id] = {
                "provider": str(item.get("provider") or "").strip(),
                "model": str(item.get("model") or item.get("modelId") or "").strip(),
            }
        for profile in sorted(required):
            selection = self._profile_selections.get(profile, {})
            print(
                f"controller profile selected: profile={profile} "
                f"provider={selection.get('provider') or '<unknown>'} "
                f"model={selection.get('model') or '<unknown>'}",
                file=sys.stderr,
            )
        missing = sorted(required - available)
        failures = {profile: "profile_unavailable" for profile in missing}
        cooled = set(self.state.active_profile_cooldowns()) & required
        failures.update({profile: "cooldown_active" for profile in sorted(cooled)})
        if self.config.debug_profile not in available:
            print(
                f"controller warning: debug profile unavailable: {self.config.debug_profile}",
                file=sys.stderr,
            )
        healthy = set(required - set(missing) - cooled)
        if probe_profiles:
            healthy.clear()
            for profile in sorted(required - set(missing) - cooled):
                last_error = "profile_probe_failed"
                for attempt in range(1, PROFILE_PROBE_ATTEMPTS + 1):
                    probe_started = time.monotonic()
                    try:
                        metadata = await self._probe_profile(profile)
                        self._record_profile_probe_attempt(
                            profile,
                            attempt,
                            time.monotonic() - probe_started,
                            metadata,
                        )
                        healthy.add(profile)
                        break
                    except RuntimeError as exc:
                        last_error = (
                            exc.error_category
                            if isinstance(exc, ProfileProbeError)
                            else str(exc).split(": profile=", 1)[0]
                        )
                        metadata = {
                            "stage": getattr(exc, "phase", "probe"),
                            "httpStatus": getattr(exc, "http_status", None),
                            "errorCategory": getattr(exc, "error_category", last_error),
                            "requestId": getattr(exc, "request_id", ""),
                        }
                        self._record_profile_probe_attempt(
                            profile,
                            attempt,
                            time.monotonic() - probe_started,
                            metadata,
                        )
                        if attempt < PROFILE_PROBE_ATTEMPTS:
                            await asyncio.sleep(float(attempt))
                if profile not in healthy:
                    failures[profile] = last_error
        self.profile_failures = dict(sorted(failures.items()))
        if not healthy:
            detail = ",".join(f"{profile}:{failures.get(profile, 'failed')}" for profile in sorted(required))
            raise RuntimeError(f"profile_preflight_failed: {detail}")
        for profile, reason in self.profile_failures.items():
            print(
                f"controller warning: execution profile disabled: profile={profile} reason={reason}",
                file=sys.stderr,
            )
        return healthy

    @staticmethod
    def _profile_probe_error(exc: RuntimeError, profile: int | None) -> str:
        text = str(exc)
        lower = text.lower()
        if "http 401" in lower or "http 403" in lower or "unauthorized" in lower or "forbidden" in lower:
            kind = "auth_failed"
        elif "http 402" in lower or "http 429" in lower or "quota" in lower or "rate limit" in lower:
            kind = "quota_exhausted"
        elif "timeout" in lower or "timed out" in lower:
            kind = "probe_timeout"
        elif "connection" in lower or "request failed" in lower or "urlerror" in lower:
            kind = "bridge_unavailable"
        else:
            kind = "profile_probe_failed"
        suffix = "" if profile is None else f": profile={profile}"
        return f"{kind}{suffix}"

    def _record_profile_probe_attempt(
        self,
        profile: int,
        attempt: int,
        elapsed_seconds: float,
        metadata: dict[str, Any],
    ) -> None:
        error_category = str(metadata.get("errorCategory") or "").strip()
        record = {
            "event": "profile_preflight_attempt",
            "profile": profile,
            "stage": safe_id(str(metadata.get("stage") or "probe"), 48),
            "attempt": int(attempt),
            "durationMs": round(max(0.0, elapsed_seconds) * 1000, 3),
            "httpStatus": metadata.get("httpStatus") if isinstance(metadata.get("httpStatus"), int) else None,
            "errorCategory": safe_id(error_category, 48) if error_category else None,
            "requestId": safe_request_id(metadata.get("requestId")) or None,
            "recordedAt": now_iso(),
        }
        self.profile_probe_attempts.append(record)
        try:
            self.state.record_profile_probe_attempt(record)
        except Exception as exc:
            warning = {
                "event": "profile_preflight_record_failed",
                "errorCategory": safe_id(type(exc).__name__, 48),
            }
            print(f"controller profile preflight: {json.dumps(warning, sort_keys=True)}", file=sys.stderr)
        print(f"controller profile preflight: {json.dumps(record, sort_keys=True)}", file=sys.stderr)

    async def _probe_profile(self, profile: int) -> dict[str, Any]:
        """Exercise model authentication/quota without creating a target or record."""
        session_id = ""
        phase = "create_probe_session"
        request_events: list[dict[str, Any]] = []
        context_token = _PROFILE_PROBE_HTTP_EVENTS.set(request_events)
        try:
            try:
                cwd = self.config.work_root / "profile-preflight" / f"profile-{profile}"
                cwd.mkdir(parents=True, exist_ok=True)
                session_id = await self.bridge.create_probe_session(profile, cwd)
                phase = "submit_prompt"
                await self.bridge.submit(
                    session_id,
                    "Reply exactly PROFILE_OK. Do not call tools.",
                    profile,
                )
                deadline = time.monotonic() + min(PROFILE_PROBE_TIMEOUT_SECONDS, self.config.request_timeout_seconds)
                while True:
                    phase = "poll_snapshot"
                    snapshot = await self.bridge.snapshot(session_id)
                    status = str(snapshot.get("status") or "")
                    if status != "running":
                        last_error = str(snapshot.get("lastError") or "").strip()
                        if status == "error" or last_error:
                            if last_error.startswith(PROFILE_PROBE_ANSWER_EVIDENCE_GUARDS):
                                # The Pi supervisor may reject a target-free autonomous probe
                                # after the model response because no answer evidence exists.
                                # Treat that lifecycle guard as a successful connectivity probe
                                # only when the bridge export proves a model message completed.
                                try:
                                    phase = "export_answer_guard"
                                    exported = await self.bridge.export(session_id)
                                except RuntimeError:
                                    exported = {}
                                runtime_log = exported.get("runtimeLog") if isinstance(exported, dict) else []
                                if any(
                                    isinstance(event, dict)
                                    and (event.get("type") or event.get("event")) == "message_end"
                                    for event in (runtime_log or [])
                                ):
                                    break
                            raise RuntimeError(last_error or "profile probe session failed")
                        break
                    if time.monotonic() >= deadline:
                        raise RuntimeError("profile probe timed out")
                    await asyncio.sleep(min(self.config.poll_seconds, 0.25))
                http_status, request_id = profile_probe_http_summary(request_events)
                return {"stage": "complete", "httpStatus": http_status, "requestId": request_id, "errorCategory": ""}
            except Exception as exc:
                category = self._profile_probe_error(
                    exc if isinstance(exc, RuntimeError) else RuntimeError(type(exc).__name__),
                    None,
                ).split(": profile=", 1)[0]
                _, request_id = profile_probe_http_summary(request_events)
                raise ProfileProbeError(
                    profile,
                    phase,
                    category,
                    profile_probe_error_status(exc, request_events),
                    request_id,
                ) from exc
        finally:
            try:
                if session_id:
                    try:
                        await self._delete_session_with_retry(session_id)
                    except Exception as exc:
                        category = self._profile_probe_error(
                            exc if isinstance(exc, RuntimeError) else RuntimeError(type(exc).__name__),
                            None,
                        ).split(": profile=", 1)[0]
                        _, request_id = profile_probe_http_summary(request_events)
                        raise ProfileProbeError(
                            profile,
                            "cleanup_session",
                            category,
                            profile_probe_error_status(exc, request_events),
                            request_id,
                        ) from exc
            finally:
                _PROFILE_PROBE_HTTP_EVENTS.reset(context_token)

    async def _candidate_rows(self, target_ids: set[str] | None) -> list[dict[str, Any]]:
        if not target_ids:
            return await self.field.untested_targets()

        rows = await self.field.all_targets()
        by_id: dict[str, dict[str, Any]] = {}
        duplicates: set[str] = set()
        for row in rows:
            target_id = str(row.get("target_id") or row.get("id") or "")
            if not target_id:
                continue
            if target_id in by_id:
                duplicates.add(target_id)
            by_id[target_id] = row
        if duplicates:
            raise RuntimeError(f"CTF Field returned duplicate target IDs: {sorted(duplicates)}")

        missing = sorted(target_ids - set(by_id))
        rejected = []
        for target_id in sorted(target_ids & set(by_id)):
            row = by_id[target_id]
            status = str(row.get("status") or "")
            if not row.get("ready"):
                rejected.append(f"{target_id}:not_ready")
            elif row.get("running"):
                rejected.append(f"{target_id}:already_running")
            elif status not in {"untested", "failed"} and not (
                self.allow_done_rerun and status == "done"
            ):
                rejected.append(f"{target_id}:status={status or 'missing'}")
        if missing or rejected:
            details = []
            if missing:
                details.append(f"missing={missing}")
            if rejected:
                details.append(f"rejected={rejected}")
            raise RuntimeError("explicit target selection rejected: " + "; ".join(details))

        return [row for row in rows if str(row.get("target_id") or row.get("id") or "") in target_ids]

    async def plan(self, target_ids: set[str] | None = None) -> list[dict[str, Any]]:
        rows = await self._candidate_rows(target_ids)
        self._target_metadata = {
            str(row.get("target_id") or row.get("id") or ""): row
            for row in rows
            if str(row.get("target_id") or row.get("id") or "")
        }
        plan: list[dict[str, Any]] = []
        lane_ordinals = {lane.index: 0 for lane in self.config.lanes}
        for index, row in enumerate(rows):
            lane = self.config.lanes[index % len(self.config.lanes)]
            ordinal = lane_ordinals[lane.index]
            lane_ordinals[lane.index] += 1
            plan.append({
                "targetId": str(row.get("target_id") or row.get("id") or ""),
                "lane": lane.index + 1,
                "profile": lane.profile_for(ordinal),
            })
        return plan

    async def execute(self, target_ids: set[str] | None, max_targets: int) -> list[dict[str, Any]]:
        self.state.load()
        stale_running = sorted(self.state.running_targets())
        if stale_running:
            raise RuntimeError(
                f"stale running leases require manual recovery before execution: count={len(stale_running)}"
            )
        healthy_profiles = await self.preflight()
        active_lanes = tuple(
            Lane(lane.index, tuple(profile for profile in lane.profiles if profile in healthy_profiles))
            for lane in self.config.lanes
            if any(profile in healthy_profiles for profile in lane.profiles)
        )
        if not active_lanes:
            raise RuntimeError("no healthy execution lanes remain after profile preflight")
        running = self.state.running_targets()
        terminal = self.state.terminal_targets()
        rows = await self._candidate_rows(target_ids)
        self._target_metadata = {
            str(row.get("target_id") or row.get("id") or ""): row
            for row in rows
            if str(row.get("target_id") or row.get("id") or "")
        }
        selected: list[tuple[str, bool]] = []
        for row in rows:
            target_id = str(row.get("target_id") or row.get("id") or "")
            field_status = str(row.get("status") or "untested")
            if not target_id or target_id in running:
                continue
            if target_ids and target_id not in target_ids:
                continue
            explicit_failed_retest = bool(target_ids and field_status == "failed")
            explicit_done_rerun = bool(
                target_ids and field_status == "done" and self.allow_done_rerun
            )
            if target_id in terminal and not explicit_failed_retest and not explicit_done_rerun:
                continue
            selected.append((target_id, explicit_failed_retest or explicit_done_rerun))
            if len(selected) >= max_targets:
                break
        queue = asyncio.Queue()
        for item in selected:
            queue.put_nowait(item)
        results = await asyncio.gather(*(
            self._run_lane(lane, queue) for lane in active_lanes
        ))
        return [item for lane_results in results for item in lane_results]

    async def _run_lane(self, lane: Lane, queue: asyncio.Queue) -> list[dict[str, Any]]:
        results = []
        while True:
            await asyncio.sleep(0)
            # Check the lane's next profile before removing a target from the
            # shared queue.  A rate-limited profile must not strand a target
            # while it waits for its cooldown to expire.
            profile, ordinal = self.state.next_profile(lane)
            remaining = self.state.profile_cooldown_remaining(profile)
            if queue.empty():
                break
            if remaining > 0:
                await asyncio.sleep(min(max(self.config.poll_seconds, 0.1), remaining))
                continue
            try:
                item = queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            target_id, allow_retest = item
            run_id = ""
            reserved = False
            try:
                run_id = f"bridge-{time.strftime('%Y%m%d-%H%M%S')}-l{lane.index + 1}-{safe_id(target_id)}"
                await self.state.reserve(
                    lane,
                    target_id,
                    profile,
                    ordinal,
                    run_id,
                    allow_failed_retest=allow_retest,
                )
                reserved = True
                result = await self._run_one(lane, target_id, profile, run_id)
                result.update(self._cleanup_diagnostics.pop(run_id, {}))
                if is_provider_rate_limit_result(result):
                    until = await self.state.cooldown_profile(
                        profile,
                        self.config.profile_cooldown_seconds,
                        "http_429",
                    )
                    result["profileCooldownSeconds"] = round(max(0.0, until - time.time()), 1)
                    print(
                        f"controller warning: profile cooldown activated: "
                        f"profile={profile} seconds={self.config.profile_cooldown_seconds:g} "
                        f"reason=http_429",
                        file=sys.stderr,
                    )
                try:
                    await self.state.finish(target_id, result)
                except Exception as exc:
                    result["stateStatus"] = "failed"
                    result["stateErrorCode"] = safe_error_code(exc)
                    print(
                        f"controller warning: state finish failed: target={safe_id(target_id)} "
                        f"error={safe_error_code(exc)}",
                        file=sys.stderr,
                    )
                results.append({"targetId": target_id, "lane": lane.index + 1, "profile": profile, **result})
            except Exception as exc:
                result = {
                    "status": "failed",
                    "terminalReason": "infra_failed",
                    "verificationState": "not_attempted",
                    "sessionId": "",
                    "errorClass": type(exc).__name__,
                    "errorCode": safe_error_code(exc),
                    "operation": "controller.lane",
                }
                if reserved:
                    with contextlib.suppress(Exception):
                        await self.state.finish(target_id, result)
                results.append({"targetId": target_id, "lane": lane.index + 1, **result})
                print(
                    f"controller warning: lane target failed without stopping other lanes: "
                    f"target={safe_id(target_id)} error={safe_error_code(exc)}",
                    file=sys.stderr,
                )
            finally:
                queue.task_done()
        return results

    async def _run_one(self, lane: Lane, target_id: str, profile: int, run_id: str) -> dict[str, Any]:
        lane_number = lane.index + 1
        started_at = now_iso()
        started_monotonic = time.monotonic()
        profile_selection = self._profile_selections.get(profile, {})
        profile_provider = str(profile_selection.get("provider") or "")
        profile_model = str(profile_selection.get("model") or "")
        profile_fields = {
            "profile": profile,
            "profileProvider": profile_provider,
            "profileModel": profile_model,
        }
        session_id = ""
        target_started = False
        operation = "controller.initialize"
        start_payload: dict[str, Any] = {}
        export: dict[str, Any] = {}
        cancel_context: dict[str, str] = {}
        cwd: Path | None = None
        record_status = "not_attempted"
        record_error = ""
        trace: RuntimeTrace | None = None
        planning_trace: PlanningTraceExport | None = None
        artifact: RunArtifact | None = None
        artifact_error = ""
        artifact_finalized = False
        contract_mismatch: ExecutionContractMismatch | None = None
        execution_fields = execution_metadata(self.config)
        result: dict[str, Any] = {
            "status": "failed",
            "terminalReason": "infra_failed",
            "verificationState": "not_attempted",
            "sessionId": "",
            "runId": run_id,
            "startedAt": started_at,
            **profile_fields,
            **execution_fields,
        }
        snapshot: dict[str, Any] = {
            "taskKind": "ctf",
            "terminalReason": "infra_failed",
            "verificationState": "not_attempted",
            "outcome": "failed",
        }
        try:
            artifact = RunArtifact(
                self.config,
                run_id=run_id,
                target_id=target_id,
                profile=profile,
                lane=lane_number,
                profile_provider=profile_provider,
                profile_model=profile_model,
            )
            artifact.initialize()
        except Exception as exc:
            artifact_error = f"{type(exc).__name__}:{safe_id(str(exc), 120)}"
            artifact = None
            print(
                f"controller warning: artifact initialization failed: "
                f"target={safe_id(target_id)} error={artifact_error}",
                file=sys.stderr,
            )
        if artifact is not None:
            result["artifactDir"] = str(artifact.path)
            try:
                await self.state.update_run(
                    target_id,
                    run_id,
                    {
                        "artifactDir": str(artifact.path),
                        "artifactState": "running",
                        "traceComplete": False,
                        "traceGapReason": "",
                    },
                )
            except Exception as exc:
                artifact_error = f"state_update:{type(exc).__name__}:{safe_id(str(exc), 120)}"
                print(
                    f"controller warning: artifact state persistence failed: "
                    f"target={safe_id(target_id)} error={artifact_error}",
                    file=sys.stderr,
                )
        try:
            if artifact is None:
                operation = "artifact.initialize"
                raise RuntimeError("artifact initialization failed")
            operation = "field.start"
            start_payload = await self.field.start(target_id, run_id)
            if not start_payload.get("ok"):
                raise FieldStartError(start_payload, run_id)
            target_started = True
            operation = "field.prompt"
            prompt_payload = await self.field.prompt(target_id)
            prompt = str(prompt_payload.get("prompt") or "")
            if not prompt_payload.get("ok") or not prompt:
                raise RuntimeError("CTF Field prompt generation failed")
            cwd = self.config.work_root / safe_id(run_id)
            cwd.mkdir(parents=True, exist_ok=True)
            operation = "bridge.create_session"
            session_id = await self.bridge.create_session(
                profile,
                cwd,
                execution_mode=self.config.execution_mode,
                execution_capacity=self.config.execution_capacity,
                target_id=target_id,
                run_id=run_id,
            )
            # Persist Bridge identity before any model prompt is submitted.
            await self.state.bind_session(target_id, run_id, session_id)
            if artifact is not None:
                artifact.update_manifest(sessionId=session_id)
            operation = "bridge.verify_execution_contract"
            session_snapshot = await self.bridge.snapshot(session_id)
            execution_fields = verify_execution_contract(self.config, session_snapshot)
            await self.state.update_run(target_id, run_id, execution_fields)
            if artifact is not None:
                artifact.update_manifest(**execution_fields)
            trace = RuntimeTrace(
                self.bridge,
                artifact,
                self.state,
                target_id=target_id,
                run_id=run_id,
                session_id=session_id,
            )
            await trace.poll()
            operation = "bridge.submit"
            await self.bridge.submit(
                session_id,
                prompt,
                profile,
                web_verbs_enabled=(
                    self.config.web_verbs_enabled_for_web_only
                    and self._is_web_target(target_id)
                ),
            )
            operation = "bridge.wait_for_terminal"
            snapshot, cancel_context = await self._wait_for_terminal(session_id, trace)
            await trace.poll()
            operation = "bridge.export"
            export = await self.bridge.export(session_id)
            snapshot = terminal_snapshot_from_export(snapshot, export)
            rate_limit_code = profile_rate_limit_error_code(snapshot, export)
            metrics = export_metrics(export)
            ended_at = now_iso()
            duration_seconds = round(max(0.0, time.monotonic() - started_monotonic), 3)
            done = strict_verified_done(snapshot)
            status = "done" if done else "failed"
            operation = "field.record"
            record_run_id = str(start_payload.get("run_id") or run_id)
            record_terminal_reason = str(snapshot.get("terminalReason") or "infra_failed")
            record_verification_state = str(snapshot.get("verificationState") or "not_attempted")
            record_process_note = process_note_from_export(export)
            record_response = await self.field.record({
                "target_id": target_id,
                "status": status,
                "failure_reason": None if done else controlled_failure_reason(snapshot),
                "process_summary": controlled_summary(
                    snapshot,
                    profile,
                    metrics,
                    started_at=started_at,
                    ended_at=ended_at,
                    duration_seconds=duration_seconds,
                    max_turns=self.config.max_turns,
                ),
                "process_note": record_process_note,
                "target_url": start_payload.get("target_url") or None,
                "assets_path": start_payload.get("assets_path") or None,
                "run_id": record_run_id,
                "terminal_reason": record_terminal_reason,
                "verification_state": record_verification_state,
                **cancel_metadata(snapshot, cancel_context, target_id, session_id),
            })
            validate_record_response(
                record_response,
                target_id=target_id,
                run_id=record_run_id,
                session_id=session_id,
                status=status,
                terminal_reason=record_terminal_reason,
                verification_state=record_verification_state,
                process_note=record_process_note,
            )
            record_status = "saved"
            result = {
                "status": status,
                "terminalReason": snapshot.get("terminalReason") or "infra_failed",
                "verificationState": snapshot.get("verificationState") or "not_attempted",
                "sessionId": session_id,
                **profile_fields,
                "recordStatus": "saved",
                "startedAt": started_at,
                "endedAt": ended_at,
                "durationSeconds": duration_seconds,
                "turns": metrics["turns"],
                "toolCalls": metrics["tool_calls"],
                "maxTurns": self.config.max_turns,
                **execution_fields,
                **failure_metadata(snapshot),
            }
            if rate_limit_code:
                result["errorCode"] = rate_limit_code
            return result
        except Exception as exc:
            failed_operation = operation
            error_name = type(exc).__name__
            error_code = safe_error_code(exc)
            if isinstance(exc, ExecutionContractMismatch):
                contract_mismatch = exc
                execution_fields.update({
                    "effectiveExecutionMode": str(exc.effective_mode or ""),
                    "effectiveExecutionCapacity": _nonnegative_int(exc.effective_capacity),
                    "legacyPlanningMode": str(exc.legacy_planning_mode or ""),
                })
            export_error = ""
            if trace is not None:
                await trace.poll()
            if session_id:
                try:
                    export = await self.bridge.export(session_id)
                except Exception as export_exc:
                    export_error = safe_error_code(export_exc)
                with contextlib.suppress(Exception):
                    snapshot = await self.bridge.snapshot(session_id)
            if contract_mismatch is not None:
                snapshot = dict(contract_mismatch.snapshot)
                snapshot.update({
                    "status": "error",
                    "taskKind": "ctf",
                    "terminalReason": "execution_contract_mismatch",
                    "verificationState": "not_attempted",
                    "outcome": "failed",
                })
            else:
                snapshot = terminal_snapshot_from_export(snapshot, export)
            export = auditable_export(export, snapshot, export_error)
            metrics = export_metrics(export)
            ended_at = now_iso()
            duration_seconds = round(max(0.0, time.monotonic() - started_monotonic), 3)
            done = strict_verified_done(snapshot)
            status = "done" if done else "failed"
            record_status = "not_applicable" if not target_started else "not_attempted"
            record_error = ""
            if target_started:
                try:
                    record_run_id = str(start_payload.get("run_id") or run_id)
                    record_terminal_reason = str(snapshot.get("terminalReason") or "infra_failed")
                    record_verification_state = str(snapshot.get("verificationState") or "not_attempted")
                    record_process_note = process_note_from_export(export)
                    record_failure_reason = (
                        controlled_failure_reason(snapshot)
                        if str(snapshot.get("terminalReason") or "") not in {"", "infra_failed"}
                        else (
                            f"infra_failed; controller={error_name}; "
                            f"operation={failed_operation}; error={error_code}"
                        )
                    )
                    record_response = await self.field.record({
                        "target_id": target_id,
                        "status": status,
                        "failure_reason": None if done else record_failure_reason,
                        "process_summary": (
                            f"bridge evaluation controller failed: {error_name}; "
                            f"operation={failed_operation}; error={error_code}; "
                            f"turns={metrics['turns']}; turns_used={metrics['turns']}; "
                            f"max_turns={self.config.max_turns}; tool_calls={metrics['tool_calls']}; "
                            f"started_at={started_at}; ended_at={ended_at}; "
                            f"duration_seconds={duration_seconds:g}"
                        ),
                        "process_note": record_process_note,
                        "target_url": start_payload.get("target_url") or None,
                        "assets_path": start_payload.get("assets_path") or None,
                        "run_id": record_run_id,
                        "terminal_reason": record_terminal_reason,
                        "verification_state": record_verification_state,
                        **cancel_metadata(snapshot, cancel_context, target_id, session_id),
                    })
                    validate_record_response(
                        record_response,
                        target_id=target_id,
                        run_id=record_run_id,
                        session_id=session_id,
                        status=status,
                        terminal_reason=record_terminal_reason,
                        verification_state=record_verification_state,
                        process_note=record_process_note,
                    )
                    record_status = "saved"
                except Exception as record_exc:
                    record_status = "failed"
                    record_error = safe_error_code(record_exc)
                    print(
                        f"controller warning: result record failed: target={safe_id(target_id)} "
                        f"error={record_error}",
                        file=sys.stderr,
                    )
            record_persisted = record_status in {"saved", "not_applicable"}
            result_status = status if record_persisted else "failed"
            result = {
                "status": result_status,
                "terminalReason": (
                    snapshot.get("terminalReason") or "infra_failed"
                    if record_persisted
                    else "record_save_failed"
                ),
                "verificationState": snapshot.get("verificationState") or "not_attempted",
                "sessionId": session_id,
                **profile_fields,
                "errorClass": error_name,
                "errorCode": error_code,
                "operation": failed_operation,
                "errorOperation": failed_operation,
                **({"infraFailureDiagnostics": exc.diagnostic} if isinstance(exc, FieldStartError) else {}),
                "recordStatus": record_status,
                "startedAt": started_at,
                "endedAt": ended_at,
                "durationSeconds": duration_seconds,
                "turns": metrics["turns"],
                "toolCalls": metrics["tool_calls"],
                "maxTurns": self.config.max_turns,
                **execution_fields,
                **failure_metadata(snapshot),
                **({"recordErrorCode": record_error} if record_error else {}),
                **(
                    {"artifactState": "unavailable", "artifactError": artifact_error}
                    if artifact is None
                    else {}
                ),
            }
            return result
        finally:
            if not export:
                export = auditable_export(export, snapshot, "Unavailable")
            if artifact is not None:
                planning_trace = PlanningTraceExport(
                    self.bridge,
                    artifact,
                    self.config,
                    session_id=session_id,
                )
                try:
                    await planning_trace.collect()
                except Exception as exc:
                    # Keep diagnostic export failures isolated from the task
                    # result and the existing artifact/cleanup contract.
                    planning_trace.state = (
                        "partial" if planning_trace._successful_pages > 0 else "unavailable"
                    )
                    planning_trace.complete = False
                    planning_trace.error_code = f"planning_trace_{safe_error_code(exc)}"
                    planning_trace._persist()
                result.update(planning_trace.fields())
                with contextlib.suppress(Exception):
                    outer_metrics = planning_trace_metrics(artifact.planning_events_path)
                    result["planningMetrics"] = outer_metrics
                    result.update(reconcile_planning_verification(result, artifact.planning_events_path))
                    # The durable live ledger remains authoritative. Trace counts
                    # are a lower bound and must never be added to it a second time.
                    result["turns"] = max(int(result.get("turns") or 0), outer_metrics["plannerCalls"] + outer_metrics["executorTurns"])
                    result["toolCalls"] = max(int(result.get("toolCalls") or 0), outer_metrics["toolCallsStarted"])
            observed_execution_fields = execution_metadata(self.config, snapshot)
            for field_name in (
                "effectiveExecutionMode",
                "effectiveExecutionCapacity",
                "legacyPlanningMode",
            ):
                observed_value = observed_execution_fields.get(field_name)
                if observed_value not in ("", None):
                    execution_fields[field_name] = observed_value
            result.update(execution_fields)
            if artifact is not None:
                with contextlib.suppress(Exception):
                    artifact.update_manifest(**execution_fields)
                result["artifactDir"] = str(artifact.path)
                artifact_result = {
                    **result,
                    "targetId": target_id,
                    **profile_fields,
                    "lane": lane_number,
                    "recordStatus": record_status,
                    "recordErrorClass": record_error,
                    "snapshot": snapshot,
                    "artifactError": artifact_error,
                    **execution_fields,
                }
                try:
                    artifact.finalize(
                        result=artifact_result,
                        export=export,
                        trace_complete=trace.trace_complete if trace is not None else False,
                        trace_gap_reason=trace.trace_gap_reason if trace is not None else "no_trace",
                        log_epoch=trace.log_epoch if trace is not None else "",
                        after_event_id=trace.after_event_id if trace is not None else 0,
                        after_message_id=trace.after_message_id if trace is not None else 0,
                    )
                    artifact_finalized = True
                    result["artifactState"] = "complete"
                    result["traceComplete"] = trace.trace_complete if trace is not None else False
                    result["traceGapReason"] = trace.trace_gap_reason if trace is not None else "no_trace"
                except Exception as exc:
                    artifact_error = f"{type(exc).__name__}:{safe_id(str(exc), 120)}"
                    result["artifactState"] = "incomplete"
                    result["artifactError"] = artifact_error
                    print(
                        f"controller warning: artifact finalization failed: "
                        f"target={safe_id(target_id)} error={artifact_error}",
                        file=sys.stderr,
                    )

            target_stop_status = "not_started"
            session_cleanup_status = "not_created"
            workspace_cleanup_status = "not_created"
            if artifact_finalized and target_started:
                target_stop_status = await self._stop_target_with_retry(
                    target_id,
                    str(start_payload.get("run_id") or run_id),
                )
            elif target_started:
                target_stop_status = "preserved_artifact_incomplete"
            if artifact_finalized and session_id:
                session_cleanup_status = (
                    "deleted" if await self._delete_session_with_retry(session_id) else "failed"
                )
            elif session_id:
                session_cleanup_status = "preserved_artifact_incomplete"
            workspace_cleanup_status = (
                self._cleanup_workspace(
                    cwd,
                    session_deleted=session_cleanup_status in {"deleted", "not_created"},
                    record_saved=record_status in {"saved", "not_applicable"},
                    target_stopped=target_stop_status in {"stopped", "not_started"},
                )
                if artifact_finalized
                else "preserved_artifact_incomplete"
            )
            result.update({
                "recordStatus": record_status,
                "targetStopStatus": target_stop_status,
                "sessionCleanupStatus": session_cleanup_status,
                "workspaceCleanupStatus": workspace_cleanup_status,
            })
            if artifact is not None and artifact_finalized:
                with contextlib.suppress(Exception):
                    artifact.write_result({
                        **result,
                        "targetId": target_id,
                        "profile": profile,
                        "lane": lane_number,
                        "snapshot": snapshot,
                    })
            self._cleanup_diagnostics[run_id] = {
                "targetStopStatus": target_stop_status,
                "sessionCleanupStatus": session_cleanup_status,
                "workspaceCleanupStatus": workspace_cleanup_status,
            }

    async def _stop_target_with_retry(self, target_id: str, run_id: str) -> str:
        last_error = "unknown"
        for attempt in range(1, FIELD_STOP_RETRIES + 1):
            try:
                response = await self.field.stop(target_id, run_id)
                if not isinstance(response, dict) or response.get("ok") is False:
                    raise RuntimeError("CTF Field stop rejected")
                rows = await self.field.all_targets()
                target = next(
                    (row for row in rows if str(row.get("target_id") or row.get("id") or "") == target_id),
                    None,
                )
                if target is None:
                    raise RuntimeError("target missing after stop")
                if target.get("running"):
                    raise RuntimeError("target still running after stop")
                return "stopped"
            except Exception as exc:
                last_error = safe_error_code(exc)
                if attempt < FIELD_STOP_RETRIES:
                    await asyncio.sleep(float(attempt))
        print(
            f"controller warning: target stop verification failed: "
            f"target={safe_id(target_id)} error={last_error}",
            file=sys.stderr,
        )
        return f"failed:{last_error}"

    async def _delete_session_with_retry(self, session_id: str) -> bool:
        """Best-effort cleanup with an observable, bounded retry policy.

        A 404 means another actor already removed the session and is therefore
        a successful cleanup outcome.  Other failures are reported so they do
        not silently accumulate and block a later batch's session guard.
        """
        last_error = "unknown"
        for attempt in range(1, SESSION_DELETE_RETRIES + 1):
            try:
                await self.bridge.delete(session_id)
                return True
            except RuntimeError as exc:
                if "HTTP 404 DELETE" in str(exc):
                    return True
                last_error = safe_error_code(exc)
                if attempt == SESSION_DELETE_RETRIES:
                    print(
                        f"controller warning: bridge session cleanup failed "
                        f"after {attempt} attempt(s): {session_id} error={last_error}",
                        file=sys.stderr,
                    )
                    return False
            except Exception as exc:
                last_error = safe_error_code(exc)
                if attempt == SESSION_DELETE_RETRIES:
                    print(
                        f"controller warning: bridge session cleanup failed "
                        f"after {attempt} attempt(s): {session_id} error={last_error}",
                        file=sys.stderr,
                    )
                    return False
            await asyncio.sleep(float(min(attempt * 2, 8)))
        return False

    async def _wait_for_terminal(
        self,
        session_id: str,
        trace: RuntimeTrace | None = None,
    ) -> tuple[dict[str, Any], dict[str, str]]:
        deadline = time.monotonic() + self.config.wall_timeout_seconds
        while True:
            if trace is not None:
                await trace.poll()
            snapshot = await self.bridge.snapshot(session_id)
            status = str(snapshot.get("status") or "")
            if strict_verified_done(snapshot) and status in RUNNING_SESSION_STATES:
                cancel_context = {
                    "cancel_source": "bridge_eval_controller",
                    "cancel_reason": "trusted_verifier_success",
                    "cancel_at": now_iso(),
                    "pre_cancel_status": str(snapshot.get("status") or ""),
                }
                await self.bridge.cancel_verified(session_id)
                cancelled = await self.bridge.snapshot(session_id)
                snapshot = {
                    **snapshot,
                    **cancelled,
                    "taskKind": "ctf",
                    "terminalReason": "verified_true",
                    "verificationState": "accepted",
                }
                if trace is not None:
                    await trace.poll()
                return normalize_ctf_terminal_snapshot(snapshot), cancel_context
            if status not in RUNNING_SESSION_STATES:
                if trace is not None:
                    await trace.poll()
                return normalize_ctf_terminal_snapshot(snapshot), {}
            if time.monotonic() >= deadline:
                cancel_context = {
                    "cancel_source": "controller_wall_timeout",
                    "cancel_reason": "wall_clock_timeout",
                    "cancel_at": now_iso(),
                    "pre_cancel_status": str(snapshot.get("status") or ""),
                }
                await self.bridge.cancel_timeout(session_id)
                snapshot = await self.bridge.snapshot(session_id)
                if not str(snapshot.get("terminalReason") or ""):
                    snapshot["terminalReason"] = "wall_clock_timeout"
                if trace is not None:
                    await trace.poll()
                return normalize_ctf_terminal_snapshot(snapshot), cancel_context
            await asyncio.sleep(self.config.poll_seconds)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Three-lane bridge-backed CTF evaluation controller")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH)
    parser.add_argument("--target-id", action="append", default=[], help="limit to one or more exact target IDs")
    parser.add_argument("--plan-limit", type=int, default=18, help="maximum preview rows in default dry-run mode")
    parser.add_argument("--list-running", action="store_true", help="list durable running leases for crash recovery")
    parser.add_argument("--execute", action="store_true", help="enable state-changing execution")
    parser.add_argument("--confirm", default="", help=f"must equal {EXECUTE_CONFIRMATION!r} when executing")
    parser.add_argument("--max-targets", type=int, default=0, help="required positive cap when executing")
    parser.add_argument(
        "--allow-done-rerun",
        action="store_true",
        help="explicitly allow selected targets whose current status is done to be rerun",
    )
    return parser


def validate_execute_args(args: argparse.Namespace) -> None:
    if not args.execute:
        return
    if args.confirm != EXECUTE_CONFIRMATION:
        raise ValueError("execution confirmation string is missing or incorrect")
    if args.max_targets <= 0:
        raise ValueError("--max-targets must be positive in execute mode")


async def async_main(args: argparse.Namespace) -> int:
    validate_execute_args(args)
    config = ControllerConfig.load(args.config)
    field = FieldClient(JsonHttpClient(config.field_base, config.request_timeout_seconds))
    bridge = BridgeClient(
        JsonHttpClient(config.bridge_base, config.request_timeout_seconds),
        max_turns=config.max_turns,
        memory_reference_enabled=config.memory_reference_enabled,
    )
    state = StateStore(config.state_root)
    controller = EvaluationController(
        config,
        field,
        bridge,
        state,
        allow_done_rerun=args.allow_done_rerun,
    )
    if args.list_running:
        if args.execute:
            raise ValueError("--list-running cannot be combined with --execute")
        state.load()
        print(json.dumps({"running": state.running_records()}, ensure_ascii=False, indent=2))
        return 0
    target_ids = set(args.target_id) or None
    if not args.execute:
        await controller.preflight(probe_profiles=False)
        plan = await controller.plan(target_ids)
        print(json.dumps({
            "mode": "dry-run",
            "totalEligible": len(plan),
            "debugProfile": config.debug_profile,
            "maxTurns": config.max_turns,
            "executionMode": config.execution_mode,
            "executionCapacity": config.execution_capacity,
            "controllerConcurrency": config.resolved_controller_concurrency(),
            "wallTimeoutSeconds": config.wall_timeout_seconds,
            "memoryReferenceEnabled": config.memory_reference_enabled,
            "webVerbsEnabledForWebOnly": config.web_verbs_enabled_for_web_only,
            "heuristicLearningEnabled": config.heuristic_learning_enabled,
            "progressivePlanningRequiredDisabled": config.require_progressive_planning_disabled,
            "preview": plan[: max(0, args.plan_limit)],
        }, ensure_ascii=False, indent=2))
        return 0
    with state.exclusive_process_lock():
        results = await controller.execute(target_ids, args.max_targets)
    print(json.dumps({
        "mode": "execute",
        "resultCount": len(results),
        "profileFailures": controller.profile_failures,
        "profileProbeAttempts": controller.profile_probe_attempts,
        "results": results,
    }, ensure_ascii=False, indent=2))
    return 0


def main(argv: Iterable[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        return asyncio.run(async_main(args))
    except (ValueError, RuntimeError, OSError, json.JSONDecodeError) as exc:
        print(f"controller error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
