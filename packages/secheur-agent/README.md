# SecHeur Agent on Pi

SecHeur Agent is the application layer for this Pi monorepo. Pi remains the only
agent loop, model, JSONL session, and TUI runtime. SecHeur adds the existing
permission modes, MCP tools, CTF/browser integrations, memory, skills, sub-agents,
progress judging, and the desktop compatibility API.

The `secheur-server` entry point exposes durable SecHeur sessions through the Pi
Unix-socket protocol. Protocol session discovery, normalized transcripts, and
model/thinking state use SQLite, while Pi JSONL sessions remain authoritative for
agent context, branching, and compaction. The CLI and desktop bridge keep their
existing direct runtime paths.

SecHeur injects Pi telemetry into runtime creation and prompts. Provider requests
run under the active prompt span, so callers can supply a `TelemetryContext`
without changing provider configuration.

During migration, Python-only tools run through the versioned compatibility host
under `../../legacy/`. They do not own conversation state or call an LLM.

```bash
npm ci --ignore-scripts
npm run build:offline
npm run secheur -- --help
npm run secheur:server -- --help
```

Runtime configuration remains under `<project>/.secheur-agent/`. Secrets are not
copied into this repository. Pi credentials remain in its normal auth store.

## Main Agent and WebUI

`secheur` starts the official Pi Agent TUI and names that session `Main Agent`.
It owns the competition coordinator, task preparation layer, competition plan,
attempt budgets, solver dispatch, and solver guidance. The Pi agent loop and
session runtime remain the single source of truth.

Start the Main Agent first, then start the attach-only bridge in another shell:

```bash
npm run secheur -- --model router/auto
npm run secheur:bridge
```

Open `http://127.0.0.1:14168/` for the WebUI. The WebUI discovers the Main Agent
and independent solver Pi sessions through the local session registry and uses
Pi's Unix-socket client protocol for prompts, steering, model changes, and
transcript updates. `secheur launch` is the equivalent bridge command. It does
not create a second agent loop or hidden scheduler.

## Ultracode orchestration

SecHeur includes an optional Pi mode plugin. A run creates five independent Git
worktrees, executes five isolated Pi coding sessions with the configured DeepSeek
model, ranks their transcripts with `llm-verifier`, validates the selected worktree,
and applies only the winner patch to the Main Agent worktree. A non-Git directory or
fewer than two successful candidates stops without applying a result.

Use it from the TUI, CLI, bridge session, or any Pi client that exposes extension
commands:

```text
/ultracode
/ultracode status
/ultracode once implement the requested change and add focused tests
/ultracode on
/normal
```

`/ultracode` and `--ultracode` enable continuous mode for the session;
`/ultracode status` reports its state. The normal mode is explicit;
`/ultracode once <task>` is safer for a single request. Candidate and verifier models
are resolved from the active Pi model catalog. Set `ULTRACODE_AGENT_MODEL` or
`ULTRACODE_VERIFIER_MODEL` to `provider/model` when a custom DeepSeek provider is
used. The verifier uses the Pi model's `baseUrl` and auth resolution; optional
`ULTRACODE_VERIFIER_API`, `ULTRACODE_VERIFIER_BASE_URL`, `ULTRACODE_VERIFIER_API_KEY`, and
`ULTRACODE_VERIFIER_HEADERS` override them without changing `auth.json`. Set
`ULTRACODE_VERIFIER_WHOLE_ENDPOINT=1` for gateways that accept the complete
request URL instead of an OpenAI-compatible base URL.
Candidate Pi sessions use `max` reasoning by default so DeepSeek can adapt its
effort to the task. Set `ULTRACODE_THINKING_LEVEL` to `off`, `minimal`, `low`,
`medium`, `high`, `xhigh`, or `max` to override it.
The winner gate also supports `ULTRACODE_FLAG_VERIFY=auto|required|off`. In `auto`
mode, a configured Flag Oracle is called for CTF tasks with a challenge ID and the
winner is applied only after `correct=true`; `required` fails closed when the oracle
is unavailable. A local verification command should print one candidate flag to
stdout, rather than merely matching a flag-shaped regular expression.

The package also exposes `@secheur/agent/ultracode` as a Pi package entry, so another
Pi agent can install the release package and load the same extension. That agent
needs Git and a Python environment containing `llm-verifier==0.2.0` (the SecHeur
Docker image installs it automatically).

## Competition Orchestration

Set `SLAB_MATCH_HOST=https://pro.dasctf.com`, `SLAB_MATCH_ID=1629`, and
`SLAB_AGENT_ACCESSKEY` for the DASCTF Agent API. The web page
`https://gcsis.dasctf.com/1629` supplies the match ID; it is not the API host.
The Main Agent syncs open unsolved challenges through its explicit workflow,
keeps its own Pi session plus one independent solver Pi session per dispatched
challenge, and limits environment-backed work to three tasks. Attachment-only
challenges run without that limit.

### Main-controlled Scheduling

The Main Agent does not start hidden workers. Ask it to sync the competition,
inspect tasks, persist an ordered plan, ask for one batch attempt budget, and
explicitly dispatch solver TUI sessions. Each solver runs in its own tmux window,
keeps its own official Pi session, and reports evidence and submissions through
the broker. Solvers remain independently attachable from the WebUI while they
are idle or working.

For a host installation:

```bash
npm run secheur -- --model router/auto
npm run secheur:bridge
curl -fsS http://127.0.0.1:14168/competition
curl -fsS http://127.0.0.1:14168/competition/tasks
```

Use the WebUI at `http://127.0.0.1:14168/` for the live competition task view and operator
controls. The task controls are read-only status views in managed mode; plan,
budget, dispatch, guide, stop, and replan actions go through the Main Agent.

The Docker `agent` image starts the attach-only bridge. Run the Main Agent in a
process that shares the same project and state directories before opening the
WebUI; otherwise the WebUI reports that no Main Agent is registered.

The WebUI shows task status, the explicit attempt budget, solver failure events,
the active Pi session, plan revision, and broker evidence. Selecting a task with
an attached solver opens that solver's Pi transcript. Main Agent and solver
sessions can also be inspected with `GET /sessions` or the Pi Unix protocol.

`attempts` counts only platform answer submissions, not model guesses. A failed
or blocked item can be requeued by the Main Agent after reviewing evidence.

Correct submissions call the platform answer endpoint, recover the environment,
and persist writeup metadata. Wrong answers retain the environment. The Main
Agent and solver Pi sessions use the same broker database and session registry;
the WebUI is an observer/controller client and never creates a competing loop.

## Pi and Desktop UI plugins

The Desktop settings panel installs, updates, enables, and removes normal Pi
packages. A trusted Pi package can also declare optional Desktop UI assets:

```json
{
  "pi": { "extensions": ["./index.js"] },
  "secheur": {
    "desktop": {
      "styles": ["./desktop/plugin.css"],
      "scripts": ["./desktop/plugin.js"]
    }
  }
}
```

Asset paths must be relative files inside the installed package. Styles must use
the `.css` extension and scripts must use `.js`; real-path checks reject directory
traversal and symbolic links outside the package. Assets are available only while
the Pi package is enabled.

Desktop scripts register synchronously through
`window.SecHeurDesktopPlugins.register({ setup, decorate, destroy })`. The shared
host observes `#messages`, calls `decorate(root)` after conversation DOM updates,
and calls cleanup hooks before unloading a disabled or removed plugin. Desktop
scripts run with page privileges, so install them only from sources trusted to run
as Pi extensions.

MCP failures do not block runtime startup. Failed HTTP or stdio servers are
reported through diagnostics, can be retried with `mcp_refresh`, and are retried
in the background with bounded exponential backoff.

Check the bundled Python compatibility runtime before using legacy browser, CTF,
memory, or flag-oracle tools:

```bash
secheur doctor
```

The doctor output includes exact bootstrap commands when Python 3.10-3.13 or a
required package is missing. The generated environment lives under
`<project>/.secheur-agent/python/` and is selected automatically on the next run.

## Offline self-test

Run `secheur self-test` to verify the local install without touching the
network, real providers, or any production config. Every probe uses a temporary
workspace and is safe to run on developer machines, CI runners, and post-install
smoke jobs:

```bash
secheur self-test         # human-readable report, exit 0 on success
secheur self-test --json  # machine-readable report (same exit code contract)
```

Each step prints its `id`, `label`, `durationMs`, and `error` if it failed.
Coverage:

| Step | What it checks |
| ---- | -------------- |
| `legacy-runtime` | `inspectLegacyEnvironment` — bundled Python interpreter, required modules, `secheur_pi_bridge.py`, tool schema. |
| `legacy-tool-search`, `legacy-list-files`, `legacy-attack-memory` | Real `LegacyToolHost` calls into the Python bridge. |
| `bridge-http` | `SecHeurBridge` on a random port; fetches `/status`, `/`, `/app.js`. |
| `bridge-websocket` | Raw HTTP/1.1 upgrade handshake against `/ws`. |
| `mcp-fixture` | Spawns `test/fixtures/mcp-stdio-fixture.ts`, exercises `tools/list`, `tools/call` with `structuredContent`, then closes the manager and reconnects. |
| `protocol` | Unix-socket protocol server + SQLite, faux provider; session ID + transcript survive a close/reopen. |
| `skills` | Discovers `SKILL.md` files under `config.skillPaths`. |

The `--json` output mirrors the `SelfTestReport` type exported from
`@secheur/agent` so CI can attach the report as a build artifact.

### Programmatic use

```ts
import { runSelfTest, formatSelfTestJson } from "@secheur/agent";

const report = await runSelfTest({ projectRoot: process.cwd() });
console.log(formatSelfTestJson(report));
process.exit(report.ok ? 0 : 1);
```

Individual probes (`probeBridgeHttp`, `probeBridgeWebSocket`, `probeMcpFixture`,
`probeProtocol`, ...) are also exported for targeted regressions; see
`src/self-test.ts`.
