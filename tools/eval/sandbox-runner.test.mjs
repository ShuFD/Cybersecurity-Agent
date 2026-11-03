import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSandboxWorker, workerDesktopConfiguration } from './sandbox-runner.mjs';

test('each PLAN worker admits two executors even when inherited settings specify DIRECT or a global seven limit', () => {
 const inherited = { executionMode: 'direct', executionCapacity: 1, memoryReferenceEnabled: true,
  maxTurns: 800, planning: { executionMode: 'direct', globalExecutorCapacity: 7, global_executor_capacity: 7,
   observerMode: 'guidance', taskGranularityPromptEnabled: true, evidenceCatalogEnabled: true } };
 for (const mode of ['progressive', 'cairn', 'hypothesis', 'artex']) {
  const result = workerDesktopConfiguration(inherited, mode);
  assert.deepEqual(result.executionMode, { mode: 'plan_multi', capacity: 2 });
  assert.deepEqual(result.planning.executionMode, result.executionMode);
  assert.equal(result.planning.engine, mode);
  assert.equal(result.planning.observerMode, 'off');
  assert.equal(result.planning.taskGranularityPromptEnabled, false);
  assert.equal(result.planning.evidenceCatalogEnabled, true);
  assert.equal(result.maxTurns, 220);
  assert.equal(result.memoryReferenceEnabled, false);
  assert.equal(result.planning.globalExecutorCapacity, undefined);
  assert.equal(result.planning.global_executor_capacity, undefined);
 }
 assert.equal(inherited.planning.globalExecutorCapacity, 7);
 const direct = workerDesktopConfiguration(inherited, 'direct');
 assert.deepEqual(direct.executionMode, { mode: 'direct', capacity: 1 });
 assert.equal(direct.planning.mode, 'off');
});

test('PLAN workers default to a shared evidence catalog and respect an explicit opt-out', () => {
 for (const mode of ['progressive', 'cairn', 'hypothesis', 'artex']) {
  assert.equal(workerDesktopConfiguration({}, mode).planning.evidenceCatalogEnabled, true);
  assert.equal(workerDesktopConfiguration({ planning: { evidenceCatalogEnabled: false } }, mode).planning.evidenceCatalogEnabled, false);
  assert.equal(workerDesktopConfiguration({ planning: { evidence_catalog_enabled: false } }, mode).planning.evidenceCatalogEnabled, false);
 }
});

test('Artex reaches the gateway credential guard before any sandbox is created', () => {
 const modelConfig = mkdtempSync(join(tmpdir(), 'artex-worker-admission-'));
 try {
  writeFileSync(join(modelConfig, 'models.json'), JSON.stringify({ providers: { synthetic: { apiKey: 'invalid-test-value' } } }));
  writeFileSync(join(modelConfig, 'auth.json'), '{}');
  assert.throws(() => startSandboxWorker({ mode: 'artex', manifest: { modelConfig }, desktopConfig: {} }),
   /Worker configuration must contain only dummy gateway credentials/);
 } finally {
  rmSync(modelConfig, { recursive: true, force: true });
 }
});

test('unknown modes are rejected before reading a worker manifest or silently selecting another engine', () => {
 assert.throws(() => workerDesktopConfiguration({}, 'unknown'), /Unknown evaluation mode/);
 assert.throws(() => startSandboxWorker({ mode: 'unknown' }), /Unknown evaluation mode/);
});
