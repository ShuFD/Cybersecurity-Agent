#!/usr/bin/env python3
"""Run one deterministic Stage I batch and stop after its audit gate."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable

from stage1_audit import audit_batch, load_lines, write_json_atomic


BATCH_SIZES = {1: 12, 2: 12, 3: 11}
MODE_CONFIGS = {"direct": "DIRECT", "plan-single": "PLAN_SINGLE"}
EXECUTE_CONFIRMATION = "RUN_3_LANE_EVAL"
EXPECTED_PROFILES = 6


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def load_config(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"invalid config: {path}") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"config must be a JSON object: {path}")
    return payload


def default_config(mode: str) -> Path:
    script_dir = Path(__file__).resolve().parent
    deployed = script_dir / "stage1-20260918" / mode / "config.json"
    if deployed.exists():
        return deployed
    return script_dir.parent / "config" / f"stage1-20260918-{mode}.json"


def default_targets() -> Path:
    script_dir = Path(__file__).resolve().parent
    deployed = script_dir / "stage1-20260918" / "targets.txt"
    if deployed.exists():
        return deployed
    return script_dir.parent / "config" / "stage1-targets.txt"


def default_batch(mode: str, batch: int) -> Path:
    del mode
    script_dir = Path(__file__).resolve().parent
    deployed = script_dir / "stage1-20260918" / "batches" / f"batch-{batch:02d}.txt"
    if deployed.exists():
        return deployed
    return script_dir.parent / "config" / "stage1-batches" / f"batch-{batch:02d}.txt"


def validate_config(payload: dict[str, Any], mode: str) -> list[int]:
    requested = MODE_CONFIGS[mode]
    raw_mode = str(payload.get("executionMode") or "").strip().upper().replace("-", "_")
    if raw_mode != requested:
        raise ValueError(f"config executionMode={raw_mode or '<missing>'}, expected {requested}")
    try:
        capacity = int(payload["executionCapacity"])
        concurrency = int(payload["controllerConcurrency"])
        max_turns = int(payload["maxTurns"])
        wall_timeout = int(payload["wallTimeoutSeconds"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("config must declare integer executionCapacity/controllerConcurrency/maxTurns/wallTimeoutSeconds") from exc
    if capacity != 1:
        raise ValueError("Stage I requires executionCapacity=1")
    if concurrency != EXPECTED_PROFILES:
        raise ValueError("Stage I requires controllerConcurrency=6")
    if max_turns != 200:
        raise ValueError("Stage I requires maxTurns=200")
    if wall_timeout != 2400:
        raise ValueError("Stage I requires wallTimeoutSeconds=2400")
    planning_disabled = bool(payload.get("requireProgressivePlanningDisabled"))
    if mode == "direct" and not planning_disabled:
        raise ValueError("DIRECT requires requireProgressivePlanningDisabled=true")
    if mode == "plan-single" and planning_disabled:
        raise ValueError("PLAN_SINGLE requires requireProgressivePlanningDisabled=false")
    lanes = payload.get("lanes")
    if not isinstance(lanes, list) or len(lanes) != EXPECTED_PROFILES:
        raise ValueError("Stage I requires six lanes")
    profiles: list[int] = []
    for lane in lanes:
        if not isinstance(lane, list) or len(lane) != 1:
            raise ValueError("each Stage I lane must contain exactly one profile")
        try:
            profiles.append(int(lane[0]))
        except (TypeError, ValueError) as exc:
            raise ValueError("lane profile IDs must be integers") from exc
    if len(set(profiles)) != EXPECTED_PROFILES:
        raise ValueError("six execution profile IDs must be unique")
    try:
        debug_profile = int(payload["debugProfile"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("debugProfile must be an integer") from exc
    if debug_profile in profiles:
        raise ValueError("debug profile must not be in execution lanes")
    for field in ("workRoot", "stateRoot", "artifactRoot"):
        if not str(payload.get(field) or ""):
            raise ValueError(f"config must declare {field}")
    if str(payload.get("retentionClass") or "") != "pinned":
        raise ValueError("formal Stage I batches require retentionClass=pinned")
    return profiles


def _bounded_config_integer(value: Any, fallback: int, minimum: int, maximum: int) -> int:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    if not parsed.is_integer():
        return fallback
    return max(minimum, min(maximum, int(parsed)))


def planning_experiment_manifest(config: dict[str, Any]) -> dict[str, Any]:
    raw = config.get("planning")
    planning = raw if isinstance(raw, dict) else {}
    max_evidence_bytes = _bounded_config_integer(
        planning.get("maxEvidenceBytes", planning.get("max_evidence_bytes")),
        16384,
        1024,
        1048576,
    )
    executor_context_bytes = _bounded_config_integer(
        planning.get("executorContextBytes", planning.get("executor_context_bytes")),
        max_evidence_bytes,
        1024,
        1048576,
    )
    configured_observer_mode = planning.get("observerMode", planning.get("observer_mode"))
    observer_mode = (
        configured_observer_mode
        if isinstance(configured_observer_mode, str) and configured_observer_mode in {"report", "guidance"}
        else "off"
    )
    task_timeout_seconds = _bounded_config_integer(
        planning.get("taskTimeoutSeconds", planning.get("task_timeout_seconds")),
        600,
        5,
        86400,
    )
    return {
        "evidenceCatalogEnabled": planning.get("evidenceCatalogEnabled", planning.get("evidence_catalog_enabled")) is True,
        "observerMode": observer_mode,
        "taskGranularityPromptEnabled": planning.get(
            "taskGranularityPromptEnabled", planning.get("task_granularity_prompt_enabled")
        ) is True,
        "executorContextBytes": executor_context_bytes,
        "maxEvidenceBytes": max_evidence_bytes,
        "taskTimeoutMs": task_timeout_seconds * 1000,
        "observerCheckpointsMs": [180000, 420000],
        "observerFinalizeReminderMs": 540000,
        "observerMaxRemindersPerAttempt": 2,
        "evidenceCatalogDefaultPageSize": 25,
        "evidenceCatalogMaximumPageSize": 50,
    }


def validate_targets(targets_path: Path, batch_path: Path, batch: int) -> tuple[list[str], list[str]]:
    targets = load_lines(targets_path)
    if len(targets) != 35:
        raise ValueError(f"expected exactly 35 targets, found {len(targets)}")
    if len(set(targets)) != len(targets):
        raise ValueError("stage1 target list contains duplicate IDs")
    batch_targets = load_lines(batch_path)
    expected_size = BATCH_SIZES[batch]
    if len(batch_targets) != expected_size:
        raise ValueError(f"batch {batch} must contain {expected_size} targets")
    if len(set(batch_targets)) != len(batch_targets):
        raise ValueError(f"batch {batch} contains duplicate target IDs")
    start = sum(BATCH_SIZES[index] for index in range(1, batch))
    expected = targets[start:start + expected_size]
    if batch_targets != expected:
        raise ValueError(f"batch {batch} differs from the frozen stage1-targets.txt order")
    return targets, batch_targets


def request_json(base_url: str, method: str, path: str, timeout: int) -> Any:
    request = urllib.request.Request(f"{base_url.rstrip('/')}{path}", method=method, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
        raise RuntimeError(f"{method} {path} failed: {type(exc).__name__}") from exc
    try:
        return json.loads(raw.decode("utf-8")) if raw else {}
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"{method} {path} returned invalid JSON") from exc


def bridge_session_count(payload: Any) -> int:
    if not isinstance(payload, dict):
        return 0
    sessions = payload.get("sessions")
    return len(sessions) if isinstance(sessions, list) else 0


def state_running_count(state_root: Path) -> int:
    try:
        payload = json.loads((state_root / "state.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return 0
    targets = payload.get("targets") if isinstance(payload, dict) else {}
    return sum(1 for value in (targets or {}).values() if isinstance(value, dict) and value.get("state") == "running")


def workspace_count(work_root: Path) -> int:
    if not work_root.exists():
        return 0
    return sum(1 for child in work_root.iterdir() if child.is_dir() and child.name != "profile-preflight")


def repository_revision(repo_root: Path, config: dict[str, Any]) -> tuple[str, str]:
    try:
        revision = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_root,
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        revision = str(config.get("gitCommit") or "unavailable")
        return revision, "config.gitCommit"
    return revision, "git"


def assert_writable(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    probe = path / f".stage1-preflight-{os.getpid()}"
    try:
        probe.write_text("ok\n", encoding="utf-8")
    finally:
        probe.unlink(missing_ok=True)


def preflight(
    *,
    config: dict[str, Any],
    config_path: Path,
    targets_path: Path,
    batch_path: Path,
    batch_number: int,
    batch_targets: list[str],
    repo_root: Path,
) -> dict[str, Any]:
    mode = "direct" if str(config.get("executionMode")).upper() == "DIRECT" else "plan-single"
    profiles = validate_config(config, mode)
    state_root = Path(str(config["stateRoot"]))
    artifact_root = Path(str(config["artifactRoot"]))
    work_root = Path(str(config["workRoot"]))
    if artifact_root.as_posix().startswith("/tmp/") or state_root.as_posix().startswith("/tmp/") or work_root.as_posix().startswith("/tmp/"):
        raise ValueError("formal Stage I roots must use persistent storage, not /tmp")
    running_leases = state_running_count(state_root)
    if running_leases:
        raise RuntimeError(f"state contains {running_leases} running lease(s)")
    assert_writable(artifact_root)
    request_timeout = int(config.get("requestTimeoutSeconds") or 300)
    field_status = request_json(str(config.get("fieldBase") or ""), "GET", "/api/health", request_timeout)
    if isinstance(field_status, dict) and field_status.get("ok") is False:
        raise RuntimeError("CTF Field health check failed")
    bridge_status = request_json(str(config.get("bridgeBase") or ""), "GET", "/status", request_timeout)
    if not isinstance(bridge_status, dict) or not bridge_status.get("ready"):
        raise RuntimeError("Bridge is not ready")
    catalog = request_json(str(config.get("bridgeBase") or ""), "GET", "/plugins/catalog", request_timeout)
    planning = next(
        (
            item for item in (catalog.get("plugins") if isinstance(catalog, dict) else [])
            if isinstance(item, dict) and item.get("id") == "progressive-planning"
        ),
        None,
    )
    planning_enabled = bool(isinstance(planning, dict) and planning.get("effectiveEnabled") is True)
    if mode == "direct" and planning_enabled:
        raise RuntimeError("DIRECT preflight requires progressive-planning to be disabled")
    if mode == "plan-single" and not planning_enabled:
        raise RuntimeError("PLAN_SINGLE preflight requires progressive-planning to be enabled")
    bridge_sessions = request_json(str(config.get("bridgeBase") or ""), "GET", "/sessions", request_timeout)
    session_count = bridge_session_count(bridge_sessions)
    if session_count:
        raise RuntimeError(f"Bridge has {session_count} residual session(s)")
    profiles_payload = request_json(str(config.get("bridgeBase") or ""), "GET", "/model-profiles", request_timeout)
    profile_rows = [
        item for item in (profiles_payload.get("profiles") if isinstance(profiles_payload, dict) else [])
        if isinstance(item, dict) and str(item.get("id", "")).isdigit()
    ]
    available = {
        int(item["id"])
        for item in profile_rows
    }
    missing_profiles = sorted(set(profiles) - available)
    if missing_profiles:
        raise RuntimeError(f"execution profiles unavailable: {missing_profiles}")
    selected_profile_rows = [item for item in profile_rows if int(item["id"]) in profiles]
    profile_models = {str(item.get("model") or "") for item in selected_profile_rows}
    if len(selected_profile_rows) != len(profiles) or profile_models != {"MiniMax-M3"}:
        raise RuntimeError(f"execution profiles are not equivalent MiniMax-M3 profiles: {selected_profile_rows}")
    api_config = request_json(str(config.get("bridgeBase") or ""), "GET", "/api-config", request_timeout)
    api_rows = api_config.get("profiles") if isinstance(api_config, dict) else []
    api_by_provider = {
        str(item.get("piProviderId") or ""): item
        for item in (api_rows or [])
        if isinstance(item, dict) and item.get("piProviderId")
    }
    selected_api_rows = [api_by_provider.get(str(item.get("provider") or "")) for item in selected_profile_rows]
    selected_api_rows = [item for item in selected_api_rows if isinstance(item, dict)]
    api_contracts = {
        (
            str(item.get("model") or ""),
            str(item.get("apibase") or ""),
            str(item.get("api_mode") or ""),
            str(item.get("type") or ""),
        )
        for item in selected_api_rows
    }
    if len(selected_api_rows) != len(profiles) or len(api_contracts) != 1:
        raise RuntimeError("execution profiles do not share the same model/API contract")
    repository_head, repository_head_source = repository_revision(repo_root, config)
    return {
        "repositoryHead": repository_head,
        "repositoryHeadSource": repository_head_source,
        "configSha256": sha256_file(config_path),
        "targetListSha256": sha256_file(targets_path),
        "batchSha256": sha256_file(batch_path),
        "mode": str(config.get("executionMode") or ""),
        "batch": batch_number,
        "expectedTargets": len(batch_targets),
        "configuredLaneCount": 6,
        "executionProfiles": profiles,
        "profilesEquivalent": True,
        "profileInventory": selected_profile_rows,
        "profileApiContracts": sorted(api_contracts),
        "stateRunningLeaseCount": running_leases,
        "bridgeSessionCount": session_count,
        "progressivePlanningEnabled": planning_enabled,
        "artifactRootWritable": True,
        "preflightAt": now_iso(),
    }


def build_controller_command(controller_path: Path, config_path: Path, target_ids: list[str]) -> list[str]:
    command = [
        sys.executable,
        str(controller_path),
        "--config",
        str(config_path),
        "--execute",
        "--confirm",
        EXECUTE_CONFIRMATION,
        "--max-targets",
        str(len(target_ids)),
        "--allow-done-rerun",
    ]
    for target_id in target_ids:
        command.extend(("--target-id", target_id))
    return command


def _parse_controller_output(stdout: str) -> dict[str, Any]:
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError:
        return {"parseError": "controller_output_not_json", "stdoutTail": stdout[-4000:]}
    return payload if isinstance(payload, dict) else {"parseError": "controller_output_not_object"}


def _post_cleanup_metrics(config: dict[str, Any], state_root: Path, work_root: Path) -> dict[str, Any]:
    metrics: dict[str, Any] = {
        "runningLeaseCount": state_running_count(state_root),
        "workspaceLeakCount": workspace_count(work_root),
    }
    try:
        sessions = request_json(str(config.get("bridgeBase") or ""), "GET", "/sessions", int(config.get("requestTimeoutSeconds") or 300))
        metrics["sessionLeakCount"] = bridge_session_count(sessions)
    except RuntimeError as exc:
        metrics["sessionLeakCount"] = None
        metrics["cleanupFailures"] = [str(exc)]
    return metrics


def run_one(
    *,
    mode: str,
    batch: int,
    config_path: Path,
    targets_path: Path,
    batch_path: Path,
    controller_path: Path,
    repo_root: Path,
) -> dict[str, Any]:
    config = load_config(config_path)
    targets, batch_targets = validate_targets(targets_path, batch_path, batch)
    del targets
    profiles = validate_config(config, mode)
    mode_root = config_path.parent
    mode_root.mkdir(parents=True, exist_ok=True)
    manifest_path = mode_root / f"batch-{batch:02d}-manifest.json"
    repository_head, repository_head_source = repository_revision(repo_root, config)
    manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "mode": mode,
        "requestedExecutionMode": str(config.get("executionMode") or ""),
        "requestedExecutionCapacity": int(config.get("executionCapacity") or 0),
        "controllerConcurrency": int(config.get("controllerConcurrency") or 0),
        "retentionClass": str(config.get("retentionClass") or ""),
        "maxTurns": int(config.get("maxTurns") or 0),
        "wallTimeoutSeconds": int(config.get("wallTimeoutSeconds") or 0),
        "batch": batch,
        "batchFile": str(batch_path),
        "expectedTargets": batch_targets,
        "targetCount": len(batch_targets),
        "configPath": str(config_path),
        "configSha256": sha256_file(config_path),
        "targetListSha256": sha256_file(targets_path),
        "batchSha256": sha256_file(batch_path),
        "repositoryHead": repository_head,
        "repositoryHeadSource": repository_head_source,
        "configuredLaneCount": 6,
        "planningExperiment": planning_experiment_manifest(config),
        "executionProfiles": profiles,
        "artifactRoot": str(config.get("artifactRoot") or ""),
        "stateRoot": str(config.get("stateRoot") or ""),
        "workRoot": str(config.get("workRoot") or ""),
        "startedAt": now_iso(),
        "status": "preflight",
        "runIds": [],
    }
    write_json_atomic(manifest_path, manifest)
    try:
        manifest["preflight"] = preflight(
            config=config,
            config_path=config_path,
            targets_path=targets_path,
            batch_path=batch_path,
            batch_number=batch,
            batch_targets=batch_targets,
            repo_root=repo_root,
        )
    except Exception as exc:
        manifest.update({"status": "preflight_failed", "finishedAt": now_iso(), "preflightError": str(exc), "batchHealth": "FAIL"})
        write_json_atomic(manifest_path, manifest)
        raise
    manifest["status"] = "running"
    write_json_atomic(manifest_path, manifest)
    command = build_controller_command(controller_path, config_path, batch_targets)
    process = subprocess.run(command, cwd=repo_root, text=True, capture_output=True, check=False)
    controller_payload = _parse_controller_output(process.stdout)
    result_rows = controller_payload.get("results") if isinstance(controller_payload, dict) else []
    run_ids = [str(item.get("runId")) for item in (result_rows or []) if isinstance(item, dict) and item.get("runId")]
    state_root = Path(str(config["stateRoot"]))
    work_root = Path(str(config["workRoot"]))
    manifest.update({
        "controllerExitCode": process.returncode,
        "controllerOutput": controller_payload,
        "controllerStderrTail": process.stderr[-4000:],
        "runIds": run_ids,
        **_post_cleanup_metrics(config, state_root, work_root),
    })
    profile_failures = controller_payload.get("profileFailures") if isinstance(controller_payload, dict) else {}
    manifest["profileFailures"] = profile_failures if isinstance(profile_failures, dict) else {}
    manifest["effectiveProfiles"] = sorted({item.get("profile") for item in (result_rows or []) if isinstance(item, dict) and item.get("profile") is not None})
    write_json_atomic(manifest_path, manifest)
    audit = audit_batch(mode, batch, config_path=config_path, targets_path=targets_path, batch_path=batch_path)
    manifest.update({
        "status": "complete",
        "finishedAt": now_iso(),
        "batchHealth": audit["health"]["status"],
        "traceGapReason": audit["summary"]["environment"].get("traceGapReason", {}),
        "cleanupFailures": audit["summary"]["environment"].get("cleanupFailures", []),
    })
    write_json_atomic(manifest_path, manifest)
    return {"manifest": manifest, "audit": audit, "command": command}


def continue_after_health(health_status: str, continue_on_pass: bool) -> bool:
    return bool(continue_on_pass and health_status == "PASS")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=sorted(MODE_CONFIGS), required=True)
    parser.add_argument("--batch", type=int, choices=sorted(BATCH_SIZES), required=True)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--targets", type=Path)
    parser.add_argument("--batch-file", type=Path)
    parser.add_argument("--controller", type=Path, default=Path(__file__).with_name("bridge_eval_controller.py"))
    parser.add_argument("--preflight-only", action="store_true", help="validate the batch without starting the controller")
    parser.add_argument("--continue-on-pass", action="store_true")
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = build_parser().parse_args(list(argv) if argv is not None else None)
    config_path = args.config or default_config(args.mode)
    targets_path = args.targets or default_targets()
    batch_path = args.batch_file or default_batch(args.mode, args.batch)
    repo_root = Path(__file__).resolve().parents[2]
    current_batch = args.batch
    try:
        if args.preflight_only:
            config = load_config(config_path)
            _, batch_targets = validate_targets(targets_path, batch_path, args.batch)
            result = preflight(
                config=config,
                config_path=config_path,
                targets_path=targets_path,
                batch_path=batch_path,
                batch_number=current_batch,
                batch_targets=batch_targets,
                repo_root=repo_root,
            )
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        while True:
            result = run_one(
                mode=args.mode,
                batch=current_batch,
                config_path=config_path,
                targets_path=targets_path,
                batch_path=batch_path,
                controller_path=args.controller,
                repo_root=repo_root,
            )
            health_status = str(result["audit"]["health"]["status"])
            print(json.dumps({"mode": args.mode, "batch": current_batch, "health": health_status}, ensure_ascii=False))
            if not continue_after_health(health_status, args.continue_on_pass) or current_batch >= max(BATCH_SIZES):
                return 0 if health_status in {"PASS", "WARN"} else 2
            current_batch += 1
            batch_path = batch_path.parent / f"batch-{current_batch:02d}.txt"
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as exc:
        print(f"stage1 batch failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
