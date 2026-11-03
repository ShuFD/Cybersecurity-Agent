import fnmatch
import json
import os
import re
from pathlib import Path

from shell_risk import SHELL_COMMAND_SPLIT_LIMIT_REASON, classify_python_code, classify_shell_command


PROJECT_ROOT = Path(__file__).resolve().parent

PERMISSION_MODES = {"default", "acceptEdits", "dontAsk", "bypassPermissions", "plan"}
CONFIRM_TOOLS = {"code_run", "mcp_refresh", "mcp_tool", "task_stop", "web_execute_js"}
MUTATION_TOOLS = {"code_run", "file_write", "file_patch", "web_execute_js", "mcp_refresh", "mcp_tool", "task_stop"}
EDIT_TOOLS = {"file_write", "file_patch"}
SAFE_ACTION_TOOLS = {"verify_flag", "check_flag"}
KNOWN_READ_ONLY_TOOLS = {
    "file_read",
    "grep_search",
    "list_files",
    "memory_search",
    "task_output",
    "tool_search",
    "web_fetch",
    "web_scan",
}
SHELL_CODE_TYPES = {"bash", "sh", "shell", "zsh", "fish", "powershell", "ps1", "pwsh", "cmd"}
PYTHON_CODE_TYPES = {"python", "py"}
SENSITIVE_SHELL_ENV_PREFIXES = {
    "BASH_ENV",
    "DYLD_INSERT_LIBRARIES",
    "ENV",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "IFS",
    "LD_PRELOAD",
    "NODE_OPTIONS",
    "NODE_PATH",
    "PATH",
    "PYTHONHOME",
    "PYTHONPATH",
}
TOOL_ALIASES = {
    "bash": "code_run",
    "run_shell": "code_run",
    "write": "file_write",
    "write_file": "file_write",
    "edit": "file_patch",
    "edit_file": "file_patch",
    "read": "file_read",
    "read_file": "file_read",
}

DANGEROUS_PATTERNS = [
    re.compile(r"\brm\s"),
    re.compile(r"\bgit\s+(push|reset|clean|checkout\s+\.)"),
    re.compile(r"\bsudo\b"),
    re.compile(r"\bmkfs\b"),
    re.compile(r"\bdd\s"),
    re.compile(r">\s*/dev/"),
    re.compile(r"\bkill\b"),
    re.compile(r"\bpkill\b"),
    re.compile(r"\breboot\b"),
    re.compile(r"\bshutdown\b"),
    re.compile(r"\bdel\s", re.IGNORECASE),
    re.compile(r"\brmdir\s", re.IGNORECASE),
    re.compile(r"\bformat\s", re.IGNORECASE),
    re.compile(r"\btaskkill\s", re.IGNORECASE),
    re.compile(r"\bRemove-Item\s", re.IGNORECASE),
    re.compile(r"\bStop-Process\s", re.IGNORECASE),
    re.compile(r"\bshutil\.rmtree\s*\("),
    re.compile(r"\bos\.remove\s*\("),
    re.compile(r"\bos\.unlink\s*\("),
    re.compile(r"\bPath\([^)]*\)\.unlink\s*\("),
    re.compile(r"\b(curl|wget)\b[\s\S]*\|\s*(sudo\s+)?(ba)?sh\b", re.IGNORECASE),
    re.compile(r"\b(ba)?sh\s+<\s*\(\s*(curl|wget)\b", re.IGNORECASE),
    re.compile(r"\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[\s\S]*\|\s*(iex|Invoke-Expression)\b", re.IGNORECASE),
]

_cached_rules = None
_cached_rules_signature = None


def _canonical_tool(tool_name):
    name = (tool_name or "").strip()
    return TOOL_ALIASES.get(name.lower(), name)


def is_dangerous(command):
    return any(pattern.search(command or "") for pattern in DANGEROUS_PATTERNS)


def _parse_rule(rule):
    raw = str(rule).strip()
    if raw.startswith("mcp__"):
        return {"tool": "mcp_tool", "pattern": raw}
    match = re.match(r"^([A-Za-z_]+)\((.*)\)$", raw)
    if match:
        return {"tool": _canonical_tool(match.group(1)), "pattern": match.group(2)}
    return {"tool": _canonical_tool(raw), "pattern": None}


def _load_settings(path):
    try:
        path = Path(path)
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _default_settings_paths(project_root=None):
    root = Path(project_root) if project_root else PROJECT_ROOT
    return [
        root / "settings.json",
        root / "settings.local.json",
        root / ".secheur-agent" / "settings.json",
        root / ".secheur-agent" / "settings.local.json",
    ]


def _settings_signature(paths):
    signature = []
    for path in paths:
        path = Path(path)
        try:
            st = path.stat()
            signature.append((str(path), st.st_mtime_ns, st.st_size))
        except OSError:
            signature.append((str(path), None, None))
    return tuple(signature)


def load_permission_rules(settings_paths=None, project_root=None):
    global _cached_rules, _cached_rules_signature
    paths = list(settings_paths if settings_paths is not None else _default_settings_paths(project_root))
    signature = _settings_signature(paths) if settings_paths is None else None
    if settings_paths is None and _cached_rules is not None and signature == _cached_rules_signature:
        return _cached_rules

    allow = []
    deny = []
    ask = []
    for path in paths:
        settings = _load_settings(path)
        if not settings or "permissions" not in settings:
            continue
        permissions = settings.get("permissions") or {}
        for rule in permissions.get("allow") or []:
            allow.append(_parse_rule(rule))
        for rule in permissions.get("deny") or []:
            deny.append(_parse_rule(rule))
        for rule in permissions.get("ask") or []:
            ask.append(_parse_rule(rule))

    rules = {"allow": allow, "deny": deny, "ask": ask}
    if settings_paths is None:
        _cached_rules = rules
        _cached_rules_signature = signature
    return rules


def reset_permission_cache():
    global _cached_rules, _cached_rules_signature
    _cached_rules = None
    _cached_rules_signature = None


def _has_symlink_component(path):
    try:
        path = Path(path)
        parts = path.parts
        current = Path(parts[0]) if path.is_absolute() else Path(".")
        start = 1 if path.is_absolute() else 0
        for part in parts[start:]:
            current = current / part
            if current.is_symlink():
                if str(current) in {"/var", "/tmp", "/etc"}:
                    continue
                return True
    except Exception:
        return False
    return False


def _candidate_values(tool_name, args):
    if tool_name == "code_run":
        return [str(args.get("script") or args.get("code") or "")]
    if tool_name == "mcp_tool":
        values = []
        for key in ("tool_name", "name", "raw_prefixed_name", "raw_tool_name"):
            value = args.get(key)
            if value not in (None, ""):
                values.append(str(value))
        return values
    values = []
    for key in ("path", "raw_path", "file_path"):
        value = args.get(key)
        if value not in (None, ""):
            text = str(value)
            values.append(text)
            try:
                path = Path(text)
                if _has_symlink_component(path):
                    values.append(str(path.resolve()))
                    values.append(os.path.realpath(text))
            except Exception:
                pass
    return values


def _shell_risk_for(tool_name, args):
    if tool_name != "code_run":
        return None
    values = _candidate_values(tool_name, args)
    command = values[0] if values else ""
    if not command:
        return None
    code_type = str((args or {}).get("type") or "python").strip().lower()
    report = classify_python_code(command) if code_type in PYTHON_CODE_TYPES else classify_shell_command(command)
    return {
        "level": report.level,
        "reason": report.reason,
        "matched_command": report.matched_command,
        "commands": report.commands,
        "env_prefixes": report.env_prefixes,
    }


def _is_shell_code_run(args):
    code_type = str((args or {}).get("type") or "python").strip().lower()
    return code_type in SHELL_CODE_TYPES


def _sensitive_env_prefixes(risk):
    if not isinstance(risk, dict):
        return []
    prefixes = risk.get("env_prefixes") or {}
    if not isinstance(prefixes, dict):
        return []
    return sorted(key for key in prefixes if str(key).upper() in SENSITIVE_SHELL_ENV_PREFIXES)


def _is_unparseable_shell_risk(risk):
    return isinstance(risk, dict) and risk.get("reason") == "unparseable command"


def _is_split_limit_shell_risk(risk):
    return isinstance(risk, dict) and risk.get("reason") == SHELL_COMMAND_SPLIT_LIMIT_REASON


def _with_risk(decision, risk):
    if risk is None:
        return decision
    decision = dict(decision)
    decision["risk"] = risk
    return decision


def _code_run_command_candidates(args):
    values = _candidate_values("code_run", args)
    command = values[0] if values else ""
    if not command:
        return []
    code_type = str((args or {}).get("type") or "python").strip().lower()
    report = classify_python_code(command) if code_type in PYTHON_CODE_TYPES else classify_shell_command(command)
    candidates = list(report.commands)
    if report.matched_command:
        candidates.append(report.matched_command)
    unique = []
    seen = set()
    for candidate in candidates:
        if candidate and candidate not in seen:
            unique.append(candidate)
            seen.add(candidate)
    return unique


def _rule_candidate_values(tool_name, args):
    if tool_name == "code_run":
        return _code_run_command_candidates(args)
    return _candidate_values(tool_name, args)


def _match_pattern(pattern, values):
    if pattern is None:
        return True
    return any(fnmatch.fnmatchcase(value, pattern) for value in values)


def _matches_rule(rule, tool_name, args):
    if rule["tool"] != tool_name:
        return False
    return _match_pattern(rule.get("pattern"), _rule_candidate_values(tool_name, args))


def _allow_rules_cover_tool(allow_rules, tool_name, args):
    matching_rules = [rule for rule in allow_rules if rule["tool"] == tool_name]
    if not matching_rules:
        return False
    if tool_name != "code_run":
        return any(_match_pattern(rule.get("pattern"), _candidate_values(tool_name, args)) for rule in matching_rules)

    commands = _code_run_command_candidates(args)
    if not commands:
        return False
    return all(any(_match_pattern(rule.get("pattern"), [command]) for rule in matching_rules) for command in commands)


def _same_file(a, b):
    try:
        return Path(a).resolve() == Path(b).resolve()
    except Exception:
        return os.path.abspath(str(a)) == os.path.abspath(str(b))


def _is_within_project(target, project_root=None):
    root = Path(project_root) if project_root else PROJECT_ROOT
    try:
        root = root.resolve()
        target_path = Path(target)
        if not target_path.is_absolute():
            target_path = root / target_path
        resolved = target_path.resolve()
        return resolved == root or root in resolved.parents
    except Exception:
        return False


def _tool_meta_read_only(tool_meta):
    if tool_meta is None:
        return None
    if isinstance(tool_meta, dict):
        return bool(tool_meta.get("read_only"))
    return bool(getattr(tool_meta, "read_only", False))


def check_tool_permission(
    tool_name,
    args,
    mode="default",
    plan_file_path=None,
    settings_paths=None,
    project_root=None,
    tool_meta=None,
):
    tool_name = _canonical_tool(tool_name)
    args = args or {}
    mode = mode or "default"
    rules = load_permission_rules(settings_paths=settings_paths, project_root=project_root)
    risk = _shell_risk_for(tool_name, args)

    if mode == "bypassPermissions":
        return _with_risk({"action": "allow"}, risk)

    for rule in rules["deny"]:
        if _matches_rule(rule, tool_name, args):
            return _with_risk({"action": "deny", "message": f"Denied by permission rule for {tool_name}"}, risk)

    # plan 模式的文件写入限制优先于 allow 规则，避免 file_write/file_patch 的 allow 规则绕过 plan 模式；
    # 其余工具（如 mcp_tool）仍允许通过 allow 规则显式预批
    if mode == "plan" and tool_name in EDIT_TOOLS:
        target = args.get("path") or args.get("file_path")
        if plan_file_path and target and _same_file(target, plan_file_path):
            return _with_risk({"action": "allow"}, risk)
        return _with_risk({"action": "deny", "message": f"Blocked in plan mode: {tool_name}"}, risk)

    read_only = _tool_meta_read_only(tool_meta)
    if mode == "plan" and read_only is True:
        return _with_risk({"action": "allow"}, risk)

    if tool_name == "code_run" and _is_shell_code_run(args) and _is_unparseable_shell_risk(risk):
        if mode == "dontAsk":
            return _with_risk(
                {"action": "deny", "message": "Auto-denied unparseable shell command in dontAsk mode"},
                risk,
            )
        return _with_risk(
            {"action": "confirm", "message": "Unparseable shell command requires user confirmation"},
            risk,
        )

    if tool_name == "code_run" and _is_shell_code_run(args) and _is_split_limit_shell_risk(risk):
        if mode == "dontAsk":
            return _with_risk(
                {"action": "deny", "message": "Auto-denied shell command split limit in dontAsk mode"},
                risk,
            )
        return _with_risk(
            {"action": "confirm", "message": "Shell command split limit requires user confirmation"},
            risk,
        )

    if _allow_rules_cover_tool(rules["allow"], tool_name, args):
        return _with_risk({"action": "allow"}, risk)

    for rule in rules["ask"]:
        if _matches_rule(rule, tool_name, args):
            if mode == "dontAsk":
                return _with_risk(
                    {"action": "deny", "message": f"Auto-denied ask permission rule in dontAsk mode for {tool_name}"},
                    risk,
                )
            return _with_risk(
                {"action": "confirm", "message": f"Confirmation required by permission rule for {tool_name}"},
                risk,
            )

    if mode == "plan" and read_only is False:
        return _with_risk({"action": "deny", "message": f"Blocked in plan mode: {tool_name}"}, risk)

    if mode == "plan" and tool_name in MUTATION_TOOLS:
        return _with_risk({"action": "deny", "message": f"Blocked in plan mode: {tool_name}"}, risk)

    if tool_name in EDIT_TOOLS:
        target = args.get("path") or args.get("file_path")
        if target and not _is_within_project(target, project_root):
            if mode == "dontAsk":
                return _with_risk(
                    {"action": "deny", "message": f"Auto-denied write outside project root in dontAsk mode: {target}"},
                    risk,
                )
            return _with_risk(
                {"action": "confirm", "message": f"Writing outside project root requires user confirmation: {target}"},
                risk,
            )

    if mode == "acceptEdits" and tool_name in EDIT_TOOLS:
        return _with_risk({"action": "allow"}, risk)

    if tool_name in SAFE_ACTION_TOOLS:
        return _with_risk({"action": "allow"}, risk)

    if tool_name in CONFIRM_TOOLS and is_dangerous(_candidate_values(tool_name, args)[0] if _candidate_values(tool_name, args) else ""):
        if mode == "dontAsk":
            return _with_risk({"action": "deny", "message": "Auto-denied dangerous command in dontAsk mode"}, risk)
        return _with_risk({"action": "confirm", "message": "Dangerous command requires user confirmation"}, risk)

    sensitive_env = _sensitive_env_prefixes(risk)
    if tool_name == "code_run" and _is_shell_code_run(args) and sensitive_env:
        names = ", ".join(sensitive_env)
        if mode == "dontAsk":
            return _with_risk(
                {"action": "deny", "message": f"Auto-denied shell environment prefix in dontAsk mode: {names}"},
                risk,
            )
        return _with_risk(
            {"action": "confirm", "message": f"Shell environment prefix requires user confirmation: {names}"},
            risk,
        )

    if tool_name == "code_run" and _is_shell_code_run(args) and risk is not None and risk.get("level") != "readonly":
        if mode == "dontAsk":
            return _with_risk(
                {"action": "deny", "message": "Auto-denied shell command risk in dontAsk mode"},
                risk,
            )
        return _with_risk(
            {
                "action": "confirm",
                "message": f"Shell command risk requires user confirmation: {risk.get('reason', 'unknown risk')}",
            },
            risk,
        )

    if read_only is False and tool_name not in EDIT_TOOLS and tool_name not in CONFIRM_TOOLS:
        if mode == "dontAsk":
            return _with_risk(
                {"action": "deny", "message": f"Auto-denied non-read-only tool in dontAsk mode: {tool_name}"},
                risk,
            )
        return _with_risk({"action": "confirm", "message": f"{tool_name} requires user confirmation"}, risk)

    if tool_name in CONFIRM_TOOLS:
        if mode == "dontAsk":
            return _with_risk(
                {"action": "deny", "message": f"Auto-denied unapproved {tool_name} in dontAsk mode"},
                risk,
            )
        return _with_risk({"action": "confirm", "message": f"{tool_name} requires user confirmation"}, risk)

    if read_only is None and tool_name not in KNOWN_READ_ONLY_TOOLS and tool_name not in EDIT_TOOLS:
        if mode == "plan":
            return _with_risk({"action": "deny", "message": f"Blocked in plan mode: {tool_name}"}, risk)
        if mode == "dontAsk":
            return _with_risk(
                {"action": "deny", "message": f"Auto-denied missing tool metadata in dontAsk mode: {tool_name}"},
                risk,
            )
        return _with_risk({"action": "confirm", "message": f"{tool_name} requires user confirmation"}, risk)

    return _with_risk({"action": "allow"}, risk)
