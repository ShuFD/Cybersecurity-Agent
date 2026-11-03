import json
import os
import re
from dataclasses import dataclass
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_PROMPT_PATH = PROJECT_ROOT / "assets" / "judge_prompt.txt"
PROJECT_OVERRIDE_PATH = PROJECT_ROOT / ".secheur-agent" / "judge_prompt.md"

VALID_STATUSES = {"on_track", "course_correct", "stuck", "flag_found", "off_track"}


@dataclass
class JudgeVerdict:
    status: str
    summary: str
    suggestion: str
    confidence: float = 0.0
    raw_text: str = ""
    knowledge_query: str = ""


def _parse_verdict(raw_text):
    text = str(raw_text or "").strip()
    parsed = None
    try:
        parsed = json.loads(text)
    except Exception:
        match = re.search(r"\{.*\}", text, flags=re.DOTALL)
        if match:
            try:
                parsed = json.loads(match.group(0))
            except Exception:
                parsed = None
    if not isinstance(parsed, dict):
        return JudgeVerdict(
            status="on_track",
            summary="judge parse failed",
            suggestion="",
            confidence=0.0,
            raw_text=text,
        )
    status = parsed.get("status") if parsed.get("status") in VALID_STATUSES else "on_track"
    return JudgeVerdict(
        status=status,
        summary=str(parsed.get("summary") or ""),
        suggestion=str(parsed.get("suggestion") or ""),
        confidence=float(parsed.get("confidence") or 0.0),
        raw_text=text,
        knowledge_query=str(parsed.get("knowledge_query") or "").strip(),
    )


_DEFAULT_EVERY_N_TURNS = 5
_DEFAULT_MAX_HISTORY = 8

# Bounds mirror frontends/desktop_settings.py:normalize_judge_config.
_MIN_EVERY_N_TURNS = 1
_MAX_EVERY_N_TURNS = 50
_MIN_MAX_HISTORY = 2
_MAX_MAX_HISTORY = 20

_WARNED_PROFILES = set()


def should_intervene(verdict):
    return verdict is not None and verdict.status != "on_track"


def format_judge_reminder(verdict):
    if verdict.status == "on_track":
        return ""
    lines = [
        "<system-reminder>",
        f"[Progress Judge] status={verdict.status} confidence={verdict.confidence}",
        f"summary: {verdict.summary}",
    ]
    if verdict.suggestion:
        lines.extend(["", "suggestion:", verdict.suggestion])
    lines.append("</system-reminder>")
    return "\n".join(lines)


def _read_text(path):
    try:
        return Path(path).read_text(encoding="utf-8")
    except Exception:
        return None


def _build_judge_system_prompt(project_root):
    root = Path(project_root) if project_root else PROJECT_ROOT
    override = root / ".secheur-agent" / "judge_prompt.md"
    text = _read_text(override)
    if text is not None and text.strip():
        return text
    return _read_text(DEFAULT_PROMPT_PATH) or ""


def load_judge_config(handler=None):
    cfg = {
        "enabled": True,
        "every_n_turns": _DEFAULT_EVERY_N_TURNS,
        "model_profile": None,
        "max_history_messages": _DEFAULT_MAX_HISTORY,
    }
    paths = []
    config_dir = os.environ.get("SECHEUR_CONFIG_DIR", "").strip()
    if config_dir:
        paths.append(Path(config_dir) / "desktop-config.json")
    root = getattr(getattr(handler, "parent", None), "project_root", None) or PROJECT_ROOT
    paths.append(Path(root) / ".secheur-agent" / "desktop-config.json")
    for path in paths:
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8"))
        except Exception:
            continue
        block = data.get("judge") if isinstance(data, dict) else None
        if not isinstance(block, dict):
            continue
        cfg["enabled"] = bool(block.get("enabled", cfg["enabled"]))
        try:
            n = int(block.get("every_n_turns", cfg["every_n_turns"]))
            cfg["every_n_turns"] = max(_MIN_EVERY_N_TURNS, min(_MAX_EVERY_N_TURNS, n))
        except Exception:
            pass
        profile = block.get("model_profile")
        if isinstance(profile, str) and profile.strip():
            cfg["model_profile"] = profile.strip()
        try:
            n = int(block.get("max_history_messages", cfg["max_history_messages"]))
            cfg["max_history_messages"] = max(_MIN_MAX_HISTORY, min(_MAX_MAX_HISTORY, n))
        except Exception:
            pass
    return cfg


def _build_judge_input(messages, k):
    k = max(1, int(k or _DEFAULT_MAX_HISTORY))
    if not messages:
        return "", []
    recent = list(messages[-k:])
    older = list(messages[:-k])
    if not older:
        return "", recent
    # Simple truncation rather than reusing compact_messages_history:
    # the latter mutates the live session's _usage_tokens and is unsafe to call here.
    parts = []
    char_budget = 4000
    used = 0
    for msg in older:
        content = str(msg.get("content", "") or "")
        snippet = content[:400]
        line = f"[{msg.get('role', '?')}] {snippet}"
        if used + len(line) > char_budget:
            break
        parts.append(line)
        used += len(line)
    summary = "\n".join(parts)
    return summary, recent


def evaluate_progress(client, messages, handler, project_root=None, turn=None):
    import sys
    cfg = load_judge_config(handler)
    if not cfg["enabled"]:
        return None
    parent = getattr(handler, "parent", None)
    if bool(getattr(parent, "single_task", False)):
        return None
    every_n = cfg["every_n_turns"]
    if every_n > 1 and turn is not None and turn % every_n != 0:
        return None
    try:
        system_prompt = _build_judge_system_prompt(project_root)
        summary, recent = _build_judge_input(messages, cfg["max_history_messages"])
        original_task = ""
        if len(messages) > 1:
            original_task = str(messages[1].get("content", "") or "")
        prompt_messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": "## Original task\n" + (original_task or "(no task)")},
        ]
        if summary:
            prompt_messages.append({"role": "user", "content": "## Older history (truncated)\n" + summary})
        prompt_messages.append({"role": "user", "content": "## Recent messages\n" + json.dumps(recent, ensure_ascii=False)})

        backend = getattr(client, "backend", None) if client is not None else None
        original_model = getattr(backend, "model", None) if backend is not None else None
        target_model = cfg["model_profile"]
        known = getattr(backend, "model_profiles", None) if backend is not None else None
        if target_model and isinstance(known, (list, tuple, set)) and target_model not in known:
            key = (str(getattr(parent, "project_root", None) or ""), target_model)
            if key not in _WARNED_PROFILES:
                _WARNED_PROFILES.add(key)
                sys.stderr.write(f"[judge] unknown model_profile={target_model!r}; falling back to main agent profile\n")
            target_model = None
        try:
            if backend is not None and target_model:
                backend.model = target_model
            response = None
            if client is not None:
                gen = client.chat(prompt_messages, tools=[])
                try:
                    while True:
                        next(gen)
                except StopIteration as stop:
                    response = stop.value
                raw = getattr(response, "content", "") or ""
            else:
                raw = ""
        finally:
            if backend is not None and target_model and original_model is not None:
                backend.model = original_model
        return _parse_verdict(raw)
    except Exception as exc:
        sys.stderr.write(f"[judge] evaluation failed: {type(exc).__name__}: {exc}\n")
        return None
