#!/usr/bin/env python3
"""Small, dependency-free Docker environment lease gateway for local CTFd."""

from __future__ import annotations

import argparse
import http.client
import json
import os
import signal
import socket
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote, unquote, urlparse


MAX_BODY_BYTES = 1 * 1024 * 1024
DEFAULT_TTL_SECONDS = 30 * 60
DEFAULT_MAX_SLOTS = 3


class GatewayError(Exception):
    def __init__(self, message: str, code: str, status: int = 550) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


class DockerError(Exception):
    def __init__(self, message: str, status: int = 500) -> None:
        super().__init__(message)
        self.status = status


def now_ms() -> int:
    return int(time.time() * 1000)


def int_env(name: str, fallback: int, minimum: int = 0) -> int:
    try:
        return max(minimum, int(os.environ.get(name, str(fallback))))
    except ValueError:
        return fallback


def json_object(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise GatewayError(f"{name} must be an object", "invalid_config", 500)
    return value


def string_value(value: Any, name: str, required: bool = True) -> str:
    if isinstance(value, str) and value.strip():
        return value.strip()
    if required:
        raise GatewayError(f"{name} must be a non-empty string", "invalid_config", 500)
    return ""


@dataclass(frozen=True)
class ChallengeSpec:
    exercise_id: str
    image: str
    command: tuple[str, ...]
    container_port: int
    environment: tuple[str, ...]
    network: str | None
    mounts: tuple[str, ...]
    working_dir: str | None
    memory_bytes: int | None
    nano_cpus: int | None
    pids_limit: int | None

    @staticmethod
    def from_json(exercise_id: str, value: Any) -> "ChallengeSpec":
        record = json_object(value, f"challenge {exercise_id}")
        image = string_value(record.get("image"), f"challenge {exercise_id}.image")
        if image == "latest" or image.endswith(":latest"):
            raise GatewayError(f"challenge {exercise_id} must not use a floating latest image", "invalid_config", 500)
        command_value = record.get("command", [])
        if not isinstance(command_value, list) or not all(isinstance(item, str) and item for item in command_value):
            raise GatewayError(f"challenge {exercise_id}.command must be an array of strings", "invalid_config", 500)
        try:
            container_port = int(record.get("containerPort", record.get("port", 31337)))
        except (TypeError, ValueError):
            raise GatewayError(f"challenge {exercise_id}.containerPort is invalid", "invalid_config", 500) from None
        if not 1 <= container_port <= 65535:
            raise GatewayError(f"challenge {exercise_id}.containerPort is invalid", "invalid_config", 500)

        env_value = record.get("environment", record.get("env", {}))
        if not isinstance(env_value, dict) or not all(
            isinstance(key, str) and key and isinstance(value, (str, int, float, bool))
            for key, value in env_value.items()
        ):
            raise GatewayError(f"challenge {exercise_id}.environment is invalid", "invalid_config", 500)
        mounts_value = record.get("mounts", [])
        if not isinstance(mounts_value, list) or not all(isinstance(item, str) and item for item in mounts_value):
            raise GatewayError(f"challenge {exercise_id}.mounts must be an array of strings", "invalid_config", 500)

        def optional_positive(name: str) -> int | None:
            value = record.get(name)
            if value is None:
                return None
            try:
                parsed = int(value)
            except (TypeError, ValueError):
                raise GatewayError(f"challenge {exercise_id}.{name} is invalid", "invalid_config", 500) from None
            if parsed <= 0:
                raise GatewayError(f"challenge {exercise_id}.{name} is invalid", "invalid_config", 500)
            return parsed

        return ChallengeSpec(
            exercise_id=exercise_id,
            image=image,
            command=tuple(command_value),
            container_port=container_port,
            environment=tuple(f"{key}={value}" for key, value in env_value.items()),
            network=string_value(record.get("network"), f"challenge {exercise_id}.network", required=False) or None,
            mounts=tuple(mounts_value),
            working_dir=string_value(record.get("workingDir"), f"challenge {exercise_id}.workingDir", required=False)
            or None,
            memory_bytes=optional_positive("memoryBytes"),
            nano_cpus=optional_positive("nanoCpus"),
            pids_limit=optional_positive("pidsLimit"),
        )


def load_challenges(path: str) -> dict[str, ChallengeSpec]:
    source = Path(path)
    if not source.exists():
        return {}
    try:
        value = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise GatewayError(f"could not load challenge config: {error}", "invalid_config", 500) from error
    if isinstance(value, dict) and isinstance(value.get("challenges"), list):
        entries = value["challenges"]
        result: dict[str, ChallengeSpec] = {}
        for entry in entries:
            record = json_object(entry, "challenge")
            exercise_id = string_value(record.get("exerciseId", record.get("id")), "challenge.exerciseId")
            result[exercise_id] = ChallengeSpec.from_json(exercise_id, record)
        return result
    record = json_object(value, "challenge config")
    return {str(exercise_id): ChallengeSpec.from_json(str(exercise_id), spec) for exercise_id, spec in record.items()}


class DockerEngine:
    def __init__(self, socket_path: str, timeout_seconds: float = 30.0) -> None:
        self.socket_path = socket_path
        self.timeout_seconds = timeout_seconds

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        payload = json.dumps(body, separators=(",", ":")).encode("utf-8") if body is not None else b""
        request = (
            f"{method} /v1.43{path} HTTP/1.1\r\n"
            "Host: localhost\r\n"
            "Connection: close\r\n"
            "Content-Type: application/json\r\n"
            f"Content-Length: {len(payload)}\r\n\r\n"
        ).encode("ascii") + payload
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout_seconds)
        try:
            sock.connect(self.socket_path)
            sock.sendall(request)
            response = http.client.HTTPResponse(sock)
            response.begin()
            raw = response.read()
            if response.status < 200 or response.status >= 300:
                detail = raw.decode("utf-8", errors="replace")[:500]
                raise DockerError(f"Docker Engine returned HTTP {response.status}: {detail}", response.status)
            if not raw:
                return {}
            try:
                return json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError:
                return {"raw": raw.decode("utf-8", errors="replace")[:500]}
        except OSError as error:
            raise DockerError(f"Docker Engine request failed: {error}") from error
        finally:
            sock.close()

    def create_and_start(self, spec: ChallengeSpec) -> tuple[str, dict[str, Any]]:
        port_key = f"{spec.container_port}/tcp"
        host_config: dict[str, Any] = {
            "AutoRemove": False,
            "PortBindings": {port_key: [{"HostPort": "0"}]},
        }
        if spec.network:
            host_config["NetworkMode"] = spec.network
        if spec.mounts:
            host_config["Binds"] = list(spec.mounts)
        if spec.memory_bytes is not None:
            host_config["Memory"] = spec.memory_bytes
        if spec.nano_cpus is not None:
            host_config["NanoCpus"] = spec.nano_cpus
        if spec.pids_limit is not None:
            host_config["PidsLimit"] = spec.pids_limit
        config: dict[str, Any] = {
            "Image": spec.image,
            "ExposedPorts": {port_key: {}},
            "Env": list(spec.environment),
            "HostConfig": host_config,
            "Labels": {"com.secheur.competition": "ctf-lab-gateway", "com.secheur.exercise": spec.exercise_id},
        }
        if spec.command:
            config["Cmd"] = list(spec.command)
        if spec.working_dir:
            config["WorkingDir"] = spec.working_dir
        created = json_object(self.request("POST", "/containers/create", config), "Docker create response")
        container_id = string_value(created.get("Id"), "Docker container id")
        try:
            self.request("POST", f"/containers/{quote(container_id, safe='')}/start")
            inspected = json_object(self.request("GET", f"/containers/{quote(container_id, safe='')}/json"), "Docker inspect response")
            return container_id, inspected
        except Exception:
            try:
                self.stop_remove(container_id)
            except DockerError:
                pass
            raise

    def inspect(self, container_id: str) -> dict[str, Any]:
        return json_object(self.request("GET", f"/containers/{quote(container_id, safe='')}/json"), "Docker inspect response")

    def stop_remove(self, container_id: str) -> None:
        encoded = quote(container_id, safe="")
        try:
            self.request("POST", f"/containers/{encoded}/stop?t=5")
        except DockerError as error:
            if error.status != 304 and error.status != 404:
                raise
        try:
            self.request("DELETE", f"/containers/{encoded}?force=true")
        except DockerError as error:
            if error.status != 404:
                raise


def published_endpoint(inspected: dict[str, Any], container_port: int, advertised_host: str) -> dict[str, Any]:
    port_key = f"{container_port}/tcp"
    network = json_object(inspected.get("NetworkSettings", {}), "Docker network settings")
    ports = network.get("Ports", {})
    bindings = ports.get(port_key) if isinstance(ports, dict) else None
    if isinstance(bindings, list) and bindings:
        binding = json_object(bindings[0], "Docker port binding")
        host_port = binding.get("HostPort")
        if isinstance(host_port, str) and host_port.isdigit():
            return {"host": advertised_host, "port": int(host_port)}
    networks = network.get("Networks")
    if isinstance(networks, dict):
        for value in networks.values():
            if isinstance(value, dict) and isinstance(value.get("IPAddress"), str) and value["IPAddress"]:
                return {"host": value["IPAddress"], "port": container_port}
    raise GatewayError("Docker container did not expose a reachable TCP endpoint", "environment_error")


class EnvironmentManager:
    def __init__(
        self,
        challenges: dict[str, ChallengeSpec],
        docker: DockerEngine,
        state_path: str,
        max_slots: int = DEFAULT_MAX_SLOTS,
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
        advertised_host: str = "127.0.0.1",
        clock: Callable[[], int] = now_ms,
    ) -> None:
        self.challenges = challenges
        self.docker = docker
        self.state_path = Path(state_path)
        self.max_slots = max(1, max_slots)
        self.ttl_ms = max(5_000, ttl_seconds * 1000)
        self.advertised_host = advertised_host
        self.clock = clock
        self.lock = threading.RLock()
        self.state: dict[str, dict[str, Any]] = self._load_state()

    def _load_state(self) -> dict[str, dict[str, Any]]:
        try:
            value = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, json.JSONDecodeError):
            return {}
        if not isinstance(value, dict):
            return {}
        environments = value.get("environments", value)
        return environments if isinstance(environments, dict) else {}

    def _save_state(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_path = tempfile.mkstemp(prefix="ctf-lab-gateway-", suffix=".tmp", dir=self.state_path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump({"version": 1, "environments": self.state}, handle, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temp_path, 0o600)
            os.replace(temp_path, self.state_path)
        finally:
            try:
                os.unlink(temp_path)
            except FileNotFoundError:
                pass

    def _active_count(self) -> int:
        return sum(1 for value in self.state.values() if value.get("status") in {"active", "cleanup_error"})

    def _cleanup_expired(self) -> None:
        changed = False
        current_time = self.clock()
        for exercise_id, value in list(self.state.items()):
            if value.get("status") not in {"active", "cleanup_error"}:
                continue
            if value.get("status") == "active" and int(value.get("expiresAt", 0)) > current_time:
                continue
            container_id = value.get("containerId")
            try:
                if isinstance(container_id, str) and container_id:
                    self.docker.stop_remove(container_id)
                value.update({"status": "expired", "releasedAt": current_time, "cleanupError": None})
                changed = True
            except DockerError as error:
                value.update({"status": "cleanup_error", "cleanupError": str(error), "cleanupRetryAt": current_time + 10_000})
                changed = True
        if changed:
            self._save_state()

    def _record(self, exercise_id: str, spec: ChallengeSpec, container_id: str, inspected: dict[str, Any]) -> dict[str, Any]:
        current_time = self.clock()
        endpoint = published_endpoint(inspected, spec.container_port, self.advertised_host)
        value = {
            "exerciseId": exercise_id,
            "status": "active",
            "containerId": container_id,
            "endpoint": endpoint,
            "leaseId": f"gateway-{container_id[:24]}",
            "acquiredAt": current_time,
            "heartbeatAt": current_time,
            "expiresAt": current_time + self.ttl_ms,
        }
        self.state[exercise_id] = value
        self._save_state()
        return value

    def _response(self, value: dict[str, Any]) -> dict[str, Any]:
        endpoint = value.get("endpoint")
        return {
            "status": "ready" if value.get("status") == "active" else "blocked",
            "endpoints": [endpoint] if isinstance(endpoint, dict) else [],
            "lease_id": value.get("leaseId"),
            "expires_at": value.get("expiresAt"),
            "exercise_id": value.get("exerciseId"),
        }

    def start(self, exercise_id: str) -> dict[str, Any]:
        with self.lock:
            self._cleanup_expired()
            existing = self.state.get(exercise_id)
            if existing and existing.get("status") == "active":
                return self._response(existing)
            if existing and existing.get("status") == "cleanup_error":
                raise GatewayError("previous environment cleanup is still failing", "environment_error")
            spec = self.challenges.get(exercise_id)
            if spec is None:
                raise GatewayError(f"exercise {exercise_id} has no local environment configuration", "environment_unconfigured")
            if self._active_count() >= self.max_slots:
                raise GatewayError("no local environment slot is available", "environment_capacity")
            try:
                container_id, inspected = self.docker.create_and_start(spec)
                return self._response(self._record(exercise_id, spec, container_id, inspected))
            except GatewayError:
                raise
            except DockerError as error:
                raise GatewayError(str(error), "environment_error") from error

    def get(self, exercise_id: str) -> dict[str, Any]:
        with self.lock:
            self._cleanup_expired()
            value = self.state.get(exercise_id)
            if not value or value.get("status") != "active":
                raise GatewayError(f"exercise {exercise_id} has no active environment", "environment_not_found", 404)
            container_id = value.get("containerId")
            try:
                if isinstance(container_id, str) and container_id:
                    inspected = self.docker.inspect(container_id)
                    state = json_object(inspected.get("State", {}), "Docker state")
                    if state.get("Running") is not True:
                        raise DockerError("Docker container is not running", 550)
                return self._response(value)
            except DockerError as error:
                value.update({"status": "cleanup_error", "cleanupError": str(error)})
                self._save_state()
                raise GatewayError(str(error), "environment_error") from error

    def heartbeat(self, exercise_id: str) -> dict[str, Any]:
        with self.lock:
            result = self.get(exercise_id)
            value = self.state[exercise_id]
            current_time = self.clock()
            value.update({"heartbeatAt": current_time, "expiresAt": current_time + self.ttl_ms})
            self._save_state()
            return result | {"expires_at": value["expiresAt"]}

    def release(self, exercise_id: str) -> dict[str, Any]:
        with self.lock:
            self._cleanup_expired()
            value = self.state.get(exercise_id)
            if not value or value.get("status") not in {"active", "cleanup_error"}:
                return {"exercise_id": exercise_id, "released": False, "reason": "not_active"}
            container_id = value.get("containerId")
            try:
                if isinstance(container_id, str) and container_id:
                    self.docker.stop_remove(container_id)
            except DockerError as error:
                value.update({"status": "cleanup_error", "cleanupError": str(error)})
                self._save_state()
                raise GatewayError(str(error), "environment_error") from error
            value.update({"status": "released", "releasedAt": self.clock(), "cleanupError": None})
            self._save_state()
            return {"exercise_id": exercise_id, "released": True, "lease_id": value.get("leaseId")}

    def health(self) -> dict[str, Any]:
        with self.lock:
            self._cleanup_expired()
            return {"ok": True, "active": self._active_count(), "max_slots": self.max_slots}


class GatewayRequestHandler(BaseHTTPRequestHandler):
    server_version = "SecHeurCtfLabGateway/1"

    @property
    def manager(self) -> EnvironmentManager:
        return self.server.manager  # type: ignore[attr-defined]

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict[str, Any]:
        length_text = self.headers.get("content-length", "0")
        try:
            length = int(length_text)
        except ValueError:
            raise GatewayError("invalid content length", "invalid_request", 400) from None
        if length < 0 or length > MAX_BODY_BYTES:
            raise GatewayError("request body is too large", "invalid_request", 413)
        raw = self.rfile.read(length)
        if not raw:
            return {}
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise GatewayError("request body must be JSON", "invalid_request", 400) from None
        return json_object(value, "request body")

    def _exercise_id(self, path: str) -> str:
        prefix = "/v1/environments/"
        if not path.startswith(prefix):
            raise GatewayError("unknown gateway route", "not_found", 404)
        exercise_id = unquote(path[len(prefix) :]).strip()
        if not exercise_id or "/" in exercise_id:
            raise GatewayError("invalid exercise id", "invalid_request", 400)
        return exercise_id

    def _run(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        if path == "/healthz" and self.command == "GET":
            self._send(200, self.manager.health())
            return
        if path == "/v1/environments" and self.command == "POST":
            body = self._body()
            exercise_id = string_value(body.get("exerciseId", body.get("exercise_id")), "exerciseId")
            self._send(200, self.manager.start(exercise_id))
            return
        if path.startswith("/v1/environments/"):
            heartbeat_suffix = "/heartbeat"
            is_heartbeat = path.endswith(heartbeat_suffix)
            exercise_path = path[: -len(heartbeat_suffix)].rstrip("/") if is_heartbeat else path
            exercise_id = self._exercise_id(exercise_path)
            if self.command == "GET":
                self._send(200, self.manager.get(exercise_id))
                return
            if self.command == "POST" and is_heartbeat:
                self._send(200, self.manager.heartbeat(exercise_id))
                return
            if self.command == "DELETE":
                self._send(200, self.manager.release(exercise_id))
                return
        raise GatewayError("unknown gateway route", "not_found", 404)

    def _handle(self) -> None:
        try:
            self._run()
        except GatewayError as error:
            self._send(error.status, {"ok": False, "code": error.code, "message": str(error)})
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as error:  # pragma: no cover - final HTTP safety net
            self._send(500, {"ok": False, "code": "internal_error", "message": str(error)})

    def do_GET(self) -> None:  # noqa: N802
        self._handle()

    def do_POST(self) -> None:  # noqa: N802
        self._handle()

    def do_DELETE(self) -> None:  # noqa: N802
        self._handle()

    def log_message(self, format_string: str, *args: Any) -> None:
        sys.stderr.write(f"ctf-lab-gateway: {format_string % args}\n")


class GatewayServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], manager: EnvironmentManager) -> None:
        super().__init__(address, GatewayRequestHandler)
        self.manager = manager
        self.daemon_threads = True
        self.allow_reuse_address = True


def create_manager_from_environment() -> EnvironmentManager:
    config_path = os.environ.get("CTF_LAB_CHALLENGE_CONFIG", "/config/challenges.json")
    return EnvironmentManager(
        challenges=load_challenges(config_path),
        docker=DockerEngine(os.environ.get("DOCKER_HOST_SOCKET", "/var/run/docker.sock")),
        state_path=os.environ.get("CTF_LAB_STATE_FILE", "/data/environments.json"),
        max_slots=int_env("CTF_LAB_MAX_ENVIRONMENTS", DEFAULT_MAX_SLOTS, 1),
        ttl_seconds=int_env("CTF_LAB_ENVIRONMENT_TTL_SECONDS", DEFAULT_TTL_SECONDS, 5),
        advertised_host=os.environ.get("CTF_LAB_ADVERTISE_HOST", "127.0.0.1"),
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="SecHeur local CTF environment lease gateway")
    parser.add_argument("--host", default=os.environ.get("CTF_LAB_GATEWAY_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int_env("CTF_LAB_GATEWAY_PORT", 8090, 1))
    args = parser.parse_args()
    manager = create_manager_from_environment()
    server = GatewayServer((args.host, args.port), manager)

    def stop(_signal: int, _frame: Any) -> None:
        server.shutdown()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        print(f"ctf-lab-gateway listening on {args.host}:{args.port}", flush=True)
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
