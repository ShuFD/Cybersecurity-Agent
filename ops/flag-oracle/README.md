# Flag Oracle host sources

These files are the source-controlled copies of three independent Python
services/scripts on the Ubuntu evaluation host. They are **not** part of the
agent release bundle:

| Repository file | Installed path |
| --- | --- |
| `server.py` | `/opt/secheur-flag-oracle/server.py` |
| `sync_from_ctf_field.py` | `/opt/secheur-flag-oracle/sync_from_ctf_field.py` |
| `secheur_verify_proxy.py` | `/usr/local/lib/secheur-verify/secheur_verify_proxy.py` |

The 2026-10-02 fix treats Field target IDs as opaque printable strings, so
titles containing spaces, `?`, or brackets can be registered and verified.
The sync script passes all gold answers through JSON stdin; answer values must
never appear in command arguments, logs, Git, or test fixtures. The proxy
reports Oracle HTTP 400 as `invalid_request` rather than `unavailable`.

Run `test_oracle_ids.py` with the host Oracle virtualenv against temporary
fixture data before deploying. `preflight-oracle.sh` reads the root-only gold
store and checks that the five affected target IDs are selectable without
writing the database. `deploy-oracle.sh` requires root and an absolute staging
directory containing the three Python files. It backs up the old sources,
root-only environment file, and a consistent SQLite snapshot under `/root/`,
installs the new sources, restarts both services, registers the five missing
targets, and checks health and accepted-digest counts. An error triggers
rollback. Never run these scripts from an agent container or copy the backups
into the repository.

Deployment does not submit a candidate Flag or consume a verification attempt.
It does not rerun any evaluation challenge; benchmark reruns must use their own
separate batch and results ledger.
