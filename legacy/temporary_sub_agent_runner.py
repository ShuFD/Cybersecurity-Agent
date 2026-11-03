from __future__ import annotations

import contextlib
import queue
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable
from xml.sax.saxutils import escape as _xml_escape

from agent_loop import StepOutcome
from runtime_cleanup import cleanup_old_runtime_files


TEMP_SUB_AGENT_WAIT_SECONDS = 6.0
TEMP_SUB_AGENT_STUCK_SECONDS = 30.0


def xml_escape(value: Any) -> str:
    return _xml_escape(str(value), {'"': "&quot;", "'": "&apos;"})


def temp_sub_agent_status(state: str, detail: str = "") -> str:
    label = {
        "created": "已创建",
        "running": "正在工作",
        "waiting": "等待输出",
        "stuck": "可能卡住",
        "completed": "已完成",
        "failed": "失败",
        "cancelled": "已取消",
    }.get(state, state)
    body = detail or label
    return f'<status state="{xml_escape(state)}">{xml_escape(body)}</status>\n'


def configure_temporary_sub_agent(child: Any, payload: dict[str, Any]) -> Any:
    child.allowed_tools = payload.get("allowed_tools")
    if isinstance(payload.get("read_file_state"), dict) or isinstance(payload.get("read_call_state"), dict):
        inherited = type("TemporarySubAgentInheritedState", (), {})()
        inherited.working = {}
        inherited._read_file_state = dict(payload.get("read_file_state") or {})
        inherited._read_call_state = dict(payload.get("read_call_state") or {})
        child.handler = inherited
    return child


def _safe_name(value: Any, fallback: str = "subagent") -> str:
    safe = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in str(value or "")).strip("_")
    return safe or fallback


def _write_sidechain_transcript(
    transcript_root: str | Path | None,
    *,
    temp_id: str,
    agent_name: str,
    task: str,
    prompt: str,
    allowed_tools: Any,
    agent_file: str,
    status: str,
    collected: list[str],
    result: str,
) -> str:
    if not transcript_root:
        return ""
    out_dir = Path(transcript_root) / "temp" / "model_responses"
    out_dir.mkdir(parents=True, exist_ok=True)
    cleanup_old_runtime_files(out_dir, "subagent-*.txt")
    allowed_text = ", ".join(allowed_tools) if isinstance(allowed_tools, list) else str(allowed_tools or "")
    path = out_dir / f"subagent-{_safe_name(agent_name)}-{int(time.time() * 1000)}-{temp_id}.txt"
    text = "\n".join([
        "# Temporary Sub-Agent Transcript",
        "",
        f"id: {temp_id}",
        f"agent: {agent_name}",
        f"task: {task}",
        f"status: {status}",
        f"agent_file: {agent_file}",
        f"allowed_tools: {allowed_text}",
        "",
        "## Master Prompt",
        prompt,
        "",
        "## Agent Output",
        "".join(collected).strip(),
        "",
        "## Final Result",
        result,
        "",
    ])
    path.write_text(text, encoding="utf-8")
    return str(path)


def run_temporary_sub_agent_dialog(
    payload: dict[str, Any],
    child: Any,
    *,
    cancel_requested: Callable[[], bool] | None = None,
    transcript_root: str | Path | None = None,
    wait_seconds: float = TEMP_SUB_AGENT_WAIT_SECONDS,
    stuck_seconds: float = TEMP_SUB_AGENT_STUCK_SECONDS,
):
    payload = dict(payload or {})
    cancel_requested = cancel_requested or (lambda: False)
    temp_id = "tmp-agent-" + uuid.uuid4().hex[:10]
    agent_name = str(payload.get("agent") or "unknown")
    task = str(payload.get("task") or "")
    prompt = str(payload.get("prompt") or task)
    allowed_tools = payload.get("allowed_tools")

    thread = threading.Thread(target=child.run, daemon=True, name=f"TempSubAgent-{temp_id}")
    thread.start()
    display_q = child.put_task(prompt, source=f"temp-subagent:{temp_id}")
    full = ""
    collected: list[str] = []
    status = "running"
    last_output_at = time.time()
    last_status = ""
    message_open = False

    def close_agent_message():
        nonlocal message_open
        if not message_open:
            return ""
        message_open = False
        return "\n</message>\n"

    def open_agent_message():
        nonlocal message_open
        if message_open:
            return ""
        message_open = True
        return '<message role="agent">\n'

    allowed_text = ", ".join(allowed_tools) if isinstance(allowed_tools, list) else str(allowed_tools or "")
    yield (
        f'<temp_sub_agent_dialog id="{xml_escape(temp_id)}" agent="{xml_escape(agent_name)}" '
        f'status="running" source="{xml_escape(payload.get("source", ""))}">\n'
        f'<summary>临时智能体 {xml_escape(agent_name)} 正在工作</summary>\n'
        f'<task>{xml_escape(task)}</task>\n'
        f'<allowed_tools>{xml_escape(allowed_text)}</allowed_tools>\n'
        f'<agent_file>{xml_escape(payload.get("agent_file", ""))}</agent_file>\n'
        f'<message role="master">{xml_escape(prompt)}</message>\n'
        f'{temp_sub_agent_status("running")}'
    )
    try:
        while True:
            if cancel_requested():
                status = "cancelled"
                with contextlib.suppress(Exception):
                    child.abort()
                break
            try:
                item = display_q.get(timeout=1.0)
            except queue.Empty:
                idle = time.time() - last_output_at
                next_status = "stuck" if idle >= stuck_seconds else "waiting"
                if idle >= wait_seconds and next_status != last_status:
                    last_status = next_status
                    detail = f"{int(idle)} 秒没有新输出，子智能体仍在运行。"
                    yield close_agent_message() + temp_sub_agent_status(next_status, detail)
                continue
            if isinstance(item, dict):
                if item.get("next"):
                    text = str(item["next"])
                    collected.append(text)
                    last_output_at = time.time()
                    last_status = "running"
                    yield open_agent_message() + xml_escape(text)
                if "done" in item:
                    full = str(item.get("done") or "")
                    status = "completed"
                    break
            else:
                text = str(item)
                collected.append(text)
                last_output_at = time.time()
                last_status = "running"
                yield open_agent_message() + xml_escape(text)
    except Exception as exc:
        status = "failed"
        full = "\n".join(collected) + f"\n[临时智能体错误] {type(exc).__name__}: {exc}"
    finally:
        if status not in {"completed", "cancelled"} and getattr(child, "is_running", False):
            with contextlib.suppress(Exception):
                child.abort()
    if not full:
        full = "".join(collected).strip()
    transcript_path = _write_sidechain_transcript(
        transcript_root,
        temp_id=temp_id,
        agent_name=agent_name,
        task=task,
        prompt=prompt,
        allowed_tools=allowed_tools,
        agent_file=str(payload.get("agent_file", "")),
        status=status,
        collected=collected,
        result=full,
    )
    yield close_agent_message()
    final_detail = {
        "completed": "临时智能体已完成。",
        "failed": "临时智能体执行失败。",
        "cancelled": "临时智能体已取消。",
    }.get(status, status)
    yield temp_sub_agent_status(status, final_detail)
    yield "</temp_sub_agent_dialog>\n"
    next_prompt = (
        f"[Sub-Agent:{agent_name}] 临时智能体已{('完成' if status == 'completed' else status)}。"
        "请吸收下面的返回并继续原任务。\n\n"
        f"{full}"
    )
    return StepOutcome(
        {
            "status": status,
            "agent": agent_name,
            "task": task,
            "prompt": prompt,
            "result": full,
            "temp_agent_id": temp_id,
            "source": payload.get("source", ""),
            "agent_file": payload.get("agent_file", ""),
            "allowed_tools": allowed_tools,
            "transcript_path": transcript_path,
        },
        next_prompt=next_prompt,
    )
