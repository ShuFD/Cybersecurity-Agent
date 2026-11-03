import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { LocatedArtifacts } from "../src/adapter/artifact-locator.ts";
import { RepoAuditError } from "../src/adapter/errors.ts";
import {
  detectLogFailure,
  parseBuggyLocation,
  parseDetectInfoJson,
  parseRunArtifacts,
} from "../src/adapter/result-parser.ts";

async function artifacts(
  t: test.TestContext,
  log: string,
  report?: string,
): Promise<LocatedArtifacts> {
  const root = await mkdtemp(path.join(os.tmpdir(), "repoaudit-result-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logDirectory = path.join(root, "log");
  const resultDirectory = path.join(root, "result");
  await mkdir(logDirectory);
  await mkdir(resultDirectory);
  const logPath = path.join(logDirectory, "dfbscan.log");
  await writeFile(logPath, log, "utf8");
  let reportPath: string | null = null;
  if (report !== undefined) {
    reportPath = path.join(resultDirectory, "detect_info.json");
    await writeFile(reportPath, report, "utf8");
  }
  return { logDirectory, resultDirectory, logPath, reportPath };
}

test("空 JSON {} -> success_no_findings", async (t) => {
  const located = await artifacts(t, "0 bug(s) was/were detected in total.", "{}");
  const result = await parseRunArtifacts(located, "", "NPD");
  assert.equal(result.status, "success_no_findings");
  assert.equal(result.findings.length, 0);
});

test("无 JSON + 正常 summary 0 -> success_no_findings", async (t) => {
  const located = await artifacts(t, "0 bug(s) was/were detected in total.");
  const result = await parseRunArtifacts(located, "", "NPD");
  assert.equal(result.status, "success_no_findings");
});

test("有 finding JSON -> success_with_findings", async (t) => {
  const report = JSON.stringify({
    "7": {
      bug_type: "NPD",
      buggy_value: "((None, C:/中文 repo/case.py, 12, -1), ValueLabel.SRC)",
      relevant_functions: [
        ["C:/中文 repo/case.py"],
        ["get_value"],
        ["def get_value(): return None"],
      ],
      explanation: "Potential null pointer dereference.",
      is_human_confirmed_true: "False",
    },
  });
  const located = await artifacts(t, "1 bug(s) was/were detected in total.", report);
  const result = await parseRunArtifacts(located, "", "NPD");
  assert.equal(result.status, "success_with_findings");
  assert.equal(result.findings[0]?.id, "7");
  assert.equal(result.findings[0]?.file, "C:/中文 repo/case.py");
  assert.equal(result.findings[0]?.line, 12);
  assert.equal(result.findings[0]?.verification.humanConfirmed, false);
  assert.equal("confidence" in (result.findings[0] ?? {}), false);
});

test("malformed JSON -> RESULT_PARSE_ERROR", () => {
  assert.throws(
    () => parseDetectInfoJson("{broken", "NPD"),
    (error: unknown) => error instanceof RepoAuditError && error.code === "RESULT_PARSE_ERROR",
  );
});

test("顶层 array -> RESULT_PARSE_ERROR", () => {
  assert.throws(
    () => parseDetectInfoJson("[]", "NPD"),
    (error: unknown) => error instanceof RepoAuditError && error.code === "RESULT_PARSE_ERROR",
  );
});

test("worker error log + exit0 语义 -> failed", async (t) => {
  const located = await artifacts(
    t,
    "Error processing source value: Please set the ANTHROPIC_API_KEY environment variable",
  );
  await assert.rejects(
    parseRunArtifacts(located, "0 bug(s) was/were detected in total.", "NPD"),
    (error: unknown) => error instanceof RepoAuditError && error.code === "API_KEY_MISSING",
  );
});

test("普通自然语言中的 error 不会误判", () => {
  assert.equal(detectLogFailure("The error rate metric was calculated successfully."), null);
});

test("finding summary > 0 但 JSON 不存在 -> RESULT_NOT_FOUND", async (t) => {
  const located = await artifacts(t, "2 bug(s) was/were detected in total.");
  await assert.rejects(
    parseRunArtifacts(located, "", "NPD"),
    (error: unknown) => error instanceof RepoAuditError && error.code === "RESULT_NOT_FOUND",
  );
});

test("buggy_value 无法解析 file/line 时 finding 仍返回", () => {
  const findings = parseDetectInfoJson(
    JSON.stringify({
      alpha: {
        bug_type: "NPD",
        buggy_value: "not-parseable",
        relevant_functions: [["fallback.py"], ["f"], ["def f(): pass"]],
        explanation: "explanation",
        is_human_confirmed_true: "unknown",
      },
    }),
    "NPD",
  );
  assert.equal(findings[0]?.file, "fallback.py");
  assert.equal(findings[0]?.line, null);
  assert.equal(findings[0]?.verification.humanConfirmed, null);
});

test("relevant_functions 长度不一致时不会越界", () => {
  const findings = parseDetectInfoJson(
    JSON.stringify({
      "0": {
        bug_type: "NPD",
        buggy_value: "bad",
        relevant_functions: [["first.py", "second.py"], ["f"], []],
        explanation: "safe conversion",
        is_human_confirmed_true: "True",
      },
    }),
    "NPD",
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.file, "first.py");
  assert.equal(findings[0]?.verification.humanConfirmed, true);
});

test("buggy_value 路径包含逗号时优先按 relevant file 解析", () => {
  assert.deepEqual(
    parseBuggyLocation(
      "((None, C:/repo,comma/case.py, 42, -1), ValueLabel.SRC)",
      ["C:/repo,comma/case.py"],
    ),
    { file: "C:/repo,comma/case.py", line: 42 },
  );
});
