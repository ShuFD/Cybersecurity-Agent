"""Pwn atomic primitives.

Each verb returns structured JSON describing one observation about a
binary or a libc.  Long pwn sessions (leak -> control -> ROP -> exec)
should use the `pwn.open_session` recorder rather than chaining verbs,
because their failure modes are not atomically attributable to a single
action.
"""

from __future__ import annotations

import hashlib
import os
import re
import struct
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ._spec import VerbSpec


PWN_VERBS: Dict[str, VerbSpec] = {}


def _register(spec: VerbSpec) -> VerbSpec:
    PWN_VERBS[spec.name] = spec
    return spec


MAX_DISASM_LINES = 400
MAX_GADGETS = 200
MAX_FUNCTIONS = 400
SECRET_ARG_KEYS = {"payload", "flag_input", "cookie"}
ELF_HEADER_BYTES = 16
SAFE_BIN_LIMIT = 64 * 1024 * 1024


# --------------------------------------------------------------------------- #
# inspect_binary / checksec
# --------------------------------------------------------------------------- #


def _resolve_path(value: Any) -> Path:
    path = Path(str(value or "")).expanduser()
    if not path.is_absolute():
        path = (Path.cwd() / path).resolve()
    return path


def _safe_run(cmd: List[str], *, timeout: float = 8.0, max_bytes: int = 2_000_000) -> Dict[str, Any]:
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            timeout=timeout,
            check=False,
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


def _looks_like_elf(data: bytes) -> Optional[Dict[str, Any]]:
    if len(data) < 52 or data[:4] != b"\x7fELF":
        return None
    ei_class = data[4]
    ei_data = data[5]
    if ei_class not in (1, 2) or ei_data not in (1, 2):
        return None
    bits = 32 if ei_class == 1 else 64
    endian = "<" if ei_data == 1 else ">"
    fmt = f"{endian}16sHHI{ 'Q' if bits == 64 else 'I' }QQ"
    try:
        size = struct.calcsize(fmt)
        (_, _, machine, _, _, _, _) = struct.unpack(fmt, data[:size])
    except Exception:
        return None
    return {
        "bits": bits,
        "endian": endian,
        "machine": int(machine),
        "machine_name": _machine_name(machine),
    }


def _elf_program_headers(data: bytes, header: Dict[str, Any]) -> List[Dict[str, Any]]:
    endian = header["endian"]
    bits = header["bits"]
    if len(data) < 52:
        return []
    e_phdr_off_size = struct.calcsize(f"{endian}QQHH")
    e_phoff, _, e_phentsize, e_phnum = struct.unpack(
        f"{endian}QQHH", data[32 : 32 + e_phdr_off_size]
    )
    out: List[Dict[str, Any]] = []
    for idx in range(e_phnum):
        offset = e_phoff + idx * e_phentsize
        if offset + e_phentsize > len(data):
            break
        # 32-bit phdrs only need p_type(4)+p_flags(4); 64-bit phdr may include
        # PF_X in p_flags too.
        phdr_fmt = f"{endian}II"
        phdr_size = struct.calcsize(phdr_fmt)
        if e_phentsize < phdr_size:
            continue
        try:
            p_type, p_flags = struct.unpack(phdr_fmt, data[offset : offset + phdr_size])
        except struct.error:
            continue
        if p_type in (0x6474E550, 0x6474E551):  # PT_GNU_STACK, PT_GNU_RELRO
            out.append(
                {
                    "index": idx,
                    "p_type": int(p_type),
                    "name": "GNU_STACK" if p_type == 0x6474E551 else "GNU_RELRO",
                    "flags": int(p_flags),
                    "executable": bool(p_flags & 1),
                }
            )
    return out


def _machine_name(value: int) -> str:
    mapping = {
        0x03: "x86",
        0x3E: "x86_64",
        0x28: "arm",
        0xB7: "aarch64",
        0x08: "mips",
        0x14: "ppc",
        0x16: "s390",
        0xF3: "riscv64",
    }
    return mapping.get(int(value), f"unknown(0x{int(value):x})")


def _elf_program_headers(data: bytes, header: Dict[str, Any]) -> List[Dict[str, Any]]:
    return []  # legacy placeholder, see the new implementation above


def _checksec_symbols(path: Path) -> Dict[str, bool]:
    canary = False
    fortify = False
    pie = False
    rpath = False
    bind_now = False
    nm_proc = subprocess.run(
        ["nm", "-D", "--defined-only", str(path)],
        capture_output=True,
        timeout=4,
        check=False,
    )
    dyn_text = (nm_proc.stdout or b"").decode("utf-8", errors="replace")
    if "__stack_chk_fail" in dyn_text:
        canary = True
    if "_chk@" in dyn_text or "__stack_chk_guard" in dyn_text:
        fortify = True

    nm_all = subprocess.run(
        ["nm", "--defined-only", str(path)],
        capture_output=True,
        timeout=4,
        check=False,
    )
    all_text = (nm_all.stdout or b"").decode("utf-8", errors="replace")
    if not re.search(r"^\s*\S+\s+[Tt]\s+\S+", all_text, flags=re.M):
        pie = True
    if " RPATH" in all_text or " RUNPATH" in all_text:
        rpath = True

    readelf_proc = subprocess.run(
        ["readelf", "-d", str(path)],
        capture_output=True,
        timeout=4,
        check=False,
    )
    dyn_dump = (readelf_proc.stdout or b"").decode("utf-8", errors="replace")
    if "BIND_NOW" in dyn_dump or "(FLAGS)" in dyn_dump and "BIND_NOW" in dyn_dump:
        bind_now = True
    return {
        "canary": canary,
        "fortify_source": fortify,
        "pie_text_segment": pie,
        "rpath_runpath": rpath,
        "bind_now": bind_now,
    }


def _probe_protections(path: Path, data: bytes, header: Dict[str, Any]) -> Dict[str, Any]:
    progs = _elf_program_headers(data, header)
    has_stack_nx = False
    has_relro = False
    relro_full_hint = False
    for entry in progs:
        if entry["name"] == "GNU_STACK":
            has_stack_nx = not entry["executable"]
        elif entry["name"] == "GNU_RELRO":
            has_relro = True
    symbols = _checksec_symbols(path)
    return {
        "nx": has_stack_nx,
        "pie": header["bits"] == 64 and symbols["pie_text_segment"],
        "relro": ("Full" if has_relro and symbols["bind_now"] else "Partial") if has_relro else "None",
        "canary": symbols["canary"],
        "fortify": symbols["fortify_source"],
        "rpath_runpath": symbols["rpath_runpath"],
    }


def _libc_candidates(path: Path) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    if not path.is_symlink() and not path.exists():
        return out
    try:
        if path.is_symlink():
            resolved = path.resolve()
            out.append({"path": str(resolved), "via": "symlink"})
        ldd = subprocess.run(
            ["ldd", str(path)],
            capture_output=True,
            timeout=4,
            check=False,
        )
        text = (ldd.stdout or b"").decode("utf-8", errors="replace")
        for match in re.finditer(r"(\S+)\s+=>\s+(\S+)", text):
            libc = match.group(2)
            if "libc" in libc and "ld-linux" not in libc:
                out.append({"path": libc, "via": "ldd"})
    except Exception:
        pass
    return out[:6]


def verb_inspect_binary(args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    path = _resolve_path(args.get("path"))
    if not path.is_file():
        raise FileNotFoundError(path)
    if path.stat().st_size > SAFE_BIN_LIMIT:
        raise ValueError(f"binary too large: {path.stat().st_size} bytes")
    data = path.read_bytes()
    sha256 = hashlib.sha256(data).hexdigest()
    magic = _safe_run(["file", "-b", str(path)])
    elf = _looks_like_elf(data)
    protections = _probe_protections(path, data, elf) if elf else {}
    libc = _libc_candidates(path) if (elf and os.access(str(path), os.X_OK)) else []
    arch = elf["machine_name"] if elf else magic["stdout"].strip() or "unknown"
    bits = elf["bits"] if elf else None
    return {
        "path": str(path),
        "size": len(data),
        "sha256": sha256,
        "arch": arch,
        "bits": bits,
        "file_output": magic["stdout"].strip(),
        "protections": protections,
        "libc_candidates": libc,
        "entry_recommendation": ("pwn.find_gadgets" if elf else "re.triage"),
    }


def verb_checksec(args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    path = _resolve_path(args.get("path"))
    if not path.is_file():
        raise FileNotFoundError(path)
    data = path.read_bytes()
    elf = _looks_like_elf(data)
    if not elf:
        return {
            "path": str(path),
            "arch": "unknown",
            "error": "not an ELF binary; checksec is only meaningful for ELF",
        }
    return {
        "path": str(path),
        "arch": elf["machine_name"],
        "bits": elf["bits"],
        "protections": _probe_protections(path, data, elf),
    }


_register(
    VerbSpec(
        "pwn.inspect_binary",
        "Return JSON describing an ELF binary: arch, bits, protections, libc candidates, sha256.",
        ("read_only",),
        ("path",),
        verb_inspect_binary,
        category="pwn",
    )
)
_register(
    VerbSpec(
        "pwn.checksec",
        "Return the binary's NX/PIE/RELRO/canary/FORTIFY flags without verbose readelf dump.",
        ("read_only",),
        ("path",),
        verb_checksec,
        category="pwn",
    )
)


# --------------------------------------------------------------------------- #
# identify_libc / glibc_offsets
# --------------------------------------------------------------------------- #


# Bundled offsets for a handful of common glibc versions.  This is a
# deliberate stub: real lookups should call into a libc-database service
# or an offline index.  Add rows here as new versions become relevant.
GLIBC_OFFSETS: Dict[str, Dict[str, int]] = {
    "2.23": {"system": 0x45390, "str_bin_sh": 0x18cd57, "dup2": 0xf7670, "open": 0x10fc40},
    "2.27": {"system": 0x4f440, "str_bin_sh": 0x1b3e9a, "dup2": 0x110070, "open": 0x10fc40},
    "2.31": {"system": 0x55410, "str_bin_sh": 0x1b75aa, "dup2": 0x111130, "open": 0x111130 // 4},
    "2.35": {"system": 0x50d60, "str_bin_sh": 0x1d8698, "dup2": 0x114980, "open": 0x114ab0},
}


def _parse_int(value: Any, base: int = 16) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, int):
        return value
    try:
        return int(str(value), 0 if str(value).startswith(("0x", "0X")) else base)
    except Exception:
        return None


def verb_identify_libc(args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    leaks = args.get("leaks") or []
    if not isinstance(leaks, list):
        raise ValueError("leaks must be a list of {name, address} entries")
    versions: Dict[str, List[Dict[str, Any]]] = {}
    for entry in leaks:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        address = _parse_int(entry.get("address"))
        if not name or address is None:
            continue
        for version, table in GLIBC_OFFSETS.items():
            offset = table.get(name)
            if offset is None:
                continue
            base = address - offset
            if base < 0 or (base & 0xFFF) != 0:
                continue
            versions.setdefault(version, []).append(
                {"name": name, "address": address, "offset": offset, "libc_base": base}
            )
    ranked = sorted(
        (
            {
                "version": version,
                "confidence": len(matches) / max(1, len(leaks)),
                "matches": matches,
            }
            for version, matches in versions.items()
        ),
        key=lambda item: (-item["confidence"], item["version"]),
    )
    return {
        "leaks": leaks,
        "candidates": ranked[:5],
        "known_versions": sorted(GLIBC_OFFSETS.keys()),
    }


def verb_glibc_offsets(args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    version = str(args.get("version") or "").strip()
    table = GLIBC_OFFSETS.get(version)
    if not table:
        return {
            "version": version,
            "error": "unknown version",
            "known_versions": sorted(GLIBC_OFFSETS.keys()),
        }
    return {"version": version, "offsets": dict(table)}


_register(
    VerbSpec(
        "pwn.identify_libc",
        "Given leaked function addresses, list candidate glibc versions and bases from a bundled offset table.",
        ("read_only",),
        ("leaks",),
        verb_identify_libc,
        category="pwn",
    )
)
_register(
    VerbSpec(
        "pwn.glibc_offsets",
        "Look up bundled offsets (system, str_bin_sh, dup2, open) for a known glibc version.",
        ("read_only",),
        ("version",),
        verb_glibc_offsets,
        category="pwn",
    )
)


# --------------------------------------------------------------------------- #
# find_gadgets
# --------------------------------------------------------------------------- #


def _normalize_gadget_instruction(line: str) -> str:
    line = re.sub(r"\s+", " ", line.strip())
    return line.rstrip(";").strip()


def verb_find_gadgets(
    args: Dict[str, Any], context: Dict[str, Any]
) -> Dict[str, Any]:
    path = _resolve_path(args.get("path"))
    if not path.is_file():
        raise FileNotFoundError(path)
    try:
        max_gadgets = max(1, min(int(args.get("max") or 40), MAX_GADGETS))
    except Exception:
        max_gadgets = 40
    kind = str(args.get("kind") or "ret").lower()
    if kind not in {"ret", "pop", "syscall", "one_gadget"}:
        kind = "ret"

    disasm_run = _safe_run(
        ["objdump", "-d", "-M", "intel", "--no-show-raw-insn", str(path)],
        timeout=20,
    )
    if disasm_run["status"] != "ok":
        return {
            "path": str(path),
            "kind": kind,
            "gadgets": [],
            "error": disasm_run.get("error") or disasm_run.get("stderr", "").strip()[:500],
        }
    text = disasm_run["stdout"]

    gadgets: List[Dict[str, Any]] = []
    current: List[Tuple[str, str]] = []  # [(addr_hex, instruction)]
    function_hint = ""
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line:
            continue
        m = re.match(r"^([0-9a-f]+) <([^+>!]+)>", line)
        if m:
            function_hint = m.group(2)
            current = []
            continue
        insn_match = re.match(r"^\s*([0-9a-f]+):\s+(.+)$", line)
        if not insn_match:
            continue
        addr, insn = insn_match.groups()
        insn = _normalize_gadget_instruction(insn)
        low = insn.lower()
        if kind == "ret":
            if low == "ret":
                current.append((addr, insn))
                snippets = current[-3:]
                gadgets.append(
                    {
                        "addr": "0x" + snippets[0][0],
                        "instructions": [item[1] for item in snippets],
                        "function_hint": function_hint,
                        "kind": "ret",
                    }
                )
                current = []
            elif low.startswith(("pop", "mov", "xor", "sub", "add", "lea", "xchg", "and", "or")):
                current.append((addr, insn))
                if len(current) > 6:
                    current = current[-3:]
            else:
                current = []
        elif kind == "pop":
            if low == "ret":
                snippet = current[-4:] + [(addr, insn)]
                gadgets.append(
                    {
                        "addr": "0x" + (snippet[0][0] if snippet else "0"),
                        "instructions": [item[1] for item in snippet],
                        "function_hint": function_hint,
                        "kind": "pop_ret",
                    }
                )
                current = []
            elif low.startswith("pop"):
                current.append((addr, insn))
            else:
                current = []
        elif kind == "syscall":
            if "syscall" in low:
                snippet = current[-2:] + [(addr, insn)]
                gadgets.append(
                    {
                        "addr": "0x" + (snippet[0][0] if snippet else "0"),
                        "instructions": [item[1] for item in snippet],
                        "function_hint": function_hint,
                        "kind": "syscall",
                    }
                )
                current = []
            elif low.startswith(("pop", "mov", "xor", "lea", "and", "or")):
                current.append((addr, insn))
                if len(current) > 4:
                    current = current[-2:]
            else:
                current = []
        else:  # one_gadget placeholder — never satisfied locally.
            continue
        if len(gadgets) >= max_gadgets:
            break

    return {
        "path": str(path),
        "kind": kind,
        "gadgets": gadgets[:max_gadgets],
        "gadget_count": len(gadgets[:max_gadgets]),
    }


def verb_disasm(args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    path = _resolve_path(args.get("path"))
    if not path.is_file():
        raise FileNotFoundError(path)
    function = str(args.get("function") or "").strip()
    try:
        max_lines = max(20, min(int(args.get("max_lines") or 80), MAX_DISASM_LINES))
    except Exception:
        max_lines = 80
    cmd = ["objdump", "-d", "-M", "intel", "--no-show-raw-insn", str(path)]
    if function:
        cmd.insert(-2, f"--disassemble={function}")
    run = _safe_run(cmd, timeout=20, max_bytes=4_000_000)
    if run["status"] != "ok":
        return {
            "path": str(path),
            "function": function,
            "text": "",
            "error": run.get("error") or run.get("stderr", "")[:500],
        }
    lines = run["stdout"].splitlines()
    return {
        "path": str(path),
        "function": function or None,
        "text": "\n".join(lines[:max_lines]),
        "line_count": min(len(lines), max_lines),
        "truncated": len(lines) > max_lines,
    }


_register(
    VerbSpec(
        "pwn.find_gadgets",
        "Scan a binary for ROP/syscall gadgets by parsing objdump output. No capstone required.",
        ("read_only",),
        ("path",),
        verb_find_gadgets,
        category="pwn",
    )
)
_register(
    VerbSpec(
        "pwn.disasm",
        "Return an objdump snippet for a function name or symbol.",
        ("read_only",),
        ("path",),
        verb_disasm,
        category="pwn",
    )
)


# --------------------------------------------------------------------------- #
# cyclic_offset
# --------------------------------------------------------------------------- #


def _de_bruijn(alphabet: str, length: int) -> str:
    """Return the first `length` characters of a De Bruijn sequence.

    Uses the iterative "necklaces/ Lyndon words" algorithm so we never
    recurse beyond `n` (word-size). Default word-size is 4 because the
    caller only reads 4 bytes back out of the cyclic pattern.
    """
    if length <= 0 or len(alphabet) < 2:
        return ""
    k = len(alphabet)
    n = 4
    a = [0] * (k * n)
    sequence: List[str] = []
    alphabet_chars = list(alphabet)

    def db(t: int, p: int) -> None:
        if len(sequence) >= length:
            return
        if t > n:
            if n % p == 0:
                for j in range(1, p + 1):
                    sequence.append(alphabet_chars[a[j]])
                    if len(sequence) >= length:
                        return
            return
        if t <= p:
            a[t] = 0
            db(t + 1, p)
        else:
            a[t] = a[t - p]
            db(t + 1, p)
            if len(sequence) >= length:
                return
        for j in range(a[t - p if t > p else 1] + 1, k):
            a[t] = j
            db(t + 1, t)
            if len(sequence) >= length:
                return

    db(1, 1)
    return "".join(sequence[:length])


def _parse_cyclic_value(value: Any) -> Optional[int]:
    if isinstance(value, int):
        return value
    if isinstance(value, bytes):
        try:
            return int.from_bytes(value, "little", signed=False)
        except Exception:
            return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if text.lower().startswith("0x"):
            return _parse_int(text)
        # 4-char ASCII printable strings (e.g. "jaaa") map cleanly to
        # little-endian 32-bit integers — useful for the typical crash register
        # captured in gdb.
        if len(text) == 4 and all(c.isprintable() for c in text):
            try:
                return int.from_bytes(text.encode("latin-1"), "little")
            except Exception:
                pass
        # 8 hex chars → 32-bit value.
        stripped = re.sub(r"^0x", "", text.lower())
        if len(stripped) == 8 and re.fullmatch(r"[0-9a-f]+", stripped):
            try:
                return int.from_bytes(bytes.fromhex(stripped), "little")
            except Exception:
                pass
        try:
            return int(text)
        except Exception:
            return None
    return None


def verb_cyclic_offset(args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    try:
        length = max(64, min(int(args.get("length") or 4096), 65536))
    except Exception:
        length = 4096
    alphabet = str(args.get("alphabet") or "abcdefghijklmnopqrstuvwxyz")
    if not alphabet or len(set(alphabet)) < 2:
        alphabet = "abcdefghijklmnopqrstuvwxyz"

    value = _parse_cyclic_value(args.get("value"))
    if value is None:
        return {
            "pattern": _de_bruijn(alphabet, length),
            "length": length,
            "alphabet": alphabet,
            "offset": None,
        }

    sequence = _de_bruijn(alphabet, length)
    # The agent typically feeds the crash-time value (8-byte register read);
    # we probe the lower 32 bits both little- and big-endian.
    candidate_values = []
    truncated = value & 0xFFFFFFFF
    candidate_values.append(("little", truncated.to_bytes(4, "little")))
    candidate_values.append(("big", truncated.to_bytes(4, "big")))
    offset = -1
    endian = "unknown"
    for candidate_endian, needle_bytes in candidate_values:
        needle = needle_bytes.decode("latin-1")
        idx = sequence.find(needle)
        if idx >= 0:
            offset = idx
            endian = candidate_endian
            break
    return {
        "pattern": sequence,
        "length": length,
        "alphabet": alphabet,
        "value": f"0x{value:x}",
        "value_truncated_32": f"0x{truncated:08x}",
        "value_endian": endian if offset >= 0 else None,
        "offset": offset if offset >= 0 else None,
    }


_register(
    VerbSpec(
        "pwn.cyclic_offset",
        "Generate a De Bruijn pattern and (optionally) locate a 4-byte crash value's offset within it. No pwntools needed.",
        ("read_only",),
        (),
        verb_cyclic_offset,
        category="pwn",
    )
)
