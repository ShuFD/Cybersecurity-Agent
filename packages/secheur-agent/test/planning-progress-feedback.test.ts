import { describe, expect, it } from "vitest";
import { PlanningProgressFeedback } from "../src/planning/progress-feedback.ts";

function event(n: number, extra: Partial<Parameters<PlanningProgressFeedback["observe"]>[0]> = {}) {
	return {
		toolCallId: `call-${n}`,
		toolName: "fixture",
		toolInput: { path: "fixture" },
		result: "same error",
		isError: true,
		evidenceId: `e-${n}`,
		...extra,
	};
}

describe("host planning progress feedback", () => {
	it("checkpoints one repeated-error streak despite unrelated successes and clears it on repair", () => {
		const feedback = new PlanningProgressFeedback();
		feedback.observe(event(1));
		feedback.observe(event(2, { toolName: "read", result: "new", isError: false }));
		feedback.observe(event(3));
		const checkpoint = feedback.observe(event(4));
		expect(checkpoint?.evidenceRefs).toEqual(["e-4"]);
		expect(checkpoint?.suggestedNextSteps[0]?.dependsOnCurrent).toBe(false);
		expect(feedback.observe(event(5))).toBeUndefined();
		feedback.observe(event(6, { result: "repaired", isError: false }));
		expect(feedback.context()).toBe("");
		expect(feedback.observe(event(7))).toBeUndefined();
	});
	it("detects four identical observations without stopping or cancelling a tool", () => {
		const feedback = new PlanningProgressFeedback();
		for (let n = 1; n < 4; n++)
			expect(feedback.observe(event(n, { isError: false, result: "processing" }))).toBeUndefined();
		expect(feedback.observe(event(4, { isError: false, result: "processing" }))?.summary).toContain(
			"same observation 4 times",
		);
		expect(feedback.context()).toContain("not a stop instruction");
	});
	it("separates changed arguments and limits repetition detection to twenty events", () => {
		const feedback = new PlanningProgressFeedback();
		feedback.observe(event(1));
		feedback.observe(event(2));
		for (let n = 3; n < 25; n++)
			feedback.observe(event(n, { toolName: "read", toolInput: { page: n }, result: n, isError: false }));
		expect(feedback.observe(event(25))).toBeUndefined();
		expect(feedback.observe(event(26, { toolInput: { path: "other" } }))).toBeUndefined();
	});
	it("accepts one background completion after a foreground processing response, with no false goal proof", () => {
		const feedback = new PlanningProgressFeedback();
		expect(feedback.observe(event(1, { isError: false, result: { status: "running" } }))).toBeUndefined();
		const completed = event(1, {
			isError: false,
			backgroundCompletion: true,
			result: "finished",
			evidenceId: "background-evidence",
		});
		const checkpoint = feedback.observe(completed);
		expect(checkpoint?.evidenceRefs).toEqual(["background-evidence"]);
		expect(checkpoint?.summary).toContain("goal remains unverified");
		expect(checkpoint?.suggestedNextSteps).toEqual([]);
		expect(feedback.observe(completed)).toBeUndefined();
	});
	it("uses canonical verifier rejection metadata and preserves sibling isolation", () => {
		const a = new PlanningProgressFeedback();
		const b = new PlanningProgressFeedback();
		expect(
			a.observe(event(1, { toolName: "verify_flag", verifierStatus: "incorrect", isError: false }))?.summary,
		).toContain("incorrect");
		expect(b.context()).toBe("");
		expect(b.observe(event(2, { toolName: "verify_flag", isError: true }))).toBeUndefined();
		expect(
			b.observe(event(3, { toolName: "verify_flag", verifierStatus: "correct", isError: false, result: "correct" })),
		).toBeUndefined();
	});
});
