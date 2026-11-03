from __future__ import annotations

import hashlib
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


MODULE_ROOT = Path(__file__).resolve().parent
MEMORY_DIR_ENV = "SECHEUR_TOOL_EXPERIENCE_MEMORY_DIR"
ENABLE_ENV = "SECHEUR_TOOL_EXPERIENCE"
DISABLE_ENV = "SECHEUR_DISABLE_TOOL_EXPERIENCE"
FINGERPRINT_VERSION = 1

MAX_FILES = 120
MAX_DEPTH = 5
MAX_FILE_BYTES = 131072
MAX_ARTIFACTS_IN_PROMPT = 12
MAX_MATCHES_IN_PROMPT = 4

HEURISTIC_MARKERS = (
    "heuristic-learning",
    "HEURISTIC_LEARNING_ENABLED",
    "启发式学习",
)

IGNORED_METADATA_KEYS = {
    "benchmark",
    "bench",
    "category",
    "target_id",
    "targetid",
    "id",
}

TEXT_METADATA_KEYS = {
    "prompt",
    "query",
    "question",
    "description",
    "desc",
    "statement",
    "readme",
    "title",
    "name",
    "url",
    "target_url",
    "service",
    "host",
    "port",
    "ports",
    "files",
    "attachments",
    "assets",
}

SKIP_DIRS = {
    ".git",
    ".pytest_cache",
    "__pycache__",
    "node_modules",
    ".venv",
    "venv",
    "memory",
    "temp",
    "outputs",
    "server-pull-20260713-103756",
}

TEXT_EXTS = {
    "c",
    "cc",
    "cpp",
    "cs",
    "go",
    "h",
    "hpp",
    "html",
    "java",
    "js",
    "json",
    "md",
    "php",
    "pl",
    "py",
    "rb",
    "rs",
    "sh",
    "sol",
    "sql",
    "toml",
    "ts",
    "txt",
    "wasm.txt",
    "xml",
    "yaml",
    "yml",
}

ARCHIVE_EXTS = {"zip", "gz", "tgz", "tar", "xz", "bz2", "7z", "rar"}
IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "bmp", "webp"}
BINARY_EXTS = {"elf", "exe", "bin", "so", "dll", "o"}

DEFAULT_CTF_MCP_TOOLS = [
    "run_ctf_tool",
    "identify_file",
    "strings_extract",
    "checksec_file",
    "binwalk_scan",
    "run_linux_elf",
    "gdb_batch",
    "radare2_cmd",
    "tshark_summary",
]

HARDCODED_VIRTUAL_TOOLS = {
    "grep_search",
    "list_files",
    "memory_search",
    "mcp_refresh",
    "skill",
    "sub_agent",
    "web_fetch",
    "web_search",
    "web_scan",
    "web_execute_js",
}

SIGNAL_PATTERNS = {
    "pickle": r"\bpickle\b|pickle\.loads|pickle\.load|__reduce__|find_class|\.pkl\b",
    "python-jail": r"pyjail|sandbox|restrictedpython|__builtins__|eval\(|exec\(",
    "jwt": r"\bjwt\b|jsonwebtoken|HS256|RS256|secret_key|session_cookie",
    "sql": r"\bsqlite\b|\bselect\b[\s\S]{0,80}\bfrom\b|union\s+select|sqlalchemy",
    "ssti": r"render_template_string|jinja2|\{\{[^{}]{0,80}\}\}",
    "xss": r"document\.cookie|innerHTML|<script|onerror=",
    "ssrf": r"ssrf|requests\.get|urllib\.request|fetch\([^)]*url|curl\s+",
    "flask": r"\bflask\b|@app\.route|render_template",
    "express": r"\bexpress\b|app\.(get|post|use)\(",
    "php": r"<\?php|\$_(GET|POST|REQUEST|COOKIE)|include\s*\(",
    "graphql": r"graphql|apollo|__schema|resolver",
    "rsa": r"\brsa\b|BEGIN RSA|public exponent|e\s*=\s*65537|modulus",
    "aes": r"\baes\b|Crypto\.Cipher|openssl_encrypt|cbc|ctr|gcm",
    "lattice": r"lattice|coppersmith|LLL|small root|sage",
    "xor": r"\bxor\b|repeating.key|single.byte",
    "overflow": r"\bgets\s*\(|strcpy\s*\(|strcat\s*\(|scanf\s*\(",
    "format-string": r"printf\s*\(\s*[^,\)]*\)|%n|format string",
    "rop": r"\brop\b|ret2libc|system\(|/bin/sh|one_gadget",
    "heap": r"\bheap\b|malloc|free\(|tcache|fastbin|unsorted bin",
    "pcap": r"\bpcap\b|pcapng|wireshark|tshark|tcpdump|tcp stream",
    "stego": r"stego|steganography|lsb|exif|zsteg|steghide",
    "binwalk": r"binwalk|firmware|squashfs|ubifs|cpio",
    "wasm": r"\bwasm\b|WebAssembly",
    "dotnet": r"\.NET|dnSpy|ILSpy|System\.Reflection",
    "android": r"\bapk\b|AndroidManifest|classes\.dex|smali",
    "z3": r"\bz3\b|solver|constraints?|sat solver",
}


def heuristic_tool_reuse_enabled(prompt: Any) -> bool:
    if str(os.environ.get(DISABLE_ENV, "")).lower() in {"1", "true", "yes"}:
        return False
    if str(os.environ.get(ENABLE_ENV, "")).lower() in {"1", "true", "yes"}:
        return True
    text = str(prompt or "")
    return any(marker in text for marker in HEURISTIC_MARKERS)


def build_tool_experience_context(
    prompt: Any,
    *,
    project_root: Optional[str] = None,
    task_dir: Optional[str] = None,
) -> Dict[str, Any]:
    root = _first_existing_dir(task_dir, project_root, os.getcwd()) or Path(os.getcwd())
    fingerprint = extract_challenge_fingerprint(prompt, root=root)
    inventory = discover_tool_inventory(project_root=project_root, task_dir=task_dir)
    rules = load_index_rules()
    matches = match_rules(fingerprint, rules)
    recommendations = build_recommendations(matches, inventory)
    return {
        "enabled": heuristic_tool_reuse_enabled(prompt),
        "root": str(root),
        "fingerprint": fingerprint,
        "inventory": inventory,
        "matches": matches,
        "recommendations": recommendations,
    }


def format_tool_experience_prompt(context: Dict[str, Any]) -> str:
    if not context or not context.get("enabled"):
        return ""
    fingerprint = context.get("fingerprint") or {}
    recommendations = context.get("recommendations") or {}
    matches = context.get("matches") or []

    traits = _format_list(fingerprint.get("traits"), 16)
    exts = _format_list(fingerprint.get("file_exts"), 14)
    magics = _format_list(fingerprint.get("magic"), 12)
    terms = _format_list(fingerprint.get("prompt_terms"), 18)
    artifacts = []
    for artifact in (fingerprint.get("artifacts") or [])[:MAX_ARTIFACTS_IN_PROMPT]:
        parts = [artifact.get("path", "")]
        if artifact.get("magic"):
            parts.append(f"magic={artifact['magic']}")
        if artifact.get("ext"):
            parts.append(f"ext={artifact['ext']}")
        artifacts.append(" ".join(part for part in parts if part))

    skills = _format_list(recommendations.get("skills"), 12)
    tools = _format_list(recommendations.get("tools"), 18)
    mcp_tools = _format_list(recommendations.get("mcp_tools"), 18)
    commands = _format_list(recommendations.get("commands"), 16)

    lines = [
        "[Heuristic Tool Experience Reuse]",
        "The frontend heuristic-learning switch is ON, so challenge-derived tool routing is active for this run.",
        "Use only challenge-intrinsic signals below. Do not use benchmark name, category label, or target_id as matching evidence.",
        f"Fingerprint traits: {traits or 'none'}",
        f"File extensions: {exts or 'none'}",
        f"Magic/types: {magics or 'none'}",
        f"Signal terms: {terms or 'none'}",
    ]
    if artifacts:
        lines.append("Visible artifacts: " + "; ".join(artifacts))
    if matches:
        route_bits = []
        for item in matches[:MAX_MATCHES_IN_PROMPT]:
            rule = item.get("rule") or {}
            route_bits.append(f"{rule.get('id', 'unknown')} score={item.get('score')}")
        lines.append("Matched experience rules: " + "; ".join(route_bits))
    lines.extend(
        [
            f"Recommended skills: {skills or 'none'}",
            f"Recommended built-in tools: {tools or 'none'}",
            f"Recommended MCP tools after mcp_refresh: {mcp_tools or 'none'}",
            f"Useful container commands via run_ctf_tool when available: {commands or 'none'}",
            "Start by refreshing MCP tools when MCP recommendations are present. Prefer the matching skill and tool route before broad trial-and-error.",
            "When you believe you have the flag, call verify_flag/check_flag or provide a single final flag in <FINAL_ANSWER>...</FINAL_ANSWER>; a correct oracle result ends the run, an incorrect result means continue.",
        ]
    )
    return "\n".join(lines)


def extract_challenge_fingerprint(prompt: Any, *, root: Optional[Path] = None) -> Dict[str, Any]:
    root = Path(root or os.getcwd()).resolve()
    metadata_texts = _metadata_texts(root)
    prompt_text = _strip_heuristic_prefix(str(prompt or ""))
    combined_texts = [prompt_text] + metadata_texts

    artifacts: List[Dict[str, Any]] = []
    sampled_texts: List[str] = []
    for path in _iter_candidate_files(root):
        artifact, sample = _inspect_file(root, path)
        artifacts.append(artifact)
        if sample:
            sampled_texts.append(sample)

    file_exts = _unique_sorted(_normalize_ext(item.get("ext")) for item in artifacts if item.get("ext"))
    magics = _unique_sorted(item.get("magic") for item in artifacts if item.get("magic"))
    path_tokens = _tokens_from_paths(item.get("path", "") for item in artifacts)
    terms = _extract_signal_terms("\n".join(combined_texts + sampled_texts))
    languages, frameworks, traits = _derive_traits(file_exts, magics, terms, path_tokens, artifacts, combined_texts)

    digest_payload = {
        "version": FINGERPRINT_VERSION,
        "file_exts": file_exts,
        "magic": magics,
        "path_tokens": path_tokens[:80],
        "prompt_terms": terms,
        "languages": languages,
        "frameworks": frameworks,
        "traits": traits,
    }
    digest = hashlib.sha256(json.dumps(digest_payload, ensure_ascii=True, sort_keys=True).encode("utf-8")).hexdigest()[:16]
    return {
        "version": FINGERPRINT_VERSION,
        "digest": digest,
        "root": str(root),
        "file_exts": file_exts,
        "magic": magics,
        "path_tokens": path_tokens[:100],
        "prompt_terms": terms,
        "languages": languages,
        "frameworks": frameworks,
        "traits": traits,
        "artifacts": artifacts[:MAX_ARTIFACTS_IN_PROMPT * 3],
    }


def discover_tool_inventory(
    *,
    project_root: Optional[str] = None,
    task_dir: Optional[str] = None,
) -> Dict[str, Any]:
    tools = set(HARDCODED_VIRTUAL_TOOLS)
    tools.update(_tool_names_from_schema(MODULE_ROOT / "assets" / "tools_schema.json"))
    tools.update(_tool_names_from_schema(MODULE_ROOT / "assets" / "tools_schema_cn.json"))
    try:
        from tool_registry import VIRTUAL_TOOL_SCHEMAS

        for schema in VIRTUAL_TOOL_SCHEMAS.values():
            name = ((schema or {}).get("function") or {}).get("name")
            if name:
                tools.add(name)
    except Exception:
        pass

    roots = [MODULE_ROOT]
    for item in (project_root, task_dir):
        if item:
            try:
                path = Path(item).resolve()
            except Exception:
                continue
            if path not in roots:
                roots.append(path)

    skills = set()
    for base in roots:
        for rel in (".agents/skills", ".secheur-agent/skills", "skills"):
            skills.update(_skill_names_from_dir(base / rel))

    mcp_servers = _mcp_servers_from_roots(roots)
    return {
        "tools": sorted(tools),
        "skills": sorted(skills),
        "mcp_servers": mcp_servers,
        "known_mcp_tools": list(DEFAULT_CTF_MCP_TOOLS),
    }


def load_index_rules() -> List[Dict[str, Any]]:
    rules = [dict(rule) for rule in DEFAULT_RULES]
    for rule in _read_learned_rules():
        if isinstance(rule, dict) and rule.get("id"):
            rules.append(rule)
    return rules


def match_rules(fingerprint: Dict[str, Any], rules: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    scored: List[Dict[str, Any]] = []
    for rule in rules:
        score, reasons = _score_rule(fingerprint, rule)
        if score >= 4:
            item = {
                "score": round(score, 2),
                "reasons": reasons[:8],
                "rule": _public_rule(rule),
            }
            scored.append(item)
    scored.sort(key=lambda item: (-item["score"], item["rule"].get("id", "")))
    return scored[:8]


def build_recommendations(matches: Sequence[Dict[str, Any]], inventory: Dict[str, Any]) -> Dict[str, Any]:
    available_tools = set(inventory.get("tools") or [])
    available_skills = set(inventory.get("skills") or [])
    known_mcp = set(inventory.get("known_mcp_tools") or [])

    skills: List[str] = []
    tools: List[str] = []
    mcp_tools: List[str] = []
    commands: List[str] = []
    notes: List[str] = []
    for item in matches:
        rule = item.get("rule") or {}
        rec = rule.get("recommend") or {}
        for skill in rec.get("skills") or []:
            if skill in available_skills:
                _append_unique(skills, skill)
        for tool in rec.get("tools") or []:
            if tool in available_tools:
                _append_unique(tools, tool)
        for tool in rec.get("mcp_tools") or []:
            if tool in known_mcp or tool.startswith("mcp__"):
                _append_unique(mcp_tools, tool)
        for command in rec.get("commands") or []:
            _append_unique(commands, command)
        for note in rec.get("notes") or []:
            _append_unique(notes, note)

    if mcp_tools and "mcp_refresh" in available_tools:
        tools.insert(0, "mcp_refresh") if "mcp_refresh" not in tools else None
    if "verify_flag" in available_tools:
        _append_unique(tools, "verify_flag")
    if "check_flag" in available_tools:
        _append_unique(tools, "check_flag")
    return {
        "skills": skills[:8],
        "tools": tools[:16],
        "mcp_tools": mcp_tools[:16],
        "commands": commands[:12],
        "notes": notes[:8],
    }


def record_success(
    *,
    parent: Any,
    handler: Any,
    response: Any = None,
    oracle_result: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    if not getattr(parent, "tool_experience_enabled", False):
        return {"status": "disabled"}
    if getattr(parent, "_tool_experience_success_recorded", False):
        return {"status": "already_recorded"}
    oracle_result = oracle_result or {}
    if oracle_result and oracle_result.get("status") != "correct" and not oracle_result.get("correct"):
        return {"status": "not_verified"}

    context = getattr(parent, "tool_experience_context", None)
    if not context:
        prompt = getattr(parent, "tool_experience_prompt", "")
        context = build_tool_experience_context(
            prompt,
            project_root=getattr(parent, "project_root", None),
            task_dir=getattr(parent, "task_dir", None),
        )
    fingerprint = context.get("fingerprint") or {}
    matches = context.get("matches") or match_rules(fingerprint, load_index_rules())
    used_tools = _extract_used_tools(getattr(handler, "history_info", []))
    final_preview = _preview(getattr(response, "content", "") if response is not None else "")

    memory_dir = _memory_dir()
    memory_dir.mkdir(parents=True, exist_ok=True)
    success_entry = {
        "ts": _utc_now(),
        "fingerprint_digest": fingerprint.get("digest"),
        "fingerprint": _compact_fingerprint(fingerprint),
        "matched_rule_ids": [((item.get("rule") or {}).get("id")) for item in matches[:4] if (item.get("rule") or {}).get("id")],
        "recommended": context.get("recommendations") or {},
        "used_tools": used_tools,
        "oracle_status": oracle_result.get("status", "correct"),
        "attempts_total": oracle_result.get("attempts_total"),
        "final_preview": final_preview,
    }
    _append_jsonl(memory_dir / "tool_success_cases.jsonl", success_entry)
    update_summary = _update_learned_rules(memory_dir / "tool_index_rules.jsonl", fingerprint, matches, used_tools)
    setattr(parent, "_tool_experience_success_recorded", True)
    return {
        "status": "recorded",
        "memory_dir": str(memory_dir),
        "fingerprint_digest": fingerprint.get("digest"),
        "used_tools": used_tools,
        "rule_update": update_summary,
    }


def _strip_heuristic_prefix(text: str) -> str:
    return re.sub(r"(?is)^.*?heuristic-learning.*?\n\n", "", text, count=1)


def _metadata_texts(root: Path) -> List[str]:
    texts: List[str] = []
    for name in ("metadata.json", "target.json", "challenge.json"):
        path = root / name
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        texts.extend(_extract_metadata_text(data))
    return texts


def _extract_metadata_text(value: Any, key: str = "") -> List[str]:
    key_l = str(key or "").lower()
    if key_l in IGNORED_METADATA_KEYS:
        return []
    if isinstance(value, dict):
        chunks: List[str] = []
        for child_key, child_value in value.items():
            child_key_l = str(child_key).lower()
            if child_key_l in IGNORED_METADATA_KEYS:
                continue
            if child_key_l in TEXT_METADATA_KEYS or isinstance(child_value, (dict, list)):
                chunks.extend(_extract_metadata_text(child_value, child_key_l))
        return chunks
    if isinstance(value, list):
        chunks: List[str] = []
        for item in value[:40]:
            chunks.extend(_extract_metadata_text(item, key_l))
        return chunks
    if key_l in TEXT_METADATA_KEYS and value not in (None, ""):
        return [str(value)]
    return []


def _iter_candidate_files(root: Path) -> Iterable[Path]:
    if not root.exists() or not root.is_dir():
        return []
    found: List[Path] = []
    for current, dirs, files in os.walk(root):
        current_path = Path(current)
        try:
            rel = current_path.relative_to(root)
        except ValueError:
            continue
        depth = 0 if str(rel) == "." else len(rel.parts)
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".cache")]
        if depth >= MAX_DEPTH:
            dirs[:] = []
        for name in sorted(files):
            if name.startswith(".") and name not in {".env"}:
                continue
            path = current_path / name
            found.append(path)
            if len(found) >= MAX_FILES:
                return found
    return found


def _inspect_file(root: Path, path: Path) -> Tuple[Dict[str, Any], str]:
    rel = _safe_rel(path, root)
    ext = _normalize_ext(path.suffix.lstrip(".").lower())
    try:
        size = path.stat().st_size
    except OSError:
        size = 0
    try:
        data = path.read_bytes()[:MAX_FILE_BYTES]
    except Exception:
        data = b""
    magic = _detect_magic(data, ext, path.name)
    sample = ""
    if _looks_textual(data, ext):
        sample = data.decode("utf-8", errors="ignore")
    artifact = {
        "path": rel,
        "name": path.name,
        "ext": ext,
        "size": size,
        "magic": magic,
    }
    return artifact, sample


def _detect_magic(data: bytes, ext: str, name: str) -> str:
    if data.startswith(b"\x7fELF"):
        return "elf"
    if data.startswith(b"MZ"):
        return "pe"
    if data.startswith(b"PK\x03\x04"):
        return "zip"
    if data.startswith(b"\x1f\x8b"):
        return "gzip"
    if data.startswith(b"\xfd7zXZ"):
        return "xz"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if data.startswith(b"%PDF"):
        return "pdf"
    if data.startswith(b"SQLite format 3"):
        return "sqlite"
    if data[:4] in {b"\xd4\xc3\xb2\xa1", b"\xa1\xb2\xc3\xd4", b"\x4d\x3c\xb2\xa1", b"\xa1\xb2\x3c\x4d"}:
        return "pcap"
    if data.startswith(b"\x0a\x0d\x0d\x0a"):
        return "pcapng"
    if ext in ARCHIVE_EXTS:
        return "archive"
    if ext in IMAGE_EXTS:
        return "image"
    if ext in BINARY_EXTS:
        return "binary"
    if ext in TEXT_EXTS or name in {"Dockerfile", "Makefile"}:
        return "text"
    return ""


def _looks_textual(data: bytes, ext: str) -> bool:
    if not data:
        return False
    if ext in TEXT_EXTS:
        return True
    if b"\x00" in data[:4096]:
        return False
    printable = sum(1 for byte in data[:4096] if byte in b"\n\r\t" or 32 <= byte < 127)
    return printable / max(1, min(len(data), 4096)) > 0.85


def _extract_signal_terms(text: str) -> List[str]:
    lowerable = str(text or "")
    terms: List[str] = []
    for name, pattern in SIGNAL_PATTERNS.items():
        try:
            if re.search(pattern, lowerable, flags=re.IGNORECASE):
                terms.append(name)
        except re.error:
            continue
    return sorted(terms)


def _derive_traits(
    file_exts: Sequence[str],
    magics: Sequence[str],
    terms: Sequence[str],
    path_tokens: Sequence[str],
    artifacts: Sequence[Dict[str, Any]],
    texts: Sequence[str],
) -> Tuple[List[str], List[str], List[str]]:
    ext_set = set(file_exts)
    magic_set = set(magics)
    term_set = set(terms)
    path_set = set(path_tokens)
    joined_text = "\n".join(texts).lower()

    languages = []
    frameworks = []
    traits = []

    if ext_set & {"py"} or "python" in path_set:
        languages.append("python")
        traits.append("python_source")
    if ext_set & {"js", "ts"}:
        languages.append("javascript")
        traits.append("javascript_source")
    if ext_set & {"php"} or "php" in term_set:
        languages.append("php")
        traits.append("php_source")
    if ext_set & {"c", "cc", "cpp", "h", "hpp"}:
        languages.append("c_cpp")
        traits.append("native_source")
    if ext_set & {"rs"}:
        languages.append("rust")
    if ext_set & {"go"}:
        languages.append("go")

    if "flask" in term_set:
        frameworks.append("flask")
    if "express" in term_set:
        frameworks.append("express")
    if "graphql" in term_set:
        frameworks.append("graphql")

    if "pickle" in term_set or ext_set & {"pkl", "pickle"}:
        traits.append("unsafe_deserialization")
    if "python-jail" in term_set:
        traits.append("python_jail")
    if term_set & {"flask", "express", "php", "graphql", "jwt", "sql", "ssti", "xss", "ssrf"}:
        traits.append("web_source")
    if re.search(r"https?://|localhost:\d+|127\.0\.0\.1:\d+|:\d{2,5}\b", joined_text):
        traits.append("http_service")
    if "elf" in magic_set:
        traits.append("elf_binary")
    if "pe" in magic_set:
        traits.append("pe_binary")
    if term_set & {"overflow", "format-string", "rop", "heap"}:
        traits.append("pwn_primitive")
    if magic_set & {"pcap", "pcapng"} or ext_set & {"pcap", "pcapng"} or "pcap" in term_set:
        traits.append("network_capture")
    if magic_set & {"png", "jpeg", "image"} or ext_set & IMAGE_EXTS:
        traits.append("image_artifact")
    if term_set & {"stego"}:
        traits.append("stego_suspected")
    if magic_set & {"zip", "gzip", "xz", "archive"} or ext_set & ARCHIVE_EXTS:
        traits.append("archive_artifact")
    if term_set & {"binwalk"}:
        traits.append("firmware_or_embedded")
    if term_set & {"rsa", "aes", "lattice", "xor"}:
        traits.append("crypto_material")
    if "rsa" in term_set:
        traits.append("rsa_material")
    if "aes" in term_set:
        traits.append("symmetric_crypto")
    if "wasm" in term_set or ext_set & {"wasm"}:
        traits.append("wasm_reverse")
    if "dotnet" in term_set or ext_set & {"dll", "cs"}:
        traits.append("dotnet_reverse")
    if "android" in term_set or ext_set & {"apk", "dex"}:
        traits.append("android_reverse")
    if "z3" in term_set:
        traits.append("constraint_solving")

    if any((item.get("name") or "").lower() in {"dockerfile", "docker-compose.yml"} for item in artifacts):
        traits.append("deployable_service")
    return sorted(set(languages)), sorted(set(frameworks)), sorted(set(traits))


def _score_rule(fingerprint: Dict[str, Any], rule: Dict[str, Any]) -> Tuple[float, List[str]]:
    match = rule.get("match") or {}
    fields = {
        "terms": set(fingerprint.get("prompt_terms") or []),
        "file_exts": set(fingerprint.get("file_exts") or []),
        "magic": set(fingerprint.get("magic") or []),
        "path_tokens": set(fingerprint.get("path_tokens") or []),
        "traits": set(fingerprint.get("traits") or []),
        "languages": set(fingerprint.get("languages") or []),
        "frameworks": set(fingerprint.get("frameworks") or []),
    }
    weights = {
        "terms": 2.0,
        "file_exts": 2.5,
        "magic": 3.0,
        "path_tokens": 1.0,
        "traits": 4.0,
        "languages": 1.5,
        "frameworks": 2.5,
    }
    score = 0.0
    reasons: List[str] = []
    for field, values in fields.items():
        expected = set(match.get(field) or [])
        hits = sorted(values & expected)
        if hits:
            score += weights[field] * len(hits)
            reasons.append(f"{field}: {', '.join(hits[:4])}")
    confidence = float(rule.get("confidence") or 0)
    score += min(2.0, confidence * 2.0)
    score += min(3.0, float(rule.get("success_count") or 0) * 0.25)
    return score, reasons


def _public_rule(rule: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": rule.get("id"),
        "description": rule.get("description"),
        "source": rule.get("source", "builtin"),
        "confidence": rule.get("confidence"),
        "success_count": rule.get("success_count", 0),
        "recommend": rule.get("recommend") or {},
    }


def _update_learned_rules(
    rules_path: Path,
    fingerprint: Dict[str, Any],
    matches: Sequence[Dict[str, Any]],
    used_tools: Sequence[str],
) -> Dict[str, Any]:
    rules = _read_learned_rules(rules_path)
    now = _utc_now()
    best_rule = ((matches[0].get("rule") if matches else None) or {})
    derived_from = best_rule.get("id")
    learned_id = f"learned/{derived_from}" if derived_from else f"learned/{fingerprint.get('digest', 'unknown')}"

    for rule in rules:
        if rule.get("id") == learned_id:
            rule["success_count"] = int(rule.get("success_count") or 0) + 1
            rule["last_success"] = now
            rule["confidence"] = min(0.95, float(rule.get("confidence") or 0.55) + 0.03)
            _merge_recommended_tools(rule, used_tools)
            _write_jsonl(rules_path, rules)
            return {"status": "updated", "rule_id": learned_id, "success_count": rule["success_count"]}

    if best_rule:
        rule = {
            "id": learned_id,
            "description": f"Learned reinforcement for {derived_from}",
            "source": "learned",
            "derived_from": derived_from,
            "created": now,
            "last_success": now,
            "success_count": 1,
            "confidence": max(0.6, float(best_rule.get("confidence") or 0.55)),
            "match": _rule_match_from_fingerprint(fingerprint),
            "recommend": dict(best_rule.get("recommend") or {}),
        }
    else:
        rule = {
            "id": learned_id,
            "description": "Learned route from verified successful solve",
            "source": "learned",
            "created": now,
            "last_success": now,
            "success_count": 1,
            "confidence": 0.55,
            "match": _rule_match_from_fingerprint(fingerprint),
            "recommend": {
                "skills": [],
                "tools": [tool for tool in used_tools if not tool.startswith("mcp__")][:8],
                "mcp_tools": [tool for tool in used_tools if tool.startswith("mcp__")][:8],
                "commands": [],
                "notes": ["Route learned from a flag-oracle-verified solve."],
            },
        }
    _merge_recommended_tools(rule, used_tools)
    rules.append(rule)
    _write_jsonl(rules_path, rules)
    return {"status": "created", "rule_id": learned_id, "success_count": 1}


def _rule_match_from_fingerprint(fingerprint: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "traits": list(fingerprint.get("traits") or [])[:8],
        "terms": list(fingerprint.get("prompt_terms") or [])[:8],
        "file_exts": list(fingerprint.get("file_exts") or [])[:8],
        "magic": list(fingerprint.get("magic") or [])[:6],
        "languages": list(fingerprint.get("languages") or [])[:5],
        "frameworks": list(fingerprint.get("frameworks") or [])[:5],
    }


def _merge_recommended_tools(rule: Dict[str, Any], used_tools: Sequence[str]) -> None:
    recommend = rule.setdefault("recommend", {})
    tools = list(recommend.get("tools") or [])
    mcp_tools = list(recommend.get("mcp_tools") or [])
    for tool in used_tools:
        if tool.startswith("mcp__"):
            _append_unique(mcp_tools, tool)
        elif tool not in {"no_tool", "bad_json"}:
            _append_unique(tools, tool)
    recommend["tools"] = tools[:16]
    recommend["mcp_tools"] = mcp_tools[:16]


def _extract_used_tools(history_info: Any) -> List[str]:
    text = "\n".join(str(item) for item in (history_info or []))
    tools: List[str] = []
    for match in re.findall(r"调用工具([A-Za-z0-9_:.\/-]+)", text):
        _append_unique(tools, match.rstrip(","))
    for match in re.findall(r"\bTool:\s*`?([A-Za-z0-9_:.\/-]+)`?", text):
        _append_unique(tools, match.rstrip(","))
    for match in re.findall(r"\b([A-Za-z0-9_]+)\(", text):
        if match in HARDCODED_VIRTUAL_TOOLS or match in DEFAULT_CTF_MCP_TOOLS or match in {"verify_flag", "check_flag", "file_read", "code_run"}:
            _append_unique(tools, match)
    return tools[:32]


def _compact_fingerprint(fingerprint: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "version": fingerprint.get("version"),
        "digest": fingerprint.get("digest"),
        "file_exts": list(fingerprint.get("file_exts") or [])[:16],
        "magic": list(fingerprint.get("magic") or [])[:12],
        "prompt_terms": list(fingerprint.get("prompt_terms") or [])[:20],
        "languages": list(fingerprint.get("languages") or [])[:10],
        "frameworks": list(fingerprint.get("frameworks") or [])[:10],
        "traits": list(fingerprint.get("traits") or [])[:20],
        "artifacts": list(fingerprint.get("artifacts") or [])[:12],
    }


def _tool_names_from_schema(path: Path) -> List[str]:
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    names: List[str] = []
    for item in data if isinstance(data, list) else []:
        name = ((item or {}).get("function") or {}).get("name")
        if name:
            names.append(name)
    return names


def _skill_names_from_dir(path: Path) -> List[str]:
    if not path.is_dir():
        return []
    names: List[str] = []
    try:
        for child in path.iterdir():
            if child.is_dir() and (child / "SKILL.md").is_file():
                names.append(child.name)
    except OSError:
        return []
    return names


def _mcp_servers_from_roots(roots: Sequence[Path]) -> List[Dict[str, Any]]:
    servers: Dict[str, Dict[str, Any]] = {}
    for root in roots:
        for path in _mcp_config_candidates(root):
            if not path.is_file():
                continue
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            configs = raw.get("mcpServers", raw) if isinstance(raw, dict) else {}
            if not isinstance(configs, dict):
                continue
            for name, cfg in configs.items():
                if not isinstance(cfg, dict):
                    continue
                servers.setdefault(
                    str(name),
                    {
                        "name": str(name),
                        "transport": "http" if cfg.get("url") else "stdio",
                        "source_path": str(path),
                        "enabled": True,
                    },
                )
    return sorted(servers.values(), key=lambda item: item["name"])


def _mcp_config_candidates(root: Path) -> List[Path]:
    return [
        root / ".secheur-agent" / "mcp.json",
        root / ".mcp.json",
        root / "settings.json",
        root / "settings.local.json",
        root / ".secheur-agent" / "settings.json",
        root / ".secheur-agent" / "settings.local.json",
    ]


def _read_learned_rules(path: Optional[Path] = None) -> List[Dict[str, Any]]:
    path = path or (_memory_dir() / "tool_index_rules.jsonl")
    if not path.is_file():
        return []
    rules: List[Dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rules.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rules


def _memory_dir() -> Path:
    configured = os.environ.get(MEMORY_DIR_ENV)
    if configured:
        return Path(configured).expanduser().resolve()
    return MODULE_ROOT / "memory"


def _append_jsonl(path: Path, item: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n")


def _write_jsonl(path: Path, items: Sequence[Dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        for item in items:
            handle.write(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n")
    tmp.replace(path)


def _safe_rel(path: Path, root: Path) -> str:
    try:
        return str(path.resolve().relative_to(root.resolve())).replace(os.sep, "/")
    except Exception:
        return path.name


def _tokens_from_paths(paths: Iterable[str]) -> List[str]:
    tokens = set()
    for path in paths:
        for token in re.findall(r"[A-Za-z0-9]{2,32}", str(path).lower()):
            if token in {"the", "and", "for", "with", "file", "data"}:
                continue
            tokens.add(token)
    return sorted(tokens)


def _normalize_ext(ext: Any) -> str:
    return str(ext or "").strip().lower().lstrip(".")


def _unique_sorted(values: Iterable[Any]) -> List[str]:
    return sorted({str(value).strip().lower() for value in values if str(value or "").strip()})


def _append_unique(items: List[str], value: Any) -> None:
    value = str(value or "").strip()
    if value and value not in items:
        items.append(value)


def _first_existing_dir(*values: Any) -> Optional[Path]:
    for value in values:
        if not value:
            continue
        try:
            path = Path(value).expanduser().resolve()
        except Exception:
            continue
        if path.is_dir():
            return path
    return None


def _format_list(values: Any, limit: int) -> str:
    items = [str(value) for value in (values or []) if str(value)]
    return ", ".join(items[:limit])


def _preview(value: Any, limit: int = 180) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit] + ("..." if len(text) > limit else "")


def _utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _rule(
    rule_id: str,
    description: str,
    match: Dict[str, List[str]],
    recommend: Dict[str, List[str]],
    confidence: float = 0.65,
) -> Dict[str, Any]:
    return {
        "id": rule_id,
        "description": description,
        "source": "builtin",
        "confidence": confidence,
        "success_count": 0,
        "match": match,
        "recommend": recommend,
    }


DEFAULT_RULES: List[Dict[str, Any]] = [
    _rule(
        "unsafe-python-deserialization",
        "Python pickle or object deserialization challenge.",
        {
            "terms": ["pickle", "python-jail"],
            "file_exts": ["py", "pkl", "pickle"],
            "traits": ["unsafe_deserialization", "python_source"],
            "languages": ["python"],
        },
        {
            "skills": ["ctf-misc", "ctf-reverse"],
            "tools": ["grep_search", "list_files", "file_read", "code_run", "verify_flag", "check_flag"],
            "mcp_tools": ["run_ctf_tool", "strings_extract"],
            "commands": ["python3", "strings", "grep"],
            "notes": ["Inspect custom Unpickler/find_class and gadget constraints before brute force."],
        },
        0.78,
    ),
    _rule(
        "web-source-service",
        "HTTP service or web source challenge.",
        {
            "terms": ["flask", "express", "php", "jwt", "sql", "ssti", "xss", "ssrf", "graphql"],
            "file_exts": ["py", "js", "ts", "php", "html"],
            "traits": ["web_source", "http_service", "deployable_service"],
            "frameworks": ["flask", "express", "graphql"],
        },
        {
            "skills": ["ctf-web"],
            "tools": ["web_fetch", "web_scan", "grep_search", "list_files", "file_read", "code_run", "verify_flag", "check_flag"],
            "mcp_tools": ["run_ctf_tool"],
            "commands": ["curl", "python3", "grep", "sed"],
            "notes": ["Map routes and auth/session handling from source before blind endpoint fuzzing."],
        },
        0.72,
    ),
    _rule(
        "elf-pwn",
        "Native ELF exploitation challenge.",
        {
            "terms": ["overflow", "format-string", "rop", "heap"],
            "file_exts": ["elf", "bin", "so", "c"],
            "magic": ["elf"],
            "traits": ["elf_binary", "pwn_primitive", "native_source"],
        },
        {
            "skills": ["ctf-pwn", "ctf-reverse"],
            "tools": ["list_files", "file_read", "code_run", "verify_flag", "check_flag"],
            "mcp_tools": ["identify_file", "strings_extract", "checksec_file", "run_linux_elf", "gdb_batch", "radare2_cmd", "run_ctf_tool"],
            "commands": ["file", "checksec", "strings", "objdump", "readelf", "gdb", "python3"],
            "notes": ["Run file/checksec/strings before deciding between reversing and exploitation."],
        },
        0.76,
    ),
    _rule(
        "network-pcap-forensics",
        "PCAP or network traffic forensics challenge.",
        {
            "terms": ["pcap"],
            "file_exts": ["pcap", "pcapng"],
            "magic": ["pcap", "pcapng"],
            "traits": ["network_capture"],
        },
        {
            "skills": ["ctf-forensics", "ctf-malware"],
            "tools": ["list_files", "file_read", "code_run", "verify_flag", "check_flag"],
            "mcp_tools": ["identify_file", "tshark_summary", "run_ctf_tool", "strings_extract"],
            "commands": ["tshark", "tcpdump", "strings", "python3"],
            "notes": ["Extract conversations, objects, DNS/HTTP metadata, and suspicious payloads early."],
        },
        0.74,
    ),
    _rule(
        "archive-and-stego-forensics",
        "Archive, embedded data, image, or steganography challenge.",
        {
            "terms": ["stego", "binwalk"],
            "file_exts": ["zip", "gz", "tgz", "tar", "xz", "7z", "rar", "png", "jpg", "jpeg", "pdf"],
            "magic": ["zip", "gzip", "xz", "archive", "png", "jpeg", "pdf", "image"],
            "traits": ["archive_artifact", "image_artifact", "stego_suspected", "firmware_or_embedded"],
        },
        {
            "skills": ["ctf-forensics"],
            "tools": ["list_files", "file_read", "code_run", "verify_flag", "check_flag"],
            "mcp_tools": ["identify_file", "strings_extract", "binwalk_scan", "run_ctf_tool"],
            "commands": ["file", "strings", "binwalk", "exiftool", "unzip", "tar", "python3"],
            "notes": ["Identify container format and embedded files before repeated manual extraction."],
        },
        0.7,
    ),
    _rule(
        "crypto-material",
        "Cryptography material in challenge files or prompt.",
        {
            "terms": ["rsa", "aes", "lattice", "xor"],
            "file_exts": ["py", "sage", "txt"],
            "traits": ["crypto_material", "rsa_material", "symmetric_crypto", "constraint_solving"],
        },
        {
            "skills": ["ctf-crypto"],
            "tools": ["grep_search", "list_files", "file_read", "code_run", "verify_flag", "check_flag"],
            "mcp_tools": ["run_ctf_tool"],
            "commands": ["python3", "sage", "grep"],
            "notes": ["Extract exact parameters and verify math assumptions with small scripts."],
        },
        0.7,
    ),
    _rule(
        "reverse-engineering",
        "Reverse engineering challenge with managed, WASM, Android, or native artifacts.",
        {
            "terms": ["wasm", "dotnet", "android", "z3"],
            "file_exts": ["wasm", "dll", "exe", "apk", "dex", "so"],
            "magic": ["elf", "pe"],
            "traits": ["wasm_reverse", "dotnet_reverse", "android_reverse", "elf_binary", "pe_binary", "constraint_solving"],
        },
        {
            "skills": ["ctf-reverse"],
            "tools": ["grep_search", "list_files", "file_read", "code_run", "verify_flag", "check_flag"],
            "mcp_tools": ["identify_file", "strings_extract", "radare2_cmd", "run_ctf_tool"],
            "commands": ["file", "strings", "rabin2", "radare2", "python3", "java"],
            "notes": ["Recover validation logic and encode it into a verifier before guessing flags."],
        },
        0.68,
    ),
]
