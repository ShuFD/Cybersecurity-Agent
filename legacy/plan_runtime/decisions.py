from __future__ import annotations

from typing import Any, Dict, Iterable, Optional

from .models import utc_now


DECISIONS = {"KEEP", "EXPAND", "REVISE", "COMPLETE"}


def make_replan_decision(
    state: Dict[str, Any],
    *,
    execution: Dict[str, Any],
    result_status: str,
    changed_fact_keys: Iterable[str],
    newly_runnable: Iterable[str],
    replan_hint: Dict[str, Any],
    triage_result: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    facts = state.get("facts") or {}
    verified = (facts.get("flag.verified") or {}).get("value") is True
    triage_result = triage_result or {}
    added = list(triage_result.get("added_node_ids") or [])
    classification = str(execution.get("classification") or "deviation")
    failed = str(result_status or "").lower() in {
        "blocked",
        "error",
        "failed",
        "hook_blocked",
        "permission_denied",
        "permission_required",
        "stale_file",
    }

    if verified:
        decision = "COMPLETE"
        reason = "answer_verified"
        suggested_action = None
        requires_planner_action = False
    elif added:
        decision = "EXPAND"
        reason = str(triage_result.get("reason") or "domain_triage_expanded")
        suggested_action = None
        requires_planner_action = False
    elif (
        triage_result.get("status") == "waiting_for_domain_tools"
        and execution.get("tool") == "mcp_refresh"
    ):
        decision = "REVISE"
        reason = "configured_domain_analysis_tools_unavailable"
        suggested_action = "plan_revise"
        requires_planner_action = True
    elif failed:
        decision = "REVISE"
        reason = "planned_or_exploratory_action_failed"
        suggested_action = "plan_revise"
        requires_planner_action = True
    elif classification == "repeated":
        decision = "REVISE"
        reason = "repeated_without_new_facts"
        suggested_action = "plan_revise"
        requires_planner_action = True
    elif replan_hint.get("replan_needed"):
        suggested_action = replan_hint.get("suggested_action")
        decision = "REVISE" if suggested_action == "plan_revise" else "EXPAND"
        reason = str(replan_hint.get("reason") or "evidence_changed_plan_assumptions")
        requires_planner_action = True
    else:
        root = (state.get("nodes") or {}).get(state.get("root_id")) or {}
        runnable = list((state.get("runtime") or {}).get("runnable_node_ids") or [])
        if not runnable and root.get("status") != "done":
            decision = "REVISE"
            reason = "nonterminal_plan_has_no_runnable_action"
            suggested_action = "plan_revise"
            requires_planner_action = True
        else:
            decision = "KEEP"
            reason = "current_plan_remains_grounded"
            suggested_action = None
            requires_planner_action = False

    return {
        "decision_id": f"decision_{execution.get('execution_id') or 'unknown'}",
        "decision": decision,
        "reason": reason,
        "auto_applied": bool(added),
        "requires_planner_action": requires_planner_action,
        "suggested_action": suggested_action,
        "suggested_parent_id": replan_hint.get("suggested_parent_id"),
        "changed_fact_keys": list(changed_fact_keys or []),
        "newly_runnable": list(newly_runnable or []),
        "added_node_ids": added,
        "triage_stage": triage_result.get("stage"),
        "evidence_id": execution.get("evidence_id"),
        "created_at": utc_now(),
    }


def record_replan_decision(state: Dict[str, Any], decision: Dict[str, Any]) -> None:
    state.setdefault("replan_decisions", []).append(dict(decision))
    state["replan_decisions"] = state["replan_decisions"][-100:]
    runtime = state.setdefault("runtime", {})
    runtime["last_replan_decision"] = dict(decision)
    metrics = runtime.setdefault("metrics", {})
    key = "decision_" + str(decision.get("decision") or "KEEP").lower()
    metrics[key] = int(metrics.get(key) or 0) + 1
    if decision.get("auto_applied"):
        metrics["auto_triage_expansions"] = int(metrics.get("auto_triage_expansions") or 0) + 1


__all__ = ["DECISIONS", "make_replan_decision", "record_replan_decision"]
