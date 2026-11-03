import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "../../packages/ai/dist/index.js";
import { ModelRuntime } from "../../packages/coding-agent/dist/index.js";
import { loadSecHeurConfig } from "../../packages/secheur-agent/dist/config.js";
import { createSecHeurExtension, sharePlanningVerifierState } from "../../packages/secheur-agent/dist/extension.js";
import { OperationalGuard } from "../../packages/secheur-agent/dist/operational-guard.js";
import { PiPlanningExecutor } from "../../packages/secheur-agent/dist/planning/pi-adapters.js";
import { planningExecutorExtensionBundle } from "../../packages/secheur-agent/dist/planning/session-controller.js";

const root = mkdtempSync(join(tmpdir(), "planning-background-compiled-"));
const config = loadSecHeurConfig({ projectRoot: root, stateDir: join(root, "state"), env: { PI_OFFLINE: "1", SECHEUR_PYTHON: "/opt/secheur-agent-python/bin/python" } });
config.executionMode = { ...config.executionMode, mode: "plan_multi" };
config.judge.enabled = false; config.knowledgeBaseEnabled = false;
const identity = { challengeId: "synthetic/background", runId: "synthetic-only" };
const parent = createSecHeurExtension({ config, trustedTaskIdentity: identity });
parent.state.operationalGuard = new OperationalGuard(config.stateDir, "synthetic-only");
const saved = []; const checkpoints = []; const children = []; let turns = 0, completionMessages = 0, earlyIdle = 0;
async function attempt(index) {
 const path = join(root, `fixture-${index}.txt`);
 const faux = fauxProvider({ models: [{ id: `background-worker-${index}`, reasoning: false }] });
 const credentials = new InMemoryCredentialStore();
 await credentials.modify(faux.provider.id, async () => ({ type: "api_key", key: "synthetic-only" }));
 const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
 modelRuntime.registerNativeProvider(faux.provider); await modelRuntime.refresh({ allowNetwork: false });
 let child;
 faux.setResponses([
  fauxAssistantMessage(fauxToolCall("bash", { command: `sleep 0.${index + 3}; printf synthetic-${index} > '${path}'`, run_in_background: true })),
  () => { assert.equal(child.state.commandTasks.pendingCount, 1); earlyIdle++; return fauxAssistantMessage("Background fixture is processing; awaiting its completion event."); },
  context => {
   const completed = context.messages.filter(m => /Command task [0-9a-f-]+ \(bash\) completed/.test(JSON.stringify(m.content)));
   assert.equal(completed.length, 1, "Exactly one automatic completion message must reach its owner");
   assert.equal(child.state.commandTasks.pendingCount, 0); completionMessages++;
   return fauxAssistantMessage(fauxToolCall("read", { path }));
  },
  fauxAssistantMessage(fauxToolCall("planning_commit_result", { outcome: "done", summary: "Synthetic output consumed after completion.", suggestedTasks: [], flagCandidates: [] })),
  fauxAssistantMessage("Local fixture objective complete."),
 ]);
 const executor = new PiPlanningExecutor({ config, cwd: root, model: faux.getModel(), modelRuntime, thinkingLevel: "off", onModelTurn: () => { turns++; }, createExtensionBundle: scope => {
  assert.equal(scope.leaseId, `lease-${index}`);
  child = createSecHeurExtension({ config, subAgentDepth: 1, commandTaskScope: scope.leaseId, permissionMode: "bypassPermissions", trustedTaskIdentity: identity, requireTrustedChallengeId: true, ctfContinuation: { taskKind: "ctf", verificationState: "not_attempted", consecutiveNoToolTurns: 0 } });
  sharePlanningVerifierState(parent.state, child.state); children.push(child);
  const bundle = planningExecutorExtensionBundle(child.extension, () => child.state.close());
  bundle.backgroundTasks = { hasPending: () => Boolean(child.state.commandTasks?.pendingCount), waitForSettlement: signal => child.state.commandTasks.waitForSettlement(signal), settledExecutions: () => child.state.commandTasks?.settledExecutions() ?? [] };
  return bundle;
 } });
 const now = Date.now();
 const report = await executor.execute({ goal: "Read local synthetic fixtures through owned background commands.", lease: { schemaVersion: 1, leaseId: `lease-${index}`, runId: "synthetic-only", taskId: `task-${index}`, planRevision: 1, objective: "Create and read the local fixture.", doneWhen: "Fixture output has been consumed and committed.", allowedScope: root, issuedAt: now, expiresAt: now + 10000 }, context: "Offline harness fixture; no benchmark content.", recordEvidence: item => saved.push(item), recordCheckpoint: (_id, item) => { checkpoints.push(item); return item; }, signal: AbortSignal.timeout(10000) });
 assert.equal(report.result.outcome, "done"); assert.equal(readFileSync(path, "utf8"), `synthetic-${index}`);
 assert.equal(faux.state.callCount, 5, "Completion must not create extra polling or recovery calls");
 assert(report.evidence.some(e => e.toolName === "read" && !e.metadata.isError), JSON.stringify(report.evidence));
 assert.equal(report.evidence.filter(e => e.metadata.toolCallId.startsWith("background-completion:")).length, 1);
}
try {
 await Promise.all([attempt(1), attempt(2)]);
 assert.equal(checkpoints.length, 2); for (const checkpoint of checkpoints) { assert.equal(checkpoint.evidenceRefs.length, 1); assert(saved.some(e => e.evidenceId === checkpoint.evidenceRefs[0])); assert.equal(checkpoint.suggestedNextSteps.length, 0); } assert.equal(earlyIdle, 2); assert.equal(completionMessages, 2); assert.equal(turns, 10);
 assert.equal(children[0].state.operationalGuard, parent.state.operationalGuard);
 assert.equal(children[1].state.operationalGuard, parent.state.operationalGuard);
 console.log(JSON.stringify({ status: "passed", realPiSessions: true, synthetic: true, workers: 2, idleWithLiveJobs: earlyIdle, completionMessages, modelTurns: turns, pollingCalls: 0, localReports: 2, persistedHostCheckpoints: checkpoints.length, checkpointEvidenceExists: true, wholeTaskProofFabricated: false }));
} finally { for (const child of children) await child.state.close(); await parent.state.close(); rmSync(root, { recursive: true, force: true }); }


