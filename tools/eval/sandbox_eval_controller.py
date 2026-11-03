"""Run-scoped adapter around the existing Pi evaluation controller.

Trusted scopes contain attachment hashes and exact endpoints; prompts cannot
expand either. A failed sandbox never falls back to the shared host bridge.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import os
from pathlib import Path, PurePosixPath
import sys
import time
from urllib.parse import urlsplit

import bridge_eval_controller as base
from model_failure_diagnostics import summarize_model_failures
from private_life_field import field_for_sandbox


def write_private_json(path: Path, value: object) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())


def validate_required_attachments(scope: dict) -> dict:
    """Check host requirements against delivery metadata, never prompt claims.

    Missing requirements means unknown; an empty delivery list proves nothing.
    """
    delivered = scope.get("attachments")
    if not isinstance(delivered, list):
        raise ValueError("input_manifest_invalid: attachments must be a list")
    by_path = {}
    for item in delivered:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise ValueError("input_manifest_invalid: attachment entry")
        relative = PurePosixPath(item["path"])
        if (not relative.parts or relative.is_absolute() or ".." in relative.parts
                or "\\" in item["path"] or ":" in item["path"] or "\0" in item["path"]):
            raise ValueError("input_manifest_invalid: attachment path")
        name = relative.as_posix()
        digest = item.get("sha256")
        if name in by_path or not isinstance(digest, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", digest):
            raise ValueError("input_manifest_invalid: duplicate path or invalid digest")
        by_path[name] = digest.lower()
    required = scope.get("requiredAttachments")
    if required is None:
        return {"requirements": "not_declared", "deliveredCount": len(by_path)}
    if not isinstance(required, list):
        raise ValueError("input_manifest_invalid: requiredAttachments must be a list")
    validate_required_attachments({"attachments": required})
    for item in required:
        name = PurePosixPath(item["path"]).as_posix()
        if name not in by_path:
            raise ValueError("required_input_missing: declared attachment was not delivered")
        if by_path[name] != item["sha256"].lower():
            raise ValueError("required_input_mismatch: delivered digest differs from requirement")
    return {"requirements": "verified", "requiredCount": len(required), "deliveredCount": len(by_path)}


def copy_scoped_attachments(scope: dict, destination: Path) -> list[dict]:
    """Copy bytes with controller-pinned provenance, never an entire run tree."""
    validate_required_attachments(scope)
    root = Path(scope["attachmentRoot"]).resolve(strict=True)
    if not root.is_dir():
        raise ValueError("Attachment root is not a directory")
    destination.mkdir()
    records = []
    for item in scope["attachments"]:
        relative = Path(item["path"])
        if relative.is_absolute() or ".." in relative.parts or not relative.parts:
            raise ValueError("Invalid attachment path")
        source = root / relative
        if source.is_symlink() or not source.is_file() or not source.resolve().is_relative_to(root):
            raise ValueError("Attachment escaped its trusted root")
        # Read once, then hash and copy the same bytes (no check/copy race).
        content = source.read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        if digest != item["sha256"].lower():
            raise ValueError("Attachment differs from its frozen manifest")
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        executable = bool(source.stat().st_mode & 0o111)
        if "executable" in item and (not isinstance(item["executable"], bool) or item["executable"] != executable):
            raise ValueError("Attachment executable mode differs from its frozen manifest")
        # Read-only does not mean non-executable. Preserve the public tool's execution mode.
        target.chmod(0o555 if executable else 0o444)
        records.append({"path": relative.as_posix(), "sha256": digest, "executable": executable})
    return records


def export_model_gateway_diagnostics(temporary: str, artifact: Path) -> dict:
    journal = Path(temporary) / "model-requests.jsonl"
    if not journal.exists():
        return {"status": "unknown", "reason": "no_gateway_journal"}
    if journal.is_symlink():
        raise ValueError("Gateway journal must belong to the private run directory")
    content = journal.read_bytes()
    rows = [json.loads(line) for line in content.splitlines() if line.strip()]
    if any(not isinstance(row, dict) or row.get("event") != "model_gateway_request" for row in rows):
        raise ValueError("Unexpected gateway journal record")
    counts = {}
    for row in rows:
        status = row.get("status", "unknown")
        counts[status] = counts.get(status, 0) + 1
    destination = artifact / "model-gateway-events.jsonl"
    temporary_path = destination.with_suffix(".tmp")
    temporary_path.write_bytes(content)
    temporary_path.chmod(0o600)
    temporary_path.replace(destination)
    return {"status": "exported", "file": destination.name,
            "sha256": hashlib.sha256(content).hexdigest(),
            "requests": len({row.get("requestId") for row in rows}),
            "statusCounts": counts, "roleMapping": "unknown"}


class RunSandbox:
    def __init__(self, settings: dict, config: base.ControllerConfig, target_id: str, run_id: str):
        self.settings, self.config = settings, config
        self.target_id, self.run_id = target_id, run_id
        self.scope = settings["scopes"][target_id]
        self.root = Path(settings["privateRoot"]) / hashlib.sha256(run_id.encode()).hexdigest()
        self.sandbox: dict | None = None
        self.bridge: base.BridgeClient | None = None
        self.records: list[dict] = []
        self.admitted = False
        self.input_admission: dict = {"status": "not_checked"}

    async def node(self, path: Path, cleanup: bool = False) -> dict:
        command = [self.settings["node"], str(Path(__file__).with_name("sandbox-runner.mjs")), str(path)]
        if cleanup:
            command.append("--cleanup")
        process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.PIPE,
                                                      stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await process.communicate()
        if process.returncode:
            # Provider credentials never enter controller diagnostics.
            (self.root / "bootstrap-diagnostic.log").write_bytes(stderr)
            (self.root / "bootstrap-diagnostic.log").chmod(0o600)
            raise RuntimeError("sandbox_environment_mismatch: see private bootstrap diagnostic")
        return json.loads(stdout) if stdout.strip() else {}

    async def start(self, field_start: dict) -> None:
        if field_start.get("run_id") != self.run_id:
            raise ValueError("Field start returned a different run identity")
        endpoint = str(field_start.get("target_url") or "")
        if endpoint != str(self.scope.get("targetUrl") or ""):
            raise ValueError("Field endpoint differs from the trusted scope")
        # Reject host-confirmed unavailable input before starting a model session.
        try:
            self.input_admission = {"status": "manifest_checked", **validate_required_attachments(self.scope)}
        except ValueError as error:
            self.input_admission = {"status": "rejected", "reason": str(error).split(":", 1)[0]}
            raise
        self.root.parent.mkdir(parents=True, exist_ok=True)
        self.root.mkdir(mode=0o700)  # Exclusive: never reuse a previous run.
        try:
            self.records = copy_scoped_attachments(self.scope, self.root / "attachments")
        except (OSError, ValueError):
            self.input_admission["status"] = "rejected"
            self.input_admission["reason"] = "attachment_copy_or_integrity_failed"
            raise
        model_dir = self.root / "model-config"
        model_dir.mkdir(mode=0o755)
        for name in ("models.json", "auth.json", "settings.json"):
            # This input directory is prepared with dummy credentials only.
            value = json.loads((Path(self.settings["workerConfig"]) / name).read_text())
            (model_dir / name).write_text(json.dumps(value), encoding="utf-8")
            (model_dir / name).chmod(0o644)
        manifest = {
            "runId": self.run_id, "challengeId": self.target_id,
            "image": self.settings["image"], "toolchainDigest": self.settings["toolchainDigest"],
            "attachments": str(self.root / "attachments"), "attachmentManifest": self.records, "modelConfig": str(model_dir),
            "endpoints": self.scope["endpoints"], "protectedEndpoints": self.settings["protectedEndpoints"],
            "controlEndpoints": self.settings["controlEndpoints"],
            "verifierSocket": self.settings["verifierSocket"],
        }
        routes = [dict(route) for route in self.settings["controlRoutes"]]
        for route in routes:
            if route["kind"] == "verifier":
                route.update(challengeId=self.target_id, runId=self.run_id)
        routes.extend(self.scope["routes"])
        request = self.root / "bootstrap.json"
        write_private_json(request, {"manifest": manifest, "routes": routes,
                                   "mode": self.settings["mode"], "desktopConfig": self.settings["desktopConfig"]})
        self.sandbox = await self.node(request)
        self.bridge = base.BridgeClient(base.JsonHttpClient(self.sandbox["bridgeAddress"], self.config.request_timeout_seconds),
                                       max_turns=self.config.max_turns, memory_reference_enabled=False)
        deadline = time.monotonic() + 30
        while True:
            try:
                status = await self.bridge.status()
                if status.get("ready"):
                    break
            except RuntimeError:
                pass
            if time.monotonic() >= deadline:
                raise RuntimeError("sandbox_environment_mismatch: private bridge not ready")
            await asyncio.sleep(0.5)
        profiles = await self.bridge.profiles()
        expected = self.settings["model"]
        if not any(str(row.get("id")) == "0" and row.get("provider") == expected["provider"]
                   and (row.get("model") or row.get("modelId")) == expected["model"] for row in profiles):
            raise ValueError("Private bridge model profile differs from the frozen model")
        write_private_json(self.root / "sandbox.json", self.sandbox)
        self.admitted = True
        self.input_admission["status"] = "worker_verified"

    def rewrite_prompt(self, prompt: str) -> str:
        if not self.sandbox:
            raise RuntimeError("Private sandbox has not passed preflight")
        roots = {root.rstrip("/") for root in [self.scope["attachmentRoot"], *self.scope.get("promptAttachmentRoots", [])]}
        for root in sorted(roots, key=len, reverse=True):
            if not root or root == "/":
                raise ValueError("Attachment alias must identify a specific directory")
            # Trusted aliases map only this directory, never a similarly prefixed sibling.
            prompt = re.sub(re.escape(root) + r"(?=/|$|[\s`\"<>;，。])", "/attachments", prompt)
        # stage-official-catalogs.py appends this host-only hint, not an original task requirement.
        # The admitted worker uses the same fixed toolkit for every mode and owns only this run's workspace.
        if self.target_id.startswith("intercode-ctf/"):
            host_hint = ('Use /home/shared/bench-harness/intercode-ctf/icctl exec '
                         + self.target_id + ' "COMMAND" to work inside the official task environment.')
            prompt = prompt.replace(host_hint, 'Use the native bash tool in /workspace for this isolated run. '
                                   'Public input files are available under /attachments; use /workspace for writable copies. '
                                   'The host-only benchmark wrapper is not available in this worker.')
        if self.scope.get("attachments"):
            files = [item["path"] for item in self.scope["attachments"]]
            prompt += ("\nAuthoritative current-run attachment directory: /attachments (read-only). "
                       + "Declared public input files: " + json.dumps(files[:32], ensure_ascii=False)
                       + (" (additional entries are available in the same manifest directory)" if len(files) > 32 else "")
                       + ". This runtime manifest takes precedence over stale delivery-path notes.\n")
        if self.scope.get("attachments") == []:
            prompt += "\nEvaluation attachment manifest: no local attachments are supplied for this target. /attachments is an intentionally empty directory. Use only the declared target endpoint and current-run artifacts.\n"
        endpoint = self.scope.get("targetUrl")
        if endpoint:
            parsed = urlsplit(endpoint)
            route = next((item for item in self.scope["routes"]
                          if item["host"] == parsed.hostname and item["port"] == parsed.port), None)
            if route is None:
                raise ValueError("Target URL has no exact scoped gateway route")
            destination = f'{self.sandbox["gatewayAddress"]}:{route["listenPort"]}'
            prompt = prompt.replace(f"{parsed.hostname}:{parsed.port}", destination)
        return prompt

    async def cleanup(self) -> str:
        if not self.sandbox:
            return "preserved_preflight_failure"
        path = self.root / "cleanup.json"
        write_private_json(path, self.sandbox)
        await self.node(path, cleanup=True)
        return "removed_owned_containers_preserved_private_evidence"


class ScopedBridge(base.BridgeClient):
    def __init__(self, sandbox: RunSandbox):
        self.sandbox = sandbox
        # No host URL is stored: use before admission fails closed.
        self.max_turns = sandbox.config.max_turns
        self.memory_reference_enabled = False

    @property
    def http(self):
        if not self.sandbox.bridge:
            raise RuntimeError("Sandbox admission is required before bridge access")
        return self.sandbox.bridge.http

    async def create_session(self, profile, cwd, **kwargs):
        return await super().create_session(0, PurePosixPath("/workspace"), **kwargs)

    async def submit(self, session_id, prompt, profile, **kwargs):
        return await super().submit(session_id, prompt, 0, **kwargs)


class ScopedField:
    def __init__(self, field: base.FieldClient, sandbox: RunSandbox):
        self.field, self.sandbox = field, sandbox
        self.start_payload: dict = {}

    async def start(self, target_id, run_id):
        self.start_payload = await self.field.start(target_id, run_id)
        if (self.start_payload.get("ok") and self.start_payload.get("deploy_mode") == "offline-assets"
                and self.start_payload.get("target_id") == target_id and not self.start_payload.get("target_url")):
            self.start_payload = {**self.start_payload, "field_run_id": self.start_payload.get("run_id"),
                                  "run_id": run_id}
        return self.start_payload

    async def prompt(self, target_id):
        payload = await self.field.prompt(target_id)
        if not payload.get("ok") or not payload.get("prompt"):
            return payload
        await self.sandbox.start(self.start_payload)
        return {**payload, "prompt": self.sandbox.rewrite_prompt(payload["prompt"])}

    async def record(self, payload):
        return await self.field.record(payload)

    async def all_targets(self):
        return await self.field.all_targets()

    async def health(self):
        return await self.field.health()

    async def stop(self, target_id, run_id):
        return await self.field.stop(target_id, self.start_payload.get("field_run_id") or run_id)


class SandboxEvaluationController(base.EvaluationController):
    def __init__(self, config, field, state, settings, *, allow_done_rerun=False):
        super().__init__(config, field, None, state, allow_done_rerun=allow_done_rerun)
        self.settings = settings
        expected_mode = "DIRECT" if settings["mode"] == "direct" else "PLAN_MULTI"
        if config.execution_mode != expected_mode or config.execution_capacity != (1 if expected_mode == "DIRECT" else 2):
            raise ValueError("Sandbox/controller execution contract differs")
        if config.memory_reference_enabled or config.max_turns != 220 or config.wall_timeout_seconds != 3000:
            raise ValueError("Clean evaluation requires fixed 220 turns/3000 seconds and no historical memory")

    async def preflight(self, *, probe_profiles=True):
        if not (await self.field.health()).get("ok"):
            raise RuntimeError("CTF Field health check failed")
        # Actual tool/bridge/model configuration checked in each private worker.
        required = {profile for lane in self.config.lanes for profile in lane.profiles}
        self._profile_selections = {profile: dict(self.settings["model"]) for profile in required}
        return required

    async def _candidate_rows(self, target_ids):
        if not target_ids or not target_ids.issubset(self.settings["scopes"]):
            raise ValueError("Sandbox evaluation requires explicit manifest-scoped target IDs")
        return await super()._candidate_rows(target_ids)

    async def _run_one(self, lane, target_id, profile, run_id):
        sandbox = RunSandbox(self.settings, self.config, target_id, run_id)
        field = field_for_sandbox(self.field, sandbox)
        child = base.EvaluationController(self.config, ScopedField(field, sandbox), ScopedBridge(sandbox),
                                         self.state, allow_done_rerun=self.allow_done_rerun)
        child._profile_selections = self._profile_selections.copy()
        child._target_metadata = self._target_metadata.copy()
        result = await child._run_one(lane, target_id, profile, run_id)
        artifact_directory = result.get("artifactDir")
        if artifact_directory:
            events_path = Path(artifact_directory) / "planning-events.jsonl"
            role_turns = {}
            observer_elapsed_ms = 0
            diagnostic_events = None
            if events_path.exists():
                diagnostic_events = []
                for line in events_path.read_text().splitlines():
                    event = json.loads(line)
                    diagnostic_events.append(event)
                    kind, payload = event.get("type", ""), event.get("payload", {})
                    if kind.endswith("model_turn_completed"):
                        role = payload.get("role", "unknown")
                        role_turns[role] = role_turns.get(role, 0) + 1
                    if kind == "observer_review_finished":
                        observer_elapsed_ms += payload.get("elapsedMs", 0)
            result["roleMetrics"] = {"modelTurns": role_turns, "observerReviewSeconds": observer_elapsed_ms / 1000,
                                     "observerTimeOverlapsExecution": True}
            result["modelFailureDiagnostics"] = summarize_model_failures(diagnostic_events, result)
        if artifact_directory and sandbox.sandbox:
            effective = sandbox.sandbox.get("effectiveConfiguration")
            if effective is not None:
                write_private_json(Path(artifact_directory) / "effective-worker-config.json", effective)
                result["effectiveConfigurationSha256"] = sandbox.sandbox.get("configurationSha256")
        result["sandbox"] = {"runId": run_id, "image": self.settings["image"],
                             "toolchainDigest": self.settings["toolchainDigest"],
                             "attachmentManifest": sandbox.records, "mode": self.settings["mode"],
                             "preflightPassed": sandbox.admitted, "inputAdmission": sandbox.input_admission}
        if not sandbox.admitted:
            result["environmentMismatch"] = True
        if result.get("sessionCleanupStatus") in {"deleted", "not_created"} and result.get("recordStatus") == "saved":
            try:
                result["sandbox"]["cleanup"] = await sandbox.cleanup()
            except Exception:
                result["sandbox"]["cleanup"] = "preserved_cleanup_failure"
        else:
            result["sandbox"]["cleanup"] = "preserved_incomplete_export_or_record"
        artifact = result.get("artifactDir")
        if artifact and sandbox.sandbox and sandbox.sandbox.get("temporary"):
            try:
                result["modelGatewayDiagnostics"] = export_model_gateway_diagnostics(sandbox.sandbox["temporary"], Path(artifact))
            except (OSError, ValueError, TypeError) as error:
                result["modelGatewayDiagnostics"] = {"status": "unknown", "reason": type(error).__name__}
        if artifact:
            path = Path(artifact) / "result.json"
            existing = json.loads(path.read_text())
            temporary = path.with_suffix(".sandbox.tmp")
            temporary.write_text(json.dumps({**existing, **result}, ensure_ascii=False), encoding="utf-8")
            temporary.replace(path)
        self._cleanup_diagnostics.update(child._cleanup_diagnostics)
        return result


async def async_main(args):
    base.validate_execute_args(args)
    config = base.ControllerConfig.load(args.config)
    settings = json.loads(args.sandbox_config.read_text())
    state = base.StateStore(config.state_root)
    controller = SandboxEvaluationController(config, base.FieldClient(base.JsonHttpClient(config.field_base, config.request_timeout_seconds)),
                                              state, settings, allow_done_rerun=args.allow_done_rerun)
    targets = set(args.target_id)
    if args.list_running:
        state.load()
        print(json.dumps({"running": state.running_records()}))
        return 0
    if not args.execute:
        await controller.preflight(probe_profiles=False)
        print(json.dumps({"mode": "dry-run", "plan": await controller.plan(targets)}))
        return 0
    with state.exclusive_process_lock():
        results = await controller.execute(targets, args.max_targets)
    print(json.dumps({"mode": settings["mode"], "results": results}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    parser = base.build_parser()
    parser.add_argument("--sandbox-config", type=Path, required=True)
    try:
        raise SystemExit(asyncio.run(async_main(parser.parse_args())))
    except (ValueError, RuntimeError, OSError) as error:
        print(f"sandbox controller error: {error}", file=sys.stderr)
        raise SystemExit(2)
