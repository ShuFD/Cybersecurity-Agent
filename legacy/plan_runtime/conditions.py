from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, Iterable, Set


class TriValue(str, Enum):
    TRUE = "true"
    FALSE = "false"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class ConditionResult:
    value: TriValue
    missing_facts: frozenset[str] = frozenset()


def _fact_value(facts: Dict[str, Any], key: str) -> tuple[bool, Any]:
    if key not in facts:
        return False, None
    record = facts.get(key)
    if isinstance(record, dict) and "value" in record:
        return True, record.get("value")
    return True, record


def referenced_facts(expr: Any) -> Set[str]:
    refs: Set[str] = set()
    if isinstance(expr, dict):
        fact = expr.get("fact")
        if isinstance(fact, str) and fact:
            refs.add(fact)
        for value in expr.values():
            refs.update(referenced_facts(value))
    elif isinstance(expr, list):
        for item in expr:
            refs.update(referenced_facts(item))
    return refs


def _combine_all(results: Iterable[ConditionResult]) -> ConditionResult:
    results = list(results)
    missing = frozenset().union(*(item.missing_facts for item in results)) if results else frozenset()
    if any(item.value == TriValue.FALSE for item in results):
        return ConditionResult(TriValue.FALSE, missing)
    if any(item.value == TriValue.UNKNOWN for item in results):
        return ConditionResult(TriValue.UNKNOWN, missing)
    return ConditionResult(TriValue.TRUE, missing)


def _combine_any(results: Iterable[ConditionResult]) -> ConditionResult:
    results = list(results)
    missing = frozenset().union(*(item.missing_facts for item in results)) if results else frozenset()
    if any(item.value == TriValue.TRUE for item in results):
        return ConditionResult(TriValue.TRUE, missing)
    if any(item.value == TriValue.UNKNOWN for item in results):
        return ConditionResult(TriValue.UNKNOWN, missing)
    return ConditionResult(TriValue.FALSE, missing)


def evaluate_condition(expr: Any, facts: Dict[str, Any]) -> ConditionResult:
    if expr in (None, {}, []):
        return ConditionResult(TriValue.TRUE)
    if not isinstance(expr, dict):
        return ConditionResult(TriValue.FALSE)

    op = str(expr.get("op") or "").lower()
    if op in {"all", "any"}:
        args = expr.get("args") or []
        results = [evaluate_condition(item, facts) for item in args]
        return _combine_all(results) if op == "all" else _combine_any(results)
    if op == "not":
        child = evaluate_condition(expr.get("arg"), facts)
        if child.value == TriValue.UNKNOWN:
            return child
        return ConditionResult(TriValue.FALSE if child.value == TriValue.TRUE else TriValue.TRUE, child.missing_facts)

    key = str(expr.get("fact") or "")
    exists, actual = _fact_value(facts, key)
    if not key or not exists:
        return ConditionResult(TriValue.UNKNOWN, frozenset({key}) if key else frozenset())
    if op == "exists":
        return ConditionResult(TriValue.TRUE if actual is not None else TriValue.FALSE)

    expected = expr.get("value")
    try:
        if op == "eq":
            matched = actual == expected
        elif op == "ne":
            matched = actual != expected
        elif op == "contains":
            matched = expected in actual
        elif op == "gt":
            matched = actual > expected
        elif op == "gte":
            matched = actual >= expected
        elif op == "lt":
            matched = actual < expected
        elif op == "lte":
            matched = actual <= expected
        else:
            return ConditionResult(TriValue.FALSE)
    except (TypeError, ValueError):
        return ConditionResult(TriValue.FALSE)
    return ConditionResult(TriValue.TRUE if matched else TriValue.FALSE)
