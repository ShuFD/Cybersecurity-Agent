# Terminal contract error analysis

`intercode-ctf/56` replacement ended `planning_failed/terminal_contract_error`. The final parent message says the Supervisor could not finish without valid persisted answer evidence, but the retained artifact does not contain a persisted `planning-flag-candidate` or a canonical verifier result. Therefore the current evidence cannot distinguish an actually wrong solution from an over-strict/missing evidence handoff.

Classification: **terminal evidence handoff failure is established; verifier over-strictness is only a hypothesis**. The smallest next diagnostic is to persist candidate count/evidence references and distinguish `no_candidate`, `candidate_unverified`, and `candidate_rejected`; do not weaken the verifier gate.
