---
name: slab-match
description: Drive the SecHeur agent through the slab-match CTF competition platform API — pull match info, list challenges, fetch details, start/recover target environments, submit flags, and auto-persist writeups. Use whenever the user mentions the match, "slab-match", the competition API, "X-Agent-AccessKey", or wants to start solving today's challenges.
allowed-tools: Bash Read Write Edit Glob Grep Task WebFetch WebSearch
---

# slab-match

End-to-end driver for the slab-match competition API described in `/workspace/docs/api_doc.md` (always open that file first when you need exact field shapes; the script and this skill assume you have it). Credentials come from `SLAB_MATCH_HOST` (e.g. `https://example.com`) and `SLAB_AGENT_ACCESSKEY` in `/workspace/.secheur-agent/competition.env`. Auth header on every call: `X-Agent-AccessKey: <key>`.

A thin wrapper script is bundled alongside this skill at `/workspace/skills/slab-match/slab-match.sh`. Prefer invoking it via the Bash tool — it handles auth header construction, JSON envelopes, `code == "00000"` checks, and uniform error output. All output is JSON unless noted.

## Subcommands

| Subcommand | Endpoint |
| --- | --- |
| `slab-match info` | `GET /match/notice/match-info` |
| `slab-match overview` | `GET /answer-panel/overview` |
| `slab-match exercises` | `GET /ctf/exercise-list` |
| `slab-match exercise <id>` | `GET /ctf/exercise?exerciseId=<id>` |
| `slab-match build-env <id>` | `POST /ctf/build-exercise-env` |
| `slab-match answer <id> <flag>` | `POST /answer-panel/answer` (raw call, no persistence, **no auto-recover**) |
| `slab-match submit <id> <flag>` | answer + **auto recover-env on success** + persist `{id,name,flag,submittedAt,answerResponse}` to `/workspace/writeups/<id>-<name>.meta.json` |
| `slab-match writeup-save <id> <md-file>` | copy a generated writeup markdown to `/workspace/writeups/<id>-<name>.md` |
| `slab-match notice-list` | `GET /match/notice/now-list` |
| `slab-match notice-detail <id>` | `GET /match/notice/detail?id=<id>` |

> ⚠️ **`slab-match recover-env` is intentionally NOT in this table.** The skill does not expose it as a free-form command. Recover only happens inside `submit` after a correct flag. If you must abandon a challenge without submitting, call `slab-match recover-env <id>` directly — but **never** run it as a "cleanup" step after solving. Running it manually after solving destroys the target you just used and forces a useless rebuild.

The wrapper exits non-zero on `code != "00000"` so you can chain it in shell pipelines. Use `slab-match info` as the very first call every session to read match rules and notes.

## Recommended workflow

1. **Bootstrap**:
   ```bash
   slab-match info                        # match notes + rules (READ THESE first)
   slab-match overview                    # current score + rank
   slab-match exercises                   # full exercise list (category + corpus)
   slab-match notice-list                 # announcements since session start
   ```
   Pick one challenge and announce it: category (Web / Crypto / Pwn / Reverse / Misc / …) and exercise id.

2. **Inspect the chosen challenge**:
   ```bash
   slab-match exercise <id>               # description, attachments, endpoints, isNeedInit, isNeedCheck
   ```
   If `attachment.files[]` is non-empty, `curl -fLO <url>` each into `/work/<challenge-id>/` (shared with the ctf-toolbox MCP) so heavy tools (Ghidra, Sage, pwndbg) can reach it. Do not unpack to `/workspace` if the file is large.

3. **Stand up the target environment** when `isNeedInit=true`:
   ```bash
   slab-match build-env <id>
   # poll until isNeedCheck=false and endpoints[] is populated:
   while true; do
     slab-match exercise <id> | jq '{isNeedCheck, isNeedInit, endpoints}'
     sleep 5
   done
   ```
   Note the connection info: `endpoints[].exposeIps[]`, `ports[]`, `users[]`, `portMappings[]`, `expireTime`. Do not start a second `build-env` while one is in flight.

4. **Solve**: route to the right legacy skill via `solve-challenge` or jump straight to the matching `ctf-<category>` skill (`ctf-web`, `ctf-crypto`, `ctf-pwn`, `ctf-reverse`, `ctf-forensics`, `ctf-misc`, `ctf-osint`, `ctf-malware`, `ctf-ai-ml`). Run recon from `/work/<challenge-id>/` and interact with the target via `endpoints[].exposeIps[]:ports[]`. If `isProxy=true`, prefer the `proxyIps[]:portMappings[].proxy` host instead — the platform reverse-proxies traffic for you.

5. **Extract the flag** (use `legacy/flag_oracle_client.py`-style normalization: `flag\{[^}]{1,256}\}` plus the scoreboard's own conventions). Verify with `grep -Eo` before submitting.

6. **Submit the flag — `submit` handles everything else**:
   ```bash
   slab-match submit <exerciseId> "<flag>"
   ```
   What `submit` does atomically:
   - Normalizes the flag wrapper (`DASCTF{...}` / `flag{...}` / bare → bare inner content)
   - POSTs to `/answer-panel/answer`
   - On `isCorrect=true`: calls `/ctf/recover-exercise-env` automatically so the next challenge can build-env without contention, then writes `/workspace/writeups/<id>-<name>.meta.json` containing `{exerciseId,name,flag,submittedAt,answerResponse}`
   - On `isCorrect=false`: non-zero exit, stderr shows the platform message — **the target is NOT recovered** so you can keep debugging
   - On recover-env failure (rare): a WARNING is logged but the `.meta.json` is still written

   **Do NOT call `recover-env` yourself after a correct submit.** `submit` already did it. Calling it again just adds API noise. **Do NOT call `recover-env` after a wrong submit either** — you still need the target.

   **Use `slab-match submit`, not `slab-match answer`** — `submit` is the persistent + auto-cleanup variant.

7. **Generate the writeup markdown** (after submit succeeds):

   - Save a complete `writeup-<exerciseId>.md` to a tmp path, e.g. `/tmp/writeup-<id>.md`
   - Then run:
     ```bash
     slab-match writeup-save <exerciseId> /tmp/writeup-<id>.md
     ```
     This copies the file to `/workspace/writeups/<id>-<name>.md` (host bind mount — visible on host at `runtime/workspace/writeups/`).
   - Use the legacy `ctf-writeup` skill (or write your own) for the markdown body — must cover: challenge metadata, vulnerability analysis, exploit steps, key commands, lessons.

   The two artifacts that will land on the host after step 7:
   - `runtime/workspace/writeups/<id>-<name>.meta.json`  (auto, from `submit`)
   - `runtime/workspace/writeups/<id>-<name>.md`         (auto, from `writeup-save`)

   Move on to the next challenge: target is already cleaned up by `submit`'s auto-recover.

## Rules of engagement

- **NEVER** call `slab-match recover-env` after solving — `submit` already did it. Manually re-running recover after a correct submit is a useless no-op (or worse, an extra API hit on a quota-tracked endpoint).
- **NEVER** call `recover-env` after a wrong submit — you still need the target to debug.
- **Only** call `recover-env` manually when abandoning a challenge you will not solve (e.g. wrong category, time-boxed decision).
- **Never** call `submit` / `answer` with a truncated flag, the hex of a hash, or a placeholder string — the response is final and the API logs the attempt.
- **Never** call `build-exercise-env` while one is in flight for the same id; poll `exercise <id>` instead.
- **Never** modify the `userName`/`createdTime` fields of any notice — those are platform-owned.
- `competition.env` is the only place to put credentials; never echo them into a writeup or commit them.
- `api_doc.md` is the authoritative spec; if this skill disagrees with the file, the file wins.
- When `currentTime` exceeds `endpoints[].expireTime`, the target is gone — `build-env` again (or `submit` will do it for you on success).
- Per match rules, **each flag has a 50-submit cap**. Recover and rebuild rather than resubmitting identical wrong guesses.

## Failure modes

- HTTP 401 → check `SLAB_AGENT_ACCESSKEY` is non-empty and matches the platform-issued key (rotate via the match platform if you suspect leak).
- `code != "00000"` but HTTP 200 → the platform rejected the request (stale id, wrong role, exhausted env quota, rate-limit 40409); the `message` field tells you which.
- Connection refused → `SLAB_MATCH_HOST` host is unreachable; check `RUNTIME_HTTP_PROXY` and `NO_PROXY` (`llm-gateway.dasctf.com` and the match host should both be reachable from the agent container).
- `slab-match submit` exits non-zero → the `.meta.json` was NOT written; re-investigate before re-submitting. (recover-env may or may not have run depending on where it failed.)
- `/workspace/writeups/` not writable → check the host bind mount `runtime/workspace/writeups/` exists and is `chown -R 1000:1000`.
- Target disappeared mid-solve → either `currentTime > expireTime` (auto-expired) or someone ran `recover-env` on it. Check `slab-match exercise <id>` and rebuild with `build-env` if needed.
