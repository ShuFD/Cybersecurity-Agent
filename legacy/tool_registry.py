import copy

from mcp_client import mcp_config_path_hint
from registry_state import disabled_names


DEFAULT_DEFERRED_TOOLS = {
    "grep_search",
    "list_files",
    "mcp_refresh",
    "skill",
    "sub_agent",
    "web_fetch",
    "web_scan",
    "web_execute_js",
    "start_long_term_update",
    "plan_expand",
    "plan_revise",
    "plan_status",
}

ALWAYS_ACTIVE_VIRTUAL_TOOLS = {
    "attack_memory_search",
    "memory_search",
}

TOOL_SEARCH_SCHEMA = {
    "type": "function",
    "function": {
        "name": "tool_search",
        "description": (
            "Search for less-common tools by name or capability. "
            "Returns matching tool schemas and activates them for later turns."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Tool name or capability keyword, such as browser, memory, web, js, crypto, ctf, attack, writeup.",
                }
            },
            "required": ["query"],
        },
    },
}

SKILL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "skill",
        "description": (
            "Invoke a registered SecHeur Agent skill from the project-owned .secheur-agent/skills/<name>/SKILL.md directory. "
            "Legacy skill/<name>/SKILL.md and skills/<name>/SKILL.md are read for compatibility. "
            "Inline skills return resolved instructions; skills declaring `context: fork` run as an isolated temporary sub-agent "
            "when supported, otherwise their prompt is saved to a transcript instead of injected into the main context."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "skill_name": {"type": "string", "description": "Skill name from SKILL.md frontmatter or folder name."},
                "args": {"type": "string", "description": "Optional arguments substituted into $ARGUMENTS."},
            },
            "required": ["skill_name"],
        },
    },
}

SUB_AGENT_SCHEMA = {
    "type": "function",
    "function": {
        "name": "sub_agent",
        "description": (
            "Delegate focused work to a named SecHeur Agent sub-agent type. "
            "In CLI and desktop this starts a temporary sub-agent, streams its status/dialog, "
            "and returns its concise report to the main agent."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "agent_type": {"type": "string", "description": "Sub-agent type name from .secheur-agent/agents."},
                "task": {"type": "string", "description": "Focused task to delegate."},
            },
            "required": ["agent_type", "task"],
        },
    },
}

PLAN_EXPAND_SCHEMA = {
    "type": "function",
    "function": {
        "name": "plan_expand",
        "description": (
            "Add a local evidence-backed subtree to the executable program plan. "
            "New action nodes require explicit tools, args, preconditions, and failure policies."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "parent_id": {"type": "string", "description": "Existing expandable parent node id."},
                "reason": {"type": "string", "description": "Why this local expansion is justified."},
                "evidence_refs": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Existing evidence ids supporting the expansion.",
                },
                "nodes": {
                    "type": "array",
                    "items": {"type": "object"},
                    "description": (
                        "Flat node definitions. Supported kinds: sequence, parallel, if, while, action, probe, "
                        "verify, reflect, finish. Nested relationships use node ids."
                    ),
                },
                "facts": {
                    "type": "array",
                    "items": {"type": "object"},
                    "description": "Optional fact claims with key, value, confidence, and existing evidence_refs.",
                },
                "hypotheses": {
                    "type": "array",
                    "items": {"type": "object"},
                    "description": "Optional probe-only hypotheses with id, claim, confidence, and evidence_refs.",
                },
            },
            "required": ["parent_id", "reason", "evidence_refs", "nodes"],
        },
    },
}

PLAN_REVISE_SCHEMA = {
    "type": "function",
    "function": {
        "name": "plan_revise",
        "description": (
            "Locally revise the executable plan using evidence. Supported changes are prune, retry, and set_priority; "
            "use plan_expand for new branches."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "reason": {"type": "string", "description": "Evidence-backed reason for the revision."},
                "evidence_refs": {"type": "array", "items": {"type": "string"}},
                "changes": {
                    "type": "array",
                    "items": {"type": "object"},
                    "description": "Changes with op, node_id, and optional reason or priority.",
                },
                "facts": {"type": "array", "items": {"type": "object"}},
                "hypotheses": {"type": "array", "items": {"type": "object"}},
            },
            "required": ["reason", "evidence_refs", "changes"],
        },
    },
}

PLAN_STATUS_SCHEMA = {
    "type": "function",
    "function": {
        "name": "plan_status",
        "description": (
            "Inspect runnable nodes, blocked nodes, missing facts, evidence ids, automatic replan decisions, "
            "and program-plan state."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "include_nodes": {"type": "boolean", "description": "Include complete node definitions."},
                "include_evidence": {"type": "boolean", "description": "Include the ten most recent evidence records."},
            },
        },
    },
}

MCP_REFRESH_SCHEMA = {
    "type": "function",
    "function": {
        "name": "mcp_refresh",
        "description": (
            f"Load configured MCP servers from {mcp_config_path_hint()}, "
            "connect over stdio, discover tools, and activate mcp__server__tool schemas."
        ),
        "parameters": {
            "type": "object",
            "properties": {},
        },
    },
}

MEMORY_SEARCH_SCHEMA = {
    "type": "function",
    "function": {
        "name": "memory_search",
        "description": "Search local memory files and the local CTF attack-pattern memory index for relevant SOPs, facts, prior notes, and crypto attack paths by query.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Memory query for SOPs, facts, prior notes, or CTF crypto attack patterns."},
                "limit": {"type": "integer", "description": "Maximum matches to return. Default 5."},
            },
            "required": ["query"],
        },
    },
}

ATTACK_MEMORY_SEARCH_SCHEMA = {
    "type": "function",
    "function": {
        "name": "attack_memory_search",
        "description": (
            "Search local CTF Crypto, Pwn, Web, and Reverse attack-pattern knowledge bases. "
            "Use this to recall similar solutions, attack vectors, code snippets, and "
            "relevant primitives for RSA/lattice/ECC/PRNG, glibc heap, tcache, UAF, "
            "double-free, ROP, binary-exploitation, web vulnerabilities, and reverse tasks."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "CTF challenge description, attack-pattern keywords, or primitive name (e.g. 'RSA small e broadcast attack', 'tcache poisoning safe linking', 'ViewState deserialization', 'ELF triage').",
                },
                "top_k": {
                    "type": "integer",
                    "description": "Maximum matches to return. Default 5, max 20.",
                },
            },
            "required": ["query"],
        },
    },
}

LIST_FILES_SCHEMA = {
    "type": "function",
    "function": {
        "name": "list_files",
        "description": "List files matching a glob pattern. Skips .git and node_modules.",
        "parameters": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Glob pattern such as **/*.py or *.md."},
                "path": {"type": "string", "description": "Base directory. Defaults to current tool cwd."},
            },
            "required": ["pattern"],
        },
    },
}

GREP_SEARCH_SCHEMA = {
    "type": "function",
    "function": {
        "name": "grep_search",
        "description": "Search text with a regex pattern and return file:line:content matches.",
        "parameters": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Regex pattern to search for."},
                "path": {"type": "string", "description": "Directory or file to search. Defaults to current tool cwd."},
                "include": {"type": "string", "description": "Optional filename glob such as *.py."},
            },
            "required": ["pattern"],
        },
    },
}

WEB_FETCH_SCHEMA = {
    "type": "function",
    "function": {
        "name": "web_fetch",
        "description": "Fetch a URL and return readable text. HTML script/style/tags are stripped.",
        "parameters": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "URL to fetch."},
                "max_length": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 200000,
                    "description": "Maximum returned characters. Default 50000.",
                },
            },
            "required": ["url"],
        },
    },
}

VIRTUAL_TOOL_SCHEMAS = {
    "attack_memory_search": ATTACK_MEMORY_SEARCH_SCHEMA,
    "grep_search": GREP_SEARCH_SCHEMA,
    "list_files": LIST_FILES_SCHEMA,
    "memory_search": MEMORY_SEARCH_SCHEMA,
    "mcp_refresh": MCP_REFRESH_SCHEMA,
    "skill": SKILL_SCHEMA,
    "sub_agent": SUB_AGENT_SCHEMA,
    "web_fetch": WEB_FETCH_SCHEMA,
    "plan_expand": PLAN_EXPAND_SCHEMA,
    "plan_revise": PLAN_REVISE_SCHEMA,
    "plan_status": PLAN_STATUS_SCHEMA,
}

_ALIASES = {
    "attack": {"attack_memory_search"},
    "attack memory": {"attack_memory_search"},
    "attack pattern": {"attack_memory_search"},
    "browser": {"web_scan", "web_execute_js"},
    "crypto": {"attack_memory_search"},
    "crypto attack": {"attack_memory_search"},
    "ctf": {"attack_memory_search"},
    "pwn": {"attack_memory_search"},
    "heap": {"attack_memory_search"},
    "glibc": {"attack_memory_search"},
    "tcache": {"attack_memory_search"},
    "uaf": {"attack_memory_search"},
    "double free": {"attack_memory_search"},
    "rop": {"attack_memory_search"},
    "ctf writeup": {"attack_memory_search"},
    "fetch": {"web_fetch"},
    "fetch url": {"web_fetch"},
    "grep": {"grep_search"},
    "javascript": {"web_execute_js"},
    "js": {"web_execute_js"},
    "list files": {"list_files"},
    "list": {"list_files"},
    "memory": {"start_long_term_update"},
    "memory search": {"memory_search"},
    "recall": {"memory_search"},
    "recall memory": {"memory_search"},
    "remembered": {"memory_search"},
    "sop": {"memory_search"},
    "long term": {"start_long_term_update"},
    "mcp": {"mcp_refresh"},
    "model context protocol": {"mcp_refresh"},
    "search": {"grep_search"},
    "agent": {"sub_agent"},
    "delegate": {"sub_agent"},
    "subagent": {"sub_agent"},
    "sub agent": {"sub_agent"},
    "plan": {"plan_expand", "plan_revise", "plan_status"},
    "plan tree": {"plan_expand", "plan_revise", "plan_status"},
    "web": {"web_scan", "web_execute_js", "web_fetch"},
    "writeup": {"attack_memory_search"},
    "writeup search": {"attack_memory_search"},
}


def _tool_name(tool):
    return ((tool or {}).get("function") or {}).get("name", "")


def _search_blob(tool):
    function = (tool or {}).get("function") or {}
    params = function.get("parameters") or {}
    return " ".join(
        [
            str(function.get("name", "")),
            str(function.get("description", "")),
            str(params),
        ]
    ).lower()


def _clone_tool(tool):
    return copy.deepcopy(tool)


def get_active_tool_schema(schema, activated=None, deferred=None, extra_tools=None, project_root=None, cache_first=False):
    activated = set(activated or ())
    deferred = set(deferred or DEFAULT_DEFERRED_TOOLS)
    disabled = disabled_names(project_root, "tools")
    out = []
    saw_tool_search = False
    for tool in schema:
        name = _tool_name(tool)
        if name in disabled:
            continue
        if cache_first and name == "tool_search":
            continue
        if name == "tool_search":
            saw_tool_search = True
            out.append(_clone_tool(tool))
            continue
        if not cache_first and name in deferred and name not in activated:
            continue
        out.append(_clone_tool(tool))
    if not cache_first and not saw_tool_search and "tool_search" not in disabled:
        out.append(_clone_tool(TOOL_SEARCH_SCHEMA))
    existing = {_tool_name(tool) for tool in out}
    for name, tool in VIRTUAL_TOOL_SCHEMAS.items():
        if name in disabled:
            continue
        if (cache_first or name in activated or name in ALWAYS_ACTIVE_VIRTUAL_TOOLS) and name not in existing:
            out.append(_clone_tool(tool))
            existing.add(name)
    for tool in sorted(extra_tools or [], key=_tool_name):
        name = _tool_name(tool)
        if name in disabled:
            continue
        if name and name not in existing:
            out.append(_clone_tool(tool))
            existing.add(name)
    return out


def search_deferred_tools(schema, query, deferred=None, project_root=None):
    deferred = set(deferred or DEFAULT_DEFERRED_TOOLS)
    disabled = disabled_names(project_root, "tools")
    q = (query or "").strip().lower()
    if not q:
        return []
    alias_names = set()
    for key, names in _ALIASES.items():
        if q in key or key in q:
            alias_names.update(names)
    if "recall" in q:
        alias_names.discard("start_long_term_update")
    matches = []
    all_tools = list(schema) + [tool for name, tool in VIRTUAL_TOOL_SCHEMAS.items() if name not in {_tool_name(t) for t in schema}]
    for tool in all_tools:
        name = _tool_name(tool)
        if name in disabled:
            continue
        if name not in deferred:
            continue
        if name in alias_names or q in _search_blob(tool):
            matches.append(_clone_tool(tool))
    return matches


def activate_tools(activated, tools):
    next_activated = set(activated or ())
    for tool in tools:
        name = _tool_name(tool)
        if name:
            next_activated.add(name)
    return next_activated
