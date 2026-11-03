import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "../../packages/ai/dist/index.js";
import { ModelRuntime } from "../../packages/coding-agent/dist/index.js";
import { loadSecHeurConfig } from "../../packages/secheur-agent/dist/config.js";
import { createSecHeurExtension, sharePlanningVerifierState } from "../../packages/secheur-agent/dist/extension.js";
import { OperationalGuard } from "../../packages/secheur-agent/dist/operational-guard.js";
import { PiPlanningExecutor } from "../../packages/secheur-agent/dist/planning/pi-adapters.js";
import { planningExecutorExtensionBundle } from "../../packages/secheur-agent/dist/planning/session-controller.js";

const root = mkdtempSync(join(tmpdir(), "plan-efficiency-compiled-"));
const config = loadSecHeurConfig({ projectRoot: root, stateDir: join(root, "state"), env: { PI_OFFLINE: "1", SECHEUR_PYTHON: "/opt/secheur-agent-python/bin/python" } });
config.executionMode = { ...config.executionMode, mode: "plan_multi" };
config.judge.enabled = false; config.knowledgeBaseEnabled = false;
const identity = { challengeId: "synthetic/latency", runId: "synthetic-only" };
const parent = createSecHeurExtension({ config, trustedTaskIdentity: identity, requireTrustedChallengeId: true });
parent.state.operationalGuard = new OperationalGuard(config.stateDir, "synthetic-only");
let turns = 0;
const children = [];
async function attempt(index) {
 const path = join(root, `fixture-${index}.txt`); writeFileSync(path, `synthetic witness ${index}`);
 const faux = fauxProvider({ models: [{ id: `compiled-worker-${index}`, reasoning: false }] });
 const credentials = new InMemoryCredentialStore();
 await credentials.modify(faux.provider.id, async () => ({ type: "api_key", key: "synthetic-only" }));
 const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
 modelRuntime.registerNativeProvider(faux.provider); await modelRuntime.refresh({ allowNetwork: false });
 faux.setResponses([
  async () => { await new Promise(resolve => setTimeout(resolve, 250)); return fauxAssistantMessage(fauxToolCall("read", { path })); },
  fauxAssistantMessage(fauxToolCall("planning_commit_result", { outcome: "done", summary: "Synthetic fixture read and persisted.", suggestedTasks: [], flagCandidates: [] })),
  fauxAssistantMessage("Fixture complete."),
 ]);
 const executor = new PiPlanningExecutor({ config, cwd: root, model: faux.getModel(), modelRuntime, thinkingLevel: "off", onModelTurn: () => { turns++; }, createExtensionBundle: () => {
  const child = createSecHeurExtension({ config, subAgentDepth: 1, trustedTaskIdentity: identity, requireTrustedChallengeId: true });
  sharePlanningVerifierState(parent.state, child.state); children.push(child);
  return planningExecutorExtensionBundle(child.extension, () => child.state.close());
 } });
 const now = Date.now();
 const report = await executor.execute({ lease: { schemaVersion: 1, leaseId: `lease-${index}`, runId: "synthetic-only", taskId: `task-${index}`, planRevision: 1, objective: "Read the synthetic fixture and persist the observation.", doneWhen: "A structured fixture report is committed.", allowedScope: root, issuedAt: now, expiresAt: now + 60_000 }, context: "Offline harness fixture; no benchmark target content.", signal: AbortSignal.timeout(20_000) });
 assert.equal(report.result.outcome, "done"); assert.equal(report.commitSource, "planning_commit_result");
 assert(report.evidence.some(e => e.toolName === "read" && e.metadata.isError === false));
 return faux.state.callCount;
}
try {
 let start = performance.now(); await attempt(1); await attempt(2); const serialMs = performance.now() - start;
 start = performance.now(); await Promise.all([attempt(3), attempt(4)]); const parallelMs = performance.now() - start;
 assert.equal(turns, 12);
 assert.equal(parent.state.operationalGuard.reserveVerification("SYNTHETIC_ONLY"), "allowed");
 assert(parent.state.operationalGuard.toolCallsUsed >= 8);
 assert(parallelMs < serialMs, "Independent compiled Pi workers must overlap");
 console.log(JSON.stringify({ status: "passed", compiledPiExecutor: true, tasks: 4, modelTurns: turns, toolCalls: parent.state.operationalGuard.toolCallsUsed, sharedEvidenceReachedParent: true, serialMs: Math.round(serialMs), parallelMs: Math.round(parallelMs), speedup: +(serialMs / parallelMs).toFixed(2), syntheticDelayMs: 250 }));
} finally { for (const child of children) child.state.close(); parent.state.close(); rmSync(root, { recursive: true, force: true }); }
