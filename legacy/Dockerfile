FROM ubuntu:24.04

SHELL ["/bin/bash", "-euxo", "pipefail", "-c"]

ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_MAJOR=20
ARG MAVEN_VERSION=3.9.9

ARG INSTALL_SAGE=1
ARG INSTALL_GHIDRA=1
ARG INSTALL_EXTRA_MCPS=1
ARG STRICT_EXTRA_MCPS=0

ARG MAMBA_CHANNEL=conda-forge

ARG GHIDRA_VERSION=12.1.2
ARG GHIDRA_DATE=20260605
ARG GHIDRA_SHA256=b62e81a0390618466c019c60d8c2f796ced2509c4c1aea4a37644a77272cf99d
ARG GHIDRA_URL=https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.2_build/ghidra_12.1.2_PUBLIC_20260605.zip

ENV TZ=Etc/UTC \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    WORKDIR=/work \
    CTF_WORKDIR=/work \
    VIRTUAL_ENV=/opt/ctf-venv \
    MAMBA_ROOT_PREFIX=/opt/micromamba \
    GHIDRA_INSTALL_DIR=/opt/ghidra \
    WINEPREFIX=/home/ctf/.wine \
    WINEARCH=win64 \
    WINEDEBUG=-all \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/ctf-venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN dpkg --add-architecture i386

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg dirmngr software-properties-common apt-transport-https && \
    install -d -m 0755 /etc/apt/keyrings && \
    curl -fsSL "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list && \
    add-apt-repository -y universe && \
    add-apt-repository -y multiverse && \
    rm -rf /var/lib/apt/lists/*

RUN echo "wireshark-common wireshark-common/install-setuid boolean false" | debconf-set-selections

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      bash-completion build-essential cmake ninja-build make pkg-config autoconf automake libtool meson \
      git git-lfs curl wget aria2 rsync openssh-client ca-certificates \
      vim nano less tmux screen tree file jq xxd bsdmainutils coreutils findutils ripgrep fd-find \
      unzip zip p7zip-full xz-utils zstd lz4 gzip bzip2 tar cabextract upx-ucl \
      python3 python3-full python3-dev python3-pip python3-venv python3-setuptools python3-wheel python-is-python3 \
      nodejs openjdk-21-jdk ruby-full \
      gcc g++ clang lld llvm gdb gdbserver gdb-multiarch \
      binutils binutils-multiarch binutils-avr gdb-avr simavr elfutils patchelf checksec strace ltrace lsof procps psmisc \
      socat netcat-openbsd iproute2 iputils-ping dnsutils tcpdump \
      libc6-dbg libc6:i386 libc6-dbg:i386 libstdc++6:i386 libgcc-s1:i386 zlib1g:i386 libtinfo6:i386 \
      libssl-dev libffi-dev libgmp-dev libmpfr-dev libmpc-dev liblzma-dev libbz2-dev zlib1g-dev \
      libfplll-dev fplll-tools libflint-dev libmagic-dev \
      qemu-user qemu-user-static qemu-system-x86 qemu-system-arm qemu-system-misc qemu-utils \
      binfmt-support qemu-efi-aarch64 qemu-efi-arm ovmf seabios \
      gcc-aarch64-linux-gnu g++-aarch64-linux-gnu libc6-arm64-cross \
      gcc-arm-linux-gnueabihf g++-arm-linux-gnueabihf libc6-armhf-cross \
      wine wine64 wine32 winetricks xvfb \
      mingw-w64 osslsigncode \
      tshark wireshark-common \
      binwalk squashfs-tools sleuthkit foremost scalpel exiftool libimage-exiftool-perl \
      steghide pngcheck jpeginfo ffmpeg sox imagemagick qrencode zbar-tools \
      yara hashdeep dc3dd \
      apktool radare2 pari-gp \
      libglib2.0-0 libnss3 libxrender1 libxtst6 libxi6 libgtk-3-0 libcanberra-gtk-module && \
    rm -rf /var/lib/apt/lists/*

RUN curl --retry 5 --retry-delay 5 -fsSL \
      "https://archive.apache.org/dist/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.tar.gz" \
    | tar -xz -C /opt && \
    ln -sf "/opt/apache-maven-${MAVEN_VERSION}/bin/mvn" /usr/local/bin/mvn

RUN python3 -m venv /opt/ctf-venv && \
    pip install --no-cache-dir --upgrade pip setuptools wheel packaging cython && \
    pip install --no-cache-dir --prefer-binary \
      "mcp[cli]" fastmcp uv && \
    pip install --no-cache-dir --prefer-binary \
      pwntools angr claripy archinfo cle pyvex z3-solver && \
    pip install --no-cache-dir --prefer-binary \
      ropper ROPGadget one_gadget capstone unicorn keystone-engine pyelftools lief && \
    pip install --no-cache-dir --prefer-binary \
      pycryptodome gmpy2 sympy fpylll cysignals numpy scipy networkx pandas tqdm rich ipython && \
    pip install --no-cache-dir --prefer-binary \
      volatility3 yara-python pefile construct hexdump r2pipe qiling && \
    pip install --no-cache-dir --prefer-binary \
      frida frida-tools frida-mcp wireshark-mcp intelhex

RUN if [ "${INSTALL_SAGE}" = "1" ]; then \
      curl --retry 5 --retry-delay 5 -fsSL \
        "https://micro.mamba.pm/api/micromamba/linux-64/latest" \
        -o /tmp/micromamba.tar.bz2 && \
      mkdir -p /tmp/micromamba && \
      tar -xjf /tmp/micromamba.tar.bz2 -C /tmp/micromamba && \
      install -m 0755 /tmp/micromamba/bin/micromamba /usr/local/bin/micromamba && \
      micromamba create -y -n sage -c "${MAMBA_CHANNEL}" sage && \
      micromamba clean -a -y && \
      ln -sf "${MAMBA_ROOT_PREFIX}/envs/sage/bin/sage" /usr/local/bin/sage && \
      ln -sf "${MAMBA_ROOT_PREFIX}/envs/sage/bin/python" /usr/local/bin/sage-python && \
      rm -rf /tmp/micromamba /tmp/micromamba.tar.bz2; \
    else \
      echo "INSTALL_SAGE=0: skip SageMath"; \
    fi

RUN gem install --no-document one_gadget seccomp-tools

RUN if [ "${INSTALL_GHIDRA}" = "1" ]; then \
      curl --retry 5 --retry-delay 5 -fL -o /tmp/ghidra.zip "${GHIDRA_URL}" && \
      echo "${GHIDRA_SHA256}  /tmp/ghidra.zip" | sha256sum -c - && \
      unzip -q /tmp/ghidra.zip -d /opt && \
      mv "/opt/ghidra_${GHIDRA_VERSION}_PUBLIC" /opt/ghidra && \
      rm -f /tmp/ghidra.zip && \
      chmod +x /opt/ghidra/ghidraRun /opt/ghidra/support/analyzeHeadless && \
      ln -sf /opt/ghidra/ghidraRun /usr/local/bin/ghidraRun && \
      ln -sf /opt/ghidra/support/analyzeHeadless /usr/local/bin/analyzeHeadless; \
    else \
      mkdir -p /opt/ghidra; \
      echo "INSTALL_GHIDRA=0: skip Ghidra"; \
    fi

RUN mkdir -p /opt/mcps && \
    if [ "${INSTALL_EXTRA_MCPS}" = "1" ]; then \
      optional() { "$@" || { rc=$?; echo "[optional failed ${rc}] $*" >&2; if [ "${STRICT_EXTRA_MCPS}" = "1" ]; then exit "${rc}"; fi; }; }; \
      optional git clone --depth=1 https://github.com/bethington/ghidra-mcp.git /opt/mcps/ghidra-mcp; \
      if [ -d /opt/mcps/ghidra-mcp ]; then \
        optional bash -lc 'cd /opt/mcps/ghidra-mcp && pip install --no-cache-dir -r requirements.txt'; \
        if [ "${INSTALL_GHIDRA}" = "1" ]; then \
          optional bash -lc 'cd /opt/mcps/ghidra-mcp && python -m tools.setup ensure-prereqs --ghidra-path /opt/ghidra'; \
          optional bash -lc 'cd /opt/mcps/ghidra-mcp && python -m tools.setup build'; \
        fi; \
      fi; \
      optional git clone --depth=1 https://github.com/GaloisHLee/mcp-server-sagemath.git /opt/mcps/mcp-server-sagemath; \
      if [ -d /opt/mcps/mcp-server-sagemath ]; then \
        optional bash -lc 'cd /opt/mcps/mcp-server-sagemath && npm install && npm run build'; \
      fi; \
      optional git clone --depth=1 https://github.com/doublegate/CyberChef-MCP.git /opt/mcps/CyberChef-MCP; \
      if [ -d /opt/mcps/CyberChef-MCP ]; then \
        optional bash -lc 'cd /opt/mcps/CyberChef-MCP && npm install'; \
      fi; \
      optional git clone --depth=1 https://github.com/RocketMaDev/pwndbg-mcp.git /opt/mcps/pwndbg-mcp; \
      if [ -d /opt/mcps/pwndbg-mcp ]; then \
        optional uv tool install /opt/mcps/pwndbg-mcp; \
      fi; \
      optional git clone --depth=1 https://github.com/Cossack9989/binwalk-mcp-server.git /opt/mcps/binwalk-mcp-server; \
      if [ -d /opt/mcps/binwalk-mcp-server ]; then \
        optional bash -lc 'cd /opt/mcps/binwalk-mcp-server && pip install --no-cache-dir -e .'; \
      fi; \
      optional r2pm -Uci r2mcp; \
    fi

RUN git clone --depth=1 https://github.com/pwndbg/pwndbg.git /opt/pwndbg && \
    cd /opt/pwndbg && ./setup.sh || true && \
    cat > /usr/local/bin/pwndbg-gdb <<'SH' && chmod +x /usr/local/bin/pwndbg-gdb
#!/usr/bin/env bash
if [ -f /opt/pwndbg/gdbinit.py ]; then
  exec gdb -q -ex "source /opt/pwndbg/gdbinit.py" "$@"
fi
exec gdb -q "$@"
SH

RUN mkdir -p /work /opt/ctf-mcp && \
    cat > /opt/ctf-mcp/server.py <<'PY'
#!/usr/bin/env python3
import os
import re
import shlex
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("ctf-toolbox-mcp")
WORKDIR = Path(os.environ.get("CTF_WORKDIR", "/work")).resolve()

def _as_args(args: Optional[Union[str, List[Any]]]) -> List[str]:
    if args is None:
        return []
    if isinstance(args, str):
        return shlex.split(args)
    return [str(x) for x in args]

def _safe_path(path: str) -> Path:
    p = Path(path)
    if not p.is_absolute():
        p = WORKDIR / p
    rp = p.resolve()
    try:
        rp.relative_to(WORKDIR)
    except ValueError:
        raise ValueError(f"path outside CTF_WORKDIR is blocked: {rp}")
    return rp

def _safe_cwd(cwd: Optional[str]) -> Path:
    return _safe_path(cwd) if cwd else WORKDIR

def _require_file(path: str) -> Path:
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

def _decode(data: bytes, limit: int = 32000) -> str:
    text = data.decode("utf-8", errors="replace")
    if len(text) > limit:
        return text[:limit] + f"\n...[truncated {len(text) - limit} chars]"
    return text

def _run(
    cmd: List[str],
    timeout: int = 30,
    cwd: Optional[Path] = None,
    env: Optional[Dict[str, str]] = None,
    cap: int = 32000,
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
    "file", "strings", "xxd", "hexdump", "readelf", "objdump", "nm", "ldd",
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

@mcp.tool()
def command_exists(names: List[str]) -> Dict[str, Optional[str]]:
    """Check whether commands exist in PATH."""
    return {name: shutil.which(name) for name in names}

@mcp.tool()
def identify_file(path: str) -> Dict[str, Any]:
    """Identify a challenge file with file(1), sha256sum, and size metadata."""
    p = _require_file(path)
    return {
        "path": str(p),
        "size": p.stat().st_size,
        "file": _file_info(p),
        "sha256": _run(["sha256sum", str(p)], timeout=5, cwd=p.parent, cap=2000)["stdout"].strip(),
    }

@mcp.tool()
def run_ctf_tool(
    argv: Union[str, List[str]],
    timeout: int = 30,
    cwd: Optional[str] = None,
) -> Dict[str, Any]:
    """Run an allowlisted CTF tool inside /work. Use argv as a list for reliability."""
    args = _as_args(argv)
    if not args:
        raise ValueError("empty argv")
    exe = Path(args[0]).name
    if exe not in ALLOWED_TOOLS:
        raise ValueError(f"tool not allowlisted: {exe}")
    return _run(args, timeout=timeout, cwd=_safe_cwd(cwd), cap=64000)

@mcp.tool()
def run_linux_elf(
    path: str,
    args: Optional[Union[str, List[str]]] = None,
    arch: str = "auto",
    timeout: int = 10,
) -> Dict[str, Any]:
    """Run a Linux ELF natively or under qemu-user-static. Supports x86_64/i386/aarch64/arm/mips/mipsel/riscv64."""
    p = _require_file(path)
    try:
        p.chmod(p.stat().st_mode | 0o111)
    except Exception:
        pass
    info = _file_info(p)
    selected = _detect_arch(info) if arch == "auto" else arch
    if selected in ("x86_64", "i386", "native"):
        cmd = [str(p)] + _as_args(args)
    else:
        if selected not in QEMU_USER:
            raise ValueError(f"unsupported arch: {selected}; file info: {info}")
        qemu, sysroot = QEMU_USER[selected]
        cmd = [qemu]
        if sysroot and Path(sysroot).exists():
            cmd += ["-L", sysroot]
        cmd += [str(p)] + _as_args(args)
    res = _run(cmd, timeout=timeout, cwd=p.parent, cap=64000)
    res["detected_file"] = info
    res["selected_arch"] = selected
    return res

@mcp.tool()
def run_windows_exe(
    path: str,
    args: Optional[Union[str, List[str]]] = None,
    timeout: int = 30,
) -> Dict[str, Any]:
    """Run a Windows PE challenge with Wine under Xvfb."""
    p = _require_file(path)
    env = {
        "WINEPREFIX": os.environ.get("WINEPREFIX", "/home/ctf/.wine"),
        "WINEARCH": os.environ.get("WINEARCH", "win64"),
        "WINEDEBUG": "-all",
        "WINEDLLOVERRIDES": "mscoree,mshtml=",
    }
    cmd = ["xvfb-run", "-a", "wine", str(p)] + _as_args(args)
    res = _run(cmd, timeout=timeout, cwd=p.parent, env=env, cap=64000)
    res["detected_file"] = _file_info(p)
    return res

@mcp.tool()
def qemu_system_run(
    arch: str,
    qemu_args: Union[str, List[str]],
    timeout: int = 120,
    allow_network: bool = False,
) -> Dict[str, Any]:
    """Run qemu-system-* for firmware, kernels, ARM boards, Windows/Linux images, or disk images under /work."""
    if arch not in QEMU_SYSTEM:
        raise ValueError(f"arch must be one of {sorted(QEMU_SYSTEM)}")
    args = _as_args(qemu_args)
    if not allow_network and any(a.startswith(("-net", "-netdev", "-nic")) for a in args):
        raise ValueError("network args are blocked unless allow_network=true")
    if "-nographic" not in args and "-display" not in args:
        args = ["-nographic"] + args
    if not allow_network:
        args = ["-nic", "none"] + args
    return _run([QEMU_SYSTEM[arch]] + args, timeout=timeout, cwd=WORKDIR, cap=96000)

@mcp.tool()
def qemu_targets() -> Dict[str, Any]:
    """List installed QEMU user and system emulators."""
    return {
        "qemu_user_static": sorted(str(p) for p in Path("/usr/bin").glob("qemu-*-static")),
        "qemu_system": sorted(str(p) for p in Path("/usr/bin").glob("qemu-system-*")),
    }

@mcp.tool()
def checksec_file(path: str) -> Dict[str, Any]:
    """Run checksec on an ELF file."""
    p = _require_file(path)
    return _run(["checksec", "--file", str(p)], timeout=10, cwd=p.parent, cap=16000)

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
    return _run([vol, "-f", str(p), plugin] + _as_args(extra_args), timeout=timeout, cwd=p.parent, cap=96000)

@mcp.tool()
def binwalk_scan(
    path: str,
    extract: bool = False,
    recursive: bool = False,
    timeout: int = 180,
) -> Dict[str, Any]:
    """Run binwalk scan or extraction on firmware/blob files."""
    p = _require_file(path)
    cmd = ["binwalk"]
    if extract:
        cmd.append("-e")
    if recursive:
        cmd.append("-M")
    cmd.append(str(p))
    return _run(cmd, timeout=timeout, cwd=p.parent, cap=96000)

@mcp.tool()
def strings_extract(
    path: str,
    min_len: int = 4,
    grep: str = "",
    limit: int = 500,
    timeout: int = 30,
) -> Dict[str, Any]:
    """Extract strings, optionally filtering by regex."""
    p = _require_file(path)
    min_len = max(1, min(int(min_len), 64))
    limit = max(1, min(int(limit), 10000))
    res = _run(["strings", "-a", "-n", str(min_len), str(p)], timeout=timeout, cwd=p.parent, cap=300000)
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
    with tempfile.NamedTemporaryFile("w", suffix=".sage", dir=str(tmpdir), delete=False) as f:
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
    mcp.run()
PY

RUN chmod +x /opt/ctf-mcp/server.py && \
    ln -sf /opt/ctf-mcp/server.py /usr/local/bin/ctf-toolbox-mcp && \
    cat > /usr/local/bin/ctf-selfcheck <<'SH' && chmod +x /usr/local/bin/ctf-selfcheck
#!/usr/bin/env bash
set +e
echo "== basic =="
python3 --version
pip --version
node --version
npm --version
java -version 2>&1 | head -n 2
mvn --version | head -n 1
echo
echo "== tools =="
for c in \
  gdb gdb-multiarch pwndbg-gdb checksec ROPgadget ropper one_gadget \
  avr-objdump avr-gdb simavr \
  qemu-aarch64-static qemu-arm-static qemu-system-x86_64 qemu-system-aarch64 qemu-system-arm \
  wine tshark capinfos mergecap editcap dumpcap text2pcap \
  binwalk r2 vol volatility3 sage ghidraRun analyzeHeadless frida frida-ps; do
  if command -v "$c" >/dev/null 2>&1; then
    printf "%-28s %s\n" "$c" "$(command -v "$c")"
  else
    printf "%-28s missing\n" "$c"
  fi
done
SH

RUN cat > /opt/ctf-mcp/mcp.servers.core.json <<'JSON'
{
  "mcpServers": {
    "ctf-toolbox": {
      "command": "python3",
      "args": ["/opt/ctf-mcp/server.py"],
      "env": {
        "CTF_WORKDIR": "/work",
        "WINEPREFIX": "/home/ctf/.wine",
        "WINEARCH": "win64",
        "WINEDEBUG": "-all"
      }
    }
  }
}
JSON

RUN cat > /opt/ctf-mcp/mcp.servers.optional.json <<'JSON'
{
  "mcpServers": {
    "ctf-toolbox": {
      "command": "python3",
      "args": ["/opt/ctf-mcp/server.py"],
      "env": {
        "CTF_WORKDIR": "/work",
        "WINEPREFIX": "/home/ctf/.wine",
        "WINEARCH": "win64",
        "WINEDEBUG": "-all"
      }
    },
    "wireshark": {
      "command": "wireshark-mcp",
      "args": []
    },
    "frida": {
      "command": "frida-mcp",
      "args": []
    },
    "radare2": {
      "command": "r2pm",
      "args": ["-r", "r2mcp"]
    },
    "sagemath": {
      "command": "node",
      "args": ["/opt/mcps/mcp-server-sagemath/dist/index.js"],
      "env": {
        "SAGE_PATH": "/usr/local/bin/sage"
      }
    },
    "ghidra": {
      "command": "python3",
      "args": ["/opt/mcps/ghidra-mcp/bridge_mcp_ghidra.py"]
    },
    "pwndbg": {
      "command": "pwndbg-mcp",
      "args": ["--transport", "stdio", "--pwndbg", "/usr/local/bin/pwndbg-gdb"]
    }
  }
}
JSON

RUN cat > /opt/ctf-mcp/mcp.servers.host-example.json <<'JSON'
{
  "mcpServers": {
    "ctf-toolbox": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--platform", "linux/amd64",
        "--cap-add=SYS_PTRACE",
        "--security-opt", "seccomp=unconfined",
        "-v", "/ABS/PATH/TO/work:/work",
        "ctf-mcp:ubuntu24",
        "python3", "/opt/ctf-mcp/server.py"
      ]
    }
  }
}
JSON

RUN useradd -m -s /bin/bash ctf && \
    mkdir -p /work /home/ctf/.cache /home/ctf/.config /home/ctf/.wine && \
    chown -R ctf:ctf /work /home/ctf

USER ctf
WORKDIR /work

CMD ["/bin/bash"]
