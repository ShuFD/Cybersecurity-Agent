import ast
import glob
import json
import os
import re
import warnings
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from runtime_session_log import (
    legacy_session_log_sidecar_path,
    SessionCompactBoundary,
    SessionLogEvent,
    read_recoverable_session_records,
    read_session_records,
    session_log_sidecar_path,
)


PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_LOG_DIR = PROJECT_ROOT / "temp" / "model_responses"
_BLOCK_RE = re.compile(
    r"^=== (Prompt|Response) ===.*?\n(.*?)(?=^=== (?:Prompt|Response) ===|\Z)",
    re.DOTALL | re.MULTILINE,
)
_HISTORY_RE = re.compile(r"<history>(.*?)</history>", re.DOTALL)


class SessionResumeError(Exception):
    pass


@dataclass(frozen=True)
class SessionLog:
    path: Path
    mtime: float
    size: int


@dataclass(frozen=True)
class RestoredSession:
    path: Path
    history: list


@dataclass(frozen=True)
class RestorableSession:
    path: Path
    mtime: float
    size: int
    message_count: int
    preview: str


def _session_jsonl_dirs(base):
    candidates = []
    if base.name == "model_responses":
        candidates.append(base.parent / "sessions")
    if base.name == "sessions":
        candidates.append(base)
    else:
        candidates.append(base / "sessions")
    unique = []
    seen = set()
    for path in candidates:
        key = str(path)
        if key not in seen:
            seen.add(key)
            unique.append(path)
    return unique


def list_session_logs(log_dir=None, limit=10):
    base = Path(log_dir) if log_dir is not None else DEFAULT_LOG_DIR
    logs = []
    candidates = list(glob.glob(str(base / "model_responses*.txt")))
    for session_dir in _session_jsonl_dirs(base):
        candidates.extend(glob.glob(str(session_dir / "*.jsonl")))
    for raw in candidates:
        path = Path(raw)
        try:
            st = path.stat()
        except OSError:
            continue
        if st.st_size <= 0:
            continue
        logs.append(SessionLog(path=path, mtime=st.st_mtime, size=st.st_size))
    logs.sort(key=lambda item: item.mtime, reverse=True)
    return logs[: max(0, int(limit or 0))]


def _preferred_restorable_path(path):
    path = Path(path)
    if path.suffix == ".jsonl":
        return path
    for candidate in _structured_log_paths(path):
        if candidate.exists():
            return candidate
    return path


def _read_text(path):
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise SessionResumeError(f"Cannot read session log: {path}") from exc


def extract_last_history_block(path):
    content = _read_text(path).replace("\\\\n", "\n").replace("\\n", "\n")
    matches = _HISTORY_RE.findall(content)
    return matches[-1].strip() if matches else ""


def _prompt_response_pairs(content):
    pairs = []
    pending = None
    for label, body in _BLOCK_RE.findall(content or ""):
        if label == "Prompt":
            pending = body.strip()
        elif pending is not None:
            pairs.append((pending, body.strip()))
            pending = None
    return pairs


def _parse_native_history(content):
    history = []
    for prompt_body, response_body in _prompt_response_pairs(content):
        try:
            user_msg = json.loads(prompt_body)
            try:
                response_blocks = json.loads(response_body)
            except json.JSONDecodeError:
                warnings.warn(
                    "Restoring legacy repr response blocks with ast.literal_eval; JSON response logs are preferred.",
                    RuntimeWarning,
                    stacklevel=2,
                )
                response_blocks = ast.literal_eval(response_body)
        except Exception:
            return []
        if not isinstance(user_msg, dict) or user_msg.get("role") != "user":
            return []
        if not isinstance(response_blocks, list):
            return []
        history.append(user_msg)
        history.append({"role": "assistant", "content": response_blocks})
    return history


def _history_block_to_message(history_block):
    return {
        "role": "user",
        "content": [
            {
                "type": "text",
                "text": "### [RESTORED SESSION]\n<history>\n" + history_block.strip() + "\n</history>",
            }
        ],
    }


def _message_from_structured_record(record):
    event = SessionLogEvent.from_record(record)
    if event.role not in {"user", "assistant"}:
        return None
    return {"role": event.role, "content": event.content}


def _compact_boundary_message():
    return {
        "role": "user",
        "content": [
            {
                "type": "text",
                "text": (
                    "<system-reminder>\n"
                    "compact boundary: use the next compact summary for earlier conversation history.\n"
                    "</system-reminder>"
                ),
            }
        ],
        "is_compact_boundary": True,
    }


def _sequential_messages_from_records(records):
    history = []
    for record in records:
        if record.get("type") == "compact_boundary":
            continue
        try:
            message = _message_from_structured_record(record)
        except (ValueError, TypeError):
            continue
        if message is not None:
            history.append(message)
    return history


def _message_chain_from_uuid(records, start_uuid, stop_uuid=""):
    if not start_uuid:
        return []
    by_uuid = {}
    children_by_parent = {}
    for index, record in enumerate(records):
        if (record.get("type") or "message") != "message":
            continue
        record_uuid = str(record.get("uuid") or "")
        if not record_uuid:
            continue
        by_uuid[record_uuid] = record
        parent_uuid = str(record.get("parent_uuid") or "")
        if parent_uuid:
            children_by_parent.setdefault(parent_uuid, []).append((index, record))

    stop_uuid = str(stop_uuid or "")
    if stop_uuid:
        current_uuid = stop_uuid
        seen = set()
        reversed_records = []
        while current_uuid and current_uuid not in seen:
            record = by_uuid.get(current_uuid)
            if record is None:
                break
            seen.add(current_uuid)
            reversed_records.append(record)
            if current_uuid == str(start_uuid):
                chain = []
                for item in reversed(reversed_records):
                    try:
                        message = _message_from_structured_record(item)
                    except (ValueError, TypeError):
                        return []
                    if message is not None:
                        chain.append(message)
                return chain
            current_uuid = str(record.get("parent_uuid") or "")

    current_uuid = str(start_uuid)
    seen = set()
    chain = []
    while current_uuid and current_uuid not in seen:
        record = by_uuid.get(current_uuid)
        if record is None:
            break
        seen.add(current_uuid)
        try:
            message = _message_from_structured_record(record)
        except (ValueError, TypeError):
            break
        if message is not None:
            chain.append(message)
        if stop_uuid and current_uuid == stop_uuid:
            break
        children = children_by_parent.get(current_uuid) or []
        if not children:
            break
        _, child = min(children, key=lambda item: item[0])
        current_uuid = str(child.get("uuid") or "")
    return chain


def _message_chain_after_parent(records, parent_uuid):
    if not parent_uuid:
        return []
    for record in records:
        if (record.get("type") or "message") != "message":
            continue
        if str(record.get("parent_uuid") or "") == str(parent_uuid):
            return _message_chain_from_uuid(records, record.get("uuid"))
    return []


def _messages_from_last_compact_boundary(records, boundary_index):
    boundary = SessionCompactBoundary.from_record(records[boundary_index])
    history = [_compact_boundary_message(), {
        "role": "user",
        "content": boundary.summary_content,
        "is_compact_summary": True,
    }]

    before_boundary = records[:boundary_index]
    kept_messages = _message_chain_from_uuid(
        before_boundary,
        boundary.kept_from_uuid,
        boundary.parent_uuid,
    )
    if not kept_messages and boundary.kept_from_turn_id:
        kept_messages = _sequential_messages_from_records([
            record for record in before_boundary
            if int(record.get("turn_id") or 0) >= boundary.kept_from_turn_id
        ])
    history.extend(kept_messages)

    after_boundary = records[boundary_index + 1:]
    post_boundary_messages = _message_chain_after_parent(after_boundary, boundary.uuid)
    if not post_boundary_messages:
        post_boundary_messages = _sequential_messages_from_records(after_boundary)
    history.extend(post_boundary_messages)
    return history


def _structured_log_paths(path):
    candidates = [session_log_sidecar_path(path), legacy_session_log_sidecar_path(path)]
    unique = []
    seen = set()
    for candidate in candidates:
        candidate = Path(candidate)
        key = str(candidate)
        if key not in seen:
            seen.add(key)
            unique.append(candidate)
    return unique


def _restore_history_from_structured_path(structured_path):
    try:
        records = list(read_session_records(structured_path))
    except ValueError:
        records = list(read_recoverable_session_records(structured_path))
    if not records:
        return None
    try:
        last_boundary_index = -1
        for index, record in enumerate(records):
            if record.get("type") == "compact_boundary":
                try:
                    SessionCompactBoundary.from_record(record)
                except (ValueError, TypeError):
                    continue
                last_boundary_index = index
        if last_boundary_index >= 0:
            history = _messages_from_last_compact_boundary(records, last_boundary_index)
        else:
            history = _sequential_messages_from_records(records)
    except ValueError as exc:
        raise SessionResumeError(f"Cannot restore structured session log: {structured_path}") from exc
    return history or None


def _restore_history_from_structured_log_with_path(path):
    for structured_path in _structured_log_paths(path):
        if structured_path.exists():
            try:
                history = _restore_history_from_structured_path(structured_path)
            except SessionResumeError:
                continue
            if history is not None:
                return history, structured_path
    return None, None


def _restore_history_from_structured_log(path):
    history, _ = _restore_history_from_structured_log_with_path(path)
    return history


def _restore_history_from_log_with_path(path):
    path = Path(path)
    structured_history, structured_path = _restore_history_from_structured_log_with_path(path)
    if structured_history is not None:
        return structured_history, structured_path
    content = _read_text(path)
    native_history = _parse_native_history(content)
    if native_history:
        return native_history, path
    history_block = extract_last_history_block(path)
    if history_block:
        return [_history_block_to_message(history_block)], path
    raise SessionResumeError(f"No recoverable history found in {path}")


def restore_history_from_log(path):
    history, _ = _restore_history_from_log_with_path(path)
    return history


def restore_latest_history(log_dir=None, limit=10):
    last_error = None
    for log in list_session_logs(log_dir=log_dir, limit=limit):
        try:
            history, source_path = _restore_history_from_log_with_path(log.path)
            return RestoredSession(path=source_path, history=history)
        except SessionResumeError as exc:
            last_error = exc
    detail = f": {last_error}" if last_error else ""
    raise SessionResumeError(f"No recoverable session logs found{detail}")


def _message_text(message):
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict):
            text = block.get("text")
            if text is None:
                text = block.get("content")
            if isinstance(text, str):
                parts.append(text)
    return "\n".join(parts)


def _clean_preview(text, max_chars=140):
    text = str(text or "").replace("### [RESTORED SESSION]", " ")
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > max_chars:
        return text[: max(0, max_chars - 3)].rstrip() + "..."
    return text


def _history_preview(history):
    candidates = []
    for message in history or []:
        if not isinstance(message, dict) or message.get("is_compact_boundary"):
            continue
        if message.get("role") == "user":
            candidates.append(message)
    if not candidates:
        candidates = [message for message in (history or []) if isinstance(message, dict)]
    for message in candidates:
        preview = _clean_preview(_message_text(message))
        if preview:
            return preview
    return ""


def list_restorable_sessions(log_dir=None, limit=10):
    try:
        limit = max(0, int(limit or 0))
    except (TypeError, ValueError):
        limit = 10
    if limit <= 0:
        return []
    candidates = list_session_logs(log_dir=log_dir, limit=max(limit * 3, limit))
    sessions = []
    seen = set()
    for log in candidates:
        try:
            history, source_path = _restore_history_from_log_with_path(log.path)
        except SessionResumeError:
            continue
        display_path = source_path
        key = str(display_path.resolve())
        if key in seen:
            continue
        try:
            display_stat = display_path.stat()
            display_mtime = display_stat.st_mtime
            display_size = display_stat.st_size
        except OSError:
            display_mtime = log.mtime
            display_size = log.size
        seen.add(key)
        sessions.append(RestorableSession(
            path=display_path,
            mtime=display_mtime,
            size=display_size,
            message_count=len(history),
            preview=_history_preview(history),
        ))
        if len(sessions) >= limit:
            break
    return sessions


def format_resume_list(log_dir=None, limit=10):
    sessions = list_restorable_sessions(log_dir=log_dir, limit=limit)
    if not sessions:
        return "[Resume] 没有找到可恢复会话。"
    lines = ["[Resume] 最近可恢复会话："]
    for index, session in enumerate(sessions, start=1):
        mtime = datetime.fromtimestamp(session.mtime).strftime("%Y-%m-%d %H:%M:%S")
        lines.append(f"{index}. {session.path}（{session.message_count} 条消息，{mtime}）")
        if session.preview:
            lines.append(f"   {session.preview}")
    lines.append("使用 `/resume <path>` 恢复指定会话；使用 `/resume` 恢复最新可用会话。")
    return "\n".join(lines)
