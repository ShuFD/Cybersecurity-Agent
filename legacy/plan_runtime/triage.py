from __future__ import annotations

import hashlib
import re
from pathlib import PurePosixPath
from typing import Any, Dict, Iterable, List, Optional

from .models import utc_now


DOMAIN_CATEGORIES = {"pwn", "reverse", "forensics"}
MAX_PRIMARY_ASSETS = 8
MAX_SOURCE_ASSETS = 3


def _fact_value(state: Dict[str, Any], key: str, default: Any = None) -> Any:
    record = (state.get("facts") or {}).get(key)
    if isinstance(record, dict):
        return record.get("value", default)
    return default if record is None else record


def _tool_names(schemas: Iterable[Dict[str, Any]]) -> List[str]:
    names = []
    for schema in schemas or []:
        name = str(((schema or {}).get("function") or {}).get("name") or "")
        if name:
            names.append(name)
    return names


def _logical_tool_name(name: str) -> str:
    parts = str(name or "").split("__", 2)
    return parts[2] if len(parts) == 3 and parts[0] == "mcp" else str(name or "")


def sync_tool_catalog(
    state: Dict[str, Any], *, schemas: Iterable[Dict[str, Any]] = (), discovered_names: Iterable[str] = ()
) -> Dict[str, str]:
    runtime = state.setdefault("runtime", {})
    catalog = dict(runtime.get("tool_catalog") or {})
    for name in [*_tool_names(schemas), *[str(item) for item in discovered_names or []]]:
        logical = _logical_tool_name(name)
        if logical:
            catalog[logical] = name
        catalog[name] = name
    runtime["tool_catalog"] = catalog
    runtime["tool_catalog_ready"] = any(str(name).startswith("mcp__") for name in catalog.values())
    return catalog


def _resolve_tool(state: Dict[str, Any], logical_name: str) -> Optional[str]:
    catalog = (state.get("runtime") or {}).get("tool_catalog") or {}
    value = catalog.get(logical_name)
    return str(value) if value else None


def _normalized_path(value: Any) -> str:
    path = str(value or "").strip().replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    return path


def _asset_score(category: str, path: str) -> int:
    lowered = path.lower()
    name = PurePosixPath(lowered).name
    suffix = PurePosixPath(lowered).suffix
    score = 0
    extensions = {
        "pwn": {".elf", ".bin", ".out", ".so", ".exe"},
        "reverse": {".elf", ".bin", ".out", ".so", ".exe", ".dll", ".apk", ".dex", ".jar", ".class", ".wasm", ".pyc", ".pyd", ".ko", ".img"},
        "forensics": {".pcap", ".pcapng", ".img", ".raw", ".dd", ".mem", ".dmp", ".vmem", ".e01", ".zip", ".7z", ".rar", ".tar", ".gz", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".wav", ".mp3", ".pdf", ".docx", ".xlsx", ".evtx"},
    }
    if suffix in extensions.get(category, set()):
        score += 8
    if not suffix and name not in {"makefile", "dockerfile", "readme", "license"}:
        score += 4
    if re.search(r"chal|challenge|vuln|pwn|crack|flag|firmware|capture|dump|memory|disk|image", name):
        score += 5
    if re.search(r"(^|/)libc(?:[-_.]|$)|ld-linux", lowered):
        score += 4 if category == "pwn" else 0
    if any(part in lowered for part in ("/.git/", "/node_modules/", "/.venv/", "/__pycache__/")):
        return -100
    return score


def _select_assets(category: str, files: Iterable[Any]) -> List[str]:
    unique = []
    for item in files or []:
        path = _normalized_path(item)
        if path and path not in unique:
            unique.append(path)
    ranked = sorted(
        ((path, _asset_score(category, path)) for path in unique),
        key=lambda item: (-item[1], len(item[0]), item[0]),
    )
    selected = [path for path, score in ranked if score > 0]
    if not selected:
        selected = [path for path, score in ranked if score >= 0]
    return selected[:MAX_PRIMARY_ASSETS]


def _select_sources(files: Iterable[Any]) -> List[str]:
    source_names = {"dockerfile", "makefile", "readme", "readme.md"}
    source_exts = {".c", ".cc", ".cpp", ".h", ".hpp", ".py", ".js", ".java", ".rs", ".go", ".toml", ".json", ".yml", ".yaml"}
    out = []
    for item in files or []:
        path = _normalized_path(item)
        pure = PurePosixPath(path.lower())
        if path and (pure.name in source_names or pure.suffix in source_exts):
            out.append(path)
    return out[:MAX_SOURCE_ASSETS]


def _node_id(category: str, operation: str, path: str) -> str:
    stem = re.sub(r"[^a-z0-9]+", "_", PurePosixPath(path.lower()).name).strip("_")[:24] or "asset"
    digest = hashlib.sha1(path.encode("utf-8", errors="replace")).hexdigest()[:8]
    return f"{category}_{operation}_{stem}_{digest}"


def _probe(category: str, parent_id: str, operation: str, path: str, title: str, tool: str, args: Dict[str, Any], priority: int) -> Dict[str, Any]:
    now = utc_now()
    return {
        "id": _node_id(category, operation, path),
        "parent_id": parent_id,
        "kind": "probe",
        "title": title,
        "status": "pending",
        "action": {"tool": tool, "args": args},
        "failure_policy": {"type": "backtrack"},
        "priority": priority,
        "generated_by": "domain_secondary_triage",
        "created_at": now,
        "updated_at": now,
    }


def _append_nodes(state: Dict[str, Any], parent_id: str, proposed: Iterable[Dict[str, Any]]) -> List[str]:
    nodes = state.setdefault("nodes", {})
    parent = nodes.get(parent_id)
    if not parent:
        return []
    added = []
    children = parent.setdefault("children", [])
    for node in proposed or []:
        node_id = str(node.get("id") or "")
        if not node_id or node_id in nodes:
            continue
        nodes[node_id] = node
        if node_id not in children:
            children.append(node_id)
        added.append(node_id)
    if added:
        parent["kind"] = "parallel"
        parent["expandable"] = False
        if parent.get("status") in {"done", "pruned"}:
            parent["status"] = "pending"
    return added


def _register_required_tools(state: Dict[str, Any], nodes: Iterable[Dict[str, Any]]) -> List[str]:
    runtime = state.setdefault("runtime", {})
    required = set(runtime.get("template_tools") or [])
    for node in nodes or []:
        tool = str((node.get("action") or {}).get("tool") or "")
        if tool:
            required.add(tool)
    runtime["template_tools"] = sorted(required)
    return sorted(required)


def _initial_identification_nodes(state: Dict[str, Any], category: str, parent_id: str, files: List[str]) -> List[Dict[str, Any]]:
    identify = _resolve_tool(state, "identify_file")
    nodes = []
    if identify:
        for index, path in enumerate(_select_assets(category, files)):
            nodes.append(
                _probe(
                    category,
                    parent_id,
                    "identify",
                    path,
                    f"Identify challenge asset {path}",
                    identify,
                    {"path": path},
                    20 - index,
                )
            )
    for index, path in enumerate(_select_sources(files)):
        nodes.append(
            _probe(
                category,
                parent_id,
                "read_source",
                path,
                f"Read supplied source or configuration {path}",
                "file_read",
                {"path": path},
                8 - index,
            )
        )
    return nodes


def _run_tool_node(category: str, parent_id: str, operation: str, path: str, title: str, tool: Optional[str], args: Dict[str, Any], priority: int) -> Optional[Dict[str, Any]]:
    if not tool:
        return None
    return _probe(category, parent_id, operation, path, title, tool, args, priority)


def _pwn_type_nodes(state: Dict[str, Any], parent_id: str, path: str, file_info: str) -> List[Dict[str, Any]]:
    lowered = file_info.lower()
    if "elf" not in lowered and "pe32" not in lowered and "executable" not in lowered:
        return []
    nodes = [
        _run_tool_node("pwn", parent_id, "strings", path, f"Extract strings from {path}", _resolve_tool(state, "strings_extract"), {"path": path, "min_len": 4, "limit": 500}, 14),
    ]
    if "elf" in lowered:
        nodes.extend(
            [
                _run_tool_node("pwn", parent_id, "checksec", path, f"Inspect ELF protections for {path}", _resolve_tool(state, "checksec_file"), {"path": path}, 18),
                _run_tool_node("pwn", parent_id, "readelf", path, f"Inspect ELF headers and symbols for {path}", _resolve_tool(state, "run_ctf_tool"), {"argv": ["readelf", "-h", "-l", "-s", path], "timeout": 30}, 12),
            ]
        )
    return [node for node in nodes if node]


def _reverse_type_nodes(state: Dict[str, Any], parent_id: str, path: str, file_info: str) -> List[Dict[str, Any]]:
    lowered = file_info.lower()
    suffix = PurePosixPath(path.lower()).suffix
    recognized = any(marker in lowered for marker in ("elf", "pe32", "mach-o", "android", "java", "webassembly", "executable", "shared object")) or suffix in {".apk", ".dex", ".jar", ".wasm", ".pyc", ".bin", ".img"}
    if not recognized:
        return []
    nodes = [
        _run_tool_node("reverse", parent_id, "strings", path, f"Extract strings from {path}", _resolve_tool(state, "strings_extract"), {"path": path, "min_len": 4, "limit": 700}, 16),
    ]
    runner = _resolve_tool(state, "run_ctf_tool")
    if "elf" in lowered:
        nodes.append(_run_tool_node("reverse", parent_id, "readelf", path, f"Inspect ELF sections and symbols for {path}", runner, {"argv": ["readelf", "-h", "-S", "-s", path], "timeout": 30}, 14))
    elif "pe32" in lowered:
        nodes.append(_run_tool_node("reverse", parent_id, "objdump", path, f"Inspect PE headers for {path}", runner, {"argv": ["objdump", "-x", path], "timeout": 30}, 14))
    elif suffix in {".apk", ".jar"}:
        nodes.append(_run_tool_node("reverse", parent_id, "archive_list", path, f"List package contents for {path}", runner, {"argv": ["unzip", "-l", path], "timeout": 30}, 14))
    if suffix in {".bin", ".img", ".apk"}:
        nodes.append(_run_tool_node("reverse", parent_id, "binwalk", path, f"Scan embedded content in {path}", _resolve_tool(state, "binwalk_scan"), {"path": path, "extract": False}, 11))
    return [node for node in nodes if node]


def _forensics_type_nodes(state: Dict[str, Any], parent_id: str, path: str, file_info: str) -> List[Dict[str, Any]]:
    lowered = file_info.lower()
    suffix = PurePosixPath(path.lower()).suffix
    runner = _resolve_tool(state, "run_ctf_tool")
    nodes: List[Optional[Dict[str, Any]]] = []
    if suffix in {".pcap", ".pcapng"} or "capture file" in lowered:
        nodes.extend(
            [
                _run_tool_node("forensics", parent_id, "capinfos", path, f"Summarize packet capture {path}", runner, {"argv": ["capinfos", path], "timeout": 60}, 18),
                _run_tool_node("forensics", parent_id, "protocols", path, f"Enumerate protocols in {path}", runner, {"argv": ["tshark", "-r", path, "-q", "-z", "io,phs"], "timeout": 120}, 16),
            ]
        )
    elif suffix in {".zip", ".7z", ".rar", ".tar", ".gz"} or "archive" in lowered:
        nodes.append(_run_tool_node("forensics", parent_id, "archive_list", path, f"List archive members in {path}", runner, {"argv": ["7z", "l", path], "timeout": 60}, 16))
        nodes.append(_run_tool_node("forensics", parent_id, "binwalk", path, f"Scan embedded content in {path}", _resolve_tool(state, "binwalk_scan"), {"path": path, "extract": False}, 12))
    elif suffix in {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".wav", ".mp3", ".pdf", ".docx", ".xlsx"} or any(marker in lowered for marker in ("image", "audio", "pdf", "document")):
        nodes.extend(
            [
                _run_tool_node("forensics", parent_id, "metadata", path, f"Extract metadata from {path}", runner, {"argv": ["exiftool", path], "timeout": 60}, 16),
                _run_tool_node("forensics", parent_id, "binwalk", path, f"Scan embedded content in {path}", _resolve_tool(state, "binwalk_scan"), {"path": path, "extract": False}, 13),
                _run_tool_node("forensics", parent_id, "strings", path, f"Extract strings from {path}", _resolve_tool(state, "strings_extract"), {"path": path, "min_len": 8, "limit": 500}, 10),
            ]
        )
    elif suffix in {".img", ".raw", ".dd", ".e01"} or "filesystem" in lowered or "disk image" in lowered:
        nodes.append(_run_tool_node("forensics", parent_id, "binwalk", path, f"Scan disk or blob signatures in {path}", _resolve_tool(state, "binwalk_scan"), {"path": path, "extract": False}, 13))
    return [node for node in nodes if node]


def apply_secondary_triage(state: Dict[str, Any], *, evidence_id: str) -> Dict[str, Any]:
    category = str(_fact_value(state, "task.category", ""))
    if category not in DOMAIN_CATEGORIES:
        return {"status": "unchanged", "added_node_ids": []}
    runtime = state.setdefault("runtime", {})
    parent_id = f"{category}_expand_after_inventory"
    files = list(_fact_value(state, "artifact.files", []) or [])
    all_added: List[str] = []
    stages = []

    if files and not runtime.get("secondary_triage_initialized"):
        identify_ready = bool(_resolve_tool(state, "identify_file"))
        proposed = _initial_identification_nodes(state, category, parent_id, files)
        added = _append_nodes(state, parent_id, proposed)
        if added and identify_ready:
            runtime["secondary_triage_initialized"] = True
            runtime["secondary_triage_status"] = "identifying_assets"
            all_added.extend(added)
            stages.append("asset_identification")
            _register_required_tools(state, proposed)
        elif added:
            runtime["secondary_triage_status"] = "waiting_for_domain_tools"
            all_added.extend(added)
            stages.append("source_inspection")
            _register_required_tools(state, proposed)
        elif not runtime.get("tool_catalog_ready"):
            runtime["secondary_triage_status"] = "waiting_for_domain_tools"
        else:
            runtime["secondary_triage_status"] = "no_candidate_assets"

    file_types = _fact_value(state, "artifact.file_types", {}) or {}
    processed = set(runtime.get("secondary_triage_processed_types") or [])
    for raw_path, raw_info in file_types.items() if isinstance(file_types, dict) else []:
        path = _normalized_path(raw_path)
        if not path or path in processed:
            continue
        info = str(raw_info or "")
        if category == "pwn":
            proposed = _pwn_type_nodes(state, parent_id, path, info)
        elif category == "reverse":
            proposed = _reverse_type_nodes(state, parent_id, path, info)
        else:
            proposed = _forensics_type_nodes(state, parent_id, path, info)
        added = _append_nodes(state, parent_id, proposed)
        processed.add(path)
        if added:
            all_added.extend(added)
            stages.append("type_specific_probes")
            _register_required_tools(state, proposed)
    runtime["secondary_triage_processed_types"] = sorted(processed)
    if all_added:
        runtime["secondary_triage_status"] = "expanded"
        runtime.setdefault("secondary_triage_evidence_refs", []).append(evidence_id)
        runtime["secondary_triage_evidence_refs"] = runtime["secondary_triage_evidence_refs"][-20:]
        return {
            "status": "expanded",
            "stage": "+".join(dict.fromkeys(stages)),
            "parent_id": parent_id,
            "added_node_ids": all_added,
            "required_tools": list(runtime.get("template_tools") or []),
            "reason": "domain_secondary_triage_expanded_from_observed_artifacts",
            "evidence_refs": [evidence_id],
        }
    return {
        "status": runtime.get("secondary_triage_status") or "unchanged",
        "stage": None,
        "parent_id": parent_id,
        "added_node_ids": [],
        "required_tools": list(runtime.get("template_tools") or []),
    }


__all__ = ["DOMAIN_CATEGORIES", "apply_secondary_triage", "sync_tool_catalog"]
