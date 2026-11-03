import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { RepoAuditRunOptions } from "../src/adapter/contracts.ts";
import {
  buildRepoAuditArgs,
  type RepoAuditRuntimeConfig,
} from "../src/adapter/config.ts";
import { RepoAuditError } from "../src/adapter/errors.ts";
import {
  assertModelCredential,
  preflightRepoAudit,
  validateRepoAuditOptions,
  validateRepositoryInput,
} from "../src/adapter/preflight.ts";

function config(root: string, pythonExecutable = process.execPath): RepoAuditRuntimeConfig {
  return {
    repoAuditRoot: root,
    rootSource: "explicit",
    repoAuditSrcDirectory: path.join(root, "src"),
    repoAuditEntryPoint: path.join(root, "src", "repoaudit.py"),
    pythonExecutable,
    treeSitterLibrary: path.join(root, "lib", "build", "my-languages.so"),
    runsDirectory: path.join(root, "runs"),
    lockDirectory: path.join(root, "lock"),
    defaultTimeoutMs: 10_000,
    lockTimeoutMs: 10_000,
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

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repoaudit-adapter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function pythonOptions(repoPath: string): RepoAuditRunOptions {
  return { repoPath, language: "Python", bugType: "NPD" };
}

test("repoPath 不存在 -> REPOSITORY_NOT_FOUND", async (t) => {
  const root = await temporaryDirectory(t);
  await assert.rejects(
    validateRepositoryInput(pythonOptions(path.join(root, "missing")), config(root)),
    (error: unknown) => error instanceof RepoAuditError && error.code === "REPOSITORY_NOT_FOUND",
  );
});

test("repoPath 不是目录 -> REPOSITORY_NOT_FOUND", async (t) => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, "file.py");
  await writeFile(file, "print('x')\n", "utf8");
  await assert.rejects(
    validateRepositoryInput(pythonOptions(file), config(root)),
    (error: unknown) => error instanceof RepoAuditError && error.code === "REPOSITORY_NOT_FOUND",
  );
});

test("没有对应语言源文件 -> NO_ANALYZABLE_FILES", async (t) => {
  const root = await temporaryDirectory(t);
  const repository = path.join(root, "repo");
  await mkdir(repository);
  await writeFile(path.join(repository, "README.md"), "empty", "utf8");
  await assert.rejects(
    validateRepositoryInput(pythonOptions(repository), config(root)),
    (error: unknown) =>
      error instanceof RepoAuditError && error.code === "NO_ANALYZABLE_FILES",
  );
});

test("Python executable 不存在 -> PYTHON_NOT_FOUND", async (t) => {
  const root = await temporaryDirectory(t);
  const repository = path.join(root, "repo");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(repository);
  await writeFile(path.join(root, "src", "repoaudit.py"), "", "utf8");
  await writeFile(path.join(repository, "main.py"), "x = 1\n", "utf8");
  await assert.rejects(
    preflightRepoAudit(pythonOptions(repository), config(root, path.join(root, "missing-python"))),
    (error: unknown) => error instanceof RepoAuditError && error.code === "PYTHON_NOT_FOUND",
  );
});

test("preflight credential policy matches REPOAUDIT_REQUIRE_API_KEY", () => {
  const optional = config(process.cwd());
  assert.equal(assertModelCredential(optional), false);

  const required = { ...optional, requireApiKey: true };
  assert.throws(
    () => assertModelCredential(required),
    (error: unknown) => error instanceof RepoAuditError && error.code === "API_KEY_MISSING",
  );
});

test("非法 language 与 bugType 在运行时被拒绝", () => {
  assert.throws(
    () => validateRepoAuditOptions({ repoPath: ".", language: "Rust", bugType: "NPD" } as never),
    (error: unknown) => error instanceof RepoAuditError && error.code === "UNSUPPORTED_LANGUAGE",
  );
  assert.throws(
    () => validateRepoAuditOptions({ repoPath: ".", language: "Cpp", bugType: "SQLI" } as never),
    (error: unknown) => error instanceof RepoAuditError && error.code === "UNSUPPORTED_BUG_TYPE",
  );
});

test("Python + UAF -> UNSUPPORTED_LANGUAGE_BUG_COMBINATION", () => {
  assert.throws(
    () => validateRepoAuditOptions({ repoPath: ".", language: "Python", bugType: "UAF" } as never),
    (error: unknown) =>
      error instanceof RepoAuditError &&
      error.code === "UNSUPPORTED_LANGUAGE_BUG_COMBINATION",
  );
});

test("Cpp + MLK args 不含 --is-reachable", () => {
  const args = buildRepoAuditArgs(
    { repoPath: "C:/repo", language: "Cpp", bugType: "MLK" },
    config("C:/RepoAudit"),
  );
  assert.equal(args.includes("--is-reachable"), false);
});

test("Cpp + NPD args 包含 --is-reachable 且 repoPath 是独立 argv", () => {
  const repoPath = "C:/含 空格/repo";
  const args = buildRepoAuditArgs(
    { repoPath, language: "Cpp", bugType: "NPD" },
    config("C:/RepoAudit"),
  );
  assert.equal(args.includes("--is-reachable"), true);
  assert.equal(args[args.indexOf("--project-path") + 1], repoPath);
});

test("run ID is passed as a separate backward-compatible CLI argument", () => {
  const runId = "run_0123456789abcdef0123456789abcdef";
  const args = buildRepoAuditArgs(
    { repoPath: "C:/repo", language: "Python", bugType: "NPD" },
    config("C:/RepoAudit"),
    "C:/repo",
    runId,
  );
  assert.equal(args[args.indexOf("--run-id") + 1], runId);
});

for (const directoryName of ["repo with spaces", "中文仓库"]) {
  test(`repoPath 支持 ${directoryName}`, async (t) => {
    const root = await temporaryDirectory(t);
    const repository = path.join(root, directoryName);
    await mkdir(repository);
    await writeFile(path.join(repository, "main.py"), "x = 1\n", "utf8");
    assert.equal(
      await validateRepositoryInput(pythonOptions(repository), config(root)),
      await realpath(repository),
    );
  });
}
