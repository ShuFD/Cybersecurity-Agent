# =============================================================================
# ctf-mcp:ubuntu24-core — CTF MCP Toolbox Docker Image
# =============================================================================
# Build:
#   docker build -t ctf-mcp:ubuntu24-core .
#
# Run (MCP stdio mode for agent integration):
#   docker run -i --rm \
#     --platform linux/amd64 \
#     --cap-add=SYS_PTRACE \
#     --security-opt seccomp=unconfined \
#     -v /path/to/work:/work \
#     ctf-mcp:ubuntu24-core \
#     python3 /opt/ctf-mcp/server.py
# =============================================================================

FROM ubuntu:24.04

LABEL maintainer="ctf-mcp"
LABEL description="CTF MCP Toolbox — PWN/Rev/Crypto/Forensics all-in-one container"

# ── Build Arguments ──────────────────────────────────────────────────────────
ARG UBUNTU_MIRROR="http://mirrors.ustc.edu.cn/ubuntu/"
ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_MAJOR=20
ARG MAVEN_VERSION=3.9.16

ARG INSTALL_SAGE=1
ARG INSTALL_GHIDRA=1
ARG INSTALL_EXTRA_MCPS=0
ARG STRICT_EXTRA_MCPS=0

ARG GHIDRA_VERSION=12.1.2
ARG GHIDRA_DATE=20260605
ARG GHIDRA_SHA256=b62e81a0390618466c019c60d8c2f796ced2509c4c1aea4a37644a77272cf99d
ARG GHIDRA_URL=https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VERSION}_build/ghidra_${GHIDRA_VERSION}_PUBLIC_${GHIDRA_DATE}.zip

ARG MAMBA_CHANNEL=conda-forge

SHELL ["/bin/bash", "-euxo", "pipefail", "-c"]

# ── System Dependencies ─────────────────────────────────────────────────────
RUN \
  # Use mirror if specified
  if [ -n "${UBUNTU_MIRROR}" ]; then \
    sed -i "s|http://archive.ubuntu.com/ubuntu/|${UBUNTU_MIRROR}|g" /etc/apt/sources.list; \
    sed -i "s|http://security.ubuntu.com/ubuntu/|${UBUNTU_MIRROR}|g" /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null || true; \
  fi && \
  dpkg --add-architecture i386 && \
  apt-get update -qq && \
  apt-get install -y -qq --no-install-recommends \
    # Core
    curl ca-certificates gnupg unzip xz-utils bzip2 \
    git jq file sudo vim tmux screen \
    # Build
    build-essential cmake pkg-config libtool autoconf automake \
    ruby ruby-dev \
    # Python
    python3 python3-pip python3-dev python3-venv \
    # Debug / Reverse
    gdb gdb-multiarch \
    binutils-avr gdb-avr simavr \
    radare2 \
    strace ltrace lsof \
    # Network / Forensics
    netcat-openbsd nmap tcpdump tshark \
    binwalk \
    xxd \
    # File analysis
    file libmagic1 \
    exiftool bsdextrautils foremost scalpel steghide pngcheck \
    zbar-tools \
    7zip p7zip-full \
    imagemagick tesseract-ocr \
    # Emulation
    qemu-system-data qemu-system-gui \
    qemu-system-arm qemu-system-aarch64 \
    qemu-system-mips qemu-system-misc \
    qemu-system-x86 qemu-system-ppc \
    qemu-user-static \
    # Windows compat
    wine wine32 wine64 \
    # Misc
    nodejs npm \
    openjdk-21-jdk-headless \
    yara \
    && \
  # Cleanup
  apt-get clean && rm -rf /var/lib/apt/lists/*

# ── Node.js (if not included above) ──────────────────────────────────────────
RUN if ! command -v node &>/dev/null; then \
    curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*; \
  fi

# ── Maven ────────────────────────────────────────────────────────────────────
RUN curl -fsSL \
      "https://dlcdn.apache.org/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.tar.gz" \
      -o /tmp/maven.tar.gz && \
    tar -xzf /tmp/maven.tar.gz -C /opt && \
    ln -sf /opt/apache-maven-${MAVEN_VERSION}/bin/mvn /usr/local/bin/mvn && \
    rm /tmp/maven.tar.gz

# ── Python CTF Virtual Environment ──────────────────────────────────────────
COPY requirements.txt /opt/ctf-venv/requirements.txt
RUN python3 -m venv /opt/ctf-venv && \
    source /opt/ctf-venv/bin/activate && \
    pip install --no-cache-dir -U pip && \
    pip install --no-cache-dir \
      pwntools \
      angr \
      capstone \
      unicorn \
      ropper \
      ROPgadget \
      one_gadget \
      z3-solver \
      cryptography \
      pycryptodome \
      requests \
      beautifulsoup4 \
      pillow \
      numpy \
      aiofile \
      bitstring \
      bitarray \
      intelhex \
      && \
    pip install --no-cache-dir \
      "mcp[cli]==1.29.0" \
      uv

# ── Ruby CTF Tools ──────────────────────────────────────────────────────────
RUN gem install --no-document zsteg one_gadget && \
    ln -sf /usr/bin/7z /usr/local/bin/7zz

# ── pwndbg ───────────────────────────────────────────────────────────────────
RUN git clone --depth=1 https://github.com/pwndbg/pwndbg /opt/pwndbg && \
    cd /opt/pwndbg && \
    PATH=/opt/ctf-venv/bin:$PATH uv sync --no-dev && \
    chown -R root:root /opt/pwndbg/.venv

COPY pwndbg-wrapper.sh /usr/local/bin/pwndbg-gdb
RUN chmod 0755 /usr/local/bin/pwndbg-gdb

# ── Micromamba + SageMath (optional: INSTALL_SAGE=1) ────────────────────────
RUN if [ "${INSTALL_SAGE}" = "1" ]; then \
    mkdir -p /tmp/micromamba /opt/micromamba /opt/sage && \
    curl -L --retry 8 --retry-delay 3 --connect-timeout 30 \
      -o /tmp/micromamba/micromamba.tar.bz2 \
      https://micro.mamba.pm/api/micromamba/linux-64/latest && \
    tar -xjf /tmp/micromamba/micromamba.tar.bz2 -C /tmp/micromamba bin/micromamba && \
    install -m 0755 /tmp/micromamba/bin/micromamba /usr/local/bin/micromamba && \
    rm -rf /tmp/micromamba && \
    micromamba create -y -p /opt/sage -c ${MAMBA_CHANNEL} --strict-channel-priority sage=10.9 && \
    micromamba clean -a -y && \
    ln -sf /opt/sage/bin/sage /usr/local/bin/sage && \
    rm -rf /opt/micromamba; \
  fi

# ── Ghidra (optional: INSTALL_GHIDRA=1) ─────────────────────────────────────
RUN if [ "${INSTALL_GHIDRA}" = "1" ]; then \
    mkdir -p /opt/ghidra-download && \
    curl -L --retry 8 --retry-delay 5 --connect-timeout 30 \
      -o /opt/ghidra-download/ghidra.zip "${GHIDRA_URL}" && \
    echo "${GHIDRA_SHA256}  /opt/ghidra-download/ghidra.zip" | sha256sum -c - && \
    unzip -q /opt/ghidra-download/ghidra.zip -d /opt && \
    mv "/opt/ghidra_${GHIDRA_VERSION}_PUBLIC" /opt/ghidra && \
    ln -sf /opt/ghidra/ghidraRun /usr/local/bin/ghidraRun && \
    ln -sf /opt/ghidra/support/analyzeHeadless /usr/local/bin/analyzeHeadless && \
    rm -rf /opt/ghidra-download; \
  fi

# ── Environment ──────────────────────────────────────────────────────────────
ENV MAMBA_ROOT_PREFIX=/opt/micromamba
ENV PATH=/opt/sage/bin:/opt/ghidra/support:/opt/ghidra:/opt/ctf-venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# System `python3` is invoked by compose command; make it resolve to the venv
# so the MCP deps installed under /opt/ctf-venv are importable.
RUN ln -sf /opt/ctf-venv/bin/python3 /usr/local/bin/python3
ENV PWNDBG_NO_AUTOUPDATE=1

# ── MCP Server ───────────────────────────────────────────────────────────────
COPY server.py /opt/ctf-mcp/server.py
COPY mcp.servers.optional.json /opt/ctf-mcp/mcp.servers.optional.json
COPY mcp.servers.host-example.json /opt/ctf-mcp/mcp.servers.host-example.json

# ── Final Setup ──────────────────────────────────────────────────────────────
RUN ln -sfn /opt/ghidra/ghidraRun /usr/local/bin/ghidraRun 2>/dev/null; \
    ln -sfn /opt/ghidra/support/analyzeHeadless /usr/local/bin/analyzeHeadless 2>/dev/null; \
    command -v sage 2>/dev/null; command -v ghidraRun 2>/dev/null || true

RUN useradd -m -s /bin/bash ctf && \
    mkdir -p /work /home/ctf/.cache /home/ctf/.config /home/ctf/.wine && \
    chown -R ctf:ctf /work /home/ctf /opt/sage /opt/micromamba /opt/ghidra 2>/dev/null || true

USER ctf
WORKDIR /work

CMD ["/bin/bash"]
