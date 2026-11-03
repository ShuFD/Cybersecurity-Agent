# PLAN_SINGLE recovery success patterns

## P1 — persisted-evidence to verifier-only handoff

`misc/avatar` is the clearest handoff case. The replacement run persisted planning evidence/candidate metadata and the parent presentation had only one verifier tool start before `verified_true`. The retained trace does not expose every worker task, so the defensible claim is not that a specific hidden task graph solved it; it is that structured persisted evidence narrowed the parent turn to verification instead of restarting broad investigation.

## P2 — small deterministic task-scoped action

`intercode-ctf/17` persisted one task (`plan_ffdeb6c00a90b02fa4dc364a`) and eight evidence items. The first action calculated the ASCII character from the hexadecimal clue, then the verifier accepted the candidate. This is a concrete `hypothesis -> bounded action -> evidence -> verifier` path with no exploratory loop.

## What is common

- The parent presentation was short (2 turns) and verifier-focused.
- Both successes had one accepted verifier result and no broad tool search in the final handoff.
- The evidence supports context isolation and explicit verification sequencing.

The artifacts do not prove that decomposition alone caused the improvement; infrastructure and model variance remain confounders.
