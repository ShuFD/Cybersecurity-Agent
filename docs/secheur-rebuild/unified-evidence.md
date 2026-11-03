# Shared PLAN evidence foundation

This change extracts the hypothesis mode's existing evidence capture and semantic cards. Progressive, Cairn and hypothesis mode use the same repository and card validation. Planning, graph mutation, scheduling, model configuration, retries and completion authority remain with their existing owners.

## Storage and compatibility

- `tool-evidence.ts` captures host-owned tool results with the existing blob format, stable IDs, hashes, redaction and completeness flags.
- `evidence-cards.ts` owns raw index insertion and semantic card storage. It operates on either existing SQLite driver without introducing a service or dependency.
- Progressive/hypothesis keep `planning_evidence`, existing IDs and paths. New cards live in `planning_evidence_cards`; historical DAG cards remain readable from the graph JSON in place.
- Cairn writes new observations to the same `planning_evidence` schema and blob format in its run directory. Old `tool_evidence`/`tool_inputs` rows remain readable by ID and through legacy cursors. New observations are not also written to those legacy tables.
- Storage is shared code and format, not one database mixing different challenge runs.

## Ownership and publication

- The host captures originals. Evidence/card queries and semantic publication are excluded from raw capture to avoid recursion.
- Executors can call `planning_publish_evidence_card` and `planning_list_evidence_cards` in all three modes.
- Existing supported Progressive checkpoint/result summaries and Cairn Fact deliveries are also exposed as cards. Reports without original tool references remain reports, not fabricated evidence cards.
- Cairn delivery cards retain `cairnFactId` for lookup from Fact to card. The graph remains authoritative for Fact/Intent state; its existing statement is preserved for old consumers.
- Hypothesis observations use the shared card constructor. Hypothesis verdict checks, graph versioning and limits remain in the hypothesis module. Publishing a generic card does not resolve a hypothesis.
- Cards preserve references and host-derived source hashes. `observed`/`inferred` is an executor declaration, not host semantic verification. Native goal verification remains separate.

## Parameters

| Parameter | Value | Origin |
| --- | --- | --- |
| Raw result excerpt | 4 KiB | Existing evidence store |
| Model raw read maximum | 64 KiB for existing byte-based API | Existing evidence store; legacy Cairn character-based read contract remains compatible |
| Blob capture cap | 8 MiB of original serialized payload | Existing evidence store; larger inputs retain marked head/tail envelopes |
| Derived delivery preview | 600 characters | Existing hypothesis task-delivery preview |
| Card summary | Aim for 30–50 characters | User requirement; not a hard rejection bound |
| Card paging | Default 20, maximum 100 | ARTEX `list_facts` reference |
| Card payload safeguard | 20,000 serialized characters | Existing hypothesis observation bound |
| Large key values in planner preview | Detail omitted above 512 serialized characters, reference retained | Existing hypothesis view; full card retains the value |

Explicit cards keep their full accepted summary and exact key values. Automatically derived delivery previews are marked as previews; full deliveries remain in checkpoints/results or the Cairn graph. No new automatic model summarizer, background compactor, vector store or cross-run memory is introduced.

Numerical `inputTokens`, `outputTokens`, `totalTokens`, `cacheReadTokens` and `cacheWriteTokens` survive redaction. Credential fields, including other token-shaped names, retain the existing redaction behavior.

## Validation boundary

Offline tests cover real Pi tool dispatch with a faux model, original evidence round trips, Unicode, duplicate callbacks, historical IDs/cursors, restart reads, scope isolation, paging, oversized/incomplete blobs, tampering and separation of tool errors from verified success. Existing recorded model-error metadata is replayed through the three adapter paths; this is not a replay of a complete solving session or an online model evaluation.

Implementation and tests take place in an isolated checkout. Deployment, live problem solving and GitHub publication require their own explicit task.

## Reference

ARTEX source snapshot `f3e3f54b6c93916388a0a3dc6a439893a9abe37a`:
https://github.com/Hinln/ARTEX/blob/f3e3f54b6c93916388a0a3dc6a439893a9abe37a/agent/tools.go

Only the paging values and separation principles are referenced. No ARTEX implementation is copied into this module.
