# PLAN integration and corrections, 2026-10-24

This change keeps shared verification history, task checkpoints, evidence references,
canonical artifact registration and the fourth Artex PLAN engine.

Native proposal schema failures are diagnostic events only. They increment
`nativeSchemaRejections`, independently of the existing semantic rejection budget.
Two native failures, or one native plus one semantic failure, no longer exhaust
the two-semantic-rejection stop boundary. Pi's normal execution limits still apply.

Progressive and Hypothesis supervisor task-division guidance is restored to the
version before the final optimization round. The newer mandatory single-owner
wording is removed. Partial artifact publication and registration remain available.

The Artex batch queue keeps its own metadata private with umask 077, and explicitly
starts both preflight and execution controller children with umask 022. This matches
the established runner: worker-mounted directories must be readable by UID 1000.
It does not change system permissions, worker identity or model credentials.

The reproducible queue scripts and their synthetic tests are under
`tools/eval/artex-queue/`. Their deployment paths are explicit constants; preparing
an already existing batch is refused, and prior evaluation data is not replaced.

Artex design and source attribution are documented in `artex-plan.txt` and
`artex-reference.json`. Production activation and evaluation results are separate
from this source publication.

Publication validation: 244 targeted Agent/WebUI tests and 17 Node startup/UI
checks pass on the merged source, together with Agent/WebUI typechecks, the
frontend production build and distribution verification. The seven Linux queue
tests and an offline UID-1000 mount-read check also passed before the startup fix
was used. These checks do not establish a live challenge success rate.
