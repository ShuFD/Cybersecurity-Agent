"""CTF verb recommender and experience-replay hook.

Mirrors `web_verbs.recommender` but tuned for pwn/re signals. The
recommender never claims a verb is mandatory; it surfaces options and
the structural digest used by `record_success` later.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional


MODULE_ROOT = Path(__file__).resolve().parent.parent
MEMORY_DIR_ENV = "SECHEUR_CTF_VERB_MEMORY_DIR"

BINARY_SIGNAL_FILES = {
    "vmlinux",
    "kernel.bin",
    "zImage",
}
BINARY_EXTS = {".elf", ".bin", ".so", ".o", ".ko"}
SKIP_DIRS = {".git", "__pycache__", ".venv", "venv", "node_modules", ".pytest_cache", "memory", "temp", "tool_results"}


def build_ctf_verb_context(
    prompt: Any,
    *,
    project_root: Optional[str] = None,
    task_dir: Optional[str] = None,
    enabled: bool = True,
) -> Dict[str, Any]:
    root = _first_existing_dir(task_dir, project_root, os.getcwd()) or Path(os.getcwd())
    text_signals = _extract_text_signals(str(prompt or ""))
    file_signals = _extract_file_signals(root)
    traits = sorted(set(text_signals["traits"] + file_signals["traits"]))
    binary_paths = file_signals["binary_paths"][:20]
    is_pwn_or_re_task = bool(binary_paths or traits)
    recommended = _recommend_verbs(traits, binary_paths)
    digest_payload = {
        "traits": traits,
        "binary_exts": sorted(file_signals["binary_exts"]),
        "binary_count": len(file_signals["binary_paths"]),
    }
    digest = hashlib.sha256(json.dumps(digest_payload, sort_keys=True).encode()).hexdigest()[:16]
    return {
        "enabled": bool(enabled),
        "is_pwn_or_re_task": is_pwn_or_re_task,
        "root": str(root),
        "digest": digest,
        "traits": traits,
        "binary_paths": binary_paths,
        "recommended_tools": ["ctf_verb_call"] if is_pwn_or_re_task else [],
        "recommended_verbs": recommended,
    }


def format_ctf_verb_prompt(context: Dict[str, Any]) -> str:
    if not context or not context.get("enabled"):
        return ""
    verbs = context.get("recommended_verbs") or []
    if not context.get("is_pwn_or_re_task"):
        verbs = ["pwn.checksec", "re.triage", "re.strings"]
    binaries = context.get("binary_paths") or []
    binary_hint = f" Observed binaries: {', '.join(binaries[:5])}." if binaries else ""
    lines = [
        "[CTF Typed Verbs]",
        "The frontend CTF Verb switch is ON for this turn. Prefer typed ctf actions through the `ctf_verb_call` tool before raw shell scraping for pwn and reverse work.",
        f"Detected ctf traits: {', '.join(context.get('traits') or []) or 'none'}.",
        f"Recommended verbs: {', '.join(verbs) or 'none'}.",
        "Call format: ctf_verb_call({\"verb\":\"pwn.inspect_binary\",\"args\":{\"path\":\"a.out\"}}).",
        "For multi-step pwn recipes (probe -> leak -> control -> ROP -> exec) use `pwn.open_session` and `pwn.append_event` instead of repeating atomic verbs.",
        "Each verb returns structured JSON and writes a ctf_verb_trace.jsonl record for reproducibility.",
    ]
    if binary_hint:
        lines.append(binary_hint)
    return "\n".join(line for line in lines if line)


def record_success(
    *,
    parent: Any,
    handler: Any = None,
    oracle_result: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    if not getattr(parent, "ctf_verbs_enabled", False):
        return {"status": "disabled"}
    if getattr(parent, "_ctf_verb_success_recorded", False):
        return {"status": "already_recorded"}
    oracle_result = oracle_result or {}
    if oracle_result and not (
        oracle_result.get("correct") or oracle_result.get("status") == "correct"
    ):
        return {"status": "not_verified"}

    context = getattr(parent, "ctf_verb_context", None) or {}
    used = list(getattr(parent, "ctf_verbs_used", []) or [])
    sessions = list(getattr(parent, "ctf_sessions_used", []) or [])

    memory_dir = _memory_dir()
    memory_dir.mkdir(parents=True, exist_ok=True)
    entry = {
        "ts": _utc_now(),
        "fingerprint_digest": context.get("digest"),
        "traits": context.get("traits") or [],
        "binary_paths": context.get("binary_paths") or [],
        "used_verbs": used,
        "sessions_used": sessions,
        "oracle_status": oracle_result.get("status") or ("correct" if oracle_result.get("correct") else ""),
        "attempts_total": oracle_result.get("attempts_total") or oracle_result.get("attempt"),
    }
    _append_jsonl(memory_dir / "ctf_verb_success_cases.jsonl", entry)
    update = _update_rule(memory_dir / "ctf_verb_rules.jsonl", context, used, sessions)
    setattr(parent, "_ctf_verb_success_recorded", True)
    return {
        "status": "recorded",
        "memory_dir": str(memory_dir),
        "rule_update": update,
        "used_verbs": used,
        "sessions_used": sessions,
    }


def _extract_text_signals(text: str) -> Dict[str, Any]:
    lowered = text.lower()
    traits: List[str] = []
    trait_patterns = {
        "binary_present": r"\b(?:binary|executable|elf|binfile|elf64|elf32|a\.out|target)\b",
        "pwn_glibc": r"\bglibc|libc[-_ ]?version|libc[-_ ]?base|libcdatabase\b",
        "rop_chain": r"\brop(?:\s+chain)?|ret2|ropper|ropgadget|one[_-]?gadget|stack pivot",
        "heap_exploit": r"\bheap|tcache|fastbin|unsorted\s*bin|fsop|house[-_ ]?of[-_ ]?\w+|tcache_dup",
        "format_string": r"\bformat\s*string|%n|%p\.|fmtstr|fmt[-_ ]?str",
        "shellcode": r"\bshellcode|msfvenom|nasm|execve\(|/bin/sh",
        "kernel": r"\bkernel(?:\s+exploit|module)?|kaslr|kptr_restrict|modprobe_path",
        "canary": r"\bstack\s*(?:canary|cookie)|__stack_chk_fail",
        "reverse_symbols": r"\bghidra|\bida\b|radare|rizin|\br2\b|decompile|disassembl",
        "reverse_vm": r"\bvirtual\s*machine|bytecode\s*interpreter|opaque\s*predicate|control[- ]?flow\s*flattening",
        "reverse_packing": r"\bpacker|packed|upx|themida|vmp|vmprotect",
        "strings_artifacts": r"\bflag[-_]?pattern|\b(?<!no )strings?\b|\bhardcoded\b",
        "pwn_database": r"\b(?:libc[-_]?database|libcdb|libc\.rip)\b",
    }
    for trait, pattern in trait_patterns.items():
        if re.search(pattern, lowered, flags=re.I):
            traits.append(trait)
    return {"traits": traits}


def _extract_file_signals(root: Path) -> Dict[str, Any]:
    binary_paths: List[str] = []
    binary_exts: List[str] = []
    tokens: List[str] = []
    traits: List[str] = []
    if not root.exists():
        return {"binary_paths": [], "binary_exts": [], "traits": [], "tokens": []}
    for path in _iter_files(root):
        rel = _safe_rel(path, root)
        name_l = path.name.lower()
        suffix = path.suffix.lower()
        if name_l in BINARY_SIGNAL_FILES or suffix in BINARY_EXTS or _looks_like_elf(path):
            binary_paths.append(rel)
            binary_exts.append(suffix or "<noext>")
            if not _has_text_extension(path):
                tokens.append(rel.lower())
        if any(trait in name_l for trait in ("elf", "vmlinux", "kernel", "loader", "initramfs")):
            traits.append("binary_present")
    if binary_paths:
        traits.append("binary_present")
    return {
        "binary_paths": binary_paths,
        "binary_exts": sorted(set(binary_exts)),
        "traits": sorted(set(traits)),
        "tokens": tokens[:60],
    }


def _recommend_verbs(traits: List[str], binary_paths: List[str]) -> List[str]:
    trait_set = set(traits)
    verbs: List[str] = []
    if binary_paths or "binary_present" in trait_set:
        verbs.extend(["re.triage", "pwn.inspect_binary"])
    if trait_set & {"rop_chain", "shellcode", "canary"}:
        verbs.extend(["pwn.find_gadgets", "pwn.disasm"])
    if trait_set & {"pwn_glibc", "pwn_database"}:
        verbs.extend(["pwn.identify_libc", "pwn.glibc_offsets"])
    if trait_set & {"heap_exploit", "format_string", "kernel", "pwn_glibc"}:
        verbs.extend(["pwn.open_session", "pwn.append_event", "pwn.close_session"])
    if trait_set & {"reverse_symbols", "reverse_vm", "reverse_packing", "strings_artifacts"}:
        verbs.extend(["re.strings", "re.functions", "re.detect_packer"])
    if trait_set & {"reverse_vm", "reverse_symbols"}:
        verbs.append("re.decompile")
    if "binary_present" in trait_set and not verbs:
        verbs.extend(["re.triage", "re.strings"])
    return _dedupe(verbs)[:12]


def _update_rule(
    path: Path,
    context: Dict[str, Any],
    used: List[Dict[str, Any]],
    sessions: List[Dict[str, Any]],
) -> Dict[str, Any]:
    rules = _read_jsonl(path)
    rule_id = "ctf/" + str(
        context.get("digest") or hashlib.sha1(json.dumps(context, sort_keys=True).encode()).hexdigest()[:16]
    )
    used_names = _dedupe(item.get("verb") for item in used if item.get("verb"))
    session_outcomes = _dedupe(item.get("outcome") for item in sessions if item.get("outcome"))
    for rule in rules:
        if rule.get("id") == rule_id:
            rule["success_count"] = int(rule.get("success_count") or 0) + 1
            rule["last_success"] = _utc_now()
            rule["verbs"] = _dedupe(list(rule.get("verbs") or []) + used_names)
            if session_outcomes:
                rule["session_outcomes"] = _dedupe(
                    list(rule.get("session_outcomes") or []) + session_outcomes
                )
            _write_jsonl(path, rules)
            return {"status": "updated", "rule_id": rule_id, "success_count": rule["success_count"]}
    rules.append(
        {
            "id": rule_id,
            "created": _utc_now(),
            "last_success": _utc_now(),
            "success_count": 1,
            "traits": context.get("traits") or [],
            "verbs": used_names,
            "session_outcomes": session_outcomes,
        }
    )
    _write_jsonl(path, rules)
    return {"status": "created", "rule_id": rule_id, "success_count": 1}


def _iter_files(root: Path):
    count = 0
    for current, dirs, files in os.walk(root):
        dirs[:] = [
            d
            for d in dirs
            if d not in SKIP_DIRS
            and not d.startswith(".cache")
            and not d.startswith("ctf_sessions")
        ]
        for name in sorted(files):
            count += 1
            if count > 220:
                return
            yield Path(current) / name


def _looks_like_elf(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            head = handle.read(4)
    except Exception:
        return False
    return head == b"\x7fELF"


def _has_text_extension(path: Path) -> bool:
    return path.suffix.lower() in {
        ".py",
        ".js",
        ".ts",
        ".php",
        ".html",
        ".htm",
        ".md",
        ".txt",
        ".json",
        ".yml",
        ".yaml",
    }


def _memory_dir() -> Path:
    configured = os.environ.get(MEMORY_DIR_ENV)
    if configured:
        return Path(configured).expanduser().resolve()
    return MODULE_ROOT / "memory"


def _append_jsonl(path: Path, item: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n")


def _read_jsonl(path: Path) -> List[Dict[str, Any]]:
    if not path.is_file():
        return []
    out: List[Dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            out.append(json.loads(line))
        except Exception:
            continue
    return out


def _write_jsonl(path: Path, items: List[Dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        for item in items:
            handle.write(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n")
    tmp.replace(path)


def _dedupe(values) -> List[str]:
    out: List[str] = []
    for value in values or []:
        text = str(value or "").strip()
        if text and text not in out:
            out.append(text)
    return out


def _safe_rel(path: Path, root: Path) -> str:
    try:
        return str(path.resolve().relative_to(root.resolve())).replace(os.sep, "/")
    except Exception:
        return path.name


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


def _utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
