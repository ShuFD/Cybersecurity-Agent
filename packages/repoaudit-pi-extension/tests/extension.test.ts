import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import type { RepoAuditResult } from "../src/adapter/contracts.ts";
import extension, {
  createRepoAuditExtension,
  type RepoAuditToolDefinition,
} from "../src/index.ts";

type RunRepoAudit = typeof import("../src/adapter/run-repoaudit.ts").runRepoAudit;

function successfulResult(): RepoAuditResult {
  return {
    status: "success_no_findings",
    tool: "repoaudit",
    bugType: "NPD",
    language: "Python",
    repoPath: "C:/repo",
    findingCount: 0,
    findings: [],
    reportPath: null,
    logPath: "C:/RepoAudit/log/dfbscan.log",
    execution: {
      runId: "run-1",
      startedAt: "2026-08-14T00:00:00.000Z",
      endedAt: "2026-08-14T00:00:01.000Z",
      durationMs: 1_000,
      exitCode: 0,
      signal: null,
      pythonExecutable: "python",
      pythonVersion: "3.13.9",
      modelName: "model",
      workingDirectory: "C:/RepoAudit/src",
      resultDirectory: null,
      logDirectory: "C:/RepoAudit/log",
      stdoutBytes: 0,
      stderrBytes: 0,
      artifactIsolation: "run_id",
    },
  };
}

function register(factory = extension): RepoAuditToolDefinition {
  const tools: RepoAuditToolDefinition[] = [];
  factory({
    registerTool(tool) {
      tools.push(tool as unknown as RepoAuditToolDefinition);
    },
  } as ExtensionAPI);
  assert.equal(tools.length, 1);
  return tools[0] as RepoAuditToolDefinition;
}

test("默认导出是可加载的 ExtensionFactory 且只注册 repoaudit_scan", () => {
  assert.equal(typeof extension, "function");
  const tool = register();
  assert.equal(tool.name, "repoaudit_scan");
  assert.equal(tool.executionMode, "sequential");
});

test("schema 只暴露 repoPath、language、bugType", () => {
  const schema = register().parameters as unknown as {
    properties: Record<string, unknown>;
    required?: string[];
  };

  assert.deepEqual(Object.keys(schema.properties).sort(), ["bugType", "language", "repoPath"]);
  assert.deepEqual([...(schema.required ?? [])].sort(), ["bugType", "language", "repoPath"]);
  for (const forbidden of ["API key", "pythonExecutable", "model", "outputDir", "timeoutMs"]) {
    assert.equal(forbidden in schema.properties, false);
  }
});

test("description 明确支持矩阵与不适用边界", () => {
  const description = register().description;
  for (const phrase of ["C/C++", "Java", "Python", "Go", "NPD", "UAF", "MLK"]) {
    assert.match(description, new RegExp(phrase.replace("+", "\\+")));
  }
  for (const phrase of [
    "Web pentesting",
    "Network scanning",
    "Binary/reverse analysis",
    "Dependency vulnerability scanning",
    "Generic code review",
  ]) {
    assert.match(description, new RegExp(phrase, "i"));
  }
});

test("execute 调用 runRepoAudit、透传 signal，并只发送真实阶段更新", async () => {
  const calls: Array<{ options: unknown; runtimeOptions: unknown }> = [];
  const mockRun: RunRepoAudit = async (options, runtimeOptions) => {
    calls.push({ options, runtimeOptions });
    return successfulResult();
  };
  const tool = register(createRepoAuditExtension(mockRun));
  const controller = new AbortController();
  const updates: string[] = [];
  const result = await tool.execute(
    "call-1",
    { repoPath: "C:/repo", language: "Python", bugType: "NPD" },
    controller.signal,
    (update) => {
      const first = update.content[0];
      if (first?.type === "text") updates.push(first.text);
    },
    { cwd: "C:/workspace" } as never,
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.options, { repoPath: "C:/repo", language: "Python", bugType: "NPD" });
  const runtimeOptions = calls[0]?.runtimeOptions as { signal?: AbortSignal; runId?: string; onProgress?: unknown };
  assert.equal(runtimeOptions.signal, controller.signal);
  assert.match(runtimeOptions.runId ?? "", /^run_[0-9a-f]{32}$/);
  assert.equal(typeof runtimeOptions.onProgress, "function");
  assert.deepEqual(updates, [
    "Preparing RepoAudit scan...",
    "Running RepoAudit analysis...",
    "Processing RepoAudit result...",
  ]);
  assert.equal("status" in result.details ? result.details.status : undefined, "success_no_findings");
});

test("unsupported language/bug 组合由 Adapter 安全失败且不调用 Python/LLM", async () => {
  const failed: RepoAuditResult = {
    ...successfulResult(),
    status: "failed",
    language: "Python",
    bugType: "UAF",
    error: {
      code: "UNSUPPORTED_LANGUAGE_BUG_COMBINATION",
      message: "Python does not support UAF; raw diagnostic should not leak",
      recoverable: true,
      suggestion: "Choose a supported combination.",
    },
  };
  const mockRun: RunRepoAudit = async () => failed;
  const tool = register(createRepoAuditExtension(mockRun));

  await assert.rejects(
    tool.execute(
      "call-2",
      { repoPath: "C:/repo", language: "Python", bugType: "UAF" } as never,
      undefined,
      undefined,
      { cwd: "C:/workspace" } as never,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /UNSUPPORTED_LANGUAGE_BUG_COMBINATION/);
      assert.doesNotMatch(error.message, /raw diagnostic/);
      return true;
    },
  );
});


test("promptSnippet 与 promptGuidelines 同时挂到 ToolDefinition 以接入 system prompt 路由", () => {
  const tool = register();
  assert.equal(typeof tool.promptSnippet, "string");
  assert.ok((tool.promptSnippet ?? "").length > 0);
  assert.match(tool.promptSnippet ?? "", /RepoAudit/i);
  assert.match(tool.promptSnippet ?? "", /NPD|UAF|MLK/);

  const guidelines = tool.promptGuidelines;
  assert.ok(Array.isArray(guidelines));
  assert.ok((guidelines ?? []).length >= 4);

  const joined = (guidelines ?? []).join("\n");
  // 1. 何时该用:提到 NPD/UAF/MLK
  assert.match(joined, /repoaudit_scan/i);
  assert.match(joined, /NPD/);
  assert.match(joined, /UAF/);
  assert.match(joined, /MLK/);
  // 2. 支持矩阵:不要让 Agent 试错组合
  assert.match(joined, /C\/C\+/);
  assert.match(joined, /Java/);
  assert.match(joined, /Python/);
  assert.match(joined, /Go/);
  // 3. 禁用场景
  for (const phrase of [
    /web pentesting/i,
    /network scanning/i,
    /dependency|CVE/i,
    /binary/i,
    /generic code review/i,
  ]) {
    assert.match(joined, phrase);
  }
  // 4. 路径语义:相对路径基于 cwd
  assert.match(joined, /working directory/i);
  // 5. evidence 处理:不编造 finding
  assert.match(joined, /invent/i);
});

test("导出的常量与 ToolDefinition 上的字段一致", () => {
  const tool = register();
  // 直接导入常量做一致性校验
  return import("../src/extension/repoaudit-tool.ts").then(
    ({ REPOAUDIT_PROMPT_SNIPPET, REPOAUDIT_PROMPT_GUIDELINES }) => {
      assert.equal(tool.promptSnippet, REPOAUDIT_PROMPT_SNIPPET);
      assert.deepEqual(tool.promptGuidelines, [...REPOAUDIT_PROMPT_GUIDELINES]);
    },
  );
});

test("heartbeat is periodic and its timer is cleared in finally", async () => {
  let finish!: (result: RepoAuditResult) => void;
  const mockRun: RunRepoAudit = () => new Promise((resolve) => { finish = resolve; });
  const tool = register(createRepoAuditExtension(mockRun, { heartbeatMs: 10 }));
  const updates: Array<{ text: string; heartbeat: boolean }> = [];
  const pending = tool.execute(
    "heartbeat-call",
    { repoPath: "C:/repo", language: "Python", bugType: "NPD" },
    undefined,
    (update) => {
      const first = update.content[0];
      updates.push({
        text: first?.type === "text" ? first.text : "",
        heartbeat: "heartbeat" in update.details ? update.details.heartbeat : false,
      });
    },
    { cwd: "C:/workspace" } as never,
  );
  await new Promise((resolve) => setTimeout(resolve, 36));
  finish(successfulResult());
  await pending;
  const heartbeatCount = updates.filter((update) => update.heartbeat).length;
  assert.ok(heartbeatCount >= 2);
  assert.match(updates.find((update) => update.heartbeat)?.text ?? "", /run run_[0-9a-f]{32}/);
  const afterCompletion = updates.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(updates.length, afterCompletion);
});

test("heartbeat timer is also cleared when execution throws", async () => {
  const mockRun: RunRepoAudit = async () => {
    await new Promise((resolve) => setTimeout(resolve, 24));
    throw new Error("fixture failure");
  };
  const tool = register(createRepoAuditExtension(mockRun, { heartbeatMs: 8 }));
  let updates = 0;
  await assert.rejects(tool.execute(
    "heartbeat-failure",
    { repoPath: "C:/repo", language: "Python", bugType: "NPD" },
    undefined,
    () => { updates += 1; },
    { cwd: "C:/workspace" } as never,
  ));
  const finalCount = updates;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(updates, finalCount);
});
