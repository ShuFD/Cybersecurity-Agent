import { describe, expect, it } from "vitest";
import { compilePlanningProposal } from "../src/planning/compiler.ts";
import { PLANNING_SCHEMA_VERSION, stablePlanningTaskId } from "../src/planning/contracts.ts";

describe("planning compiler", () => {
	it("resolves stable dependency ids", () => {
		const tasks = compilePlanningProposal(
			"run-1",
			{
				schemaVersion: PLANNING_SCHEMA_VERSION,
				expectedRevision: 0,
				rationale: "test",
				tasks: [
					{ key: "a", objective: "inspect", doneWhen: "observed" },
					{ key: "b", objective: "verify", doneWhen: "verified", dependsOn: ["a"] },
				],
			},
			[],
			8,
		);
		expect(tasks[1].dependsOnTaskIds).toEqual([tasks[0].taskId]);
		expect(tasks.map((task) => task.sequence)).toEqual([0, 1]);
	});

	it("rejects cycles before persistence", () => {
		expect(() =>
			compilePlanningProposal(
				"run-1",
				{
					schemaVersion: PLANNING_SCHEMA_VERSION,
					expectedRevision: 0,
					rationale: "cycle",
					tasks: [
						{ key: "a", objective: "a", doneWhen: "a", dependsOn: ["b"] },
						{ key: "b", objective: "b", doneWhen: "b", dependsOn: ["a"] },
					],
				},
				[],
				8,
			),
		).toThrow(/cycle/u);
	});

	it("rejects a task key that would insert an existing stable task id", () => {
		const runId = "run-identity-compiler";
		const key = "verify";
		expect(() =>
			compilePlanningProposal(
				runId,
				{
					schemaVersion: PLANNING_SCHEMA_VERSION,
					expectedRevision: 1,
					rationale: "duplicate",
					tasks: [{ key, objective: "verify", doneWhen: "verified", dependsOn: [] }],
				},
				[{ taskId: stablePlanningTaskId(runId, key) } as never],
				8,
			),
		).toThrow(`task key already exists in this run: ${key}`);
	});

	it("rejects an exact objective/evidence repeat but allows a genuinely new evidence set", () => {
		const existing = [
			{
				taskId: "previous-task",
				objective: "inspect the narrowed input",
				doneWhen: "the narrowed input is classified",
				inputEvidenceRefs: ["evidence-a"],
			},
		] as never;
		let duplicateError: unknown;
		try {
			compilePlanningProposal(
				"run-signature",
				{
					schemaVersion: PLANNING_SCHEMA_VERSION,
					expectedRevision: 1,
					rationale: "repeat",
					tasks: [
						{
							key: "new-key",
							objective: "inspect the narrowed input",
							doneWhen: "the narrowed input is classified",
							inputEvidenceRefs: ["evidence-a"],
						},
					],
				},
				existing,
				8,
			);
		} catch (error) {
			duplicateError = error;
		}
		expect(duplicateError).toMatchObject({ code: "duplicate_task_signature" });
		expect(() =>
			compilePlanningProposal(
				"run-signature",
				{
					schemaVersion: PLANNING_SCHEMA_VERSION,
					expectedRevision: 1,
					rationale: "new evidence",
					tasks: [
						{
							key: "new-key-2",
							objective: "inspect the narrowed input",
							doneWhen: "the narrowed input is classified",
							inputEvidenceRefs: ["evidence-b"],
						},
					],
				},
				existing,
				8,
			),
		).not.toThrow();
	});
});
