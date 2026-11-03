# PLAN candidate source publication — 2026-10-16

This publication merges server candidate source onto `04e39ea8af4886c35d85144590bc4f95e07b0664`.
It publishes code for review and reproduction. It does not deploy or change running services.

## Sources and behavior

- `agent-hypothesis-candidate-20261014-r2`: optional `hypothesis` planning engine, with at most four unresolved hypotheses globally and two on each dependency path. Reuses planning storage, evidence, leases, executor pool and Pi sessions. Evidence-backed observations resolve hypotheses; summaries alone do not establish truth.
- `agent-model-service-repair-20261016`: Cairn submission schema aligned with host limits; namespace-aware selection catalogs; compact planner board; Observer final-call submission boundary; bounded read caching and coverage metadata; structured model failure diagnostics.
- Host evaluation helpers: separate credentials per lane, persistent quota admission, quota refresh before new work, model failure classification, planning timeline audit and opt-in private Life environment.
- Shared proposal-session integration preserves both the hypothesis engine's disabled context queries and the board-only planner policy. No additional model loop was introduced.
- Four pre-existing test fixture type errors were corrected without changing knowledge retrieval or execution behavior.

Only source, tests and bounded historical metadata fixtures are included. Credentials, runtime state, session transcripts, results, attachments and account ledgers are excluded. Source snapshots and production services remain unchanged.

## Validation of the merged source

- Full offline workspace build passed; compiled Agent validation reported 125 modules, four executables and 347 legacy runtime files.
- Agent source and test TypeScript project passed.
- Thirteen focused test files / 130 tests passed: hypothesis graph and host validation, Cairn submission repair, native proposal sessions, model recovery, trace metadata, Observer boundaries and planning concurrency.
- Linux evaluation checks passed: quota health 10, credential admission 16, model failure diagnostics 10, planning audit 2 (38 total).
- Built sandbox runner contract test passed; relative TypeScript import and browser smoke checks passed.
- Changed TypeScript files passed Biome checks; informational style suggestions remain.
- Explicit staged source scan checks for literal API keys, private keys, unresolved merge markers and enterprise-encrypted file headers.

These are offline and fixture-based checks, not a replay of an entire original solve or a new merged-version live benchmark.

## Known limits

- Transport resets are unresolved. Both MiniMax and DeepSeek smoke logs contain upstream stream errors; this release does not claim to fix their root cause.
- Historical DeepSeek hypothesis smoke scored 3/4, but used the frozen hypothesis candidate before this source merge. That result is not acceptance of this merged build.
- Existing knowledge-coordinator tests have 11 runtime failures outside this change; their implementation was not modified.
- The repository-wide pinned-dependency check reports the pre-existing wildcard `typebox` dependency in `.pi/extensions/repoaudit-pi-extension/package.json`. No dependency or lockfile was changed.
- The host evaluation controller is Linux-specific (`fcntl`, Docker and Unix verifier socket). Windows quota-health tests pass, but Windows admission cleanup/import failures are not represented as Linux failures.
- Observer remains opt-in. The frozen evaluation worker forces it off; no live Observer performance benefit is asserted.
- No new full50 batch, production deployment, network configuration change or competition solve was performed for publication.
