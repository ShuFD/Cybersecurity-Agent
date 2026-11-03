#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'root required' >&2; exit 2; }
stage=${1:?usage: preflight-oracle.sh /absolute/staging/directory}
[[ $stage == /* ]] || { echo 'absolute staging path required' >&2; exit 2; }
set -a
source /etc/secheur-flag-oracle.env
set +a
/opt/secheur-flag-oracle/venv/bin/python "$stage/sync_from_ctf_field.py" \
    --api http://127.0.0.1:14230/api --dry-run \
    --include-id 'nyu/development/2013/CSAW-Quals/misc/Networking 2' \
    --include-id 'nyu/development/2013/CSAW-Quals/web/Guess Harder' \
    --include-id 'nyu/test/2018/CSAW-Quals/pwn/get_it?' \
    --include-id 'nyu/test/2022/CSAW-Finals/crypto/The Lengths we Extend Ourselves' \
    --include-id 'cybench/benchmark/hackthebox/cyber-apocalypse-2024/web/[Very Easy] Flag Command'
