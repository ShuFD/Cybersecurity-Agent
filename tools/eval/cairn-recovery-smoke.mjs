import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "../../packages/ai/dist/index.js";
import { ModelRuntime } from "../../packages/coding-agent/dist/index.js";
import { loadSecHeurConfig } from "../../packages/secheur-agent/dist/config.js";
import { CairnPlanningEngine, cairnRunDirectory } from "../../packages/secheur-agent/dist/planning/cairn/engine.js";
import { CairnHostEvidence } from "../../packages/secheur-agent/dist/planning/cairn/host-evidence.js";
import { PlanningCapacityControl } from "../../packages/secheur-agent/dist/planning/execution-pool.js";

const root = mkdtempSync(join(tmpdir(), "cairn-compiled-recovery-"));
try {
 const config = loadSecHeurConfig({ projectRoot: root, stateDir: join(root, "state"), env: { PI_OFFLINE: "1" } });
 config.agentDir = join(root, "pi"); config.skillPaths = []; config.systemPromptPath = ""; config.knowledgeBaseEnabled = false;
 config.planning.engine = "cairn"; config.planning.maxSteps = 1; config.planning.maxTasks = 1; config.planning.taskTimeoutMs = 5;
 const faux = fauxProvider({ providerId: "cairn-compiled-synthetic", models: [{ id: "local-fixture", reasoning: false }] });
 const credentials = new InMemoryCredentialStore();
 await credentials.modify(faux.provider.id, async () => ({ type: "api_key", key: "synthetic-only" }));
 const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
 modelRuntime.registerNativeProvider(faux.provider); await modelRuntime.refresh({ allowNetwork: false });
 const draft = JSON.stringify({ rationaleSummary: "Independent local fixtures", proposedIntents: [0,1].map(i=>({ clientId:`local-${i}`,objective:`Local fixture ${i}`,successCriteria:["Host observation"],rationale:"Independent fixture",fromFactIds:[],sourceHintIds:[],capabilityTags:[],priority:2-i,supersedesIntentIds:[] })),supersedeRecommendations:[] });
 faux.setResponses(Array.from({length:20},()=> context => context.tools?.some(t=>t.name==="submit_planning_proposal") ? fauxAssistantMessage(draft) : context.messages.at(-1)?.role === "toolResult" ? fauxAssistantMessage("Synthetic host observation accepted.") : fauxAssistantMessage(fauxToolCall("verify_flag",{}),{stopReason:"toolUse"})));
 let active=0, peak=0, started=0, turns=0; let release;
 const ready=new Promise(resolve=>{release=resolve;});
 const extension={name:"synthetic-native-verifier",factory:pi=>pi.registerTool({name:"verify_flag",label:"Local verifier",description:"Synthetic fixture observation",parameters:Type.Object({}),execute:async()=>{
  active++; started++; peak=Math.max(peak,active); if(started===2)release();
  try { await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error("Second executor did not start")),2000))]); await new Promise(resolve=>setTimeout(resolve,50)); const data={ok:true,verified:true,status:"correct",challenge_id:"local-fixture"}; return {content:[{type:"text",text:JSON.stringify(data)}],details:{data}}; }
  finally {active--;}
 }})};
 const result=await new CairnPlanningEngine({config,cwd:root,model:faux.getModel(),modelRuntime,thinkingLevel:"off",requireTrustedCompletion:true,capacityControl:new PlanningCapacityControl(2),extensionFactories:[extension],onModelTurn:()=>{turns++;}}).execute({outerTaskId:"compiled-local",goal:"Local synthetic fixtures",signal:AbortSignal.timeout(10000)});
 assert.equal(result.status,"completed"); assert.equal(peak,2); assert.equal(active,0); assert.equal(started,2); assert.ok(turns>=2); assert.equal(result.trustedVerification.verificationOutcome,"correct");
 const host=new CairnHostEvidence(join(cairnRunDirectory(config.stateDir,result.runId),"host.sqlite"));
 try {assert.equal(host.events(result.runId,0,1000).events.filter(e=>e.type==="cairn_executor_error").length,0);} finally {host.close();}
 console.log(JSON.stringify({status:"passed",compiledCairn:true,realPiSessions:true,synthetic:true,peakExecutors:peak,modelTurns:turns,trustedProof:true,obsoleteChildTimeoutMs:5,toolDelayMs:50,executorErrors:0}));
} finally {rmSync(root,{recursive:true,force:true});}
