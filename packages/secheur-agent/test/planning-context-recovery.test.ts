import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { OpportunityReview } from "../src/planning/opportunity-review.ts";
import { PlannerMemory, validatePlanningCoverage } from "../src/planning/planner-memory.ts";
import { normalizePlanningIncrement } from "../src/planning/proposal-increment.ts";

it("preserves read ranges across planning wakes, detects changed evidence and isolates roles/runs", () => {
	const root = mkdtempSync(join(tmpdir(), "planning-memory-"));
	try {
		const memory = new PlannerMemory(root, "a", "planner");
		expect(memory.readPage("e", 0, 256, { content: "first" }).cacheHit).toBe(false);
		expect(new PlannerMemory(root, "a", "planner").readPage("e", 0, 256, { content: "first" }).cacheHit).toBe(true);
		expect(memory.readPage("e", 0, 256, { content: "changed" }).cacheHit).toBe(false);
		expect(new PlannerMemory(root, "b", "planner").readPage("e", 0, 256, { content: "changed" }).cacheHit).toBe(
			false,
		);
		expect(new PlannerMemory(root, "a", "observer").readPage("e", 0, 256, { content: "changed" }).cacheHit).toBe(
			false,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("requires a live owner or dependency for waiting and rejects unsupported citations", () => {
	const coverage = {
		remaining: [{ question: "Finish current bounded work", ownerId: "owner", evidenceIds: ["e"] }],
		recheckOn: "owner checkpoint",
	};
	expect(() => validatePlanningCoverage(coverage, ["owner"], [], ["e"])).not.toThrow();
	expect(() => validatePlanningCoverage(coverage, [], [], ["e"])).toThrow("current owner");
	expect(() => validatePlanningCoverage(coverage, ["owner"], [], [])).toThrow("outside this run");
	expect(() => validatePlanningCoverage({ remaining: [], recheckOn: "" }, ["owner"], [], ["e"])).toThrow();
});

it("reviews a long vacancy with 120/240/480 backoff, resets on changes and leaves full occupancy alone", () => {
	const review = new OpportunityReview();
	review.update("initial", 1, 2, 0);
	expect(review.due(119999)).toBe(false);
	expect(review.due(120000)).toBe(true);
	review.reviewed(120000);
	expect(review.due(359999)).toBe(false);
	expect(review.due(360000)).toBe(true);
	review.reviewed(360000);
	expect(review.due(839999)).toBe(false);
	expect(review.due(840000)).toBe(true);
	review.update("new evidence", 1, 2, 500000);
	expect(review.due(619999)).toBe(false);
	review.update("new evidence", 2, 2, 620000);
	expect(review.due(1000000)).toBe(false);
	review.update("empty", 0, 2, 1000001);
	expect(review.due(1000001)).toBe(true);
});

it("binds cited increment evidence to Progressive task inputs instead of retaining it only in prose", () => {
	const result = normalizePlanningIncrement(
		{
			tasks: [
				{ objective: "Check next synthetic question", increment: "new observation", incrementEvidenceIds: ["e"] },
			],
		},
		{ engine: "progressive", priorWork: true, evidenceIds: ["e"] },
	) as { tasks: Array<{ inputEvidenceRefs: string[] }> };
	expect(result.tasks[0].inputEvidenceRefs).toEqual(["e"]);
});
