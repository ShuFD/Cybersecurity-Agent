from __future__ import annotations

import json
import os
import socket
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_ORACLE_URL = "http://127.0.0.1:18181"
DEFAULT_CLIENT_ENV_PATH = Path.home() / ".config" / "secheur-agent" / "oracle-client.env"
DEFAULT_VERIFY_SOCKET = "/run/secheur-flag-oracle/verify.sock"
PROCESS_RUN_ID = f"run-{uuid.uuid4().hex[:16]}"


class FlagOracleError(RuntimeError):
    pass


class FlagOracleConfigurationError(FlagOracleError):
    pass


class FlagOracleUnavailableError(FlagOracleError):
    pass


@dataclass(frozen=True)
class FlagOracleConfig:
    base_url: str
    token: str
    agent_id: str
    run_id: str
    timeout: float = 8.0
    verify_socket: str = ""

    @classmethod
    def from_env(
        cls,
        *,
        agent_id: str | None = None,
        run_id: str | None = None,
        timeout: float | None = None,
    ) -> "FlagOracleConfig":
        file_values = _load_client_env()
        base_url = str(
            os.environ.get("CTF_ORACLE_URL")
            or file_values.get("CTF_ORACLE_URL")
            or DEFAULT_ORACLE_URL
        ).strip().rstrip("/")
        token = str(
            os.environ.get("CTF_ORACLE_TOKEN")
            or file_values.get("CTF_ORACLE_TOKEN")
            or ""
        ).strip()
        resolved_agent_id = str(
            agent_id
            or os.environ.get("CTF_AGENT_ID")
            or file_values.get("CTF_AGENT_ID")
            or "secheur-agent"
        ).strip()
        resolved_run_id = str(
            run_id
            or os.environ.get("CTF_RUN_ID")
            or file_values.get("CTF_RUN_ID")
            or PROCESS_RUN_ID
        ).strip()
        resolved_timeout = timeout if timeout is not None else _env_timeout("CTF_ORACLE_TIMEOUT", 8.0)
        socket_path = str(os.environ.get("CTF_ORACLE_SOCKET") or "").strip()
        return cls(
            base_url=base_url,
            token=token,
            agent_id=resolved_agent_id,
            run_id=resolved_run_id,
            timeout=resolved_timeout,
            verify_socket=socket_path,
        )


def _env_timeout(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, ""))
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _load_client_env() -> dict[str, str]:
    raw_path = os.environ.get("CTF_ORACLE_CLIENT_ENV_FILE")
    path = Path(raw_path).expanduser() if raw_path else DEFAULT_CLIENT_ENV_PATH
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return {}
    values: dict[str, str] = {}
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        if key in {
            "CTF_ORACLE_URL",
            "CTF_ORACLE_TOKEN",
            "CTF_AGENT_ID",
            "CTF_RUN_ID",
        }:
            values[key] = value
    return values


class FlagOracleClient:
    def __init__(self, config: FlagOracleConfig):
        self.config = config

    def verify(self, challenge_id: str, candidate_flag: str) -> dict[str, Any]:
        payload = {
            "challengeId": str(challenge_id or "").strip(),
            "flag": str(candidate_flag or ""),
            "agentId": self.config.agent_id,
            "runId": self.config.run_id,
        }
        return self._request("POST", "/api/v1/verify", payload)

    def summary(self, limit: int = 30) -> dict[str, Any]:
        safe_limit = max(1, min(int(limit), 200))
        return self._request("GET", f"/api/v1/summary?limit={safe_limit}")

    def attempts(
        self,
        *,
        challenge_id: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        safe_limit = max(1, min(int(limit), 200))
        query = [f"limit={safe_limit}"]
        cid = str(challenge_id or "").strip()
        if cid:
            from urllib.parse import quote
            query.append(f"challengeId={quote(cid, safe='')}")
        return self._request("GET", f"/api/v1/attempts?{'&'.join(query)}")

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if self.config.verify_socket:
            return self._socket_request(method, path, payload)
        if not self.config.token:
            raise FlagOracleConfigurationError("CTF_ORACLE_TOKEN is not configured")
        data = None
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self.config.token}",
        }
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            f"{self.config.base_url}{path}",
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=self.config.timeout) as response:
                raw = response.read(1_000_001)
                if len(raw) > 1_000_000:
                    raise FlagOracleError("Flag Oracle response exceeded 1000000 bytes")
                return _decode_json(raw)
        except urllib.error.HTTPError as exc:
            raw = exc.read(64_000)
            detail = _error_detail(raw) or str(exc.reason)
            if exc.code in {401, 403}:
                raise FlagOracleConfigurationError(
                    f"Flag Oracle authentication failed: HTTP {exc.code} {detail}"
                ) from exc
            raise FlagOracleError(f"Flag Oracle request failed: HTTP {exc.code} {detail}") from exc
        except (urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError) as exc:
            reason = getattr(exc, "reason", exc)
            raise FlagOracleUnavailableError(f"Flag Oracle is unavailable: {reason}") from exc

    def _socket_request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None,
    ) -> dict[str, Any]:
        if method != "POST" or path != "/api/v1/verify" or not isinstance(payload, dict):
            raise FlagOracleConfigurationError("local verification socket only supports flag verification")
        request = json.dumps({"method": method, "path": path, "payload": payload}, ensure_ascii=False).encode("utf-8")
        if len(request) > 8192:
            raise FlagOracleError("local verification request exceeded 8192 bytes")
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(self.config.timeout)
                client.connect(self.config.verify_socket)
                client.sendall(request + b"\n")
                chunks: list[bytes] = []
                total = 0
                while True:
                    block = client.recv(65536)
                    if not block:
                        break
                    chunks.append(block)
                    total += len(block)
                    if total > 1_000_000:
                        raise FlagOracleError("local verification response exceeded 1000000 bytes")
                    if b"\n" in block:
                        break
        except (OSError, TimeoutError, socket.timeout) as exc:
            raise FlagOracleUnavailableError(f"local Flag Oracle is unavailable: {exc}") from exc
        raw = b"".join(chunks).split(b"\n", 1)[0]
        try:
            response = _decode_json(raw)
        except FlagOracleError:
            raise
        if not response.get("ok"):
            raise FlagOracleError(str(response.get("error") or "local Flag Oracle rejected the request"))
        result = response.get("result")
        if not isinstance(result, dict):
            raise FlagOracleError("local Flag Oracle returned an invalid result")
        return result


def _decode_json(raw: bytes) -> dict[str, Any]:
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise FlagOracleError(f"Flag Oracle returned invalid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise FlagOracleError("Flag Oracle returned a non-object JSON response")
    return payload


def _error_detail(raw: bytes) -> str:
    if not raw:
        return ""
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return raw.decode("utf-8", errors="replace")[:500]
    if isinstance(payload, dict):
        return str(payload.get("error") or payload.get("message") or "")[:500]
    return str(payload)[:500]
