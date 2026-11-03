from __future__ import annotations

from typing import Any, Dict, Iterable, List, Set

from .conditions import TriValue, evaluate_condition, referenced_facts
from .models import NODE_KINDS


VALID_CONDITION_OPS = {"exists", "eq", "ne", "contains", "gt", "gte", "lt", "lte", "all", "any", "not"}
ACTION_KINDS = {"action", "probe", "verify"}


def _error(code: str, node_id: str, message: str, **extra: Any) -> Dict[str, Any]:
    return {"code": code, "node_id": node_id, "message": message, **extra}


def _condition_errors(expr: Any, node_id: str) -> List[Dict[str, Any]]:
    errors = []
    if not isinstance(expr, dict):
        return [_error("INVALID_CONDITION", node_id, "Condition must be a JSON object")]
    op = str(expr.get("op") or "")
    if op not in VALID_CONDITION_OPS:
        errors.append(_error("INVALID_CONDITION_OP", node_id, f"Unsupported condition op: {op or '<missing>'}"))
    if op in {"all", "any"}:
        args = expr.get("args")
        if not isinstance(args, list) or not args:
            errors.append(_error("EMPTY_CONDITION_GROUP", node_id, f"{op} requires a non-empty args list"))
        else:
            for child in args:
                errors.extend(_condition_errors(child, node_id))
    elif op == "not":
        errors.extend(_condition_errors(expr.get("arg"), node_id))
    elif not str(expr.get("fact") or ""):
        errors.append(_error("MISSING_CONDITION_FACT", node_id, "Condition must name a fact"))
    return errors


def lint_nodes(
    *,
    existing_nodes: Dict[str, Dict[str, Any]],
    proposed_nodes: Iterable[Dict[str, Any]],
    facts: Dict[str, Any],
    hypotheses: Dict[str, Any],
) -> List[Dict[str, Any]]:
    proposed = [dict(node or {}) for node in proposed_nodes or []]
    proposed_ids = [str(node.get("id") or "") for node in proposed]
    all_ids: Set[str] = set(existing_nodes) | set(proposed_ids)
    errors: List[Dict[str, Any]] = []

    for node in proposed:
        node_id = str(node.get("id") or "")
        kind = str(node.get("kind") or "")
        if not node_id:
            errors.append(_error("MISSING_NODE_ID", "<missing>", "Every node requires an id"))
            continue
        if proposed_ids.count(node_id) > 1 or node_id in existing_nodes:
            errors.append(_error("DUPLICATE_NODE_ID", node_id, "Node id already exists"))
        if kind not in NODE_KINDS:
            errors.append(_error("INVALID_NODE_KIND", node_id, f"Unsupported node kind: {kind or '<missing>'}"))
        if node.get("status") not in (None, "pending"):
            errors.append(_error("STATUS_NOT_MODEL_WRITABLE", node_id, "New nodes may only start as pending"))
        parent_id = node.get("parent_id")
        if parent_id not in all_ids:
            errors.append(_error("UNKNOWN_PARENT", node_id, f"Unknown parent node: {parent_id}"))

        for expr in node.get("requires") or []:
            errors.extend(_condition_errors(expr, node_id))
            for fact_key in referenced_facts(expr):
                if fact_key in hypotheses and fact_key not in facts and kind != "probe":
                    errors.append(
                        _error(
                            "HYPOTHESIS_USED_AS_FACT",
                            node_id,
                            f"Hypothesis {fact_key} may only unlock probe nodes",
                            fact=fact_key,
                        )
                    )

        if kind in {"sequence", "parallel"}:
            children = node.get("children") or []
            if not isinstance(children, list):
                errors.append(_error("INVALID_CHILDREN", node_id, "children must be a list of node ids"))
            for child_id in children if isinstance(children, list) else []:
                if child_id not in all_ids:
                    errors.append(_error("UNKNOWN_CHILD", node_id, f"Unknown child node: {child_id}"))

        if kind in ACTION_KINDS:
            action = node.get("action")
            if not isinstance(action, dict) or not str(action.get("tool") or ""):
                errors.append(_error("MISSING_ACTION_TOOL", node_id, "Action nodes require action.tool"))
            elif not isinstance(action.get("args", {}), dict):
                errors.append(_error("INVALID_ACTION_ARGS", node_id, "action.args must be an object"))
            if not isinstance(node.get("failure_policy"), dict):
                errors.append(_error("MISSING_FAILURE_POLICY", node_id, "Action nodes require failure_policy"))
            if str(node.get("risk") or "").lower() in {"high", "exploit"} and not node.get("requires"):
                errors.append(
                    _error(
                        "UNSUPPORTED_HIGH_RISK_ACTION",
                        node_id,
                        "High-risk actions require evidence-backed preconditions",
                    )
                )

        if kind == "if":
            condition = node.get("condition")
            errors.extend(_condition_errors(condition, node_id))
            for branch_key in ("then", "else", "on_unknown"):
                target = node.get(branch_key)
                if not target or target not in all_ids:
                    errors.append(_error("MISSING_IF_BRANCH", node_id, f"if node requires a valid {branch_key} branch"))
            if evaluate_condition(condition, facts).value == TriValue.UNKNOWN and not node.get("on_unknown"):
                errors.append(_error("UNKNOWN_WITHOUT_PROBE", node_id, "Unknown if conditions require on_unknown"))

        if kind == "while":
            errors.extend(_condition_errors(node.get("condition"), node_id))
            body = node.get("body")
            if not body or body not in all_ids:
                errors.append(_error("MISSING_WHILE_BODY", node_id, "while node requires a valid body"))
            if not isinstance(node.get("max_iterations"), int) or not 1 <= int(node.get("max_iterations") or 0) <= 100:
                errors.append(_error("MISSING_LOOP_BUDGET", node_id, "while requires max_iterations between 1 and 100"))
            if not str(node.get("progress_fact") or ""):
                errors.append(_error("MISSING_PROGRESS_FACT", node_id, "while requires progress_fact"))
            if not isinstance(node.get("max_no_progress"), int) or int(node.get("max_no_progress") or 0) < 1:
                errors.append(_error("MISSING_NO_PROGRESS_BUDGET", node_id, "while requires max_no_progress >= 1"))

    # Parent references must agree with explicit children/body/branches.
    combined = dict(existing_nodes)
    combined.update({str(node.get("id")): node for node in proposed if node.get("id")})
    for node in proposed:
        node_id = str(node.get("id") or "")
        parent_id = node.get("parent_id")
        parent = combined.get(parent_id) or {}
        linked = node_id in (parent.get("children") or []) or node_id in {
            parent.get("body"),
            parent.get("then"),
            parent.get("else"),
            parent.get("on_unknown"),
        }
        if parent_id and not linked:
            errors.append(_error("UNLINKED_CHILD", node_id, f"Parent {parent_id} does not reference this child"))
    return errors
