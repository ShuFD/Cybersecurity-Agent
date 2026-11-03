from __future__ import annotations

from typing import Any, Dict, List

from .conditions import TriValue, evaluate_condition
from .models import TERMINAL_STATUSES, utc_now


def _fact_value(facts: Dict[str, Any], key: str) -> Any:
    record = facts.get(key)
    return record.get("value") if isinstance(record, dict) else record


def _reset_subtree(nodes: Dict[str, Dict[str, Any]], node_id: str) -> None:
    node = nodes.get(node_id)
    if not node:
        return
    if node.get("status") != "pruned":
        node["status"] = "pending"
        node.pop("blocked_reason", None)
        node.pop("missing_facts", None)
    for child_id in node.get("children") or []:
        _reset_subtree(nodes, child_id)
    for key in ("body", "then", "else", "on_unknown"):
        child_id = node.get(key)
        if child_id:
            _reset_subtree(nodes, child_id)


def _requirements(
    node: Dict[str, Any], facts: Dict[str, Any], hypotheses: Dict[str, Any]
) -> tuple[TriValue, List[str]]:
    condition_facts = facts
    if node.get("kind") == "probe" and hypotheses:
        condition_facts = dict(facts)
        for hypothesis_id in hypotheses:
            condition_facts.setdefault(hypothesis_id, {"value": True, "source": "hypothesis"})
    missing = set()
    for expr in node.get("requires") or []:
        result = evaluate_condition(expr, condition_facts)
        missing.update(result.missing_facts)
        if result.value == TriValue.FALSE:
            return TriValue.FALSE, sorted(missing)
        if result.value == TriValue.UNKNOWN:
            return TriValue.UNKNOWN, sorted(missing)
    return TriValue.TRUE, sorted(missing)


def refresh_schedule(state: Dict[str, Any]) -> List[str]:
    nodes = state.setdefault("nodes", {})
    facts = state.setdefault("facts", {})
    hypotheses = state.setdefault("hypotheses", {})
    runnable: List[str] = []
    blocked: List[str] = []
    visiting = set()

    def walk(node_id: str) -> None:
        node = nodes.get(node_id)
        if not node or node_id in visiting or node.get("status") in TERMINAL_STATUSES:
            return
        visiting.add(node_id)
        required, missing = _requirements(node, facts, hypotheses)
        if required != TriValue.TRUE:
            node["status"] = "blocked_unknown" if required == TriValue.UNKNOWN else "blocked_condition"
            node["blocked_reason"] = "missing_or_unknown_facts" if missing else "condition_false"
            node["missing_facts"] = missing
            blocked.append(node_id)
            visiting.remove(node_id)
            return

        kind = node.get("kind")
        if kind == "finish":
            node["status"] = "done"
            visiting.remove(node_id)
            return

        if kind in {"action", "probe", "verify", "reflect"}:
            if node.get("status") != "running":
                node["status"] = "runnable"
                runnable.append(node_id)
            visiting.remove(node_id)
            return

        if kind in {"sequence", "parallel"}:
            children = [nodes.get(child_id) for child_id in node.get("children") or []]
            children = [child for child in children if child]
            if not children:
                node["status"] = "runnable" if node.get("expandable") else "done"
                if node["status"] == "runnable":
                    runnable.append(node_id)
                visiting.remove(node_id)
                return
            if all(child.get("status") in {"done", "pruned"} for child in children):
                node["status"] = "done"
                visiting.remove(node_id)
                return
            node["status"] = "active"
            targets = children if kind == "parallel" else [next(child for child in children if child.get("status") not in {"done", "pruned"})]
            for child in targets:
                walk(str(child.get("id")))
            visiting.remove(node_id)
            return

        if kind == "if":
            result = evaluate_condition(node.get("condition"), facts)
            branch = node.get("then") if result.value == TriValue.TRUE else node.get("else")
            if result.value == TriValue.UNKNOWN:
                branch = node.get("on_unknown")
                node["missing_facts"] = sorted(result.missing_facts)
            if not branch:
                node["status"] = "blocked_unknown"
                blocked.append(node_id)
            elif nodes.get(branch, {}).get("status") in {"done", "pruned"}:
                node["status"] = "done"
            else:
                node["status"] = "active"
                node["selected_branch"] = branch
                walk(str(branch))
            visiting.remove(node_id)
            return

        if kind == "while":
            result = evaluate_condition(node.get("condition"), facts)
            if result.value == TriValue.UNKNOWN:
                node["status"] = "blocked_unknown"
                node["missing_facts"] = sorted(result.missing_facts)
                blocked.append(node_id)
                visiting.remove(node_id)
                return
            if result.value == TriValue.FALSE:
                node["status"] = "done"
                visiting.remove(node_id)
                return
            if int(node.get("iterations") or 0) >= int(node.get("max_iterations") or 0):
                node["status"] = "failed"
                node["failure_reason"] = "max_iterations_exceeded"
                visiting.remove(node_id)
                return
            body_id = str(node.get("body") or "")
            body = nodes.get(body_id)
            if not body:
                node["status"] = "failed"
                node["failure_reason"] = "missing_body"
                visiting.remove(node_id)
                return
            if body.get("status") in {"done", "pruned"}:
                progress = _fact_value(facts, str(node.get("progress_fact") or ""))
                if node.get("last_progress_value") == progress:
                    node["no_progress_count"] = int(node.get("no_progress_count") or 0) + 1
                else:
                    node["no_progress_count"] = 0
                node["last_progress_value"] = progress
                node["iterations"] = int(node.get("iterations") or 0) + 1
                if int(node.get("no_progress_count") or 0) >= int(node.get("max_no_progress") or 1):
                    node["status"] = "failed"
                    node["failure_reason"] = "no_progress"
                    visiting.remove(node_id)
                    return
                _reset_subtree(nodes, body_id)
            node["status"] = "active"
            walk(body_id)
            visiting.remove(node_id)
            return

        node["status"] = "failed"
        node["failure_reason"] = "unsupported_kind"
        visiting.remove(node_id)

    # Repeated passes allow nested containers that just completed to advance their parents.
    for _ in range(min(16, max(2, len(nodes) + 1))):
        runnable.clear()
        blocked.clear()
        visiting.clear()
        walk(str(state.get("root_id") or "root"))

    runnable = sorted(set(runnable), key=lambda node_id: (-float(nodes[node_id].get("priority") or 0), node_id))
    runtime = state.setdefault("runtime", {})
    runtime["runnable_node_ids"] = runnable
    runtime["blocked_node_ids"] = sorted(set(blocked))
    runtime["current_node_id"] = runnable[0] if runnable else str(state.get("root_id") or "root")
    for node in nodes.values():
        node["updated_at"] = node.get("updated_at") or utc_now()
    return runnable
