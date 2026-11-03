#!/usr/bin/env python3
"""Audit Stage I batch artifacts without contacting a model or Bridge runtime."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import re
import statistics
import time
from pathlib import Path
from typing import Any, Iterable


BATCH_SIZES = {1: 12, 2: 12, 3: 11}
MODE_NAMES = {"direct": "DIRECT", "plan-single": "PLAN_SINGLE"}
EXPECTED_EFFECTIVE_MODE = {"direct": "direct", "plan-single": "plan_single"}
EXPECTED_LEGACY_MODE = {"direct": "off", "plan-single": "active"}
PLANNING_RUN_ID_RE = re.compile(r"^planning_[0-9a-f]{32}$")
PLANNING_RUN_STATUS_VALUES = {"created", "running", "paused", "blocked", "completed", "failed", "cancelled"}


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return default


def write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def load_lines(path: Path) -> list[str]:
    return [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def config_paths(config_path: Path) -> tuple[Path, Path, Path, dict[str, Any]]:
    config = load_json(config_path)
    if not isinstance(config, dict):
        raise ValueError(f"invalid config JSON: {config_path}")
    artifact_value = str(config.get("artifactRoot") or "").strip()
    state_value = str(config.get("stateRoot") or "").strip()
    work_value = str(config.get("workRoot") or "").strip()
    if not artifact_value or not state_value or not work_value:
        raise ValueError("config must declare artifactRoot, stateRoot and workRoot")
    return Path(artifact_value), Path(state_value), Path(work_value), config


def resolve_defaults(mode: str, config_path: Path | None) -> Path:
    if config_path is not None:
        return config_path
    script_dir = Path(__file__).resolve().parent
    deployed = script_dir / "stage1-20260918" / mode / "config.json"
    if deployed.exists():
        return deployed
    root = script_dir.parent / "config"
    return root / f"stage1-20260918-{mode}.json"


def resolve_batch_file(config_path: Path, batch: int, explicit: Path | None) -> Path:
    if explicit is not None:
        return explicit
    candidates = (
        config_path.parent.parent / "batches" / f"batch-{batch:02d}.txt",
        config_path.parent.parent / "config" / "stage1-batches" / f"batch-{batch:02d}.txt",
        config_path.parent.parent / "stage1-batches" / f"batch-{batch:02d}.txt",
        Path(__file__).resolve().parents[1] / "config" / "stage1-batches" / f"batch-{batch:02d}.txt",
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


def resolve_target_file(config_path: Path, explicit: Path | None) -> Path:
    if explicit is not None:
        return explicit
    candidates = (
        config_path.parent.parent / "targets.txt",
        config_path.parent.parent / "config" / "stage1-targets.txt",
        config_path.parent.parent / "stage1-targets.txt",
        Path(__file__).resolve().parents[1] / "config" / "stage1-targets.txt",
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


def normalize_mode(value: Any) -> str:
    return str(value or "").strip().lower().replace("-", "_")


def _read_artifact(path: Path) -> dict[str, Any]:
    manifest_path = path / "manifest.json"
    manifest_raw = load_json(manifest_path)
    manifest_error = "" if isinstance(manifest_raw, dict) else "missing_or_invalid_manifest"
    result_path = path / "result.json"
    export_path = path / "session-export.json"
    events_path = path / "runtime-events.jsonl"
    result_raw = load_json(result_path)
    export_raw = load_json(export_path)
    return {
        "path": path,
        "manifest": manifest_raw if isinstance(manifest_raw, dict) else {},
        "manifestError": manifest_error,
        "result": result_raw if isinstance(result_raw, dict) else {},
        "export": export_raw if isinstance(export_raw, dict) else {},
        "manifestPath": manifest_path,
        "resultPath": result_path,
        "exportPath": export_path,
        "eventsPath": events_path,
        "planningEventsPath": path / "planning-events.jsonl",
    }


def scan_artifacts(artifact_root: Path) -> list[dict[str, Any]]:
    if not artifact_root.exists():
        return []
    artifacts: list[dict[str, Any]] = []
    for child in sorted(artifact_root.iterdir()):
        if child.is_dir() and (child / "manifest.json").exists():
            artifacts.append(_read_artifact(child))
    return artifacts


def _run_ids_from_batch_manifest(path: Path) -> set[str]:
    payload = load_json(path, {})
    if not isinstance(payload, dict):
        return set()
    values = payload.get("runIds") or payload.get("observedRunIds") or []
    return {str(value) for value in values if str(value)} if isinstance(values, list) else set()


def _latest_by_target(artifacts: list[dict[str, Any]], expected: set[str]) -> dict[str, dict[str, Any]]:
    selected: dict[str, dict[str, Any]] = {}
    for artifact in artifacts:
        target_id = str(artifact["manifest"].get("targetId") or "")
        if target_id not in expected:
            continue
        current = selected.get(target_id)
        key = (str(artifact["manifest"].get("startedAt") or ""), str(artifact["path"]))
        current_key = (
            str(current["manifest"].get("startedAt") or ""),
            str(current["path"]),
        ) if current else ("", "")
        if current is None or key >= current_key:
            selected[target_id] = artifact
    return selected


def _as_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _as_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _planning_trace_audit(artifact: dict[str, Any], *, applicable: bool) -> dict[str, Any]:
    """Check Planning trace structure without using it as an outcome signal."""
    manifest = artifact["manifest"]
    path = artifact["planningEventsPath"]
    state = str(manifest.get("planningTraceState") or "")
    planning_run_id = str(manifest.get("planningRunId") or "")
    manifest_count = _as_int(manifest.get("planningTraceEventCount"))
    complete = manifest.get("planningTraceComplete")
    error_code = str(manifest.get("planningTraceErrorCode") or "")
    raw_planning_status = manifest.get("planningStatus")
    planning_status: str | None
    issues: list[str] = []
    events: list[dict[str, Any]] = []
    line_count = 0
    file_present = path.is_file()

    if not file_present:
        issues.append("missing_file")
    else:
        try:
            for raw_line in path.read_text(encoding="utf-8").splitlines():
                if not raw_line.strip():
                    continue
                line_count += 1
                try:
                    event = json.loads(raw_line)
                except (TypeError, json.JSONDecodeError):
                    issues.append("invalid_json")
                    continue
                if not isinstance(event, dict):
                    issues.append("invalid_event")
                    continue
                events.append(event)
        except (OSError, UnicodeDecodeError):
            issues.append("unreadable_file")

    if state not in {"available", "partial", "unavailable", "not_applicable"}:
        issues.append("invalid_state")
    if raw_planning_status is None or raw_planning_status == "":
        planning_status = None
    elif isinstance(raw_planning_status, str):
        planning_status = raw_planning_status.strip() or None
    else:
        planning_status = None
        issues.append("invalid_planning_status")
    if complete is not True and complete is not False:
        issues.append("missing_complete_flag")
    if manifest_count is None or manifest_count < 0:
        issues.append("invalid_event_count")
    elif manifest_count != line_count:
        issues.append("event_count_mismatch")

    run_id_valid = bool(PLANNING_RUN_ID_RE.fullmatch(planning_run_id))
    if applicable:
        if state in {"available", "partial"} and not run_id_valid:
            issues.append("invalid_run_id")
        if state == "available" and not planning_run_id:
            issues.append("missing_run_id")
        if planning_status is not None and planning_status not in PLANNING_RUN_STATUS_VALUES and planning_status != "unknown":
            issues.append("invalid_planning_status")
        if state == "available" and planning_status not in PLANNING_RUN_STATUS_VALUES:
            issues.append("missing_planning_status")
        if not planning_run_id and planning_status in PLANNING_RUN_STATUS_VALUES:
            issues.append("status_without_run")
    else:
        if state != "not_applicable":
            issues.append("direct_state_not_applicable")
        if planning_run_id:
            issues.append("direct_run_id_present")
        if planning_status not in (None, "not_applicable"):
            issues.append("direct_planning_status_present")
        if events:
            issues.append("direct_events_present")

    seen_event_ids: set[str] = set()
    seen_sequences: set[int] = set()
    last_sequence = -1
    event_identity_valid = True
    for event in events:
        event_run_id = str(event.get("runId") or "")
        event_id = str(event.get("eventId") or "")
        sequence = _as_int(event.get("sequence"))
        if event_run_id != planning_run_id:
            issues.append("event_run_id_mismatch")
        if not event_id or sequence is None or sequence < 0:
            event_identity_valid = False
            issues.append("event_identity_invalid")
            continue
        if event_id in seen_event_ids or sequence in seen_sequences or sequence <= last_sequence:
            event_identity_valid = False
            issues.append("event_order_invalid")
        seen_event_ids.add(event_id)
        seen_sequences.add(sequence)
        last_sequence = max(last_sequence, sequence)

    if state in {"available", "not_applicable"} and complete is not True:
        issues.append("state_complete_mismatch")
    if state in {"partial", "unavailable"} and complete is not False:
        issues.append("state_incomplete_mismatch")
    if state in {"available", "not_applicable"} and error_code:
        issues.append("unexpected_error_code")
    if state in {"partial", "unavailable"} and not error_code:
        issues.append("missing_error_code")
    if state == "partial" and not events:
        issues.append("partial_without_events")

    unique_issues = sorted(set(issues))
    return {
        "applicable": applicable,
        "ok": not unique_issues,
        "state": state,
        "filePresent": file_present,
        "planningRunId": planning_run_id,
        "runIdValid": run_id_valid if applicable else not planning_run_id,
        "eventCount": line_count,
        "manifestEventCount": manifest_count,
        "eventRunIdsValid": all(str(event.get("runId") or "") == planning_run_id for event in events),
        "eventOrderValid": event_identity_valid,
        "stateConsistent": not any(
            issue in unique_issues
            for issue in (
                "invalid_state",
                "missing_complete_flag",
                "state_complete_mismatch",
                "state_incomplete_mismatch",
                "unexpected_error_code",
                "missing_error_code",
                "invalid_planning_status",
                "missing_planning_status",
                "status_without_run",
                "direct_planning_status_present",
            )
        ),
        "planningStatus": planning_status,
        "planningStatusValid": planning_status in PLANNING_RUN_STATUS_VALUES,
        "issues": unique_issues,
    }


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * percentile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def distribution(values: list[float | int]) -> dict[str, float | int | None]:
    numbers = [float(value) for value in values]
    if not numbers:
        return {"n": 0, "mean": None, "median": None, "min": None, "max": None, "p90": None}
    return {
        "n": len(numbers),
        "mean": round(statistics.mean(numbers), 3),
        "median": round(statistics.median(numbers), 3),
        "min": min(numbers),
        "max": max(numbers),
        "p90": round(_percentile(numbers, 0.9) or 0.0, 3),
    }


def _state_metrics(state_root: Path) -> tuple[int, int]:
    state = load_json(state_root / "state.json", {})
    targets = state.get("targets") if isinstance(state, dict) else {}
    running = [value for value in (targets or {}).values() if isinstance(value, dict) and value.get("state") == "running"]
    running_sessions = sum(1 for value in running if str(value.get("sessionId") or ""))
    return len(running), running_sessions


def _workspace_leaks(work_root: Path) -> int:
    if not work_root.exists():
        return 0
    return sum(1 for child in work_root.iterdir() if child.is_dir() and child.name != "profile-preflight")


def _load_batch_manifest(config_path: Path, batch: int) -> tuple[Path, dict[str, Any]]:
    path = config_path.parent / f"batch-{batch:02d}-manifest.json"
    payload = load_json(path, {})
    return path, payload if isinstance(payload, dict) else {}


def _case_from_artifact(
    target_id: str,
    artifact: dict[str, Any] | None,
    *,
    expected_mode: str,
) -> dict[str, Any]:
    if artifact is None:
        planning_applicable = expected_mode == "PLAN_SINGLE"
        return {
            "targetId": target_id,
            "artifactPresent": False,
            "runId": "",
            "sessionId": "",
            "profile": None,
            "lane": None,
            "artifactState": "missing",
            "traceComplete": False,
            "traceGapReason": "missing_artifact",
            "missingResult": True,
            "missingExport": True,
            "status": "failed",
            "terminalReason": "missing_artifact",
            "verificationState": "not_attempted",
            "requestedExecutionMode": "",
            "effectiveExecutionMode": "",
            "effectiveExecutionCapacity": None,
            "legacyPlanningMode": "",
            "durationSeconds": None,
            "turns": None,
            "toolCalls": None,
            "recordStatus": "",
            "planningStatus": None,
            "planningTraceState": "missing_artifact",
            "planningTraceAudit": {
                "applicable": planning_applicable,
                "ok": False,
                "state": "missing_artifact",
                "filePresent": False,
                "planningRunId": "",
                "runIdValid": False,
                "eventCount": 0,
                "manifestEventCount": None,
                "eventRunIdsValid": False,
                "eventOrderValid": False,
                "stateConsistent": False,
                "planningStatus": None,
                "planningStatusValid": False,
                "issues": ["missing_artifact"],
            },
        }
    manifest = artifact["manifest"]
    result = artifact["result"]
    observed_modes = {
        normalize_mode(manifest.get("requestedExecutionMode")),
        normalize_mode(manifest.get("effectiveExecutionMode")),
    }
    planning_applicable = expected_mode == "PLAN_SINGLE" or "plan_single" in observed_modes
    planning_trace = _planning_trace_audit(artifact, applicable=planning_applicable)
    snapshot = result.get("snapshot") if isinstance(result.get("snapshot"), dict) else {}
    terminal_reason = str(result.get("terminalReason") or snapshot.get("terminalReason") or "")
    verification = str(result.get("verificationState") or snapshot.get("verificationState") or "not_attempted")
    trace_complete = bool(manifest.get("traceComplete") is True)
    trace_gap_reason = str(manifest.get("traceGapReason") or "")
    if not artifact["eventsPath"].is_file():
        trace_complete = False
        trace_gap_reason = trace_gap_reason or "missing_runtime_events"
    return {
        "targetId": target_id,
        "artifactPresent": True,
        "runId": str(manifest.get("runId") or result.get("runId") or ""),
        "sessionId": str(manifest.get("sessionId") or result.get("sessionId") or ""),
        "profile": manifest.get("profile", result.get("profile")),
        "lane": manifest.get("lane", result.get("lane")),
        "artifactState": str(manifest.get("artifactState") or ""),
        "traceComplete": trace_complete,
        "traceGapReason": trace_gap_reason,
        "manifestError": artifact["manifestError"],
        "missingResult": not artifact["resultPath"].is_file(),
        "missingExport": not artifact["exportPath"].is_file(),
        "status": str(result.get("status") or ("done" if terminal_reason == "verified_true" else "failed")),
        "terminalReason": terminal_reason,
        "verificationState": verification,
        "requestedExecutionMode": str(manifest.get("requestedExecutionMode") or result.get("requestedExecutionMode") or ""),
        "effectiveExecutionMode": str(manifest.get("effectiveExecutionMode") or result.get("effectiveExecutionMode") or ""),
        "effectiveExecutionCapacity": manifest.get("effectiveExecutionCapacity", result.get("effectiveExecutionCapacity")),
        "legacyPlanningMode": str(manifest.get("legacyPlanningMode") or result.get("legacyPlanningMode") or ""),
        "durationSeconds": _as_float(result.get("durationSeconds")),
        "turns": _as_int(result.get("turns")),
        "toolCalls": _as_int(result.get("toolCalls")),
        "recordStatus": str(result.get("recordStatus") or ""),
        "profileCooldownSeconds": _as_float(result.get("profileCooldownSeconds")),
        "planningStatus": planning_trace["planningStatus"],
        "planningTraceState": planning_trace["state"],
        "planningTraceAudit": planning_trace,
    }


def audit_batch(
    mode: str,
    batch: int,
    *,
    config_path: Path,
    targets_path: Path | None = None,
    batch_path: Path | None = None,
    results_root: Path | None = None,
    write_outputs: bool = True,
) -> dict[str, Any]:
    mode = mode.lower().replace("_", "-")
    if mode not in MODE_NAMES:
        raise ValueError(f"unsupported mode: {mode}")
    if batch not in BATCH_SIZES:
        raise ValueError(f"batch must be 1, 2 or 3: {batch}")
    artifact_root, state_root, work_root, config = config_paths(config_path)
    targets_path = targets_path or resolve_target_file(config_path, None)
    batch_path = batch_path or resolve_batch_file(config_path, batch, None)
    expected = load_lines(batch_path) if batch_path.exists() else []
    target_list = load_lines(targets_path) if targets_path.exists() else []
    batch_manifest_path, batch_manifest = _load_batch_manifest(config_path, batch)
    run_ids = _run_ids_from_batch_manifest(batch_manifest_path)
    artifacts = scan_artifacts(artifact_root)
    if run_ids:
        scoped = [artifact for artifact in artifacts if str(artifact["manifest"].get("runId") or "") in run_ids]
    else:
        scoped = artifacts
    selected = _latest_by_target(scoped, set(expected))
    expected_mode = MODE_NAMES[mode]
    cases = [
        _case_from_artifact(target_id, selected.get(target_id), expected_mode=expected_mode)
        for target_id in expected
    ]
    running_lease_count, state_session_leaks = _state_metrics(state_root)
    configured_session_leaks = _as_int(batch_manifest.get("sessionLeakCount"))
    session_leak_count = configured_session_leaks if configured_session_leaks is not None else state_session_leaks
    configured_workspace_leaks = _as_int(batch_manifest.get("workspaceLeakCount"))
    workspace_leak_count = configured_workspace_leaks if configured_workspace_leaks is not None else _workspace_leaks(work_root)
    effective_expected = EXPECTED_EFFECTIVE_MODE[mode]
    legacy_expected = EXPECTED_LEGACY_MODE[mode]
    config_mode = normalize_mode(config.get("executionMode"))
    contract_mismatch_cases = [
        case for case in cases
        if case["artifactPresent"] and (
            str(case["requestedExecutionMode"]).upper().replace("-", "_") != expected_mode
            or normalize_mode(case["effectiveExecutionMode"]) != effective_expected
            or _as_int(case["effectiveExecutionCapacity"]) != 1
            or str(case["legacyPlanningMode"]).lower() != legacy_expected
        )
    ]
    reason_counts: dict[str, int] = {}
    for case in cases:
        reason = case["terminalReason"] or "missing_terminal_reason"
        reason_counts[reason] = reason_counts.get(reason, 0) + 1
    done_count = sum(1 for case in cases if case["status"] == "done" and case["terminalReason"] == "verified_true" and case["verificationState"] == "accepted")
    trace_incomplete = sum(1 for case in cases if not case["traceComplete"])
    planning_trace_audits = [case["planningTraceAudit"] for case in cases]
    planning_trace_integrity_issues = sum(1 for item in planning_trace_audits if not item["ok"])
    planning_trace_applicable = sum(1 for item in planning_trace_audits if item["applicable"])
    planning_trace_states = {
        state: sum(1 for item in planning_trace_audits if item["state"] == state)
        for state in ("available", "partial", "unavailable", "not_applicable", "missing_artifact")
    }
    missing_result = sum(1 for case in cases if case["missingResult"])
    missing_export = sum(1 for case in cases if case["missingExport"])
    artifact_complete = sum(1 for case in cases if case["artifactState"] == "complete")
    configured_profile_failures = batch_manifest.get("profileFailures") or {}
    profile_failures = len(configured_profile_failures) if isinstance(configured_profile_failures, dict) else _as_int(configured_profile_failures) or 0
    cooldown_events = _as_int(batch_manifest.get("cooldownEvents")) or 0
    cooldown_events += sum(1 for case in cases if (_as_float(case.get("profileCooldownSeconds")) or 0.0) > 0.0)
    trace_gap_reasons: dict[str, int] = {}
    for case in cases:
        reason = case.get("traceGapReason") or ""
        if reason:
            trace_gap_reasons[reason] = trace_gap_reasons.get(reason, 0) + 1
    duration_values = [case["durationSeconds"] for case in cases if case["durationSeconds"] is not None]
    turn_values = [case["turns"] for case in cases if case["turns"] is not None]
    tool_values = [case["toolCalls"] for case in cases if case["toolCalls"] is not None]
    missing_targets = sorted(set(expected) - set(target_list)) if target_list else list(expected)
    duplicate_targets = len(expected) - len(set(expected))
    controller_exit_code = _as_int(batch_manifest.get("controllerExitCode"))
    core_failures = {
        "configModeMismatch": 0 if config_mode == expected_mode.lower() else 1,
        "configCapacityMismatch": 0 if _as_int(config.get("executionCapacity")) == 1 else 1,
        "configConcurrencyMismatch": 0 if _as_int(config.get("controllerConcurrency")) == 6 else 1,
        "targetListMissing": 0 if target_list else len(expected),
        "batchFileMissing": 0 if batch_path.exists() else 1,
        "missingTargets": missing_targets,
        "duplicateBatchTargets": duplicate_targets,
        "missingExpectedArtifacts": sum(1 for case in cases if not case["artifactPresent"]),
        "artifactIncomplete": sum(1 for case in cases if case["artifactPresent"] and case["artifactState"] != "complete"),
        "invalidManifest": sum(1 for case in cases if case.get("manifestError")),
        "missingResult": missing_result,
        "missingExport": missing_export,
        "recordSaveFailed": sum(
            1 for case in cases
            if case.get("recordStatus") in {"failed", "error", "record_save_failed"}
            or case.get("terminalReason") == "record_save_failed"
        ),
        "contractMismatchCount": len(contract_mismatch_cases),
        "runningLeaseCount": running_lease_count,
        "sessionLeakCount": session_leak_count,
        "controllerExitCode": controller_exit_code if controller_exit_code not in (None, 0) else 0,
    }
    fail_reasons = {key: value for key, value in core_failures.items() if value not in (0, [], None)}
    warn_reasons = {
        "traceIncomplete": trace_incomplete,
        "planningTraceIntegrity": planning_trace_integrity_issues,
        "profileFailures": profile_failures,
        "cooldownEvents": cooldown_events,
        "workspaceLeakCount": workspace_leak_count,
        "cleanupFailures": len(batch_manifest.get("cleanupFailures") or []),
    }
    warn_reasons = {key: value for key, value in warn_reasons.items() if value not in (0, [], None)}
    health_status = "FAIL" if fail_reasons else ("WARN" if warn_reasons else "PASS")
    health = {
        "status": health_status,
        "mode": mode,
        "batch": batch,
        "failReasons": fail_reasons,
        "warnReasons": warn_reasons,
        "generatedAt": now_iso(),
    }
    summary = {
        "schemaVersion": 1,
        "mode": mode,
        "requestedExecutionMode": expected_mode,
        "batch": batch,
        "batchFile": str(batch_path),
        "batchSha256": sha256_file(batch_path) if batch_path.exists() else "",
        "targetListSha256": sha256_file(targets_path) if targets_path.exists() else "",
        "expectedTargets": len(expected),
        "observedRuns": len(scoped),
        "artifactHealth": {
            "expectedTargets": len(expected),
            "observedRuns": len(scoped),
            "artifactComplete": artifact_complete,
            "traceComplete": len(cases) - trace_incomplete,
            "traceIncomplete": trace_incomplete,
            "planningTrace": {
                "applicable": planning_trace_applicable,
                **planning_trace_states,
                "integrityIssues": planning_trace_integrity_issues,
            },
            "missingResult": missing_result,
            "missingExport": missing_export,
            "runningLeaseCount": running_lease_count,
            "sessionLeakCount": session_leak_count,
            "workspaceLeakCount": workspace_leak_count,
        },
        "contract": {
            "requestedExecutionMode": expected_mode,
            "effectiveExecutionMode": effective_expected,
            "executionCapacity": 1,
            "legacyPlanningMode": legacy_expected,
            "contractMismatchCount": len(contract_mismatch_cases),
        },
        "outcome": {
            "done": done_count,
            "failed": len(cases) - done_count,
            "successRate": round(done_count / len(expected), 6) if expected else 0.0,
            "verifierAccepted": sum(1 for case in cases if case["verificationState"] == "accepted" and case["terminalReason"] == "verified_true"),
            "wallClockTimeout": reason_counts.get("wall_clock_timeout", 0),
            "hardTurnLimit": reason_counts.get("hard_turn_limit", 0),
            "infraFailed": reason_counts.get("infra_failed", 0),
            "planningFailed": reason_counts.get("planning_failed", 0),
            "unverifiedIdle": reason_counts.get("unverified_idle", 0),
            "recordSaveFailed": reason_counts.get("record_save_failed", 0),
            "terminalReason": reason_counts,
        },
        "cost": {
            "durationSeconds": distribution(duration_values),
            "turns": distribution(turn_values),
            "toolCalls": distribution(tool_values),
        },
        "environment": {
            "configuredLaneCount": _as_int(batch_manifest.get("configuredLaneCount")) or _as_int(config.get("controllerConcurrency")) or 0,
            "effectiveProfiles": batch_manifest.get("effectiveProfiles") or sorted({case["profile"] for case in cases if case["profile"] is not None}),
            "profileFailures": configured_profile_failures,
            "cooldownEvents": cooldown_events,
            "traceGapReason": trace_gap_reasons,
            "cleanupFailures": batch_manifest.get("cleanupFailures") or [],
        },
        "planningTrace": {
            "applicable": planning_trace_applicable,
            **planning_trace_states,
            "integrityIssues": planning_trace_integrity_issues,
        },
        "health": health,
        "generatedAt": now_iso(),
    }
    if write_outputs:
        output_root = results_root or (config_path.parent.parent / "stage1-results" / mode)
        output_root.mkdir(parents=True, exist_ok=True)
        prefix = f"batch-{batch:02d}"
        write_json_atomic(output_root / f"{prefix}-summary.json", summary)
        write_json_atomic(output_root / f"{prefix}-health.json", health)
        write_json_atomic(output_root / f"{prefix}-batch-health.json", health)
        with (output_root / f"{prefix}-cases.csv").open("w", encoding="utf-8", newline="") as handle:
            fields = [
                "targetId", "runId", "sessionId", "profile", "lane", "artifactPresent", "artifactState",
                "traceComplete", "traceGapReason", "missingResult", "missingExport", "status", "terminalReason",
                "verificationState", "requestedExecutionMode", "effectiveExecutionMode", "effectiveExecutionCapacity",
                "legacyPlanningMode", "recordStatus", "durationSeconds", "turns", "toolCalls",
                "planningTraceState",
                "planningStatus",
            ]
            writer = csv.DictWriter(handle, fieldnames=fields)
            writer.writeheader()
            writer.writerows({field: case.get(field, "") for field in fields} for case in cases)
    return {"summary": summary, "health": health, "cases": cases}


def audit_all(mode: str, *, config_path: Path, targets_path: Path | None = None, results_root: Path | None = None) -> dict[str, Any]:
    audits = [audit_batch(mode, batch, config_path=config_path, targets_path=targets_path, results_root=results_root) for batch in BATCH_SIZES]
    summaries = [item["summary"] for item in audits]
    cases = [case for item in audits for case in item["cases"]]
    expected = sum(int(summary["expectedTargets"]) for summary in summaries)
    done = sum(int(summary["outcome"]["done"]) for summary in summaries)
    reason_counts: dict[str, int] = {}
    durations: list[float] = []
    turns: list[int] = []
    tools: list[int] = []
    for summary in summaries:
        for reason, count in summary["outcome"]["terminalReason"].items():
            reason_counts[reason] = reason_counts.get(reason, 0) + int(count)
    for case in cases:
        if case["durationSeconds"] is not None:
            durations.append(case["durationSeconds"])
        if case["turns"] is not None:
            turns.append(case["turns"])
        if case["toolCalls"] is not None:
            tools.append(case["toolCalls"])
    overall_health = "FAIL" if any(item["health"]["status"] == "FAIL" for item in summaries) else (
        "WARN" if any(item["health"]["status"] == "WARN" for item in summaries) else "PASS"
    )
    overall = {
        "schemaVersion": 1,
        "mode": mode,
        "batches": [summary["batch"] for summary in summaries],
        "expectedTargets": expected,
        "observedRuns": sum(int(summary["observedRuns"]) for summary in summaries),
        "done": done,
        "failed": expected - done,
        "successRate": round(done / expected, 6) if expected else 0.0,
        "terminalReason": reason_counts,
        "cost": {
            "durationSeconds": distribution(durations),
            "turns": distribution(turns),
            "toolCalls": distribution(tools),
        },
        "batchHealth": {str(summary["batch"]): summary["health"]["status"] for summary in summaries},
        "health": overall_health,
        "generatedAt": now_iso(),
    }
    output_root = results_root or (config_path.parent.parent / "stage1-results" / mode)
    output_root.mkdir(parents=True, exist_ok=True)
    write_json_atomic(output_root / "overall-summary.json", overall)
    return {"summary": overall, "batches": audits}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=sorted(MODE_NAMES), required=True)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--batch", type=int, choices=sorted(BATCH_SIZES))
    group.add_argument("--all", action="store_true")
    parser.add_argument("--config", type=Path)
    parser.add_argument("--targets", type=Path)
    parser.add_argument("--batch-file", type=Path)
    parser.add_argument("--results-root", type=Path)
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = build_parser().parse_args(list(argv) if argv is not None else None)
    config_path = resolve_defaults(args.mode, args.config)
    try:
        payload = audit_all(args.mode, config_path=config_path, targets_path=args.targets, results_root=args.results_root) if args.all else audit_batch(
            args.mode,
            args.batch,
            config_path=config_path,
            targets_path=args.targets,
            batch_path=args.batch_file,
            results_root=args.results_root,
        )
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"stage1 audit failed: {exc}")
        return 2
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
