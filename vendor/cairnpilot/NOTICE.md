# CairnPilot source provenance

Source: https://github.com/sxd-git1/cairnpilot
Revision: b015733fa117aa35f2406b8b31fd1bbf84d3ec6e
License: Apache-2.0 (included as LICENSE).

The Graph, Reasoner, Scheduler, intent lifecycle, Graph tool schemas and Host
handler in packages/secheur-agent/src/planning/cairn are adapted from this
revision. Modifications: Node SQLite/filesystem instead of Bun, erasable
TypeScript, explicit .ts imports, TypeBox/Pi 0.84.1 and in-process Host transport.
The legacy Board difference helper is omitted; existing SecHeur memory is not
migrated. Solver observer candidate tooling is not a second agent runtime.
New SecHeur host integration files are engine.ts, solver.ts, host-types.ts and
host-evidence.ts. No Cairn UI, Docker runtime, credentials or challenge data is
included.

packages/secheur-agent/src/planning/proposal-model.ts also adapts the source
packages/core/src/graph/reason-model.ts: identical JSON-only system prompt,
single user message, Pi completeSimple generation and text extraction/error
handling. The current Pi ModelRuntime API retains this application's configured
provider/auth resolution; no Cairn credentials or ConfigManager are copied.
Both Cairn Reasoner and progressive Supervisor use that generation function.
Their schemas and semantic validators remain separate.
