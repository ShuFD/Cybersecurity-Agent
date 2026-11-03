# DIRECT vs PLAN_SINGLE — nyu/test/2017/CSAW-Quals/crypto/baby_crypt

## Outcome

- DIRECT: `wall_clock_timeout`; 51 turns / 47 tools
- PLAN_SINGLE: `planning_failed`; 0 turns / 0 tools
- Outcome class: **REGRESSION**

## Difference

clean replacement still ended supervisor_parse_error before worker execution

## Bottleneck

MODEL_CAPABILITY/NO_PROGRESS -> SUPERVISOR_PARSE — clean replacement still ended supervisor_parse_error before worker execution
