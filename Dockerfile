# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22-bookworm-slim
ARG PYTHON_IMAGE=python:3.13-slim-bookworm

FROM ${PYTHON_IMAGE} AS repoaudit-builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
        build-essential \
        git \
    && rm -rf /var/lib/apt/lists/*

COPY vendor/repoaudit /opt/repoaudit

RUN python3.13 -m venv /opt/repoaudit-venv \
    && /opt/repoaudit-venv/bin/pip install --upgrade pip \
    && /opt/repoaudit-venv/bin/pip install -r /opt/repoaudit/requirements.txt \
    && mkdir -p /opt/repoaudit/lib/build \
    && /opt/repoaudit-venv/bin/python /opt/repoaudit/lib/build.py

FROM ${NODE_IMAGE} AS builder

WORKDIR /src
COPY . .

RUN npm ci --ignore-scripts
RUN npm run build:offline
RUN mkdir -p /release \
    && npm pack --workspace=@repoaudit/typescript-adapter --pack-destination /release \
    && mv /release/repoaudit-typescript-adapter-*.tgz /release/repoaudit-pi-extension.tgz \
    && npm pack --workspace=@secheur/agent --pack-destination /release \
    && mv /release/secheur-agent-*.tgz /release/secheur-agent.tgz

FROM ${NODE_IMAGE} AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PYTHONUNBUFFERED=1 \
    SECHEUR_PROJECT_ROOT=/workspace \
    SECHEUR_CONFIG_DIR=/data \
    SECHEUR_PYTHON=/opt/secheur-python/bin/python \
    REPOAUDIT_ROOT=/opt/repoaudit \
    REPOAUDIT_REQUIRE_EXPLICIT_ROOT=1 \
    REPOAUDIT_PYTHON=/opt/repoaudit-venv/bin/python \
    REPOAUDIT_REQUIRE_API_KEY=1 \
    REPOAUDIT_TIMEOUT_MS=1800000 \
    REPOAUDIT_LOCK_TIMEOUT_MS=300000 \
    REPOAUDIT_LOCK_STALE_MS=120000 \
    REPOAUDIT_HEARTBEAT_MS=25000 \
    BRIDGE_HOST=0.0.0.0 \
    BRIDGE_PORT=14168

COPY --from=repoaudit-builder /usr/local /usr/local
COPY --from=repoaudit-builder /opt/repoaudit /opt/repoaudit
COPY --from=repoaudit-builder /opt/repoaudit-venv /opt/repoaudit-venv

RUN apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        file \
        git \
        jq \
        openssh-client \
        procps \
        ripgrep \
        tini \
        tmux \
        unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/secheur
COPY --from=builder /release/secheur-agent.tgz /tmp/secheur-agent.tgz
COPY --from=builder /release/repoaudit-pi-extension.tgz /tmp/repoaudit-pi-extension.tgz

RUN npm init -y \
    && npm install --omit=dev --ignore-scripts /tmp/repoaudit-pi-extension.tgz /tmp/secheur-agent.tgz \
    && python3.13 -m venv /opt/secheur-python \
    && /opt/secheur-python/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/secheur-python/bin/pip install --no-cache-dir /opt/secheur/node_modules/@secheur/agent/dist/legacy \
    && /opt/secheur-python/bin/pip install --no-cache-dir -r /opt/secheur/node_modules/@secheur/agent/dist/requirements-ultracode.txt \
    && rm -f /tmp/repoaudit-pi-extension.tgz /tmp/secheur-agent.tgz \
    && npm cache clean --force

COPY docker/mcp.json /opt/secheur/defaults/mcp.json
COPY .pi/model-router.json /opt/secheur/defaults/model-router.json
COPY docker/repoaudit-smoke.sh /usr/local/bin/repoaudit-smoke
COPY docker/entrypoint.sh /usr/local/bin/secheur-entrypoint

RUN chmod 0755 /usr/local/bin/secheur-entrypoint /usr/local/bin/repoaudit-smoke \
    && mkdir -p /data /workspace /work /opt/repoaudit/log /opt/repoaudit/result /opt/repoaudit/runs /opt/repoaudit/lock \
    && REPOAUDIT_REQUIRE_API_KEY=0 /usr/local/bin/repoaudit-smoke \
    && chown -R node:node /data /workspace /work /opt/secheur /opt/repoaudit /opt/repoaudit-venv

USER node
WORKDIR /workspace

EXPOSE 14168

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:14168/status').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/secheur-entrypoint"]
CMD ["/opt/secheur/node_modules/.bin/secheur-bridge"]
