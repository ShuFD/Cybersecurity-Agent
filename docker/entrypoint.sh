#!/bin/sh
set -eu

state_dir="${SECHEUR_CONFIG_DIR:-/data}"
project_root="${SECHEUR_PROJECT_ROOT:-/workspace}"
mkdir -p "$state_dir"
mkdir -p "$project_root/.pi"

if [ ! -e "$state_dir/mcp.json" ]; then
  cp /opt/secheur/defaults/mcp.json "$state_dir/mcp.json"
  chmod 0600 "$state_dir/mcp.json"
fi

if [ ! -e "$project_root/.pi/model-router.json" ]; then
  cp /opt/secheur/defaults/model-router.json "$project_root/.pi/model-router.json"
  chmod 0600 "$project_root/.pi/model-router.json"
fi

# Doctor never starts a scan or calls a model, but runtime readiness must honor
# the configured credential policy so a service cannot become healthy while
# every RepoAudit scan is guaranteed to fail preflight.
repoaudit-doctor >/tmp/repoaudit-doctor.json

exec "$@"
