#!/usr/bin/env bash
set -euo pipefail
export HTTP_PROXY=http://127.0.0.1:17898 HTTPS_PROXY=http://127.0.0.1:17898
export http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY"
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
uv=/home/seu/controller-runtime/bin/uv
python=/home/seu/controller-runtime/python/cpython-3.11-linux-x86_64-gnu/bin/python3.11
test ! -e /opt/secheur-agent-python || test -x /opt/secheur-agent-python/bin/python
if test ! -x /opt/secheur-agent-python/bin/python; then
    "$uv" venv --python "$python" /opt/secheur-agent-python
fi
"$uv" pip install --python /opt/secheur-agent-python/bin/python \
    'requests>=2.28' 'beautifulsoup4>=4.12' 'bottle>=0.12' 'simple-websocket-server>=0.4' 'aiohttp>=3.9'
"$uv" pip freeze --python /opt/secheur-agent-python/bin/python
runuser -u pi-eval -- /opt/secheur-agent-python/bin/python -c 'import sys, requests, bs4, bottle, simple_websocket_server, aiohttp; assert (3,10) <= sys.version_info[:2] < (3,14); print("pi-eval Python core imports passed")'
