# ctf-mcp 🛠️

> **CTF MCP Toolbox** — A Docker-based CTF challenge-solving toolset, exposed as MCP (Model Context Protocol) tools.
> AI 驱动的 CTF 解题工具箱，以 MCP 协议提供 17+ 专业工具，覆盖 PWN/逆向/密码学/取证。

[![Docker](https://img.shields.io/badge/docker-ubuntu%3A24.04-blue)](https://ubuntu.com/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## 📦 What's Inside / 内含工具

### MCP Tools (17 tools, available via agent)

| Category | Tools |
|----------|-------|
| **File Analysis** | `identify_file`, `checksec_file`, `strings_extract`, `upload_image` |
| **Reverse Engineering** | `gdb_batch`, `radare2_cmd`, `ghidra_headless_analyze` |
| **ELF/PE Execution** | `run_linux_elf`, `run_windows_exe`, `run_ctf_tool` |
| **Emulation** | `qemu_system_run`, `qemu_targets` |
| **Network / Forensics** | `tshark_summary`, `volatility3_run`, `binwalk_scan` |
| **Crypto / Math** | `sage_eval` |
| **System** | `command_exists` |

### Pre-installed System Tools

| Area | Tools |
|------|-------|
| **Debugger** | GDB, GDB-multiarch, pwndbg |
| **Disassembler** | radare2, Ghidra 12.1.2 (headless) |
| **Python CTF** | pwntools, angr 9.2, z3, capstone, unicorn, ROPgadget, ropper, one_gadget |
| **Math / Crypto** | SageMath 10.9 (via conda-forge), pycryptodome |
| **Forensics** | binwalk, volatility3, tshark, foremost, scalpel, steghide, yara |
| **Emulation** | QEMU (29 system targets + user-static for aarch64/arm/mips/riscv64) |
| **Windows** | Wine (win32 + win64) |
| **File Tools** | xxd, hexdump, exiftool, pngcheck, zbarimg, file |

---

## 🚀 Quick Start / 快速开始

### 1. Build the Docker image

```bash
git clone https://github.com/YOUR_USER/ctf-mcp.git
cd ctf-mcp

# Full build (includes SageMath + Ghidra, ~30min, ~15GB image)
docker build -t ctf-mcp:ubuntu24-core .

# Minimal build (skip SageMath and Ghidra for faster iteration)
docker build --build-arg INSTALL_SAGE=0 --build-arg INSTALL_GHIDRA=0 \
  -t ctf-mcp:ubuntu24-core .
```

> **Build time** depends on network speed. The pre-built image size is ~8GB compressed / ~31GB on disk.

### 2. Verify the image

```bash
docker run --rm --platform linux/amd64 ctf-mcp:ubuntu24-core \
  python3 /opt/ctf-mcp/server.py --help
```

### 3. Configure your MCP client

Add to your agent's `.mcp.json` or `settings.json`:

```json
{
  "mcpServers": {
    "ctf-toolbox": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--platform", "linux/amd64",
        "--cap-add=SYS_PTRACE",
        "--security-opt", "seccomp=unconfined",
        "-v", "/ABSOLUTE/PATH/TO/YOUR/WORKDIR:/work",
        "ctf-mcp:ubuntu24-core",
        "python3", "/opt/ctf-mcp/server.py"
      ],
      "timeout": 120
    }
  }
}
```

> ⚠️ Replace `/ABSOLUTE/PATH/TO/YOUR/WORKDIR` with a real directory on your host.
> All file operations are restricted to this `/work` directory for security.

### 4. Install the MCP server

```bash
pip install mcp fastmcp
```

Then refresh MCP tools in your agent. You should see all 17 tools available.

For the server-compatible HTTP image, build from the `legacy/` directory so the
wrapper always copies this canonical `server.py` instead of maintaining a second
fork:

```bash
cd ..
docker build \
  -f ctf-mcp-hotfix/Dockerfile \
  -t ctf-mcp:ubuntu24-http-tools \
  .
```

Run it with the deployed bind and port contract:

```bash
docker run -d \
  --name ctf-mcp-http \
  --restart unless-stopped \
  --platform linux/amd64 \
  --cap-add=SYS_PTRACE \
  --security-opt seccomp=unconfined \
  -v /path/to/secheur-agent/.secheur-agent/ctf-work:/work \
  -p 127.0.0.1:18080:8000 \
  ctf-mcp:ubuntu24-http-tools
```

Configure SecHeur with the same HTTP endpoint:

```json
{
  "mcpServers": {
    "ctf-toolbox": {
      "transport": "streamable-http",
      "url": "http://127.0.0.1:18080/mcp",
      "timeout": 120
    }
  }
}
```

The server maps absolute paths from the deployed host work directory into
`/work`. Override the colon-separated `CTF_HOST_WORKDIRS` and
`CTF_ALLOWED_ROOTS`, or `CTF_TMPDIR`, when another deployment layout is used.

---

## 🐳 Docker Deployment / 部署说明

### Build Arguments / 构建参数

| Arg | Default | Description |
|-----|---------|-------------|
| `UBUNTU_MIRROR` | `http://archive.ubuntu.com/ubuntu/` | APT mirror for faster downloads |
| `INSTALL_SAGE` | `1` | Install SageMath 10.9 (~5GB extra) |
| `INSTALL_GHIDRA` | `1` | Install Ghidra 12.1.2 (~1.5GB extra) |
| `INSTALL_EXTRA_MCPS` | `0` | Install optional MCP servers (r2mcp, pwndbg-mcp, ghidra-mcp, sagemath-mcp) |
| `STRICT_EXTRA_MCPS` | `0` | Exit on error if extra MCPs fail |

### Example: Build with mirror for faster download

```bash
docker build \
  --build-arg UBUNTU_MIRROR=http://mirrors.ustc.edu.cn/ubuntu/ \
  -t ctf-mcp:ubuntu24-core .
```

### Example: Minimal footprint build

```bash
docker build \
  --build-arg INSTALL_SAGE=0 \
  --build-arg INSTALL_GHIDRA=0 \
  -t ctf-mcp:ubuntu24-minimal .
```

### Docker Run Options Explained / 参数说明

| Flag | Why |
|------|-----|
| `--platform linux/amd64` | Ensures compatibility; some tools (pwndbg, Sage) require amd64 |
| `--cap-add=SYS_PTRACE` | Required for GDB/ptrace debugging |
| `--security-opt seccomp=unconfined` | Allows ptrace syscalls inside container |
| `-v /path:/work` | Mounts a host directory for challenge files |

---

## 🔧 Usage Examples / 使用示例

### PWN: Check binary protections

```python
# Agent will call: checksec_file(path="/work/challenge.elf")
```

### Reverse: Decompile with Ghidra

```python
# Agent will call: ghidra_headless_analyze(path="/work/binary")
```

### Reverse: Scripted GDB analysis

```python
# Agent will call: gdb_batch(path="/work/binary", commands=["info functions", "disas main"])
```

### Crypto: RSA attack with SageMath

```python
# Agent will call: sage_eval(code="factor(12345678901234567890123456789012345678901)")
```

### Forensics: Analyze memory dump

```python
# Agent will call: volatility3_run(image="/work/dump.raw", plugin="windows.pslist")
```

### Network: Parse pcap

```python
# Agent will call: tshark_summary(pcap="/work/traffic.pcap", display_filter="http")
```

### Firmware: Extract filesystem

```python
# Agent will call: binwalk_scan(path="/work/firmware.bin", extract=True, recursive=True)
```

---

## 📁 Project Structure / 项目结构

```
ctf-mcp/
├── Dockerfile                    # Multi-stage Docker build
├── server.py                     # MCP tool server (main entry point)
├── requirements.txt              # Python dependencies
├── pwndbg-wrapper.sh             # GDB wrapper for pwndbg
├── mcp.servers.host-example.json # Example MCP config for Docker mode
├── mcp.servers.optional.json     # Local (non-Docker) MCP config
├── .mcp.json.example             # Simplified agent-side config
└── README.md                     # This file
```

---

## 🔒 Security / 安全说明

- File-oriented MCP tools accept only `/work`, `CTF_TMPDIR`, and explicitly
  configured `CTF_ALLOWED_ROOTS`; known host work-directory paths are mapped to
  `/work`
- `run_ctf_tool` uses an **allowlist** of approved tools only
- The broad CTF command allowlist, networking tools, and shell interpreters are
  intended for an isolated container; do not expose the HTTP port beyond a
  trusted local interface
- QEMU system mode disables networking by default (`-nic none`)
- The container runs as **non-root** user `ctf` by default
- `SYS_PTRACE` and `seccomp=unconfined` are required for GDB — use with caution

---

## 📋 License

MIT

---

## 🤝 Contributing

PRs welcome! Please ensure:
- Tools are added to `ALLOWED_TOOLS` set in `server.py`
- New tools have proper security sandboxing
- Docker build remains reproducible
