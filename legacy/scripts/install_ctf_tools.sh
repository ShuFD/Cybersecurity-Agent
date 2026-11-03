#!/usr/bin/env bash
# install_ctf_tools.sh — Central CTF tooling installer
# Usage: bash scripts/install_ctf_tools.sh <mode>
#   all      Install everything
#   python   Python packages into current venv (or system if no venv active)
#   apt      System packages (Debian/Ubuntu)
#   brew     macOS Homebrew packages
#   gems     Ruby gems
#   go       Go tools
#   manual   Tools that need manual build steps
set -euo pipefail

MODE="${1:-all}"

# ── Python packages ──────────────────────────────────────────────────────────
install_python() {
  echo "==> Installing Python CTF packages..."
  local pkgs=(
    pwntools angr claripy archinfo cle pyvex z3-solver
    ropper ROPGadget one_gadget capstone unicorn keystone-engine pyelftools lief
    pycryptodome gmpy2 sympy fpylll cysignals numpy scipy networkx pandas tqdm rich ipython
    volatility3 yara-python pefile construct hexdump r2pipe qiling
    intelhex
  )
  pip install --prefer-binary "${pkgs[@]}"
  echo "   Python packages done."
}

# ── APT packages (Debian/Ubuntu) ─────────────────────────────────────────────
install_apt() {
  if ! command -v apt-get &>/dev/null; then
    echo "   apt-get not found; skipping APT install."
    return 0
  fi
  echo "==> Installing APT CTF packages..."
  sudo apt-get update -qq
  sudo apt-get install -y --no-install-recommends \
    build-essential cmake pkg-config autoconf automake libtool \
    git curl wget file jq xxd binutils binutils-multiarch binutils-avr \
    gdb gdb-multiarch gdb-avr simavr \
    elfutils patchelf checksec strace ltrace lsof \
    python3 python3-pip python3-dev python3-venv \
    qemu-user qemu-user-static qemu-system-x86 qemu-system-arm qemu-system-misc qemu-utils \
    socat netcat-openbsd tcpdump tshark \
    binwalk squashfs-tools sleuthkit foremost scalpel exiftool steghide pngcheck zbar-tools \
    yara radare2 upx-ucl \
    gcc-aarch64-linux-gnu g++-aarch64-linux-gnu \
    gcc-arm-linux-gnueabihf g++-arm-linux-gnueabihf \
    wine wine64 wine32 xvfb \
    unzip zip p7zip-full \
    imagemagick ffmpeg \
    nodejs npm ruby-full
  echo "   APT packages done."
}

# ── Homebrew (macOS) ─────────────────────────────────────────────────────────
install_brew() {
  if ! command -v brew &>/dev/null; then
    echo "   Homebrew not found; skipping brew install."
    return 0
  fi
  echo "==> Installing Homebrew CTF packages..."
  brew install \
    binutils binutils-amd64 binutils-aarch64 \
    gdb radare2 checksec \
    qemu \
    binwalk foremost exiftool steghide pngcheck zbar \
    yara upx \
    tshark wireshark \
    socat nmap \
    unzip p7zip imagemagick ffmpeg \
    node ruby
  echo "   Homebrew packages done."
}

# ── Ruby gems ────────────────────────────────────────────────────────────────
install_gems() {
  if ! command -v gem &>/dev/null; then
    echo "   gem not found; skipping gem install."
    return 0
  fi
  echo "==> Installing Ruby CTF gems..."
  gem install one_gadget seccomp-tools zsteg
  echo "   Ruby gems done."
}

# ── Go tools ─────────────────────────────────────────────────────────────────
install_go() {
  if ! command -v go &>/dev/null; then
    echo "   Go not found; skipping go install."
    return 0
  fi
  echo "==> Installing Go CTF tools..."
  go install github.com/ropnop/kerbrute@latest 2>/dev/null || true
  echo "   Go tools done."
}

# ── Manual build steps ───────────────────────────────────────────────────────
install_manual() {
  echo "==> Manual build steps..."

  # pwndbg
  if [ ! -d /opt/pwndbg ]; then
    echo "   Cloning pwndbg..."
    git clone --depth=1 https://github.com/pwndbg/pwndbg.git /opt/pwndbg || true
    cd /opt/pwndbg && ./setup.sh || true
  else
    echo "   pwndbg already present at /opt/pwndbg."
  fi

  echo "   Manual steps done."
}

# ── Dispatch ─────────────────────────────────────────────────────────────────
case "$MODE" in
  all)
    install_apt
    install_python
    install_gems
    install_go
    install_manual
    ;;
  python)   install_python ;;
  apt)      install_apt ;;
  brew)     install_brew ;;
  gems)     install_gems ;;
  go)       install_go ;;
  manual)   install_manual ;;
  *)
    echo "Usage: $0 {all|python|apt|brew|gems|go|manual}"
    exit 1
    ;;
esac

echo "==> Done (mode: $MODE)."
