# PLAN_SINGLE failure taxonomy

- **SUPERVISOR_PARSE** (2): skilift,baby_crypt. Priority P0; impact removes two hard Planning aborts; one diagnostic was nondeterministic; severity high; complexity low; expected gain likely 0-1.
- **EXECUTOR_STARTUP_TIMEOUT** (1): rpgo. Priority P0; impact can restore a run that never reached a worker turn; severity medium; complexity medium; expected gain possible 0-1.
- **TERMINAL_CONTRACT_ERROR** (1): intercode-ctf/56. Priority P0; impact may recover a near-solve if evidence handoff, not solution quality, was the blocker; severity medium; complexity medium; expected gain possible 0-1.
- **INFRA_UNRESOLVED** (2): 22-back-to-the-past,noisy-crc. Priority separate; impact not a Planning behavior signal; severity high; complexity medium; expected gain not a code gain.
- **PLANNING_RUNTIME_TIMEOUT_UNKNOWN** (1): stfu. Priority P1; impact needs lifecycle evidence before a behavior patch; severity high; complexity high; expected gain speculative 0-1.
- **NO_IMPROVEMENT_OR_MODEL_CAPABILITY** (2): rpgo,stfu. Priority P1; impact may remain hard after infrastructure fixes; severity high; complexity high; expected gain speculative.
- **RECOVERED** (2): avatar,intercode-ctf/17. Priority observed; impact demonstrates fallback value; severity observed; complexity low; expected gain already counted.
