from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any, Dict

from .models import utc_now


_LOCKS: Dict[str, threading.RLock] = {}
_LOCKS_GUARD = threading.Lock()


def state_lock(path: str) -> threading.RLock:
    key = str(Path(path).resolve(strict=False))
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(key, threading.RLock())


def save_state(state: Dict[str, Any]) -> None:
    path = Path(str(state.get("path") or "plan_runtime.json"))
    path.parent.mkdir(parents=True, exist_ok=True)
    state["updated_at"] = utc_now()
    state["events"] = list(state.get("events") or [])[-50:]
    temp_path = path.with_name(path.name + ".tmp")
    payload = json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True)
    with state_lock(str(path)):
        temp_path.write_text(payload, encoding="utf-8")
        os.replace(temp_path, path)


def load_state(path: str) -> Dict[str, Any]:
    with state_lock(path):
        return json.loads(Path(path).read_text(encoding="utf-8"))


def append_event(state: Dict[str, Any], event_type: str, detail: Dict[str, Any]) -> None:
    event = {"ts": utc_now(), "type": event_type, "detail": detail}
    state.setdefault("events", []).append(event)
    state["events"] = state["events"][-50:]
    path = Path(str(state.get("events_path") or "plan_runtime_events.jsonl"))
    path.parent.mkdir(parents=True, exist_ok=True)
    with state_lock(str(state.get("path") or path)):
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
        save_state(state)
