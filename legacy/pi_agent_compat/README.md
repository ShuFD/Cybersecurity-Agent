# Pi planning compatibility layer

This directory migrates the current evidence-grounded planning kernel into the
Pi-based `@secheur/agent` package without replacing Pi's conversation loop,
session manager, model calls, compaction, or tool scheduler.

The release builder replaces only these legacy-host modules:

- `task_descriptor/`
- `plan_runtime/`
- `task_tree.py`
- `secheur_pi_bridge.py`

`error_handler.py` and `flag_oracle.py` are preserved by default so deployment
does not overwrite newer server hotfixes. They can be replaced explicitly with
`--include-adjacent-modules` when the source versions have been reviewed.

At task start, the bridge parses one `TaskDescriptor`, persists it, and passes
the same object to CTF Context, Task Tree, and Program Plan. Tool results from
both Pi-native/MCP tools and legacy-hosted tools update one task-scoped
`ProgressController`.

Duplicate detection is observational in the Pi integration. It adds replan and
stop guidance to tool results but does not skip a Pi-scheduled call. A hard stop
for legacy-hosted tools can be enabled explicitly with
`SECHEUR_PROGRESS_HARD_STOP=1`; it is disabled by default.

Build a migrated npm archive:

```powershell
python legacy/pi_agent_compat/build_release.py BASE.tgz OUTPUT.tgz
```

The output includes `dist/legacy/planning-migration-manifest.json` with the
strategy, safety defaults, and SHA-256 hashes of every replaced file.
