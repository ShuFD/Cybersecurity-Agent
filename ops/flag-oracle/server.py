#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

from aiohttp import web


MAX_FLAG_LENGTH = 4096
DEFAULT_DB_PATH = Path.home() / ".local" / "share" / "secheur-flag-oracle" / "oracle.sqlite3"
STORE_KEY = web.AppKey("flag_oracle_store", object)
TOKEN_KEY = web.AppKey("flag_oracle_token", str)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def normalize_challenge_id(value: str) -> str:
    challenge_id = str(value or "").strip()
    # Field target IDs are opaque identifiers, not URL path segments. Preserve
    # their internal spaces and punctuation while rejecting control characters.
    if not 1 <= len(challenge_id) <= 200 or not challenge_id.isprintable():
        raise ValueError("challenge_id must be 1-200 printable characters")
    return challenge_id


def normalize_flag(value: str) -> str:
    flag = str(value or "").strip()
    if not flag:
        raise ValueError("flag must not be empty")
    if len(flag) > MAX_FLAG_LENGTH:
        raise ValueError(f"flag must not exceed {MAX_FLAG_LENGTH} characters")
    return flag


def normalize_identity(value: str, field_name: str, default: str) -> str:
    identity = str(value or default).strip()
    if not identity:
        identity = default
    if len(identity) > 200:
        raise ValueError(f"{field_name} must not exceed 200 characters")
    return identity


def candidate_preview(flag: str) -> str:
    if len(flag) <= 4:
        return "*" * len(flag)
    if flag.startswith("flag{") and flag.endswith("}"):
        return f"flag{{...}} ({len(flag)} chars)"
    return f"{flag[:3]}...{flag[-2:]} ({len(flag)} chars)"


@dataclass(frozen=True)
class Challenge:
    challenge_id: str
    title: str = ""
    benchmark: str = ""
    category: str = ""
    difficulty: str = ""


class FlagOracleStore:
    def __init__(self, db_path: Path | str, secret: str):
        secret_text = str(secret or "")
        if len(secret_text) < 16:
            raise ValueError("CTF_ORACLE_SECRET must contain at least 16 characters")
        self.db_path = Path(db_path).expanduser().resolve()
        self.secret = secret_text.encode("utf-8")
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA busy_timeout = 10000")
        return connection

    def initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS challenges (
                    challenge_id TEXT PRIMARY KEY,
                    title TEXT NOT NULL DEFAULT '',
                    benchmark TEXT NOT NULL DEFAULT '',
                    category TEXT NOT NULL DEFAULT '',
                    difficulty TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS accepted_flags (
                    challenge_id TEXT NOT NULL,
                    flag_digest TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (challenge_id, flag_digest),
                    FOREIGN KEY (challenge_id) REFERENCES challenges(challenge_id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS attempts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    challenge_id TEXT NOT NULL,
                    agent_id TEXT NOT NULL,
                    run_id TEXT NOT NULL,
                    candidate_digest TEXT NOT NULL,
                    candidate_preview TEXT NOT NULL,
                    candidate_length INTEGER NOT NULL,
                    result TEXT NOT NULL CHECK (result IN ('correct', 'incorrect', 'unknown_challenge')),
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_attempts_challenge
                    ON attempts(challenge_id, id DESC);
                CREATE INDEX IF NOT EXISTS idx_attempts_agent_run
                    ON attempts(challenge_id, agent_id, run_id, id DESC);
                CREATE INDEX IF NOT EXISTS idx_attempts_result
                    ON attempts(result, id DESC);
                """
            )

    def _digest(self, flag: str) -> str:
        return hmac.new(self.secret, flag.encode("utf-8"), hashlib.sha256).hexdigest()

    def set_challenge(
        self,
        challenge: Challenge,
        accepted_flags: Sequence[str],
        *,
        replace: bool = True,
    ) -> dict[str, Any]:
        challenge_id = normalize_challenge_id(challenge.challenge_id)
        flags = [normalize_flag(flag) for flag in accepted_flags]
        if not flags:
            raise ValueError("at least one accepted flag is required")
        now = utc_now()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO challenges (
                    challenge_id, title, benchmark, category, difficulty, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(challenge_id) DO UPDATE SET
                    title = excluded.title,
                    benchmark = excluded.benchmark,
                    category = excluded.category,
                    difficulty = excluded.difficulty,
                    updated_at = excluded.updated_at
                """,
                (
                    challenge_id,
                    str(challenge.title or "").strip(),
                    str(challenge.benchmark or "").strip(),
                    str(challenge.category or "").strip(),
                    str(challenge.difficulty or "").strip(),
                    now,
                    now,
                ),
            )
            if replace:
                connection.execute(
                    "DELETE FROM accepted_flags WHERE challenge_id = ?",
                    (challenge_id,),
                )
            connection.executemany(
                """
                INSERT OR IGNORE INTO accepted_flags (challenge_id, flag_digest, created_at)
                VALUES (?, ?, ?)
                """,
                [(challenge_id, self._digest(flag), now) for flag in flags],
            )
            accepted_count = connection.execute(
                "SELECT COUNT(*) FROM accepted_flags WHERE challenge_id = ?",
                (challenge_id,),
            ).fetchone()[0]
        return {
            "ok": True,
            "challengeId": challenge_id,
            "acceptedFlagCount": accepted_count,
            "replace": bool(replace),
        }

    def verify(
        self,
        challenge_id: str,
        candidate_flag: str,
        *,
        agent_id: str,
        run_id: str,
        record_mode: str = "authoritative",
    ) -> dict[str, Any]:
        normalized_id = normalize_challenge_id(challenge_id)
        normalized_flag = normalize_flag(candidate_flag)
        normalized_agent = normalize_identity(agent_id, "agent_id", "secheur-agent")
        normalized_run = normalize_identity(run_id, "run_id", "default")
        normalized_mode = str(record_mode or "authoritative").strip().lower()
        if normalized_mode not in {"authoritative", "baseline"}:
            raise ValueError("record_mode must be authoritative or baseline")
        digest = self._digest(normalized_flag)
        now = utc_now()

        with self._connect() as connection:
            challenge_exists = connection.execute(
                "SELECT 1 FROM challenges WHERE challenge_id = ?",
                (normalized_id,),
            ).fetchone() is not None
            correct = False
            if challenge_exists:
                correct = connection.execute(
                    """
                    SELECT 1 FROM accepted_flags
                    WHERE challenge_id = ? AND flag_digest = ?
                    """,
                    (normalized_id, digest),
                ).fetchone() is not None
            result = "correct" if correct else ("incorrect" if challenge_exists else "unknown_challenge")
            if normalized_mode == "baseline":
                # Baseline evaluation needs the same answer comparison, but must
                # not persist a candidate or change the personal solve metrics.
                duplicate = False
                attempt_id = None
                run_attempt = agent_attempts = total_attempts = 0
            else:
                duplicate = connection.execute(
                    """
                    SELECT 1 FROM attempts
                    WHERE challenge_id = ? AND agent_id = ? AND run_id = ? AND candidate_digest = ?
                    LIMIT 1
                    """,
                    (normalized_id, normalized_agent, normalized_run, digest),
                ).fetchone() is not None
                cursor = connection.execute(
                    """
                    INSERT INTO attempts (
                        challenge_id, agent_id, run_id, candidate_digest, candidate_preview,
                        candidate_length, result, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        normalized_id,
                        normalized_agent,
                        normalized_run,
                        digest,
                        candidate_preview(normalized_flag),
                        len(normalized_flag),
                        result,
                        now,
                    ),
                )
                attempt_id = cursor.lastrowid
                run_attempt = connection.execute(
                    """
                    SELECT COUNT(*) FROM attempts
                    WHERE challenge_id = ? AND agent_id = ? AND run_id = ?
                    """,
                    (normalized_id, normalized_agent, normalized_run),
                ).fetchone()[0]
                agent_attempts = connection.execute(
                    """
                    SELECT COUNT(*) FROM attempts
                    WHERE challenge_id = ? AND agent_id = ?
                    """,
                    (normalized_id, normalized_agent),
                ).fetchone()[0]
                total_attempts = connection.execute(
                    "SELECT COUNT(*) FROM attempts WHERE challenge_id = ?",
                    (normalized_id,),
                ).fetchone()[0]

        message = {
            "correct": "Flag accepted.",
            "incorrect": "Flag rejected. Continue solving and do not repeat the same candidate.",
            "unknown_challenge": "Challenge is not configured in the Flag Oracle.",
        }[result]
        return {
            "ok": True,
            "attemptId": attempt_id,
            "challengeId": normalized_id,
            "agentId": normalized_agent,
            "runId": normalized_run,
            "correct": correct,
            "status": result,
            "duplicate": duplicate,
            "attempt": run_attempt,
            "agentAttempts": agent_attempts,
            "totalAttempts": total_attempts,
            "recordMode": normalized_mode,
            "message": message,
            "verifiedAt": now,
        }

    def summary(self, limit: int = 30) -> dict[str, Any]:
        safe_limit = max(1, min(int(limit), 200))
        with self._connect() as connection:
            totals = connection.execute(
                """
                SELECT
                    (SELECT COUNT(*) FROM challenges) AS challenge_count,
                    (SELECT COUNT(*) FROM attempts) AS attempt_count,
                    (SELECT COUNT(*) FROM attempts WHERE result = 'correct') AS correct_attempt_count,
                    (SELECT COUNT(*) FROM attempts WHERE result = 'incorrect') AS incorrect_attempt_count,
                    (
                        SELECT COUNT(DISTINCT challenge_id)
                        FROM attempts
                        WHERE result = 'correct'
                    ) AS solved_challenge_count
                """
            ).fetchone()
            challenge_rows = connection.execute(
                """
                SELECT
                    c.challenge_id,
                    c.title,
                    c.benchmark,
                    c.category,
                    c.difficulty,
                    COUNT(a.id) AS attempt_count,
                    SUM(CASE WHEN a.result = 'correct' THEN 1 ELSE 0 END) AS correct_attempt_count,
                    MAX(a.created_at) AS last_attempt_at
                FROM challenges c
                LEFT JOIN attempts a ON a.challenge_id = c.challenge_id
                GROUP BY c.challenge_id
                ORDER BY
                    CASE WHEN MAX(a.created_at) IS NULL THEN 1 ELSE 0 END,
                    MAX(a.created_at) DESC,
                    c.challenge_id
                """
            ).fetchall()
            recent_rows = connection.execute(
                """
                SELECT
                    id,
                    challenge_id,
                    agent_id,
                    run_id,
                    candidate_preview,
                    candidate_length,
                    result,
                    created_at,
                    COUNT(*) OVER (
                        PARTITION BY challenge_id, agent_id, run_id
                        ORDER BY id
                        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                    ) AS run_attempt
                FROM attempts
                ORDER BY id DESC
                LIMIT ?
                """,
                (safe_limit,),
            ).fetchall()

        challenges = [
            {
                "challengeId": row["challenge_id"],
                "title": row["title"],
                "benchmark": row["benchmark"],
                "category": row["category"],
                "difficulty": row["difficulty"],
                "attempts": int(row["attempt_count"] or 0),
                "correctAttempts": int(row["correct_attempt_count"] or 0),
                "solved": bool(row["correct_attempt_count"]),
                "lastAttemptAt": row["last_attempt_at"],
            }
            for row in challenge_rows
        ]
        recent_attempts = [
            {
                "attemptId": row["id"],
                "challengeId": row["challenge_id"],
                "agentId": row["agent_id"],
                "runId": row["run_id"],
                "candidatePreview": row["candidate_preview"],
                "candidateLength": row["candidate_length"],
                "status": row["result"],
                "correct": row["result"] == "correct",
                "createdAt": row["created_at"],
                "attempt": row["run_attempt"],
            }
            for row in recent_rows
        ]
        return {
            "ok": True,
            "generatedAt": utc_now(),
            "totals": {
                "challenges": int(totals["challenge_count"] or 0),
                "solvedChallenges": int(totals["solved_challenge_count"] or 0),
                "attempts": int(totals["attempt_count"] or 0),
                "correctAttempts": int(totals["correct_attempt_count"] or 0),
                "incorrectAttempts": int(totals["incorrect_attempt_count"] or 0),
            },
            "challenges": challenges,
            "recentAttempts": recent_attempts,
        }


    def list_attempts(
        self,
        *,
        challenge_id: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        safe_limit = max(1, min(int(limit), 200))
        normalized_id = None
        if challenge_id is not None and str(challenge_id).strip():
            normalized_id = normalize_challenge_id(challenge_id)

        with self._connect() as connection:
            if normalized_id is None:
                totals = connection.execute(
                    """
                    SELECT
                        COUNT(*) AS attempt_count,
                        SUM(CASE WHEN result = 'correct' THEN 1 ELSE 0 END) AS correct_attempt_count,
                        SUM(CASE WHEN result = 'incorrect' THEN 1 ELSE 0 END) AS incorrect_attempt_count,
                        SUM(CASE WHEN result = 'unknown_challenge' THEN 1 ELSE 0 END) AS unknown_attempt_count
                    FROM attempts
                    """
                ).fetchone()
                rows = connection.execute(
                    """
                    SELECT
                        id,
                        challenge_id,
                        agent_id,
                        run_id,
                        candidate_preview,
                        candidate_length,
                        result,
                        created_at,
                        COUNT(*) OVER (
                            PARTITION BY challenge_id, agent_id, run_id
                            ORDER BY id
                            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                        ) AS run_attempt
                    FROM attempts
                    ORDER BY id DESC
                    LIMIT ?
                    """,
                    (safe_limit,),
                ).fetchall()
                challenge_exists = None
            else:
                challenge_exists = connection.execute(
                    "SELECT 1 FROM challenges WHERE challenge_id = ?",
                    (normalized_id,),
                ).fetchone() is not None
                totals = connection.execute(
                    """
                    SELECT
                        COUNT(*) AS attempt_count,
                        SUM(CASE WHEN result = 'correct' THEN 1 ELSE 0 END) AS correct_attempt_count,
                        SUM(CASE WHEN result = 'incorrect' THEN 1 ELSE 0 END) AS incorrect_attempt_count,
                        SUM(CASE WHEN result = 'unknown_challenge' THEN 1 ELSE 0 END) AS unknown_attempt_count
                    FROM attempts
                    WHERE challenge_id = ?
                    """,
                    (normalized_id,),
                ).fetchone()
                rows = connection.execute(
                    """
                    SELECT
                        id,
                        challenge_id,
                        agent_id,
                        run_id,
                        candidate_preview,
                        candidate_length,
                        result,
                        created_at,
                        COUNT(*) OVER (
                            PARTITION BY challenge_id, agent_id, run_id
                            ORDER BY id
                            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                        ) AS run_attempt
                    FROM attempts
                    WHERE challenge_id = ?
                    ORDER BY id DESC
                    LIMIT ?
                    """,
                    (normalized_id, safe_limit),
                ).fetchall()

        attempts = [
            {
                "attemptId": row["id"],
                "challengeId": row["challenge_id"],
                "agentId": row["agent_id"],
                "runId": row["run_id"],
                "candidatePreview": row["candidate_preview"],
                "candidateLength": row["candidate_length"],
                "status": row["result"],
                "correct": row["result"] == "correct",
                "createdAt": row["created_at"],
                "attempt": int(row["run_attempt"] or 0),
            }
            for row in rows
        ]
        return {
            "ok": True,
            "generatedAt": utc_now(),
            "challengeId": normalized_id,
            "challengeConfigured": challenge_exists,
            "totals": {
                "attempts": int(totals["attempt_count"] or 0),
                "correctAttempts": int(totals["correct_attempt_count"] or 0),
                "incorrectAttempts": int(totals["incorrect_attempt_count"] or 0),
                "unknownAttempts": int(totals["unknown_attempt_count"] or 0),
            },
            "attempts": attempts,
            "limit": safe_limit,
        }



def _authorized(request: web.Request) -> bool:
    expected = request.app[TOKEN_KEY]
    header = str(request.headers.get("Authorization") or "")
    prefix = "Bearer "
    provided = header[len(prefix):].strip() if header.startswith(prefix) else ""
    return bool(provided) and hmac.compare_digest(provided, expected)


@web.middleware
async def auth_middleware(request: web.Request, handler):
    if request.path.startswith("/api/") and not _authorized(request):
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
    return await handler(request)


async def health_handler(request: web.Request) -> web.Response:
    store: FlagOracleStore = request.app[STORE_KEY]
    summary = store.summary(limit=1)
    return web.json_response(
        {
            "ok": True,
            "service": "secheur-flag-oracle",
            "configuredChallenges": summary["totals"]["challenges"],
            "attempts": summary["totals"]["attempts"],
        }
    )


async def verify_handler(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise ValueError("JSON body must be an object")
        store: FlagOracleStore = request.app[STORE_KEY]
        result = store.verify(
            payload.get("challengeId") or payload.get("challenge_id"),
            payload.get("flag"),
            agent_id=payload.get("agentId") or payload.get("agent_id"),
            run_id=payload.get("runId") or payload.get("run_id"),
            record_mode=payload.get("recordMode") or payload.get("record_mode") or "authoritative",
        )
        return web.json_response(result)
    except (json.JSONDecodeError, ValueError, TypeError) as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)



async def attempts_handler(request: web.Request) -> web.Response:
    try:
        limit = int(request.query.get("limit", "50"))
    except ValueError:
        return web.json_response({"ok": False, "error": "limit must be an integer"}, status=400)
    challenge_id = request.query.get("challengeId") or request.query.get("challenge_id") or request.query.get("target_id")
    store: FlagOracleStore = request.app[STORE_KEY]
    try:
        return web.json_response(store.list_attempts(challenge_id=challenge_id, limit=limit))
    except ValueError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)


async def summary_handler(request: web.Request) -> web.Response:
    try:
        limit = int(request.query.get("limit", "30"))
    except ValueError:
        return web.json_response({"ok": False, "error": "limit must be an integer"}, status=400)
    store: FlagOracleStore = request.app[STORE_KEY]
    return web.json_response(store.summary(limit=limit))


def create_app(store: FlagOracleStore, api_token: str) -> web.Application:
    token = str(api_token or "").strip()
    if len(token) < 16:
        raise ValueError("CTF_ORACLE_TOKEN must contain at least 16 characters")
    app = web.Application(middlewares=[auth_middleware], client_max_size=16 * 1024)
    app[STORE_KEY] = store
    app[TOKEN_KEY] = token
    app.router.add_get("/healthz", health_handler)
    app.router.add_post("/api/v1/verify", verify_handler)
    app.router.add_get("/api/v1/summary", summary_handler)
    app.router.add_get("/api/v1/attempts", attempts_handler)
    return app


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run and manage the SecHeur Flag Oracle.")
    parser.add_argument(
        "--db",
        default=os.environ.get("CTF_ORACLE_DB", str(DEFAULT_DB_PATH)),
        help="SQLite database path.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    serve = subparsers.add_parser("serve", help="Run the HTTP service.")
    serve.add_argument("--host", default=os.environ.get("CTF_ORACLE_HOST", "127.0.0.1"))
    serve.add_argument("--port", type=int, default=int(os.environ.get("CTF_ORACLE_PORT", "18181")))

    set_challenge = subparsers.add_parser("set-challenge", help="Create or update a challenge.")
    set_challenge.add_argument("--id", required=True, dest="challenge_id")
    set_challenge.add_argument("--title", default="")
    set_challenge.add_argument("--benchmark", default="")
    set_challenge.add_argument("--category", default="")
    set_challenge.add_argument("--difficulty", default="")
    set_challenge.add_argument("--flag", action="append", default=[])
    set_challenge.add_argument("--flag-stdin", action="store_true")
    set_challenge.add_argument("--flags-json-stdin", action="store_true")
    set_challenge.add_argument("--append", action="store_true")

    subparsers.add_parser("summary", help="Print the current summary as JSON.")
    return parser


def _required_env(name: str) -> str:
    value = str(os.environ.get(name) or "").strip()
    if not value:
        raise ValueError(f"{name} is required")
    return value


def main(argv: Sequence[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    store = FlagOracleStore(args.db, _required_env("CTF_ORACLE_SECRET"))

    if args.command == "serve":
        app = create_app(store, _required_env("CTF_ORACLE_TOKEN"))
        web.run_app(app, host=args.host, port=args.port, print=None)
        return

    if args.command == "set-challenge":
        if args.flag_stdin and args.flags_json_stdin:
            raise ValueError("choose one stdin flag format")
        flags = list(args.flag)
        if args.flag_stdin:
            flags.append(sys.stdin.read().strip())
        if args.flags_json_stdin:
            stdin_flags = json.loads(sys.stdin.read())
            if not isinstance(stdin_flags, list) or not all(isinstance(flag, str) for flag in stdin_flags):
                raise ValueError("flags JSON must be an array of strings")
            flags.extend(stdin_flags)
        result = store.set_challenge(
            Challenge(
                challenge_id=args.challenge_id,
                title=args.title,
                benchmark=args.benchmark,
                category=args.category,
                difficulty=args.difficulty,
            ),
            flags,
            replace=not args.append,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    if args.command == "summary":
        print(json.dumps(store.summary(limit=30), ensure_ascii=False, indent=2))
        return

    raise ValueError(f"unsupported command: {args.command}")


if __name__ == "__main__":
    main()
