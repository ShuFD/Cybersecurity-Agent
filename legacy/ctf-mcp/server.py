#!/usr/bin/env python3
"""CTF MCP Toolbox Server — exposes CTF tools via Model Context Protocol.

Usage (stdio):
    python3 server.py

Environment:
    CTF_WORKDIR  path to the working directory (default: /work)
    WINEPREFIX   Wine prefix for Windows PE analysis
    WINEARCH     Wine architecture (win32/win64)
    WINEDEBUG    Wine debug level
"""

import argparse
import base64
import binascii
import hashlib
import io
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("ctf-toolbox-mcp")


def _path_entries_from_env(name: str, defaults: List[str]) -> List[str]:
    raw = os.environ.get(name)
    if raw is None:
        return defaults
    return [part for part in raw.split(os.pathsep) if part]


def _resolve_path(path: Union[str, Path]) -> Path:
    return Path(path).expanduser().resolve(strict=False)


WORKDIR = _resolve_path(os.environ.get("CTF_WORKDIR", "/work"))
HOST_WORKDIRS = tuple(
    _resolve_path(path)
    for path in _path_entries_from_env(
        "CTF_HOST_WORKDIRS",
        [
            "/work",
        ],
    )
)
ALLOWED_PATH_ROOTS = tuple(
    _resolve_path(path)
    for path in [str(WORKDIR), os.environ.get("CTF_TMPDIR", "/tmp")]
    + _path_entries_from_env("CTF_ALLOWED_ROOTS", [])
    if path
)
MAX_UPLOAD_BYTES = 50 * 1024 * 1024


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the CTF MCP toolbox server.")
    parser.add_argument(
        "--transport",
        choices=("stdio", "sse", "streamable-http"),
        default=os.environ.get("CTF_MCP_TRANSPORT", "stdio"),
        help="MCP transport to use. Defaults to stdio.",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("CTF_MCP_HOST", "127.0.0.1"),
        help="Host for sse or streamable-http transports.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("CTF_MCP_PORT", "8000")),
        help="Port for sse or streamable-http transports.",
    )
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> None:
    args = parse_args(argv)
    if args.transport in {"sse", "streamable-http"}:
        mcp.settings.host = args.host
        mcp.settings.port = args.port
    mcp.run(transport=args.transport)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _as_args(args: Optional[Union[str, List[Any]]]) -> List[str]:
    if args is None:
        return []
    if isinstance(args, str):
        return shlex.split(args)
    return [str(x) for x in args]


def _relative_to(path: Path, root: Path) -> Optional[Path]:
    try:
        return path.relative_to(root)
    except ValueError:
        return None


def _map_host_workdir_path(path: Path) -> Optional[Path]:
    if not path.is_absolute():
        return None
    resolved = _resolve_path(path)
    for host_root in HOST_WORKDIRS:
        relative = _relative_to(resolved, host_root)
        if relative is not None:
            return _resolve_path(WORKDIR / relative)
    return None


def _is_allowed_path(path: Path) -> bool:
    return any(_relative_to(path, root) is not None for root in ALLOWED_PATH_ROOTS)


def _safe_path(path: Union[str, Path]) -> Path:
    if path is None or not str(path).strip():
        raise ValueError("missing path")
    candidate = Path(str(path)).expanduser()
    mapped = _map_host_workdir_path(candidate)
    if mapped is not None:
        rp = mapped
    elif candidate.is_absolute():
        rp = _resolve_path(candidate)
    else:
        rp = _resolve_path(WORKDIR / candidate)
    if not _is_allowed_path(rp):
        allowed = ", ".join(str(root) for root in ALLOWED_PATH_ROOTS)
        host_roots = ", ".join(str(root) for root in HOST_WORKDIRS)
        raise ValueError(
            f"path outside allowed CTF roots is blocked: {rp}; "
            f"allowed roots: {allowed}; host workdir mappings: {host_roots}"
        )
    return rp


def _require_file(path: Union[str, Path]) -> Path:
    """Resolve a path and raise FileNotFoundError with diagnostics."""
    p = _safe_path(path)
    if not p.exists():
        parent = p.parent
        siblings = ""
        if parent.exists() and parent.is_dir():
            try:
                entries = sorted(
                    [e.name for e in parent.iterdir()],
                    key=lambda x: (not Path(parent, x).is_dir(), x),
                )[:40]
                siblings = f"  Contents of {parent}/:\n    " + "\n    ".join(entries)
            except Exception:
                siblings = f"  (cannot list {parent})"
        else:
            siblings = f"  Parent directory does not exist: {parent}"
        msg = f"File not found: {p}\n{siblings}"
        raise FileNotFoundError(msg)
    return p


def _safe_cwd(cwd: Optional[str]) -> Path:
    return _safe_path(cwd) if cwd else WORKDIR


def _coalesce_path(*values: Optional[str]) -> str:
    for value in values:
        if value is not None and str(value).strip():
            return str(value)
    raise ValueError("missing path; use path, file, filename, file_path, or target")


def _looks_like_url(value: str) -> bool:
    return bool(re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", value))


def _rewrite_path_arg(value: str) -> str:
    if not value or _looks_like_url(value):
        return value
    prefix = ""
    body = value
    if body.startswith("@") and len(body) > 1:
        prefix, body = "@", body[1:]
    if body.startswith("-") and "=" in body:
        option, option_value = body.split("=", 1)
        if option_value.startswith(("/", "~")):
            return f"{prefix}{option}={_safe_path(option_value)}"
        return value
    if body.startswith(("/", "~")):
        return prefix + str(_safe_path(body))
    return value


def _rewrite_command_paths(args: List[str]) -> List[str]:
    if not args:
        return args
    return [args[0], *(_rewrite_path_arg(arg) for arg in args[1:])]


def _decode(data: bytes, limit: int = 320000) -> str:
    text = data.decode("utf-8", errors="replace")
    if len(text) > limit:
        return text[:limit] + f"\n...[truncated {len(text) - limit} chars]"
    return text


def _run(
    cmd: List[str],
    timeout: int = 30,
    cwd: Optional[Path] = None,
    env: Optional[Dict[str, str]] = None,
    cap: int = 320000,
) -> Dict[str, Any]:
    timeout = max(1, min(int(timeout), 900))
    run_env = os.environ.copy()
    if env:
        run_env.update({str(k): str(v) for k, v in env.items()})
    try:
        p = subprocess.run(
            cmd,
            cwd=str(cwd or WORKDIR),
            env=run_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
        return {
            "cmd": shlex.join(cmd),
            "cwd": str(cwd or WORKDIR),
            "exit_code": p.returncode,
            "stdout": _decode(p.stdout, cap),
            "stderr": _decode(p.stderr, cap),
            "timed_out": False,
        }
    except subprocess.TimeoutExpired as e:
        return {
            "cmd": shlex.join(cmd),
            "cwd": str(cwd or WORKDIR),
            "exit_code": None,
            "stdout": _decode(e.stdout or b"", cap),
            "stderr": _decode(e.stderr or b"", cap) + f"\n[TIMEOUT after {timeout}s]",
            "timed_out": True,
        }
    except FileNotFoundError:
        return {
            "cmd": shlex.join(cmd),
            "cwd": str(cwd or WORKDIR),
            "exit_code": 127,
            "stdout": "",
            "stderr": f"executable not found in PATH: {cmd[0]}",
            "timed_out": False,
        }


def _file_info(path: Path) -> str:
    res = _run(["file", "-b", str(path)], timeout=5, cwd=path.parent, cap=8000)
    return (res.get("stdout") or "").strip()


def _detect_arch(info: str) -> str:
    s = info.lower()
    if "x86-64" in s or "x86_64" in s:
        return "x86_64"
    if "80386" in s or "i386" in s:
        return "i386"
    if "aarch64" in s or ("arm" in s and "64-bit" in s):
        return "aarch64"
    if "arm" in s:
        return "arm"
    if "mips" in s and "lsb" in s:
        return "mipsel"
    if "mips" in s:
        return "mips"
    if "risc-v" in s or "riscv" in s:
        return "riscv64"
    return "native"


QEMU_USER = {
    "aarch64": ("/usr/bin/qemu-aarch64-static", "/usr/aarch64-linux-gnu"),
    "arm": ("/usr/bin/qemu-arm-static", "/usr/arm-linux-gnueabihf"),
    "armhf": ("/usr/bin/qemu-arm-static", "/usr/arm-linux-gnueabihf"),
    "mips": ("/usr/bin/qemu-mips-static", None),
    "mipsel": ("/usr/bin/qemu-mipsel-static", None),
    "riscv64": ("/usr/bin/qemu-riscv64-static", None),
}

QEMU_SYSTEM = {
    "x86_64": "/usr/bin/qemu-system-x86_64",
    "i386": "/usr/bin/qemu-system-i386",
    "arm": "/usr/bin/qemu-system-arm",
    "aarch64": "/usr/bin/qemu-system-aarch64",
}

ALLOWED_TOOLS = {
    "python", "python3", "sage", "sage-python",
    "bash", "sh", "env", "which", "true", "false",
    "file", "strings", "xxd", "hexdump", "readelf", "objdump", "objcopy", "strip", "nm", "ldd",
    "sha1sum", "sha256sum", "md5sum", "stat", "du", "wc",
    "ls", "cp", "mv", "mkdir", "rm", "cat", "head", "tail", "touch", "chmod",
    "grep", "egrep", "fgrep", "sed", "awk", "sort", "uniq", "cut", "tr", "tee",
    "find", "realpath", "readlink",
    "tar", "gzip", "gunzip", "xz", "unxz", "bzip2", "bunzip2", "zip", "unzip",
    "curl", "wget", "nc", "ncat", "netcat", "socat",
    "make", "gcc", "g++", "cc", "rustc", "cargo", "node", "npm", "perl", "php",
    "openssl", "sqlite3",
    "checksec", "ROPgadget", "ropper", "one_gadget",
    "r2", "radare2", "gdb", "gdb-multiarch", "pwndbg-gdb",
    "avr-objdump", "avr-gdb", "simavr",
    "tshark", "capinfos", "dumpcap", "mergecap", "editcap", "text2pcap",
    "binwalk", "exiftool", "foremost", "scalpel", "steghide", "pngcheck",
    "zbarimg", "zsteg", "vol", "volatility3", "yara",
    "7z", "7zz", "convert", "tesseract", "ruby",
    "wine", "qemu-aarch64-static", "qemu-arm-static", "qemu-mips-static",
    "qemu-mipsel-static", "qemu-riscv64-static",
}


# ── MCP Tools ────────────────────────────────────────────────────────────────

@mcp.tool()
def command_exists(names: Union[str, List[str]]) -> Dict[str, Optional[str]]:
    """Check whether commands exist in PATH."""
    return {name: shutil.which(name) for name in _as_args(names)}


@mcp.tool()
def identify_file(
    path: str = "",
    file: str = "",
    filename: str = "",
    file_path: str = "",
    target: str = "",
) -> Dict[str, Any]:
    """Identify a challenge file with file(1), sha256sum, and size metadata."""
    p = _require_file(_coalesce_path(path, file, filename, file_path, target))
    return {
        "path": str(p),
        "size": p.stat().st_size,
        "file": _file_info(p),
        "sha256": _run(["sha256sum", str(p)], timeout=5, cwd=p.parent,
                        cap=2000)["stdout"].strip(),
    }


@mcp.tool()
def upload_image(
    b64_data: str,
    filename: str = "",
    overwrite: bool = False,
) -> Dict[str, Any]:
    """Upload a base64-encoded image into the CTF working directory."""
    data = str(b64_data or "").strip()
    if data.startswith("data:"):
        if "," not in data:
            raise ValueError("malformed data URL: missing comma separator")
        data = data.split(",", 1)[1]
    encoded = re.sub(r"\s+", "", data)
    max_encoded_size = ((MAX_UPLOAD_BYTES + 2) // 3) * 4
    if not encoded:
        raise ValueError("empty base64 data")
    if len(encoded) > max_encoded_size:
        raise ValueError(f"encoded image exceeds the {MAX_UPLOAD_BYTES}-byte limit")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError(f"invalid base64 data: {error}") from error
    if len(raw) > MAX_UPLOAD_BYTES:
        raise ValueError(f"image too large ({len(raw)} bytes, max {MAX_UPLOAD_BYTES})")

    image_format = "UNKNOWN"
    width: Optional[int] = None
    height: Optional[int] = None
    try:
        from PIL import Image as PILImage

        with PILImage.open(io.BytesIO(raw)) as image:
            image_format = image.format or "UNKNOWN"
            width, height = image.size
    except Exception:
        pass

    name = str(filename or "").strip()
    if not name:
        extension = {
            "PNG": ".png",
            "JPEG": ".jpg",
            "GIF": ".gif",
            "BMP": ".bmp",
            "WEBP": ".webp",
        }.get(image_format.upper(), ".png")
        name = f"uploaded_image_{int(time.time() * 1000)}{extension}"
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
        raise ValueError("filename contains invalid characters; only [A-Za-z0-9_.-] allowed")

    destination = _safe_path(name)
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with destination.open("wb" if overwrite else "xb") as output:
            output.write(raw)
    except FileExistsError as error:
        raise FileExistsError(f"{destination} exists; use overwrite=True to replace") from error

    return {
        "path": str(destination),
        "size": len(raw),
        "format": image_format,
        "width": width,
        "height": height,
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


@mcp.tool()
def run_ctf_tool(
    argv: Optional[Union[str, List[Any]]] = None,
    timeout: int = 30,
    cwd: Optional[str] = None,
    command: Optional[Union[str, List[Any]]] = None,
    cmd: Optional[Union[str, List[Any]]] = None,
    args: Optional[Union[str, List[Any]]] = None,
    tool: str = "",
) -> Dict[str, Any]:
    """Run an allowlisted CTF tool. Accepts argv, cmd, command, or tool plus args."""
    raw_argv = argv if argv is not None else command if command is not None else cmd
    if raw_argv is not None:
        command_args = _as_args(raw_argv)
    elif tool:
        command_args = [str(tool), *_as_args(args)]
    else:
        command_args = _as_args(args)
    if not command_args:
        raise ValueError("empty argv")
    exe = Path(command_args[0]).name
    if exe not in ALLOWED_TOOLS:
        raise ValueError(f"tool not allowlisted: {exe}")
    return _run(
        _rewrite_command_paths(command_args),
        timeout=timeout,
        cwd=_safe_cwd(cwd),
        cap=640000,
    )


@mcp.tool()
def checksec_file(
    path: str = "",
    file: str = "",
    filename: str = "",
    file_path: str = "",
    target: str = "",
) -> Dict[str, Any]:
    """Run checksec on an ELF file."""
    p = _require_file(_coalesce_path(path, file, filename, file_path, target))
    return _run(["checksec", "--file", str(p)], timeout=10, cwd=p.parent, cap=16000)


@mcp.tool()
def run_linux_elf(
    path: str,
    args: Optional[Union[str, List[str]]] = None,
    arch: str = "auto",
    timeout: int = 10,
) -> Dict[str, Any]:
    """Run a Linux ELF natively or under qemu-user-static.

    Supports x86_64/i386/aarch64/arm/mips/mipsel/riscv64.
    """
    p = _require_file(path)
    info = _file_info(p)
    if "ELF" not in info:
        return {
            "status": "error",
            "error": f"Not an ELF file: {info}",
            "detected_file": info,
            "selected_arch": None,
        }

    selected = arch if arch != "auto" else _detect_arch(info)

    if selected == "native" or selected == "x86_64":
        p.chmod(p.stat().st_mode | 0o111)
        cmd = [str(p)] + _as_args(args)
        return _run(cmd, timeout=timeout, cwd=p.parent, cap=640000)

    if selected not in QEMU_USER:
        return {
            "status": "error",
            "error": f"unsupported arch: {selected}; file info: {info}",
            "detected_file": info,
            "selected_arch": selected,
        }

    qemu, sysroot = QEMU_USER[selected]
    cmd = [qemu]
    if sysroot and Path(sysroot).exists():
        cmd += ["-L", sysroot]
    cmd += [str(p)] + _as_args(args)
    return _run(cmd, timeout=timeout, cwd=p.parent, env={"CTF_WORKDIR": str(WORKDIR)},
                cap=640000)


@mcp.tool()
def qemu_targets() -> Dict[str, Any]:
    """List installed QEMU user and system emulators."""
    from pathlib import Path
    qemu_user = sorted(str(p) for p in Path("/usr/bin").glob("qemu-*-static"))
    qemu_system = sorted(str(p) for p in Path("/usr/bin").glob("qemu-system-*"))
    return {"qemu_user_static": qemu_user, "qemu_system": qemu_system}


@mcp.tool()
def qemu_system_run(
    arch: str,
    qemu_args: Union[str, List[str]],
    timeout: int = 120,
    allow_network: bool = False,
) -> Dict[str, Any]:
    """Run qemu-system-* for firmware, kernels, ARM boards, Windows/Linux images."""
    if arch not in QEMU_SYSTEM:
        raise ValueError(f"arch must be one of {sorted(QEMU_SYSTEM)}")

    args = _as_args(qemu_args)
    if not allow_network:
        args = ["-nic", "none"] + args
    else:
        args = ["-nic", "user"] + args

    return _run([QEMU_SYSTEM[arch]] + args, timeout=timeout, cwd=WORKDIR, cap=96000)


@mcp.tool()
def run_windows_exe(
    path: str,
    args: Optional[Union[str, List[str]]] = None,
    timeout: int = 30,
) -> Dict[str, Any]:
    """Run a Windows PE challenge with Wine under Xvfb."""
    p = _require_file(path)

    # Check for Xvfb; start if available
    xvfb = shutil.which("Xvfb")
    if xvfb:
        subprocess.run([xvfb, ":99", "-screen", "0", "1024x768x16"],
                       check=False, stderr=subprocess.DEVNULL)
        os.environ.setdefault("DISPLAY", ":99")

    env = {
        "WINEPREFIX": os.environ.get("WINEPREFIX", "/home/ctf/.wine"),
        "WINEARCH": os.environ.get("WINEARCH", "win64"),
        "WINEDEBUG": os.environ.get("WINEDEBUG", "-all"),
        "WINEDLLOVERRIDES": "mscoree,mshtml=",
        "DISPLAY": os.environ.get("DISPLAY", ":99"),
    }
    cmd = ["wine", str(p)] + _as_args(args)
    return _run(cmd, timeout=timeout, cwd=p.parent, env=env, cap=640000)


@mcp.tool()
def gdb_batch(
    path: str,
    commands: Union[str, List[str]],
    args: Optional[Union[str, List[str]]] = None,
    timeout: int = 45,
) -> Dict[str, Any]:
    """Run GDB in batch mode with scripted commands."""
    p = _require_file(path)
    if isinstance(commands, str):
        cmds = [c.strip() for c in re.split(r"[\n;]+", commands) if c.strip()]
    else:
        cmds = [str(c) for c in commands]
    cmd = ["gdb", "-q", "--batch"]
    for c in cmds:
        cmd += ["-ex", c]
    cmd += ["--args", str(p)] + _as_args(args)
    return _run(cmd, timeout=timeout, cwd=p.parent, cap=96000)


@mcp.tool()
def radare2_cmd(
    path: str,
    commands: Optional[List[str]] = None,
    timeout: int = 45,
) -> Dict[str, Any]:
    """Run radare2 read-only analysis commands on a binary."""
    p = _require_file(path)
    cmds = commands or ["aaa", "iI", "afl", "iz"]
    cmd = ["r2", "-q", "-e", "io.cache=true", "-e", "scr.color=false"]
    for c in cmds:
        cmd += ["-c", str(c)]
    cmd += ["-c", "q", str(p)]
    return _run(cmd, timeout=timeout, cwd=p.parent, cap=96000)


@mcp.tool()
def tshark_summary(
    pcap: str,
    display_filter: str = "",
    limit: int = 200,
    timeout: int = 45,
) -> Dict[str, Any]:
    """Summarize packets from a pcap using tshark. display_filter is a Wireshark filter."""
    p = _require_file(pcap)
    limit = max(1, min(int(limit), 20000))
    cmd = [
        "tshark", "-r", str(p), "-c", str(limit),
        "-T", "fields",
        "-e", "frame.number",
        "-e", "frame.time_relative",
        "-e", "_ws.col.Protocol",
        "-e", "ip.src",
        "-e", "ip.dst",
        "-e", "tcp.srcport",
        "-e", "tcp.dstport",
        "-e", "udp.srcport",
        "-e", "udp.dstport",
        "-e", "_ws.col.Info",
    ]
    if display_filter:
        cmd[3:3] = ["-Y", display_filter]
    return _run(cmd, timeout=timeout, cwd=p.parent, cap=96000)


@mcp.tool()
def volatility3_run(
    image: str,
    plugin: str = "windows.pslist.PsList",
    extra_args: Optional[Union[str, List[str]]] = None,
    timeout: int = 180,
) -> Dict[str, Any]:
    """Run a Volatility3 plugin against a memory image."""
    p = _require_file(image)
    if not re.fullmatch(r"[A-Za-z0-9_.]+", plugin):
        raise ValueError("plugin name contains invalid characters")
    vol = shutil.which("vol") or shutil.which("volatility3")
    if not vol:
        raise RuntimeError("Volatility3 command not found")
    return _run([vol, "-f", str(p), plugin] + _as_args(extra_args),
                timeout=timeout, cwd=p.parent, cap=96000)


@mcp.tool()
def binwalk_scan(
    path: str = "",
    extract: bool = False,
    recursive: bool = False,
    timeout: int = 180,
    file: str = "",
    filename: str = "",
    file_path: str = "",
    target: str = "",
) -> Dict[str, Any]:
    """Run binwalk scan or extraction on firmware/blob files."""
    p = _require_file(_coalesce_path(path, file, filename, file_path, target))
    cmd = ["binwalk"]
    if extract:
        cmd.append("-e")
    if recursive:
        cmd.append("-M")
    cmd.append(str(p))
    return _run(cmd, timeout=timeout, cwd=p.parent, cap=96000)


@mcp.tool()
def strings_extract(
    path: str = "",
    min_len: int = 4,
    grep: str = "",
    limit: int = 500,
    timeout: int = 30,
    file: str = "",
    filename: str = "",
    file_path: str = "",
    target: str = "",
) -> Dict[str, Any]:
    """Extract strings, optionally filtering by regex."""
    p = _require_file(_coalesce_path(path, file, filename, file_path, target))
    min_len = max(1, min(int(min_len), 64))
    limit = max(1, min(int(limit), 10000))
    res = _run(["strings", "-a", "-n", str(min_len), str(p)],
               timeout=timeout, cwd=p.parent, cap=300000)
    lines = res["stdout"].splitlines()
    if grep:
        rx = re.compile(grep, re.IGNORECASE)
        lines = [x for x in lines if rx.search(x)]
    res["stdout"] = "\n".join(lines[:limit])
    res["matched_count_before_limit"] = len(lines)
    return res


@mcp.tool()
def sage_eval(code: str, timeout: int = 120) -> Dict[str, Any]:
    """Evaluate SageMath code. Use for RSA/ECC/finite-field/lattice CTF crypto."""
    sage = shutil.which("sage")
    if not sage:
        raise RuntimeError("sage is not installed")
    tmpdir = WORKDIR / ".mcp_tmp"
    tmpdir.mkdir(exist_ok=True)
    with tempfile.NamedTemporaryFile("w", suffix=".sage", dir=str(tmpdir),
                                     delete=False) as f:
        f.write(code)
        script = Path(f.name)
    try:
        return _run([sage, "-q", str(script)], timeout=timeout, cwd=tmpdir, cap=96000)
    finally:
        try:
            script.unlink()
        except Exception:
            pass


@mcp.tool()
def ghidra_headless_analyze(
    path: str,
    project_name: str = "ctf_project",
    timeout: int = 300,
) -> Dict[str, Any]:
    """Import and analyze a binary with Ghidra headless analyzer."""
    p = _require_file(path)
    analyze = shutil.which("analyzeHeadless")
    if not analyze:
        raise RuntimeError("analyzeHeadless not found; Ghidra is not installed")
    project_dir = WORKDIR / "ghidra-projects"
    project_dir.mkdir(exist_ok=True)
    return _run(
        [analyze, str(project_dir), project_name, "-import", str(p), "-overwrite"],
        timeout=timeout,
        cwd=WORKDIR,
        cap=96000,
    )


if __name__ == "__main__":
    main()
