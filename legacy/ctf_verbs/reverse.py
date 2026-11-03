"""Reverse-engineering atomic primitives.

Same contract as `pwn.py`: each verb returns JSON describing one
observation (triage, strings, symbols, packer, decompile hint).  Heavy
decompilers (Ghidra/IDA/radare2) are not run inside this layer; instead
`re.decompile` reports which backend is reachable so the agent can
dispatch through MCP if configured.
"""

from __future__ import annotations

import hashlib
import math
import os
import re
import subprocess
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ._spec import VerbSpec


REVERSE_VERBS: Dict[str, VerbSpec] = {}


def _register(spec: VerbSpec) -> VerbSpec:
    REVERSE_VERBS[spec.name] = spec
    return spec


MAX_BINARY_BYTES = 64 * 1024 * 1024
MAX_STRINGS = 800
MAX_FUNCTIONS = 600
SECTION_ENTROPY_BUCKETS = 32
KNOWN_PACKERS: Dict[str, List[str]] = {
    "UPX": ["UPX!", "upx_", "$Info: This file is packed with the UPX"],
    "MPRESS": ["MPRESS"],
    "ASPack": ["ASPack"],
    "PEtite": ["PEtite"],
    "FSG": ["FSG!"],
    "VMProtect": ["VMProtect", ".vmp0", ".vmp1"],
    "Themida": ["Themida", "Winlicense"],
    "PyInstaller": ["pyi-", "PyInstaller"],
}


def _resolve_path(value: Any) -> Path:
    path = Path(str(value or "")).expanduser()
    if not path.is_absolute():
        path = (Path.cwd() / path).resolve()
    return path


def _safe_run(cmd: List[str], *, timeout: float = 8.0, max_bytes: int = 2_000_000, env_locale: bool = True) -> Dict[str, Any]:
    env = os.environ.copy() if env_locale else None
    if env is not None:
        env["LC_ALL"] = "C"
        env["LANG"] = "C"
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            timeout=timeout,
            check=False,
            env=env,
        )
    except FileNotFoundError as exc:
        return {"status": "error", "error": f"{type(exc).__name__}: {exc}"}
    except subprocess.TimeoutExpired:
        return {"status": "error", "error": f"timeout after {timeout}s"}
    out = proc.stdout[:max_bytes] if proc.stdout else b""
    err = proc.stderr[:max_bytes] if proc.stderr else b""
    return {
        "status": "ok" if proc.returncode == 0 else "error",
        "returncode": int(proc.returncode),
        "stdout": out.decode("utf-8", errors="replace"),
        "stderr": err.decode("utf-8", errors="replace"),
    }


def _shannon_entropy(data: bytes) -> float:
    if not data:
        return 0.0
    counts = Counter(data)
    total = len(data)
    entropy = 0.0
    for count in counts.values():
        p = count / total
        if p <= 0:
            continue
        entropy -= p * math.log2(p)
    return entropy


def _detect_language(path: Path, file_output: str) -> List[str]:
    langs: List[str] = []
    suffixes = path.suffix.lower()
    text = file_output.lower()
    if suffixes == ".pyc" or "python" in text:
        langs.append("python")
    if suffixes == ".class" or "java" in text:
        langs.append("java")
    if suffixes in {".jar"} or "java archive" in text:
        langs.append("java_jar")
    if suffixes == ".dex" or "android dex" in text:
        langs.append("android_dex")
    if "elf" in text and "linux" in text:
        langs.append("c_cpp")
    if "mach-o" in text:
        langs.append("c_cpp_macho")
    if suffixes == ".wasm" or "webassembly" in text:
        langs.append("wasm")
    if suffixes == ".netmodule" or "mono/.net" in text:
        langs.append("dotnet")
    if suffixes == ".bc" or "llvm" in text:
        langs.append("llvm_ir")
    if suffixes in {".go",} or "go" in text and "google" not in text:
        langs.append("go")
    if suffixes in {".rs",} or "rust" in text:
        langs.append("rust")
    return sorted(set(langs))


def _is_pdb_present(path: Path, data: bytes) -> bool:
    if path.suffix.lower() in {".pdb"}:
        return True
    if b"Microsoft Pdb" in data[:1024 * 1024]:
        return True
    for line in data[:1024 * 1024].split(b"\n", maxsplit=2000):
        if b"PDB" in line and b"file:" in line.lower():
            return True
    return False


def _section_table(path: Path) -> List[Dict[str, Any]]:
    run = _safe_run(["readelf", "-SW", str(path)], timeout=6)
    sections: List[Dict[str, Any]] = []
    if run["status"] != "ok":
        return sections
    text = run["stdout"]
    in_table = False
    for raw_line in text.splitlines():
        if "[" in raw_line and "Name" in raw_line and "Type" in raw_line:
            in_table = True
            continue
        if not in_table:
            continue
        if not raw_line.lstrip().startswith("["):
            continue
        parts = raw_line.split()
        if len(parts) < 6:
            continue
        # Two readelf index layouts:
        #   "[ 1] .note.gnu.build-id NOTE ..."  -> parts[1]="1]" name=parts[2]
        #   "[10] .init PROGBITS ..."           -> parts[0]="[10]" name=parts[1]
        # The discriminator is whether the bracket is closed in parts[1]
        # (single-digit) or merged into parts[0] (>= 10).
        name_idx = 1 if parts[0].startswith("[") and parts[0].endswith("]") else 2
        if len(parts) < name_idx + 3:
            continue
        try:
            size = int(parts[name_idx + 4], 16)
        except Exception:
            continue
        name = parts[name_idx]
        if name.endswith("[...]"):
            name = name[: -len("[...]")]
        sections.append(
            {
                "name": name,
                "type": parts[name_idx + 1] if len(parts) >= name_idx + 2 else "",
                "size": size,
            }
        )
    return sections[:40]


def _packer_indicators(data: bytes, file_output: str) -> List[Dict[str, Any]]:
    found: List[Dict[str, Any]] = []
    haystack = (file_output or "") + " " + data[:256_000].decode("latin-1", errors="replace")
    haystack_lower = haystack.lower()
    for packer, signatures in KNOWN_PACKERS.items():
        for sig in signatures:
            if sig.lower() in haystack_lower:
                found.append({"packer": packer, "indicator": sig})
                break
    return found


def verb_triage(args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    path = _resolve_path(args.get("path"))
    if not path.is_file():
        raise FileNotFoundError(path)
    if path.stat().st_size > MAX_BINARY_BYTES:
        raise ValueError(f"file too large for triage: {path.stat().st_size} bytes")
    data = path.read_bytes()
    sha256 = hashlib.sha256(data).hexdigest()
    file_run = _safe_run(["file", "-b", str(path)], timeout=6)
    file_text = file_run["stdout"].strip()
    sections = _section_table(path) if data[:4] == b"\x7fELF" else []
    if sections:
        section_blob = bytes(data[: min(len(data), 1_000_000)])
        entropies = []
        bucket = max(1, len(section_blob) // SECTION_ENTROPY_BUCKETS)
        for idx in range(0, len(section_blob), bucket):
            entropies.append(
                {
                    "offset": idx,
                    "entropy": round(_shannon_entropy(section_blob[idx : idx + bucket]), 3),
                }
            )
    else:
        entropies = [{"offset": 0, "entropy": round(_shannon_entropy(data[:64_000]), 3)}]
    packers = _packer_indicators(data, file_text)
    return {
        "path": str(path),
        "size": len(data),
        "sha256": sha256,
        "file_output": file_text,
        "languages": _detect_language(path, file_text),
        "stripped": "not stripped" not in file_text,
        "has_pdb": _is_pdb_present(path, data),
        "sections": sections,
        "entropy_samples": entropies[:SECTION_ENTROPY_BUCKETS],
        "packer_indicators": packers,
        "next_recommendation": (
            "pwn.checksec" if data[:4] == b"\x7fELF" else "re.strings"
        ),
    }


def verb_strings(args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    path = _resolve_path(args.get("path"))
    if not path.is_file():
        raise FileNotFoundError(path)
    try:
        min_len = max(2, min(int(args.get("min_len") or 4), 64))
    except Exception:
        min_len = 4
    try:
        max_count = max(20, min(int(args.get("max_count") or MAX_STRINGS), MAX_STRINGS))
    except Exception:
        max_count = MAX_STRINGS
    contains = str(args.get("contains") or "").strip()
    exclude = str(args.get("exclude") or "").strip()
    run = _safe_run(
        ["strings", "-n", str(min_len), "-a", str(path)],
        timeout=12,
        max_bytes=4_000_000,
    )
    if run["status"] != "ok":
        return {
            "path": str(path),
            "min_len": min_len,
            "strings": [],
            "error": run.get("error") or run.get("stderr", "")[:500],
        }
    candidates: List[Dict[str, Any]] = []
    contains_l = contains.lower() if contains else ""
    exclude_l = exclude.lower() if exclude else ""
    for line in run["stdout"].splitlines():
        text = line.strip()
        if not text or len(text) < min_len:
            continue
        low = text.lower()
        if contains_l and contains_l not in low:
            continue
        if exclude_l and exclude_l in low:
            continue
        candidates.append({"value": text})
        if len(candidates) >= max_count:
            break
    return {
        "path": str(path),
        "min_len": min_len,
        "filters": {"contains": contains, "exclude": exclude},
        "strings": candidates,
        "string_count": len(candidates),
        "truncated": len(candidates) >= max_count,
    }


def _parse_functions(text: str, source: str) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    # nm -P output is "Name TYPE ADDR [SIZE]".  We need only the first 3 tokens.
    nm_match = re.match(r"^(\S+)\s+([A-Za-z])\s+([0-9a-fA-F]+)", text)
    if nm_match:
        name, kind, addr = nm_match.groups()
        items.append(
            {
                "addr": f"0x{addr}",
                "name": name,
                "kind": "symbol",
                "type": {
                    "T": "text",
                    "W": "weak_text",
                    "B": "bss",
                    "D": "data",
                    "R": "rodata",
                    "r": "rodata_local",
                    "t": "text_local",
                    "b": "bss_local",
                    "d": "data_local",
                }.get(kind, kind),
            }
        )
        return items
    # Fallback: non-P mode produces "<addr> <type> <name>" lines.
    obj_match = re.match(r"^([0-9a-f]+)\s+([TtWwBbDdRr])\s+(\S+)$", text)
    if obj_match:
        addr, kind, name = obj_match.groups()
        items.append(
            {
                "addr": f"0x{addr}",
                "name": name,
                "kind": "symbol",
                "type": kind,
            }
        )
        return items
    return items


def verb_functions(args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    path = _resolve_path(args.get("path"))
    if not path.is_file():
        raise FileNotFoundError(path)
    try:
        max_count = max(20, min(int(args.get("max_count") or 120), MAX_FUNCTIONS))
    except Exception:
        max_count = 120
    name_pattern = str(args.get("name_pattern") or "").strip()
    exported_only = bool(args.get("exported_only") or False)
    pattern = re.compile(name_pattern) if name_pattern else None

    run = _safe_run(
        ["nm", "--defined-only", "-P", str(path)] if not exported_only else
        ["nm", "--defined-only", "-P", "--dynamic", str(path)],
        timeout=12,
        max_bytes=4_000_000,
    )
    if run["status"] != "ok":
        return {
            "path": str(path),
            "functions": [],
            "error": run.get("error") or run.get("stderr", "")[:500],
        }
    items: List[Dict[str, Any]] = []
    for line in run["stdout"].splitlines():
        parsed = _parse_functions(line, "nm")
        for item in parsed:
            if pattern and not pattern.search(item["name"]):
                continue
            items.append(item)
            if len(items) >= max_count:
                break
        if len(items) >= max_count:
            break
    return {
        "path": str(path),
        "filters": {"name_pattern": name_pattern, "exported_only": exported_only},
        "functions": items,
        "function_count": len(items),
        "truncated": len(items) >= max_count,
    }


def verb_detect_packer(args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    path = _resolve_path(args.get("path"))
    if not path.is_file():
        raise FileNotFoundError(path)
    data = path.read_bytes()
    file_run = _safe_run(["file", "-b", str(path)], timeout=6)
    file_text = file_run["stdout"]
    indicators = _packer_indicators(data, file_text)
    overall_entropy = _shannon_entropy(data[:256_000])
    confidence = min(1.0, len(indicators) * 0.25 + (0.4 if overall_entropy > 7.2 else 0))
    if not indicators:
        confidence = 0.0
    primary = indicators[0]["packer"] if indicators else None
    return {
        "path": str(path),
        "packer": primary,
        "confidence": round(confidence, 3),
        "indicators": indicators,
        "overall_entropy": round(overall_entropy, 3),
    }


def _normalize_function_list(items: Any) -> List[Tuple[str, str]]:
    out: List[Tuple[str, str]] = []
    if not isinstance(items, list):
        return out
    for entry in items:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        addr = str(entry.get("addr") or "").strip()
        if name or addr:
            out.append((name, addr))
    return out


def verb_diff_against(args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    baseline_path = _resolve_path(args.get("baseline_path"))
    target_path = _resolve_path(args.get("path"))
    if not baseline_path.is_file() or not target_path.is_file():
        raise FileNotFoundError("both baseline_path and path must exist")
    if baseline_path.stat().st_size > MAX_BINARY_BYTES or target_path.stat().st_size > MAX_BINARY_BYTES:
        raise ValueError("binary too large for diff")
    baseline_data = baseline_path.read_bytes()
    target_data = target_path.read_bytes()
    baseline_hash = hashlib.sha256(baseline_data).hexdigest()
    target_hash = hashlib.sha256(target_data).hexdigest()
    same_size = len(baseline_data) == len(target_data)

    baseline_run = _safe_run(["nm", "--defined-only", "-P", str(baseline_path)], timeout=8)
    target_run = _safe_run(["nm", "--defined-only", "-P", str(target_path)], timeout=8)
    baseline_set = set()
    target_set = set()
    if baseline_run["status"] == "ok":
        baseline_set = {
            (item.split()[0] if len(item.split()) >= 1 else item)
            for item in baseline_run["stdout"].splitlines()
            if item.strip()
        }
    if target_run["status"] == "ok":
        target_set = {
            (item.split()[0] if len(item.split()) >= 1 else item)
            for item in target_run["stdout"].splitlines()
            if item.strip()
        }
    added = sorted(target_set - baseline_set)[:40]
    removed = sorted(baseline_set - target_set)[:40]

    size_delta = len(target_data) - len(baseline_data)
    return {
        "baseline_path": str(baseline_path),
        "target_path": str(target_path),
        "baseline_sha256": baseline_hash,
        "target_sha256": target_hash,
        "size_delta": size_delta,
        "size_match": same_size,
        "added_symbols": added,
        "removed_symbols": removed,
        "added_count": len(added),
        "removed_count": len(removed),
    }


def _probe_decompilers() -> List[Dict[str, Any]]:
    candidates = [
        ("ghidra", ["ghidra", "analyzeHeadless"]),
        ("ida", ["ida"]),
        ("rizin", ["rizin"]),
        ("radare2", ["r2"]),
        ("binaryninja", ["binaryninja"]),
    ]
    available: List[Dict[str, Any]] = []
    for name, cmd in candidates:
        try:
            proc = subprocess.run(
                [cmd[0], "--version"] if cmd[0] != "analyzeHeadless" else ["analyzeHeadless"],
                capture_output=True,
                timeout=3,
                check=False,
            )
            installed = proc.returncode == 0 or "not found" not in (proc.stderr or b"").decode(
                "utf-8", errors="replace"
            ).lower()
        except Exception:
            installed = False
        if installed:
            available.append({"name": name, "command": cmd[0]})
    return available


def verb_decompile(args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    path = _resolve_path(args.get("path"))
    if not path.is_file():
        raise FileNotFoundError(path)
    target = str(args.get("function") or args.get("addr") or "").strip()
    backends = _probe_decompilers()
    if not backends:
        return {
            "path": str(path),
            "function": target,
            "backend": None,
            "available": False,
            "hint": "no headless decompiler found (ghidra/ida/rizin/r2); connect via MCP for decompilation",
        }
    chosen = backends[0]
    return {
        "path": str(path),
        "function": target or None,
        "backend": chosen["name"],
        "available": True,
        "hint": f"call {chosen['command']} via MCP with target='{path}' function='{target}'",
        "backends_available": [item["name"] for item in backends],
    }


_register(
    VerbSpec(
        "re.triage",
        "Return JSON triage (arch, language, packer indicators, stripped/PDB, sections, entropy samples).",
        ("read_only",),
        ("path",),
        verb_triage,
        category="reverse",
    )
)
_register(
    VerbSpec(
        "re.strings",
        "Filter printable strings from a binary with min length, contains, exclude, and count caps.",
        ("read_only",),
        ("path",),
        verb_strings,
        category="reverse",
    )
)
_register(
    VerbSpec(
        "re.functions",
        "List defined/external symbols with optional name pattern.",
        ("read_only",),
        ("path",),
        verb_functions,
        category="reverse",
    )
)
_register(
    VerbSpec(
        "re.detect_packer",
        "Return packer name, confidence, indicator strings, and overall entropy.",
        ("read_only",),
        ("path",),
        verb_detect_packer,
        category="reverse",
    )
)
_register(
    VerbSpec(
        "re.diff_against",
        "Diff symbols + size + sha256 of two binaries (target vs baseline).",
        ("read_only",),
        ("baseline_path", "path"),
        verb_diff_against,
        category="reverse",
    )
)
_register(
    VerbSpec(
        "re.decompile",
        "Probe headless decompilers and report which backend to dispatch to (via MCP).",
        ("read_only",),
        ("path",),
        verb_decompile,
        category="reverse",
    )
)
