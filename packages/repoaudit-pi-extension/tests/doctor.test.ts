import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runRepoAuditDoctor, type RepoAuditDoctorOperations } from "../src/adapter/doctor.ts";
import { RepoAuditError } from "../src/adapter/errors.ts";

async function runtimeRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "repoaudit-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "lib", "build"), { recursive: true });
  await writeFile(path.join(root, "src", "repoaudit.py"), "# fixture\n", "utf8");
  await writeFile(path.join(root, "lib", "build", "my-languages.so"), "fixture", "utf8");
  return root;
}

function successfulOperations(): Partial<RepoAuditDoctorOperations> {
  return {
    async assertRuntimePaths() {},
    async getPythonVersion() { return "3.13.9"; },
    async missingPythonDependencies() { return []; },
    async assertTreeSitter() {},
  };
}

test("doctor succeeds without model access and checks all five grammars", async (t) => {
  const root = await runtimeRoot(t);
  const grammars: string[] = [];
  const result = await runRepoAuditDoctor({
    environment: { REPOAUDIT_ROOT: root, REPOAUDIT_MODEL: "claude-3.7", ANTHROPIC_API_KEY: "super-secret" },
    operations: {
      ...successfulOperations(),
      async assertTreeSitter(grammar) { grammars.push(grammar); },
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(grammars, ["C", "Cpp", "Java", "Python", "Go"]);
  assert.equal(result.root.source, "explicit");
  assert.equal(result.model.apiKeyPresent, true);
  assert.doesNotMatch(JSON.stringify(result), /super-secret/);
});

test("doctor reports exact missing Python modules", async (t) => {
  const root = await runtimeRoot(t);
  const result = await runRepoAuditDoctor({
    environment: { REPOAUDIT_ROOT: root, ANTHROPIC_API_KEY: "present" },
    operations: { ...successfulOperations(), async missingPythonDependencies() { return ["anthropic", "boto3"]; } },
  });
  const dependency = result.checks.find((check) => check.name === "python-modules");
  assert.equal(dependency?.code, "DEPENDENCY_MISSING");
  assert.match(dependency?.message ?? "", /anthropic, boto3/);
});

test("doctor reports grammar, model mapping, API key, and unwritable output failures", async (t) => {
  const root = await runtimeRoot(t);
  const result = await runRepoAuditDoctor({
    environment: { REPOAUDIT_ROOT: root, REPOAUDIT_MODEL: "unknown-model" },
    operations: {
      ...successfulOperations(),
      async assertTreeSitter(grammar) {
        if (grammar === "Go") throw new RepoAuditError("TREE_SITTER_NOT_READY", "Go grammar failed.");
      },
      async assertWritableDirectory(directory) {
        if (directory.endsWith("result")) throw new Error("read only");
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((check) => check.name === "grammar-Go")?.code, "TREE_SITTER_NOT_READY");
  assert.equal(result.checks.find((check) => check.name === "model-credential-mapping")?.code, "MODEL_CONFIGURATION_ERROR");
  assert.equal(result.checks.find((check) => check.name === "result-directory")?.ok, false);
});

test("doctor reports a missing API key without exposing any secret value", async (t) => {
  const root = await runtimeRoot(t);
  const result = await runRepoAuditDoctor({
    environment: { REPOAUDIT_ROOT: root, REPOAUDIT_MODEL: "claude-3.7" },
    operations: successfulOperations(),
  });
  const credential = result.checks.find((check) => check.name === "model-api-key");
  assert.equal(result.ok, false);
  assert.equal(credential?.code, "API_KEY_MISSING");
  assert.equal(result.model.apiKeyPresent, false);
  assert.doesNotMatch(JSON.stringify(result), /api[_-]?key\s*[:=]\s*["'][^"']+/i);
});

test("doctor reports an optional missing API key without failing", async (t) => {
  const root = await runtimeRoot(t);
  const result = await runRepoAuditDoctor({
    environment: {
      REPOAUDIT_ROOT: root,
      REPOAUDIT_MODEL: "claude-3.7",
      REPOAUDIT_REQUIRE_API_KEY: "0",
    },
    operations: successfulOperations(),
  });
  const credential = result.checks.find((check) => check.name === "model-api-key");
  assert.equal(result.ok, true);
  assert.equal(credential?.ok, true);
  assert.match(credential?.message ?? "", /not present.*optional/i);
  assert.deepEqual(credential?.details, { present: false, required: false });
  assert.equal(result.model.apiKeyPresent, false);
});

test("doctor preserves Python not found and version unsupported codes", async (t) => {
  const root = await runtimeRoot(t);
  for (const code of ["PYTHON_NOT_FOUND", "PYTHON_VERSION_UNSUPPORTED"] as const) {
    const result = await runRepoAuditDoctor({
      environment: { REPOAUDIT_ROOT: root, ANTHROPIC_API_KEY: "present" },
      operations: {
        ...successfulOperations(),
        async getPythonVersion() { throw new RepoAuditError(code, code); },
      },
    });
    assert.equal(result.checks.find((check) => check.name === "python-3.13")?.code, code);
  }
});
