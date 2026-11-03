from __future__ import annotations

from typing import Any, Dict, List

from .evidence import EvidenceStore
from .models import utc_now
from task_descriptor import TaskDescriptor, parse_task_descriptor

TASK_DESCRIPTOR_PLAN_VERSION = 1


def detect_category(prompt: Any) -> str:
    """Compatibility wrapper backed by the shared task descriptor parser."""
    return parse_task_descriptor(prompt).classification.category


def _node(node_id: str, parent_id: str, kind: str, title: str, **extra: Any) -> Dict[str, Any]:
    now = utc_now()
    return {
        "id": node_id,
        "parent_id": parent_id,
        "kind": kind,
        "title": title,
        "status": "pending",
        "created_at": now,
        "updated_at": now,
        **extra,
    }


def _action(node_id: str, parent_id: str, title: str, tool: str, args: Dict[str, Any], priority: int = 0) -> Dict[str, Any]:
    return _node(
        node_id,
        parent_id,
        "probe",
        title,
        action={"tool": tool, "args": args},
        failure_policy={"type": "backtrack"},
        priority=priority,
    )


def _web_nodes(url: str) -> List[Dict[str, Any]]:
    return [
        _node(
            "web_initial_triage",
            "collect_evidence",
            "parallel",
            "Run grounded Web reconnaissance",
            children=["web_fetch_root", "web_inspect_headers", "web_check_common_files", "web_extract_forms"],
        ),
        _action("web_fetch_root", "web_initial_triage", "Fetch the root page", "web_fetch", {"url": url}, 4),
        _action(
            "web_inspect_headers",
            "web_initial_triage",
            "Inspect response headers",
            "web_verb_call",
            {"verb": "web.inspect_headers", "args": {"url": url}},
            3,
        ),
        _action(
            "web_check_common_files",
            "web_initial_triage",
            "Check common discovery files",
            "web_verb_call",
            {"verb": "web.check_common_files", "args": {"url": url}},
            2,
        ),
        _action(
            "web_extract_forms",
            "web_initial_triage",
            "Extract visible forms",
            "web_verb_call",
            {"verb": "web.extract_forms", "args": {"url": url}},
            1,
        ),
    ]


def _file_nodes(category: str, asset_path: str = ".") -> List[Dict[str, Any]]:
    group_id = f"{category}_initial_triage"
    expand_id = f"{category}_expand_after_inventory"
    domain_template = category in {"pwn", "reverse", "forensics"}
    children = [f"{category}_inventory_assets"]
    if domain_template:
        children.append(f"{category}_discover_domain_tools")
    children.append(expand_id)
    return [
        _node(
            group_id,
            "collect_evidence",
            "sequence",
            f"Inventory assets before {category} analysis",
            children=children,
        ),
        _action(
            f"{category}_inventory_assets",
            group_id,
            "Inventory challenge files",
            "list_files",
            {"pattern": "**/*", "path": asset_path or "."},
            3,
        ),
        *(
            [
                _action(
                    f"{category}_discover_domain_tools",
                    group_id,
                    "Discover configured CTF analysis tools",
                    "mcp_refresh",
                    {},
                    2,
                )
            ]
            if domain_template
            else []
        ),
        _node(
            expand_id,
            group_id,
            "sequence",
            "Expand triage after file inventory",
            children=[],
            expandable=True,
        ),
    ]


def _tcp_nodes(category: str, host: str, port: int) -> List[Dict[str, Any]]:
    group_id = f"{category}_tcp_initial_triage"
    capture_id = f"{category}_tcp_capture_banner"
    expand_id = f"{category}_tcp_expand_after_banner"
    script = "\n".join(
        [
            "import socket",
            f"host = {host!r}",
            f"port = {int(port)}",
            "chunks = []",
            "with socket.create_connection((host, port), timeout=8) as sock:",
            "    sock.settimeout(2)",
            "    while sum(map(len, chunks)) < 65536:",
            "        try:",
            "            chunk = sock.recv(4096)",
            "        except socket.timeout:",
            "            break",
            "        if not chunk:",
            "            break",
            "        chunks.append(chunk)",
            "print(b''.join(chunks).decode('utf-8', errors='replace'))",
        ]
    )
    return [
        _node(
            group_id,
            "collect_evidence",
            "sequence",
            f"Inspect declared TCP service {host}:{port}",
            children=[capture_id, expand_id],
        ),
        _action(
            capture_id,
            group_id,
            "Connect once and capture the initial TCP banner",
            "code_run",
            {"type": "python", "script": script, "timeout": 15},
            5,
        ),
        _node(
            expand_id,
            group_id,
            "sequence",
            "Expand protocol triage from observed TCP evidence",
            children=[],
            expandable=True,
        ),
    ]


def apply_initial_template(state: Dict[str, Any], descriptor: TaskDescriptor) -> Dict[str, Any]:
    category = descriptor.classification.category
    if category in {"", "unknown"}:
        category = "generic"
    http_endpoint = descriptor.first_endpoint("http", "https")
    tcp_endpoint = descriptor.first_endpoint("tcp")
    asset_path = descriptor.primary_asset_path
    node_groups: List[List[Dict[str, Any]]] = []
    if http_endpoint and http_endpoint.url:
        node_groups.append(_web_nodes(http_endpoint.url))
    if asset_path:
        node_groups.append(_file_nodes(category, asset_path))
    elif category in {"pwn", "reverse", "forensics"} and not descriptor.endpoints:
        # Preserve direct-library usage where only a category is supplied.
        node_groups.append(_file_nodes(category, "."))
    if tcp_endpoint and tcp_endpoint.host and tcp_endpoint.port:
        node_groups.append(_tcp_nodes(category, tcp_endpoint.host, tcp_endpoint.port))
    if not node_groups:
        node_groups.append(_file_nodes(category, "."))
    nodes = [node for group in node_groups for node in group]
    node_map = state.setdefault("nodes", {})
    for node in nodes:
        node_map[node["id"]] = node
    collect = node_map["collect_evidence"]
    collect["children"] = [group[0]["id"] for group in node_groups]
    collect["kind"] = "parallel" if len(node_groups) > 1 else "sequence"
    collect["expandable"] = False
    primary_endpoint = descriptor.first_endpoint()
    store = EvidenceStore(state)
    store.commit_facts(
        [
            {
                "key": "task.category",
                "value": category,
                "confidence": descriptor.classification.confidence,
                "evidence_refs": ["ev_task_input"],
            },
            {"key": "task.mode", "value": descriptor.mode, "confidence": 1.0, "evidence_refs": ["ev_task_input"]},
            {"key": "task.capabilities", "value": descriptor.capabilities.__dict__, "confidence": 1.0, "evidence_refs": ["ev_task_input"]},
            *(
                [{"key": "task.target_id", "value": descriptor.identity.target_id, "confidence": 1.0, "evidence_refs": ["ev_task_input"]}]
                if descriptor.identity.target_id
                else []
            ),
            *(
                [{"key": "task.target_url", "value": http_endpoint.url, "confidence": 1.0, "evidence_refs": ["ev_task_input"]}]
                if http_endpoint and http_endpoint.url
                else []
            ),
            *(
                [{"key": "task.asset_path", "value": asset_path, "confidence": 1.0, "evidence_refs": ["ev_task_input"]}]
                if asset_path
                else []
            ),
            *(
                [
                    {"key": "task.endpoint.protocol", "value": primary_endpoint.protocol, "confidence": primary_endpoint.confidence, "evidence_refs": ["ev_task_input"]},
                    {"key": "task.endpoint.host", "value": primary_endpoint.host, "confidence": primary_endpoint.confidence, "evidence_refs": ["ev_task_input"]},
                    {"key": "task.endpoint.port", "value": primary_endpoint.port, "confidence": primary_endpoint.confidence, "evidence_refs": ["ev_task_input"]},
                ]
                if primary_endpoint
                else []
            ),
        ]
    )
    required_tools = sorted(
        {
            str((node.get("action") or {}).get("tool"))
            for node in nodes
            if (node.get("action") or {}).get("tool")
        }
    )
    runtime = state.setdefault("runtime", {})
    runtime["template"] = category
    runtime["template_tools"] = required_tools
    runtime["task_descriptor_digest"] = descriptor.prompt_digest
    runtime["task_descriptor_plan_version"] = TASK_DESCRIPTOR_PLAN_VERSION
    return {"category": category, "node_ids": [node["id"] for node in nodes], "required_tools": required_tools}
