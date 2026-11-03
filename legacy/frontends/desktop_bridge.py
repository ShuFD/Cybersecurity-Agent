#!/usr/bin/env python3
"""
SecHeur Agent desktop bridge.

Clear split:
1) AgentManager: owns agent instances, sessions and histories.
2) Transport: HTTP is the command/data channel; WebSocket only pushes small
   session-state notifications.

HTTP API:
  GET    /status
  GET    /config
  POST   /config
  GET    /model-profiles
  GET    /sessions
  POST   /session/new
  GET    /session/{sid}
  DELETE /session/{sid}
  POST   /session/{sid}/prompt
  GET    /session/{sid}/messages?after=0&limit=200
  POST   /session/{sid}/cancel

WS API:
  GET /ws -> events only, e.g.
  {"type":"session-state","sessionId":"sess-...","state":"running","seq":3,"updatedAt":...}
"""
from __future__ import annotations

import asyncio, contextlib, importlib, json, math, os, re, sys
import threading, time, traceback, uuid
from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set
from aiohttp import web, WSMsgType, ClientSession, ClientTimeout
from urllib.parse import urlparse

APP_DIR = Path(__file__).resolve().parent
PROJECT_DIR = APP_DIR.parent
if str(PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(PROJECT_DIR))

from flag_oracle_client import FlagOracleClient, FlagOracleConfig, FlagOracleError
from temporary_sub_agent_runner import configure_temporary_sub_agent, run_temporary_sub_agent_dialog

try:
    from frontends.desktop_settings import (
        build_registry,
        delete_api_config,
        delete_project_agent,
        delete_project_mcp_server,
        delete_project_skill,
        load_api_config,
        save_api_config,
        resolve_api_fetch_config,
        save_mcp_server,
        save_project_agent,
        save_project_skill,
        save_registry_state,
    )
except Exception:
    from desktop_settings import (
        build_registry,
        delete_api_config,
        delete_project_agent,
        delete_project_mcp_server,
        delete_project_skill,
        load_api_config,
        save_api_config,
        resolve_api_fetch_config,
        save_mcp_server,
        save_project_agent,
        save_project_skill,
        save_registry_state,
    )
from registry_state import STATE_DIR_NAME, disabled_names
from permission_guard import PERMISSION_MODES
from skill_registry import project_skill_dirs


def find_default_project_root() -> Path:
    candidates = [
        APP_DIR / "..",
        APP_DIR / ".." / "..",
        APP_DIR / ".." / "SecHeur Agent",
        APP_DIR / ".." / ".." / "SecHeur Agent",
    ]
    for p in candidates:
        root = p.resolve()
        if (root / "agentmain.py").exists():
            return root
    return APP_DIR.parent.parent.resolve()


def _env_positive_int(name: str, default: int) -> int:
    try:
        parsed = int(os.environ.get(name, ""))
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


DEFAULT_PROJECT_ROOT = find_default_project_root()
DESKTOP_CONFIG_FILE_NAME = "desktop-config.json"
DESKTOP_SESSIONS_FILE_NAME = "desktop-sessions.json"
TEMP_SUB_AGENT_WAIT_SECONDS = 6.0
TEMP_SUB_AGENT_STUCK_SECONDS = 30.0
AGENT_FIRST_OUTPUT_TIMEOUT_SECONDS = _env_positive_int("SECHEUR_AGENT_FIRST_OUTPUT_TIMEOUT", 120)
AGENT_OUTPUT_IDLE_TIMEOUT_SECONDS = _env_positive_int("SECHEUR_AGENT_OUTPUT_IDLE_TIMEOUT", 600)
API_TEST_PROMPT = "只回复 OK，用于测试 API 是否可用。"
API_TEST_MAX_TOKENS = 64
SCHEDULER_SESSION_TITLE = "定时任务"
SCHEDULER_POLLER_KEY = web.AppKey("scheduler_poller", Any)
SCHEDULER_TASK_KEY = web.AppKey("scheduler_task", asyncio.Task)
PLAN_APPROVED_ANSWERS = {"批准", "允许", "同意", "是", "yes", "y", "ok", "approve", "approved", "allow"}


def _optional_positive_int(value):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _optional_positive_float(value):
    if value in ("", None):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) and parsed > 0 else None


def _normalize_session_allowed_prompts(value):
    if not isinstance(value, list):
        return []
    allowed = []
    for item in value:
        if not isinstance(item, dict):
            continue
        tool = str(item.get("tool") or "Bash").strip() or "Bash"
        prompt = str(item.get("prompt") or "").strip()
        if tool == "Bash" and prompt:
            allowed.append({"tool": tool, "prompt": prompt})
    return allowed


def _approved_prompts_for_permission(tool_name: str, args: dict, allowed_prompts: list) -> list:
    if tool_name != "code_run":
        return []
    code_type = str((args or {}).get("type") or "").strip().lower()
    if code_type not in {"bash", "sh", "shell"}:
        return []
    return [item for item in _normalize_session_allowed_prompts(allowed_prompts) if item.get("tool") == "Bash"]


def _format_approved_prompt_detail(detail: str, allowed_prompts: list) -> str:
    allowed_prompts = _normalize_session_allowed_prompts(allowed_prompts)
    detail = str(detail or "")
    if not allowed_prompts:
        return detail
    lines = [f"- {item.get('tool', 'Bash')}(prompt: {item.get('prompt', '')})" for item in allowed_prompts]
    note = "计划已批准的语义权限（匹配的非破坏测试命令可自动放行）：\n" + "\n".join(lines)
    if note in detail:
        return detail
    return f"{detail}\n\n{note}" if detail else note


def _permission_decision_allowed(tool_name: str, decision: str, answer: str = "") -> bool:
    if decision in {"allow_once", "allow_session"}:
        return True
    if decision != "answer":
        return False
    if tool_name != "exit_plan_mode":
        return True
    return answer.strip().lower() in PLAN_APPROVED_ANSWERS


def desktop_config_path(root: Path | str) -> Path:
    return Path(root) / STATE_DIR_NAME / DESKTOP_CONFIG_FILE_NAME


def desktop_sessions_path(root: Path | str) -> Path:
    return Path(root) / STATE_DIR_NAME / DESKTOP_SESSIONS_FILE_NAME


def load_desktop_config(root: Path | str) -> Dict[str, Any]:
    path = desktop_config_path(root)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def save_desktop_config(root: Path | str, config: Dict[str, Any]) -> Dict[str, Any]:
    path = desktop_config_path(root)
    safe_config = dict(config) if isinstance(config, dict) else {}
    if not safe_config:
        with contextlib.suppress(FileNotFoundError):
            path.unlink()
        return {}
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(safe_config, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)
    return safe_config


def xml_escape(value: Any) -> str:
    return (
        str(value or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


_BLACKBOARD_TAG_RE = re.compile(r"<[^>]+>")
_BLACKBOARD_WS_RE = re.compile(r"\s+")
_BLACKBOARD_LLM_RUNNING_RE = re.compile(r"\**LLM Running \(Turn \d+\) \.\.\.\**", re.IGNORECASE)
_BLACKBOARD_CODE_FENCE_RE = re.compile(r"`{3,}[\s\S]*?`{3,}")
_BLACKBOARD_TABLE_RULE_RE = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$")


def _blackboard_clean_text(value: Any, fallback: str = "") -> str:
    text = strip_goal_plan_blocks(str(value or ""))
    text = re.sub(r"<think>[\s\S]*?</think>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"<summary>\s*([\s\S]*?)\s*</summary>", r"\1", text, flags=re.IGNORECASE)
    text = _BLACKBOARD_TAG_RE.sub(" ", text)
    text = _blackboard_strip_markdown(text)
    text = _BLACKBOARD_WS_RE.sub(" ", text).strip()
    return text or fallback


def _blackboard_strip_markdown(value: Any) -> str:
    text = str(value or "")
    text = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"(^|\s)[*_]{1,3}([^*_]+)[*_]{1,3}(\s|$)", r"\1\2\3", text)
    text = text.replace("**", "").replace("__", "").replace("`", "")
    return text


def _blackboard_remove_internal_lines(text: str) -> str:
    kept: list[str] = []
    for line in str(text or "").splitlines():
        stripped = line.strip()
        if not stripped:
            kept.append("")
            continue
        if _BLACKBOARD_LLM_RUNNING_RE.fullmatch(stripped):
            continue
        if _BLACKBOARD_TABLE_RULE_RE.match(stripped):
            continue
        if re.match(r"^(🛠️\s*)?Tool\s*:", stripped, flags=re.IGNORECASE):
            continue
        if re.match(r"^(📥\s*)?args\s*:", stripped, flags=re.IGNORECASE):
            continue
        if re.match(r"^\[(Action|Status|Stdout|Stderr|Info|omitted)\b", stripped, flags=re.IGNORECASE):
            continue
        if stripped.startswith("``"):
            continue
        kept.append(line)
    return "\n".join(kept)


def _blackboard_user_visible_text(value: Any, fallback: str = "") -> str:
    raw = strip_goal_plan_blocks(str(value or ""))
    if not raw.strip():
        return fallback

    parts = _BLACKBOARD_LLM_RUNNING_RE.split(raw)
    candidates = parts[1:] if len(parts) > 1 else [raw]
    for candidate in reversed(candidates):
        text = _blackboard_clean_user_visible_candidate(candidate)
        if text:
            return text
    return _blackboard_clean_user_visible_candidate(raw) or fallback


def _blackboard_clean_user_visible_candidate(value: Any) -> str:
    text = str(value or "")
    text = re.sub(r"<summary>[\s\S]*?</summary>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"<think>[\s\S]*?</think>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"<function_calls\b[^>]*>[\s\S]*?</function_calls>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"<function_results\b[^>]*>[\s\S]*?</function_results>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"<invoke\b[^>]*>[\s\S]*?</invoke>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"<result\b[^>]*>[\s\S]*?</result>", " ", text, flags=re.IGNORECASE)
    text = _BLACKBOARD_CODE_FENCE_RE.sub(" ", text)
    text = re.sub(r"`{3,}[\s\S]*$", " ", text)
    text = _blackboard_remove_internal_lines(text)
    text = _BLACKBOARD_TAG_RE.sub(" ", text)
    text = _blackboard_strip_markdown(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _blackboard_summary(value: Any, fallback: str = "", limit: int = 180) -> str:
    text = _blackboard_clean_text(value, fallback)
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def _blackboard_assistant_summary(value: Any, fallback: str = "", limit: int = 180) -> str:
    text = _blackboard_user_visible_text(value, fallback)
    text = _BLACKBOARD_WS_RE.sub(" ", text).strip() or fallback
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def _blackboard_timestamp(msg: dict, fallback: float) -> float:
    try:
        value = float(msg.get("ts") or 0)
    except (TypeError, ValueError):
        value = 0
    return value if value > 0 else fallback


def _blackboard_intent_status(msg: dict) -> str:
    if msg.get("partial"):
        return "running"
    role = msg.get("role")
    if role == "error":
        return "failed"
    if role == "permission" and msg.get("status") not in {"resolved", "done"}:
        return "running"
    return "concluded"


def strip_goal_plan_blocks(text: str) -> str:
    return re.sub(
        r"<!--\s*secheur:goal-plan\s*-->[\s\S]*?<!--\s*/secheur:goal-plan\s*-->",
        "",
        str(text or ""),
        flags=re.IGNORECASE,
    ).strip()


def build_session_blackboard_graph(sess: "Session") -> dict:
    messages = list(sess.messages or [])
    if sess.partial:
        partial = dict(sess.partial)
        partial["partial"] = True
        messages.append(partial)

    first_user = next((msg for msg in messages if msg.get("role") == "user"), None)
    origin_text = _blackboard_summary(
        first_user.get("content") if first_user else "",
        "等待用户目标",
        240,
    )
    goal_text = f"完成用户目标：{origin_text}" if first_user else "等待明确目标"

    facts = [
        {
            "id": "origin",
            "description": origin_text,
            "sourceMessageId": first_user.get("id") if first_user else None,
            "createdAt": _blackboard_timestamp(first_user or {}, sess.created_at),
            "kind": "origin",
        },
        {
            "id": "goal",
            "description": goal_text,
            "sourceMessageId": first_user.get("id") if first_user else None,
            "createdAt": _blackboard_timestamp(first_user or {}, sess.created_at),
            "kind": "goal",
        },
    ]
    intents: list[dict] = []
    hints: list[dict] = []
    last_fact_id = "origin"
    fact_index = 1
    intent_index = 1
    first_user_seen = False

    for msg in messages:
        role = msg.get("role")
        mid = msg.get("id")
        created_at = _blackboard_timestamp(msg, sess.created_at)
        if role == "user":
            if not first_user_seen:
                first_user_seen = True
                continue
            content = _blackboard_summary(msg.get("content"), "用户补充", 220)
            hints.append({
                "id": f"h{len(hints) + 1:03d}",
                "content": content,
                "creator": msg.get("source") or "user",
                "sourceMessageId": mid,
                "createdAt": created_at,
            })
            continue

        if role == "permission":
            description = _blackboard_summary(
                msg.get("title") or msg.get("content"),
                "权限确认",
                180,
            )
            status = _blackboard_intent_status(msg)
            intents.append({
                "id": f"i{intent_index:03d}",
                "from": [last_fact_id],
                "to": None,
                "description": description,
                "creator": "desktop.permission",
                "worker": msg.get("tool_name") or msg.get("toolName") or "permission",
                "status": status,
                "sourceMessageId": mid,
                "createdAt": created_at,
                "concludedAt": created_at if status == "concluded" else None,
            })
            intent_index += 1
            continue

        if role not in {"assistant", "error", "system"}:
            continue

        if role == "assistant":
            content = _blackboard_assistant_summary(
                msg.get("content"),
                "Agent 正在探索" if msg.get("partial") else "Agent 产出结果",
                260,
            )
        else:
            content = _blackboard_summary(
                msg.get("content"),
                "Agent 正在探索" if msg.get("partial") else "Agent 产出结果",
                260,
            )
        status = _blackboard_intent_status(msg)
        intent_id = f"i{intent_index:03d}"
        intent_index += 1
        if status == "running":
            intents.append({
                "id": intent_id,
                "from": [last_fact_id],
                "to": None,
                "description": content,
                "creator": "secheur.agent",
                "worker": "SecHeur Agent",
                "status": status,
                "sourceMessageId": mid,
                "createdAt": created_at,
                "concludedAt": None,
            })
            continue

        if role == "error":
            description = content
            kind = "error"
        elif role == "system":
            description = content
            kind = "system"
        else:
            description = content
            kind = "fact"
        fact_id = f"f{fact_index:03d}"
        fact_index += 1
        facts.append({
            "id": fact_id,
            "description": description,
            "sourceMessageId": mid,
            "createdAt": created_at,
            "kind": kind,
        })
        intents.append({
            "id": intent_id,
            "from": [last_fact_id],
            "to": fact_id,
            "description": "记录 Agent 已确认结果" if role == "assistant" else "记录运行状态",
            "creator": "secheur.agent",
            "worker": "SecHeur Agent",
            "status": status,
            "sourceMessageId": mid,
            "createdAt": created_at,
            "concludedAt": created_at,
        })
        last_fact_id = fact_id

    running_intents = [intent for intent in intents if intent.get("status") == "running"]
    return {
        "project": {
            "id": sess.id,
            "title": sess.title,
            "status": sess.status,
            "origin": origin_text,
            "goal": goal_text,
            "reason": {
                "worker": "SecHeur Agent",
                "trigger": "active_turn",
                "startedAt": sess.partial.get("ts") if sess.partial else sess.updated_at,
            } if sess.status == "running" else None,
        },
        "facts": facts,
        "intents": intents,
        "hints": hints,
        "summary": {
            "factCount": len(facts),
            "intentCount": len(intents),
            "hintCount": len(hints),
            "runningIntentCount": len(running_intents),
            "openIntentCount": len([intent for intent in intents if not intent.get("to")]),
        },
    }

for _s in (sys.stdout, sys.stderr):
    with contextlib.suppress(Exception):
        _s.reconfigure(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Agent management layer
# ---------------------------------------------------------------------------

@dataclass
class Session:
    id: str
    title: str = "New chat"
    cwd: str = ""
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    messages: List[dict] = field(default_factory=list)
    msg_seq: int = 0
    partial: Optional[dict] = None
    status: str = "idle"  # idle|running|error|cancelled
    agent: Any = None
    agent_poisoned: bool = False
    turn_generation: int = 0
    active_turn_id: int = 0
    llm_no: int = 0
    permission_mode: str = "default"
    memory_reference_enabled: bool = True
    web_verbs_enabled: bool = False
    thread: Optional[threading.Thread] = None
    cancel_requested: bool = False
    last_error: str = ""
    permission_requests: Dict[str, dict] = field(default_factory=dict)
    permission_events: Dict[str, threading.Event] = field(default_factory=dict)
    permission_decisions: Dict[str, str] = field(default_factory=dict)
    permission_session_allows: Set[str] = field(default_factory=set)
    approved_plan_allowed_prompts: List[dict] = field(default_factory=list)
    queued_prompts: List[dict] = field(default_factory=list)
    runtime_events: List[dict] = field(default_factory=list)


class AgentManager:
    def __init__(self, project_root: Optional[Path | str] = None):
        self.lock = threading.RLock()
        self._project_root = str(Path(project_root or DEFAULT_PROJECT_ROOT))
        self.config: Dict[str, Any] = load_desktop_config(self._project_root)
        self.sessions: Dict[str, Session] = {}
        self.active_session_id: Optional[str] = None
        self.load_sessions()

    @property
    def project_root(self) -> str:
        return self._project_root

    @project_root.setter
    def project_root(self, value: Path | str):
        with self.lock:
            self._project_root = str(Path(value))
            self.config = load_desktop_config(self._project_root)
            self.sessions = {}
            self.active_session_id = None
            self.load_sessions()

    @property
    def mykey_path(self) -> str:
        return str(Path(self.project_root) / "mykey.py")

    def reload_config(self) -> Dict[str, Any]:
        self.config = load_desktop_config(self.project_root)
        return self.config

    def save_sessions(self) -> bool:
        path = desktop_sessions_path(self.project_root)
        with self.lock:
            payload = {
                "version": 1,
                "activeSessionId": self.active_session_id,
                "sessions": [
                    {
                        "id": sess.id,
                        "title": sess.title,
                        "cwd": sess.cwd,
                        "createdAt": sess.created_at,
                        "updatedAt": sess.updated_at,
                        "messages": deepcopy(sess.messages),
                        "msgSeq": sess.msg_seq,
                        "status": sess.status,
                        "llmNo": sess.llm_no,
                        "permissionMode": sess.permission_mode,
                        "memoryReferenceEnabled": sess.memory_reference_enabled,
                        "webVerbsEnabled": sess.web_verbs_enabled,
                        "lastError": sess.last_error,
                        "runtimeEvents": deepcopy(sess.runtime_events),
                    }
                    for sess in self.sessions.values()
                ],
            }
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True, default=str) + "\n",
                encoding="utf-8",
            )
            tmp.replace(path)
            return True
        except OSError as exc:
            print(f"save desktop sessions failed: {exc}", file=sys.stderr)
            return False

    def load_sessions(self) -> None:
        path = desktop_sessions_path(self.project_root)
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            return
        if not isinstance(payload, dict):
            return
        raw_sessions = payload.get("sessions")
        if isinstance(raw_sessions, dict):
            raw_sessions = list(raw_sessions.values())
        if not isinstance(raw_sessions, list):
            return
        restored: Dict[str, Session] = {}
        for item in raw_sessions:
            if not isinstance(item, dict):
                continue
            sid = str(item.get("id") or item.get("sessionId") or "").strip()
            if not sid:
                continue
            messages = [dict(message) for message in item.get("messages") or [] if isinstance(message, dict)]
            for message in messages:
                if message.get("queued_status") == "queued":
                    message["queued_status"] = "cancelled"
                if message.get("role") == "permission" and message.get("status") == "pending":
                    message["status"] = "resolved"
                    message["decision"] = "deny"
                    message["decision_label"] = "已拒绝"
            message_ids = []
            for message in messages:
                try:
                    message_ids.append(int(message.get("id") or 0))
                except (TypeError, ValueError):
                    continue
            try:
                msg_seq = max(int(item.get("msgSeq") or 0), max(message_ids, default=0))
            except (TypeError, ValueError):
                msg_seq = max(message_ids, default=0)
            try:
                created_at = float(item.get("createdAt") or time.time())
            except (TypeError, ValueError):
                created_at = time.time()
            try:
                updated_at = float(item.get("updatedAt") or created_at)
            except (TypeError, ValueError):
                updated_at = created_at
            try:
                llm_no = max(0, int(item.get("llmNo") or 0))
            except (TypeError, ValueError):
                llm_no = 0
            permission_mode = str(item.get("permissionMode") or "default")
            if permission_mode not in PERMISSION_MODES:
                permission_mode = "default"
            restored[sid] = Session(
                id=sid,
                title=str(item.get("title") or "New chat"),
                cwd=str(item.get("cwd") or self.project_root),
                created_at=created_at,
                updated_at=updated_at,
                messages=messages,
                msg_seq=msg_seq,
                status="idle",
                llm_no=llm_no,
                permission_mode=permission_mode,
                memory_reference_enabled=item.get("memoryReferenceEnabled") is not False,
                web_verbs_enabled=item.get("webVerbsEnabled") is True,
                last_error=str(item.get("lastError") or ""),
                runtime_events=[
                    dict(event) for event in item.get("runtimeEvents") or [] if isinstance(event, dict)
                ],
            )
        with self.lock:
            self.sessions = restored
            active_id = str(payload.get("activeSessionId") or "")
            self.active_session_id = active_id if active_id in restored else next(iter(restored), None)

    def save_config(self, cfg: Dict[str, Any]) -> Dict[str, Any]:
        self.config = dict(cfg)
        save_desktop_config(self.project_root, self.config)
        self.sync_runtime_config()
        return self.config

    def custom_skill_dirs(self):
        return self.config.get("customSkillDirectories") or ""

    def agent_first_output_timeout_seconds(self) -> int:
        return _optional_positive_int(self.config.get("agentFirstOutputTimeoutSeconds")) or AGENT_FIRST_OUTPUT_TIMEOUT_SECONDS

    def agent_output_idle_timeout_seconds(self) -> int:
        return _optional_positive_int(self.config.get("agentOutputIdleTimeoutSeconds")) or AGENT_OUTPUT_IDLE_TIMEOUT_SECONDS

    def effective_skill_dirs(self):
        return project_skill_dirs(self.project_root, extra_skill_dirs=self.custom_skill_dirs())

    def sync_agent_runtime_config(self, agent, sess: Optional[Session] = None):
        custom_skill_dirs = self.custom_skill_dirs()
        memory_enabled = self.config.get("memoryReferenceEnabled")
        has_memory_setting = isinstance(memory_enabled, bool)
        attempt_dedup_enabled = self.config.get("attemptDedupEnabled") is True
        max_turns = _optional_positive_int(self.config.get("maxTurns"))
        raw_max_cost = self.config.get("maxCost")
        max_cost = _optional_positive_float(raw_max_cost)
        thinking_mode = self.config.get("thinkingMode")
        thinking_budget = _optional_positive_int(self.config.get("thinkingBudget"))
        agent.custom_skill_dirs = custom_skill_dirs
        agent.attempt_dedup_enabled = attempt_dedup_enabled
        if sess is not None:
            agent.memory_reference_enabled = sess.memory_reference_enabled
            agent.permission_mode = sess.permission_mode or "default"
            agent.approved_plan_allowed_prompts = list(sess.approved_plan_allowed_prompts)
        if has_memory_setting:
            agent.memory_reference_enabled = memory_enabled
        if max_turns is not None:
            agent.max_turns = min(max_turns, 200)
        if max_cost is not None:
            agent.max_cost = max_cost
        elif raw_max_cost in ("", None):
            agent.max_cost = None
        if thinking_mode in {"adaptive", "enabled", "disabled"} and getattr(agent, "llmclient", None) is not None:
            try:
                agentmain = importlib.import_module("agentmain")
                agentmain.apply_thinking_settings(agent, thinking_mode, thinking_budget)
            except Exception:
                pass
        if getattr(agent, "llmclient", None) is not None:
            agent.llmclient.last_tools = ""

    def sync_runtime_config(self):
        memory_enabled = self.config.get("memoryReferenceEnabled")
        has_memory_setting = isinstance(memory_enabled, bool)
        permission_mode = self.config.get("permissionMode")
        has_permission_mode = permission_mode in PERMISSION_MODES
        with self.lock:
            sessions = list(self.sessions.values())
        for sess in sessions:
            if has_memory_setting:
                sess.memory_reference_enabled = memory_enabled
            if has_permission_mode and sess.status != "running":
                sess.permission_mode = permission_mode
            agent = getattr(sess, "agent", None)
            if not agent:
                continue
            self.sync_agent_runtime_config(agent, sess)
        with contextlib.suppress(Exception):
            from skill_registry import reset_skill_cache
            reset_skill_cache()
        with contextlib.suppress(Exception):
            from agent_registry import reset_agent_cache
            reset_agent_cache()

    def ensure_project_import_path(self) -> Path:
        root = Path(self.project_root).resolve()
        root_text = str(root)
        sys.path[:] = [path for path in sys.path if str(Path(path).resolve()) != root_text]
        sys.path.insert(0, root_text)
        cached_mykey = sys.modules.get("mykey")
        cached_path = Path(getattr(cached_mykey, "__file__", "") or "").resolve() if cached_mykey else None
        expected_path = (root / "mykey.py").resolve()
        if cached_path and cached_path != expected_path:
            sys.modules.pop("mykey", None)
            with contextlib.suppress(Exception):
                llmcore = importlib.import_module("llmcore")
                llmcore._mykey_path = None
                llmcore._mykey_mtime = None
                vars(llmcore).pop("mykeys", None)
        return root

    def make_agent(self, sess: Session):
        root = self.ensure_project_import_path()
        session_root = Path(sess.cwd or str(root)).resolve()
        agentmain = importlib.import_module("agentmain")
        AgentClass = agentmain.SecHeurAgent
        agent = AgentClass()
        agent.inc_out = True
        agent.verbose = True
        agent.project_root = str(session_root)
        agent.permission_mode = sess.permission_mode or "default"
        agent.oracle_agent_id = os.environ.get("CTF_AGENT_ID", "secheur-agent")
        agent.oracle_run_id = sess.id
        agent.oracle_challenge_id = (
            os.environ.get("CTF_CHALLENGE_ID")
            or os.environ.get("SECHEUR_TARGET_ID")
            or os.environ.get("CTF_TARGET_ID")
            or ""
        ).strip()
        agent.desktop_user_texts = []
        agent.session_title = sess.title or ""
        self.sync_agent_runtime_config(agent, sess)
        if sess.llm_no:
            agent.next_llm(sess.llm_no)
        agent.desktop_permission_callback = lambda request: self.request_permission(sess.id, request)
        agent.desktop_ask_user_callback = lambda request: self.request_permission(sess.id, request)
        agent.desktop_drain_queued_prompts = lambda: self.drain_queued_prompts_for_agent(sess)
        agent.run_temporary_sub_agent = lambda payload: self.run_temporary_sub_agent(sess, payload)
        threading.Thread(target=agent.run, daemon=True, name=f"SecHeur-{sess.id}").start()
        sess.agent_poisoned = False
        return agent

    def _make_temporary_agent(self, sess: Session, temp_id: str):
        root = self.ensure_project_import_path()
        session_root = Path(sess.cwd or str(root)).resolve()
        agentmain = importlib.import_module("agentmain")
        child = agentmain.SecHeurAgent()
        child.inc_out = True
        child.verbose = False
        child.single_task = True
        child.project_root = str(session_root)
        child.permission_mode = sess.permission_mode or "default"
        child.oracle_agent_id = os.environ.get("CTF_AGENT_ID", "secheur-agent")
        child.oracle_run_id = f"{sess.id}:{temp_id}"
        parent_agent = getattr(sess, "agent", None)
        child.oracle_challenge_id = (
            os.environ.get("CTF_CHALLENGE_ID")
            or os.environ.get("SECHEUR_TARGET_ID")
            or os.environ.get("CTF_TARGET_ID")
            or getattr(parent_agent, "oracle_challenge_id", "")
            or ""
        )
        child.oracle_challenge_id = str(child.oracle_challenge_id or "").strip()
        child.desktop_user_texts = list(getattr(parent_agent, "desktop_user_texts", []) or [])
        child.session_title = sess.title or ""
        child.memory_reference_enabled = sess.memory_reference_enabled
        child.desktop_permission_callback = lambda request: self.request_permission(sess.id, request)
        child.desktop_ask_user_callback = lambda request: self.request_permission(sess.id, request)
        child.desktop_drain_queued_prompts = lambda: ""
        self.sync_agent_runtime_config(child, sess)
        if sess.llm_no:
            child.next_llm(sess.llm_no)
        return child

    def _temp_sub_agent_status(self, state: str, detail: str = "") -> str:
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

    def run_temporary_sub_agent(self, sess: Session, payload: Dict[str, Any]):
        payload = dict(payload or {})
        child = configure_temporary_sub_agent(self._make_temporary_agent(sess, "temporary"), payload)
        return (yield from run_temporary_sub_agent_dialog(
            payload,
            child,
            cancel_requested=lambda: bool(sess.cancel_requested),
            transcript_root=sess.cwd or self.project_root,
        ))

    def list_model_profiles(self):
        self.ensure_project_import_path()
        try:
            agentmain = importlib.import_module("agentmain")
            agent = agentmain.SecHeurAgent()
            if hasattr(agent, "list_llms"):
                return [{"id": i, "name": name, "active": active} for i, name, active in agent.list_llms()]
        except ZeroDivisionError:
            return []
        except Exception as e:
            print(f"get model profiles failed: {e}", file=sys.stderr)
        return []

    def snapshot(self, sess: Session, include_messages: bool = True) -> dict:
        out = {
            "sessionId": sess.id,
            "id": sess.id,
            "title": sess.title,
            "cwd": sess.cwd,
            "status": sess.status,
            "createdAt": sess.created_at,
            "updatedAt": sess.updated_at,
            "lastError": sess.last_error,
            "msgSeq": sess.msg_seq,
            "llmNo": sess.llm_no,
            "permissionMode": sess.permission_mode,
            "memoryReferenceEnabled": sess.memory_reference_enabled,
        }
        if include_messages:
            out["messages"] = deepcopy(sess.messages)
            out["partial"] = deepcopy(sess.partial) if sess.partial else None
        out["blackboardGraph"] = build_session_blackboard_graph(sess)
        out["runtimeEventCount"] = len(sess.runtime_events)
        return out

    def add_runtime_event(self, sess: Session, event: str, detail: str = "", **extra) -> dict:
        next_id = (max((int(item.get("id") or 0) for item in sess.runtime_events), default=0) + 1)
        entry = {
            "id": next_id,
            "sessionId": sess.id,
            "event": str(event or "event"),
            "detail": str(detail or ""),
            "status": sess.status,
            "seq": sess.msg_seq,
            "ts": time.time(),
        }
        for key, value in extra.items():
            if value is not None:
                entry[key] = value
        sess.runtime_events.append(entry)
        if len(sess.runtime_events) > 500:
            sess.runtime_events = sess.runtime_events[-500:]
        return entry

    def add_message(self, sess: Session, role: str, content: str, **extra) -> dict:
        sess.msg_seq += 1
        msg = {"id": sess.msg_seq, "role": role, "content": content, "ts": time.time()}
        msg.update(extra)
        sess.messages.append(msg)
        if sess.partial is not None and int(sess.partial.get("id") or 0) <= sess.msg_seq:
            sess.partial["id"] = sess.msg_seq + 1
            sess.partial["ts"] = time.time()
        sess.updated_at = time.time()
        if role == "user" and content.strip():
            agent = getattr(sess, "agent", None)
            if agent is not None:
                texts = list(getattr(agent, "desktop_user_texts", []) or [])
                texts.append(content.strip())
                agent.desktop_user_texts = texts[-12:]
                if not getattr(agent, "oracle_challenge_id", None):
                    import re as _re
                    m = _re.search(
                        r"(?im)\b(?:target\s*id|challenge\s*id)\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9_./-]{2,})",
                        content,
                    )
                    if not m:
                        m = _re.search(
                            r"(?m)\b((?:nyu|cybench|intercode)(?:/[A-Za-z0-9._-]+){2,})\b",
                            content,
                        )
                    if m:
                        agent.oracle_challenge_id = m.group(1).strip().strip("`\"' ")
                agent.session_title = sess.title or ""
            if sess.title == "New chat":
                sess.title = content.strip().replace("\n", " ")[:40]
                if agent is not None:
                    agent.session_title = sess.title
        self.add_runtime_event(sess, f"message:{role}", f"{role} message #{msg['id']}", messageId=msg["id"], role=role)
        self.save_sessions()
        return msg

    def finalize_partial_as_interrupted(self, sess: Session, reason: str) -> bool:
        """Preserve visible progress when a running turn is cancelled."""
        partial = sess.partial or {}
        content = str(partial.get("content") or "").strip()
        sess.partial = None
        if not content:
            return False
        self.add_message(
            sess,
            "assistant",
            content,
            interrupted=True,
            interruption_reason=reason,
        )
        self.add_runtime_event(
            sess,
            "partial-saved",
            "已保存取消前的过程输出",
            chars=len(content),
        )
        return True

    def _permission_signature(self, tool_name: str, args: Optional[dict]) -> str:
        payload = {"tool": str(tool_name or ""), "args": args or {}}
        return json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)

    def _permission_title(self, tool_name: str, args: Optional[dict]) -> str:
        tool_name = str(tool_name or "tool")
        args = args or {}
        if tool_name == "code_run":
            code_type = args.get("type") or "shell"
            return f"运行 {code_type} 命令"
        if tool_name == "ask_user":
            return "需要用户确认"
        if tool_name == "file_write":
            return "写入文件"
        if tool_name == "file_patch":
            return "编辑文件"
        if tool_name == "mcp_tool":
            return f"调用 MCP 工具 {args.get('tool_name') or args.get('name') or ''}".strip()
        return f"执行 {tool_name}"

    def _permission_detail(self, tool_name: str, args: Optional[dict], message: str = "") -> str:
        args = args or {}
        if tool_name == "code_run":
            return str(args.get("script") or args.get("code") or message or "")
        if tool_name == "ask_user":
            return str(args.get("question") or message or "")
        for key in ("path", "raw_path", "tool_name", "name"):
            if args.get(key):
                return str(args.get(key))
        return message or json.dumps(args, ensure_ascii=False, indent=2, default=str)

    def _auto_answer_for_bypass(self, request: dict, args: dict) -> str:
        choices = [str(c) for c in (request.get("choices") or request.get("candidates") or args.get("candidates") or [])]
        preferred = {"允许", "同意", "是", "继续", "确认", "allow", "yes", "y", "ok", "continue"}
        for choice in choices:
            if choice.strip().lower() in preferred:
                return choice
        if choices:
            return choices[0]
        return "已开启完全访问权限，请按你的最佳判断继续。"

    def request_permission(self, sid: str, request: dict) -> dict:
        sess = self.get_session(sid)
        tool_name = str(request.get("tool_name") or request.get("toolName") or "tool")
        args = request.get("args") if isinstance(request.get("args"), dict) else {}
        if tool_name == "ask_user" and sess.permission_mode == "bypassPermissions":
            answer = self._auto_answer_for_bypass(request, args)
            with self.lock:
                self.add_message(
                    sess,
                    "permission",
                    f"已自动回答：{answer}",
                    tool_name=tool_name,
                    title="完全访问权限自动回答",
                    detail=self._permission_detail(tool_name, args, str(request.get("message") or "")),
                    choices=[str(c) for c in (request.get("choices") or request.get("candidates") or args.get("candidates") or [])],
                    args=args,
                    status="resolved",
                    decision="answer",
                    decision_label=answer,
                    answer=answer,
                )
            emit_session_state(sess, "permission")
            return {"decision": "answer", "allowed": True, "answer": answer, "bypassed": True}
        signature = self._permission_signature(tool_name, args)
        with self.lock:
            if signature in sess.permission_session_allows:
                return {"decision": "allow_session", "allowed": True, "remembered": True}
            request_id = "perm-" + uuid.uuid4().hex[:12]
            event = threading.Event()
            detail = request.get("detail") or self._permission_detail(tool_name, args, str(request.get("message") or ""))
            detail = _format_approved_prompt_detail(
                detail,
                _approved_prompts_for_permission(tool_name, args, sess.approved_plan_allowed_prompts),
            )
            payload = {
                "requestId": request_id,
                "toolName": tool_name,
                "args": args,
                "message": str(request.get("message") or ""),
                "title": request.get("title") or self._permission_title(tool_name, args),
                "detail": detail,
                "choices": [str(c) for c in (request.get("choices") or request.get("candidates") or [])],
                "status": "pending",
                "signature": signature,
                "createdAt": time.time(),
            }
            sess.permission_requests[request_id] = payload
            sess.permission_events[request_id] = event
            self.add_message(
                sess,
                "permission",
                payload["message"] or "需要权限确认",
                request_id=request_id,
                tool_name=tool_name,
                title=payload["title"],
                detail=payload["detail"],
                choices=payload["choices"],
                args=args,
                status="pending",
            )
        emit_session_state(sess, "permission")
        while not sess.cancel_requested:
            if event.wait(timeout=0.5):
                break
        with self.lock:
            decision = sess.permission_decisions.get(request_id) or "deny"
            sess.permission_events.pop(request_id, None)
            if decision == "allow_session":
                sess.permission_session_allows.add(signature)
            req = sess.permission_requests.get(request_id)
            answer = ""
            if req is not None:
                req["status"] = "resolved"
                req["decision"] = decision
                answer = str(req.get("answer") or "")
            allowed = _permission_decision_allowed(tool_name, decision, answer)
            if tool_name == "exit_plan_mode":
                if allowed:
                    sess.approved_plan_allowed_prompts = _normalize_session_allowed_prompts(args.get("allowedPrompts"))
                else:
                    sess.approved_plan_allowed_prompts = []
                if sess.agent is not None:
                    sess.agent.approved_plan_allowed_prompts = list(sess.approved_plan_allowed_prompts)
        return {"decision": decision, "allowed": allowed, "answer": answer}

    def resolve_permission(self, sid: str, request_id: str, decision: str, answer: str = "") -> dict:
        if decision not in {"allow_once", "allow_session", "deny", "answer"}:
            raise web.HTTPBadRequest(text=json.dumps({"error": "invalid permission decision"}, ensure_ascii=False), content_type="application/json")
        with self.lock:
            sess = self.get_session(sid)
            req = sess.permission_requests.get(request_id)
            if not req:
                raise web.HTTPNotFound(text=json.dumps({"error": f"permission request not found: {request_id}"}, ensure_ascii=False), content_type="application/json")
            if req.get("status") != "pending":
                return {"ok": True, "sessionId": sid, "requestId": request_id, "decision": req.get("decision"), "status": req.get("status")}
            req["status"] = "resolved"
            req["decision"] = decision
            if answer:
                req["answer"] = answer
            sess.permission_decisions[request_id] = decision
            label = answer or {"allow_once": "已允许本次", "allow_session": "本会话已允许", "deny": "已拒绝", "answer": "已回答"}[decision]
            updated = None
            for msg in sess.messages:
                if msg.get("role") == "permission" and msg.get("request_id") == request_id:
                    msg["status"] = "resolved"
                    msg["decision"] = decision
                    msg["decision_label"] = label
                    if answer:
                        msg["answer"] = answer
                    msg["content"] = label
                    updated = dict(msg)
                    break
            sess.updated_at = time.time()
            event = sess.permission_events.get(request_id)
            if event:
                event.set()
        emit_session_state(sess, "permission")
        return {"ok": True, "sessionId": sid, "requestId": request_id, "decision": decision, "message": updated}

    def resolve_pending_permissions(self, sess: Session, decision: str = "deny", request_ids: Optional[List[str]] = None):
        ids = list(request_ids) if request_ids is not None else list(sess.permission_requests)
        label = {"deny": "已拒绝", "allow_once": "已允许本次", "allow_session": "本会话已允许", "answer": "已回答"}.get(decision, decision)
        changed = False
        for request_id in ids:
            req = sess.permission_requests.get(request_id)
            if not req or req.get("status") != "pending":
                continue
            req["status"] = "resolved"
            req["decision"] = decision
            sess.permission_decisions[request_id] = decision
            for msg in sess.messages:
                if msg.get("role") == "permission" and msg.get("request_id") == request_id:
                    msg["status"] = "resolved"
                    msg["decision"] = decision
                    msg["decision_label"] = label
                    msg["content"] = label
                    break
            event = sess.permission_events.get(request_id)
            if event:
                event.set()
            changed = True
        if changed:
            sess.updated_at = time.time()

    def begin_turn(self, sess: Session) -> int:
        sess.turn_generation += 1
        sess.active_turn_id = sess.turn_generation
        return sess.active_turn_id

    def invalidate_active_turn(self, sess: Session) -> None:
        sess.turn_generation += 1
        sess.active_turn_id = 0

    def is_current_turn(self, sess: Session, turn_id: Optional[int]) -> bool:
        return turn_id is not None and sess.active_turn_id == turn_id and sess.turn_generation == turn_id

    def reset_agent_runtime(self, sess: Session, reason: str = "", poisoned: bool = False, invalidate_turn: bool = True) -> None:
        agent = sess.agent
        if agent is not None:
            with contextlib.suppress(Exception):
                setattr(agent, "stop_sig", True)
            with contextlib.suppress(Exception):
                handler = getattr(agent, "handler", None)
                if handler is not None:
                    handler.code_stop_signal.append(1)
            if hasattr(agent, "abort"):
                with contextlib.suppress(Exception):
                    agent.abort()
        if invalidate_turn:
            self.invalidate_active_turn(sess)
        self.resolve_pending_permissions(sess)
        sess.agent = None
        sess.agent_poisoned = bool(poisoned)
        sess.updated_at = time.time()

    def create_session(
        self,
        cwd: Optional[str] = None,
        llm_no: int = 0,
        permission_mode: str = "default",
        memory_reference_enabled: bool = True,
        title: str = "New chat",
        activate: bool = True,
    ) -> Session:
        permission_mode = str(permission_mode or "default")
        if permission_mode not in PERMISSION_MODES:
            raise web.HTTPBadRequest(text=json.dumps({"error": f"invalid permission mode: {permission_mode}"}, ensure_ascii=False), content_type="application/json")
        sid = "sess-" + uuid.uuid4().hex[:12]
        sess = Session(
            id=sid,
            title=str(title or "New chat"),
            cwd=str(cwd or self.project_root),
            llm_no=max(0, int(llm_no or 0)),
            permission_mode=permission_mode,
            memory_reference_enabled=bool(memory_reference_enabled),
        )
        with self.lock:
            self.sessions[sid] = sess
            if activate:
                self.active_session_id = sid
            self.add_runtime_event(sess, "created", "会话已创建")
        self.save_sessions()
        emit_session_state(sess, "created")
        return sess

    def get_session(self, sid: str) -> Session:
        with self.lock:
            sess = self.sessions.get(sid)
            if not sess:
                raise web.HTTPNotFound(text=json.dumps({"error": f"session not found: {sid}"}, ensure_ascii=False), content_type="application/json")
            return sess

    def delete_session(self, sid: str) -> dict:
        with self.lock:
            sess = self.sessions.pop(sid, None)
            if not sess:
                raise web.HTTPNotFound(text=json.dumps({"error": f"session not found: {sid}"}, ensure_ascii=False), content_type="application/json")
            if self.active_session_id == sid:
                self.active_session_id = next(iter(self.sessions), None)
            should_cancel = sess.status == "running" or sess.partial is not None or bool(sess.permission_events)
            if should_cancel:
                sess.cancel_requested = True
                self.invalidate_active_turn(sess)
                sess.status = "closed"
                sess.partial = None
                sess.updated_at = time.time()
            self.add_runtime_event(sess, "closed", "会话已关闭")
            self.resolve_pending_permissions(sess)
            for event in list(sess.permission_events.values()):
                event.set()
            if sess.agent and hasattr(sess.agent, "abort"):
                with contextlib.suppress(Exception):
                    sess.agent.abort()
        self.save_sessions()
        emit_session_state(sess, "closed")
        return {"ok": True, "sessionId": sid, "status": sess.status}

    def set_session_model(self, sid: str, llm_no: int) -> dict:
        runtime_reset = False
        was_running = False
        with self.lock:
            sess = self.get_session(sid)
            sess.llm_no = max(0, int(llm_no or 0))
            was_running = sess.status == "running" or sess.partial is not None or bool(sess.permission_events)
            if was_running:
                sess.cancel_requested = True
                self.reset_agent_runtime(sess, "model switch while running", poisoned=False)
                sess.partial = None
                sess.status = "idle"
                sess.last_error = ""
                sess.thread = None
                sess.updated_at = time.time()
                runtime_reset = True
                agent = None
            elif sess.agent_poisoned:
                self.reset_agent_runtime(sess, "model switch after stalled runtime", poisoned=False)
                runtime_reset = True
                agent = None
            else:
                agent = sess.agent
            self.add_runtime_event(sess, "model", f"模型切换到 {sess.llm_no}", llmNo=sess.llm_no, runtimeReset=runtime_reset)
        if agent is not None and hasattr(agent, "next_llm"):
            agent.next_llm(sess.llm_no)
        emit_session_state(sess, "model")
        return {"ok": True, "sessionId": sid, "llmNo": sess.llm_no, "runtimeReset": runtime_reset, "wasRunning": was_running}

    def reset_session_runtime(self, sid: str) -> dict:
        with self.lock:
            sess = self.get_session(sid)
            was_running = sess.status == "running" or sess.partial is not None or bool(sess.permission_events)
            had_agent = sess.agent is not None or sess.agent_poisoned
            if was_running:
                sess.cancel_requested = True
            self.reset_agent_runtime(sess, "manual runtime reset", poisoned=False)
            if was_running:
                sess.partial = None
                sess.status = "idle"
                sess.last_error = ""
                sess.thread = None
                sess.updated_at = time.time()
            self.add_runtime_event(sess, "runtime-reset", "已重置本会话运行时", hadAgent=had_agent, wasRunning=was_running)
        emit_session_state(sess, "runtime-reset")
        return {"ok": True, "sessionId": sid, "runtimeReset": True, "hadAgent": had_agent, "wasRunning": was_running}

    def set_session_permission_mode(self, sid: str, mode: str) -> dict:
        mode = str(mode or "default")
        if mode not in PERMISSION_MODES:
            raise web.HTTPBadRequest(text=json.dumps({"error": f"invalid permission mode: {mode}"}, ensure_ascii=False), content_type="application/json")
        with self.lock:
            sess = self.get_session(sid)
            if sess.status == "running":
                raise web.HTTPConflict(text=json.dumps({"error": "session is already running"}, ensure_ascii=False), content_type="application/json")
            sess.permission_mode = mode
            agent = sess.agent
            self.add_runtime_event(sess, "permission-mode", f"权限模式切换到 {mode}", permissionMode=mode)
        if agent is not None:
            agent.permission_mode = mode
        emit_session_state(sess, "permission-mode")
        return {"ok": True, "sessionId": sid, "permissionMode": mode}

    def _queued_prompt_text(self, items: List[dict]) -> str:
        if not items:
            return ""
        parts = [
            "<queued_user_messages>",
            "用户在上一工具调用执行期间补充了以下输入。上一工具调用已经结束，请先吸收这些最新用户意图，再决定下一步。",
        ]
        for index, item in enumerate(items, 1):
            prompt = xml_escape(item.get("prompt") or "")
            source = xml_escape(item.get("source") or "user")
            parts.append(f'<message index="{index}" source="{source}">{prompt}</message>')
        parts.append("</queued_user_messages>")
        return "\n".join(parts)

    def drain_queued_prompts_for_agent(self, sess: Session) -> str:
        with self.lock:
            if not sess.queued_prompts:
                return ""
            items = list(sess.queued_prompts)
            sess.queued_prompts.clear()
            delivered_ids = {int(item.get("message_id") or 0) for item in items}
            for msg in sess.messages:
                if int(msg.get("id") or 0) in delivered_ids and msg.get("queued_status") == "queued":
                    msg["queued_status"] = "delivered"
            sess.updated_at = time.time()
            self.add_runtime_event(sess, "queue-delivered", f"已交付 {len(items)} 条排队输入", queuedCount=len(items))
        emit_session_state(sess, "queue")
        return self._queued_prompt_text(items)

    def start_next_queued_prompt_if_idle(self, sess: Session) -> bool:
        with self.lock:
            if sess.status != "idle" or not sess.queued_prompts:
                return False
            item = sess.queued_prompts.pop(0)
            message_id = int(item.get("message_id") or 0)
            for msg in sess.messages:
                if int(msg.get("id") or 0) == message_id and msg.get("queued_status") == "queued":
                    msg["queued_status"] = "delivered"
                    break
            sess.status = "running"
            sess.cancel_requested = False
            sess.last_error = ""
            sess.partial = {"id": sess.msg_seq + 1, "role": "assistant", "content": "", "ts": time.time(), "partial": True}
            turn_id = self.begin_turn(sess)
            t = threading.Thread(
                target=self.run_agent_turn,
                args=(sess, str(item.get("prompt") or ""), item.get("images") or [], None, turn_id, bool(item.get("web_verbs_enabled"))),
                daemon=True,
                name=f"Turn-{sess.id}",
            )
            sess.thread = t
            sess.updated_at = time.time()
            self.add_runtime_event(sess, "running", "开始执行排队输入", messageId=message_id)
            t.start()
        emit_session_state(sess, "running")
        return True

    def submit_prompt(
        self,
        sid: str,
        prompt: Any,
        images: Optional[list] = None,
        files: Optional[list] = None,
        llm_no: Optional[int] = None,
        source: str = "user",
        done_callback: Optional[Any] = None,
        force: bool = False,
        display_prompt: Any = None,
        web_verbs_enabled: bool = False,
    ) -> dict:
        interrupted = False
        with self.lock:
            sess = self.sessions.get(sid)
            if not sess:
                raise web.HTTPNotFound(text=json.dumps({"error": f"session not found: {sid}"}, ensure_ascii=False), content_type="application/json")
            if sess.status == "running":
                if not force:
                    prompt, image_ids, image_refs, file_refs = normalize_prompt_payload(prompt, images, files)
                    display_prompt, _display_image_ids, _display_image_refs, _display_file_refs = normalize_prompt_payload(
                        prompt if display_prompt is None else display_prompt,
                        [],
                        [],
                    )
                    if not has_normalized_prompt_payload(prompt, image_ids, file_refs):
                        raise empty_prompt_error()
                    extra = {"queued_status": "queued"}
                    if image_ids:
                        extra["image_ids"] = image_ids
                    if file_refs:
                        extra["file_attachments"] = file_refs
                    if source != "user":
                        extra["source"] = source
                    user_msg = self.add_message(sess, "user", display_prompt, **extra)
                    sess.queued_prompts.append({
                        "prompt": prompt,
                        "display_prompt": display_prompt,
                        "images": image_refs,
                        "files": file_refs,
                        "message_id": user_msg["id"],
                        "source": source,
                        "web_verbs_enabled": bool(web_verbs_enabled),
                    })
                    seq = sess.msg_seq
                    sess.updated_at = time.time()
                    queued_count = len(sess.queued_prompts)
                    self.add_runtime_event(sess, "queue", "用户输入已排队", messageId=user_msg["id"], queuedCount=queued_count)
                    emit_after = "queue"
                    result = {
                        "ok": True,
                        "sessionId": sid,
                        "accepted": True,
                        "queued": True,
                        "interrupted": False,
                        "userMessageId": user_msg["id"],
                        "queuedCount": queued_count,
                        "seq": seq,
                    }
                    emit_session_state(sess, emit_after)
                    return result
                interrupted = True
                sess.cancel_requested = True
                self.reset_agent_runtime(sess, "force submit replaced running turn", poisoned=False)
                sess.partial = None
                sess.status = "idle"
                sess.last_error = ""
                sess.thread = None
                sess.updated_at = time.time()
            prompt, image_ids, image_refs, file_refs = normalize_prompt_payload(prompt, images, files)
            display_prompt, _display_image_ids, _display_image_refs, _display_file_refs = normalize_prompt_payload(
                prompt if display_prompt is None else display_prompt,
                [],
                [],
            )
            if not has_normalized_prompt_payload(prompt, image_ids, file_refs):
                raise empty_prompt_error()
            sess.web_verbs_enabled = bool(web_verbs_enabled)
            if llm_no is not None:
                sess.llm_no = max(0, int(llm_no or 0))
                if sess.agent is not None and hasattr(sess.agent, "next_llm"):
                    sess.agent.next_llm(sess.llm_no)
            extra = {}
            if image_ids:
                extra["image_ids"] = image_ids
            if file_refs:
                extra["file_attachments"] = file_refs
            if source != "user":
                extra["source"] = source
            user_msg = self.add_message(sess, "user", display_prompt, **extra)
            sess.status = "running"
            sess.cancel_requested = False
            sess.last_error = ""
            sess.partial = {"id": sess.msg_seq + 1, "role": "assistant", "content": "", "ts": time.time(), "partial": True}
            turn_id = self.begin_turn(sess)
            self.add_runtime_event(sess, "running", "开始执行用户输入", messageId=user_msg["id"], turnId=turn_id, interrupted=interrupted)
            t = threading.Thread(target=self.run_agent_turn, args=(sess, prompt, image_refs, done_callback, turn_id), daemon=True, name=f"Turn-{sid}")
            sess.thread = t
            t.start()
            seq = sess.msg_seq
            emit_after = "running"
            result = {"ok": True, "sessionId": sid, "accepted": True, "queued": False, "interrupted": interrupted, "userMessageId": user_msg["id"], "seq": seq}
        emit_session_state(sess, emit_after)
        return result

    def run_agent_turn(self, sess: Session, prompt: str, images: Optional[list] = None, done_callback: Optional[Any] = None, turn_id: Optional[int] = None, web_verbs_enabled: bool = False):
        try:
            web_verbs_enabled = bool(web_verbs_enabled or getattr(sess, "web_verbs_enabled", False))
            with self.lock:
                if turn_id is None:
                    turn_id = sess.active_turn_id or self.begin_turn(sess)
                if not self.is_current_turn(sess, turn_id):
                    return
            if sess.agent is None:
                agent = self.make_agent(sess)
                with self.lock:
                    if not self.is_current_turn(sess, turn_id):
                        if hasattr(agent, "abort"):
                            with contextlib.suppress(Exception):
                                agent.abort()
                        return
                    sess.agent = agent
                    sess.agent_poisoned = False
            agent = sess.agent
            full = ""
            if hasattr(agent, "put_task"):
                try:
                    display_q = agent.put_task(prompt, images=images or [], web_verbs_enabled=web_verbs_enabled)
                except TypeError as exc:
                    if "web_verbs_enabled" not in str(exc):
                        raise
                    display_q = agent.put_task(prompt, images=images or [])
                pieces = []
                resume_prefix = ""
                restart_attempted = False
                first_output_timeout = self.agent_first_output_timeout_seconds()
                output_idle_timeout = self.agent_output_idle_timeout_seconds()
                started_at = last_activity_at = time.time()
                import queue as _queue
                while True:
                    with self.lock:
                        if not self.is_current_turn(sess, turn_id):
                            return
                        cancel_requested = sess.cancel_requested
                    if cancel_requested:
                        break
                    try:
                        item = display_q.get(timeout=1.0)
                    except _queue.Empty:
                        now = time.time()
                        agent_running = bool(getattr(agent, "is_running", True))
                        if pieces and not agent_running:
                            break
                        if not pieces and not agent_running and now - started_at > 3:
                            break
                        if not pieces and now - started_at > first_output_timeout:
                            raise TimeoutError(
                                "模型首个输出超时："
                                f"已等待 {first_output_timeout} 秒仍没有收到任何内容。"
                                "网络可用时通常是 API 请求未返回、流式响应卡住、"
                                "代理/API Base/模型配置异常，或服务端排队/限流。"
                                "请检查当前模型、API Base、Key、代理设置，或切换模型重试。"
                            )
                        if pieces and now - last_activity_at > output_idle_timeout:
                            if restart_attempted:
                                raise TimeoutError(
                                    "模型输出中断："
                                    f"已 {output_idle_timeout} 秒没有收到新内容，且自动续作后再次中断。"
                                    "可能是流式连接中断、工具执行未返回或服务端响应卡住。"
                                    "已自动释放会话，你可以调整模型/代理后重试。"
                                )
                            restart_attempted = True
                            partial_text = resume_prefix + ("".join(pieces) if getattr(agent, "inc_out", False) else pieces[-1])
                            if hasattr(agent, "abort"):
                                with contextlib.suppress(Exception):
                                    agent.abort()
                            retry_agent = self.make_agent(sess)
                            with self.lock:
                                if not self.is_current_turn(sess, turn_id):
                                    return
                                sess.agent = retry_agent
                                sess.agent_poisoned = False
                            agent = retry_agent
                            resume_prefix = partial_text
                            pieces = []
                            retry_prompt = (
                                "上一轮模型输出在中途停止，请继续完成原任务，不要重复已输出的内容。\n"
                                f"原始请求：\n{prompt}\n\n"
                                f"已输出的部分内容：\n{partial_text}"
                            )
                            display_q = agent.put_task(retry_prompt, images=[])
                            started_at = last_activity_at = time.time()
                        continue
                    last_activity_at = time.time()
                    if isinstance(item, dict):
                        if item.get("next"):
                            text = str(item["next"])
                            pieces.append(text)
                            with self.lock:
                                if not self.is_current_turn(sess, turn_id):
                                    return
                                if sess.partial is not None:
                                    sess.partial["content"] = resume_prefix + ("".join(pieces) if getattr(agent, "inc_out", False) else text)
                                    sess.partial["ts"] = time.time()
                                    sess.updated_at = time.time()
                        if "done" in item:
                            full = str(item.get("done") or "")
                            break
                    else:
                        pieces.append(str(item))
                if not full and pieces:
                    full = pieces[-1] if not getattr(agent, "inc_out", False) else "".join(pieces)
                if resume_prefix:
                    full = resume_prefix + full
            elif hasattr(agent, "run"):
                ret = agent.run(prompt)
                if isinstance(ret, str):
                    full = ret
            else:
                full = "SecHeur Agent object has no put_task/run method"
            if not full:
                full = "(completed)"
            if sess.cancel_requested:
                with self.lock:
                    if not self.is_current_turn(sess, turn_id):
                        return
                    sess.partial = None
                    # Ensure status stays cancelled (don't overwrite)
                    if sess.status != "cancelled":
                        sess.status = "cancelled"
                    sess.updated_at = time.time()
                    sess.active_turn_id = 0
                    self.add_runtime_event(sess, "cancelled", "任务已取消")
                emit_session_state(sess, "cancelled")
                return
            with self.lock:
                if not self.is_current_turn(sess, turn_id):
                    return
                sess.partial = None
                # Strip trailing [Info] Final response to user. marker
                import re as _re
                full = _re.sub(r'\n*`{5}\n*\[Info\] Final response to user\.\n*`{5}\s*$', '', full)
                self.add_message(sess, "assistant", full)
                sess.status = "idle"
                sess.last_error = ""
                sess.active_turn_id = 0
                self.add_runtime_event(sess, "idle", "任务已完成")
            if done_callback is not None:
                try:
                    done_callback(full)
                except Exception as callback_error:
                    with self.lock:
                        self.add_message(sess, "error", f"定时任务完成回调失败：{callback_error}")
            if self.start_next_queued_prompt_if_idle(sess):
                return
            emit_session_state(sess, "idle")
        except Exception as e:
            tb = traceback.format_exc()
            with self.lock:
                if not self.is_current_turn(sess, turn_id):
                    return
                self.reset_agent_runtime(sess, str(e), poisoned=True)
                sess.partial = None
                sess.status = "error"
                sess.last_error = str(e)
                self.add_message(sess, "error", str(e))
                self.add_runtime_event(sess, "error", str(e))
            print(tb, file=sys.stderr)
            emit_session_state(sess, "error")

    def messages(self, sid: str, after: int = 0, limit: int = 200) -> dict:
        with self.lock:
            sess = self.sessions.get(sid)
            if not sess:
                raise web.HTTPNotFound(text=json.dumps({"error": f"session not found: {sid}"}, ensure_ascii=False), content_type="application/json")
            msgs = [m for m in sess.messages if int(m.get("id", 0)) > after]
            if limit > 0:
                msgs = msgs[-limit:]
            return {
                "sessionId": sid,
                "status": sess.status,
                "messages": msgs,
                "partial": dict(sess.partial) if sess.partial else None,
                "msgSeq": sess.msg_seq,
                "updatedAt": sess.updated_at,
                "lastError": sess.last_error,
                "blackboardGraph": build_session_blackboard_graph(sess),
            }

    def session_runtime_log(self, sid: str) -> dict:
        with self.lock:
            sess = self.get_session(sid)
            return {
                "ok": True,
                "sessionId": sid,
                "session": self.snapshot(sess, include_messages=False),
                "events": deepcopy(sess.runtime_events),
            }

    def export_session(self, sid: str) -> dict:
        with self.lock:
            sess = self.get_session(sid)
            return {
                "ok": True,
                "sessionId": sid,
                "exportedAt": time.time(),
                "session": self.snapshot(sess, include_messages=False),
                "messages": deepcopy(sess.messages),
                "partial": deepcopy(sess.partial) if sess.partial else None,
                "runtimeLog": deepcopy(sess.runtime_events),
                "blackboardGraph": build_session_blackboard_graph(sess),
            }

    def cancel(self, sid: str) -> dict:
        with self.lock:
            sess = self.sessions.get(sid)
            if not sess:
                raise web.HTTPNotFound(text=json.dumps({"error": f"session not found: {sid}"}, ensure_ascii=False), content_type="application/json")
            if sess.status != "running" and sess.partial is None and not sess.permission_events:
                return {"ok": True, "sessionId": sid, "cancelled": False, "status": sess.status}
            sess.cancel_requested = True
            self.invalidate_active_turn(sess)
            if sess.agent and hasattr(sess.agent, "abort"):
                with contextlib.suppress(Exception):
                    sess.agent.abort()
            sess.status = "cancelled"
            partial_saved = self.finalize_partial_as_interrupted(sess, "任务在完成前被取消")
            self.resolve_pending_permissions(sess)
            sess.updated_at = time.time()
            self.add_runtime_event(sess, "cancelled", "已请求停止当前任务", partialSaved=partial_saved)
        emit_session_state(sess, "cancelled")
        return {"ok": True, "sessionId": sid, "cancelled": True, "status": "cancelled"}


import base64
import binascii
import tempfile

# Shared temp dir for image uploads (persists for process lifetime)
_UPLOAD_DIR = Path(tempfile.gettempdir()) / "secheur_agent_uploads"
_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
_IMAGE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
_FILE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
MAX_REQUEST_BYTES = 32 * 1024 * 1024
MAX_PROMPT_IMAGES = 4
MAX_PROMPT_FILES = 8
MAX_PROMPT_TEXT_CHARS = 400_000
MAX_PROMPT_IMAGE_BYTES = 5 * 1024 * 1024
MAX_PROMPT_IMAGE_B64_CHARS = math.ceil(MAX_PROMPT_IMAGE_BYTES / 3) * 4 + 128
MAX_PROMPT_FILE_BYTES = 8 * 1024 * 1024
MAX_PROMPT_FILE_B64_CHARS = math.ceil(MAX_PROMPT_FILE_BYTES / 3) * 4 + 128


def bridge_bad_request(message: str):
    raise web.HTTPBadRequest(
        text=json.dumps({"error": message}, ensure_ascii=False),
        content_type="application/json",
    )


def _save_image_data(data_url: str, img_id: str) -> str:
    """Save a data URL to disk, return absolute path."""
    if not _IMAGE_ID_RE.fullmatch(str(img_id)):
        bridge_bad_request("invalid image id")
    # data:image/png;base64,xxxxx
    if "," in data_url:
        header, b64 = data_url.split(",", 1)
    else:
        b64 = data_url
        header = ""
    if len(b64) > MAX_PROMPT_IMAGE_B64_CHARS:
        bridge_bad_request("image data exceeds size limit")
    ext = "png"
    if "jpeg" in header or "jpg" in header:
        ext = "jpg"
    elif "webp" in header:
        ext = "webp"
    elif "gif" in header:
        ext = "gif"
    fpath = _UPLOAD_DIR / f"{img_id}.{ext}"
    try:
        content = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        bridge_bad_request("invalid image data")
    if not content:
        bridge_bad_request("empty image data")
    if len(content) > MAX_PROMPT_IMAGE_BYTES:
        bridge_bad_request("image data exceeds size limit")
    fpath.write_bytes(content)
    return str(fpath)


def _safe_upload_file_name(name: Any) -> str:
    safe_name = str(name or "upload.bin").strip() or "upload.bin"
    if len(safe_name) > 180:
        bridge_bad_request("file name is too long")
    if safe_name != Path(safe_name).name or any(ord(ch) < 32 for ch in safe_name):
        bridge_bad_request("invalid file name")
    return safe_name


def _save_file_data(data_url: str, file_id: str, name: Any) -> tuple[str, int]:
    if not _FILE_ID_RE.fullmatch(str(file_id)):
        bridge_bad_request("invalid file id")
    safe_name = _safe_upload_file_name(name)
    if "," in data_url:
        _, b64 = data_url.split(",", 1)
    else:
        b64 = data_url
    if len(b64) > MAX_PROMPT_FILE_B64_CHARS:
        bridge_bad_request("file data exceeds size limit")
    try:
        content = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        bridge_bad_request("invalid file data")
    if len(content) > MAX_PROMPT_FILE_BYTES:
        bridge_bad_request("file data exceeds size limit")
    fpath = _UPLOAD_DIR / f"{file_id}-{safe_name}"
    fpath.write_bytes(content)
    return str(fpath), len(content)


def normalize_prompt_payload(prompt: Any, images: Optional[list] = None, files: Optional[list] = None):
    """Normalize prompt and images.
    
    images: list of dicts {"id": "img-xxx", "dataUrl": "data:..."} or plain data URLs.
    Returns: (prompt_text_with_attachment_tags, image_ids_list, image_refs_list, file_refs_list)
    """
    images = list(images or [])
    files = list(files or [])
    if isinstance(prompt, list):
        text_parts = []
        for part in prompt:
            if isinstance(part, str):
                text_parts.append(part)
            elif isinstance(part, dict):
                if part.get("type") in ("text", "input_text"):
                    text_parts.append(str(part.get("text") or part.get("content") or ""))
                elif part.get("type") in ("image", "input_image"):
                    url = part.get("image_url") or part.get("url") or part.get("data")
                    if isinstance(url, dict):
                        url = url.get("url")
                    if url:
                        images.append(url)
        prompt = "\n".join([p for p in text_parts if p])
    if len(images) > MAX_PROMPT_IMAGES:
        bridge_bad_request(f"too many images: max {MAX_PROMPT_IMAGES}")
    if len(files) > MAX_PROMPT_FILES:
        bridge_bad_request(f"too many files: max {MAX_PROMPT_FILES}")

    # Process images: save to disk, build [image:path] tags
    image_ids = []
    image_refs = []
    image_tags = []
    for img in images:
        if isinstance(img, dict):
            img_id = img.get("id") or f"img-{uuid.uuid4().hex[:8]}"
            data_url = img.get("dataUrl") or img.get("data_url") or ""
        else:
            # Plain data URL string
            img_id = f"img-{uuid.uuid4().hex[:8]}"
            data_url = str(img)
        if data_url:
            path = _save_image_data(data_url, img_id)
            image_tags.append(f"[image:{path}]")
            image_ids.append(img_id)
            image_refs.append({"id": img_id, "path": path})

    file_refs = []
    file_tags = []
    for file in files:
        if not isinstance(file, dict):
            bridge_bad_request("invalid file attachment")
        file_id = file.get("id") or f"file-{uuid.uuid4().hex[:8]}"
        data_url = file.get("dataUrl") or file.get("data_url") or ""
        if not data_url:
            bridge_bad_request("file attachment missing data")
        name = _safe_upload_file_name(file.get("name"))
        file_type = str(file.get("type") or "application/octet-stream")[:120]
        path, size = _save_file_data(data_url, file_id, name)
        file_refs.append({"id": file_id, "name": name, "type": file_type, "size": size, "path": path})
        file_tags.append(
            f'<uploaded_file name="{xml_escape(name)}" type="{xml_escape(file_type)}" size="{size}">\n'
            f"{xml_escape(path)}\n"
            "</uploaded_file>"
        )

    # Append image tags to prompt
    final_prompt = str(prompt or "")
    if len(final_prompt) > MAX_PROMPT_TEXT_CHARS:
        bridge_bad_request(f"prompt exceeds size limit: max {MAX_PROMPT_TEXT_CHARS} chars")
    if image_tags:
        final_prompt = final_prompt + "\n" + "\n".join(image_tags)
    if file_tags:
        final_prompt = final_prompt + "\n\n" + "\n\n".join(file_tags)

    return final_prompt, image_ids, image_refs, file_refs


def normalize_prompt(prompt: Any, images: Optional[list] = None, files: Optional[list] = None):
    final_prompt, image_ids, _image_refs, file_refs = normalize_prompt_payload(prompt, images, files)
    return final_prompt, image_ids, file_refs


class SchedulerPoller:
    def __init__(self, manager: AgentManager, scheduler_path: Optional[Path | str] = None, scheduler_module: Optional[Any] = None):
        self.manager = manager
        self.scheduler_path = Path(scheduler_path) if scheduler_path is not None else None
        self.scheduler_module = scheduler_module
        self._injected_module = scheduler_module is not None
        self._module_mtime: Optional[float] = None
        self._tick_lock = threading.Lock()
        self._load_error_logged = False
        self._stopped = False
        self._session_id: Optional[str] = None

    @property
    def interval(self) -> int:
        return max(5, int(getattr(self.scheduler_module, "INTERVAL", 60) or 60))

    def _resolved_scheduler_path(self) -> Path:
        if self.scheduler_path is not None:
            return self.scheduler_path
        return Path(self.manager.project_root) / "reflect" / "scheduler.py"

    def _has_task_files(self) -> bool:
        task_dir = Path(self.manager.project_root) / "sche_tasks"
        return task_dir.is_dir() and any(task_dir.glob("*.json"))

    def _load_scheduler(self):
        if self._injected_module:
            return self.scheduler_module
        if not self._has_task_files():
            return None
        path = self._resolved_scheduler_path()
        if not path.exists():
            return None
        try:
            mtime = path.stat().st_mtime
            if self.scheduler_module is not None and self._module_mtime == mtime:
                return self.scheduler_module
            root = str(Path(self.manager.project_root).resolve())
            if root not in sys.path:
                sys.path.insert(0, root)
            old_embedded = os.environ.get("SECHEUR_SCHEDULER_EMBEDDED")
            os.environ["SECHEUR_SCHEDULER_EMBEDDED"] = "1"
            try:
                module_name = f"_secheur_desktop_scheduler_{abs(hash(str(path.resolve())))}"
                spec = importlib.util.spec_from_file_location(module_name, path)
                if spec is None or spec.loader is None:
                    return None
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
            finally:
                if old_embedded is None:
                    os.environ.pop("SECHEUR_SCHEDULER_EMBEDDED", None)
                else:
                    os.environ["SECHEUR_SCHEDULER_EMBEDDED"] = old_embedded
            self.scheduler_module = module
            self._module_mtime = mtime
            self._load_error_logged = False
            return module
        except Exception as e:
            if not self._load_error_logged:
                print(f"scheduler load failed: {e}", file=sys.stderr)
                self._load_error_logged = True
            return None

    def _active_session_is_running(self) -> bool:
        with self.manager.lock:
            active_id = self.manager.active_session_id
            active = self.manager.sessions.get(active_id) if active_id else None
            return bool(active and active.status == "running")

    def _get_or_create_scheduler_session(self):
        with self.manager.lock:
            sess = self.manager.sessions.get(self._session_id) if self._session_id else None
            if sess is not None:
                if sess.status != "idle":
                    raise web.HTTPConflict(text=json.dumps({"error": "scheduler session is busy"}, ensure_ascii=False), content_type="application/json")
                return sess
        permission_mode = self.manager.config.get("permissionMode")
        if permission_mode not in PERMISSION_MODES:
            permission_mode = "default"
        memory_enabled = self.manager.config.get("memoryReferenceEnabled")
        if not isinstance(memory_enabled, bool):
            memory_enabled = True
        sess = self.manager.create_session(
            cwd=self.manager.project_root,
            permission_mode=permission_mode,
            memory_reference_enabled=memory_enabled,
            title=SCHEDULER_SESSION_TITLE,
            activate=False,
        )
        self._session_id = sess.id
        return sess

    def tick(self) -> dict:
        if not self._tick_lock.acquire(blocking=False):
            return {"submitted": False, "reason": "already-running"}
        try:
            if self._active_session_is_running():
                return {"submitted": False, "reason": "busy"}
            module = self._load_scheduler()
            if module is None or not hasattr(module, "check"):
                return {"submitted": False, "reason": "unavailable"}
            task = module.check()
            if not task:
                return {"submitted": False, "reason": "no-task"}
            sess = self._get_or_create_scheduler_session()
            done_callback = getattr(module, "on_done", None)
            self.manager.submit_prompt(sess.id, task, source="scheduler", done_callback=done_callback)
            return {"submitted": True, "sessionId": sess.id}
        except web.HTTPConflict:
            return {"submitted": False, "reason": "busy"}
        except Exception as e:
            print(f"scheduler tick failed: {e}", file=sys.stderr)
            return {"submitted": False, "reason": "error", "error": str(e)}
        finally:
            self._tick_lock.release()

    async def run(self):
        while not self._stopped:
            self.tick()
            await asyncio.sleep(self.interval)

    def stop(self):
        self._stopped = True


manager = AgentManager()


def project_root_payload() -> dict:
    return {
        "projectRoot": manager.project_root,
        "mykeyPath": manager.mykey_path,
    }


# ---------------------------------------------------------------------------
# Transport layer: WS notification only
# ---------------------------------------------------------------------------

class WsHub:
    def __init__(self):
        self.websockets: Set[web.WebSocketResponse] = set()
        self.loop: Optional[asyncio.AbstractEventLoop] = None

    def emit(self, obj: dict):
        if self.loop and self.loop.is_running():
            asyncio.run_coroutine_threadsafe(self._broadcast(obj), self.loop)

    async def _broadcast(self, obj: dict):
        data = json.dumps(obj, ensure_ascii=False, default=str)
        dead = set()
        for ws in list(self.websockets):
            try:
                await ws.send_str(data)
            except Exception:
                dead.add(ws)
        self.websockets.difference_update(dead)


hub = WsHub()


def emit_session_state(sess: Session, state_name: str):
    hub.emit({
        "type": "session-state",
        "sessionId": sess.id,
        "state": state_name,
        "status": sess.status,
        "seq": sess.msg_seq,
        "updatedAt": sess.updated_at,
        "title": sess.title,
    })


async def ws_handler(request):
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    hub.websockets.add(ws)
    await ws.send_str(json.dumps({
        "type": "bridge-ready",
        **project_root_payload(),
        "http": True,
        "wsEventsOnly": True,
    }, ensure_ascii=False))
    async for msg in ws:
        if msg.type == WSMsgType.TEXT:
            # WS is intentionally not a data/command channel anymore.
            with contextlib.suppress(Exception):
                data = json.loads(msg.data)
                if data.get("action") == "ping":
                    await ws.send_str(json.dumps({"type": "pong", "ts": time.time()}, ensure_ascii=False))
    hub.websockets.discard(ws)
    return ws


# ---------------------------------------------------------------------------
# Transport layer: HTTP command/data API
# ---------------------------------------------------------------------------

def is_allowed_origin(origin: str, request_host: str = "") -> bool:
    if not origin:
        return True
    parsed = urlparse(origin)
    if parsed.scheme not in {"http", "https"}:
        return False
    host = (parsed.hostname or "").lower()
    if host in {"127.0.0.1", "localhost", "::1"}:
        return True
    origin_host = parsed.netloc.lower()
    request_host = str(request_host or "").split(",", 1)[0].strip().lower()
    return bool(origin_host and request_host and origin_host == request_host)


def cors_headers(origin: str = "", request_host: str = ""):
    headers = {
        "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }
    if origin and is_allowed_origin(origin, request_host):
        headers["Access-Control-Allow-Origin"] = origin
    return headers


@web.middleware
async def cors_middleware(request, handler):
    origin = request.headers.get("Origin", "")
    request_host = request.headers.get("Host", "")
    if origin and not is_allowed_origin(origin, request_host):
        return web.Response(status=403, text="Forbidden origin")
    if request.method == "OPTIONS":
        return web.Response(status=204, headers=cors_headers(origin, request_host))
    resp = await handler(request)
    for k, v in cors_headers(origin, request_host).items():
        resp.headers[k] = v
    return resp


def json_ok(data: dict, status: int = 200):
    return web.json_response(data, status=status, headers=cors_headers(), dumps=lambda x: json.dumps(x, ensure_ascii=False, default=str))


async def read_json(request, *, strict: bool = False, allow_empty: bool = False) -> dict:
    if request.can_read_body:
        try:
            data = await request.json()
            if isinstance(data, dict):
                return data
            if strict:
                raise web.HTTPBadRequest(
                    text=json.dumps({"error": "JSON body must be an object"}, ensure_ascii=False),
                    content_type="application/json",
                )
            return {}
        except Exception as e:
            if isinstance(e, web.HTTPException):
                raise
            if strict:
                raise web.HTTPBadRequest(
                    text=json.dumps({"error": f"invalid JSON body: {e}"}, ensure_ascii=False),
                    content_type="application/json",
                )
            return {}
    if strict and not allow_empty:
        raise web.HTTPBadRequest(
            text=json.dumps({"error": "JSON body is required"}, ensure_ascii=False),
            content_type="application/json",
        )
    return {}


async def status_handler(request):
    return json_ok({
        "ok": True,
        "running": True,
        "ready": True,
        **project_root_payload(),
        "sessionCount": len(manager.sessions),
        "activeSessionId": manager.active_session_id,
        "ws": "/ws",
        "transport": {"http": True, "wsEventsOnly": True},
    })


async def get_config_handler(request):
    return json_ok({**project_root_payload(), "config": manager.reload_config()})


async def save_config_handler(request):
    data = await read_json(request, strict=True)
    cfg = json_object_payload(data, "config")
    manager.save_config(cfg)
    return json_ok({"ok": True, **project_root_payload(), "config": manager.config})


async def api_config_handler(request):
    return json_ok(load_api_config(Path(manager.project_root)))


async def save_api_config_handler(request):
    data = await read_json(request, strict=True)
    cfg = json_object_payload(data, "config")
    try:
        return json_ok({"ok": True, **save_api_config(Path(manager.project_root), cfg)})
    except Exception as e:
        return json_ok({"ok": False, "error": str(e)}, status=400)


async def delete_api_config_handler(request):
    name = request.match_info["name"]
    try:
        return json_ok({"ok": True, **delete_api_config(Path(manager.project_root), name)})
    except Exception as e:
        return json_ok({"ok": False, "error": str(e)}, status=400)


def api_models_url(apibase: str) -> str:
    base = str(apibase or "").strip().rstrip("/")
    if not base:
        raise ValueError("API Base 不能为空")
    return f"{base}/models"


def api_endpoint_url(apibase: str, path: str) -> str:
    base = str(apibase or "").strip().rstrip("/")
    endpoint = str(path or "").strip("/")
    if not base:
        raise ValueError("API Base 不能为空")
    if not endpoint:
        raise ValueError("API path 不能为空")
    if base.endswith(endpoint):
        return base
    return f"{base}/{endpoint}"


def parse_api_models_payload(payload) -> list[dict]:
    data = payload.get("data") if isinstance(payload, dict) else payload
    if isinstance(data, dict):
        data = data.get("models") or data.get("data") or []
    if not isinstance(data, list):
        data = []
    models = []
    seen = set()
    for item in data:
        if isinstance(item, str):
            model_id = item.strip()
            model_name = model_id
        elif isinstance(item, dict):
            model_id = str(item.get("id") or item.get("model") or item.get("name") or "").strip()
            model_name = str(item.get("display_name") or item.get("name") or model_id).strip()
        else:
            continue
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        models.append({"id": model_id, "name": model_name or model_id})
    return models


async def fetch_api_models(config: dict) -> list[dict]:
    cfg = dict(config or {})
    apikey = str(cfg.get("apikey") or "").strip()
    if not apikey:
        raise ValueError("请输入 API Key 后再获取模型")
    url = api_models_url(cfg.get("apibase") or cfg.get("base_url") or "")
    cfg_type = str(cfg.get("type") or "native_oai")
    headers = {"Accept": "application/json"}
    if cfg_type == "native_anthropic":
        headers["x-api-key"] = apikey
        headers["anthropic-version"] = "2023-06-01"
    else:
        headers["Authorization"] = f"Bearer {apikey}"
    timeout = ClientTimeout(total=20)
    async with ClientSession(timeout=timeout) as session:
        async with session.get(url, headers=headers) as resp:
            text = await resp.text()
            if resp.status < 200 or resp.status >= 300:
                raise ValueError(f"获取模型失败：HTTP {resp.status} {text[:300]}")
            try:
                payload = json.loads(text)
            except Exception as e:
                raise ValueError(f"模型接口返回的不是 JSON：{e}") from e
    models = parse_api_models_payload(payload)
    if not models:
        raise ValueError("模型接口没有返回可用模型")
    return models


def _api_response_content_text(value) -> str:
    if value in (None, ""):
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        parts = []
        for item in value:
            text = _api_response_content_text(item)
            if text:
                parts.append(text)
        return "\n".join(parts).strip()
    if isinstance(value, dict):
        for key in ("text", "output_text", "content", "reasoning_content", "answer", "response", "result", "completion"):
            text = _api_response_content_text(value.get(key))
            if text:
                return text
    return ""


def parse_api_test_response_payload(payload, api_mode: str = "chat_completions") -> str:
    if not isinstance(payload, dict):
        return ""
    output_text = _api_response_content_text(payload.get("output_text"))
    if output_text:
        return output_text
    for item in payload.get("content") or []:
        text = _api_response_content_text(item)
        if text:
            return text
    for item in payload.get("output") or []:
        text = _api_response_content_text(item)
        if text:
            return text
        text = _api_response_content_text(item.get("content") if isinstance(item, dict) else item)
        if text:
            return text
    choices = payload.get("choices") or []
    if choices:
        choice = choices[0] if isinstance(choices[0], dict) else {}
        message = choice.get("message") if isinstance(choice, dict) else {}
        text = _api_response_content_text(message.get("content") if isinstance(message, dict) else message)
        if text:
            return text
        text = _api_response_content_text(message)
        if text:
            return text
        text = _api_response_content_text(choice.get("text"))
        if text:
            return text
    for key in ("text", "message"):
        text = _api_response_content_text(payload.get(key))
        if text:
            return text
    return ""


def _api_response_raw_preview(payload) -> str:
    try:
        raw = json.dumps(payload, ensure_ascii=False, default=str)
    except Exception:
        raw = str(payload)
    return raw[:1000]


def _api_response_has_model_shape(payload) -> bool:
    if not isinstance(payload, dict):
        return False
    if isinstance(payload.get("choices"), list):
        return True
    if isinstance(payload.get("output"), list):
        return True
    if isinstance(payload.get("content"), list):
        return True
    if "output_text" in payload or "text" in payload or "message" in payload:
        return True
    obj = str(payload.get("object") or "").lower()
    if obj in {"chat.completion", "response", "message"}:
        return True
    return False


def _api_test_request(config: dict) -> tuple[str, dict, dict]:
    cfg = dict(config or {})
    cfg_type = str(cfg.get("type") or "native_oai").strip()
    apikey = str(cfg.get("apikey") or "").strip()
    apibase = str(cfg.get("apibase") or cfg.get("base_url") or "").strip()
    model = str(cfg.get("model") or "").strip()
    if not apikey:
        raise ValueError("请输入 API Key 后再测试响应")
    if not apibase:
        raise ValueError("请先填写 API Base")
    if not model:
        raise ValueError("请先填写 Model")
    if cfg_type == "native_anthropic":
        url = api_endpoint_url(apibase, "messages")
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "x-api-key": apikey,
            "anthropic-version": "2023-06-01",
        }
        payload = {
            "model": model,
            "max_tokens": API_TEST_MAX_TOKENS,
            "messages": [{"role": "user", "content": API_TEST_PROMPT}],
        }
        return url, headers, payload

    mode = str(cfg.get("api_mode") or "chat_completions").strip().lower().replace("-", "_")
    api_mode = "responses" if mode in {"response", "responses"} else "chat_completions"
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {apikey}",
        "Content-Type": "application/json",
    }
    if api_mode == "responses":
        return api_endpoint_url(apibase, "responses"), headers, {
            "model": model,
            "input": API_TEST_PROMPT,
            "max_output_tokens": API_TEST_MAX_TOKENS,
            "stream": False,
        }
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": API_TEST_PROMPT}],
        "stream": False,
    }
    model_lower = model.lower()
    if model_lower.startswith(("gpt-5", "o1", "o2", "o3", "o4")):
        payload["max_completion_tokens"] = API_TEST_MAX_TOKENS
    else:
        payload["max_tokens"] = API_TEST_MAX_TOKENS
    return api_endpoint_url(apibase, "chat/completions"), headers, payload


async def test_api_response(config: dict) -> dict:
    cfg = dict(config or {})
    url, headers, payload = _api_test_request(cfg)
    mode = str(cfg.get("api_mode") or "chat_completions").strip().lower().replace("-", "_")
    api_mode = "responses" if mode in {"response", "responses"} else "chat_completions"
    started = time.monotonic()
    timeout = ClientTimeout(total=30)
    async with ClientSession(timeout=timeout) as session:
        async with session.post(url, headers=headers, json=payload) as resp:
            text = await resp.text()
            if resp.status < 200 or resp.status >= 300:
                raise ValueError(f"测试响应失败：HTTP {resp.status} {text[:300]}")
            try:
                response_payload = json.loads(text)
            except Exception as e:
                raise ValueError(f"测试响应返回的不是 JSON：{e}") from e
    response_text = parse_api_test_response_payload(response_payload, api_mode)
    if not response_text and not _api_response_has_model_shape(response_payload):
        raise ValueError(f"测试响应不是兼容的模型响应：{_api_response_raw_preview(response_payload)}")
    elapsed_ms = int((time.monotonic() - started) * 1000)
    return {
        "ok": True,
        "model": str(response_payload.get("model") or cfg.get("model") or "").strip(),
        "text": response_text[:500],
        "emptyText": not bool(response_text),
        "rawPreview": _api_response_raw_preview(response_payload),
        "elapsedMs": elapsed_ms,
    }


async def fetch_api_models_handler(request):
    data = await read_json(request, strict=True)
    cfg = json_object_payload(data, "config")
    try:
        cfg = resolve_api_fetch_config(Path(manager.project_root), cfg)
        models = await fetch_api_models(cfg)
        return json_ok({"ok": True, "models": models})
    except Exception as e:
        return json_ok({"ok": False, "error": str(e)}, status=400)


async def test_api_config_handler(request):
    data = await read_json(request, strict=True)
    cfg = json_object_payload(data, "config")
    try:
        cfg = resolve_api_fetch_config(Path(manager.project_root), cfg)
        result = await test_api_response(cfg)
        return json_ok(result)
    except Exception as e:
        return json_ok({"ok": False, "error": str(e)}, status=400)


def invalidate_runtime_registry():
    with manager.lock:
        for sess in manager.sessions.values():
            agent = getattr(sess, "agent", None)
            if not agent:
                continue
            if getattr(agent, "mcp_manager", None) is not None:
                with contextlib.suppress(Exception):
                    agent.mcp_manager.disconnect_all()
                agent.mcp_manager = None
                agent.mcp_tool_schemas = []
            if getattr(agent, "llmclient", None) is not None:
                agent.llmclient.last_tools = ""
    with contextlib.suppress(Exception):
        from skill_registry import reset_skill_cache
        reset_skill_cache()
    with contextlib.suppress(Exception):
        from agent_registry import reset_agent_cache
        reset_agent_cache()


async def save_mcp_config_handler(request):
    data = await read_json(request, strict=True)
    cfg = json_object_payload(data, "config")
    try:
        saved = save_mcp_server(Path(manager.project_root), cfg)
    except Exception as e:
        return json_ok({"ok": False, "error": str(e)}, status=400)
    invalidate_runtime_registry()
    manager.reload_config()
    return json_ok({
        "ok": True,
        "saved": saved,
        **build_registry(Path(manager.project_root), custom_skill_dirs=manager.custom_skill_dirs()),
    })


async def save_skill_config_handler(request):
    data = await read_json(request, strict=True)
    cfg = json_object_payload(data, "config")
    try:
        saved = save_project_skill(Path(manager.project_root), cfg)
    except Exception as e:
        return json_ok({"ok": False, "error": str(e)}, status=400)
    invalidate_runtime_registry()
    manager.reload_config()
    return json_ok({
        "ok": True,
        "saved": saved,
        **build_registry(Path(manager.project_root), custom_skill_dirs=manager.custom_skill_dirs()),
    })


async def save_agent_config_handler(request):
    data = await read_json(request, strict=True)
    cfg = json_object_payload(data, "config")
    try:
        saved = save_project_agent(Path(manager.project_root), cfg)
    except Exception as e:
        return json_ok({"ok": False, "error": str(e)}, status=400)
    invalidate_runtime_registry()
    manager.reload_config()
    return json_ok({
        "ok": True,
        "saved": saved,
        **build_registry(Path(manager.project_root), custom_skill_dirs=manager.custom_skill_dirs()),
    })


async def delete_mcp_config_handler(request):
    name = request.match_info["name"]
    try:
        deleted = delete_project_mcp_server(Path(manager.project_root), name)
    except Exception as e:
        return json_ok({"ok": False, "error": str(e)}, status=400)
    invalidate_runtime_registry()
    manager.reload_config()
    return json_ok({
        "ok": True,
        "deleted": deleted,
        **build_registry(Path(manager.project_root), custom_skill_dirs=manager.custom_skill_dirs()),
    })


async def delete_skill_config_handler(request):
    name = request.match_info["name"]
    try:
        deleted = delete_project_skill(Path(manager.project_root), name)
    except Exception as e:
        return json_ok({"ok": False, "error": str(e)}, status=400)
    invalidate_runtime_registry()
    manager.reload_config()
    return json_ok({
        "ok": True,
        "deleted": deleted,
        **build_registry(Path(manager.project_root), custom_skill_dirs=manager.custom_skill_dirs()),
    })


async def delete_agent_config_handler(request):
    name = request.match_info["name"]
    try:
        deleted = delete_project_agent(Path(manager.project_root), name)
    except Exception as e:
        return json_ok({"ok": False, "error": str(e)}, status=400)
    invalidate_runtime_registry()
    manager.reload_config()
    return json_ok({
        "ok": True,
        "deleted": deleted,
        **build_registry(Path(manager.project_root), custom_skill_dirs=manager.custom_skill_dirs()),
    })


async def registry_handler(request):
    manager.reload_config()
    return json_ok({"ok": True, **build_registry(Path(manager.project_root), custom_skill_dirs=manager.custom_skill_dirs())})


async def save_registry_handler(request):
    data = await read_json(request, strict=True)
    for key in ("mcpServers", "skills", "tools", "agents"):
        if key in data and not isinstance(data.get(key), dict):
            raise web.HTTPBadRequest(
                text=json.dumps({"error": f"invalid object field: {key}"}, ensure_ascii=False),
                content_type="application/json",
            )
    save_registry_state(Path(manager.project_root), data)
    disabled_tools = disabled_names(Path(manager.project_root), "tools")
    with manager.lock:
        for sess in manager.sessions.values():
            agent = getattr(sess, "agent", None)
            if not agent:
                continue
            if hasattr(agent, "activated_tools"):
                agent.activated_tools = set(getattr(agent, "activated_tools", set())) - disabled_tools
            if getattr(agent, "mcp_manager", None) is not None:
                with contextlib.suppress(Exception):
                    agent.mcp_manager.disconnect_all()
                agent.mcp_manager = None
                agent.mcp_tool_schemas = []
            if getattr(agent, "llmclient", None) is not None:
                agent.llmclient.last_tools = ""
    invalidate_runtime_registry()
    return json_ok({"ok": True, **build_registry(Path(manager.project_root), custom_skill_dirs=manager.custom_skill_dirs())})


async def model_profiles_handler(request):
    return json_ok({"profiles": manager.list_model_profiles()})


async def list_sessions_handler(request):
    with manager.lock:
        sessions = [manager.snapshot(s, include_messages=False) for s in manager.sessions.values()]
    return json_ok({"sessions": sessions, "activeSessionId": manager.active_session_id})


async def new_session_handler(request):
    data = await read_json(request, strict=True, allow_empty=True)
    llm_no = json_optional_int_field(data, "llmNo", "llm_no", minimum=0)
    if llm_no is None:
        saved_llm_no = manager.config.get("llmNo")
        llm_no = saved_llm_no if isinstance(saved_llm_no, int) and saved_llm_no >= 0 else 0
    requested_permission_mode = data.get("permissionMode") or data.get("permission_mode")
    if requested_permission_mode:
        permission_mode = requested_permission_mode
    else:
        saved_permission_mode = manager.config.get("permissionMode")
        permission_mode = saved_permission_mode if saved_permission_mode in PERMISSION_MODES else "default"
    memory_reference_enabled = json_optional_bool_field(data, "memoryReferenceEnabled", "memory_reference_enabled")
    if memory_reference_enabled is None:
        saved_memory_enabled = manager.config.get("memoryReferenceEnabled")
        memory_reference_enabled = saved_memory_enabled if isinstance(saved_memory_enabled, bool) else True
    sess = manager.create_session(
        cwd=data.get("cwd") or data.get("path"),
        llm_no=llm_no,
        permission_mode=permission_mode,
        memory_reference_enabled=memory_reference_enabled,
    )
    return json_ok({"ok": True, "sessionId": sess.id, "session": manager.snapshot(sess)}, status=201)


async def get_session_handler(request):
    sid = request.match_info["sid"]
    sess = manager.get_session(sid)
    return json_ok({"sessionId": sid, "session": manager.snapshot(sess), "messages": list(sess.messages), "partial": sess.partial})


async def delete_session_handler(request):
    sid = request.match_info["sid"]
    return json_ok(manager.delete_session(sid))


async def prompt_handler(request):
    sid = request.match_info["sid"]
    data = await read_json(request, strict=True, allow_empty=True)
    prompt = data.get("prompt", data.get("content", data.get("message", "")))
    display_prompt = data.get("displayPrompt", data.get("display_prompt", None))
    images = json_list_field(data, "images")
    files = json_list_field(data, "files")
    if not has_prompt_payload(prompt, images, files):
        raise empty_prompt_error()
    llm_no = json_optional_int_field(data, "llmNo", "llm_no", minimum=0)
    force = bool(data.get("force") or data.get("interruptRunning"))
    web_verbs_enabled = bool(data.get("webVerbsEnabled") or data.get("web_verbs_enabled"))
    return json_ok(manager.submit_prompt(sid, prompt, images, files=files, llm_no=llm_no, force=force, display_prompt=display_prompt, web_verbs_enabled=web_verbs_enabled))


async def session_model_handler(request):
    sid = request.match_info["sid"]
    data = await read_json(request, strict=True)
    llm_no = json_int_field(data, "llmNo", "llm_no", minimum=0)
    return json_ok(manager.set_session_model(sid, llm_no))


async def session_runtime_reset_handler(request):
    sid = request.match_info["sid"]
    await read_json(request, strict=True, allow_empty=True)
    return json_ok(manager.reset_session_runtime(sid))


async def session_runtime_log_handler(request):
    sid = request.match_info["sid"]
    return json_ok(manager.session_runtime_log(sid))


async def session_export_handler(request):
    sid = request.match_info["sid"]
    return json_ok(manager.export_session(sid))


async def session_permission_mode_handler(request):
    sid = request.match_info["sid"]
    data = await read_json(request, strict=True)
    mode = json_str_field(data, "mode", "permissionMode")
    return json_ok(manager.set_session_permission_mode(sid, mode))


def query_int(request, *names: str, default: int = 0, minimum: Optional[int] = None) -> int:
    raw = next((request.query.get(name) for name in names if request.query.get(name) is not None), None)
    if raw in (None, ""):
        value = default
    else:
        try:
            value = int(raw)
        except (TypeError, ValueError):
            label = "/".join(names)
            raise web.HTTPBadRequest(text=json.dumps({"error": f"invalid integer query parameter: {label}"}, ensure_ascii=False), content_type="application/json")
    if minimum is not None and value < minimum:
        label = "/".join(names)
        raise web.HTTPBadRequest(text=json.dumps({"error": f"query parameter must be >= {minimum}: {label}"}, ensure_ascii=False), content_type="application/json")
    return value


def json_field(data: dict, *names: str):
    missing = object()
    raw = next((data.get(name) for name in names if name in data), missing)
    if raw is missing:
        label = "/".join(names)
        raise web.HTTPBadRequest(text=json.dumps({"error": f"missing JSON field: {label}"}, ensure_ascii=False), content_type="application/json")
    return raw


def json_object_payload(data: dict, name: str) -> dict:
    if name not in data:
        return data
    raw = data.get(name)
    if not isinstance(raw, dict):
        raise web.HTTPBadRequest(text=json.dumps({"error": f"invalid object field: {name}"}, ensure_ascii=False), content_type="application/json")
    return raw


def json_int_field(data: dict, *names: str, minimum: Optional[int] = None) -> int:
    label = "/".join(names)
    raw = json_field(data, *names)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise web.HTTPBadRequest(text=json.dumps({"error": f"invalid integer field: {label}"}, ensure_ascii=False), content_type="application/json")
    if minimum is not None and value < minimum:
        raise web.HTTPBadRequest(text=json.dumps({"error": f"field must be >= {minimum}: {label}"}, ensure_ascii=False), content_type="application/json")
    return value


def json_optional_int_field(data: dict, *names: str, minimum: Optional[int] = None) -> Optional[int]:
    if not any(name in data for name in names):
        return None
    return json_int_field(data, *names, minimum=minimum)


def json_optional_bool_field(data: dict, *names: str) -> Optional[bool]:
    raw = next((data.get(name) for name in names if name in data), None)
    if raw is None:
        return None
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str):
        lowered = raw.strip().lower()
        if lowered in {"1", "true", "yes", "on", "enabled"}:
            return True
        if lowered in {"0", "false", "no", "off", "disabled"}:
            return False
    raise web.HTTPBadRequest(text=json.dumps({"error": f"invalid boolean field: {'/'.join(names)}"}, ensure_ascii=False), content_type="application/json")


def json_str_field(data: dict, *names: str) -> str:
    label = "/".join(names)
    raw = json_field(data, *names)
    if not isinstance(raw, str) or not raw:
        raise web.HTTPBadRequest(text=json.dumps({"error": f"invalid string field: {label}"}, ensure_ascii=False), content_type="application/json")
    return raw


def json_list_field(data: dict, name: str, default: Optional[list] = None) -> list:
    if name not in data:
        return list(default or [])
    raw = data.get(name)
    if not isinstance(raw, list):
        raise web.HTTPBadRequest(text=json.dumps({"error": f"invalid list field: {name}"}, ensure_ascii=False), content_type="application/json")
    return raw


def has_prompt_payload(prompt: Any, images: list, files: Optional[list] = None) -> bool:
    if images or files:
        return True
    if isinstance(prompt, list):
        return bool(prompt)
    return bool(str(prompt or "").strip())


def has_normalized_prompt_payload(prompt: Any, image_ids: list, file_refs: Optional[list] = None) -> bool:
    return bool(image_ids) or bool(file_refs) or bool(str(prompt or "").strip())


def empty_prompt_error():
    return web.HTTPBadRequest(text=json.dumps({"error": "prompt, images or files is required"}, ensure_ascii=False), content_type="application/json")


async def messages_handler(request):
    sid = request.match_info["sid"]
    after = query_int(request, "after", "afterId", default=0, minimum=0)
    limit = query_int(request, "limit", default=200, minimum=0)
    return json_ok(manager.messages(sid, after=after, limit=limit))


async def cancel_handler(request):
    sid = request.match_info["sid"]
    return json_ok(manager.cancel(sid))


async def permission_handler(request):
    sid = request.match_info["sid"]
    request_id = request.match_info["rid"]
    data = await read_json(request, strict=True)
    decision = json_str_field(data, "decision", "action")
    answer = data.get("answer") or ""
    return json_ok(manager.resolve_permission(sid, request_id, str(decision), str(answer)))


OPEN_TARGETS = {
    "mykeyTemplate": "mykey_template.py",
}


def resolve_open_target(root: Path, data: dict) -> Path:
    root = Path(root).resolve()
    data = data if isinstance(data, dict) else {}
    kind = str(data.get("kind") or "")
    if kind in OPEN_TARGETS:
        return root / OPEN_TARGETS[kind]
    if kind:
        raise web.HTTPBadRequest(text=json.dumps({"error": f"unknown open target kind: {kind}"}, ensure_ascii=False), content_type="application/json")
    raw_path = data.get("path") or data.get("target")
    if not raw_path:
        return root
    target = Path(str(raw_path))
    if not target.is_absolute():
        target = root / target
    target = target.resolve()
    if not target.is_relative_to(root):
        raise web.HTTPBadRequest(text=json.dumps({"error": f"path is outside project root: {target}"}, ensure_ascii=False), content_type="application/json")
    return target


async def path_open_handler(request):
    data = await read_json(request, strict=True)
    target = resolve_open_target(Path(manager.project_root), data).resolve()
    if not target.exists():
        return json_ok({"ok": False, "error": f"File not found: {target}"})
    # Actually open the file with the system default editor
    import subprocess, platform
    if platform.system() == "Windows":
        os.startfile(str(target))
    elif platform.system() == "Darwin":
        subprocess.Popen(["open", str(target)])
    else:
        subprocess.Popen(["xdg-open", str(target)])
    return json_ok({"ok": True, "path": str(target)})


async def flag_oracle_summary_handler(request):
    try:
        limit = max(1, min(int(request.query.get("limit", "30")), 200))
    except (TypeError, ValueError):
        return json_ok({"ok": False, "error": "limit must be an integer"}, status=400)

    config = FlagOracleConfig.from_env(
        agent_id=os.environ.get("CTF_AGENT_ID", "secheur-agent"),
        run_id="dashboard",
    )
    try:
        summary = await asyncio.to_thread(FlagOracleClient(config).summary, limit)
        return json_ok(summary)
    except FlagOracleError as exc:
        return json_ok(
            {
                "ok": False,
                "status": "offline",
                "error": str(exc),
                "totals": {
                    "challenges": 0,
                    "solvedChallenges": 0,
                    "attempts": 0,
                    "correctAttempts": 0,
                    "incorrectAttempts": 0,
                },
                "challenges": [],
                "recentAttempts": [],
            },
            status=503,
        )


async def flag_oracle_attempts_handler(request):
    try:
        limit = max(1, min(int(request.query.get("limit", "50")), 200))
    except (TypeError, ValueError):
        return json_ok({"ok": False, "error": "limit must be an integer"}, status=400)

    challenge_id = (
        request.query.get("challengeId")
        or request.query.get("challenge_id")
        or request.query.get("target_id")
        or ""
    )
    config = FlagOracleConfig.from_env(
        agent_id=os.environ.get("CTF_AGENT_ID", "secheur-agent"),
        run_id="dashboard",
    )
    try:
        payload = await asyncio.to_thread(
            FlagOracleClient(config).attempts,
            challenge_id=challenge_id or None,
            limit=limit,
        )
        return json_ok(payload)
    except FlagOracleError as exc:
        return json_ok(
            {
                "ok": False,
                "status": "offline",
                "error": str(exc),
                "challengeId": challenge_id or None,
                "totals": {
                    "attempts": 0,
                    "correctAttempts": 0,
                    "incorrectAttempts": 0,
                    "unknownAttempts": 0,
                },
                "attempts": [],
            },
            status=503,
        )


def create_app():
    app = web.Application(middlewares=[cors_middleware], client_max_size=MAX_REQUEST_BYTES)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/status", status_handler)
    app.router.add_get("/config", get_config_handler)
    app.router.add_post("/config", save_config_handler)
    app.router.add_get("/api-config", api_config_handler)
    app.router.add_post("/api-config", save_api_config_handler)
    app.router.add_post("/api-config/models", fetch_api_models_handler)
    app.router.add_post("/api-config/test", test_api_config_handler)
    app.router.add_delete("/api-config/{name}", delete_api_config_handler)
    app.router.add_post("/mcp-config", save_mcp_config_handler)
    app.router.add_post("/skill-config", save_skill_config_handler)
    app.router.add_post("/agent-config", save_agent_config_handler)
    app.router.add_delete("/mcp-config/{name}", delete_mcp_config_handler)
    app.router.add_delete("/skill-config/{name}", delete_skill_config_handler)
    app.router.add_delete("/agent-config/{name}", delete_agent_config_handler)
    app.router.add_get("/registry", registry_handler)
    app.router.add_post("/registry", save_registry_handler)
    app.router.add_get("/model-profiles", model_profiles_handler)
    app.router.add_get("/sessions", list_sessions_handler)
    app.router.add_post("/session/new", new_session_handler)
    app.router.add_get("/session/{sid}", get_session_handler)
    app.router.add_delete("/session/{sid}", delete_session_handler)
    app.router.add_post("/session/{sid}/prompt", prompt_handler)
    app.router.add_post("/session/{sid}/model", session_model_handler)
    app.router.add_post("/session/{sid}/runtime/reset", session_runtime_reset_handler)
    app.router.add_get("/session/{sid}/runtime/log", session_runtime_log_handler)
    app.router.add_get("/session/{sid}/export", session_export_handler)
    app.router.add_post("/session/{sid}/permission-mode", session_permission_mode_handler)
    app.router.add_get("/session/{sid}/messages", messages_handler)
    app.router.add_post("/session/{sid}/cancel", cancel_handler)
    app.router.add_post("/session/{sid}/permission/{rid}", permission_handler)
    app.router.add_post("/path/open", path_open_handler)
    app.router.add_get("/api/ctf-oracle/summary", flag_oracle_summary_handler)
    app.router.add_get("/api/ctf-oracle/attempts", flag_oracle_attempts_handler)

    # Serve static frontend (desktop/static/)
    static_dir = APP_DIR / "desktop" / "static"

    async def index_handler(request):
        return web.FileResponse(static_dir / "index.html")

    async def benchmark_dashboard_handler(request):
        return web.FileResponse(PROJECT_DIR / "ctf-benchmark-dashboard" / "index.html")

    app.router.add_get("/", index_handler)
    app.router.add_get("/benchmark-dashboard", benchmark_dashboard_handler)
    app.router.add_get("/benchmark-dashboard/", benchmark_dashboard_handler)
    app.router.add_static("/", static_dir, show_index=False)

    async def on_startup(app):
        hub.loop = asyncio.get_running_loop()
        poller = SchedulerPoller(manager)
        app[SCHEDULER_POLLER_KEY] = poller
        app[SCHEDULER_TASK_KEY] = asyncio.create_task(poller.run())

    async def on_cleanup(app):
        poller = app.get(SCHEDULER_POLLER_KEY)
        if poller is not None:
            poller.stop()
        task = app.get(SCHEDULER_TASK_KEY)
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


if __name__ == "__main__":
    host = os.environ.get("BRIDGE_HOST", "127.0.0.1")
    port = int(os.environ.get("BRIDGE_PORT", "14168"))
    print(f"SecHeur Agent bridge: http://{host}:{port}  ws://{host}:{port}/ws", file=sys.stderr)
    web.run_app(create_app(), host=host, port=port, print=None)
