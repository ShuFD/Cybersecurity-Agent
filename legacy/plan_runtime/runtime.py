from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from task_descriptor import TaskDescriptor, coerce_task_descriptor

from .evidence import EvidenceStore
from .consistency import build_replan_hint, classify_tool_call as classify_call
from .decisions import make_replan_decision, record_replan_decision
from .linter import lint_nodes
from .models import TERMINAL_STATUSES, VERSION, new_state, utc_now
from .persistence import append_event, load_state, save_state, state_lock
from .scheduler import refresh_schedule
from .templates import TASK_DESCRIPTOR_PLAN_VERSION, apply_initial_template
from .triage import apply_secondary_triage, sync_tool_catalog


PLAN_CONTROL_TOOLS = {"plan_expand", "plan_revise", "plan_status"}


def bind_runtime_to_parent(parent: Any, runtime: "PlanRuntime") -> None:
    if parent is None or runtime is None:
        return
    setattr(parent, "plan_runtime_state", runtime.state)
    setattr(parent, "plan_runtime_path", runtime.state.get("path"))
    setattr(parent, "plan_runtime_events_path", runtime.state.get("events_path"))


def _state_dir(*, run_dir: Optional[str], project_root: Optional[str]) -> Path:
    if run_dir:
        return Path(run_dir).expanduser().resolve(strict=False)
    root = Path(project_root or os.getcwd()).expanduser().resolve(strict=False)
    return root / "temp" / "plan_runtime"


def _failure_status(status: str) -> bool:
    return status in {
        "blocked",
        "error",
        "failed",
        "hook_blocked",
        "permission_denied",
        "permission_required",
        "stale_file",
    }


def _prompt_digest(prompt: Any) -> str:
    return hashlib.sha256(str(prompt or "").encode("utf-8", errors="replace")).hexdigest()[:16]


def _fact_snapshot(state: Dict[str, Any]) -> Dict[str, str]:
    return {
        key: json.dumps(record.get("value") if isinstance(record, dict) else record, ensure_ascii=False, sort_keys=True, default=str)
        for key, record in (state.get("facts") or {}).items()
        if not str(key).startswith("runtime.") and not str(key).startswith("observation.")
    }


def _prompt_args(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): "<redacted>" if str(key).lower() in {"authorization", "cookie", "password", "secret", "token"} else _prompt_args(child)
            for key, child in value.items()
        }
    if isinstance(value, list):
        return [_prompt_args(item) for item in value]
    return value


def _descendants(nodes: Dict[str, Dict[str, Any]], node_id: str) -> List[str]:
    out = []
    stack = [node_id]
    seen = set()
    while stack:
        current = stack.pop()
        if current in seen:
            continue
        seen.add(current)
        out.append(current)
        node = nodes.get(current) or {}
        stack.extend(node.get("children") or [])
        stack.extend(filter(None, (node.get("body"), node.get("then"), node.get("else"), node.get("on_unknown"))))
    return out


class PlanRuntime:
    def __init__(self, state: Dict[str, Any]):
        self.state = state

    @classmethod
    def initialize(
        cls,
        prompt: Any,
        *,
        task_descriptor: Optional[TaskDescriptor] = None,
        run_dir: Optional[str] = None,
        project_root: Optional[str] = None,
        enabled: bool = True,
    ) -> "PlanRuntime":
        root = _state_dir(run_dir=run_dir, project_root=project_root)
        root.mkdir(parents=True, exist_ok=True)
        descriptor = coerce_task_descriptor(
            task_descriptor,
            prompt=prompt,
            project_root=project_root,
            task_dir=run_dir,
        )
        existing_path = root / "plan_runtime.json"
        if existing_path.exists():
            try:
                existing = load_state(str(existing_path))
                existing_runtime = existing.get("runtime") or {}
                if (
                    existing.get("prompt_digest") == _prompt_digest(prompt)
                    and existing_runtime.get("task_descriptor_digest") == descriptor.prompt_digest
                    and existing_runtime.get("task_descriptor_plan_version") == TASK_DESCRIPTOR_PLAN_VERSION
                ):
                    return cls.resume(str(existing_path))
            except (OSError, TypeError, ValueError):
                pass
        state = new_state(
            prompt,
            path=str(root / "plan_runtime.json"),
            events_path=str(root / "plan_runtime_events.jsonl"),
            enabled=enabled,
        )
        state["task_descriptor"] = descriptor.to_dict()
        template = apply_initial_template(state, descriptor)
        refresh_schedule(state)
        runtime = cls(state)
        save_state(state)
        append_event(state, "runtime_initialized", {"shadow_mode": True, "template": template})
        return runtime

    @classmethod
    def resume(cls, path: str) -> "PlanRuntime":
        state = load_state(str(path))
        if not isinstance(state.get("nodes"), dict) or not state.get("root_id"):
            raise ValueError("Invalid program-plan runtime state")
        state["version"] = VERSION
        state.setdefault("executions", [])
        state.setdefault("replan_decisions", [])
        runtime_state = state.setdefault("runtime", {})
        runtime_state.setdefault("metrics", {})
        interrupted_nodes = []
        for node in state.get("nodes", {}).values():
            if node.get("status") == "running":
                node["status"] = "pending"
                node["interrupted_count"] = int(node.get("interrupted_count") or 0) + 1
                node.pop("active_execution_id", None)
                interrupted_nodes.append(node.get("id"))
        interrupted_executions = []
        for execution in state.get("executions") or []:
            if execution.get("status") == "started":
                execution["status"] = "interrupted"
                execution["completed_at"] = utc_now()
                interrupted_executions.append(execution.get("execution_id"))
        refresh_schedule(state)
        runtime = cls(state)
        append_event(
            state,
            "runtime_resumed",
            {"interrupted_nodes": interrupted_nodes, "interrupted_executions": interrupted_executions},
        )
        return runtime

    @classmethod
    def from_parent(cls, parent: Any) -> Optional["PlanRuntime"]:
        if parent is None:
            return None
        state = getattr(parent, "plan_runtime_state", None)
        if isinstance(state, dict):
            return cls(state)
        path = getattr(parent, "plan_runtime_path", None)
        if path:
            try:
                state = load_state(str(path))
            except (OSError, ValueError):
                return None
            setattr(parent, "plan_runtime_state", state)
            return cls(state)
        return None

    def _commit(self, candidate: Dict[str, Any], event_type: str, detail: Dict[str, Any]) -> None:
        self.state.clear()
        self.state.update(candidate)
        append_event(self.state, event_type, detail)

    def required_tools(self) -> List[str]:
        return list((self.state.get("runtime") or {}).get("template_tools") or [])

    def classify_tool_call(self, *, tool_name: str, args: Dict[str, Any], turn: int = 0) -> Dict[str, Any]:
        refresh_schedule(self.state)
        return classify_call(self.state, tool_name=tool_name, args=args or {}, turn=turn)

    def start_execution(self, *, tool_name: str, args: Dict[str, Any], turn: int = 0) -> Dict[str, Any]:
        if tool_name in PLAN_CONTROL_TOOLS or tool_name == "no_tool":
            return {"status": "ignored", "classification": "control", "tool": tool_name}
        with state_lock(str(self.state.get("path"))):
            candidate = copy.deepcopy(self.state)
            refresh_schedule(candidate)
            execution = classify_call(candidate, tool_name=tool_name, args=args or {}, turn=turn)
            candidate.setdefault("executions", []).append(execution)
            candidate["executions"] = candidate["executions"][-200:]
            matched_node_id = execution.get("matched_node_id")
            if matched_node_id:
                node = (candidate.get("nodes") or {}).get(matched_node_id) or {}
                node["status"] = "running"
                node["active_execution_id"] = execution["execution_id"]
            runtime_state = candidate.setdefault("runtime", {})
            metrics = runtime_state.setdefault("metrics", {})
            classification = execution.get("classification")
            metrics[classification] = int(metrics.get(classification) or 0) + 1
            refresh_schedule(candidate)
            self._commit(
                candidate,
                "execution_started",
                {
                    "execution_id": execution.get("execution_id"),
                    "classification": classification,
                    "tool": tool_name,
                    "matched_node_id": matched_node_id,
                    "turn": int(turn or 0),
                },
            )
            return copy.deepcopy(execution)

    @staticmethod
    def _prepare_nodes(
        candidate: Dict[str, Any], parent_id: str, proposed_nodes: Iterable[Dict[str, Any]]
    ) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        nodes = candidate.setdefault("nodes", {})
        parent = nodes.get(parent_id)
        if not parent:
            return [], [{"code": "UNKNOWN_PARENT", "node_id": parent_id, "message": "Parent node does not exist"}]
        prepared = []
        for raw in proposed_nodes or []:
            node = copy.deepcopy(raw or {})
            node_id = str(node.get("id") or "").strip()
            node["id"] = node_id
            node.setdefault("parent_id", parent_id)
            node.setdefault("status", "pending")
            node.setdefault("created_at", utc_now())
            node.setdefault("updated_at", utc_now())
            if node.get("kind") in {"sequence", "parallel"}:
                node.setdefault("children", [])
            prepared.append(node)

        prepared_ids = {node.get("id") for node in prepared}
        for node in prepared:
            direct_parent = nodes.get(node.get("parent_id"))
            if direct_parent is None:
                direct_parent = next((item for item in prepared if item.get("id") == node.get("parent_id")), None)
            if direct_parent and direct_parent.get("kind") in {"sequence", "parallel"}:
                children = direct_parent.setdefault("children", [])
                if node.get("id") not in children:
                    children.append(node.get("id"))
        if parent.get("kind") in {"sequence", "parallel"}:
            children = parent.setdefault("children", [])
            for node in prepared:
                if node.get("parent_id") == parent_id and node.get("id") not in children:
                    children.append(node.get("id"))

        lint_existing = {key: value for key, value in nodes.items() if key not in prepared_ids}
        errors = lint_nodes(
            existing_nodes=lint_existing,
            proposed_nodes=prepared,
            facts=candidate.get("facts") or {},
            hypotheses=candidate.get("hypotheses") or {},
        )
        return prepared, errors

    def expand(
        self,
        *,
        parent_id: str,
        nodes: Iterable[Dict[str, Any]],
        reason: str,
        evidence_refs: Iterable[str],
        facts: Iterable[Dict[str, Any]] = (),
        hypotheses: Iterable[Dict[str, Any]] = (),
    ) -> Dict[str, Any]:
        with state_lock(str(self.state.get("path"))):
            candidate = copy.deepcopy(self.state)
            evidence_ids = set(candidate.get("evidence") or {})
            refs = [str(item) for item in evidence_refs or []]
            if not reason.strip():
                return {"status": "rejected", "errors": [{"code": "MISSING_REASON", "message": "Expansion requires a reason"}]}
            if not refs or any(ref not in evidence_ids for ref in refs):
                return {
                    "status": "rejected",
                    "errors": [{"code": "UNKNOWN_EVIDENCE", "message": "Expansion must reference existing evidence"}],
                }
            store = EvidenceStore(candidate)
            try:
                committed_facts = store.commit_facts(facts)
                committed_hypotheses = store.commit_hypotheses(hypotheses)
            except (TypeError, ValueError) as exc:
                return {"status": "rejected", "errors": [{"code": "INVALID_CLAIM", "message": str(exc)}]}
            prepared, errors = self._prepare_nodes(candidate, str(parent_id), nodes)
            if errors:
                return {"status": "rejected", "errors": errors}
            if not prepared:
                return {"status": "rejected", "errors": [{"code": "EMPTY_EXPANSION", "message": "No nodes supplied"}]}
            for node in prepared:
                candidate["nodes"][node["id"]] = node
            runnable = refresh_schedule(candidate)
            self._commit(
                candidate,
                "plan_expanded",
                {
                    "parent_id": parent_id,
                    "node_ids": [node["id"] for node in prepared],
                    "reason": reason[:500],
                    "evidence_refs": refs,
                },
            )
            return {
                "status": "accepted",
                "added_node_ids": [node["id"] for node in prepared],
                "committed_facts": committed_facts,
                "committed_hypotheses": committed_hypotheses,
                "runnable_node_ids": runnable,
            }

    def revise(
        self,
        *,
        changes: Iterable[Dict[str, Any]],
        reason: str,
        evidence_refs: Iterable[str],
        facts: Iterable[Dict[str, Any]] = (),
        hypotheses: Iterable[Dict[str, Any]] = (),
    ) -> Dict[str, Any]:
        with state_lock(str(self.state.get("path"))):
            candidate = copy.deepcopy(self.state)
            refs = [str(item) for item in evidence_refs or []]
            known_evidence = set(candidate.get("evidence") or {})
            if not reason.strip():
                return {"status": "rejected", "errors": [{"code": "MISSING_REASON", "message": "Revision requires a reason"}]}
            if not refs or any(ref not in known_evidence for ref in refs):
                return {"status": "rejected", "errors": [{"code": "UNKNOWN_EVIDENCE", "message": "Revision must reference existing evidence"}]}
            store = EvidenceStore(candidate)
            try:
                committed_facts = store.commit_facts(facts)
                committed_hypotheses = store.commit_hypotheses(hypotheses)
            except (TypeError, ValueError) as exc:
                return {"status": "rejected", "errors": [{"code": "INVALID_CLAIM", "message": str(exc)}]}

            applied = []
            errors = []
            nodes = candidate.setdefault("nodes", {})
            for change in changes or []:
                op = str((change or {}).get("op") or "")
                node_id = str((change or {}).get("node_id") or "")
                node = nodes.get(node_id)
                if not node or node_id == candidate.get("root_id"):
                    errors.append({"code": "UNKNOWN_OR_PROTECTED_NODE", "node_id": node_id, "message": "Revision target is missing or protected"})
                    continue
                if op == "prune":
                    for target_id in _descendants(nodes, node_id):
                        nodes[target_id]["status"] = "pruned"
                        nodes[target_id]["prune_reason"] = str((change or {}).get("reason") or reason)[:500]
                    applied.append({"op": op, "node_id": node_id})
                elif op == "retry":
                    if node.get("status") not in {"failed", "blocked_condition", "blocked_unknown"}:
                        errors.append({"code": "NODE_NOT_RETRYABLE", "node_id": node_id, "message": "Only failed or blocked nodes can be retried"})
                    else:
                        node["status"] = "pending"
                        node.pop("failure_reason", None)
                        applied.append({"op": op, "node_id": node_id})
                elif op == "set_priority":
                    try:
                        node["priority"] = max(-100.0, min(100.0, float((change or {}).get("priority"))))
                        applied.append({"op": op, "node_id": node_id, "priority": node["priority"]})
                    except (TypeError, ValueError):
                        errors.append({"code": "INVALID_PRIORITY", "node_id": node_id, "message": "priority must be numeric"})
                else:
                    errors.append({"code": "UNSUPPORTED_REVISION", "node_id": node_id, "message": f"Unsupported revision op: {op}"})
            if errors:
                return {"status": "rejected", "errors": errors}
            if not applied and not committed_facts and not committed_hypotheses:
                return {"status": "rejected", "errors": [{"code": "EMPTY_REVISION", "message": "No revision was applied"}]}
            runnable = refresh_schedule(candidate)
            self._commit(candidate, "plan_revised", {"changes": applied, "reason": reason[:500], "evidence_refs": refs})
            return {
                "status": "accepted",
                "changes": applied,
                "committed_facts": committed_facts,
                "committed_hypotheses": committed_hypotheses,
                "runnable_node_ids": runnable,
            }

    def observe_tool_result(
        self,
        *,
        tool_name: str,
        args: Dict[str, Any],
        result: Any,
        turn: int = 0,
        execution_id: Optional[str] = None,
        available_tools: Iterable[Dict[str, Any]] = (),
        progress_controller: Any = None,
        progress_preflight: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        if tool_name in PLAN_CONTROL_TOOLS or tool_name == "no_tool":
            return {"status": "ignored"}
        with state_lock(str(self.state.get("path"))):
            candidate = copy.deepcopy(self.state)
            before_facts = _fact_snapshot(candidate)
            before_runnable = set((candidate.get("runtime") or {}).get("runnable_node_ids") or [])
            execution = next(
                (item for item in reversed(candidate.get("executions") or []) if item.get("execution_id") == execution_id),
                None,
            )
            synthesized_execution = execution is None
            if execution is None:
                execution = classify_call(candidate, tool_name=tool_name, args=args or {}, turn=turn)
                candidate.setdefault("executions", []).append(execution)
                candidate["executions"] = candidate["executions"][-200:]

            discovered_names = []
            if isinstance(result, dict) and isinstance(result.get("tools"), list):
                discovered_names = [str(item) for item in result.get("tools") or []]
            sync_tool_catalog(candidate, schemas=available_tools, discovered_names=discovered_names)

            observation = EvidenceStore(candidate).add_observation(
                tool_name=str(tool_name or "unknown"), args=args or {}, result=result, turn=turn
            )
            status = str(observation.get("status") or "success").lower()
            matched_node_id = execution.get("matched_node_id")
            if tool_name in {"verify_flag", "check_flag"} and isinstance(result, dict) and result.get("correct") is True:
                EvidenceStore(candidate).commit_facts(
                    [{"key": "flag.verified", "value": True, "confidence": 1.0, "evidence_refs": [observation["evidence_id"]]}]
                )

            triage_result = apply_secondary_triage(candidate, evidence_id=observation["evidence_id"])

            runtime_state = candidate.setdefault("runtime", {})
            runtime_state["step_count"] = int(runtime_state.get("step_count") or 0) + 1
            after_facts = _fact_snapshot(candidate)
            changed_fact_keys = sorted(
                key for key, value in after_facts.items() if key not in before_facts or before_facts.get(key) != value
            )
            progress_decision = None
            if progress_controller is not None:
                progress_decision = progress_controller.after_tool(
                    tool_name=str(tool_name or ""),
                    args=args or {},
                    result=result,
                    turn=turn,
                    plan_summary={"changed_fact_keys": changed_fact_keys},
                    preflight=progress_preflight,
                )
            failed = _failure_status(status)
            useful_progress = (
                bool(progress_decision.get("useful_progress"))
                if isinstance(progress_decision, dict)
                else bool(changed_fact_keys or (status == "success" and result not in (None, "", {}, [])))
            )
            if matched_node_id:
                node = candidate.get("nodes", {}).get(matched_node_id) or {}
                if failed:
                    node["status"] = "failed"
                    node["failure_reason"] = status
                elif useful_progress:
                    node["status"] = "done"
                    node.pop("failure_reason", None)
                    node["no_progress_count"] = 0
                else:
                    node["status"] = "pending"
                    node["no_progress_count"] = int(node.get("no_progress_count") or 0) + 1
                node["last_evidence_ref"] = observation["evidence_id"]
                node.pop("active_execution_id", None)
            runnable = refresh_schedule(candidate)
            newly_runnable = sorted(set(runnable) - before_runnable)
            classification = str(execution.get("classification") or "deviation")
            hint = build_replan_hint(
                classification=classification,
                changed_fact_keys=changed_fact_keys,
                newly_runnable=newly_runnable,
                current_node_id=execution.get("current_node_id"),
            )
            execution.update(
                {
                    "status": "failed" if failed else ("completed" if useful_progress else "no_progress"),
                    "result_status": status,
                    "evidence_id": observation["evidence_id"],
                    "changed_fact_keys": changed_fact_keys,
                    "new_fact_count": len(changed_fact_keys),
                    "useful_progress": useful_progress,
                    "replan_hint": hint,
                    "completed_at": utc_now(),
                }
            )
            decision = make_replan_decision(
                candidate,
                execution=execution,
                result_status="failed" if failed else (status if useful_progress else "no_progress"),
                changed_fact_keys=changed_fact_keys,
                newly_runnable=newly_runnable,
                replan_hint=hint,
                triage_result=triage_result,
            )
            execution["replan_decision"] = decision
            record_replan_decision(candidate, decision)
            metrics = runtime_state.setdefault("metrics", {})
            if synthesized_execution:
                metrics[classification] = int(metrics.get(classification) or 0) + 1
            if changed_fact_keys:
                metrics["evidence_yielding_executions"] = int(metrics.get("evidence_yielding_executions") or 0) + 1
            if hint.get("replan_needed"):
                metrics["replan_hints"] = int(metrics.get("replan_hints") or 0) + 1
            runtime_state["last_replan_hint"] = hint
            self._commit(
                candidate,
                "tool_observed",
                {
                    "execution_id": execution.get("execution_id"),
                    "classification": classification,
                    "tool": tool_name,
                    "turn": int(turn or 0),
                    "evidence_id": observation["evidence_id"],
                    "matched_node_id": matched_node_id,
                    "status": status,
                    "changed_fact_keys": changed_fact_keys,
                    "useful_progress": useful_progress,
                    "replan_hint": hint,
                    "replan_decision": decision,
                    "triage_result": triage_result,
                },
            )
            current = runnable[0] if runnable else None
            note = (
                f"[Plan Runtime] {classification} execution {execution.get('execution_id')} stored "
                f"evidence {observation['evidence_id']}."
            )
            if changed_fact_keys:
                note += " New or changed facts: " + ", ".join(changed_fact_keys[:12]) + "."
            if hint.get("replan_needed"):
                note += f" Replan suggested: {hint.get('reason')} via {hint.get('suggested_action')}."
            note += f" [Replan Decision] {decision.get('decision')}: {decision.get('reason')}."
            if decision.get("auto_applied"):
                note += f" Auto-applied {len(decision.get('added_node_ids') or [])} grounded triage nodes."
            elif decision.get("requires_planner_action"):
                note += f" Planner action requested: {decision.get('suggested_action') or 'inspect plan_status'}."
            if current:
                note += f" Current runnable node: {current}."
            elif candidate.get("nodes", {}).get(candidate.get("root_id"), {}).get("status") != "done":
                note += " No runnable leaf remains; inspect plan_status and revise the nearest failed or blocked branch."
            return {
                **observation,
                "status": "observed",
                "execution_id": execution.get("execution_id"),
                "classification": classification,
                "matched_node_id": matched_node_id,
                "changed_fact_keys": changed_fact_keys,
                "useful_progress": useful_progress,
                "progress_decision": progress_decision or {},
                "runnable_node_ids": runnable,
                "replan_hint": hint,
                "replan_decision": decision,
                "triage_result": triage_result,
                "required_tools": triage_result.get("required_tools") or self.required_tools(),
                "next_prompt": note,
            }

    def status(self, *, include_nodes: bool = False, include_evidence: bool = False) -> Dict[str, Any]:
        refresh_schedule(self.state)
        nodes = self.state.get("nodes") or {}
        runtime = self.state.get("runtime") or {}
        blocked = []
        for node_id in runtime.get("blocked_node_ids") or []:
            node = nodes.get(node_id) or {}
            blocked.append(
                {
                    "id": node_id,
                    "status": node.get("status"),
                    "missing_facts": node.get("missing_facts") or [],
                    "reason": node.get("blocked_reason"),
                }
            )
        result = {
            "status": "success",
            "path": self.state.get("path"),
            "root_status": (nodes.get(self.state.get("root_id")) or {}).get("status"),
            "current_node_id": runtime.get("current_node_id"),
            "runnable_node_ids": runtime.get("runnable_node_ids") or [],
            "runnable": [
                {
                    "id": node_id,
                    "title": (nodes.get(node_id) or {}).get("title"),
                    "tool": ((nodes.get(node_id) or {}).get("action") or {}).get("tool"),
                    "args": _prompt_args(((nodes.get(node_id) or {}).get("action") or {}).get("args") or {}),
                }
                for node_id in runtime.get("runnable_node_ids") or []
            ],
            "blocked": blocked,
            "fact_keys": sorted((self.state.get("facts") or {}).keys()),
            "hypothesis_ids": sorted((self.state.get("hypotheses") or {}).keys()),
            "evidence_count": len(self.state.get("evidence") or {}),
            "recent_evidence_ids": list((self.state.get("evidence") or {}).keys())[-10:],
            "template": runtime.get("template"),
            "metrics": dict(runtime.get("metrics") or {}),
            "last_replan_hint": runtime.get("last_replan_hint") or {},
            "last_replan_decision": runtime.get("last_replan_decision") or {},
            "last_progress_decision": runtime.get("last_progress_decision") or {},
            "controller_replan_required": bool(runtime.get("controller_replan_required")),
            "secondary_triage_status": runtime.get("secondary_triage_status"),
            "recent_executions": [
                {
                    "execution_id": item.get("execution_id"),
                    "classification": item.get("classification"),
                    "tool": item.get("tool"),
                    "status": item.get("status"),
                    "matched_node_id": item.get("matched_node_id"),
                    "new_fact_count": item.get("new_fact_count", 0),
                }
                for item in (self.state.get("executions") or [])[-10:]
            ],
            "recent_replan_decisions": list(self.state.get("replan_decisions") or [])[-10:],
            "shadow_mode": bool(runtime.get("shadow_mode", True)),
        }
        if include_nodes:
            result["nodes"] = nodes
        if include_evidence:
            result["recent_evidence"] = list((self.state.get("evidence") or {}).values())[-10:]
        save_state(self.state)
        return result

    def record_progress_decision(self, decision: Dict[str, Any]) -> Dict[str, Any]:
        """Persist an authoritative progress decision alongside advisory plan state."""
        if not isinstance(decision, dict) or not decision:
            return {"status": "ignored"}
        with state_lock(str(self.state.get("path"))):
            candidate = copy.deepcopy(self.state)
            runtime = candidate.setdefault("runtime", {})
            bounded = {
                key: copy.deepcopy(decision.get(key))
                for key in (
                    "action",
                    "reason",
                    "tool",
                    "fingerprint",
                    "result_status",
                    "useful_progress",
                    "changed_fact_keys",
                    "short_circuited",
                    "repeat_count",
                    "no_progress_streak",
                    "evidence_revision",
                    "turn",
                )
            }
            runtime["last_progress_decision"] = bounded
            runtime["controller_replan_required"] = bounded.get("action") == "REPLAN_BRANCH"
            self._commit(candidate, "progress_decision", bounded)
            return {"status": "recorded", **bounded}

    def format_prompt(self) -> str:
        status = self.status()
        runnable_lines = [
            f"- {item.get('id')}: {item.get('tool') or 'expand subtree'} "
            f"{json.dumps(item.get('args') or {}, ensure_ascii=False, sort_keys=True)}"
            for item in status.get("runnable") or []
        ]
        return "\n".join(
            [
                "[Evidence-Grounded Program Plan]",
                "The runtime is advisory: every tool call remains allowed and is classified as planned, exploratory, deviation, or repeated.",
                f"State file: {status.get('path')}",
                f"Initial template: {status.get('template') or 'generic'}",
                "Current runnable actions:",
                *(runnable_lines or ["- (none)"]),
                f"Recent evidence ids: {', '.join(status.get('recent_evidence_ids') or []) or '(none)'}",
                (
                    "Last replan decision: "
                    f"{(status.get('last_replan_decision') or {}).get('decision') or 'KEEP'} - "
                    f"{(status.get('last_replan_decision') or {}).get('reason') or 'initial plan'}"
                ),
                (
                    "Progress controller: "
                    f"{(status.get('last_progress_decision') or {}).get('action') or 'CONTINUE'} - "
                    f"{(status.get('last_progress_decision') or {}).get('reason') or 'no decision yet'}"
                ),
                "Use plan_expand to add evidence-backed local children, plan_revise to prune/retry/reprioritize, and plan_status to inspect blockers.",
                "Conditions use three-valued logic. Unknown facts block dependent actions until a probe produces evidence.",
                "Facts must cite existing evidence IDs. Hypotheses may only justify probe actions.",
            ]
        )
