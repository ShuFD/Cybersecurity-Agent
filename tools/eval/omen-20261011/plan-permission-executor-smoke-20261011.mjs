import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from '/home/shared/agent-rebuild/app-releases/agent-plan-recovery-candidate-20261011/packages/ai/dist/index.js';
import { ModelRuntime } from '/home/shared/agent-rebuild/app-releases/agent-plan-recovery-candidate-20261011/packages/coding-agent/dist/index.js';
import { loadSecHeurConfig } from '/home/shared/agent-rebuild/app-releases/agent-plan-recovery-candidate-20261011/packages/secheur-agent/dist/config.js';
import { PiPlanningExecutor } from '/home/shared/agent-rebuild/app-releases/agent-plan-recovery-candidate-20261011/packages/secheur-agent/dist/planning/pi-adapters.js';
const cwd = process.argv[2];
const config = loadSecHeurConfig({ projectRoot: cwd, stateDir: join(cwd, 'executor-state'), env: { PI_OFFLINE: '1' } });
config.executionMode = { ...config.executionMode, mode: 'plan_multi' };
config.judge.enabled = false;
const faux = fauxProvider({ models: [{ id: 'permission-executor-fixture', reasoning: false }] });
const credentials = new InMemoryCredentialStore();
await credentials.modify(faux.provider.id, async () => ({ type: 'api_key', key: 'synthetic-only' }));
const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
modelRuntime.registerNativeProvider(faux.provider); await modelRuntime.refresh({ allowNetwork: false });
faux.setResponses([
 fauxAssistantMessage(fauxToolCall('read', { path: join(cwd, 'controller.txt') })),
 fauxAssistantMessage(fauxToolCall('planning_commit_result', { outcome: 'done', summary: 'Synthetic cross-account evidence read successfully.', suggestedTasks: [], flagCandidates: [] })),
 fauxAssistantMessage('Synthetic fixture complete.'),
]);
const events = [];
const executor = new PiPlanningExecutor({ config, cwd, model: faux.getModel(), modelRuntime, thinkingLevel: 'off', onLifecycleEvent: (type) => events.push(type) });
const now = Date.now();
const report = await executor.execute({ lease: { schemaVersion: 1, leaseId: 'permission-fixture-lease', runId: 'permission-fixture-run', taskId: 'permission-fixture-task', planRevision: 1, objective: 'Read the synthetic controller fixture and commit a structured result.', doneWhen: 'Synthetic evidence is read and committed.', allowedScope: cwd, issuedAt: now, expiresAt: now + 60000 }, context: 'This is an offline harness fixture with no challenge content.' });
assert.equal(report.result.outcome, 'done');
assert.equal(report.commitSource, 'planning_commit_result');
assert(existsSync(join(cwd, '.planning-attempts')));
assert(!events.includes('executor_error'));
console.log(JSON.stringify({ status: 'passed', account: process.getuid(), compiledPiExecutor: true, attemptDirectoryCreated: true, structuredCommitAccepted: true, modelCalls: faux.state.callCount }));
