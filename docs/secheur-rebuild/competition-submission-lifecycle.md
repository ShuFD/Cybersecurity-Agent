# Real competition submission lifecycle

The trusted verdict comes from the broker's platform submission, not local verify_flag/check_flag, a candidate acknowledgement, a completed event, or model prose. Non-competition verification is unchanged.

## Behavior

- The binding records acceptance only for a submit_request response with accepted=true, submission.category=accepted, isCorrect=true, a record ID, and matching immutable task/assignment IDs.
- The tool sets Pi's existing terminate flag. Later tools are blocked after acceptance; the existing provider/dispatch guard prevents another model request for a mixed batch. Legacy continuation cannot reopen an accepted task. Main and unrelated solvers keep running.
- Desktop session state becomes verificationState=accepted / terminalReason=verified_true. Late progress or completed events cannot overwrite broker solved state.
- Incorrect returns feedback.category/message/nextAction, remainingAttempts and canContinue. With budget left and no evidence-audit block, the solver remains running and sees the feedback before its next turn. It can investigate, record new evidence and submit a corrected candidate. An exhausted budget settles without claiming success.
- Rate limits, unavailable/unknown platform responses and transport errors are distinct from incorrect answers. Retry metadata is retained. Ambiguous request failures still reserve a submission attempt; this fix does not blindly refund or resubmit them.
- Accepted environment-release failure does not undo success. It remains in broker events; DesktopSolverManager retries an owned retained lease and reports incomplete cleanup separately.

## Limits

Reuse the general competition adapter's existing fallback of three local attempts; private adapter options/access.maxAttempts can override it. An explicit Main budget or platform policy remains authoritative. Do not overwrite persisted budgets, reset attempts, or infer unlimited submissions from an absent remote quota. No timing, concurrency, planner or evidence parameters changed.

## Offline acceptance

The regression fixture test/fixtures/competition-accepted-continuation-20261019.json contains only persisted timestamps, session IDs and tool names from four local runs. It excludes answers, arguments, credentials and challenge content. These traces previously continued 654–4363 seconds after acceptance. Replay covers the submission boundary and previously observed continuation; it does not replay solving or make performance claims.

Tests use real Pi sessions with an offline fake model and a real local CBOR broker backed by temporary SQLite, plus mocked platform transport for the Windows adapter/manager. Cover incorrect → corrected → accepted, accepted plus later tools in one batch, legacy verifier routing, budget exhaustion, malformed acceptance, unrelated task isolation, and environment cleanup failures. Native verification and protocol regressions are compared against the unchanged base when failing.

Build typed source from this revision before copying the Windows overlay. Do not hot-replace a running process or overwrite private configuration/history. No real submissions, environments, model API calls, deployment, batch restart or Git push are part of this offline change.
