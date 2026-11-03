# Supervisor parse-error analysis

Affected direct-failed subset cases: `skilift`, `baby_crypt`; diagnostic evidence also includes `throwback`.

## What is established

- `skilift` original run ended `planning_failed` with `supervisor_parse_error`; its diagnostic did not reproduce the parse code but later stopped at `executor_timeout` before a full Supervisor-success trace.
- `baby_crypt` clean replacement still ended `planning_failed/supervisor_parse_error` before worker execution.
- `throwback` diagnostic completed cleanly to `unverified_idle` after 200 turns, so the original parse failure was not reproduced.

## What is not recoverable from durable artifacts

The raw primary Supervisor output and correction output were not persisted in the retained artifacts. Therefore `empty_output`, `prose_only`, `truncated_json`, `multiple_objects`, code-fence use, exact output length, and whether format correction ran cannot be determined without inventing evidence. No parser/prompt change is proposed from those unknowns.

## Conclusion

The evidence supports a real but partly nondeterministic Supervisor protocol failure surface. The first instrumentation patch should persist `attemptType` (primary/format_correction/validation_correction), output length, stop reason, parse result, and final validation error. It should not add unbounded retries or heuristic JSON repair.
