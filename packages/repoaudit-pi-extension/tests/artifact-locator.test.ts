import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { RepoAuditRunOptions } from "../src/adapter/contracts.ts";
import type { RepoAuditRuntimeConfig } from "../src/adapter/config.ts";
import { RepoAuditError } from "../src/adapter/errors.ts";
import {
  artifactParentDirectories,
  locateArtifacts,
  snapshotArtifacts,
} from "../src/adapter/artifact-locator.ts";

const options: RepoAuditRunOptions = {
  repoPath: "unused",
  language: "Python",
  bugType: "NPD",
};

function config(root: string): RepoAuditRuntimeConfig {
  return {
    repoAuditRoot: root,
    rootSource: "explicit",
    repoAuditSrcDirectory: path.join(root, "src"),
    repoAuditEntryPoint: path.join(root, "src", "repoaudit.py"),
    pythonExecutable: process.execPath,
    treeSitterLibrary: path.join(root, "lib", "build", "my-languages.so"),
    runsDirectory: path.join(root, "runs"),
    lockDirectory: path.join(root, "lock"),
    defaultTimeoutMs: 1_000,
    lockTimeoutMs: 1_000,
    lockStaleMs: 60_000,
    heartbeatMs: 25_000,
    modelName: "claude-3.7",
    temperature: 0,
    callDepth: 3,
    maxSymbolicWorkers: 1,
    maxNeuralWorkers: 1,
    apiKeyEnvironmentName: "ANTHROPIC_API_KEY",
    requireApiKey: false,
    environment: {},
  };
}

async function setup(t: test.TestContext): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "repoaudit-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, repo: path.join(root, "target-repo") };
}

test("唯一的新 log/result artifact 可定位", async (t) => {
  const { root, repo } = await setup(t);
  const runtime = config(root);
  const before = await snapshotArtifacts(options, repo, runtime);
  const parents = artifactParentDirectories(options, repo, runtime);
  const logDirectory = path.join(parents.logParentDirectory, "run-1");
  const resultDirectory = path.join(parents.resultParentDirectory, "run-1");
  await mkdir(logDirectory, { recursive: true });
  await mkdir(resultDirectory, { recursive: true });
  await writeFile(path.join(logDirectory, "dfbscan.log"), "0 bug(s) was/were detected in total.");
  await writeFile(path.join(resultDirectory, "detect_info.json"), "{}");
  const after = await snapshotArtifacts(options, repo, runtime);
  const located = await locateArtifacts(before, after, runtime, "run-1");
  assert.equal(located.logDirectory, logDirectory);
  assert.equal(located.resultDirectory, resultDirectory);
  assert.ok(located.reportPath?.endsWith("detect_info.json"));
});

test("run ID must match the unique artifact directory", async (t) => {
  const { root, repo } = await setup(t);
  const runtime = config(root);
  const before = await snapshotArtifacts(options, repo, runtime);
  const parents = artifactParentDirectories(options, repo, runtime);
  await mkdir(path.join(parents.logParentDirectory, "run-other"), { recursive: true });
  await mkdir(path.join(parents.resultParentDirectory, "run-other"), { recursive: true });
  const after = await snapshotArtifacts(options, repo, runtime);
  await assert.rejects(
    locateArtifacts(before, after, runtime, "run-expected"),
    (error: unknown) => error instanceof RepoAuditError && error.code === "RESULT_AMBIGUOUS",
  );
});

test("没有新 artifact -> RESULT_NOT_FOUND", async (t) => {
  const { root, repo } = await setup(t);
  const runtime = config(root);
  const before = await snapshotArtifacts(options, repo, runtime);
  const after = await snapshotArtifacts(options, repo, runtime);
  await assert.rejects(
    locateArtifacts(before, after, runtime),
    (error: unknown) => error instanceof RepoAuditError && error.code === "RESULT_NOT_FOUND",
  );
});

test("多个候选 artifact -> RESULT_AMBIGUOUS", async (t) => {
  const { root, repo } = await setup(t);
  const runtime = config(root);
  const before = await snapshotArtifacts(options, repo, runtime);
  const parents = artifactParentDirectories(options, repo, runtime);
  await mkdir(path.join(parents.logParentDirectory, "run-1"), { recursive: true });
  await mkdir(path.join(parents.logParentDirectory, "run-2"), { recursive: true });
  const after = await snapshotArtifacts(options, repo, runtime);
  await assert.rejects(
    locateArtifacts(before, after, runtime),
    (error: unknown) => error instanceof RepoAuditError && error.code === "RESULT_AMBIGUOUS",
  );
});
