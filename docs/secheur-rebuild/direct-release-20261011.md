# DIRECT evaluation release — 2026-10-11

This source snapshot matches the frozen OMEN release `agent-direct-length-recovery-candidate-20261011`. It preserves asynchronous command delivery, durable operational budgets, verifier quota handling, and continuation until trusted success, an external budget, or cancellation.

Length-truncated turns yield to Pi's native settlement and compaction before resuming. Queuing recovery follow-ups inside every truncated turn previously prevented compaction until the parent turn budget was exhausted.

Validation performed against this exact source:

- 57 relevant regression tests passed; build and formatting checks passed.
- The previous version reproduced the compaction failure in an offline fixture.
- The compiled fixture compacted before the resumed tool call and completed in 4 turns.
- The same 50-target DIRECT evaluation completed normally: 39 verified successes, 6 verification-budget exhaustion results, and 5 wall-clock timeouts. The preceding run had 26 successes; an earlier individual run had 33. These are individual runs, not the historical merged best.

Source hashes and the existing acceptance record are under `docs/secheur-rebuild/releases/`. OMEN-specific launch and status helpers are under `tools/eval/omen-20261011/`. They retain the server's absolute paths and require its existing credential/configuration setup; credentials and evaluation transcripts are not included.

PLAN is preserved separately on `snapshot/plan-permission-fixed-20261011`. These snapshots have not been combined, and publishing them does not deploy or restart a service.
