# Optimization roadmap

Observed baseline: DIRECT 26/35; PLAN_SINGLE fallback recovered 2/9 DIRECT failures; combined 28/35.

Near-term realistic target after targeted P0 fixes: 29-30/35 (conditional, not guaranteed). Stretch target: 31/35 only if terminal handoff and executor startup issues both prove behavioral rather than host noise.

Recommended experiment: run only the nine DIRECT-failed targets affected by the selected patch plus one or two solved regression controls. Do not rerun all 35 in the first iteration.
