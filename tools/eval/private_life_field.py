"""Opt-in, run-owned Life environment; the shared field service stays untouched."""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import time
from urllib.parse import urlsplit

from private_cached_compose_field import PrivateCachedComposeField

LIFE_TARGET = "nyu/development/2013/CSAW-Quals/misc/Life"
LIFE_IMAGE = "sha256:66bd43bb9328be4865549edd6846f34b9776c38d473e06c06fe278c38ca6d9d3"
OWNER_LABEL = "secheur.eval.private-life"
DOCKER = "/usr/bin/docker"


class PrivateLifeField:
    """Single-service official image with an atomically allocated published port.

    The caller supplies this adapter only for the exact manifest-scoped Life
    target. Scope updates are private to RunSandbox, never the shared settings.
    """

    def __init__(self, field, sandbox, options):
        if sandbox.target_id != LIFE_TARGET or options.get("kind") != "life-dynamic-port":
            raise ValueError("Private Life adapter requires its exact target and kind")
        if options.get("image") != LIFE_IMAGE:
            raise ValueError("Private Life adapter requires the pinned official image")
        self.field, self.sandbox, self.options = field, sandbox, options
        self.run_id = sandbox.run_id
        token = hashlib.sha256((self.run_id + ":private-life").encode()).hexdigest()[:24]
        self.name = "secheur-life-" + token
        self.network = "secheur-eval-" + token
        self.root = Path(options["root"]) / token
        self.old_endpoint = str(sandbox.scope.get("targetUrl") or "")
        self.endpoint = ""
        self.created_network = False
        self.created_container = False
        self.container_attempted = False
        self.metadata = {}
        self.cleanup_recorded = False

    def command(self, args, timeout=60):
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        if result.returncode:
            raise RuntimeError((result.stderr or result.stdout)[-8192:])
        return result.stdout

    def inspect(self, kind, name):
        result = subprocess.run([DOCKER, kind, "inspect", name], capture_output=True, text=True, timeout=20)
        if result.returncode:
            if "No such" in result.stderr or "not found" in result.stderr:
                return None
            raise RuntimeError(result.stderr[-8192:])
        rows = json.loads(result.stdout)
        if not isinstance(rows, list) or len(rows) != 1:
            raise ValueError("Unexpected private Life inspect response")
        return rows[0]

    def bind_scope(self, port):
        parsed = urlsplit(self.old_endpoint)
        if parsed.scheme != "tcp" or not parsed.hostname or not parsed.port:
            raise ValueError("Private Life requires an exact TCP scope")
        scope = copy.deepcopy(self.sandbox.scope)
        for key in ("routes", "endpoints"):
            matches = [item for item in scope[key]
                       if item.get("host") == parsed.hostname and item.get("port") == parsed.port
                       and item.get("transport") == "tcp"]
            if len(matches) != 1:
                raise ValueError("Private Life requires one exact endpoint and route")
            matches[0]["port"] = port
        self.endpoint = f"tcp://{parsed.hostname}:{port}"
        scope["targetUrl"] = self.endpoint
        self.sandbox.scope = scope

    def start_sync(self):
        self.root.parent.mkdir(parents=True, exist_ok=True)
        self.root.mkdir(mode=0o700)  # Exclusive ownership; never attach to old runs.
        image = self.inspect("image", LIFE_IMAGE)
        if image is None or image.get("Id") != LIFE_IMAGE:
            raise RuntimeError("Private Life image not found in the local cache")
        # Existing resources, even with a matching name, are never adopted.
        if self.inspect("container", self.name) or self.inspect("network", self.network):
            raise RuntimeError("Private Life resource already exists")
        docker_network = self.options["networkDocker"]
        self.command([docker_network, "network", "create", "--label", "secheur.eval.run=" + self.run_id,
                      "--label", OWNER_LABEL + "=" + self.run_id, self.network])
        self.created_network = True
        # Docker assigns the port during container start; no probe-then-bind gap.
        self.container_attempted = True
        self.command([DOCKER, "run", "--detach", "--pull", "never", "--name", self.name,
                      "--label", OWNER_LABEL + "=" + self.run_id,
                      "--network", self.network, "--network-alias", "misc.chal.csaw.io",
                      "--publish", "0.0.0.0:0:45678/tcp", LIFE_IMAGE])
        self.created_container = True
        row = self.inspect("container", self.name)
        if not row or not row["State"]["Running"]:
            raise RuntimeError("Private Life container did not start")
        bindings = row["NetworkSettings"]["Ports"].get("45678/tcp") or []
        ports = {int(item["HostPort"]) for item in bindings if item["HostIp"] == "0.0.0.0"}
        if len(ports) != 1:
            raise ValueError("Private Life port mapping is ambiguous")
        port = ports.pop()
        self.bind_scope(port)
        host = urlsplit(self.endpoint).hostname
        deadline = time.monotonic() + 20
        while True:
            try:
                with socket.create_connection((host, port), timeout=1):
                    break
            except OSError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("Private Life TCP health timeout")
                time.sleep(0.2)
        self.metadata = {"kind": "life-dynamic-port", "runId": self.run_id, "image": LIFE_IMAGE,
                         "container": self.name, "containerId": row["Id"], "network": self.network,
                         "targetUrl": self.endpoint, "previousTargetUrl": self.old_endpoint,
                         "scope": self.sandbox.scope, "health": "tcp_connected", "modelCalls": 0}
        self.write("start.json", self.metadata)
        return {"ok": True, "target_id": LIFE_TARGET, "run_id": self.run_id,
                "target_url": self.endpoint, "deploy_mode": "private-official-image"}

    def write(self, name, value):
        fd = os.open(self.root / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, ensure_ascii=False)

    def cleanup_sync(self):
        # Check ownership on each exact resource before touching it.
        if self.created_container:
            row = self.inspect("container", self.name)
            if row and row.get("Config", {}).get("Labels", {}).get(OWNER_LABEL) != self.run_id:
                raise RuntimeError("Private Life container ownership differs")
            if row:
                self.command([DOCKER, "rm", "--force", self.name])
            self.created_container = False
        if self.created_network:
            row = self.inspect("network", self.network)
            if row and row.get("Labels", {}).get(OWNER_LABEL) != self.run_id:
                raise RuntimeError("Private Life network ownership differs")
            if row:
                self.command([DOCKER, "network", "rm", self.network])
            self.created_network = False
        return {"ok": True, "cleanup": "removed_exact_owned_resources"}

    async def start(self, target_id, run_id):
        if target_id != LIFE_TARGET or run_id != self.run_id:
            raise ValueError("Private Life start identity differs")
        try:
            return await asyncio.to_thread(self.start_sync)
        except Exception as error:
            # docker run can create the container before returning a failure.
            if self.container_attempted:
                row = await asyncio.to_thread(self.inspect, "container", self.name)
                if row and row.get("Config", {}).get("Labels", {}).get(OWNER_LABEL) == self.run_id:
                    self.created_container = True
            await asyncio.to_thread(self.cleanup_sync)
            return {"ok": False, "error": "private_life_start_failed: " + str(error)[-4096:]}

    async def prompt(self, target_id):
        if target_id != LIFE_TARGET or not self.endpoint:
            raise ValueError("Private Life prompt requested before successful start")
        payload = await self.field.prompt(target_id)
        if not payload.get("ok") or not payload.get("prompt"):
            return payload
        old, new = urlsplit(self.old_endpoint), urlsplit(self.endpoint)
        prompt = payload["prompt"].replace(f"{old.hostname}:{old.port}", f"{new.hostname}:{new.port}")
        prompt += "\nAuthoritative current-run target endpoint: " + self.endpoint + ".\n"
        return {**payload, "prompt": prompt}

    async def stop(self, target_id, run_id):
        if target_id != LIFE_TARGET or run_id != self.run_id:
            raise ValueError("Private Life stop identity differs")
        result = await asyncio.to_thread(self.cleanup_sync)
        if not self.cleanup_recorded:
            self.write("cleanup.json", result)
            self.cleanup_recorded = True
        return result

    async def record(self, payload):
        return await self.field.record(payload)

    async def all_targets(self):
        rows = await self.field.all_targets()
        # The shared field can legitimately describe a different Life instance.
        # Cleanup confirmation must observe this adapter's exact owned instance.
        row = await asyncio.to_thread(self.inspect, "container", self.name)
        if row and row.get("Config", {}).get("Labels", {}).get(OWNER_LABEL) != self.run_id:
            raise RuntimeError("Private Life container ownership differs")
        running = bool(row and row.get("State", {}).get("Running"))
        return [{**item, "running": running} if str(item.get("target_id") or item.get("id") or "") == LIFE_TARGET else item
                for item in rows]

    async def health(self):
        return await self.field.health()


def field_for_sandbox(field, sandbox):
    options = sandbox.settings.get("privateFieldAdapters", {}).get(sandbox.target_id)
    if options is None:
        return field
    if options.get("kind") == "cached-compose":
        return PrivateCachedComposeField(field, sandbox, options)
    return PrivateLifeField(field, sandbox, options)
