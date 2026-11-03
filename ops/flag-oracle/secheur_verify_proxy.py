#!/usr/bin/env python3
"""Token-holding verify-only bridge from a Unix socket to the local Oracle.

The socket protocol is one JSON object per line.  It intentionally exposes no
Oracle management endpoint, token, answer, candidate preview, or raw response.
"""
import argparse
import hashlib
import json
import logging
import os
import socketserver
import threading
import time
from collections import defaultdict
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

MAX_REQUEST_BYTES = 16_384
MAX_FLAG_CHARS = 2_048
MAX_FIELD_CHARS = 512
MAX_ATTEMPTS_PER_RUN = 3
ALLOWED_STATUS = {"correct", "incorrect", "duplicate", "limit_exceeded", "unknown_challenge"}
BASELINE_AGENT_IDS = frozenset({"nyu-baseline", "cai", "dcipher"})


class State:
    def __init__(self, oracle_url: str, token: str):
        self.oracle_url = oracle_url.rstrip("/") + "/api/v1/verify"
        self.token = token
        self.attempts = defaultdict(int)
        self.lock = threading.Lock()

    def verify(self, request: dict) -> dict:
        target = request.get("challenge_id")
        flag = request.get("flag")
        agent = request.get("agent_id")
        run = request.get("run_id")
        if not all(isinstance(value, str) and value.strip() for value in (target, flag, agent, run)):
            return {"ok": False, "status": "invalid_request"}
        if any(len(value) > MAX_FIELD_CHARS for value in (target, agent, run)) or len(flag) > MAX_FLAG_CHARS:
            return {"ok": False, "status": "invalid_request"}
        key = (run, target)
        with self.lock:
            if self.attempts[key] >= MAX_ATTEMPTS_PER_RUN:
                return {"ok": True, "verified": False, "status": "limit_exceeded"}
            self.attempts[key] += 1
        # Scope is assigned by this token-holding proxy, never accepted from the
        # untrusted container request.  Baselines receive a real verification
        # result without creating a shared Oracle success/attempt record.
        record_mode = "baseline" if agent.strip() in BASELINE_AGENT_IDS else "authoritative"
        payload = json.dumps({"challenge_id": target, "flag": flag, "agent_id": agent, "run_id": run, "record_mode": record_mode}).encode()
        http_request = Request(
            self.oracle_url,
            data=payload,
            method="POST",
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
        )
        digest = hashlib.sha256(flag.encode()).hexdigest()[:16]
        try:
            with urlopen(http_request, timeout=10) as response:
                body = json.load(response)
        except HTTPError as error:
            logging.warning("verify_http_error run=%s target=%s candidate_sha256=%s http_status=%s", run, target, digest, error.code)
            return {"ok": False, "status": "invalid_request" if error.code == 400 else "unavailable"}
        except (URLError, TimeoutError, ValueError) as error:
            logging.warning("verify_unavailable run=%s target=%s candidate_sha256=%s error=%s", run, target, digest, type(error).__name__)
            return {"ok": False, "status": "unavailable"}
        status = str(body.get("status", "incorrect"))
        if status not in ALLOWED_STATUS:
            status = "unavailable"
        verified = bool(body.get("correct", False)) if status == "correct" else False
        logging.info("verify run=%s target=%s candidate_sha256=%s verified=%s status=%s", run, target, digest, verified, status)
        return {"ok": bool(body.get("ok", False)), "verified": verified, "status": status}


class Handler(socketserver.StreamRequestHandler):
    state: State

    def handle(self):
        raw = self.rfile.readline(MAX_REQUEST_BYTES + 1)
        if not raw or len(raw) > MAX_REQUEST_BYTES:
            self.wfile.write(b'{"ok":false,"status":"invalid_request"}\n')
            return
        try:
            request = json.loads(raw)
        except json.JSONDecodeError:
            response = {"ok": False, "status": "invalid_request"}
        else:
            response = self.state.verify(request) if isinstance(request, dict) else {"ok": False, "status": "invalid_request"}
        self.wfile.write((json.dumps(response, separators=(",", ":")) + "\n").encode())


class UnixServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True)
    parser.add_argument("--oracle-url", default="http://127.0.0.1:18181")
    args = parser.parse_args()
    token = os.environ.get("CTF_ORACLE_TOKEN", "")
    if not token:
        raise SystemExit("CTF_ORACLE_TOKEN is required")
    path = Path(args.socket)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() or path.is_socket():
        path.unlink()
    Handler.state = State(args.oracle_url, token)
    with UnixServer(str(path), Handler) as server:
        os.chmod(path, 0o660)
        try:
            os.chown(path, -1, 967)
        except OSError:
            pass
        try:
            os.chown(path.parent, -1, 967)
            os.chmod(path.parent, 0o750)
        except OSError:
            pass
        logging.info("verify_proxy_ready socket=%s", path)
        server.serve_forever()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    main()
