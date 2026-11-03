#!/usr/bin/env python3
"""Sync CTF Field gold answers into SecHeur Flag Oracle.

Source of truth for answers is the isolated gold store used by
ctf-field-backend /api/answer (default: /home/ctf-gold/answers.jsonl).

This script must run with permission to read the gold store and with
CTF_ORACLE_SECRET available. The Agent process must never run it.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Any


DEFAULT_GOLD = Path("/home/ctf-gold/answers.jsonl")
DEFAULT_API = "http://127.0.0.1:14201/api"
DEFAULT_ORACLE_PY = Path("/opt/secheur-flag-oracle/venv/bin/python")
DEFAULT_ORACLE_SERVER = Path("/opt/secheur-flag-oracle/server.py")
DEFAULT_DB = Path("/var/lib/secheur-flag-oracle/oracle.sqlite3")
ANSWER_FIELDS = {"gold", "answer", "flag"}
from server import normalize_challenge_id


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, 1):
            text = line.strip()
            if not text:
                continue
            try:
                row = json.loads(text)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_no}: invalid JSON: {exc}") from exc
            if isinstance(row, dict):
                rows.append(row)
    return rows


def fetch_targets(api_base: str, timeout: float = 20.0) -> dict[str, dict[str, Any]]:
    url = api_base.rstrip("/") + "/targets"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, UnicodeDecodeError):
        return {}
    targets = payload.get("targets") if isinstance(payload, dict) else None
    if not isinstance(targets, list):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for item in targets:
        if not isinstance(item, dict):
            continue
        tid = str(item.get("target_id") or item.get("id") or "").strip()
        if tid:
            out[tid] = item
    return out


def collect_answers(rows: list[dict[str, Any]]) -> dict[str, list[str]]:
    grouped: dict[str, list[str]] = defaultdict(list)
    seen: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        field = str(row.get("field") or "").strip().lower()
        if field not in ANSWER_FIELDS:
            continue
        tid = str(row.get("target_id") or "").strip()
        value = str(row.get("value") or "").strip()
        if not tid or not value:
            continue
        if value in seen[tid]:
            continue
        seen[tid].add(value)
        grouped[tid].append(value)
    return dict(grouped)


def difficulty_from_target(target: dict[str, Any] | None) -> str:
    if not target:
        return ""
    status = str(target.get("status") or "").strip()
    mode = str(target.get("mode") or "").strip()
    parts = [p for p in (status, mode) if p]
    return "/".join(parts)


def set_challenge(
    *,
    oracle_py: Path,
    oracle_server: Path,
    db: Path,
    secret: str,
    challenge_id: str,
    title: str,
    benchmark: str,
    category: str,
    difficulty: str,
    flags: list[str],
    dry_run: bool,
) -> dict[str, Any]:
    if dry_run:
        return {
            "ok": True,
            "dryRun": True,
            "challengeId": challenge_id,
            "flagCount": len(flags),
            "title": title,
            "benchmark": benchmark,
            "category": category,
            "difficulty": difficulty,
        }
    cmd = [
        str(oracle_py),
        str(oracle_server),
        "--db",
        str(db),
        "set-challenge",
        "--id",
        challenge_id,
        "--title",
        title,
        "--benchmark",
        benchmark,
        "--category",
        category,
        "--difficulty",
        difficulty,
        "--flags-json-stdin",
    ]
    env = os.environ.copy()
    env["CTF_ORACLE_SECRET"] = secret
    proc = subprocess.run(
        cmd,
        input=json.dumps(flags),
        text=True,
        capture_output=True,
        env=env,
        check=False,
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip() or f"exit {proc.returncode}"
        raise RuntimeError(detail)
    text = (proc.stdout or "").strip()
    if not text:
        return {"ok": True, "challengeId": challenge_id}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"ok": True, "challengeId": challenge_id, "raw": text}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Sync CTF Field gold answers into Flag Oracle")
    p.add_argument("--gold", type=Path, default=Path(os.environ.get("CTF_GOLD_ANSWERS", DEFAULT_GOLD)))
    p.add_argument("--api", default=os.environ.get("CTF_FIELD_API", DEFAULT_API))
    p.add_argument("--oracle-python", type=Path, default=DEFAULT_ORACLE_PY)
    p.add_argument("--oracle-server", type=Path, default=DEFAULT_ORACLE_SERVER)
    p.add_argument("--db", type=Path, default=Path(os.environ.get("CTF_ORACLE_DB", DEFAULT_DB)))
    p.add_argument("--benchmark", action="append", default=[], help="Only sync these benchmarks (repeatable)")
    p.add_argument("--include-id", action="append", default=[], help="Only sync these target_id values")
    p.add_argument("--exclude-id", action="append", default=[], help="Skip these target_id values")
    p.add_argument("--limit", type=int, default=0, help="Sync at most N challenges (0 = all)")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--continue-on-error", action="store_true")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    secret = str(os.environ.get("CTF_ORACLE_SECRET") or "").strip()
    if not args.dry_run and len(secret) < 16:
        print("CTF_ORACLE_SECRET is required and must be at least 16 characters", file=sys.stderr)
        return 2
    if not args.gold.is_file():
        print(f"gold file not found: {args.gold}", file=sys.stderr)
        return 2

    rows = load_jsonl(args.gold)
    answers = collect_answers(rows)
    targets = fetch_targets(args.api)

    include = {x.strip() for x in args.include_id if x.strip()}
    exclude = {x.strip() for x in args.exclude_id if x.strip()}
    benchmarks = {x.strip() for x in args.benchmark if x.strip()}

    selected = sorted(answers)
    if include:
        selected = [tid for tid in selected if tid in include]
    if exclude:
        selected = [tid for tid in selected if tid not in exclude]
    if benchmarks:
        filtered = []
        for tid in selected:
            meta = targets.get(tid) or {}
            bench = str(meta.get("benchmark") or "").strip()
            if not bench:
                # fallback: first path segment
                bench = tid.split("/", 1)[0]
            if bench in benchmarks:
                filtered.append(tid)
        selected = filtered
    if args.limit and args.limit > 0:
        selected = selected[: args.limit]

    ok_count = 0
    skip_count = 0
    err_count = 0
    multi_flag = 0

    print(
        json.dumps(
            {
                "goldRows": len(rows),
                "answerTargets": len(answers),
                "apiTargets": len(targets),
                "selected": len(selected),
                "dryRun": bool(args.dry_run),
            },
            ensure_ascii=False,
        )
    )

    for tid in selected:
        flags = answers[tid]
        try:
            normalize_challenge_id(tid)
        except ValueError:
            skip_count += 1
            print(json.dumps({"status": "skip", "reason": "invalid_challenge_id", "targetId": tid}, ensure_ascii=False))
            continue
        meta = targets.get(tid) or {}
        title = str(meta.get("name") or tid.rsplit("/", 1)[-1] or tid).strip()
        benchmark = str(meta.get("benchmark") or tid.split("/", 1)[0]).strip()
        category = str(meta.get("category") or "").strip()
        difficulty = difficulty_from_target(meta)
        if len(flags) > 1:
            multi_flag += 1
        try:
            result = set_challenge(
                oracle_py=args.oracle_python,
                oracle_server=args.oracle_server,
                db=args.db,
                secret=secret,
                challenge_id=tid,
                title=title,
                benchmark=benchmark,
                category=category,
                difficulty=difficulty,
                flags=flags,
                dry_run=args.dry_run,
            )
            ok_count += 1
            print(
                json.dumps(
                    {
                        "status": "ok",
                        "targetId": tid,
                        "flagCount": len(flags),
                        "title": title,
                        "benchmark": benchmark,
                        "category": category,
                        "result": result,
                    },
                    ensure_ascii=False,
                )
            )
        except Exception as exc:  # noqa: BLE001 - batch tool should keep going optionally
            err_count += 1
            print(
                json.dumps(
                    {
                        "status": "error",
                        "targetId": tid,
                        "error": str(exc),
                    },
                    ensure_ascii=False,
                ),
                file=sys.stderr,
            )
            if not args.continue_on_error:
                break

    summary = {
        "ok": ok_count,
        "skip": skip_count,
        "error": err_count,
        "multiFlagTargets": multi_flag,
    }
    print(json.dumps({"summary": summary}, ensure_ascii=False))
    return 1 if err_count else 0


if __name__ == "__main__":
    raise SystemExit(main())
