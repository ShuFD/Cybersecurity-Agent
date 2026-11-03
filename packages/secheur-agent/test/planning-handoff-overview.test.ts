import { expect, it } from "vitest";
import { type PlanningHandoff, renderPlanningHandoff } from "../src/planning/handoff-contract.ts";

it("bounds Unicode handoff prose without changing original evidence or concealing omitted records", () => {
	const handoff: PlanningHandoff = {
		schemaVersion: 1,
		runId: "this-run",
		overallGoal: "目标".repeat(20000),
		localQuestion: "local",
		completionCriteria: ["complete local result"],
		verifiedOutcomes: [],
		pendingTools: [{ taskId: "native-pending", status: "processing" }],
		claims: Array.from({ length: 40 }, (_, index) => ({
			factId: `fact-${index}`,
			evidenceIds: [`source-${index}`],
			content: "观察".repeat(10000),
			authority: "executor_claim",
		})),
		failureBoundaries: [],
		artifacts: [],
		remainingGaps: [],
		queryHelp: "Read original same-run evidence through its evidenceId.",
	};
	const original = structuredClone(handoff);
	const text = renderPlanningHandoff(handoff);
	expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(16_384);
	const overview = JSON.parse(text.slice(text.indexOf("\n") + 1));
	expect(overview.pendingTools).toEqual(handoff.pendingTools);
	expect(overview.claims[0]).toMatchObject({
		factId: "fact-0",
		evidenceIds: ["source-0"],
		authority: "executor_claim",
	});
	expect(overview.recordCounts.claims.total).toBe(40);
	expect(overview.recordCounts.claims.presented).toBeLessThan(40);
	expect(handoff).toEqual(original);
});
