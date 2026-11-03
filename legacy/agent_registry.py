import json
import re
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path

from skill_registry import parse_frontmatter
from registry_state import is_enabled


PROJECT_ROOT = Path(__file__).resolve().parent
_cached_agents = None


BUILTIN_AGENTS = [
    {
        "name": "reviewer",
        "description": "Code review specialist focused on bugs, regressions, risks, and missing tests.",
        "when_to_use": "Use for independent review of code changes, diffs, or implementation plans.",
        "allowed_tools": ["file_read", "grep_search", "list_files"],
        "prompt_template": (
            "Review $TASK.\n"
            "Prioritize concrete bugs, behavioral regressions, missing tests, and risky assumptions. "
            "Return findings first, ordered by severity, with file/line evidence when available. "
            "If no issues are found, say so clearly and note residual test gaps."
        ),
    },
    {
        "name": "researcher",
        "description": "Research specialist for focused codebase or documentation investigation.",
        "when_to_use": "Use when a task needs independent discovery, comparison, or evidence gathering.",
        "allowed_tools": ["file_read", "grep_search", "list_files", "web_fetch"],
        # This is intentionally code-owned: project/user agent frontmatter must
        # not be able to opt itself into CTF execution policy.
        "delegation_policy": "ctf_readonly_research",
        "prompt_template": (
            "Research $TASK.\n"
            "Gather focused evidence, cite the files, commands, or sources inspected, and separate facts "
            "from inferences. Return a concise brief with findings, uncertainty, and recommended next steps."
        ),
    },
    {
        "name": "planner",
        "description": "Planning specialist for decomposing implementation work into verifiable steps.",
        "when_to_use": "Use before complex implementation or when sequencing and risk control matter.",
        "allowed_tools": ["file_read", "grep_search", "list_files"],
        "prompt_template": (
            "Plan $TASK.\n"
            "Decompose the work into small ordered steps with verification after each meaningful change. "
            "Call out dependencies, risky files, and tests that should prove the result."
        ),
    },
]


@dataclass
class AgentDefinition:
    name: str
    description: str
    when_to_use: str = ""
    allowed_tools: list[str] | None = None
    prompt_template: str = ""
    source: str = "project"
    agent_file: str = ""
    delegation_policy: str = ""


def reset_agent_cache():
    global _cached_agents
    _cached_agents = None


def _default_user_agent_dir():
    return None


def _default_project_agent_dir(project_root=None):
    return Path(project_root or PROJECT_ROOT) / ".secheur-agent" / "agents"


def _parse_list(value):
    if not value:
        return None
    value = str(value).strip()
    if value.startswith("["):
        try:
            parsed = json.loads(value)
            return [str(item).strip() for item in parsed if str(item).strip()]
        except Exception:
            value = value.strip("[]")
    return [item.strip().strip('"').strip("'") for item in value.split(",") if item.strip()]


def _parse_agent_file(path, source):
    try:
        parsed = parse_frontmatter(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    meta = parsed.meta
    name = meta.get("name") or path.stem
    if not name:
        return None
    return AgentDefinition(
        name=name,
        description=meta.get("description", ""),
        when_to_use=meta.get("when_to_use") or meta.get("when-to-use") or "",
        allowed_tools=_parse_list(meta.get("allowed-tools") or meta.get("allowed_tools") or meta.get("tools")),
        prompt_template=parsed.body,
        source=source,
        agent_file=str(path),
    )


def _load_agents_from_dir(base_dir, source, agents):
    base_dir = Path(base_dir)
    if not base_dir.is_dir():
        return
    for path in sorted(base_dir.glob("*.md")):
        if path.name.startswith("."):
            continue
        agent = _parse_agent_file(path, source)
        if agent:
            agents[agent.name] = agent


def _load_builtin_agents(agents):
    for item in BUILTIN_AGENTS:
        agents[item["name"]] = AgentDefinition(
            name=item["name"],
            description=item["description"],
            when_to_use=item["when_to_use"],
            allowed_tools=list(item["allowed_tools"]),
            prompt_template=item["prompt_template"],
            source="builtin",
            agent_file=f"<builtin:{item['name']}>",
            delegation_policy=item.get("delegation_policy", ""),
        )


def discover_agents(project_agent_dir=None, user_agent_dir=None, project_root=None, include_disabled=False):
    global _cached_agents
    use_cache = project_agent_dir is None and user_agent_dir is None and project_root is None and include_disabled
    if use_cache and _cached_agents is not None:
        return list(_cached_agents)

    root = Path(project_root or PROJECT_ROOT)
    agents = {}
    _load_builtin_agents(agents)
    if user_agent_dir is not None:
        _load_agents_from_dir(user_agent_dir, "user", agents)
    _load_agents_from_dir(project_agent_dir or _default_project_agent_dir(root), "project", agents)
    result = [
        agent for agent in agents.values()
        if include_disabled or is_enabled(root, "agents", agent.name)
    ]
    if use_cache:
        _cached_agents = result
    return list(result)


def get_agent_by_name(name, project_agent_dir=None, user_agent_dir=None, project_root=None):
    for agent in discover_agents(
        project_agent_dir=project_agent_dir,
        user_agent_dir=user_agent_dir,
        project_root=project_root,
    ):
        if agent.name == name:
            return agent
    return None


def resolve_agent_prompt(agent, task=""):
    prompt = agent.prompt_template
    prompt = re.sub(r"\$TASK|\$\{TASK\}", task or "", prompt)
    prompt = prompt.replace("${SECHEUR_AGENT_FILE}", agent.agent_file)
    return prompt


def _tool_schema_name(tool):
    if not isinstance(tool, dict):
        return ""
    function = tool.get("function")
    if not isinstance(function, dict):
        return ""
    return function.get("name") or ""


def filter_tools_for_allowed(tools_schema, allowed_tools):
    if not allowed_tools:
        return [deepcopy(tool) for tool in (tools_schema or [])]

    allowed = {str(tool).strip() for tool in allowed_tools if str(tool).strip()}
    return [
        deepcopy(tool)
        for tool in (tools_schema or [])
        if _tool_schema_name(tool) in allowed
    ]


def execute_sub_agent(agent_type, task="", project_agent_dir=None, user_agent_dir=None, project_root=None):
    agent = get_agent_by_name(
        agent_type,
        project_agent_dir=project_agent_dir,
        user_agent_dir=user_agent_dir,
        project_root=project_root,
    )
    if not agent:
        return None
    body = resolve_agent_prompt(agent, task)
    allowed_tools = ", ".join(agent.allowed_tools) if agent.allowed_tools else "no explicit restriction"
    prompt = (
        f"[Sub-Agent:{agent.name}] Run this as a temporary sub-agent task.\n"
        "Stay focused on the delegated task, use only necessary tools, and return a concise report "
        "with findings, evidence, and any residual risks.\n"
        f"Allowed tools: {allowed_tools}\n\n"
        f"Task:\n{task}\n\n"
        f"Agent instructions:\n{body}"
    )
    return {
        "agent": agent.name,
        "description": agent.description,
        "allowed_tools": agent.allowed_tools,
        "source": agent.source,
        "agent_file": agent.agent_file,
        "delegation_policy": agent.delegation_policy,
        "prompt": prompt,
    }


def build_agent_descriptions(project_root=None, project_agent_dir=None, user_agent_dir=None):
    agents = discover_agents(project_agent_dir=project_agent_dir, user_agent_dir=user_agent_dir, project_root=project_root)
    if not agents:
        return ""
    lines = ["# Available Sub-Agents", ""]
    for agent in agents:
        desc = f": {agent.description}" if agent.description else ""
        lines.append(f"- {agent.name}{desc}")
        if agent.when_to_use:
            lines.append(f"  When to use: {agent.when_to_use}")
        if agent.allowed_tools:
            lines.append(f"  Allowed tools: {', '.join(agent.allowed_tools)}")
    lines.append("")
    lines.append("Use the `sub_agent` tool with `agent_type` and `task` to delegate focused temporary-agent work.")
    return "\n".join(lines)
