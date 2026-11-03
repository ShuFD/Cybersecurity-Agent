#!/usr/bin/env bash
# slab-match.sh — thin wrapper around the slab-match competition API.
#
# Auth: reads SLAB_MATCH_HOST and SLAB_AGENT_ACCESSKEY from
#   /workspace/.secheur-agent/competition.env (default path) or from
#   the environment directly. Both are required.
#
# All subcommands return JSON on stdout, exit non-zero on transport error
# or on response code != "00000". See legacy/.agents/skills/slab-match/SKILL.md
# and api_doc.md for the full contract.
#
# Usage:
#   slab-match info
#   slab-match overview
#   slab-match exercises
#   slab-match exercise <id>
#   slab-match build-env <id>
#   slab-match recover-env <id>
#   slab-match answer <id> "<flag>"
#   slab-match notice-list
#   slab-match notice-detail <id>

set -euo pipefail

ENV_FILE="${SLAB_COMPETITION_ENV:-/workspace/.secheur-agent/competition.env}"
if [[ -r "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi

: "${SLAB_MATCH_HOST:?SLAB_MATCH_HOST not set (set in competition.env)}"
: "${SLAB_AGENT_ACCESSKEY:?SLAB_AGENT_ACCESSKEY not set (set in competition.env)}"

BASE="${SLAB_MATCH_HOST%/}/slab-match/api/v1/agent"
HDR=(-H "X-Agent-AccessKey: ${SLAB_AGENT_ACCESSKEY}")
CT='-H Content-Type:application/json'

# call: invoke the API and check envelope
#   $1: method (GET|POST)
#   $2: path (with leading /)
#   $3: optional json body
call() {
  local method="$1" path="$2" body="${3-}"
  local args=(-sS -X "$method" "${HDR[@]}" "$BASE$path")
  if [[ -n "$body" ]]; then
    args+=( "$CT" -d "$body" )
  fi
  local resp
  resp="$(curl "${args[@]}")" || { echo "slab-match: transport error to ${method} ${path}" >&2; return 2; }
  local code
  code="$(printf '%s' "$resp" | jq -r '.code // "transport"')"
  if [[ "$code" != "00000" ]]; then
    printf '%s\n' "$resp" >&2
    return 1
  fi
  printf '%s\n' "$resp" | jq -c '.data'
}

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
  exit 64
}

[[ $# -ge 1 ]] || usage

cmd="$1"; shift || true

case "$cmd" in
  info)            call GET /match/notice/match-info ;;
  overview)        call GET /answer-panel/overview ;;
  exercises)       call GET /ctf/exercise-list ;;
  exercise)
    [[ $# -ge 1 ]] || { echo "usage: slab-match exercise <id>" >&2; exit 64; }
    call GET "/ctf/exercise?exerciseId=$1" ;;
  build-env)
    [[ $# -ge 1 ]] || { echo "usage: slab-match build-env <id>" >&2; exit 64; }
    call POST /ctf/build-exercise-env "$(jq -nc --argjson id "$1" '{exerciseId:$id}')" ;;
  recover-env)
    [[ $# -ge 1 ]] || { echo "usage: slab-match recover-env <id>" >&2; exit 64; }
    call POST /ctf/recover-exercise-env "$(jq -nc --argjson id "$1" '{exerciseId:$id}')" ;;
  answer)
    [[ $# -ge 2 ]] || { echo "usage: slab-match answer <id> <flag>" >&2; exit 64; }
    call POST /answer-panel/answer "$(jq -nc --argjson id "$1" --arg f "$2" '{exerciseId:$id,flag:$f}')" ;;
  notice-list)     call GET /match/notice/now-list ;;
  notice-detail)
    [[ $# -ge 1 ]] || { echo "usage: slab-match notice-detail <id>" >&2; exit 64; }
    call GET "/match/notice/detail?id=$1" ;;
  -h|--help|help)  usage ;;
  *)
    echo "slab-match: unknown subcommand '$cmd'" >&2
    usage >&2
    ;;
esac