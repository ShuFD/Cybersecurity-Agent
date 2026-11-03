import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runRepoAudit } from "../src/index.ts";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(testDirectory, "..", "..");
const repoAuditRoot = path.resolve(extensionRoot, "..");

const cleanResult = await runRepoAudit(
  {
    repoPath: path.join(extensionRoot, "tests", "fixtures", "clean-python"),
    language: "Python",
    bugType: "NPD",
  },
  { timeoutMs: 60_000 },
);
assert.equal(cleanResult.status, "success_no_findings", JSON.stringify(cleanResult.error));

const toyResult = await runRepoAudit(
  {
    repoPath: path.join(repoAuditRoot, "benchmark", "Python", "toy"),
    language: "Python",
    bugType: "NPD",
  },
  { timeoutMs: 60_000 },
);
assert.equal(toyResult.status, "failed");
assert.ok(
  toyResult.error?.code === "API_KEY_MISSING" ||
    toyResult.error?.code === "ANALYSIS_FAILED",
  JSON.stringify(toyResult.error),
);

process.stdout.write(
  `${JSON.stringify({
    cleanFixture: { status: cleanResult.status, findingCount: cleanResult.findingCount },
    toyWithoutApiKey: { status: toyResult.status, errorCode: toyResult.error?.code },
  }, null, 2)}\n`,
);
