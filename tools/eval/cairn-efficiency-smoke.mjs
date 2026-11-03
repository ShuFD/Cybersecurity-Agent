import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "../../packages/ai/dist/index.js";
import { ModelRuntime } from "../../packages/coding-agent/dist/index.js";
import { loadSecHeurConfig } from "../../packages/secheur-agent/dist/config.js";
import { runPiCodingTask } from "../../packages/secheur-agent/dist/subagent.js";
import { CairnPlanningEngine, cairnRunDirectory } from "../../packages/secheur-agent/dist/planning/cairn/engine.js";
import { CairnHostEvidence } from "../../packages/secheur-agent/dist/planning/cairn/host-evidence.js";
import { PlanningCapacityControl } from "../../packages/secheur-agent/dist/planning/execution-pool.js";

const root = mkdtempSync(join(tmpdir(), "cairn-efficiency-compiled-"));
try {
 const config = loadSecHeurConfig({ projectRoot: root, stateDir: join(root, "state"), env: { PI_OFFLINE: "1" } });
 config.agentDir = join(root, "pi"); config.skillPaths = []; config.systemPromptPath = ""; config.knowledgeBaseEnabled = false;
 config.planning.engine = "cairn";
 const faux = fauxProvider({ providerId: "cairn-efficiency-synthetic", models: [{ id: "local-fixture", reasoning: false }] });
 const credentials = new InMemoryCredentialStore();
 await credentials.modify(faux.provider.id, async () => ({ type: "api_key", key: "synthetic-only" }));
 const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
 modelRuntime.registerNativeProvider(faux.provider); await modelRuntime.refresh({ allowNetwork: false });
 let protocolWork = 0, protocolReports = 0;
 const protocolExtension = { name: "protocol-fixture", factory: pi => {
  for (const name of ["work_step", "required_result"]) pi.registerTool({ name, label: name, description: "Local fixture", parameters: Type.Object({}), execute: async () => {
   if (name === "work_step") protocolWork++; else protocolReports++;
   return { content: [{ type: "text", text: "local observation" }], details: { accepted: true } };
  }});
 }};
 faux.setResponses([
  ...Array.from({ length: 4 }, () => fauxAssistantMessage("Further work remains in this owned task.")),
  context => { assert(context.tools.some(tool => tool.name === "work_step")); return fauxAssistantMessage(fauxToolCall("work_step", {})); },
  fauxAssistantMessage(fauxToolCall("required_result", {})), fauxAssistantMessage("Report persisted.")
 ]);
 const protocol = await runPiCodingTask({ config, cwd: root, model: faux.getModel(), modelRuntime, thinkingLevel: "off", task: "Local protocol repair", allowedTools: ["work_step", "required_result"], extensionFactories: [protocolExtension], requiredToolName: "required_result", requiredToolRecoveryAttempts: 1, continueUntilRequiredTool: true, signal: AbortSignal.timeout(10000) });
 assert.equal(protocolWork, 1); assert.equal(protocolReports, 1);
 assert(protocol.toolExecutions.every(execution => !execution.isError));
 let feedbackSeen = 0, peersSeen = 0, active = 0, peak = 0, verifierStarted = 0, reasonCalls = 0;
 let release;
 const ready = new Promise(resolve => { release = resolve; });
 const draft = { rationaleSummary: "Two independent local fixture checks", proposedIntents: [0,1].map(i => ({ clientId: `local-${i}`, objective: `Check local assumption ${i}`, successCriteria: ["Saved local observation"], rationale: "Independent bounded fixture", fromFactIds: [], sourceHintIds: [], capabilityTags: [], priority: 2-i, supersedesIntentIds: [] })), supersedeRecommendations: [] };
 const call = name => fauxAssistantMessage(fauxToolCall(name, {}));
 faux.setResponses(Array.from({ length: 60 }, () => context => {
  const results = context.messages.filter(message => message.role === "toolResult");
  if (results.some(message => message.toolName === "verify_flag")) return fauxAssistantMessage("Native fixture proof accepted.");
  const errors = results.filter(message => message.toolName === "observe_fixture");
  if (errors.length < 3) return call("observe_fixture");
  if (!results.some(message => message.toolName === "repair_fixture")) {
   assert(JSON.stringify(context.messages).includes("[Host progress feedback]"), "Error repair feedback must reach its owner"); feedbackSeen++;
   return call("repair_fixture");
  }
  assert(JSON.stringify(context.messages).includes("[Shared host evidence references]"), "Peer evidence must reach the executor without rereading the full graph"); peersSeen++;
  return call("verify_flag");
 }));
 const extension = { name: "shared-feedback-fixture", factory: pi => {
  pi.registerTool({ name: "observe_fixture", label: "Observe fixture", description: "Synthetic repeatable error", parameters: Type.Object({}), execute: async () => { await new Promise(resolve => setTimeout(resolve, 30)); throw new Error("Synthetic invalid request: inspect feedback and use repair_fixture"); } });
  pi.registerTool({ name: "repair_fixture", label: "Repair fixture", description: "Synthetic corrected observation", parameters: Type.Object({}), execute: async () => { await new Promise(resolve => setTimeout(resolve, 650)); return { content: [{ type: "text", text: "corrected observation saved" }], details: {} }; } });
  pi.registerTool({ name: "verify_flag", label: "Local verifier", description: "Synthetic native proof", parameters: Type.Object({}), execute: async (_id, _args, signal) => {
   active++; peak = Math.max(peak, active); if (++verifierStarted === 2) release();
   try {
    await Promise.race([ready, new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
    const data = { ok: true, verified: true, status: "correct", challenge_id: "synthetic-local" };
    return { content: [{ type: "text", text: JSON.stringify(data) }], details: { data } };
   } finally { active--; }
  } });
 } };
 const result = await new CairnPlanningEngine({ config, cwd: root, model: faux.getModel(), modelRuntime, thinkingLevel: "off", requireTrustedCompletion: true, capacityControl: new PlanningCapacityControl(2), extensionFactories: [extension], reasonModel: { generate: async () => ({ text: JSON.stringify(++reasonCalls === 1 ? draft : { rationaleSummary: "Keep active owners", proposedIntents: [], supersedeRecommendations: [] }), model: "local-fixture", provider: "local-fixture" }) } }).execute({ outerTaskId: "feedback-fixture", goal: "Synthetic local observations only", signal: AbortSignal.timeout(10000) });
 assert.equal(result.status, "completed"); assert.equal(peak, 2);
 const host = new CairnHostEvidence(join(cairnRunDirectory(config.stateDir, result.runId), "host.sqlite"));
 try {
  const events = host.events(result.runId, 0, 1000).events;
  assert.equal(events.filter(event => event.type === "cairn_executor_error").length, 0);
  assert(events.filter(event => event.type === "cairn_submission_durable" && event.payload.partial).length >= 2);
 } finally { host.close(); }
 assert.equal(feedbackSeen, 2); assert.equal(peersSeen, 2);
 console.log(JSON.stringify({ status: "passed", synthetic: true, compiledPiAndCairn: true, protocolWork, protocolReports, protocolErrors: 0, feedbackSeen, peersSeen, peakExecutors: peak, reasonCalls, trustedProof: true }));
} finally { rmSync(root, { recursive: true, force: true }); }
