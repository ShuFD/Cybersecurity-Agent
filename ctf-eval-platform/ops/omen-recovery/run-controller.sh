#!/usr/bin/env bash
set -euo pipefail
export UV_PYTHON_INSTALL_DIR=/home/seu/controller-runtime/python
controller_python=$(/home/seu/controller-runtime/bin/uv python find --managed-python 3.11)
controller_config=/home/shared/eval-runner/bridge-eval-controller.json
args=("$@")
for ((index=0; index<${#args[@]}; index++)); do
    if [[ "${args[index]}" == --config ]]; then
        controller_config="${args[index+1]}"
    fi
done
"$controller_python" /home/shared/eval-runner/prepare-controller-workspace.py "$controller_config"
exec "$controller_python" /home/shared/eval-runner/bridge_eval_controller.py "$@"
