# OSV in the CTF solver workflow

The competition solver has a native `osv_query` tool. It is intentionally not
registered in ordinary agent sessions or in the Main Agent coordinator session.
The solver decides whether a target is public software before it queries OSV.

## Classification

`target_type` is required for every call:

- `constructed_ctf`: skip the query. Use this for task-specific code, services,
  scripts, binaries, or flag wrappers that have no public software identity.
- `real_world_software`: query OSV after collecting exact package/version,
  versioned PURL, or full Git commit evidence. A CTF challenge that wraps a
  public release may use this classification.
- `uncertain`: the solver asks the operator through the normal Pi UI or bridge
  permission queue. The tool remains pending until the operator selects a
  classification; there is no automatic timeout decision.

## Input

The tool accepts up to 20 targets. Each target must use exactly one selector:

```json
{
  "target_type": "real_world_software",
  "targets": [
    {
      "package_name": "demo-package",
      "ecosystem": "npm",
      "version": "1.2.3",
      "evidence_refs": ["package-lock.json:42"]
    },
    {
      "purl": "pkg:pypi/demo-package@1.2.3",
      "evidence_refs": ["poetry.lock:18"]
    },
    {
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "evidence_refs": ["git rev-parse HEAD"]
    }
  ]
}
```

Package queries require `package_name`, `ecosystem`, and `version`. PURLs must
contain a version. Commit selectors must be full 40 or 64 character hashes.
Every target needs at least one non-empty `evidence_refs` entry.

## API behavior

The client uses the public OSV API without credentials:

- `POST {OSV_API_URL}/v1/querybatch` for the batch lookup.
- `GET {OSV_API_URL}/v1/vulns/{id}` for bounded vulnerability details.
- `OSV_API_URL` defaults to `https://api.osv.dev`.
- Requests have a 10 second timeout and retry transient HTTP 429/5xx errors
  once.
- Details are fetched with at most four concurrent requests. Results are capped
  at 50 unique vulnerability IDs and three query pages.
- The process-local cache lasts 10 minutes. Tool text is capped at 24 KB.

The response contains vulnerability IDs, summaries, modified timestamps,
severity values, affected ranges, fixed versions, references, and bounded
warnings. Raw long-form OSV `details` are not returned to the model.

## Evidence and submission

Each queried target produces one broker `observation` event with source
`osv.dev`. The event references the supplied version evidence and OSV
vulnerability pages. A zero-result response and an unavailable API response
are recorded distinctly; unavailable must never be interpreted as "no known
vulnerability".

OSV data is advisory intelligence. It does not prove that the challenge target
is affected, exploitable, or associated with a flag. The solver must establish
local or remote exploit evidence before using the existing competition flag
submission flow.
