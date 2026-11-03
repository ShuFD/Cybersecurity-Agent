import { afterEach, describe, expect, it, vi } from "vitest";
import { PLANNING_SCHEMA_VERSION } from "../src/planning/contracts.ts";
import type { PlanningExecutor, PlanningSupervisor } from "../src/planning/harness.ts";
import { runPlanningHarness } from "../src/planning/harness.ts";
import { PlanningStore } from "../src/planning/store.ts";

const RUN_ID = "evidence-list-error-run";

async function seededStore(): Promise<PlanningStore> {
	const store = await PlanningStore.open(":memory:");
	store.createRun({ runId: RUN_ID, outerTaskId: "outer", goal: "query evidence", mode: "active" }, 1);
	store.commitPlan(
		{
			runId: RUN_ID,
			expectedRevision: 0,
			rationale: "seed a single task",
			idempotencyKey: "evidence-list-error-plan",
			tasks: [
				{
					taskId: "query-task",
					objective: "check the evidence catalog",
					doneWhen: "the catalog query is retried from page one",
					priority: 1,
					sequence: 0,
					dependsOnTaskIds: [],
				},
			],
		},
		2,
	);
	return store;
}

function blockedSupervisor(): PlanningSupervisor {
	return {
		async propose({ snapshot }) {
			return {
				schemaVersion: PLANNING_SCHEMA_VERSION,
				expectedRevision: snapshot.run.revision,
				decision: "blocked",
				rationale: "the query correction check is complete",
				tasks: [],
			};
		},
	};
}

function validExecutor(onExecute: PlanningExecutor["execute"]): PlanningExecutor {
	return { execute: onExecute };
}

describe("Planning evidence-list error classification", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("lets an executor recover from a bad cursor by retrying page one", async () => {
		const store = await seededStore();
		let badCursorError: unknown;
		let mismatchedFilterError: unknown;
		let retryPageCount: number | undefined;
		try {
			const snapshot = await runPlanningHarness(RUN_ID, {
				store,
				supervisor: blockedSupervisor(),
				executor: validExecutor(async ({ lease, listEvidence, recordEvidence }) => {
					recordEvidence?.({
						evidenceId: "evidence-query-cursor-one",
						kind: "tool",
						source: "bash",
						toolName: "bash",
						summary: "success: bash one",
						contentHash: "query-cursor-hash-one",
						metadata: { isError: false },
					});
					recordEvidence?.({
						evidenceId: "evidence-query-cursor-two",
						kind: "tool",
						source: "bash",
						toolName: "bash",
						summary: "success: bash two",
						contentHash: "query-cursor-hash-two",
						metadata: { isError: false },
					});
					try {
						listEvidence?.({ cursor: "invalid-cursor" });
					} catch (error) {
						badCursorError = error;
					}
					retryPageCount = listEvidence?.({ limit: 1 }).totalCount;
					const filteredCursor = listEvidence?.({ toolName: "bash", limit: 1 }).nextCursor;
					try {
						listEvidence?.({ toolName: "python", limit: 1, cursor: filteredCursor ?? undefined });
					} catch (error) {
						mismatchedFilterError = error;
					}
					listEvidence?.({ toolName: "bash", limit: 1 });
					return {
						result: {
							schemaVersion: PLANNING_SCHEMA_VERSION,
							leaseId: lease.leaseId,
							outcome: "done",
							summary: "The first-page retry succeeded",
							suggestedTasks: [],
							flagCandidates: [],
						},
						evidence: [],
						commitSource: "planning_commit_result",
					};
				}),
				maximumSteps: 4,
				maximumTasks: 4,
				leaseTtlMs: 30_000,
				maximumEvidenceBytes: 16_384,
				allowedScope: "/work",
			});
			expect(badCursorError).toMatchObject({ code: "planning_evidence_list_input_error" });
			expect(badCursorError).not.toMatchObject({ code: "planning_persistence_error" });
			expect(mismatchedFilterError).toMatchObject({ code: "planning_evidence_list_input_error" });
			expect(mismatchedFilterError).not.toMatchObject({ code: "planning_persistence_error" });
			expect(retryPageCount).toBe(2);
			expect(snapshot.tasks[0]?.status).toBe("done");
		} finally {
			store.close();
		}
	});

	it("keeps an actual Store read failure on the persistence-failure path", async () => {
		const store = await seededStore();
		const storeFailure = new Error("simulated SQLite read failure");
		const originalListEvidence = store.listEvidence.bind(store);
		let observedStoreError: unknown;
		store.listEvidence = (() => {
			throw storeFailure;
		}) as PlanningStore["listEvidence"];
		try {
			await runPlanningHarness(RUN_ID, {
				store,
				supervisor: blockedSupervisor(),
				executor: validExecutor(async ({ lease, listEvidence }) => {
					try {
						listEvidence?.({ limit: 1 });
					} catch (error) {
						observedStoreError = error;
					}
					return {
						result: {
							schemaVersion: PLANNING_SCHEMA_VERSION,
							leaseId: lease.leaseId,
							outcome: "done",
							summary: "Store classification was inspected",
							suggestedTasks: [],
							flagCandidates: [],
						},
						evidence: [],
						commitSource: "planning_commit_result",
					};
				}),
				maximumSteps: 4,
				maximumTasks: 4,
				leaseTtlMs: 30_000,
				maximumEvidenceBytes: 16_384,
				allowedScope: "/work",
			});
			expect(observedStoreError).toMatchObject({ code: "planning_persistence_error" });
			expect(observedStoreError).not.toMatchObject({ code: "planning_evidence_list_input_error" });
		} finally {
			store.listEvidence = originalListEvidence;
			store.close();
		}
	});
});
