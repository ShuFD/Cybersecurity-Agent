import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildChildEnvironment, createRuntimeConfig, RUNTIME_DEFAULTS } from "../src/adapter/config.ts";
import { RepoAuditError } from "../src/adapter/errors.ts";

test("host OpenAI-compatible default is reused without mutating process environment", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "repoaudit-model-"));
  try {
    writeFileSync(path.join(directory, "settings.json"), JSON.stringify({defaultProvider: "test", defaultModel: "MiniMax-M3"}));
    writeFileSync(path.join(directory, "models.json"), JSON.stringify({providers: {test: {api: "openai-completions", baseUrl: "http://127.0.0.1:8317/v1"}}}));
    writeFileSync(path.join(directory, "auth.json"), JSON.stringify({test: {key: "test:key"}}));
    const environment = { SECHEUR_AGENT_DIR: directory, REPOAUDIT_ROOT: directory };
    const config = createRuntimeConfig(environment);
    assert.equal(config.modelName, "MiniMax-M3");
    assert.equal(config.apiKeyEnvironmentName, "OPENAI_API_KEY");
    const child = buildChildEnvironment(config);
    assert.equal(child.OPENAI_API_KEY, "test:key");
    assert.equal(child.REPOAUDIT_OPENAI_BASE_URL, "http://127.0.0.1:8317/v1");
    assert.equal("OPENAI_API_KEY" in environment, false);
    assert.equal(createRuntimeConfig({...environment, REPOAUDIT_MODEL: "claude-3.7"}).modelName, "claude-3.7");
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test("runtime is inferred from the vendored checkout without an explicit root", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "repoaudit-root-"));
  const cwd = process.cwd();
  const runtime = path.join(fixture, "vendor", "repoaudit");
  try {
    mkdirSync(path.join(runtime, "src"), { recursive: true });
    writeFileSync(path.join(runtime, "src", "repoaudit.py"), "");
    mkdirSync(path.join(fixture, "work"));
    process.chdir(path.join(fixture, "work"));
    const config = createRuntimeConfig({});
    assert.equal(config.rootSource, "inferred");
    assert.equal(config.repoAuditRoot, runtime);
    assert.equal(config.repoAuditEntryPoint, path.join(runtime, "src", "repoaudit.py"));
  } finally {
    process.chdir(cwd);
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("strict root mode without REPOAUDIT_ROOT returns RUNTIME_NOT_FOUND", () => {
  assert.throws(
    () => createRuntimeConfig({ REPOAUDIT_REQUIRE_EXPLICIT_ROOT: "1" }),
    (error: unknown) => error instanceof RepoAuditError && error.code === "RUNTIME_NOT_FOUND",
  );
});

test("worker, timeout, lock, and heartbeat defaults are conservative and consistent", () => {
  const config = createRuntimeConfig({ REPOAUDIT_ROOT: process.cwd() });
  assert.equal(config.maxSymbolicWorkers, RUNTIME_DEFAULTS.maxSymbolicWorkers);
  assert.equal(config.maxNeuralWorkers, RUNTIME_DEFAULTS.maxNeuralWorkers);
  assert.equal(config.defaultTimeoutMs, RUNTIME_DEFAULTS.timeoutMs);
  assert.equal(config.lockTimeoutMs, RUNTIME_DEFAULTS.lockTimeoutMs);
  assert.equal(config.lockStaleMs, RUNTIME_DEFAULTS.lockStaleMs);
  assert.equal(config.heartbeatMs, RUNTIME_DEFAULTS.heartbeatMs);
  assert.equal(config.rootSource, "explicit");
  assert.equal(config.maxSymbolicWorkers < 30, true);
});

test("worker environment values are accepted only inside safe positive ranges", () => {
  const config = createRuntimeConfig({
    REPOAUDIT_ROOT: process.cwd(),
    REPOAUDIT_MAX_SYMBOLIC_WORKERS: "6",
    REPOAUDIT_MAX_NEURAL_WORKERS: "2",
    REPOAUDIT_LOCK_TIMEOUT_MS: "4000",
    REPOAUDIT_LOCK_STALE_MS: "60000",
    REPOAUDIT_HEARTBEAT_MS: "5000",
  });
  assert.equal(config.maxSymbolicWorkers, 6);
  assert.equal(config.maxNeuralWorkers, 2);
  assert.equal(config.lockTimeoutMs, 4000);
  assert.equal(config.heartbeatMs, 5000);

  for (const [name, value] of [
    ["REPOAUDIT_MAX_SYMBOLIC_WORKERS", "0"],
    ["REPOAUDIT_MAX_NEURAL_WORKERS", "9"],
    ["REPOAUDIT_LOCK_TIMEOUT_MS", "-1"],
    ["REPOAUDIT_HEARTBEAT_MS", "abc"],
  ] as const) {
    assert.throws(
      () => createRuntimeConfig({ REPOAUDIT_ROOT: process.cwd(), [name]: value }),
      (error: unknown) => error instanceof RepoAuditError && error.code === "MODEL_CONFIGURATION_ERROR",
    );
  }
});

test("model name must be a safe artifact path component", () => {
  for (const modelName of ["../claude", "vendor/claude", "vendor\\claude", ".", ".."]) {
    assert.throws(
      () => createRuntimeConfig({ REPOAUDIT_ROOT: process.cwd(), REPOAUDIT_MODEL: modelName }),
      (error: unknown) => error instanceof RepoAuditError && error.code === "MODEL_CONFIGURATION_ERROR",
    );
  }
});
