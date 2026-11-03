import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeSqliteFactory } from "@earendil-works/pi-session-backend-sqlite-node";
import { describe, expect, it } from "vitest";
import { schedulePlanningTask } from "../src/planning/scheduler.ts";
import { PlanningStore } from "../src/planning/store.ts";

async function createDependencyStore(
	runId: string,
	tasks: Array<{ taskId: string; priority: number; sequence: number; dependsOnTaskIds: string[] }>,
): Promise<PlanningStore> {
	const store = await PlanningStore.open(":memory:");
	store.createRun({ runId, outerTaskId: `${runId}-outer`, goal: "goal", mode: "active" }, 1);
	store.commitPlan(
		{
			runId,
			expectedRevision: 0,
			rationale: "test",
			idempotencyKey: `plan-${runId}`,
			tasks: tasks.map((task) => ({
				taskId: task.taskId,
				objective: task.taskId,
				doneWhen: task.taskId,
				priority: task.priority,
				sequence: task.sequence,
				dependsOnTaskIds: task.dependsOnTaskIds,
			})),
		},
		2,
	);
	return store;
}

describe("PlanningStore", () => {
	it("lists stable paginated evidence only within its run and filters the searchable excerpt surface", async () => {
		const store = await createDependencyStore("run-evidence-catalog", [
			{ taskId: "catalog-task", priority: 1, sequence: 0, dependsOnTaskIds: [] },
		]);
		const otherStore = await createDependencyStore("other-evidence-catalog", [
			{ taskId: "other-task", priority: 1, sequence: 0, dependsOnTaskIds: [] },
		]);
		try {
			const lease = store.leaseTask("run-evidence-catalog", "catalog-task", "/work", 30_000, 3);
			store.startLease(lease.leaseId, 4);
			for (let offset = 0; offset < 80; offset += 10) {
				store.recordEvidence(
					lease.leaseId,
					Array.from({ length: 10 }, (_, index) => {
						const number = offset + index;
						const content = `catalog evidence payload-${number}`;
						return {
							evidenceId: `catalog-evidence-${number}`,
							kind: "tool" as const,
							source: "catalog-tool",
							toolName: number === 79 ? "special-tool" : "catalog-tool",
							summary: content,
							excerpt: content,
							contentHash: createHash("sha256").update(content).digest("hex"),
							metadata: { isError: number % 2 === 1, searchableTag: `tag-${number}` },
						};
					}),
					offset + 5,
				);
			}
			const otherLease = otherStore.leaseTask("other-evidence-catalog", "other-task", "/work", 30_000, 3);
			otherStore.startLease(otherLease.leaseId, 4);
			otherStore.recordEvidence(
				otherLease.leaseId,
				[
					{
						evidenceId: "other-run-evidence",
						kind: "tool",
						source: "other-tool",
						summary: "other run evidence",
						contentHash: "other-run-hash",
					},
				],
				5,
			);

			expect(store.listEvidence("run-evidence-catalog").items).toHaveLength(25);
			expect(store.listEvidence("run-evidence-catalog", { limit: 100 }).items).toHaveLength(50);
			const seen: string[] = [];
			let cursor: string | undefined;
			let appended = false;
			for (;;) {
				const page = store.listEvidence("run-evidence-catalog", { limit: 13, ...(cursor ? { cursor } : {}) });
				seen.push(...page.items.map((item) => item.evidenceId));
				expect(page.totalCount).toBe(80);
				if (!appended) {
					appended = true;
					store.recordEvidence(
						lease.leaseId,
						["catalog-evidence-live-1", "catalog-evidence-live-2"].map((evidenceId) => ({
							evidenceId,
							kind: "tool" as const,
							source: "catalog-tool",
							toolName: "catalog-tool",
							summary: `${evidenceId} appended during pagination`,
							excerpt: `${evidenceId} appended during pagination`,
							contentHash: createHash("sha256").update(evidenceId).digest("hex"),
							metadata: { isError: false },
						})),
						600,
					);
				}
				if (!page.hasMore || !page.nextCursor) break;
				cursor = page.nextCursor;
			}
			expect(seen).toHaveLength(80);
			expect(new Set(seen).size).toBe(80);
			expect(seen.slice(0, 10)).toEqual(Array.from({ length: 10 }, (_, index) => `catalog-evidence-${79 - index}`));
			expect(new Set(seen)).toEqual(new Set(Array.from({ length: 80 }, (_, index) => `catalog-evidence-${index}`)));
			const latest = store.listEvidence("run-evidence-catalog", { limit: 2 });
			expect(latest.items.map((item) => item.evidenceId)).toEqual([
				"catalog-evidence-live-2",
				"catalog-evidence-live-1",
			]);
			expect(latest.totalCount).toBe(82);
			expect(() =>
				otherStore.listEvidence("other-evidence-catalog", {
					cursor: String(store.listEvidence("run-evidence-catalog", { limit: 1 }).nextCursor),
				}),
			).toThrow(/invalid or belongs to a different query/u);
			const filteredCursor = store.listEvidence("run-evidence-catalog", {
				toolName: "catalog-tool",
				limit: 1,
			}).nextCursor;
			expect(filteredCursor).toBeTruthy();
			expect(() =>
				store.listEvidence("run-evidence-catalog", {
					toolName: "special-tool",
					cursor: filteredCursor ?? undefined,
				}),
			).toThrow(expect.objectContaining({ code: "planning_evidence_list_input_error" }));
			expect(() => store.listEvidence("run-evidence-catalog", { limit: 0 })).toThrow(
				expect.objectContaining({ code: "planning_evidence_list_input_error" }),
			);
			expect(store.listEvidence("run-evidence-catalog", { outcome: "error" }).totalCount).toBe(40);
			expect(
				store.listEvidence("run-evidence-catalog", { toolName: "special-tool", keyword: "payload-79" }).items,
			).toHaveLength(1);
			expect(store.listEvidence("run-evidence-catalog", { keyword: "not-in-excerpt-or-metadata" }).totalCount).toBe(
				0,
			);
			expect(store.listEvidence("run-evidence-catalog", { taskId: "other-task" }).totalCount).toBe(0);
			expect(otherStore.listEvidence("other-evidence-catalog").items.map((item) => item.evidenceId)).toEqual([
				"other-run-evidence",
			]);
		} finally {
			store.close();
			otherStore.close();
		}
	});

	it("keeps persisted Observer observations out of successful tool evidence checks", async () => {
		const store = await createDependencyStore("run-observer-observation", [
			{ taskId: "observer-task", priority: 1, sequence: 0, dependsOnTaskIds: [] },
		]);
		try {
			const lease = store.leaseTask("run-observer-observation", "observer-task", "/work", 30_000, 3);
			store.startLease(lease.leaseId, 4);
			const observation = store.recordObservation(
				lease.leaseId,
				"planning_observer_report",
				JSON.stringify({ attempted: ["inspect source"], observedResults: [], supportedConclusions: [] }),
				{ semanticReportGenerated: true, evidenceRefs: [] },
				5,
			);
			expect(observation.kind).toBe("observation");
			expect(observation.metadata.semanticReportGenerated).toBe(true);
			expect(() =>
				store.commitResult(
					{
						leaseId: lease.leaseId,
						planRevision: lease.planRevision,
						outcome: "done",
						summary: "Observer alone cannot complete a task",
						evidence: [],
					},
					6,
				),
			).toThrow(/without successful tool evidence/u);
		} finally {
			store.close();
		}
	});

	it("records bounded checkpoint reference and scope rejection diagnostics", async () => {
		const allowedRoot = mkdtempSync(join(tmpdir(), "planning-checkpoint-diag-allowed-"));
		const otherRoot = mkdtempSync(join(tmpdir(), "planning-checkpoint-diag-other-"));
		const outsidePath = join(otherRoot, "private-artifact.txt");
		writeFileSync(outsidePath, "private artifact contents");
		const store = await createDependencyStore("run-checkpoint-diag", [
			{ taskId: "checkpoint-task", priority: 1, sequence: 0, dependsOnTaskIds: [] },
		]);
		try {
			const lease = store.leaseTask("run-checkpoint-diag", "checkpoint-task", allowedRoot, 30_000, 3);
			store.startLease(lease.leaseId, 4);
			const base = {
				summary: "bounded diagnostic",
				evidenceRefs: [],
				completedItems: [],
				remainingItems: [],
				rejectedDirections: [],
				artifacts: [],
				suggestedNextSteps: [],
			};

			try {
				store.recordCheckpoint(lease.leaseId, "unknown-reference", {
					...base,
					evidenceRefs: ["foreign-evidence-reference"],
				});
				throw new Error("expected evidence scope rejection");
			} catch (error) {
				expect(error).toMatchObject({
					code: "planning_checkpoint_validation_error",
					diagnostic: {
						reason: "evidence_reference_not_persisted_or_wrong_run",
						fieldName: "evidenceRefs",
						scopeDecision: "rejected",
						evidenceRefs: ["foreign-evidence-reference"],
					},
				});
				expect(JSON.parse((error as Error).message)).toMatchObject({
					errorCode: "planning_checkpoint_validation_error",
					reason: "evidence_reference_not_persisted_or_wrong_run",
					field: "evidenceRefs",
					scopeDecision: "rejected",
				});
			}
			try {
				store.recordCheckpoint(lease.leaseId, "outside-artifact", {
					...base,
					artifacts: [{ path: outsidePath, type: "text", description: "outside scope" }],
				});
				throw new Error("expected artifact scope rejection");
			} catch (error) {
				expect(error).toMatchObject({
					code: "planning_checkpoint_validation_error",
					diagnostic: {
						reason: "artifact_outside_allowed_scope",
						fieldName: "artifacts[0].path",
						scopeDecision: "rejected",
						artifactReferenceHashes: [createHash("sha256").update(outsidePath).digest("hex")],
					},
				});
				expect(JSON.parse((error as Error).message)).toMatchObject({
					errorCode: "planning_checkpoint_validation_error",
					reason: "artifact_outside_allowed_scope",
					field: "artifacts[0].path",
					scopeDecision: "rejected",
				});
				expect((error as Error).message).not.toContain(outsidePath);
			}
			const rejected = store
				.listLifecycleEvents("run-checkpoint-diag")
				.events.filter((event) => event.type === "planning_checkpoint_rejected");
			expect(rejected).toHaveLength(2);
			expect(rejected[0]?.payload).toMatchObject({
				taskId: "checkpoint-task",
				leaseId: lease.leaseId,
				failureCode: "planning_checkpoint_validation_error",
				diagnosticLayer: "store_validation",
				diagnosticReason: "evidence_reference_not_persisted_or_wrong_run",
				fieldName: "evidenceRefs",
				scopeDecision: "rejected",
				evidenceRefs: ["foreign-evidence-reference"],
			});
			expect(rejected[1]?.payload.artifactReferenceHashes).toEqual([
				createHash("sha256").update(outsidePath).digest("hex"),
			]);
			expect(JSON.stringify(rejected)).not.toContain(outsidePath);
			expect(JSON.stringify(rejected)).not.toContain("private artifact contents");
		} finally {
			store.close();
			rmSync(allowedRoot, { recursive: true, force: true });
			rmSync(otherRoot, { recursive: true, force: true });
		}
	});

	it("records deduplicated evidence-read scope, byte range, hash and hasMore without content", async () => {
		const store = await createDependencyStore("run-evidence-read-diag", [
			{ taskId: "reader-task", priority: 1, sequence: 0, dependsOnTaskIds: [] },
		]);
		const content = `${"a".repeat(300)}SECRET TAIL`;
		const returnedContent = content.slice(10, 266);
		try {
			const lease = store.leaseTask("run-evidence-read-diag", "reader-task", "/work", 30_000, 3);
			store.startLease(lease.leaseId, 4);
			store.recordEvidence(
				lease.leaseId,
				[
					{
						evidenceId: "readable-evidence",
						kind: "tool",
						source: "mock-tool",
						summary: content,
						excerpt: content,
						contentHash: "original-content-hash",
					},
				],
				5,
			);
			const options = {
				offset: 10,
				maxBytes: 256,
				requestId: "read-call-1",
				taskId: lease.taskId,
				leaseId: lease.leaseId,
			};
			expect(store.readEvidence(lease.runId, "readable-evidence", options).content).toBe(returnedContent);
			expect(store.readEvidence(lease.runId, "readable-evidence", options).content).toBe(returnedContent);
			const reads = store
				.listLifecycleEvents("run-evidence-read-diag")
				.events.filter((event) => event.type === "planning_evidence_read");
			expect(reads).toHaveLength(1);
			expect(reads[0]?.payload).toMatchObject({
				requestId: "read-call-1",
				evidenceId: "readable-evidence",
				taskId: "reader-task",
				leaseId: lease.leaseId,
				sourceRunId: lease.runId,
				sourceTaskId: "reader-task",
				sourceLeaseId: lease.leaseId,
				offset: 10,
				nextOffset: 266,
				requestedMaxBytes: 256,
				returnedBytes: 256,
				resultHash: createHash("sha256").update(returnedContent).digest("hex"),
				hasMore: true,
				readState: "completed",
				scopeDecision: "accepted",
			});
			expect(JSON.stringify(reads)).not.toContain(content);
			expect(JSON.stringify(reads)).not.toContain(returnedContent);
		} finally {
			store.close();
		}
	});

	it("enforces one active lease and releases dependent work after evidence commit", async () => {
		const store = await PlanningStore.open(":memory:");
		try {
			store.createRun({ runId: "run", outerTaskId: "outer", goal: "goal", mode: "active" }, 1);
			let snapshot = store.commitPlan(
				{
					runId: "run",
					expectedRevision: 0,
					rationale: "test",
					idempotencyKey: "plan-1",
					tasks: [
						{ taskId: "a", objective: "a", doneWhen: "a", priority: 1, sequence: 0, dependsOnTaskIds: [] },
						{ taskId: "b", objective: "b", doneWhen: "b", priority: 0, sequence: 1, dependsOnTaskIds: ["a"] },
					],
				},
				2,
			);
			expect(snapshot.tasks.map((task) => task.status)).toEqual(["ready", "proposed"]);
			const lease = store.leaseTask("run", "a", "test", 30_000, 3);
			expect(() => store.leaseTask("run", "b", "test", 30_000, 4)).toThrow(/active lease/u);
			store.startLease(lease.leaseId, 5);
			snapshot = store.commitResult(
				{
					leaseId: lease.leaseId,
					planRevision: lease.planRevision,
					result: {
						schemaVersion: 1,
						leaseId: lease.leaseId,
						outcome: "done",
						summary: "done",
						suggestedTasks: [
							{ objective: "follow the retained lead", doneWhen: "the lead is checked", inputEvidenceRefs: [] },
						],
						flagCandidates: [],
					},
					outcome: "done",
					summary: "done",
					evidence: [{ kind: "tool", source: "test", summary: "ok", contentHash: "hash" }],
				},
				6,
			);
			expect(snapshot.tasks.map((task) => task.status)).toEqual(["done", "ready"]);
			expect(snapshot.evidence).toHaveLength(1);
			expect(snapshot.tasks).toHaveLength(2);
			expect(snapshot.executionFrame.frame.taskSummaries[0]?.suggestedTasks).toEqual([
				{ objective: "follow the retained lead", doneWhen: "the lead is checked", inputEvidenceRefs: [] },
			]);
		} finally {
			store.close();
		}
	});

	it("persists append-only lifecycle diagnostics in planning_events", async () => {
		const root = mkdtempSync(join(tmpdir(), "planning-store-events-"));
		const path = join(root, "planning.sqlite");
		try {
			const store = await PlanningStore.open(path);
			store.createRun({ runId: "run-events", outerTaskId: "outer", goal: "goal", mode: "active" }, 1);
			store.recordLifecycleEvent(
				"run-events",
				"supervisor_propose_start",
				{ runId: "run-events", revision: 2, elapsedMs: 7 },
				2,
			);
			store.close();

			const db = await createNodeSqliteFactory().open(path);
			try {
				const event = db
					.prepare("SELECT run_id, type, payload_json, created_at FROM planning_events WHERE type = ?")
					.get<{ run_id: string; type: string; payload_json: string; created_at: number }>(
						"supervisor_propose_start",
					);
				expect(event).toMatchObject({ run_id: "run-events", type: "supervisor_propose_start", created_at: 2 });
				expect(JSON.parse(event?.payload_json ?? "{}")).toMatchObject({
					runId: "run-events",
					revision: 2,
					elapsedMs: 7,
				});
			} finally {
				db.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("lists one run in stable insertion order with bounded pagination", async () => {
		const store = await PlanningStore.open(":memory:");
		try {
			store.createRun({ runId: "run-a", outerTaskId: "outer-a", goal: "goal-a", mode: "active" }, 1);
			store.createRun({ runId: "run-b", outerTaskId: "outer-b", goal: "goal-b", mode: "active" }, 1);
			store.recordLifecycleEvent("run-a", "first", { runId: "run-a", marker: 1 }, 10);
			store.recordLifecycleEvent("run-b", "other", { runId: "run-b", marker: 9 }, 10);
			store.recordLifecycleEvent("run-a", "second", { runId: "run-a", marker: 2 }, 10);
			store.recordLifecycleEvent("run-a", "third", { runId: "run-a", marker: 3 }, 10);

			const first = store.listLifecycleEvents("run-a", { limit: 2 });
			expect(first.totalCount).toBe(4);
			expect(first.events.map((event) => event.type)).toEqual(["run_created", "first"]);
			expect(first.events[1]).toMatchObject({ type: "first", createdAt: 10, payload: { marker: 1 } });
			expect(first.nextCursor).toBeTruthy();

			const second = store.listLifecycleEvents("run-a", { cursor: first.nextCursor ?? undefined, limit: 2 });
			expect(second.events.map((event) => event.type)).toEqual(["second", "third"]);
			expect(second.nextCursor).toBeNull();
			expect(second.events.map((event) => event.sequence)).not.toContain(first.events[0]?.sequence);

			const other = store.listLifecycleEvents("run-b");
			expect(other.events.map((event) => event.type)).toEqual(["run_created", "other"]);
			expect(store.listLifecycleEvents("missing-run")).toMatchObject({
				events: [],
				totalCount: 0,
				nextCursor: null,
			});
		} finally {
			store.close();
		}
	});

	it("releases dependent work after a disproved prerequisite", async () => {
		const store = await createDependencyStore("run-disproved", [
			{ taskId: "a", priority: 1, sequence: 0, dependsOnTaskIds: [] },
			{ taskId: "b", priority: 0, sequence: 1, dependsOnTaskIds: ["a"] },
		]);
		try {
			const lease = store.leaseTask("run-disproved", "a", "test", 30_000, 3);
			store.startLease(lease.leaseId, 4);
			const snapshot = store.commitResult(
				{
					leaseId: lease.leaseId,
					planRevision: lease.planRevision,
					outcome: "disproved",
					summary: "not viable",
					evidence: [{ kind: "tool", source: "test", summary: "checked", contentHash: "disproved-hash" }],
				},
				5,
			);
			expect(snapshot.tasks.map((task) => task.status)).toEqual(["disproved", "ready"]);
		} finally {
			store.close();
		}
	});

	it("blocks a dependent when its prerequisite is blocked", async () => {
		const store = await createDependencyStore("run-blocked", [
			{ taskId: "a", priority: 1, sequence: 0, dependsOnTaskIds: [] },
			{ taskId: "b", priority: 0, sequence: 1, dependsOnTaskIds: ["a"] },
		]);
		try {
			const lease = store.leaseTask("run-blocked", "a", "test", 30_000, 3);
			store.startLease(lease.leaseId, 4);
			const snapshot = store.commitResult(
				{
					leaseId: lease.leaseId,
					planRevision: lease.planRevision,
					outcome: "blocked",
					summary: "blocked by environment",
					evidence: [],
				},
				5,
			);
			expect(snapshot.tasks.map((task) => task.status)).toEqual(["blocked", "blocked"]);
			expect(snapshot.tasks[1]?.lastError).toBe("blocked by dependency: a (blocked)");
		} finally {
			store.close();
		}
	});

	it("propagates blocked dependencies through a task chain", async () => {
		const store = await createDependencyStore("run-chain", [
			{ taskId: "a", priority: 1, sequence: 0, dependsOnTaskIds: [] },
			{ taskId: "b", priority: 0, sequence: 1, dependsOnTaskIds: ["a"] },
			{ taskId: "c", priority: 0, sequence: 2, dependsOnTaskIds: ["b"] },
		]);
		try {
			const lease = store.leaseTask("run-chain", "a", "test", 30_000, 3);
			store.startLease(lease.leaseId, 4);
			const snapshot = store.commitResult(
				{
					leaseId: lease.leaseId,
					planRevision: lease.planRevision,
					outcome: "blocked",
					summary: "blocked by environment",
					evidence: [],
				},
				5,
			);
			expect(snapshot.tasks.map((task) => task.status)).toEqual(["blocked", "blocked", "blocked"]);
			expect(snapshot.tasks[1]?.lastError).toBe("blocked by dependency: a (blocked)");
			expect(snapshot.tasks[2]?.lastError).toBe("blocked by dependency: b (blocked)");
		} finally {
			store.close();
		}
	});

	it("treats a failed prerequisite as an impossible dependency", async () => {
		const store = await createDependencyStore("run-failed", [
			{ taskId: "a", priority: 1, sequence: 0, dependsOnTaskIds: [] },
			{ taskId: "b", priority: 0, sequence: 1, dependsOnTaskIds: ["a"] },
		]);
		try {
			const lease = store.leaseTask("run-failed", "a", "test", 30_000, 3);
			store.startLease(lease.leaseId, 4);
			const snapshot = store.commitResult(
				{
					leaseId: lease.leaseId,
					planRevision: lease.planRevision,
					outcome: "failed",
					summary: "provider failed",
					evidence: [],
				},
				5,
			);
			expect(snapshot.tasks.map((task) => task.status)).toEqual(["failed", "blocked"]);
			expect(snapshot.tasks[1]?.lastError).toBe("blocked by dependency: a (failed)");
		} finally {
			store.close();
		}
	});

	it("returns replan after blocked dependency propagation leaves all tasks terminal", async () => {
		const store = await createDependencyStore("run-replan", [
			{ taskId: "a", priority: 1, sequence: 0, dependsOnTaskIds: [] },
			{ taskId: "b", priority: 0, sequence: 1, dependsOnTaskIds: ["a"] },
		]);
		try {
			const lease = store.leaseTask("run-replan", "a", "test", 30_000, 3);
			store.startLease(lease.leaseId, 4);
			const snapshot = store.commitResult(
				{
					leaseId: lease.leaseId,
					planRevision: lease.planRevision,
					outcome: "blocked",
					summary: "blocked by environment",
					evidence: [],
				},
				5,
			);
			expect(schedulePlanningTask(snapshot)).toEqual({
				kind: "replan",
				reason: "all current tasks are terminal; the supervisor must choose the next step",
			});
		} finally {
			store.close();
		}
	});

	it("persists tool evidence and checkpoints before an attempt is sealed", async () => {
		const store = await PlanningStore.open(":memory:");
		try {
			store.createRun(
				{ runId: "run-incremental", outerTaskId: "outer-incremental", goal: "goal", mode: "active" },
				1,
			);
			store.commitPlan(
				{
					runId: "run-incremental",
					expectedRevision: 0,
					rationale: "seed",
					idempotencyKey: "incremental-plan",
					tasks: [
						{
							taskId: "incremental-task",
							objective: "collect evidence",
							doneWhen: "evidence is persisted",
							priority: 1,
							sequence: 0,
							dependsOnTaskIds: [],
						},
					],
				},
				2,
			);
			const lease = store.leaseTask("run-incremental", "incremental-task", "/work", 30_000, 3);
			store.startLease(lease.leaseId, 4);
			const evidence = {
				evidenceId: "incremental-evidence",
				kind: "tool" as const,
				source: "mock-tool",
				toolName: "mock-tool",
				summary: "first tool result",
				excerpt: "observed output",
				contentHash: "incremental-content",
				metadata: { isError: false },
			};

			expect(store.recordEvidence(lease.leaseId, [evidence], 5)).toBe(1);
			expect(store.recordEvidence(lease.leaseId, [evidence], 6)).toBe(0);
			const beforeEnd = store.snapshot("run-incremental");
			expect(beforeEnd.evidence.map((item) => item.evidenceId)).toEqual(["incremental-evidence"]);
			expect(beforeEnd.activeLease?.leaseId).toBe(lease.leaseId);

			const checkpoint = store.recordCheckpoint(
				lease.leaseId,
				"checkpoint-incremental-1",
				{
					summary: "tool output is available; the next query remains incomplete",
					evidenceRefs: ["incremental-evidence"],
					completedItems: ["first query"],
					remainingItems: ["second query"],
					rejectedDirections: [
						{ direction: "blind brute force", reason: "too broad", evidenceRefs: ["incremental-evidence"] },
					],
					artifacts: [],
					suggestedNextSteps: [
						{
							objective: "run the narrowed query",
							doneWhen: "narrowed query completes",
							inputEvidenceRefs: ["incremental-evidence"],
						},
					],
				},
				7,
			);
			expect(checkpoint).toMatchObject({
				checkpointId: "checkpoint-incremental-1",
				checkpointSequence: 1,
				runId: "run-incremental",
				leaseId: lease.leaseId,
			});
			expect(store.snapshot("run-incremental").latestCheckpoint?.summary).toContain("tool output is available");

			const sealed = store.sealActiveLease(
				{
					leaseId: lease.leaseId,
					source: "runtime_failure",
					stage: "executor",
					code: "executor_timeout",
					message: "mock task timeout",
				},
				8,
			);
			expect(sealed.activeLease).toBeUndefined();
			expect(sealed.tasks[0]).toMatchObject({ status: "failed", lastError: "executor_timeout: mock task timeout" });
			expect(sealed.latestFailure).toMatchObject({
				source: "runtime_failure",
				code: "executor_timeout",
				evidenceRefs: ["incremental-evidence"],
				checkpointId: "checkpoint-incremental-1",
				completedItems: ["first query"],
				remainingItems: ["second query"],
			});
			expect(sealed.evidence[0]?.metadata).toMatchObject({ attemptFailed: true });
			expect(() => store.recordEvidence(lease.leaseId, [evidence], 9)).toThrow(/Active planning lease not found/u);
			expect(() =>
				store.recordCheckpoint(lease.leaseId, "late-checkpoint", {
					summary: "late",
					evidenceRefs: ["incremental-evidence"],
					completedItems: [],
					remainingItems: [],
					rejectedDirections: [],
					artifacts: [],
					suggestedNextSteps: [],
				}),
			).toThrow(/"reason":"active_lease_required"/u);
			const eventTypes = store.listLifecycleEvents("run-incremental").events.map((event) => event.type);
			expect(eventTypes).toContain("evidence_saved");
			expect(eventTypes).toContain("planning_checkpoint_saved");
			expect(eventTypes).toContain("attempt_sealed");
		} finally {
			store.close();
		}
	});

	it("fences commit and timeout competition to one effective settlement", async () => {
		const store = await PlanningStore.open(":memory:");
		try {
			for (const runId of ["run-commit-wins", "run-timeout-wins"]) {
				store.createRun({ runId, outerTaskId: `${runId}-outer`, goal: "goal", mode: "active" }, 1);
				store.commitPlan(
					{
						runId,
						expectedRevision: 0,
						rationale: "race",
						idempotencyKey: `${runId}-plan`,
						tasks: [
							{
								taskId: `${runId}-task`,
								objective: "race",
								doneWhen: "one settlement",
								priority: 1,
								sequence: 0,
								dependsOnTaskIds: [],
							},
						],
					},
					2,
				);
			}
			const evidence = { kind: "tool" as const, source: "mock", summary: "success", contentHash: "race-hash" };
			const commitLease = store.leaseTask("run-commit-wins", "run-commit-wins-task", "/work", 30_000, 3);
			store.startLease(commitLease.leaseId, 4);
			const committed = store.commitResult(
				{
					leaseId: commitLease.leaseId,
					planRevision: commitLease.planRevision,
					result: {
						schemaVersion: 1,
						leaseId: commitLease.leaseId,
						outcome: "done",
						summary: "committed",
						suggestedTasks: [],
						flagCandidates: [],
					},
					evidence: [evidence],
				},
				5,
			);
			const lateTimeout = store.sealActiveLease(
				{
					leaseId: commitLease.leaseId,
					source: "runtime_failure",
					stage: "executor",
					code: "executor_timeout",
					message: "late timeout",
				},
				6,
			);
			expect(committed.tasks[0]?.status).toBe("done");
			expect(lateTimeout.tasks[0]?.status).toBe("done");
			expect(lateTimeout.latestFailure).toBeUndefined();

			const timeoutLease = store.leaseTask("run-timeout-wins", "run-timeout-wins-task", "/work", 30_000, 7);
			store.startLease(timeoutLease.leaseId, 8);
			store.sealActiveLease(
				{
					leaseId: timeoutLease.leaseId,
					source: "runtime_failure",
					stage: "executor",
					code: "executor_timeout",
					message: "timeout first",
				},
				9,
			);
			expect(() =>
				store.commitResult({
					leaseId: timeoutLease.leaseId,
					planRevision: timeoutLease.planRevision,
					result: {
						schemaVersion: 1,
						leaseId: timeoutLease.leaseId,
						outcome: "done",
						summary: "late commit",
						suggestedTasks: [],
						flagCandidates: [],
					},
					evidence: [evidence],
				}),
			).toThrow(/Planning task result persistence failed/u);
			expect(store.snapshot("run-timeout-wins").tasks[0]?.status).toBe("failed");
		} finally {
			store.close();
		}
	});

	it("rejects cross-run checkpoint evidence and old-lease writes", async () => {
		const store = await PlanningStore.open(":memory:");
		try {
			for (const runId of ["run-checkpoint-a", "run-checkpoint-b"]) {
				store.createRun({ runId, outerTaskId: `${runId}-outer`, goal: "goal", mode: "active" }, 1);
				store.commitPlan(
					{
						runId,
						expectedRevision: 0,
						rationale: "seed",
						idempotencyKey: `${runId}-plan`,
						tasks: [
							{
								taskId: `${runId}-task`,
								objective: "task",
								doneWhen: "done",
								priority: 1,
								sequence: 0,
								dependsOnTaskIds: [],
							},
						],
					},
					2,
				);
			}
			const first = store.leaseTask("run-checkpoint-a", "run-checkpoint-a-task", "/work", 30_000, 3);
			store.startLease(first.leaseId, 4);
			const evidence = {
				kind: "tool" as const,
				source: "mock",
				summary: "evidence",
				contentHash: "cross-run-hash",
			};
			store.recordEvidence(first.leaseId, [evidence], 5);
			const evidenceId = store.snapshot("run-checkpoint-a").evidence[0]?.evidenceId;
			expect(evidenceId).toBeTruthy();
			const second = store.leaseTask("run-checkpoint-b", "run-checkpoint-b-task", "/work", 30_000, 6);
			store.startLease(second.leaseId, 7);
			expect(() =>
				store.recordCheckpoint(second.leaseId, "cross-run-checkpoint", {
					summary: "invalid cross-run reference",
					evidenceRefs: [],
					completedItems: [],
					remainingItems: [],
					rejectedDirections: [{ direction: "wrong", reason: "wrong run", evidenceRefs: [evidenceId!] }],
					artifacts: [],
					suggestedNextSteps: [],
				}),
			).toThrow(/"reason":"evidence_reference_not_persisted_or_wrong_run"/u);
			store.sealActiveLease(
				{
					leaseId: first.leaseId,
					source: "runtime_failure",
					stage: "executor",
					code: "executor_error",
					message: "old lease",
				},
				8,
			);
			expect(() =>
				store.recordCheckpoint(first.leaseId, "late-old-lease", {
					summary: "late",
					evidenceRefs: [],
					completedItems: [],
					remainingItems: [],
					rejectedDirections: [],
					artifacts: [],
					suggestedNextSteps: [],
				}),
			).toThrow(/"reason":"active_lease_required"/u);
		} finally {
			store.close();
		}
	});

	it("persists only in-scope checkpoint artifacts and rejects other-run paths", async () => {
		const allowedRoot = mkdtempSync(join(tmpdir(), "planning-checkpoint-artifact-"));
		const otherRoot = mkdtempSync(join(tmpdir(), "planning-checkpoint-other-"));
		try {
			const store = await PlanningStore.open(":memory:");
			store.createRun({ runId: "run-artifact", outerTaskId: "outer", goal: "goal", mode: "active" }, 1);
			store.commitPlan(
				{
					runId: "run-artifact",
					expectedRevision: 0,
					rationale: "artifact scope",
					idempotencyKey: "artifact-scope-plan",
					tasks: [
						{
							taskId: "artifact-task",
							objective: "write artifact",
							doneWhen: "artifact checkpointed",
							priority: 1,
							sequence: 0,
							dependsOnTaskIds: [],
						},
					],
				},
				2,
			);
			const insidePath = join(allowedRoot, "partial.txt");
			const otherRunPath = join(otherRoot, "other.txt");
			writeFileSync(insidePath, "inside");
			writeFileSync(otherRunPath, "other run");
			const lease = store.leaseTask("run-artifact", "artifact-task", allowedRoot, 30_000, 3);
			store.startLease(lease.leaseId, 4);

			const checkpoint = store.recordCheckpoint(
				lease.leaseId,
				"artifact-checkpoint",
				{
					summary: "artifact only appears in checkpoint",
					evidenceRefs: [],
					completedItems: [],
					remainingItems: ["read artifact"],
					rejectedDirections: [],
					artifacts: [{ path: insidePath, type: "text", description: "partial file", sha256: "hash" }],
					suggestedNextSteps: [],
				},
				5,
			);
			expect(checkpoint.artifacts[0]?.path).toBe(insidePath);
			expect(store.snapshot("run-artifact").latestCheckpoint?.artifacts[0]).toMatchObject({
				path: insidePath,
				type: "text",
			});
			expect(() =>
				store.recordCheckpoint(lease.leaseId, "outside-checkpoint", {
					summary: "outside",
					evidenceRefs: [],
					completedItems: [],
					remainingItems: [],
					rejectedDirections: [],
					artifacts: [{ path: join(allowedRoot, "missing.txt"), type: "text", description: "missing" }],
					suggestedNextSteps: [],
				}),
			).toThrow(/"reason":"artifact_not_found"/u);
			expect(() =>
				store.recordCheckpoint(lease.leaseId, "other-run-checkpoint", {
					summary: "other run",
					evidenceRefs: [],
					completedItems: [],
					remainingItems: [],
					rejectedDirections: [],
					artifacts: [{ path: otherRunPath, type: "text", description: "other run file" }],
					suggestedNextSteps: [],
				}),
			).toThrow(/"reason":"artifact_outside_allowed_scope"/u);
			store.close();
		} finally {
			rmSync(allowedRoot, { recursive: true, force: true });
			rmSync(otherRoot, { recursive: true, force: true });
		}
	});

	it("cancels the active lease and records an explicit cancellation event", async () => {
		const root = mkdtempSync(join(tmpdir(), "planning-store-cancel-"));
		const path = join(root, "planning.sqlite");
		try {
			const store = await PlanningStore.open(path);
			store.createRun({ runId: "run-cancel", outerTaskId: "outer-cancel", goal: "goal", mode: "active" }, 1);
			store.commitPlan(
				{
					runId: "run-cancel",
					expectedRevision: 0,
					rationale: "test",
					idempotencyKey: "cancel-plan",
					tasks: [
						{
							taskId: "cancel-task",
							objective: "cancel-task",
							doneWhen: "done",
							priority: 1,
							sequence: 0,
							dependsOnTaskIds: [],
						},
					],
				},
				2,
			);
			const lease = store.leaseTask("run-cancel", "cancel-task", "test", 30_000, 3);
			store.startLease(lease.leaseId, 4);
			expect(store.cancelActiveLease("run-cancel", "operator cancelled", 5)).toBe(true);
			store.setRunStatus("run-cancel", "cancelled", "operator cancelled", 6);
			const snapshot = store.snapshot("run-cancel");
			expect(snapshot.run.status).toBe("cancelled");
			expect(snapshot.tasks[0]?.status).toBe("ready");
			expect(snapshot.tasks[0]?.lastError).toBe("operator cancelled");
			expect(snapshot.activeLease).toBeUndefined();
			store.close();

			const db = await createNodeSqliteFactory().open(path);
			try {
				const events = db
					.prepare("SELECT type, payload_json FROM planning_events WHERE run_id = ? ORDER BY rowid")
					.all<{ type: string; payload_json: string }>("run-cancel");
				expect(events.map((event) => event.type)).toContain("lease_cancelled");
				expect(events.map((event) => event.type)).toContain("run_cancelled");
				expect(JSON.stringify(events)).toContain("operator cancelled");
			} finally {
				db.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
