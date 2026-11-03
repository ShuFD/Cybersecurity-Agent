import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanningEvidence, PlanningTask, PlanningTaskResult } from "../src/planning/contracts.ts";
import { captureEvidenceBlob, readEvidenceBlob } from "../src/planning/evidence-store.ts";
import { emptyExecutionFrame, reduceExecutionFrame } from "../src/planning/frame-reducer.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("planning evidence persistence", () => {
	it("stores redacted full results and reads them in bounded chunks", () => {
		const stateDir = join(tmpdir(), `secheur-planning-evidence-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(stateDir, { recursive: true });
		temporaryDirectories.push(stateDir);
		const result = { output: "x".repeat(10_000), password: "must-not-be-stored" };
		const captured = captureEvidenceBlob({
			stateDir,
			runId: "run-1",
			evidenceId: "E1",
			toolCallId: "call-1",
			toolName: "read_file",
			toolInput: { path: "/tmp/example.txt" },
			result,
			isError: false,
		});
		expect(captured.contentRef).toMatch(/^planning-evidence\/blobs\/sha256\//);
		expect(captured.contentComplete).toBe(true);
		const chunk = readEvidenceBlob({
			stateDir,
			contentRef: captured.contentRef ?? "",
			contentHash: captured.contentHash,
			maxBytes: 64 * 1024,
		});
		expect(chunk.content).toContain("[REDACTED]");
		expect(chunk.content).not.toContain("must-not-be-stored");
		expect(chunk.hasMore).toBe(false);
		expect(chunk.nextOffset).toBe(chunk.totalBytes);
	});
});

describe("execution frame reducer", () => {
	it("keeps only evidence-grounded facts and updates open questions", () => {
		const evidence: PlanningEvidence = {
			evidenceId: "E1",
			runId: "run-1",
			taskId: "task-1",
			leaseId: "lease-1",
			kind: "tool",
			source: "shell",
			toolName: "shell",
			summary: "success: shell",
			excerpt: "verified",
			contentRef: null,
			contentHash: createHash("sha256").update("verified").digest("hex"),
			locator: { type: "command", command: "true" },
			contentBytes: 8,
			contentComplete: true,
			isTruncated: false,
			metadata: { isError: false },
			createdAt: Date.now(),
		};
		const task: PlanningTask = {
			taskId: "task-1",
			runId: "run-1",
			objective: "verify",
			doneWhen: "evidence exists",
			status: "running",
			priority: 0,
			sequence: 0,
			dependsOnTaskIds: [],
			createdAt: 0,
			updatedAt: 0,
		};
		const result: PlanningTaskResult = {
			schemaVersion: 1,
			leaseId: "lease-1",
			outcome: "done",
			summary: "verified",
			suggestedTasks: [],
			flagCandidates: [],
			evidenceRefs: ["E1"],
			facts: [{ key: "verified", value: true, evidenceRefs: ["E1"] }],
			rejectedDirections: [],
			openQuestions: [],
			resolvedQuestionIds: ["q1"],
			artifacts: [],
		};
		const frame = reduceExecutionFrame({
			frame: {
				...emptyExecutionFrame(),
				openQuestions: [{ questionId: "q1", text: "pending", sourceTaskId: "task-0" }],
			},
			task,
			result,
			evidence: [evidence],
			allowedScope: process.cwd(),
		});
		expect(frame.taskSummaries[0]?.evidenceRefs).toEqual(["E1"]);
		expect(frame.facts).toHaveLength(1);
		expect(frame.openQuestions).toHaveLength(0);
	});
});
