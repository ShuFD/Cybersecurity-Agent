# DIRECT vs PLAN_SINGLE — intercode-ctf/56

## Outcome

- DIRECT: `wall_clock_timeout`; 197 turns / 62 tools
- PLAN_SINGLE: `planning_failed`; 0 turns / 0 tools
- Outcome class: **REGRESSION**

## Difference

planning could not finish with valid persisted answer evidence; no durable candidate shows whether gate was over-strict

## Bottleneck

LOOPING/TOOL_MISUSE -> TERMINAL_CONTRACT_ERROR — planning could not finish with valid persisted answer evidence; no durable candidate shows whether gate was over-strict
