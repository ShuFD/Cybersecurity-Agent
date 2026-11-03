import json
import os
import re
import subprocess
import sys
import importlib
from dataclasses import asdict, is_dataclass
from pathlib import Path

# 模块级注册表: event_name -> [callback, ...]
_registry = {}
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_EVENT_ALIASES = {
    "tool_before": ("tool_before", "PreToolUse"),
    "tool_after": ("tool_after", "PostToolUse"),
    "user_prompt_submit": ("user_prompt_submit", "UserPromptSubmit"),
    "stop": ("stop", "Stop"),
    "precompact": ("precompact", "PreCompact"),
    "session_start": ("session_start", "SessionStart"),
}
_TOOL_MATCHER_ALIASES = {
    "bash": ("Bash", "code_run"),
    "read": ("Read", "file_read"),
    "write": ("Write", "file_write"),
    "edit": ("Edit", "file_patch"),
    "grep": ("Grep", "grep_search"),
    "find": ("Glob", "list_files"),
    "ls": ("Glob", "list_files"),
    "code_run": ("Bash",),
    "file_read": ("Read",),
    "file_write": ("Write",),
    "file_patch": ("Edit",),
    "grep_search": ("Grep",),
    "list_files": ("Glob",),
    "web_fetch": ("WebFetch",),
    "sub_agent": ("Task",),
}


class HookBlocked(Exception):
    def __init__(self, event, message, data=None):
        super().__init__(message)
        self.event = event
        self.message = message
        self.data = data or {}


def register(event):
    def decorator(fn):
        _registry.setdefault(event, []).append(fn)
        return fn
    return decorator


def _jsonable(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if is_dataclass(value):
        return _jsonable(asdict(value))
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v) for v in value]
    if all(hasattr(value, attr) for attr in ("data", "next_prompt", "should_exit")):
        return {
            "data": _jsonable(getattr(value, "data", None)),
            "next_prompt": _jsonable(getattr(value, "next_prompt", None)),
            "should_exit": bool(getattr(value, "should_exit", False)),
        }
    if any(hasattr(value, attr) for attr in ("content", "thinking")):
        return {
            "content": _jsonable(getattr(value, "content", "")),
            "thinking": _jsonable(getattr(value, "thinking", "")),
        }
    return str(value)


def _project_root_from_ctx(ctx):
    handler = ctx.get("self") or ctx.get("handler")
    parent = getattr(handler, "parent", None)
    for obj in (handler, parent):
        root = getattr(obj, "project_root", None)
        if root:
            return Path(root)
    cwd = getattr(handler, "cwd", None)
    if cwd:
        return Path(cwd)
    return Path(_PROJECT_ROOT)


def _settings_paths(project_root):
    root = Path(project_root)
    return [
        root / "settings.json",
        root / "settings.local.json",
        root / ".secheur-agent" / "settings.json",
        root / ".secheur-agent" / "settings.local.json",
    ]


def _load_json(path):
    try:
        path = Path(path)
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        sys.stderr.write(f"[hooks] settings load failed {path}: {e}\n")
    return None


def _hook_match_query(event, ctx):
    if event in {"tool_before", "tool_after"}:
        return ctx.get("tool_name")
    return ctx.get("match_query")


def _hook_match_queries(event, ctx):
    match_query = _hook_match_query(event, ctx)
    if not match_query:
        return []
    match_query = str(match_query)
    return [match_query, *_TOOL_MATCHER_ALIASES.get(match_query, ())]


def _matcher_applies(matcher, event, ctx):
    if not matcher or matcher == "*":
        return True
    match_queries = _hook_match_queries(event, ctx)
    if not match_queries:
        return True
    matcher = str(matcher)
    if all(ch.isalnum() or ch in "_|" for ch in matcher):
        parts = {part.strip() for part in matcher.split("|")}
        return bool(parts.intersection(match_queries))
    try:
        return any(re.search(matcher, match_query) is not None for match_query in match_queries)
    except Exception as e:
        sys.stderr.write(f"[hooks] invalid {event} matcher {matcher!r}: {e}\n")
        return False


def _append_command_spec(specs, spec, event, ctx, inherited_matcher=None):
    if isinstance(spec, str):
        if _matcher_applies(inherited_matcher, event, ctx):
            specs.append({"command": spec})
        return
    if not isinstance(spec, dict):
        return
    if spec.get("hooks") and not spec.get("command"):
        if not _matcher_applies(spec.get("matcher"), event, ctx):
            return
        for hook in spec.get("hooks") or []:
            _append_command_spec(specs, hook, event, ctx, inherited_matcher=spec.get("matcher"))
        return
    if spec.get("command") and _matcher_applies(spec.get("matcher", inherited_matcher), event, ctx):
        if spec.get("type") not in (None, "command"):
            return
        specs.append(dict(spec))


def _normalize_external_patch(patch):
    if not isinstance(patch, dict):
        return patch
    hook_specific = patch.get("hookSpecificOutput")
    if not isinstance(hook_specific, dict):
        return patch
    patch = dict(patch)
    if isinstance(hook_specific.get("updatedInput"), dict) and "args" not in patch:
        patch["args"] = hook_specific["updatedInput"]
    if hook_specific.get("additionalContext") is not None and "additional_context" not in patch:
        patch["additional_context"] = hook_specific["additionalContext"]
    return patch


def _external_specs(event, ctx):
    names = _EVENT_ALIASES.get(event, (event,))
    specs = []
    for path in _settings_paths(_project_root_from_ctx(ctx)):
        settings = _load_json(path)
        hooks = (settings or {}).get("hooks") or {}
        for name in names:
            configured = hooks.get(name) or []
            if isinstance(configured, (str, dict)):
                configured = [configured]
            for spec in configured:
                _append_command_spec(specs, spec, event, ctx)
    return specs


def _external_payload(event, ctx):
    handler = ctx.get("self") or ctx.get("handler")
    parent = getattr(handler, "parent", None)
    payload = {
        "event": _EVENT_ALIASES.get(event, (event,))[-1],
        "tool_name": ctx.get("tool_name"),
        "args": _jsonable(ctx.get("args") or {}),
        "prompt": _jsonable(ctx.get("prompt")),
        "images": _jsonable(ctx.get("images")) if "images" in ctx else None,
        "source": _jsonable(ctx.get("source")),
        "stop_reason": _jsonable(ctx.get("stop_reason")),
        "index": ctx.get("index"),
        "tool_num": ctx.get("tool_num"),
        "response": _jsonable(ctx.get("response")),
        "ret": _jsonable(ctx.get("ret")) if "ret" in ctx else None,
        "messages": _jsonable(ctx.get("messages")) if "messages" in ctx else None,
        "estimated_tokens": _jsonable(ctx.get("estimated_tokens")) if "estimated_tokens" in ctx else None,
        "cap": _jsonable(ctx.get("cap")) if "cap" in ctx else None,
        "history_len": _jsonable(ctx.get("history_len")) if "history_len" in ctx else None,
        "cwd": getattr(handler, "cwd", None),
        "project_root": str(_project_root_from_ctx(ctx)),
        "permission_mode": getattr(parent, "permission_mode", None),
    }
    return payload


def _run_external_hook(event, spec, ctx):
    command = spec.get("command")
    timeout = spec.get("timeout", 30)
    display_event = _EVENT_ALIASES.get(event, (event,))[-1]
    payload = json.dumps(_external_payload(event, ctx), ensure_ascii=False)
    try:
        if isinstance(command, list):
            completed = subprocess.run(
                command,
                input=payload,
                text=True,
                capture_output=True,
                timeout=timeout,
                shell=False,
                cwd=str(_project_root_from_ctx(ctx)),
            )
        else:
            completed = subprocess.run(
                str(command),
                input=payload,
                text=True,
                capture_output=True,
                timeout=timeout,
                shell=True,
                cwd=str(_project_root_from_ctx(ctx)),
            )
    except Exception as e:
        sys.stderr.write(f"[hooks] external {event} hook error: {e}\n")
        return ctx

    stdout = (completed.stdout or "").strip()
    stderr = (completed.stderr or "").strip()
    if completed.returncode == 2:
        message = stderr or stdout or f"External hook blocked {event}"
        raise HookBlocked(event, message, {"command": command, "stdout": stdout, "stderr": stderr})
    if completed.returncode != 0:
        sys.stderr.write(f"[hooks] external {event} hook failed ({completed.returncode}): {stderr or stdout}\n")
        return ctx
    if not stdout:
        return ctx
    try:
        patch = json.loads(stdout)
    except Exception as e:
        sys.stderr.write(f"[hooks] external {display_event} hook invalid JSON stdout: {e}\n")
        return ctx
    patch = _normalize_external_patch(patch)
    if isinstance(patch, dict):
        ctx = dict(ctx)
        if isinstance(patch.get("args"), dict):
            merged = dict(ctx.get("args") or {})
            merged.update(patch["args"])
            ctx["args"] = merged
        for key, value in patch.items():
            if key != "args":
                ctx[key] = value
    return ctx


def trigger(event, ctx: dict):
    for fn in _registry.get(event, []):
        try:
            r = fn(ctx)
            if isinstance(r, dict):
                ctx = r
        except Exception as e:
            sys.stderr.write(f"[hooks] {event} callback error: {e}\n")
    for spec in _external_specs(event, ctx):
        ctx = _run_external_hook(event, spec, ctx)
    return ctx


def unregister(event, fn):
    try:
        _registry[event] = [f for f in _registry[event] if f is not fn]
    except KeyError:
        pass


def clear(event=None):
    if event:
        _registry.pop(event, None)
    else:
        _registry.clear()


def has(event):
    return bool(_registry.get(event))


def discover_and_load(plugin_dir=None):
    if plugin_dir is None:
        plugin_dir = os.path.join(_PROJECT_ROOT, 'plugins')
    if not os.path.isdir(plugin_dir):
        return
    parent = os.path.dirname(plugin_dir)
    if parent not in sys.path:
        sys.path.insert(0, parent)
    for fn in sorted(os.listdir(plugin_dir)):
        if fn.startswith('_') or not fn.endswith('.py'):
            continue
        name = fn[:-3]
        load(name)


def load(name):
    try:
        importlib.import_module(f'plugins.{name}')
        return True
    except Exception as e:
        sys.stderr.write(f"[hooks] plugin '{name}' load failed: {e}\n")
        return False
