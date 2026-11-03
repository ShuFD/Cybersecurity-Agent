import { describe, expect, it } from "vitest";
import { runPlanningSelfTest } from "../src/planning/self-test.ts";

describe("progressive planning self-test", () => {
	it("executes dependency-ordered leases to completion", async () => {
		const report = await runPlanningSelfTest();
		expect(report.ok).toBe(true);
		expect(report.status).toBe("completed");
		expect(report.executedObjectives).toEqual(["Inspect the target", "Verify the finding"]);
	});
});
