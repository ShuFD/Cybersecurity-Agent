import hashlib
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


FLAG_TEXT_KEYS = {
    "answer",
    "answers",
    "expected",
    "expected_answer",
    "expected_answers",
    "expected_flag",
    "expected_flags",
    "flag",
    "flags",
    "gold",
}
FLAG_HASH_KEYS = {
    "answer_sha256",
    "answer_hash",
    "expected_sha256",
    "flag_sha256",
    "flag_hash",
    "hash",
    "hashes",
    "sha256",
    "sha256s",
}
TARGET_ID_ENV_KEYS = ("SECHEUR_TARGET_ID", "CTF_TARGET_ID", "TARGET_ID")
RUN_ID_ENV_KEYS = ("SECHEUR_RUN_ID", "CTF_RUN_ID", "RUN_ID")
RUN_DIR_ENV_KEYS = ("SECHEUR_RUN_DIR", "CTF_RUN_DIR", "EVAL_RUN_DIR")


def normalize_flag(value: Any, *, case_sensitive: bool = True) -> str:
    text = str(value or "").strip()
    text = re.sub(r"^```[A-Za-z0-9_-]*\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    text = re.sub(r"(?is)^<FINAL_ANSWER>\s*", "", text)
    text = re.sub(r"(?is)\s*</FINAL_ANSWER>$", "", text)
    text = text.strip().strip("`'\" \t\r\n")
    return text if case_sensitive else text.lower()


def extract_flag_candidates(content: str) -> List[str]:
    text = str(content or "")
    candidates = [
        normalize_flag(match)
        for match in re.findall(r"(?is)<FINAL_ANSWER>\s*(.*?)\s*</FINAL_ANSWER>", text)
        if normalize_flag(match)
    ]
    if candidates:
        return _dedupe(candidates)

    # Fallback for direct CTF-style answers when the final tag is missing.
    brace_candidates = re.findall(r"\b[A-Za-z0-9_.-]{0,40}\{[^{}\s]{1,300}\}", text)
    if len(brace_candidates) == 1:
        return [normalize_flag(brace_candidates[0])]
    return []


def check_flag(
    candidate: Any,
    *,
    parent: Any = None,
    cwd: Optional[str] = None,
    source: str = "manual",
) -> Dict[str, Any]:
    context = discover_context(parent=parent, cwd=cwd)
    candidate_text = normalize_flag(candidate)
    if not candidate_text:
        return _public_result(
            status="error",
            correct=False,
            message="missing candidate flag",
            context=context,
        )
    if not context.get("target_id"):
        return _public_result(
            status="unavailable",
            correct=False,
            message="flag oracle unavailable: target_id is not configured",
            context=context,
        )

    try:
        expected = load_expected_answers(context)
    except Exception as exc:
        return _public_result(
            status="error",
            correct=False,
            message=f"flag oracle error: {type(exc).__name__}: {exc}",
            context=context,
        )

    if not expected:
        return _public_result(
            status="unavailable",
            correct=False,
            message="flag oracle unavailable: no expected flag configured for target",
            context=context,
        )

    correct = _candidate_matches(candidate_text, expected)
    max_attempts = _max_attempts()
    attempt_info = record_attempt(
        context,
        candidate_text,
        correct=correct,
        status="correct" if correct else "incorrect",
        source=source,
        max_attempts=max_attempts,
    )
    status = "correct" if correct else "incorrect"
    if not correct and max_attempts and attempt_info["attempt_no"] >= max_attempts:
        status = "attempt_limit_reached"
    return _public_result(
        status=status,
        correct=correct,
        message="flag is correct" if correct else "flag is incorrect",
        context=context,
        attempt_info=attempt_info,
        max_attempts=max_attempts,
    )


def discover_context(*, parent: Any = None, cwd: Optional[str] = None) -> Dict[str, Any]:
    project_root = _first_path(
        getattr(parent, "project_root", None),
        cwd,
        os.getcwd(),
    )
    task_dir = _first_path(getattr(parent, "task_dir", None))
    run_dir = _first_path(
        *[os.environ.get(key) for key in RUN_DIR_ENV_KEYS],
        getattr(parent, "run_dir", None),
        task_dir,
    )
    metadata = _load_first_metadata(run_dir, task_dir, project_root)

    target_id = _first_str(
        *[os.environ.get(key) for key in TARGET_ID_ENV_KEYS],
        getattr(parent, "target_id", None),
        getattr(parent, "ctf_target_id", None),
        _nested_get(metadata, "target", "id"),
        metadata.get("target_id") if isinstance(metadata, dict) else None,
    )
    run_id = _first_str(
        *[os.environ.get(key) for key in RUN_ID_ENV_KEYS],
        getattr(parent, "run_id", None),
        metadata.get("run_id") if isinstance(metadata, dict) else None,
        Path(run_dir).name if run_dir else None,
    )
    return {
        "project_root": str(project_root) if project_root else "",
        "task_dir": str(task_dir) if task_dir else "",
        "run_dir": str(run_dir) if run_dir else "",
        "target_id": target_id,
        "run_id": run_id or "manual",
        "metadata": metadata if isinstance(metadata, dict) else {},
    }


def load_expected_answers(context: Dict[str, Any]) -> List[Dict[str, Any]]:
    target_id = context.get("target_id") or ""
    answers: List[Dict[str, Any]] = []
    for source_path in _oracle_file_candidates(context):
        data = _load_oracle_json(source_path)
        if data is None:
            continue
        entry = _entry_for_target(data, target_id)
        answers.extend(_answers_from_entry(entry, source=str(source_path)))

    metadata = context.get("metadata") or {}
    if metadata:
        answers.extend(_answers_from_entry(metadata, source="metadata"))
        target = metadata.get("target") if isinstance(metadata, dict) else None
        if isinstance(target, dict):
            answers.extend(_answers_from_entry(target, source="metadata.target"))
    return _dedupe_answer_entries(answers)


def record_attempt(
    context: Dict[str, Any],
    candidate: str,
    *,
    correct: bool,
    status: str,
    source: str,
    max_attempts: int = 0,
) -> Dict[str, Any]:
    log_path = _attempt_log_path(context)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    existing = _read_attempt_lines(log_path)
    candidate_hash = _sha256(normalize_flag(candidate))
    duplicate = any(item.get("candidate_sha256") == candidate_hash for item in existing)
    attempt_no = len(existing) + 1
    entry = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "target_id": context.get("target_id") or "",
        "run_id": context.get("run_id") or "manual",
        "attempt_no": attempt_no,
        "candidate_sha256": candidate_hash,
        "candidate_preview": _preview(candidate),
        "correct": bool(correct),
        "status": status,
        "source": source,
        "duplicate": duplicate,
    }
    with log_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")
    _write_summary(context, entry, attempts_total=attempt_no, max_attempts=max_attempts)
    return {
        "attempt_no": attempt_no,
        "attempts_total": attempt_no,
        "duplicate": duplicate,
        "log_path": str(log_path),
        "candidate_preview": entry["candidate_preview"],
    }


def feedback_prompt(result: Dict[str, Any]) -> str:
    status = result.get("status")
    attempt = result.get("attempt_no") or result.get("attempt") or result.get("attempts_total") or "?"
    preview = result.get("candidate_preview") or result.get("candidatePreview") or ""
    rejected = f" Rejected candidate: {preview}." if preview else ""
    if status == "correct":
        return (
            "[Flag Oracle] The submitted flag is correct. "
            f"Attempt count: {attempt}. End the task now."
        )
    if status == "attempt_limit_reached":
        return (
            "[Flag Oracle] The submitted flag is incorrect and the configured attempt limit has been reached. "
            f"Attempt count: {attempt}.{rejected} Stop submitting new candidates. "
            "Produce a concise evidence-chain audit: what evidence supported the rejected flag, which assumption failed, "
            "what contradictory or missing evidence remains, and what exact verification step is needed next. "
            "If the evidence chain is exhausted, summarize the blockage and ask for help instead of guessing."
        )
    if status == "incorrect":
        extra = " This candidate was already tried." if result.get("duplicate") else ""
        return (
            "[Flag Oracle] The submitted flag was rejected. "
            f"Attempt count: {attempt}.{rejected}{extra} Treat this as a failed hypothesis, not as a request to enumerate. "
            "Before any next verify_flag/check_flag or FINAL_ANSWER, perform rejection recovery: "
            "1) identify the exact evidence chain that produced the rejected candidate; "
            "2) name the assumption or transformation that is now suspect; "
            "3) run at least one evidence-producing tool action to confirm or falsify that assumption; "
            "4) only submit a new candidate if it is supported by newly verified evidence. "
            "Do not mutate, enumerate, or guess nearby flag strings."
        )
    return f"[Flag Oracle] {result.get('message') or 'oracle unavailable'}"


def _candidate_matches(candidate: str, expected: Iterable[Dict[str, Any]]) -> bool:
    for item in expected:
        case_sensitive = bool(item.get("case_sensitive", True))
        norm = normalize_flag(candidate, case_sensitive=case_sensitive)
        plain = item.get("plain")
        if plain is not None and norm == normalize_flag(plain, case_sensitive=case_sensitive):
            return True
        digest = item.get("sha256")
        if digest and _sha256(norm) == str(digest).strip().lower():
            return True
    return False


def _answers_from_entry(entry: Any, *, source: str) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    if entry is None:
        return out
    if isinstance(entry, str):
        return [{"plain": entry, "source": source, "case_sensitive": True}]
    if isinstance(entry, list):
        for value in entry:
            out.extend(_answers_from_entry(value, source=source))
        return out
    if not isinstance(entry, dict):
        return out

    case_sensitive = bool(entry.get("case_sensitive", True))
    for key, value in entry.items():
        lower = str(key).lower()
        if lower in FLAG_TEXT_KEYS:
            for text in _flatten_strings(value):
                out.append({"plain": text, "source": source, "case_sensitive": case_sensitive})
        if lower in FLAG_HASH_KEYS:
            for digest in _flatten_strings(value):
                digest = digest.strip().lower()
                if re.fullmatch(r"[0-9a-f]{64}", digest):
                    out.append({"sha256": digest, "source": source, "case_sensitive": case_sensitive})
    return out


def _entry_for_target(data: Any, target_id: str) -> Any:
    if not target_id:
        return None
    if isinstance(data, dict):
        targets = data.get("targets") if isinstance(data.get("targets"), dict) else data
        if isinstance(targets, dict):
            return targets.get(target_id)
        return None
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict) and _first_str(item.get("target_id"), item.get("id")) == target_id:
                return item
    return None


def _oracle_file_candidates(context: Dict[str, Any]) -> List[Path]:
    paths: List[Path] = []
    if os.environ.get("SECHEUR_FLAG_ORACLE_FILE"):
        paths.append(Path(os.environ["SECHEUR_FLAG_ORACLE_FILE"]))
    project_root = Path(context.get("project_root") or ".")
    paths.extend(
        [
            project_root / "eval-runner" / "oracle" / "flags.json",
            project_root / ".secheur-agent" / "oracle" / "flags.json",
            Path("/path/to/eval-runner/oracle/flags.json"),
        ]
    )
    return _dedupe_paths(paths)


def _attempt_log_path(context: Dict[str, Any]) -> Path:
    if os.environ.get("SECHEUR_FLAG_ATTEMPTS_FILE"):
        return Path(os.environ["SECHEUR_FLAG_ATTEMPTS_FILE"])
    run_dir = context.get("run_dir")
    if run_dir:
        return Path(run_dir) / "flag_attempts.jsonl"
    project_root = Path(context.get("project_root") or ".")
    attempts_dir = project_root / "eval-runner" / "oracle" / "attempts"
    return attempts_dir / f"{_safe_name(context.get('run_id') or 'manual')}.jsonl"


def _write_summary(context: Dict[str, Any], entry: Dict[str, Any], *, attempts_total: int, max_attempts: int) -> None:
    summary = {
        "target_id": context.get("target_id") or "",
        "run_id": context.get("run_id") or "manual",
        "flag_attempts_total": attempts_total,
        "flag_verified": bool(entry.get("correct")),
        "flag_correct": bool(entry.get("correct")),
        "last_attempt_no": entry.get("attempt_no"),
        "last_attempt_status": entry.get("status"),
        "last_attempt_ts": entry.get("ts"),
        "max_attempts": max_attempts,
    }
    run_dir = context.get("run_dir")
    if run_dir:
        path = Path(run_dir) / "flag_oracle_summary.json"
    else:
        path = _attempt_log_path(context).with_suffix(".summary.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")


def _public_result(
    *,
    status: str,
    correct: bool,
    message: str,
    context: Dict[str, Any],
    attempt_info: Optional[Dict[str, Any]] = None,
    max_attempts: int = 0,
) -> Dict[str, Any]:
    attempt_info = attempt_info or {}
    result = {
        "status": status,
        "correct": bool(correct),
        "message": message,
        "target_id": context.get("target_id") or "",
        "run_id": context.get("run_id") or "manual",
        "attempt_no": attempt_info.get("attempt_no"),
        "attempts_total": attempt_info.get("attempts_total", 0),
        "candidate_preview": attempt_info.get("candidate_preview", ""),
        "duplicate": bool(attempt_info.get("duplicate", False)),
        "max_attempts": max_attempts,
    }
    if attempt_info.get("log_path"):
        result["attempt_log"] = attempt_info["log_path"]
    return result


def _load_first_metadata(*paths: Optional[Path]) -> Dict[str, Any]:
    for path in paths:
        if not path:
            continue
        p = Path(path)
        if p.is_dir():
            p = p / "metadata.json"
        data = _load_json(p)
        if isinstance(data, dict):
            return data
    return {}


def _load_json(path: Path) -> Any:
    try:
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _load_oracle_json(path: Path) -> Any:
    try:
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError(f"failed to load flag oracle file {path}: {exc}") from exc


def _read_attempt_lines(path: Path) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    if not path.exists():
        return rows
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            item = json.loads(line)
        except Exception:
            continue
        if isinstance(item, dict):
            rows.append(item)
    return rows


def _flatten_strings(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        text = normalize_flag(value)
        return [text] if text else []
    if isinstance(value, (int, float)):
        return [str(value)]
    if isinstance(value, list):
        out: List[str] = []
        for item in value:
            out.extend(_flatten_strings(item))
        return out
    if isinstance(value, dict):
        out: List[str] = []
        for item in value.values():
            out.extend(_flatten_strings(item))
        return out
    return []


def _dedupe(values: Iterable[str]) -> List[str]:
    out: List[str] = []
    seen = set()
    for value in values:
        if value not in seen:
            out.append(value)
            seen.add(value)
    return out


def _dedupe_answer_entries(entries: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    seen = set()
    for item in entries:
        key = (item.get("plain"), item.get("sha256"), item.get("case_sensitive", True))
        if key in seen:
            continue
        if item.get("plain") or item.get("sha256"):
            out.append(item)
            seen.add(key)
    return out


def _dedupe_paths(paths: Iterable[Path]) -> List[Path]:
    out: List[Path] = []
    seen = set()
    for path in paths:
        key = str(path)
        if key not in seen:
            out.append(path)
            seen.add(key)
    return out


def _first_path(*values: Any) -> Optional[Path]:
    for value in values:
        if value:
            return Path(value)
    return None


def _first_str(*values: Any) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""


def _nested_get(data: Any, *keys: str) -> Any:
    cur = data
    for key in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def _sha256(text: str) -> str:
    return hashlib.sha256(str(text).encode("utf-8")).hexdigest()


def _preview(text: str) -> str:
    text = normalize_flag(text)
    if len(text) <= 16:
        return "<redacted>"
    return f"{text[:8]}...{text[-4:]} (len={len(text)})"


def _safe_name(value: Any) -> str:
    text = str(value or "manual")
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", text).strip("_") or "manual"


def _max_attempts() -> int:
    try:
        return max(0, int(os.environ.get("SECHEUR_FLAG_ORACLE_MAX_ATTEMPTS", "0")))
    except ValueError:
        return 0
