# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Read `AGENTS.md` first — it is the authoritative development rulebook (code style, git discipline, dependency security, changelog/release process) and it applies here.** README and `docs/secheur-rebuild/` are in Chinese; code, comments, and AGENTS.md are in English.

## What this repo is

A standalone rebuild of SecHeur Agent (originally Python) on the Pi Agent Harness. The Pi monorepo runtime (from earendil-works/pi-mono, republished with fresh git history) is kept intact; SecHeur exists only as an application layer on top of it. Requires Node >=22.19.0 and Python 3.10–3.13 (for legacy tools).

## Commands

```bash
npm ci --ignore-scripts          # install (never run lifecycle scripts unprompted)
npm run build:offline            # build all packages without network; use `npm run build` when network fetch is OK
npm run check                    # lint + typecheck + all repo checks; fix ALL errors/warnings/infos before committing
./test.sh                        # full non-e2e test suite, hermetic env (never `npm test` directly — e2e activates with API-key env vars)
npm run test --workspace=@secheur/agent          # SecHeur package tests (vitest)
npm run typecheck --workspace=@secheur/agent
PYTHONPATH=legacy python3 -m unittest discover -s legacy/tests -p 'test_memory_search*.py'   # legacy Python tests
```

Single test, from the package root:

```bash
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts
# packages/tui uses node:test instead: node --test test/specific.test.ts
```

Run the app (dev, via tsx — no build needed): `npm run secheur -- --help`, `npm run secheur:bridge -- --help`, `npm run secheur:server -- --help`. Smoke: `npm run secheur -- self-test` (offline, safe) and `secheur doctor` (checks bundled Python env).

Docker: `docker compose up -d --build agent` (port 14168); add `--profile ctf` for the CTF toolbox image. Never `docker compose down -v` on a deployment with data.

## Critical rules (condensed from AGENTS.md)

- After code changes: run `npm run check` with full output. Do not run `npm run build`/`npm test` unless asked.
- TypeScript in root-config-checked paths (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`) must use erasable syntax only (Node strip mode): no `enum`, `namespace`, parameter properties, `import =`/`export =`. No `any`. No inline/dynamic imports — top-level only.
- Never edit `packages/ai/src/models.generated.ts`; edit `packages/ai/scripts/generate-models.ts` and regenerate.
- Direct deps stay pinned to exact versions. Lockfile refresh: `npm install --package-lock-only --ignore-scripts`.
- Git: stage explicit paths only (never `git add -A`/`git add .`); never `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `--no-verify` (multiple agent sessions share this cwd). Commit only when asked. Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <message>`. Lockfile commits need `PI_ALLOW_LOCKFILE_CHANGE=1`.
- Never hardcode keybinding checks; add to `DEFAULT_EDITOR_KEYBINDINGS`/`DEFAULT_APP_KEYBINDINGS`.

## Architecture

Invariant: **Pi is the only agent loop, model caller, context-compaction, and session implementation.** SecHeur adds config, permissions, tools, and APIs around it — never copy or fork Pi core logic into SecHeur code.

Layers (bottom to top):

1. Pi runtime packages: `agent` (pi-agent-core), `ai` (unified LLM API), `tui`, `coding-agent` (CLI/TUI app), `telemetry`, `protocol`/`client`/`server` (CBOR-over-Unix-socket remote sessions), `session-backends/sqlite-node`.
2. `packages/secheur-agent` (`@secheur/agent`) — the application layer. Three bins: `secheur` (CLI that injects SecHeur system prompt + extension, then delegates to the Pi coding-agent CLI), `secheur-bridge` (Desktop HTTP/WebSocket bridge, largest file `src/bridge.ts`), `secheur-server` (Unix-socket protocol service).
3. `legacy/` — versioned Python compatibility layer (CTF tools, browser/TMWebDriver, memory/attack knowledge base, flag oracle). It never owns conversation state and never calls an LLM.

Key `packages/secheur-agent/src/` modules and how they compose:

- `runtime.ts` — `createSecHeurRuntime` wraps a Pi `AgentSession` + `SessionManager` + loaded extensions + SecHeur extension state. Single entry the bridge, protocol service, and CLI all use.
- `extension.ts` — the SecHeur Pi extension: permission hooks (`tool_call`), MCP tools, legacy tools, progress judge, subagents, memory/web-verbs toggles.
- `permissions.ts` — permission modes (default/audit/full/plan) enforced via Pi extension hook; `isDangerousCommand`/`isPlanSafeCommand` shell classification.
- `mcp.ts` — `McpManager` for stdio/HTTP MCP servers. Offline contract: connection failures never block startup; they go to diagnostics and background reconnect with 2s→60s exponential backoff; `mcp_refresh` forces retry. Written for the `ctf-toolbox` container being frequently down.
- `legacy-host.ts` + `python-runtime.ts` — `LegacyToolHost` bridges Python tools via `legacy/secheur_pi_bridge.py`.
- `protocol-service.ts` — durable remote sessions over the Pi protocol. Persistence split: **JSONL (Pi `SessionManager`) is authoritative for agent context/branching/compaction; SQLite is authoritative for session catalog, protocol transcript, and model/thinking state.** Each active protocol runtime holds its own SQLite writer lease.
- `config.ts` / `desktop-config.ts` — runtime config under `<project>/.secheur-agent/` (gitignored); desktop registry stores API profiles, MCP servers, project agents/skills. Pi packages may declare optional Desktop UI assets under a `secheur.desktop` key (registered via `window.SecHeurDesktopPlugins`).
- `self-test.ts` — offline probes (legacy runtime, real bridge HTTP/WS, MCP fixture, protocol + SQLite, skills) behind `secheur self-test [--json]`.

Also in `packages/`: `ircopilot-pi-extension`, `repoaudit-pi-extension` (standalone Pi extensions, not part of the SecHeur runtime), `evals`.

Cross-cutting mechanics:

- Root `tsconfig.json` `paths` and `vitest.base.ts` aliases map all `@earendil-works/*` and `@secheur/agent` imports to **source**, not dist — tests and typecheck run against `src/`.
- `packages/secheur-agent` build stages the Python legacy runtime into `dist/` (`scripts/stage-legacy.mjs`) and `verify-dist.mjs` gates `npm pack` on TypeScript output, the 3 bins, Desktop assets, CTF MCP, skills, and sensitive-file exclusion.
- Migration policy: Python tools are reached through the compat host first and migrate to TypeScript one at a time, only when contract tests match; only then is the Python path removed. `docs/secheur-rebuild/parity-matrix.md` tracks per-capability status — consult it before assuming something is or isn't migrated.
- `.pi/` at the repo root is local Pi-agent config for developing this repo itself (extensions, prompts, skills).

## Testing conventions

- `packages/coding-agent/test/suite/` uses `test/suite/harness.ts` + the faux provider — no real provider APIs, keys, or paid tokens.
- Issue regressions go in `packages/coding-agent/test/suite/regressions/` named `<issue-number>-<short-slug>.test.ts`.
- If you create or modify a test file, run it and iterate until it passes.
- Interactive TUI testing: tmux recipe in AGENTS.md ("Testing pi Interactive Mode"), entry script `./pi-test.sh`.
