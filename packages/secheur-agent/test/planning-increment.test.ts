import { expect, it } from "vitest";
import { normalizePlanningIncrement } from "../src/planning/proposal-increment.ts";

it("rejects ungrounded continuation and preserves empty proposals while owners continue", () => {
	const options = { engine: "cairn" as const, priorWork: true, evidenceIds: ["saved-proof"] };
	expect(() => normalizePlanningIncrement({ proposedIntents: [{ objective: "Continue the whole goal" }] }, options)).toThrow("substantive increment");
	expect(normalizePlanningIncrement({ proposedIntents: [] }, options)).toEqual({ proposedIntents: [] });
	expect(() => normalizePlanningIncrement({ proposedIntents: [{ increment: "Inspect a newly observed prerequisite", incrementEvidenceIds: ["invented"] }] }, options)).toThrow("exact original");
});
it("stores explained increments without changing objective identity or promoting evidence to proof", () => {
	const value = normalizePlanningIncrement({ proposedIntents: [{ objective: "Check a saved parameter", rationale: "A changed observation", increment: "Reconcile the differing parameter value against original output", incrementEvidenceIds: ["proof"], fromFactIds: ["reported-fact"] }] }, { engine: "cairn", priorWork: true, evidenceIds: ["proof"] }) as { proposedIntents: Array<Record<string, unknown>> };
	expect(value.proposedIntents[0].objective).toBe("Check a saved parameter");
	expect(value.proposedIntents[0].rationale).toContain("Substantive increment");
	expect(value.proposedIntents[0].rationale).toContain("source evidence: proof");
	expect(value.proposedIntents[0]).not.toHaveProperty("verified");
});
