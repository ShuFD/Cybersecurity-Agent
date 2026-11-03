from __future__ import annotations

import copy
import hashlib
import json
import threading
from functools import wraps
from typing import Any, Dict, Iterable, Optional

from .consistency import args_digest


def _synchronized(method):
    @wraps(method)
    def wrapped(self, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)

    return wrapped


MANAGEMENT_TOOLS = {
    "ask_user",
    "exit_plan_mode",
    "mcp_refresh",
    "no_tool",
    "plan_expand",
    "plan_revise",
    "plan_status",
    "start_long_term_update",
    "tool_search",
    "update_working_checkpoint",
}
DETERMINISTIC_TOOLS = {
    "file_read",
    "grep_search",
    "list_files",
    "memory_search",
    "plan_status",
}
FAILURE_STATUSES = {
    "blocked",
    "denied",
    "error",
    "failed",
    "failure",
    "hook_blocked",
    "not_found",
    "parse_error",
    "permission_denied",
    "permission_required",
    "stale_file",
    "timeout",
    "timed_out",
}
TRANSIENT_STATUSES = {"timeout", "timed_out", "network_timeout", "cancelled"}
VOLATILE_RESULT_KEYS = {
    "cf_ray",
    "completed_at",
    "created_at",
    "date",
    "duration",
    "elapsed",
    "evidence_id",
    "execution_id",
    "request_id",
    "server_timing",
    "timestamp",
    "trace_id",
    "traceparent",
    "ts",
    "updated_at",
    "x_amzn_trace_id",
    "x_request_id",
}


def _result_status(result: Any) -> str:
    if not isinstance(result, dict):
        return "success"
    data = result
    while isinstance(data, dict):
        nested = data.get("data")
        if isinstance(nested, dict):
            data = nested
            continue
        nested = data.get("result")
        if isinstance(nested, dict):
            data = nested
            continue
        break
    status = str(data.get("status") or result.get("status") or "success").strip().lower()
    if data.get("timed_out") is True:
        return "timed_out"
    if data.get("success") is False or data.get("ok") is False:
        return "failed"
    if isinstance(data.get("exit_code"), int) and data.get("exit_code") != 0:
        return "failed"
    return status


def _stable_result(value: Any, depth: int = 0) -> Any:
    if depth > 8:
        return "<max-depth>"
    if isinstance(value, dict):
        return {
            str(key): _stable_result(child, depth + 1)
            for key, child in sorted(value.items(), key=lambda item: str(item[0]))
            if str(key).strip().lower().replace("-", "_") not in VOLATILE_RESULT_KEYS
        }
    if isinstance(value, (list, tuple)):
        return [_stable_result(item, depth + 1) for item in list(value)[:200]]
    if isinstance(value, str) and len(value) > 20_000:
        return value[:20_000]
    return value


def _result_digest(result: Any) -> str:
    payload = json.dumps(_stable_result(result), ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode("utf-8", errors="replace")).hexdigest()[:16]


def _useful_fact_keys(keys: Iterable[Any]) -> list[str]:
    return sorted(
        {
            str(key)
            for key in keys or []
            if key and not str(key).startswith("runtime.") and not str(key).startswith("observation.")
        }
    )


def _has_meaningful_result(result: Any) -> bool:
    if result is None:
        return False
    if isinstance(result, str):
        return bool(result.strip())
    if isinstance(result, (dict, list, tuple, set)):
        return bool(result)
    return True


class ProgressController:
    """Task-scoped authority for progress, duplicate calls, replanning, and terminal state."""

    def __init__(self, *, replan_after: int = 4, phase_replan_after: int = 8, stop_after: int = 12):
        self.replan_after = max(2, int(replan_after))
        self.phase_replan_after = max(self.replan_after + 1, int(phase_replan_after))
        self.stop_after = max(self.phase_replan_after + 1, int(stop_after))
        self.state: Dict[str, Any] = {
            "phase": "investigate",
            "evidence_revision": 0,
            "last_progress_turn": 0,
            "no_progress_streak": 0,
            "candidate_state": "none",
            "verification_state": "not_attempted",
            "terminal_state": None,
            "last_decision": None,
            "fingerprints": {},
        }
        self._result_cache: Dict[str, Any] = {}
        self._seen_result_digests: set[str] = set()
        self._lock = threading.RLock()

    @_synchronized
    def before_tool(self, *, tool_name: str, args: Dict[str, Any], turn: int = 0) -> Dict[str, Any]:
        tool = str(tool_name or "")
        fingerprint = args_digest(tool, args or {})
        if self.state.get("terminal_state"):
            return {
                "action": "SHORT_CIRCUIT",
                "reason": "task_already_terminal",
                "fingerprint": fingerprint,
                "cached_result": {"status": "blocked", "reason": "task_already_terminal"},
            }
        if tool in {"verify_flag", "check_flag"}:
            self.state["candidate_state"] = "verifying"
            self.state["verification_state"] = "attempting"
            return {"action": "EXECUTE", "fingerprint": fingerprint}

        entry = (self.state.get("fingerprints") or {}).get(fingerprint) or {}
        same_context = int(entry.get("context_revision", -1)) == int(self.state.get("evidence_revision") or 0)
        no_progress_runs = int(entry.get("no_progress_runs") or 0)
        last_status = str(entry.get("last_status") or "")
        if same_context and no_progress_runs:
            retry_budget = 2 if tool not in DETERMINISTIC_TOOLS else 1
            if last_status in TRANSIENT_STATUSES:
                retry_budget = max(retry_budget, 2)
            if no_progress_runs >= retry_budget:
                cached = copy.deepcopy(self._result_cache.get(fingerprint))
                if cached is None:
                    cached = {"status": "repeated_noop"}
                return {
                    "action": "SHORT_CIRCUIT",
                    "reason": "same_call_without_new_evidence",
                    "fingerprint": fingerprint,
                    "repeat_count": int(entry.get("total_runs") or 0),
                    "cached_result": cached,
                    "turn": int(turn or 0),
                }
        return {"action": "EXECUTE", "fingerprint": fingerprint}

    @_synchronized
    def after_tool(
        self,
        *,
        tool_name: str,
        args: Dict[str, Any],
        result: Any,
        turn: int = 0,
        plan_summary: Optional[Dict[str, Any]] = None,
        preflight: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        tool = str(tool_name or "")
        fingerprint = str((preflight or {}).get("fingerprint") or args_digest(tool, args or {}))
        status = _result_status(result)
        digest = _result_digest(result)
        entry = self.state.setdefault("fingerprints", {}).setdefault(fingerprint, {})
        plan_summary = plan_summary or {}
        changed_fact_keys = _useful_fact_keys(plan_summary.get("changed_fact_keys") or [])
        short_circuited = (preflight or {}).get("action") == "SHORT_CIRCUIT"
        management = tool in MANAGEMENT_TOOLS
        failed = status in FAILURE_STATUSES
        unchanged = status in {"unchanged", "repeated_noop"} or short_circuited
        novel_result = digest != entry.get("last_result_digest")
        verified = tool in {"verify_flag", "check_flag", "no_tool"} and isinstance(result, dict) and result.get("correct") is True
        rejected = tool in {"verify_flag", "check_flag", "no_tool"} and isinstance(result, dict) and result.get("correct") is False
        blocked_verification = tool in {"verify_flag", "check_flag"} and status in FAILURE_STATUSES
        useful_progress = bool(
            verified
            or changed_fact_keys
            or (
                novel_result
                and _has_meaningful_result(result)
                and not management
                and not failed
                and not unchanged
            )
        )

        current_revision = int(self.state.get("evidence_revision") or 0)
        if int(entry.get("context_revision", -1)) != current_revision:
            entry["context_revision"] = current_revision
            entry["no_progress_runs"] = 0
        entry["total_runs"] = int(entry.get("total_runs") or 0) + (0 if short_circuited else 1)
        entry["short_circuits"] = int(entry.get("short_circuits") or 0) + (1 if short_circuited else 0)
        entry["last_status"] = status
        entry["last_result_digest"] = digest
        entry["last_turn"] = int(turn or 0)
        self._result_cache[fingerprint] = copy.deepcopy(result)
        self._seen_result_digests.add(digest)

        if useful_progress:
            if not verified:
                self.state["phase"] = "investigate"
            self.state["evidence_revision"] = current_revision + 1
            self.state["last_progress_turn"] = int(turn or 0)
            self.state["no_progress_streak"] = 0
            entry["context_revision"] = self.state["evidence_revision"]
            entry["no_progress_runs"] = 0
        else:
            self.state["no_progress_streak"] = int(self.state.get("no_progress_streak") or 0) + 1
            entry["no_progress_runs"] = int(entry.get("no_progress_runs") or 0) + 1

        if verified:
            self.state["phase"] = "complete"
            self.state["candidate_state"] = "accepted"
            self.state["verification_state"] = "accepted"
            self.state["terminal_state"] = "solved"
            action, reason = "STOP_SOLVED", "answer_verified"
        elif rejected:
            self.state["phase"] = "recover"
            self.state["candidate_state"] = "rejected"
            self.state["verification_state"] = "rejected"
            action, reason = "RECOVER_AFTER_REJECTION", "candidate_rejected"
        else:
            if blocked_verification:
                self.state["candidate_state"] = "rejected"
                self.state["verification_state"] = "rejected"
            streak = int(self.state.get("no_progress_streak") or 0)
            exact_repeat = int(entry.get("no_progress_runs") or 0) > 1 or short_circuited
            if streak >= self.stop_after:
                self.state["phase"] = "stuck"
                self.state["terminal_state"] = "stuck"
                action, reason = "STOP_STUCK", "no_useful_progress_budget_exhausted"
            elif streak >= self.phase_replan_after and streak % self.replan_after == 0:
                self.state["phase"] = "alternate"
                action, reason = "REPLAN_BRANCH", "phase_has_no_useful_progress"
            elif exact_repeat or (streak >= self.replan_after and streak % self.replan_after == 0):
                self.state["phase"] = "replan"
                action, reason = "REPLAN_BRANCH", "exact_repeat_without_new_evidence" if exact_repeat else "no_useful_progress"
            else:
                action, reason = "CONTINUE", "useful_progress" if useful_progress else "observe_more"

        decision = {
            "action": action,
            "reason": reason,
            "tool": tool,
            "fingerprint": fingerprint,
            "result_status": status,
            "result_digest": digest,
            "useful_progress": useful_progress,
            "changed_fact_keys": changed_fact_keys,
            "novel_result": novel_result,
            "short_circuited": short_circuited,
            "repeat_count": int(entry.get("total_runs") or 0),
            "no_progress_streak": int(self.state.get("no_progress_streak") or 0),
            "evidence_revision": int(self.state.get("evidence_revision") or 0),
            "turn": int(turn or 0),
        }
        self.state["last_decision"] = dict(decision)
        return decision

    def prompt_for(self, decision: Optional[Dict[str, Any]]) -> str:
        decision = decision or {}
        action = decision.get("action")
        if action == "REPLAN_BRANCH":
            phase_note = (
                " Abandon the current phase and switch to a different evidence source."
                if decision.get("reason") == "phase_has_no_useful_progress"
                else ""
            )
            return (
                "[Progress Controller] The current route produced no useful new evidence. "
                f"Reason: {decision.get('reason')}. Do not repeat fingerprint {decision.get('fingerprint')}. "
                "Revise or prune the nearest low-value branch and choose a different evidence-producing action."
                + phase_note
            )
        if action == "RECOVER_AFTER_REJECTION":
            return (
                "[Progress Controller] The candidate was rejected. Invalidate that candidate and its failed assumption. "
                "A new verification is allowed only after a tool produces useful new evidence."
            )
        if action == "STOP_STUCK":
            return (
                "[Progress Controller: STOP_STUCK] The no-progress budget is exhausted. "
                "Do not repeat the current route. Stop autonomous retries, preserve the collected evidence, "
                "and report the blocking unknown or request the missing input."
            )
        return ""

    @_synchronized
    def snapshot(self) -> Dict[str, Any]:
        fingerprints = self.state.get("fingerprints") or {}
        return {
            "phase": self.state.get("phase"),
            "evidence_revision": int(self.state.get("evidence_revision") or 0),
            "last_progress_turn": int(self.state.get("last_progress_turn") or 0),
            "no_progress_streak": int(self.state.get("no_progress_streak") or 0),
            "candidate_state": self.state.get("candidate_state"),
            "verification_state": self.state.get("verification_state"),
            "terminal_state": self.state.get("terminal_state"),
            "tracked_fingerprints": len(fingerprints),
            "short_circuits": sum(int(item.get("short_circuits") or 0) for item in fingerprints.values()),
            "last_decision": copy.deepcopy(self.state.get("last_decision")),
        }


__all__ = ["ProgressController"]
