import { describe, expect, it } from "vitest";
import {
	PLANNING_SCHEMA_VERSION,
	type PlanningSnapshot,
	parsePlanningCheckpoint,
	parsePlanningPlanProposal,
	parsePlanningTaskResult,
	stablePlanningTaskId,
	validatePlanningDependencies,
	validatePlanningTaskIdentities,
} from "../src/planning/contracts.ts";
import { PlanningFailureError } from "../src/planning/failures.ts";

describe("planning contracts", () => {
	it.each(["failed", "blocked", "pruned"])(
		"rejects completion dependencies on %s tasks while preserving evidence reuse",
		(status) => {
			const snapshot = {
				run: { runId: "run" },
				tasks: [{ taskId: "old", status }],
				evidence: [{ evidenceId: "saved", runId: "run" }],
			} as unknown as PlanningSnapshot;
			const proposal = parsePlanningPlanProposal(
				JSON.stringify({
					decision: "create_tasks",
					tasks: [
						{
							key: "new",
							objective: "recover using evidence",
							doneWhen: "new result",
							dependsOn: ["old"],
							inputEvidenceRefs: ["saved"],
						},
					],
				}),
				0,
			);
			expect(() => validatePlanningDependencies(proposal, snapshot)).toThrow(/unrunnable dependency/);
			proposal.tasks[0]!.dependsOn = [];
			expect(() => validatePlanningDependencies(proposal, snapshot)).not.toThrow();
		},
	);
	it("keeps checkpoint evidence references optional but rejects malformed or truncated IDs", () => {
		expect(parsePlanningCheckpoint('{"summary":"milestone"}').evidenceRefs).toEqual([]);
		expect(parsePlanningCheckpoint('{"summary":"milestone","evidenceRefs":[]}').evidenceRefs).toEqual([]);
		expect(() => parsePlanningCheckpoint('{"summary":"milestone","evidenceRefs":null}')).toThrow(
			/Checkpoint evidenceRefs must be an array/u,
		);
		expect(() => parsePlanningCheckpoint('{"summary":"milestone","evidenceRefs":[42]}')).toThrow(
			/Checkpoint evidenceRefs\[0\] must be a non-empty string/u,
		);
		expect(() => parsePlanningCheckpoint('{"summary":"milestone","evidenceRefs":[" evidence-1"]}')).toThrow(
			/Checkpoint evidenceRefs\[0\] must be an exact evidenceId/u,
		);
		expect(() =>
			parsePlanningCheckpoint(JSON.stringify({ summary: "milestone", evidenceRefs: ["e".repeat(257)] })),
		).toThrow(/Checkpoint evidenceRefs\[0\] exceeds 256 characters/u);
	});

	it("keeps Supervisor input references optional and rejects altered, missing, or cross-run IDs", () => {
		const omitted = parsePlanningPlanProposal(
			JSON.stringify({
				decision: "create_tasks",
				tasks: [{ key: "fresh", objective: "explore", doneWhen: "a result is recorded" }],
			}),
			0,
		);
		const empty = parsePlanningPlanProposal(
			JSON.stringify({
				decision: "create_tasks",
				tasks: [{ key: "fresh", objective: "explore", doneWhen: "a result is recorded", inputEvidenceRefs: [] }],
			}),
			0,
		);
		expect(omitted.tasks[0]?.inputEvidenceRefs).toBeUndefined();
		expect(empty.tasks[0]?.inputEvidenceRefs).toBeUndefined();
		for (const badRefs of [[42], [" evidence-1"], ["e".repeat(257)], null]) {
			expect(() =>
				parsePlanningPlanProposal(
					JSON.stringify({
						decision: "create_tasks",
						tasks: [
							{ key: "bad", objective: "reuse evidence", doneWhen: "it is checked", inputEvidenceRefs: badRefs },
						],
					}),
					0,
				),
			).toThrow(/inputEvidenceRefs/u);
		}

		const snapshot = {
			run: { runId: "current-run" },
			tasks: [],
			evidence: [{ evidenceId: "foreign-evidence", runId: "other-run" }],
		} as unknown as PlanningSnapshot;
		const crossRun = parsePlanningPlanProposal(
			JSON.stringify({
				decision: "create_tasks",
				tasks: [
					{
						key: "bad",
						objective: "reuse evidence",
						doneWhen: "it is checked",
						inputEvidenceRefs: ["foreign-evidence"],
					},
				],
			}),
			0,
		);
		expect(() => validatePlanningDependencies(crossRun, snapshot)).toThrow(
			"unknown input evidence: foreign-evidence",
		);
		const missing = parsePlanningPlanProposal(
			JSON.stringify({
				decision: "create_tasks",
				tasks: [
					{
						key: "missing",
						objective: "reuse evidence",
						doneWhen: "it is checked",
						inputEvidenceRefs: ["missing-evidence"],
					},
				],
			}),
			0,
		);
		expect(() => validatePlanningDependencies(missing, { ...snapshot, evidence: [] })).toThrow(
			"unknown input evidence: missing-evidence",
		);
	});

	it("classifies malformed Supervisor JSON as a planning parse failure", () => {
		try {
			parsePlanningPlanProposal("not-json", 0);
			throw new Error("expected parse failure");
		} catch (error) {
			expect(error).toBeInstanceOf(PlanningFailureError);
			expect(error).toMatchObject({
				source: "planning",
				stage: "supervisor_parse",
				code: "supervisor_parse_error",
			});
		}
	});

	it("classifies invalid proposal fields as proposal validation failures", () => {
		try {
			parsePlanningPlanProposal(
				JSON.stringify({ tasks: [{ key: "inspect", objective: "inspect", doneWhen: "" }] }),
				0,
			);
			throw new Error("expected proposal validation failure");
		} catch (error) {
			expect(error).toBeInstanceOf(PlanningFailureError);
			expect(error).toMatchObject({
				source: "planning",
				stage: "proposal_validation",
				code: "proposal_validation_error",
			});
		}
	});
	it("extracts a bounded plan from fenced JSON", () => {
		const plan = parsePlanningPlanProposal(
			`result:\n\`\`\`json\n{"rationale":"r","tasks":[{"key":"a","objective":"inspect","done_when":"evidence"}]}\n\`\`\``,
			3,
		);
		expect(plan.expectedRevision).toBe(3);
		expect(plan.tasks).toEqual([
			{
				key: "a",
				objective: "inspect",
				doneWhen: "evidence",
				priority: 0,
				dependsOn: [],
			},
		]);
	});

	it("binds results to the authoritative lease", () => {
		const result = parsePlanningTaskResult(
			'{"outcome":"done","summary":"verified","suggestedTasks":[],"flagCandidates":[]}',
			"lease-1",
		);
		expect(result.leaseId).toBe("lease-1");
		expect(result.outcome).toBe("done");
	});

	it("normalizes common completed aliases to done", () => {
		const result = parsePlanningTaskResult('{"outcome":"completed","summary":"ok"}', "lease-2");
		expect(result.outcome).toBe("done");
	});

	it("bounds and deduplicates model-provided evidence references", () => {
		const padded = "e".repeat(300);
		const result = parsePlanningTaskResult(
			JSON.stringify({
				outcome: "done",
				summary: "ok",
				evidenceRefs: ["tool-a", "tool-a", 42, padded],
			}),
			"lease-3",
		);
		expect(result.evidenceRefs).toEqual(["tool-a", padded.trim().slice(0, 256)]);
	});

	it("accepts dependencies on keys in the current proposal", () => {
		expect(() =>
			validatePlanningDependencies(
				{
					schemaVersion: PLANNING_SCHEMA_VERSION,
					expectedRevision: 0,
					rationale: "ordered",
					tasks: [
						{ key: "inspect", objective: "inspect", doneWhen: "observed", dependsOn: [] },
						{ key: "verify", objective: "verify", doneWhen: "verified", dependsOn: ["inspect"] },
					],
				},
				{ tasks: [] } as never,
			),
		).not.toThrow();
	});

	it("reports an unknown dependency and the allowed persisted task ids", () => {
		expect(() =>
			validatePlanningDependencies(
				{
					schemaVersion: PLANNING_SCHEMA_VERSION,
					expectedRevision: 0,
					rationale: "invalid",
					tasks: [{ key: "verify", objective: "verify", doneWhen: "verified", dependsOn: ["inspect"] }],
				},
				{ tasks: [{ taskId: "plan_123" }, { taskId: "plan_456" }] } as never,
			),
		).toThrow("unknown dependency: inspect\nallowed existing taskIds:\n- plan_123\n- plan_456");
	});

	it("rejects a task key that already resolves to a persisted task id", () => {
		const runId = "run-identity-contract";
		const key = "verify";
		expect(() =>
			validatePlanningTaskIdentities(
				runId,
				{
					schemaVersion: PLANNING_SCHEMA_VERSION,
					expectedRevision: 1,
					rationale: "duplicate",
					tasks: [{ key, objective: "verify", doneWhen: "verified", dependsOn: [] }],
				},
				[{ taskId: stablePlanningTaskId(runId, key) }],
			),
		).toThrow(`task key already exists in this run: ${key}`);
		try {
			validatePlanningTaskIdentities(
				runId,
				{
					schemaVersion: PLANNING_SCHEMA_VERSION,
					expectedRevision: 1,
					rationale: "duplicate",
					tasks: [{ key, objective: "verify", doneWhen: "verified", dependsOn: [] }],
				},
				[{ taskId: stablePlanningTaskId(runId, key) }],
			);
		} catch (error) {
			expect(error).toMatchObject({ code: "duplicate_task_identity", source: "planning" });
		}
	});
});
