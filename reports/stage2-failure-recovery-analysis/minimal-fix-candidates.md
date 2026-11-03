# Minimal fix candidates (proposal only)

## P0-A — Supervisor protocol observability and bounded correction

- Affects: `skilift`, `baby_crypt`, diagnostic `throwback`.
- Minimal change: persist primary/format-correction/validation attempt metadata and final error; keep one correction maximum.
- Risk: low; regression tests must preserve cancellation and provider failure taxonomy.
- Expected gain: likely 0-1 recovered case, not guaranteed.

## P0-B — Terminal evidence handoff diagnostics

- Affects: `intercode-ctf/56`.
- Minimal change: persist candidate count, evidence references, and canonical verifier-attempt state; distinguish missing candidate from rejected candidate.
- Risk: do not alter acceptance gate; low-to-medium.
- Expected gain: possible 0-1 if the blocker is handoff rather than solving.

## P0-C — Executor startup/settlement lifecycle evidence

- Affects: `rpgo`, `skilift` diagnostic, possibly `stfu`.
- Minimal change: expose child-session start/first-output/abort/settlement boundaries and fence late commits; do not alter timeout values.
- Risk: medium; targeted lifecycle tests required.
- Expected gain: possible 0-1; evidence is currently insufficient to promise recovery.

## P1 — advisory fallback signals

Use no-new-evidence/repeated-tool-pattern/verifier-rejection signals only as logged, bounded advice. No new hidden retry or scheduler policy in this forensic stage.

## P2 — larger architecture changes

Task graph/scheduler/PLAN_MULTI/context redesign is not justified by this nine-target sample.
