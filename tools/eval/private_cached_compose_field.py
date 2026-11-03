"""Opt-in cached official compose images; no image build or pull during evaluation."""
from __future__ import annotations
import asyncio
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import time

TARGET = "cybench/benchmark/project-sekai-ctf/sekaictf-2023/web/chunky"
LABEL = "secheur.eval.cached-compose"
IMAGES = {
    "nginx": "sha256:49b150b245c2e1266f0bbd583be96a976f7c7ebc27d708fa5776d11e24dac626",
    "blog": "sha256:e0633493577e7beccdc74ad7ca946c2bc320999cb5eb47b7af1a163cafdc37de",
    "cache": "sha256:9587b8e14db6ec801711b42b68589ce5b1f8f740bd5bfae76d7a227ced92a164",
}


def cached_config(raw, project, run_id):
    config = copy.deepcopy(raw)
    if set(config.get("services", {})) != set(IMAGES):
        raise ValueError("Cached compose service set differs")
    config["name"] = project
    for name, service in config["services"].items():
        if service.get("volumes"):
            raise ValueError("Cached compose must not share mutable volumes")
        service.pop("build", None)
        service.pop("container_name", None)
        service["image"] = IMAGES[name]
        service["pull_policy"] = "never"
        service.setdefault("labels", {})[LABEL] = run_id
    for name, network in config.get("networks", {}).items():
        if network.get("external"):
            raise ValueError("Cached compose must not reuse an external network")
        network["name"] = project + "-" + name
        network.setdefault("labels", {})[LABEL] = run_id
    return config


class PrivateCachedComposeField:
    def __init__(self, field, sandbox, options):
        if sandbox.target_id != TARGET or options.get("kind") != "cached-compose":
            raise ValueError("Cached compose requires its exact target and kind")
        self.field, self.sandbox, self.options = field, sandbox, options
        self.run_id = sandbox.run_id
        self.project = "secheur-cached-" + hashlib.sha256(self.run_id.encode()).hexdigest()[:24]
        self.root = Path(options["root"]) / self.project
        self.config_path = self.root / "compose.json"
        self.attempted = False
        self.stopped = False

    def command(self, args, timeout=45):
        result = subprocess.run(["/usr/bin/docker", *args], capture_output=True, text=True, timeout=timeout)
        if result.returncode:
            raise RuntimeError("Cached compose command failed: " + result.stderr[-2000:])
        return result.stdout

    def compose(self, *args):
        return self.command(["compose", "-p", self.project, "-f", str(self.config_path), *args])

    def owned_containers(self):
        ids = self.command(["ps", "-aq", "--filter", "label=com.docker.compose.project=" + self.project]).split()
        if ids:
            rows = json.loads(self.command(["inspect", *ids]))
            if any(row.get("Config", {}).get("Labels", {}).get(LABEL) != self.run_id for row in rows):
                raise RuntimeError("Cached compose ownership differs")
        return ids

    def start_sync(self):
        content = Path(self.options["configPath"]).read_bytes()
        if hashlib.sha256(content).hexdigest() != self.options["configSha256"]:
            raise ValueError("Cached compose source changed")
        for image in IMAGES.values():
            observed = self.command(["image", "inspect", image, "--format", "{{.Id}}"]).strip()
            if observed != image:
                raise ValueError("Pinned cached image missing")
        self.root.mkdir(parents=True, mode=0o700, exist_ok=False)
        config = cached_config(json.loads(content), self.project, self.run_id)
        self.config_path.write_text(json.dumps(config))
        self.config_path.chmod(0o600)
        self.attempted = True
        # Start the upstream before the cache: otherwise an initial 502 can itself be cached.
        self.compose("up", "-d", "--no-build", "--pull", "never", "blog", "nginx")
        deadline = time.monotonic() + 20
        while True:
            try:
                self.command(["exec", self.project + "-blog-1", "python3", "-c",
                    "import urllib.request; urllib.request.urlopen('http://nginx:80/', timeout=1).read(1)"], timeout=5)
                break
            except RuntimeError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("Cached compose upstream did not become ready")
                time.sleep(0.5)
        self.compose("up", "-d", "--no-build", "--pull", "never", "cache")
        return {"ok": True, "run_id": self.run_id, "target_id": TARGET,
                "target_url": self.sandbox.scope["targetUrl"]}

    async def start(self, target_id, run_id):
        if target_id != TARGET or run_id != self.run_id:
            raise ValueError("Cached compose start identity differs")
        try:
            return await asyncio.to_thread(self.start_sync)
        except Exception:
            if self.attempted:
                await asyncio.to_thread(self.stop_sync)
            raise

    def stop_sync(self):
        if self.attempted and not self.stopped:
            self.owned_containers()
            self.compose("down", "--timeout", "5")
            self.stopped = True
        return {"ok": True, "cleanup": "removed_exact_owned_compose_resources"}

    async def stop(self, target_id, run_id):
        if target_id != TARGET or run_id != self.run_id:
            raise ValueError("Cached compose stop identity differs")
        return await asyncio.to_thread(self.stop_sync)

    async def prompt(self, target_id):
        return await self.field.prompt(target_id)

    async def record(self, payload):
        return await self.field.record(payload)

    async def health(self):
        return await self.field.health()

    async def all_targets(self):
        rows = await self.field.all_targets()
        ids = await asyncio.to_thread(self.owned_containers)
        return [{**row, "running": bool(ids)} if str(row.get("target_id") or row.get("id") or "") == TARGET else row for row in rows]
