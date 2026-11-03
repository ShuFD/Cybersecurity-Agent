# AGENTS.md - SecHeur Agent Context Memory & Development Rules

This document serves as the authoritative project context memory, domain architecture guide, and development rulebook for all AI coding agents working on the `SecHeur-Agent-pro` codebase.

---

## 1. Project Mission & Domain Overview

`SecHeur-Agent-pro` is an autonomous cybersecurity and CTF (Capture The Flag) solving agent framework. It is a complete TypeScript/Node.js rebuild of the original Python-based SecHeur Agent, constructed on top of the Pi Agent Harness (`@earendil-works/*`).

The system combines:
1. **Core LLM Agent Loop & Tool Scheduling** (powered by Pi).
2. **Cybersecurity Attack & Exploitation Toolchain** (Web, Binary/Pwn, Reverse Engineering, Cryptography, Forensics, MISC).
3. **CTF Task Tree & Program Plan Runtime** (evidence-driven hypothesis generation, plan expansion, plan revision, and verification).
4. **Autonomous Progress Evaluation & Reflection** (Progress Judge for deadloop prevention, stalled task recovery, and step quality checks).
5. **Flag Validation Oracle & Response Guard** (strict evidence gates to prevent hallucinated submissions).
6. **Domain Attack Memory & Knowledge Retrieval** (vector and keyword-indexed curated CTF attack patterns and vulnerability techniques).
7. **Multi-Agent Coordination & Specialist Roles** (Reviewer, Researcher, Planner, Pwn/Web/Crypto solvers).
8. **Desktop Bridge & Protocol Service** (HTTP/WebSocket UI gateway on port 14168 and Unix socket CBOR protocol server).
9. **Platform & Competition Automation** (integration with `slab-match` and CTF platform APIs for environment management and automated flag submission).

---

## 2. Monorepo Architecture & Core Modules

### 2.1 Directory Map

```text
SecHeur-Agent-pro/
├── packages/
│   ├── secheur-agent/              # SecHeur Application Layer (@secheur/agent)
│   │   ├── src/                    # Runtime, extension hooks, permissions, MCP, bridge, judge
│   │   └── test/                   # Vitest unit and integration suites
│   ├── agent/                      # Pi Agent Core loop, AgentSession, event dispatch (@earendil-works/pi-agent-core)
│   │   └── src/                    # Agent loop, session execution, message models
│   ├── ai/                         # Unified multi-provider LLM interface & streaming (@earendil-works/pi-ai)
│   ├── coding-agent/               # Pi coding agent CLI, TUI engine, extension runners
│   ├── protocol/, client/, server/ # Unix domain socket CBOR protocol service for remote sessions
│   ├── session-backends/
│   │   └── sqlite-node/            # SQLite persistence for protocol session catalog & transcripts
│   ├── telemetry/                  # OpenTelemetry tracing spans and contexts
│   ├── tui/                        # Terminal UI rendering components (node:test)
│   ├── ircopilot-pi-extension/     # Incident Response Copilot extension
│   ├── repoaudit-pi-extension/     # Repository Security Audit extension
│   └── evals/                      # Agent capability evaluation benchmarks
├── legacy/                         # Python Compatibility & CTF Toolset Layer
│   ├── secheur_pi_bridge.py        # IPC JSON-RPC bridge between Node.js and legacy Python tools
│   ├── ctf_attack_memory/          # Curated CTF attack vectors and exploitation patterns
│   ├── memory/                     # Local operational memory & vector knowledge base
│   ├── ctf_verbs/ & web_verbs/     # Specialized attack primitives (SQLi, XSS, SSRF, SSTI, PWN)
│   ├── TMWebDriver.py & simphtml.py# Headless browser automation & HTML inspection
│   ├── flag_oracle.py              # Candidate flag validation oracle
│   ├── task_tree.py & plan_runtime/# Task decomposition and program plan execution
│   └── ctf-mcp/                    # Dedicated Python CTF tool container (GDB, Ghidra, Sage, pwntools)
├── docker/ & docker-compose.yml    # Dual-layer container specs (Node Agent + CTF MCP Toolbox)
└── docs/secheur-rebuild/           # Architecture, deployment, parity matrix, and audit records
```

### 2.2 Core TypeScript Modules (`packages/secheur-agent/src/`)

- **`runtime.ts` (`createSecHeurRuntime`)**: The central entry point. Initializes `AgentSession`, wires `SettingsManager`, `DefaultResourceLoader`, `SessionManager`, telemetry spans, and session policies (e.g. prompt token budget).
- **`extension.ts` (`createSecHeurExtension`)**: Injects SecHeur hooks into the Pi lifecycle:
  - `before_agent_start`: Injects `# SecHeur Agent Integration` system prompt, loads task context, and triggers proactive memory prefetching.
  - `turn_start`: Triggers Progress Judge turn start and synchronizes legacy supervision hooks.
  - `tool_call`: Validates permissions via `PermissionController` and routes through external pre-hooks.
  - `tool_result`: Observes tool outcomes (native, MCP, or legacy), records structured evidence, and injects follow-up reminders.
  - `turn_end`: Invokes legacy turn callbacks and applies Flag Oracle response guards on final answers.
  - `context`: Injects Progress Judge reminders when task progression stalls.
- **`permissions.ts` (`PermissionController`, `PermissionBroker`)**: Enforces execution boundaries:
  - Modes: `default`, `acceptEdits`, `dontAsk`, `bypassPermissions`, and `plan`.
  - Shell Command Risk: Evaluates bash commands via `isDangerousCommand` (blocks destructive system calls) and `isPlanSafeCommand` (permits read-only inspection in Plan Mode).
  - UI/Non-UI Prompting: Asks interactive user confirmation or pauses for remote approval.
- **`mcp.ts` (`McpManager`)**: Manages external stdio and HTTP Model Context Protocol servers. Enforces offline resiliency: connection failures do not block agent boot, background retries use exponential backoff (2s → 60s), and `mcp_refresh` manually re-probes servers.
- **`legacy-host.ts` & `python-runtime.ts` (`LegacyToolHost`)**: Manages the persistent Python subprocess running `legacy/secheur_pi_bridge.py` for tools not yet natively migrated to TypeScript.
- **`progress-judge.ts` (`ProgressJudge`)**: Autonomous judge that analyzes conversation trajectories, evaluates step quality, detects deadloops/stalls, and produces actionable nudges or status updates (`progressing`, `blocked`, `completed`).
- **`flag-oracle.ts` (`FlagOracleClient`)**: Intercepts candidate flags against local or remote validation rules. Prevents hallucinations and premature task termination.
- **`subagent.ts` & `agent-definitions.ts`**: Sub-agent lifecycle and registry. Includes built-in roles (`reviewer`, `researcher`, `planner`) and custom project agents.
- **`bridge.ts` & `bridge-cli.ts`**: High-performance HTTP/WebSocket desktop bridge (default port 14168). Provides REST APIs, SSE/WS event streaming, session management, and settings configuration.
- **`protocol-service.ts` & `protocol-cli.ts`**: Implements durable remote sessions over Pi's CBOR-over-Unix-socket protocol, with session discovery cataloged in SQLite (`sqlite-node`).
- **`blackboard.ts` & `scheduler.ts`**: Shared evidence blackboard and task tree scheduler.
- **`self-test.ts`**: Comprehensive offline health check verifying legacy runtime, bridge HTTP/WS, MCP fixtures, SQLite persistence, and skill discovery.

---

## 3. Key Architectural Invariants

1. **Pi Sole Agent Core Invariant**: Pi (`@earendil-works/pi-agent-core`) is the *only* agent loop, model caller, session state manager, and context compaction runtime. SecHeur is strictly an application layer around Pi. Never duplicate, fork, or reimplement Pi agent loop logic.
2. **Dual Persistence Model**:
   - **JSONL (`SessionManager`)** is authoritative for agent conversation history, branch forks, and context compaction.
   - **SQLite (`sqlite-node`)** is authoritative for remote session catalogs, protocol transcripts, and thinking/model revision states. Active protocol runtimes hold individual writer leases.
3. **MCP Offline Resiliency**: MCP server failures (such as a heavy CTF container being down) must never prevent the agent from starting. Failures log to diagnostics with background exponential backoff reconnects.
4. **Legacy Tool Migration Contract**: Legacy Python tools migrate to native TypeScript one at a time. A Python tool is only removed after equivalent TypeScript unit and contract tests pass. Refer to `docs/secheur-rebuild/parity-matrix.md`.
5. **Security & State Isolation**: Runtime state, sessions, and caches live under `.secheur-agent/` (gitignored). Never commit `.env`, `mykey.py`, API keys, session transcripts, or CTF artifacts.

---

## 4. Technology Stack

- **Runtimes**: Node.js `>=22.19.0`, Python `3.10` - `3.13` (legacy tool runtime).
- **Languages**: TypeScript 5.9.3 (Node strip-only / erasable syntax), Python 3.
- **Monorepo & Package Management**: npm workspaces with strictly pinned dependencies (`npm ci --ignore-scripts`).
- **Build Tools**: `@typescript/native-preview` (`tsgo`), `tsx`, `esbuild`, `shx`.
- **Linter & Formatter**: Biome 2.3.5 (indent: tabs, width: 3, line length: 120).
- **Test Frameworks**: Vitest 4.1.9 (TS unit/integration), `node:test` (TUI & root scripts), Python `unittest`.
- **Database & Storage**: SQLite (`@earendil-works/pi-session-backend-sqlite-node`), JSONL session files.
- **Protocols & Networking**: Unix Domain Socket (CBOR via `pi-protocol`), HTTP/WebSocket bridge (`secheur-bridge`, port 14168), stdio/HTTP Model Context Protocol (MCP).
- **Containerization**: Docker & Docker Compose (dual-layer: Node.js agent + Python CTF MCP toolbox).

---

## 5. Build, Test, and Execution Commands

### 5.1 Installation & Dependencies

```bash
npm ci --ignore-scripts                           # Install dependencies (never run lifecycle scripts unprompted)
npm install --package-lock-only --ignore-scripts  # Refresh package-lock.json safely when dependencies change
```

### 5.2 Build Commands

```bash
npm run build:offline                             # Build all packages without network access (recommended)
npm run build                                     # Standard monorepo build across all workspaces
npm run clean                                     # Clean build artifacts across all workspaces
npm run build --workspace=@secheur/agent          # Build only @secheur/agent
```

### 5.3 Linting & Code Verification

```bash
npm run check                                     # Full gate: Biome check + pinned deps + TS imports + shrinkwrap + install lock + tsgo + browser smoke
npm run check:pinned-deps                         # Check that external dependencies use exact pinned versions
npm run check:ts-imports                          # Verify relative TypeScript imports
npm run typecheck --workspace=@secheur/agent      # Typecheck SecHeur agent workspace
```

### 5.4 Testing Commands

```bash
./test.sh                                         # Full non-e2e test suite in isolated hermetic environment (never run bare `npm test` unprompted)
npm run test --workspace=@secheur/agent           # Run Vitest tests for @secheur/agent
npm run test:scripts                              # Run root node:test script tests
PYTHONPATH=legacy python3 -m unittest discover -s legacy/tests -p 'test_memory_search*.py' # Legacy Python test suite
```

#### Running Specific Tests

- Specific Vitest test:
  ```bash
  node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run <path-to-test>
  ```
- Specific TUI test (`packages/tui` uses `node:test`):
  ```bash
  node --test test/specific.test.ts
  ```

### 5.5 Running Applications & Diagnostics

```bash
npm run secheur -- --help                         # SecHeur CLI
npm run secheur -- self-test                      # Offline self-test (legacy runtime, bridge HTTP/WS, MCP fixture, SQLite, skills)
npm run secheur -- doctor                         # Environment & bundled Python diagnostics
npm run secheur:bridge -- --help                  # Desktop HTTP/WebSocket bridge CLI (default port 14168)
npm run secheur:server -- --help                  # Unix socket protocol service CLI
./pi-test.sh                                      # Interactive TUI test script
```

### 5.6 Docker Commands

```bash
docker compose up -d --build agent                # Run Agent container (port 14168)
docker compose --profile ctf up -d --build        # Run Agent + full CTF toolbox containers
docker compose ps                                 # View container status
docker compose logs -f agent                      # Tail agent container logs
```
*Note: Never run `docker compose down -v` on persistent deployments.*

---

## 6. Coding Standards & Conventions

### 6.1 TypeScript Rules

- **Erasable syntax only**: Code checked by root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`) must use Node strip-only mode:
  - No `enum`, `namespace`/`module`, parameter properties, `import =`, or `export =`.
  - Use explicit class field declarations with constructor assignments.
- **No `any`**: Avoid `any` unless absolutely necessary.
- **No inline imports**: All imports must be top-level (`import ... from "..."`). Never use `await import(...)`, `import("pkg").Type`, or dynamic type imports.
- **Single-line helpers**: Inline single-line helpers that have only one call site.
- **API typing**: Check `node_modules` for external API types; never guess.
- **Generated models**: Never edit `packages/ai/src/models.generated.ts` directly. Update `packages/ai/scripts/generate-models.ts` and run `npm run generate:models`.
- **Configurable keybindings**: Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS`.

### 6.2 Conversational & Review Style

- Keep answers short, direct, and concise.
- No emojis in commits, issues, PR comments, or code.
- No fluff or cheerful filler text.
- Technical prose only. Use simple, precise language.
- Explain non-trivial designs as: problem, concrete trace/example, then solution.
- When the user asks a question, answer it first before making edits or running commands.
- When responding to user feedback or an analysis, explicitly state agree/disagree before describing changes.

### 6.3 Dependency & Install Security

- Direct external dependencies must stay pinned to exact versions.
- When updating `undici`, read its changelog/release notes and evaluate impact before updating.
- Always install locally with `npm install --ignore-scripts` or `npm ci --ignore-scripts`.
- Refresh lockfile with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regeneration, run `node scripts/generate-coding-agent-shrinkwrap.mjs`.
- Lockfile commits require `PI_ALLOW_LOCKFILE_CHANGE=1`.

---

## 7. Git & Multi-Agent Discipline

Multiple agent sessions may run concurrently in this workspace. Follow strict isolation rules:

### Committing

- Only commit files YOU changed in THIS session.
- Stage explicit file paths (`git add <path1> <path2>`); never `git add -A` or `git add .`.
- Always run `git status` before committing to verify staged files.
- Commit message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent,secheur)]: <concise message>`.
- Never commit unless the user explicitly requests it.

### Strictly Prohibited Git Commands

- Never run: `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

### Rebasing & Conflicts

- Resolve conflicts only in files you modified in your session.
- If a conflict occurs in a file you did not touch, abort and ask the user.
- Never force push.

---

## 8. User Override Rule

If the user's explicit instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.

