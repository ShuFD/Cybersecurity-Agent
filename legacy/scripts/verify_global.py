#!/usr/bin/env python3
"""Run the SecHeur Agent global verification gate.

This script intentionally uses only the standard library so it can run before
optional frontend tooling is installed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.request
from urllib.parse import urlparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PYTHON = sys.executable
BRIDGE_BASE = os.environ.get("SECHEUR_VERIFY_BRIDGE", "").rstrip("/")
EXCLUDED_DIRS = {".git", ".venv", "venv", "env", "__pycache__", "tool_results", "temp", "tmp", "sche_tasks"}
PRIVATE_SOURCE_NAMES = {"mykey.py", "mykey.py.bak", "mykey.py.tmp"}
HYGIENE_SKIP_PREFIXES = ("tests/", ".git/", ".venv/", "tool_results/")
HYGIENE_SKIP_FILES = {"scripts/verify_global.py"}
HYGIENE_TOKEN_PATTERNS = (
    ("desktop reference repo", re.compile(re.escape("desktop-" + "cc-gui"), re.IGNORECASE)),
    ("old bridge class", re.compile(re.escape("Ga" + "Bridge"))),
    ("old bridge asset", re.compile(re.escape("ga-" + "web"), re.IGNORECASE)),
    ("old window alias", re.compile(r"window\.ga\b")),
    ("old assistant brand", re.compile(re.escape("Super" + "Assistant"), re.IGNORECASE)),
    ("old GA token", re.compile(r"\bGA\b")),
    ("old SA token", re.compile(r"\bSA\b")),
)


def section(title: str) -> None:
    print(f"\n== {title} ==", flush=True)


def run(cmd: list[str], *, env: dict[str, str] | None = None, display: str | None = None) -> None:
    print("+", display or " ".join(cmd), flush=True)
    process_env = None
    if env is not None:
        process_env = {**os.environ, **env}
    subprocess.run(cmd, cwd=ROOT, env=process_env, check=True)


def tracked_files() -> list[str]:
    try:
        result = subprocess.run(["git", "ls-files"], cwd=ROOT, text=True, capture_output=True, check=True)
        return [line for line in result.stdout.splitlines() if line]
    except (subprocess.CalledProcessError, FileNotFoundError):
        return filesystem_source_files()


def filesystem_source_files() -> list[str]:
    files: list[str] = []
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(ROOT)
        if any(part in EXCLUDED_DIRS for part in rel.parts):
            continue
        files.append(str(rel))
    return files


def read_text(rel_path: str) -> str:
    try:
        return (ROOT / rel_path).read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return ""


def check_repository_hygiene() -> None:
    violations: list[str] = []
    for rel_path in tracked_files():
        if rel_path in HYGIENE_SKIP_FILES or rel_path.startswith(HYGIENE_SKIP_PREFIXES):
            continue
        text = read_text(rel_path)
        if not text:
            continue
        for label, pattern in HYGIENE_TOKEN_PATTERNS:
            if pattern.search(text):
                violations.append(f"{rel_path}: {label}")
    if violations:
        details = "\n".join(violations[:20])
        raise AssertionError(f"stale branding/reference tokens found:\n{details}")


def python_sources() -> list[str]:
    files: list[str] = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.suffix not in {".py", ".pyw"}:
            continue
        if path.name in PRIVATE_SOURCE_NAMES:
            continue
        rel = path.relative_to(ROOT)
        if any(part in EXCLUDED_DIRS for part in rel.parts):
            continue
        files.append(str(rel))
    return files


def check_python_compile() -> None:
    files = python_sources()
    if not files:
        raise RuntimeError("no Python sources found")
    chunk: list[str] = []
    for file in files:
        chunk.append(file)
        if len(chunk) >= 100:
            run([PYTHON, "-m", "py_compile", *chunk], display=f"{PYTHON} -m py_compile <{len(chunk)} files>")
            chunk = []
    if chunk:
        run([PYTHON, "-m", "py_compile", *chunk], display=f"{PYTHON} -m py_compile <{len(chunk)} files>")


def check_js() -> None:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node is required to verify desktop JavaScript")
    for rel in (
        "frontends/desktop/static/app.js",
        "frontends/desktop/static/secheur-web.js",
    ):
        run([node, "--check", rel])


def check_cli_entrypoints() -> None:
    status_env = None
    if BRIDGE_BASE:
        status_env = {**os.environ, "SECHEUR_STATUS_URL": f"{BRIDGE_BASE}/status"}
    run([PYTHON, "-m", "secheur_cli.cli", "--help"])
    run([PYTHON, "-m", "secheur_cli.cli", "list"])
    run([PYTHON, "-m", "secheur_cli.cli", "status"], env=status_env)
    run([PYTHON, "-m", "secheur_cli.cli", "--version"])
    run([PYTHON, "launch.pyw", "--help"])
    run([PYTHON, "agentmain.py", "--help"])


def wait_for_bridge(timeout: float = 5.0) -> dict:
    if not BRIDGE_BASE:
        raise RuntimeError("BRIDGE_BASE is not configured")
    deadline = time.time() + timeout
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{BRIDGE_BASE}/status", timeout=1) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            if payload.get("ok") and payload.get("ready"):
                return payload
        except Exception as exc:  # noqa: BLE001 - report the last transport error.
            last_error = exc
            time.sleep(0.2)
    raise RuntimeError(f"bridge not ready at {BRIDGE_BASE}: {last_error}")


def http_json(path: str, method: str = "GET", payload: dict | None = None) -> dict:
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{BRIDGE_BASE}{path}", data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=5) as resp:
        body = resp.read().decode("utf-8")
    return json.loads(body) if body else {}


def http_text(path: str) -> str:
    with urllib.request.urlopen(f"{BRIDGE_BASE}{path}", timeout=5) as resp:
        return resp.read().decode("utf-8")


def start_fake_models_server() -> tuple[ThreadingHTTPServer, dict]:
    seen: dict[str, str] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - stdlib hook name.
            seen["path"] = self.path
            seen["authorization"] = self.headers.get("Authorization", "")
            payload = {
                "data": [
                    {"id": "verify-model-a", "display_name": "Verify Model A"},
                    {"id": "verify-model-b"},
                ]
            }
            body = json.dumps(payload).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, seen


def check_api_model_fetch() -> None:
    server, seen = start_fake_models_server()
    try:
        host, port = server.server_address
        result = http_json(
            "/api-config/models",
            method="POST",
            payload={
                "config": {
                    "name": "verify-model-fetch",
                    "type": "native_oai",
                    "apikey": "sk-verify",
                    "apibase": f"http://{host}:{port}/v1",
                    "model": "",
                }
            },
        )
    finally:
        server.shutdown()
        server.server_close()

    if not result.get("ok"):
        raise AssertionError(f"/api-config/models failed: {result}")
    expected = [
        {"id": "verify-model-a", "name": "Verify Model A"},
        {"id": "verify-model-b", "name": "verify-model-b"},
    ]
    if result.get("models") != expected:
        raise AssertionError(f"unexpected model list: {result.get('models')}")
    if seen.get("path") != "/v1/models":
        raise AssertionError(f"model fetch used wrong path: {seen.get('path')}")
    if seen.get("authorization") != "Bearer sk-verify":
        raise AssertionError("model fetch did not send bearer token")


def check_bridge_http() -> None:
    status = wait_for_bridge()
    print(json.dumps({"bridgeBase": BRIDGE_BASE, "bridge": status}, ensure_ascii=False, indent=2))

    html = http_text("/")
    for asset in (
        "styles.css?v=settings-b33",
        "secheur-web.js?v=bridge-adapter-10",
        "app.js?v=bridge-api-77",
    ):
        if asset not in html:
            raise AssertionError(f"index.html missing asset: {asset}")
        http_text(f"/{asset}")

    for path in ("/config", "/api-config", "/registry", "/model-profiles", "/sessions"):
        payload = http_json(path)
        if payload.get("ok") is False:
            raise AssertionError(f"{path} returned ok=false: {payload}")

    check_api_model_fetch()

    session_payload = http_json("/session/new", method="POST", payload={})
    sid = session_payload["session"]["id"]
    try:
        http_json(f"/session/{sid}")
        http_json(f"/session/{sid}/messages")
        http_json(f"/session/{sid}/model", method="POST", payload={"llmNo": 0})
        http_json(f"/session/{sid}/permission-mode", method="POST", payload={"permissionMode": "default"})
        http_json(f"/session/{sid}/cancel", method="POST", payload={})
    finally:
        http_json(f"/session/{sid}", method="DELETE")

    temp_name = "verify-global-temp"
    temp_configs = (
        ("/mcp-config", f"/mcp-config/{temp_name}", {"name": temp_name, "command": "python", "args": ["--version"]}),
        ("/skill-config", f"/skill-config/{temp_name}", {"name": temp_name, "body": "# Verify Global\n\n临时检查。"}),
        ("/agent-config", f"/agent-config/{temp_name}", {"name": temp_name, "body": "# Verify Global\n\n临时检查。"}),
    )
    for save_path, delete_path, config in temp_configs:
        try:
            result = http_json(save_path, method="POST", payload={"config": config})
            if not result.get("ok"):
                raise AssertionError(f"{save_path} failed: {result}")
        finally:
            http_json(delete_path, method="DELETE")


def ensure_bridge_running() -> subprocess.Popen[bytes] | None:
    global BRIDGE_BASE
    if not BRIDGE_BASE:
        host = "127.0.0.1"
        port = reserve_free_port(host)
        BRIDGE_BASE = f"http://{host}:{port}"
        return start_bridge_process(port)

    host, port = bridge_host_port(BRIDGE_BASE)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        if sock.connect_ex((host, port)) == 0:
            return None
    return start_bridge_process(port)


def bridge_host_port(base: str) -> tuple[str, int]:
    parsed = urlparse(base)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError(f"unsupported bridge URL scheme: {base}")
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return host, int(port)


def start_bridge_process(port: int) -> subprocess.Popen[bytes]:
    log = open("/tmp/secheur-agent-verify-bridge.log", "ab", buffering=0)
    env = {**os.environ, "BRIDGE_PORT": str(port)}
    process = subprocess.Popen(
        [PYTHON, "frontends/desktop_bridge.py"],
        cwd=ROOT,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=log,
        start_new_session=True,
    )
    return process


def reserve_free_port(host: str = "127.0.0.1") -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def export_clean_archive() -> str:
    tmp = tempfile.mkdtemp(prefix="secheur-clean-")
    archive_path = Path(tmp) / "repo.tar"
    subprocess.run(["git", "archive", "HEAD", "--output", str(archive_path)], cwd=ROOT, check=True)
    with tarfile.open(archive_path) as archive:
        archive.extractall(tmp)
    archive_path.unlink(missing_ok=True)
    return tmp


def check_clean_archive() -> None:
    clean_root = export_clean_archive()
    try:
        run(
            [PYTHON, str(Path(clean_root) / "scripts" / "verify_global.py"), "--skip-clean-archive"],
            env={"SECHEUR_VERIFY_CLEAN_ARCHIVE": "1"},
            display=f"{PYTHON} <clean-archive>/scripts/verify_global.py --skip-clean-archive",
        )
    finally:
        shutil.rmtree(clean_root, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run SecHeur Agent global verification")
    parser.add_argument("--skip-http", action="store_true", help="skip runtime bridge HTTP smoke")
    parser.add_argument("--skip-clean-archive", action="store_true", help="skip clean git archive verification")
    args = parser.parse_args()

    bridge_process = None if args.skip_http else ensure_bridge_running()
    try:
        section("Python unit tests")
        run([PYTHON, "-m", "unittest", "discover", "-s", "tests"])

        section("Scheduler ResourceWarning guard")
        run([PYTHON, "-W", "error::ResourceWarning", "-m", "unittest", "tests.test_scheduler_runtime"])

        section("Python syntax")
        check_python_compile()

        section("Repository hygiene")
        check_repository_hygiene()

        section("Desktop JavaScript syntax")
        check_js()

        section("CLI")
        check_cli_entrypoints()

        if not args.skip_http:
            section("Desktop bridge HTTP smoke")
            check_bridge_http()

        if not args.skip_clean_archive and not os.environ.get("SECHEUR_VERIFY_CLEAN_ARCHIVE"):
            section("Clean archive")
            check_clean_archive()

        section("Result")
        print("global verification passed")
        return 0
    finally:
        if bridge_process is not None:
            bridge_process.terminate()
            try:
                bridge_process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                bridge_process.kill()


if __name__ == "__main__":
    raise SystemExit(main())
