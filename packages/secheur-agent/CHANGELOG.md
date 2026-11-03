Purpose: Pi bridge session and terminal-contract runtime support.

- Align Cairn Reason generation with CairnPilot's stateless Pi completeSimple adapter and reuse it for progressive Supervisor. Retain separate Proposal schemas/validation; pass Cairn output tokens as request options instead of cloning model metadata. Executors still use the shared Pi AgentSession runtime.

- Retain Pi ownership through idle after rejected abort, close cancelled resources on either settlement outcome, and release PLAN_MULTI slots after rejected cleanup. Add a rolling stale-proposal characterization without rejecting evidence-only state changes.

- Fix Cairn reuse/new-launch shared slot accounting; retry contested reservations through rolling scheduling instead of waiting with a live claim. Check actionable Reason work without a history-page limit, and scope Graph write idempotency to Solver/Intent/session attempts.
- Add opt-in `planning.engine=cairn`, adapted from CairnPilot b015733, alongside the unchanged default progressive engine. Both use the existing Pi coding runtime and global Executor pool; Graph/Intent persistence and result protocols remain separate.
- Connect Graph-triggered replanning, rolling Intent scheduling, per-session capacity changes, sequential Solver conversation reuse, durable checkpoints/results and host-saved tool evidence. Idle conversations release execution slots; shutdown waits for Worker and tool settlement.
- Expose both engines through the existing builtin-plugin toggle route and export Cairn lifecycle metadata through the existing Planning Trace endpoint. DIRECT and historical shadow retain their prior entry routes.

- Added trusted CTF verifier terminal-contract propagation.
- Add watchdog phase tracking and controlled cancel, pause, and resume lifecycle metadata.
- Add opt-in PLAN_MULTI execution with bounded parallel leases, per-attempt Pi workspaces, provenance-preserving handoff, and same-run native verifier serialization/deduplication; retain DIRECT and PLAN_SINGLE routing.
- Fix PLAN_MULTI trusted-success/quota arbitration, allow explicit same-run tool evidence to support analysis-only tasks, and retain cancelled Pi resources/host slots until actual idle settlement with bounded caller cleanup.
- Add rolling PLAN_MULTI planning while sibling Executors continue, append-only plans during active leases, and live per-session/shared capacity controls; shrinking never cancels running Executors, and DIRECT/PLAN_SINGLE keep their existing routes.
- Defer recoverable rolling Proposal failures until existing work changes durable state, and surface sibling persistence faults even during trusted-terminal drain; retain trusted proof and parent-cancellation precedence.
