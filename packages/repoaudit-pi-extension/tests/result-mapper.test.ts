import assert from "node:assert/strict";
import test from "node:test";

import type { RepoAuditResult } from "../src/adapter/contracts.ts";
import {
  mapRepoAuditResult,
  RepoAuditToolExecutionError,
} from "../src/extension/result-mapper.ts";

function result(overrides: Partial<RepoAuditResult> = {}): RepoAuditResult {
  return {
    status: "success_no_findings",
    tool: "repoaudit",
    bugType: "NPD",
    language: "Python",
    repoPath: "C:/work/example",
    findingCount: 0,
    findings: [],
    reportPath: null,
    logPath: "C:/RepoAudit/log/run/dfbscan.log",
    execution: {
      runId: "run-1",
      startedAt: "2026-08-14T00:00:00.000Z",
      endedAt: "2026-08-14T00:00:01.000Z",
      durationMs: 1_000,
      exitCode: 0,
      signal: null,
      pythonExecutable: "C:/secret/python.exe",
      pythonVersion: "3.13.9",
      modelName: "internal-model",
      workingDirectory: "C:/secret/RepoAudit/src",
      resultDirectory: null,
      logDirectory: "C:/RepoAudit/log/run",
      stdoutBytes: 1_024,
      stderrBytes: 128,
      artifactIsolation: "run_id",
    },
    ...overrides,
  };
}

test("success_with_findings 映射为精简 content 与结构化 details", () => {
  const mapped = mapRepoAuditResult(result({
    status: "success_with_findings",
    findingCount: 1,
    reportPath: "C:/RepoAudit/result/run/detect_info.json",
    findings: [{
      id: "7",
      vulnerabilityType: "NPD",
      file: "src/example.py",
      line: 12,
      summary: "Potential null pointer dereference.",
      verification: { pathValidatorAccepted: true, humanConfirmed: false },
    }],
  }));

  assert.match(mapped.content[0]?.type === "text" ? mapped.content[0].text : "", /Finding count: 1/);
  assert.equal(mapped.details.status, "success_with_findings");
  assert.equal(mapped.details.findings.length, 1);
  assert.equal(mapped.details.reportPath, "C:/RepoAudit/result/run/detect_info.json");
  assert.equal("pythonExecutable" in mapped.details.execution, false);
  assert.equal("modelName" in mapped.details.execution, false);
});

test("success_no_findings 明确限定扫描范围且不声称仓库完全安全", () => {
  const mapped = mapRepoAuditResult(result());
  const content = mapped.content[0]?.type === "text" ? mapped.content[0].text : "";

  assert.match(content, /RepoAudit completed successfully\./);
  assert.match(content, /No accepted findings were reported for the selected language \/ bug type\./);
  assert.doesNotMatch(content, /repository is secure/i);
  assert.doesNotMatch(content, /仓库.*安全/);
});

test("failed 映射为 Pi 可标记失败的去敏异常", () => {
  const failed = result({
    status: "failed",
    execution: {
      ...result().execution,
      exitCode: 0,
    },
    error: {
      code: "API_KEY_MISSING",
      message: "raw stderr secret=super-secret ANTHROPIC_API_KEY=abc",
      recoverable: true,
      suggestion: "Set the required credential.",
    },
  });

  assert.throws(
    () => mapRepoAuditResult(failed),
    (error: unknown) => {
      assert.ok(error instanceof RepoAuditToolExecutionError);
      assert.equal(error.details.error.code, "API_KEY_MISSING");
      assert.equal(error.details.error.recoverable, true);
      assert.match(error.message, /configured model credential is unavailable/);
      assert.doesNotMatch(error.message, /super-secret|ANTHROPIC_API_KEY|raw stderr/);
      return true;
    },
  );
});

test("content 不包含 raw stdout、stderr、完整 log 或内部运行配置", () => {
  const mapped = mapRepoAuditResult(result());
  const serialized = JSON.stringify(mapped);

  assert.doesNotMatch(serialized, /C:\/secret\/python\.exe/);
  assert.doesNotMatch(serialized, /internal-model/);
  assert.doesNotMatch(serialized, /stdoutBytes|stderrBytes|raw stdout|raw stderr/i);
});
