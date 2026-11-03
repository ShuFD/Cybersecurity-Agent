import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderSupervisorContextWithSummary } from "../src/planning/context.ts";
import type { PlanningEvidence, PlanningSnapshot } from "../src/planning/contracts.ts";

// Replay the observed count/budget shape, not historical message contents.
// Explicitly needed evidence must survive new unrelated observations; no claim
// is made about the semantics or actual prompt of the historical failed run.
function snapshot(count: number): PlanningSnapshot {
	const runId = "context-churn-replay";
	const evidence: PlanningEvidence[] = Array.from({ length: count }, (_, index) => ({
		evidenceId: `tool-${createHash("sha256").update(String(index)).digest("hex").slice(0, 24)}`,
		runId,
		taskId: index < 2 ? "completed-source" : "other-work",
		leaseId: index < 2 ? "source-lease" : "other-lease",
		kind: "tool",
		source: "fixture",
		summary: `Synthetic observation ${index}: ${"bounded descriptive metadata ".repeat(20)}`,
		excerpt: "synthetic output omitted",
		contentRef: null,
		contentHash: createHash("sha256").update(`fixture-${index}`).digest("hex"),
		locator: {},
		contentBytes: 20,
		contentComplete: true,
		isTruncated: false,
		metadata: {},
		createdAt: index + 1,
	}));
	return {
		run: {
			runId,
			outerTaskId: "outer-fixture",
			goal: "Continue from registered evidence",
			mode: "active",
			status: "running",
			revision: 1,
			createdAt: 1,
			updatedAt: count,
		},
		tasks: [
			{
				taskId: "current-owner",
				runId,
				objective: "Continue using the two delivered findings",
				doneWhen: "Report a checked outcome",
				status: "running",
				priority: 1,
				sequence: 0,
				dependsOnTaskIds: [],
				inputEvidenceRefs: evidence.slice(0, 2).map((item) => item.evidenceId),
				createdAt: 1,
				updatedAt: 1,
			},
		],
		evidence,
		executionFrame: {
			runId,
			revision: 1,
			updatedAt: count,
			frame: {
				schemaVersion: 1,
				taskSummaries: [],
				facts: evidence.map((item, index) => ({
					key: `fixture-fact-${index}`,
					value: "synthetic declared finding",
					evidenceRefs: [item.evidenceId],
					sourceTaskId: "current-owner",
				})),
				rejectedDirections: [],
				openQuestions: [],
				artifacts: [],
			},
		},
	};
}

describe("Supervisor evidence churn structural replay", () => {
	it("keeps named active-task inputs under 16 KiB as the pool grows by 25 observations", () => {
		for (const count of [31, 56, 81, 174]) {
			const state = snapshot(count);
			const before = JSON.stringify(state);
			const rendered = renderSupervisorContextWithSummary(state, 16_384);
			expect(rendered.summary.contextBytes).toBeLessThanOrEqual(16_384);
			expect(rendered.summary.evidenceRefsPresented).toEqual(
				expect.arrayContaining(state.tasks[0]!.inputEvidenceRefs!),
			);
			expect(rendered.summary.evidenceRefsOmittedCount).toBeGreaterThan(0);
			expect(rendered.text).not.toContain("ev_bash_12");
			expect(JSON.stringify(state)).toBe(before);
		}
	});
});
