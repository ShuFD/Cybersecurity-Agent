from __future__ import annotations

import hashlib
import time
from typing import Any, Dict


VERSION = 3
NODE_KINDS = {
    "sequence",
    "parallel",
    "if",
    "while",
    "action",
    "probe",
    "verify",
    "reflect",
    "finish",
}
TERMINAL_STATUSES = {"done", "failed", "pruned"}


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def new_state(prompt: Any, *, path: str, events_path: str, enabled: bool = True) -> Dict[str, Any]:
    now = utc_now()
    prompt_text = str(prompt or "")
    digest = hashlib.sha256(prompt_text.encode("utf-8", errors="replace")).hexdigest()[:16]
    task_evidence = "ev_task_input"
    return {
        "version": VERSION,
        "enabled": bool(enabled),
        "created_at": now,
        "updated_at": now,
        "path": str(path),
        "events_path": str(events_path),
        "prompt_digest": digest,
        "root_id": "root",
        "nodes": {
            "root": {
                "id": "root",
                "parent_id": None,
                "kind": "sequence",
                "title": "Solve the task from evidence",
                "status": "pending",
                "children": ["collect_evidence", "investigation_loop", "finish"],
                "created_at": now,
                "updated_at": now,
            },
            "collect_evidence": {
                "id": "collect_evidence",
                "parent_id": "root",
                "kind": "sequence",
                "title": "Collect and normalize initial evidence",
                "status": "pending",
                "children": [],
                "expandable": True,
                "created_at": now,
                "updated_at": now,
            },
            "investigation_loop": {
                "id": "investigation_loop",
                "parent_id": "root",
                "kind": "while",
                "title": "Investigate until the answer is verified",
                "status": "pending",
                "condition": {"op": "eq", "fact": "flag.verified", "value": False},
                "body": "investigation_body",
                "max_iterations": 8,
                "max_no_progress": 2,
                "progress_fact": "runtime.useful_fact_count",
                "iterations": 0,
                "no_progress_count": 0,
                "created_at": now,
                "updated_at": now,
            },
            "investigation_body": {
                "id": "investigation_body",
                "parent_id": "investigation_loop",
                "kind": "sequence",
                "title": "Evidence-driven investigation iteration",
                "status": "pending",
                "children": [],
                "expandable": True,
                "created_at": now,
                "updated_at": now,
            },
            "finish": {
                "id": "finish",
                "parent_id": "root",
                "kind": "finish",
                "title": "Finish only after verification",
                "status": "pending",
                "requires": [{"op": "eq", "fact": "flag.verified", "value": True}],
                "created_at": now,
                "updated_at": now,
            },
        },
        "facts": {
            "task.prompt_present": {
                "key": "task.prompt_present",
                "value": bool(prompt_text.strip()),
                "confidence": 1.0,
                "evidence_refs": [task_evidence],
                "created_at": now,
                "updated_at": now,
            },
            "flag.verified": {
                "key": "flag.verified",
                "value": False,
                "confidence": 1.0,
                "evidence_refs": [task_evidence],
                "created_at": now,
                "updated_at": now,
            },
            "runtime.evidence_count": {
                "key": "runtime.evidence_count",
                "value": 1,
                "confidence": 1.0,
                "evidence_refs": [task_evidence],
                "created_at": now,
                "updated_at": now,
            },
            "runtime.useful_fact_count": {
                "key": "runtime.useful_fact_count",
                "value": 2,
                "confidence": 1.0,
                "evidence_refs": [task_evidence],
                "created_at": now,
                "updated_at": now,
            },
        },
        "hypotheses": {},
        "executions": [],
        "replan_decisions": [],
        "evidence": {
            task_evidence: {
                "id": task_evidence,
                "kind": "task_input",
                "source": "user",
                "prompt_digest": digest,
                "preview": " ".join(prompt_text.split())[:1000],
                "created_at": now,
            }
        },
        "runtime": {
            "current_node_id": "collect_evidence",
            "runnable_node_ids": [],
            "blocked_node_ids": [],
            "step_count": 0,
            "shadow_mode": True,
            "metrics": {
                "planned": 0,
                "exploratory": 0,
                "deviation": 0,
                "repeated": 0,
                "evidence_yielding_executions": 0,
                "replan_hints": 0,
                "decision_keep": 0,
                "decision_expand": 0,
                "decision_revise": 0,
                "decision_complete": 0,
                "auto_triage_expansions": 0,
            },
        },
        "events": [],
    }
