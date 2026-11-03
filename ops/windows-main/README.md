# Windows Main Agent runtime delivery

This directory preserves the actual Windows desktop Main integration deployed on 2026-10-19. It is a runtime overlay, not a completed TypeScript source migration. The existing frontend Main-selection fix is already in commit `de895c8`.

`runtime/` contains eight Windows overlay JavaScript modules (updated for competition verdict lifecycle on 2026-10-20); `runtime-manifest.json` records their SHA256 hashes. They add a local Main bridge, Windows named-pipe broker transport, desktop solver sessions, authenticated attachment access, environment lifecycle handling, and platform `/api/v1/verify` submission. The private adapter is configured for the selected 20 challenges and three environment slots. Starting the bridge restores Main history but does not automatically dispatch work.

## Existing Windows installation

The installed launcher is `D:\SecHeur-Agent\Start-SecHeur.ps1`. It opens the local frontend at `http://127.0.0.1:14168/` with Main selected. Main and solvers share the frontend; the title does not imply a separate native EXE.

The launcher assumes an existing installation with `runtime/node.exe`, the complete app and dependencies, a private platform access file, and the workspace state directory. This overlay is not a standalone installer. `Start-SecHeur.ps1` is included as the deployed reference, with no embedded credentials.

Do not copy the overlay into a running agent. Before manually applying it to a stopped, backed-up installation, first rebuild the typed source from this same revision, then apply the overlay and verify the recorded runtime hashes. The new extension, broker and solver binding must be rebuilt too; copying only these eight overlay files over an older installation does not install the submission fix. Keep private configuration, SQLite databases, conversations, model keys and platform access tokens outside Git. A normal source rebuild will replace the runtime overlay; migrating these changes into typed source remains outstanding.

## Offline verification

Point `SECHEUR_TEST_RUNTIME_DIR` to a complete prepared agent `dist` directory containing the overlay and its normal dependencies, then run `node --test ops/windows-main/test/desktop-main.test.mjs`. The test checks all eight deployed module hashes before importing them. Tests use synthetic inputs and mocked platform responses; they do not start Main, submit real answers or create environments.

Validation on 2026-10-19: 18 tests passed, no failures or skips; all eight JavaScript syntax checks and the launcher PowerShell parser check passed. Credential-pattern scanning found no matching keys in the delivery files. No new solve run was started for this publication.

## Known limitations

- Main retains general execution tools; strict coordinator-only tool isolation has not been implemented.
- Unattended solver `ask_user` waits can end in `host_watchdog` termination.
- Platform acceptance now terminates the bound solver through the existing Pi tool-result contract, suppresses local-oracle continuation, and preserves solved state. Incorrect submissions return feedback and the remaining explicit budget; see `../../docs/secheur-rebuild/competition-submission-lifecycle.md`.
- A request error may consume the broker submission budget; this delivery does not claim that issue fixed.
- A stopped task must be explicitly requeued before desktop dispatch.
- Runtime restoration retains conversations, but does not resume interrupted model or tool execution automatically.

These are delivery limitations, not passing solve-rate claims. Historical run outcomes are excluded from this package.

The private adapter uses the existing general adapter fallback of three local attempts instead of a hard-coded one. Set `maxAttempts` in private access configuration or adapter options to choose an explicit local ceiling. This is not a claim about a remote contest quota. Main-assigned budgets, existing persisted one-attempt budgets, platform limits and anti-guessing rules are still enforced; existing tasks are not silently changed.
