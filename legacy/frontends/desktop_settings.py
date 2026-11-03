import json
import re
import shutil
import shlex
from pathlib import Path

from registry_state import (
    STATE_DIR_NAME,
    clear_registry_enabled_state,
    coerce_enabled,
    load_registry_state,
    save_registry_state as persist_registry_state,
    state_path,
)

try:
    from .model_config import delete_model_config, find_config_by_name, load_all_configs, load_current_config, mask_secret, upsert_model_config
except Exception:
    from model_config import delete_model_config, find_config_by_name, load_all_configs, load_current_config, mask_secret, upsert_model_config
from skill_registry import project_skill_dirs
from agent_registry import discover_agents


def _read_json(path, fallback):
    path = Path(path)
    if not path.exists():
        return fallback
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else fallback
    except Exception:
        return fallback


def _write_json_atomic(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def _enabled_map(state, key):
    value = state.get(key) if isinstance(state, dict) else {}
    return value if isinstance(value, dict) else {}


def save_registry_state(root, updates):
    return persist_registry_state(root, updates)


def _is_enabled(enabled_by_name, name):
    return coerce_enabled(enabled_by_name.get(name, True))


def _attach_enabled(items, enabled_by_name):
    return [{**item, "enabled": _is_enabled(enabled_by_name, item["name"])} for item in items]


def _default_skill_dirs(root, custom_skill_dirs=None):
    return project_skill_dirs(root, extra_skill_dirs=custom_skill_dirs)


def _default_mcp_config_paths(root):
    from mcp_client import mcp_config_paths

    return mcp_config_paths(Path(root))


def project_mcp_config_path(root):
    return Path(root) / STATE_DIR_NAME / "mcp.json"


def _default_agent_dir(root):
    return Path(root) / STATE_DIR_NAME / "agents"


def _ensure_registry_dirs(root):
    root = Path(root)
    paths = [
        state_path(root).parent,
        root / STATE_DIR_NAME / "skills",
        _default_agent_dir(root),
        root / STATE_DIR_NAME / "rules",
    ]
    for path in paths:
        try:
            path.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass
    mcp_path = project_mcp_config_path(root)
    if not mcp_path.exists():
        try:
            mcp_path.write_text('{"mcpServers": {}}\n', encoding="utf-8")
        except Exception:
            pass


def _normalize_mcp_args(value):
    if value in (None, ""):
        return []
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    if isinstance(value, str):
        return shlex.split(value)
    raise ValueError("MCP args must be a string or list")


def _normalize_mcp_env(value):
    if value in (None, ""):
        return {}
    if not isinstance(value, dict):
        raise ValueError("MCP env must be an object")
    return {str(key): str(val) for key, val in value.items() if str(key).strip()}


def _normalize_mcp_headers(value):
    if value in (None, ""):
        return {}
    if not isinstance(value, dict):
        raise ValueError("MCP headers must be an object")
    return {str(key): str(val) for key, val in value.items() if str(key).strip()}


def _normalize_mcp_timeout(value):
    if value in (None, ""):
        return None
    try:
        timeout = float(value)
    except (TypeError, ValueError):
        raise ValueError("MCP timeout must be a positive number")
    if timeout <= 0:
        raise ValueError("MCP timeout must be a positive number")
    return timeout


_SAFE_SKILL_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")
_SAFE_AGENT_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")


def _skill_frontmatter_value(value):
    return str(value or "").replace("\n", " ").strip()


def save_project_skill(root, form_config):
    root = Path(root)
    cfg = form_config or {}
    name = str(cfg.get("name") or "").strip()
    if not _SAFE_SKILL_NAME_RE.fullmatch(name):
        raise ValueError("Skill name must use letters, numbers, dots, underscores or hyphens")
    description = _skill_frontmatter_value(cfg.get("description"))
    context = str(cfg.get("context") or "inline").strip()
    if context not in {"inline", "fork"}:
        raise ValueError("Skill context must be inline or fork")
    body = str(cfg.get("body") or cfg.get("prompt") or "").strip()
    if not body:
        raise ValueError("Skill body is required")

    skill_dir = root / STATE_DIR_NAME / "skills" / name
    skill_file = skill_dir / "SKILL.md"
    lines = ["---", f"name: {name}"]
    if description:
        lines.append(f"description: {description}")
    if context != "inline":
        lines.append(f"context: {context}")
    lines.extend(["---", "", body, ""])
    skill_dir.mkdir(parents=True, exist_ok=True)
    tmp = skill_file.with_suffix(".tmp")
    tmp.write_text("\n".join(lines), encoding="utf-8")
    tmp.replace(skill_file)
    save_registry_state(root, {"skills": {name: True}})
    return {"name": name, "path": str(skill_file), "skillDir": str(skill_dir)}


def delete_project_skill(root, name):
    root = Path(root)
    name = str(name or "").strip()
    if not _SAFE_SKILL_NAME_RE.fullmatch(name):
        raise ValueError("Skill name must use letters, numbers, dots, underscores or hyphens")
    skill_dir = root / STATE_DIR_NAME / "skills" / name
    skill_file = skill_dir / "SKILL.md"
    if not skill_file.exists():
        raise ValueError("Project Skill not found")
    shutil.rmtree(skill_dir)
    clear_registry_enabled_state(root, "skills", name)
    return {"name": name, "path": str(skill_file), "skillDir": str(skill_dir)}


def _normalize_tool_list(value):
    if value in (None, ""):
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return [item.strip() for item in str(value).split(",") if item.strip()]


def save_project_agent(root, form_config):
    root = Path(root)
    cfg = form_config or {}
    name = str(cfg.get("name") or "").strip()
    if not _SAFE_AGENT_NAME_RE.fullmatch(name):
        raise ValueError("Agent name must use letters, numbers, dots, underscores or hyphens")
    body = str(cfg.get("body") or cfg.get("prompt") or "").strip()
    if not body:
        raise ValueError("Agent body is required")
    description = _skill_frontmatter_value(cfg.get("description"))
    when_to_use = _skill_frontmatter_value(cfg.get("whenToUse") or cfg.get("when_to_use"))
    allowed_tools = _normalize_tool_list(cfg.get("allowedTools") or cfg.get("allowed_tools"))

    agent_dir = _default_agent_dir(root)
    agent_file = agent_dir / f"{name}.md"
    lines = ["---", f"name: {name}"]
    if description:
        lines.append(f"description: {description}")
    if when_to_use:
        lines.append(f"when_to_use: {when_to_use}")
    if allowed_tools:
        lines.append("allowed-tools: " + ",".join(allowed_tools))
    lines.extend(["---", "", body, ""])
    agent_dir.mkdir(parents=True, exist_ok=True)
    tmp = agent_file.with_suffix(".tmp")
    tmp.write_text("\n".join(lines), encoding="utf-8")
    tmp.replace(agent_file)
    save_registry_state(root, {"agents": {name: True}})
    return {"name": name, "path": str(agent_file), "agentDir": str(agent_dir)}


def delete_project_agent(root, name):
    root = Path(root)
    name = str(name or "").strip()
    if not _SAFE_AGENT_NAME_RE.fullmatch(name):
        raise ValueError("Agent name must use letters, numbers, dots, underscores or hyphens")
    agent_file = _default_agent_dir(root) / f"{name}.md"
    if not agent_file.exists():
        raise ValueError("Project Agent not found")
    agent_file.unlink()
    clear_registry_enabled_state(root, "agents", name)
    return {"name": name, "path": str(agent_file), "agentDir": str(agent_file.parent)}


def save_mcp_server(root, form_config):
    root = Path(root)
    cfg = form_config or {}
    name = str(cfg.get("name") or "").strip()
    command = str(cfg.get("command") or "").strip()
    url = str(cfg.get("url") or "").strip()
    if not name:
        raise ValueError("MCP server name is required")
    if not command and not url:
        raise ValueError("MCP command or HTTP URL is required")

    if url:
        server = {"url": url}
        headers = _normalize_mcp_headers(cfg.get("headers"))
        if headers:
            server["headers"] = headers
    else:
        server = {
            "command": command,
            "args": _normalize_mcp_args(cfg.get("args")),
        }
        env = _normalize_mcp_env(cfg.get("env"))
        if env:
            server["env"] = env
        if cfg.get("cwd"):
            server["cwd"] = str(cfg.get("cwd"))
    timeout = _normalize_mcp_timeout(cfg.get("timeout"))
    if timeout is not None:
        server["timeout"] = timeout

    path = project_mcp_config_path(root)
    raw = _read_json(path, {})
    servers = raw.get("mcpServers", raw) if isinstance(raw, dict) else {}
    if not isinstance(servers, dict):
        servers = {}
    servers[name] = server
    payload = {"mcpServers": servers}
    _write_json_atomic(path, payload)
    save_registry_state(root, {"mcpServers": {name: True}})
    return {"name": name, "config": server, "path": str(path)}


def delete_project_mcp_server(root, name):
    root = Path(root)
    name = str(name or "").strip()
    if not name:
        raise ValueError("MCP server name is required")
    path = project_mcp_config_path(root)
    raw = _read_json(path, {})
    servers = raw.get("mcpServers", raw) if isinstance(raw, dict) else {}
    if not isinstance(servers, dict) or name not in servers:
        raise ValueError("Project MCP server not found")
    removed = servers.pop(name)
    _write_json_atomic(path, {"mcpServers": servers})
    clear_registry_enabled_state(root, "mcpServers", name)
    return {"name": name, "config": removed, "path": str(path)}


def _load_mcp_servers(root):
    try:
        from mcp_client import load_mcp_configs

        configs = load_mcp_configs(project_root=root, include_disabled=True, user_settings_path=root / STATE_DIR_NAME / "_no_user_settings.json")
        path_by_name = {}
        for path in _default_mcp_config_paths(root):
            raw = _read_json(path, {})
            servers = raw.get("mcpServers", raw) if isinstance(raw, dict) else {}
            if not isinstance(servers, dict):
                continue
            for name in servers:
                path_by_name[str(name)] = str(Path(path))
        return configs, path_by_name
    except Exception:
        return {}, {}


def _parse_skill_header(path):
    text = path.read_text(encoding="utf-8", errors="replace")
    name = path.parent.name
    description = ""
    context = "inline"
    body = text.strip()
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            for line in text[3:end].splitlines():
                if ":" not in line:
                    continue
                key, value = line.split(":", 1)
                key = key.strip().lower()
                value = value.strip().strip("'\"")
                if key == "name" and value:
                    name = value
                elif key == "description":
                    description = value
                elif key == "context" and value in {"inline", "fork"}:
                    context = value
            body = text[end + len("\n---"):].strip()
    return name, description, context, body


def _load_skills(root, custom_skill_dirs=None):
    root = Path(root)
    skills = {}
    for base in _default_skill_dirs(root, custom_skill_dirs=custom_skill_dirs):
        if not base.exists():
            continue
        for skill_md in sorted(base.glob("*/SKILL.md")):
            try:
                name, description, context, body = _parse_skill_header(skill_md)
            except Exception:
                name, description, context, body = skill_md.parent.name, "", "inline", ""
            skills[name] = {
                "name": name,
                "description": description,
                "context": context,
                "body": body,
                "skillDir": str(skill_md.parent),
                "path": str(skill_md.parent),
                "sourcePath": str(skill_md),
                "openPath": str(skill_md.parent),
                "source": str(base),
            }
    return list(skills.values())


def _load_agents(root):
    root = Path(root)
    agents = []
    for agent in discover_agents(project_root=root, include_disabled=True):
        is_builtin = str(agent.agent_file).startswith("<builtin:")
        source_path = "" if is_builtin else agent.agent_file
        agents.append({
            "name": agent.name,
            "description": agent.description,
            "whenToUse": agent.when_to_use,
            "allowedTools": agent.allowed_tools or [],
            "body": agent.prompt_template,
            "source": agent.source,
            "sourcePath": source_path,
            "openPath": str(Path(source_path).parent) if source_path else "",
        })
    return sorted(agents, key=lambda item: (item["source"] != "builtin", item["name"]))


def _load_tools(root, tools_schema_path=None):
    root = Path(root)
    schema_path = Path(tools_schema_path) if tools_schema_path else root / "assets" / "tools_schema.json"
    tools = []
    raw = []
    if schema_path.exists():
        try:
            raw = json.loads(schema_path.read_text(encoding="utf-8"))
        except Exception:
            raw = []
    for item in raw if isinstance(raw, list) else []:
        fn = item.get("function") if isinstance(item, dict) else {}
        if not isinstance(fn, dict) or not fn.get("name"):
            continue
        tools.append({
            "name": str(fn.get("name")),
            "description": str(fn.get("description") or ""),
            "source": str(schema_path),
            "sourcePath": str(schema_path),
            "openPath": str(schema_path.parent),
            "deferred": False,
        })

    try:
        from tool_registry import VIRTUAL_TOOL_SCHEMAS

        existing = {item["name"] for item in tools}
        for name, schema in sorted(VIRTUAL_TOOL_SCHEMAS.items()):
            if name in existing:
                continue
            fn = schema.get("function", {})
            tools.append({
                "name": name,
                "description": str(fn.get("description") or ""),
                "source": "virtual",
                "sourcePath": "virtual",
                "openPath": "",
                "deferred": True,
            })
    except Exception:
        pass
    return sorted(tools, key=lambda item: item["name"])


def _existing_paths(paths):
    return [str(Path(path)) for path in paths if Path(path).exists()]


def build_registry(root, tools_schema_path=None, custom_skill_dirs=None):
    root = Path(root)
    _ensure_registry_dirs(root)
    state = load_registry_state(root)
    mcp_enabled = _enabled_map(state, "mcpServers")
    skill_enabled = _enabled_map(state, "skills")
    agent_enabled = _enabled_map(state, "agents")
    tool_enabled = _enabled_map(state, "tools")
    mcp_configs, mcp_paths = _load_mcp_servers(root)

    mcp_servers = []
    for name, cfg in sorted(mcp_configs.items()):
        source_path = mcp_paths.get(name, "")
        mcp_servers.append({
            "name": name,
            "enabled": _is_enabled(mcp_enabled, name),
            "transport": "http" if cfg.get("url") else "stdio",
            "command": cfg.get("command", ""),
            "args": cfg.get("args", []),
            "url": cfg.get("url", ""),
            "headers": cfg.get("headers", {}) if isinstance(cfg.get("headers", {}), dict) else {},
            "env": cfg.get("env", {}) if isinstance(cfg.get("env", {}), dict) else {},
            "cwd": cfg.get("cwd", ""),
            "timeout": cfg.get("timeout", ""),
            "path": source_path,
            "sourcePath": source_path,
            "openPath": str(Path(source_path).parent) if source_path else "",
        })

    return {
        "statePath": str(state_path(root)),
        "sources": {
            "statePath": str(state_path(root)),
            "mcpConfigPaths": _existing_paths(_default_mcp_config_paths(root)),
            "skillDirs": _existing_paths(_default_skill_dirs(root, custom_skill_dirs=custom_skill_dirs)),
            "agentDir": str(_default_agent_dir(root)),
            "toolSchemaPath": str(Path(tools_schema_path) if tools_schema_path else root / "assets" / "tools_schema.json"),
        },
        "mcpServers": mcp_servers,
        "skills": _attach_enabled(_load_skills(root, custom_skill_dirs=custom_skill_dirs), skill_enabled),
        "agents": _attach_enabled(_load_agents(root), agent_enabled),
        "tools": _attach_enabled(_load_tools(root, tools_schema_path=tools_schema_path), tool_enabled),
    }


def load_api_config(root):
    root = Path(root)
    config = load_current_config(root / "mykey.py")
    apikey = str(config.get("apikey") or "")
    safe = dict(config)
    safe["apikey"] = ""
    bundle = load_all_configs(root / "mykey.py")
    return {
        "mykeyPath": str(root / "mykey.py"),
        "hasApiKey": bool(apikey),
        "maskedApiKey": mask_secret(apikey),
        "config": safe,
        "profiles": bundle["profiles"],
        "activeNames": bundle["activeNames"],
    }


def save_api_config(root, form_config):
    root = Path(root)
    upsert_model_config(root / "mykey.py", form_config or {})
    return load_api_config(root)


def resolve_api_fetch_config(root, form_config):
    root = Path(root)
    cfg = dict(form_config or {})
    if str(cfg.get("apikey") or "").strip():
        return cfg
    saved = find_config_by_name(root / "mykey.py", cfg.get("name")) or load_current_config(root / "mykey.py")
    if not isinstance(saved, dict):
        return cfg
    for key in ("apikey", "apibase", "type", "model", "api_mode", "relay_compat_system_prompt", "thinking_type", "proxy"):
        if not str(cfg.get(key) or "").strip() and saved.get(key) not in (None, ""):
            cfg[key] = saved.get(key)
    return cfg


def delete_api_config(root, name):
    root = Path(root)
    delete_model_config(root / "mykey.py", name)
    return load_api_config(root)


DEFAULT_JUDGE_CONFIG = {
    "enabled": True,
    "every_n_turns": 5,
    "model_profile": None,
    "max_history_messages": 8,
}


def normalize_judge_config(raw):
    cfg = dict(DEFAULT_JUDGE_CONFIG)
    if not isinstance(raw, dict):
        return cfg
    cfg["enabled"] = bool(raw.get("enabled", cfg["enabled"]))
    try:
        cfg["every_n_turns"] = max(1, min(50, int(raw.get("every_n_turns", cfg["every_n_turns"]))))
    except Exception:
        pass
    try:
        cfg["max_history_messages"] = max(2, min(20, int(raw.get("max_history_messages", cfg["max_history_messages"]))))
    except Exception:
        pass
    profile = raw.get("model_profile")
    if isinstance(profile, str) and profile.strip():
        cfg["model_profile"] = profile.strip()
    elif profile in (None, "", "default"):
        cfg["model_profile"] = None
    return cfg


def read_judge_config(config):
    if not isinstance(config, dict):
        return dict(DEFAULT_JUDGE_CONFIG)
    return normalize_judge_config(config.get("judge"))


def write_judge_config(config, judge_cfg):
    merged = dict(config) if isinstance(config, dict) else {}
    merged["judge"] = normalize_judge_config(judge_cfg)
    return merged
