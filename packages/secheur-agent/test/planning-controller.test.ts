import { describe, expect, it, vi } from "vitest";
import { resolveExecutionMode } from "../src/execution-mode.ts";
import {
	PLANNING_SCHEMA_VERSION,
	type PlanningExecutionReport,
	type PlanningPlanProposal,
	type PlanningSnapshot,
	stablePlanningTaskId,
} from "../src/planning/contracts.ts";
import { ProgressivePlanningController, planningRunId } from "../src/planning/controller.ts";
import { planningFailure } from "../src/planning/failures.ts";
import type { PlanningExecutor, PlanningSupervisor } from "../src/planning/harness.ts";
import { PlanningStore } from "../src/planning/store.ts";

function proposal(revision: number): PlanningPlanProposal {
	return {
		schemaVersion: PLANNING_SCHEMA_VERSION,
		expectedRevision: revision,
		rationale: "ordered test plan",
		tasks: [
			{ key: "inspect", objective: "inspect", doneWhen: "observed", priority: 2, dependsOn: [] },
			{ key: "verify", objective: "verify", doneWhen: "verified", priority: 1, dependsOn: ["inspect"] },
		],
	};
}

function singleTaskProposal(
	revision: number,
	input: {
		key?: string;
		objective?: string;
		doneWhen?: string;
		inputEvidenceRefs?: string[];
	} = {},
): PlanningPlanProposal {
	const key = input.key ?? "only";
	return {
		schemaVersion: PLANNING_SCHEMA_VERSION,
		expectedRevision: revision,
		rationale: "single task continuation test",
		tasks: [
			{
				key,
				objective: input.objective ?? key,
				doneWhen: input.doneWhen ?? "done",
				dependsOn: [],
				...(input.inputEvidenceRefs ? { inputEvidenceRefs: input.inputEvidenceRefs } : {}),
			},
		],
	};
}

function orderedProposal(snapshot: PlanningSnapshot): PlanningPlanProposal {
	const inspect = snapshot.tasks.find((task) => task.objective === "inspect");
	const verify = snapshot.tasks.find((task) => task.objective === "verify");
	if (verify && (verify.status === "done" || verify.status === "disproved")) {
		return {
			schemaVersion: PLANNING_SCHEMA_VERSION,
			expectedRevision: snapshot.run.revision,
			decision: "finish_run",
			rationale: "ordered test plan complete",
			tasks: [],
			answerEvidenceRefs: snapshot.evidence.slice(0, 1).map((item) => item.evidenceId),
		};
	}
	return {
		schemaVersion: PLANNING_SCHEMA_VERSION,
		expectedRevision: snapshot.run.revision,
		rationale: "ordered test plan",
		tasks:
			inspect && (inspect.status === "done" || inspect.status === "disproved")
				? [{ key: "verify", objective: "verify", doneWhen: "verified", priority: 1, dependsOn: [inspect.taskId] }]
				: [{ key: "inspect", objective: "inspect", doneWhen: "observed", priority: 2, dependsOn: [] }],
	};
}

function successfulToolEvidence(objective: string): PlanningExecutionReport["evidence"][number] {
	return {
		kind: "tool",
		source: "test-tool",
		toolName: "test-tool",
		summary: `${objective} tool succeeded`,
		excerpt: `${objective} evidence`,
		contentHash: `test-tool-${objective}`,
		metadata: { isError: false },
	};
}

function controllerOptions(
	store: PlanningStore,
	mode: "off" | "shadow" | "active",
	supervisor: PlanningSupervisor,
	executor: PlanningExecutor,
) {
	return {
		executionMode: resolveExecutionMode({ legacyPlanningMode: mode }),
		store,
		supervisor,
		executor,
		maximumSteps: 8,
		maximumTasks: 16,
		leaseTtlMs: 30_000,
		maximumEvidenceBytes: 16_384,
		allowedScope: "/work",
	};
}

function successfulExecutor(executed: string[]): PlanningExecutor {
	return {
		async execute({ lease }) {
			executed.push(lease.objective);
			return {
				result: {
					schemaVersion: PLANNING_SCHEMA_VERSION,
					leaseId: lease.leaseId,
					outcome: "done",
					summary: `${lease.objective} complete`,
					suggestedTasks: [],
					flagCandidates:
						lease.objective === "verify"
							? [{ candidate: "flag{verified}", confidence: 0.9, rationale: "test" }]
							: [],
				},
				evidence: [successfulToolEvidence(lease.objective)],
				commitSource: "planning_commit_result",
			};
		},
	};
}

describe("ProgressivePlanningController", () => {
	it("keeps off and shadow modes non-controlling", async () => {
		const store = await PlanningStore.open(":memory:");
		let directCalls = 0;
		let executorCalls = 0;
		const supervisor: PlanningSupervisor = {
			async propose({ snapshot }) {
				return proposal(snapshot.run.revision);
			},
		};
		const executor: PlanningExecutor = {
			async execute() {
				executorCalls += 1;
				throw new Error("shadow must not execute a planning lease");
			},
		};
		try {
			const off = new ProgressivePlanningController(controllerOptions(store, "off", supervisor, executor));
			const offResult = await off.execute({
				outerTaskId: "off",
				goal: "off goal",
				async executeDirect() {
					directCalls += 1;
				},
			});
			expect(offResult).toMatchObject({ mode: "off", direct: true });
			const shadow = new ProgressivePlanningController(controllerOptions(store, "shadow", supervisor, executor));
			const shadowResult = await shadow.execute({
				outerTaskId: "shadow",
				goal: "shadow goal",
				async executeDirect() {
					directCalls += 1;
				},
			});
			expect(shadowResult.snapshot?.run.status).toBe("paused");
			expect(shadowResult.snapshot?.tasks).toHaveLength(2);
			expect(directCalls).toBe(2);
			expect(executorCalls).toBe(0);
		} finally {
			store.close();
		}
	});

	it("actively executes dependency-ordered leases and persists flag evidence", async () => {
		const store = await PlanningStore.open(":memory:");
		const executed: string[] = [];
		const supervisor: PlanningSupervisor = {
			async propose({ snapshot }) {
				return orderedProposal(snapshot);
			},
		};
		try {
			const controller = new ProgressivePlanningController(
				controllerOptions(store, "active", supervisor, successfulExecutor(executed)),
			);
			const result = await controller.execute({
				outerTaskId: "challenge-1",
				goal: "solve challenge",
				async executeDirect() {
					throw new Error("active mode must not call the direct executor");
				},
			});
			expect(result.direct).toBe(false);
			expect(result.snapshot?.run.status).toBe("completed");
			expect(executed).toEqual(["inspect", "verify"]);
			expect(result.snapshot?.evidence.some((item) => item.source === "planning-flag-candidate")).toBe(true);
			expect(result.snapshot?.evidence.filter((item) => item.source === "planning-task-result")).toHaveLength(2);
		} finally {
			store.close();
		}
	});

	it("rejects a repeated replan task identity before SQLite insertion", async () => {
		const store = await PlanningStore.open(":memory:");
		const key = "repeat-action";
		const repeatedProposal = (revision: number): PlanningPlanProposal => ({
			schemaVersion: PLANNING_SCHEMA_VERSION,
			expectedRevision: revision,
			rationale: "repeat the same action",
			tasks: [{ key, objective: key, doneWhen: "observed", dependsOn: [] }],
		});
		const supervisor: PlanningSupervisor = {
			async propose({ snapshot }) {
				return repeatedProposal(snapshot.run.revision);
			},
		};
		const executor: PlanningExecutor = {
			async execute({ lease }) {
				return {
					result: {
						schemaVersion: PLANNING_SCHEMA_VERSION,
						leaseId: lease.leaseId,
						outcome: "done",
						summary: "identity smoke completed",
						suggestedTasks: [],
						flagCandidates: [],
					},
					evidence: [
						{
							kind: "tool",
							source: "identity-smoke",
							summary: "identity smoke tool succeeded",
							contentHash: "identity-smoke-hash",
						},
					],
					commitSource: "planning_commit_result",
				};
			},
		};
		try {
			const controller = new ProgressivePlanningController(controllerOptions(store, "active", supervisor, executor));
			await expect(
				controller.execute({
					outerTaskId: "repeat-identity",
					goal: "repeat identity",
					async executeDirect() {
						throw new Error("active mode must not call direct");
					},
				}),
			).rejects.toThrow(`task key already exists in this run: ${key}`);
			const runId = planningRunId("active:repeat-identity", "repeat identity", "active");
			const snapshot = store.snapshot(runId);
			expect(snapshot.run.status).toBe("failed");
			expect(snapshot.run.lastError).toContain("task key already exists in this run");
			expect(snapshot.run.lastError).not.toContain("UNIQUE constraint");
			expect(snapshot.tasks[0]?.taskId).toBe(stablePlanningTaskId(runId, key));
		} finally {
			store.close();
		}
	});

	it("returns an incomplete attempt to the Supervisor for a changed follow-up task", async () => {
		const store = await PlanningStore.open(":memory:");
		let calls = 0;
		const supervisorSnapshots: PlanningSnapshot[] = [];
		const supervisor: PlanningSupervisor = {
			async propose({ snapshot }) {
				supervisorSnapshots.push(snapshot);
				if (
					snapshot.tasks.some(
						(task) => task.objective === "continue after the incomplete attempt" && task.status === "done",
					)
				) {
					return {
						schemaVersion: PLANNING_SCHEMA_VERSION,
						expectedRevision: snapshot.run.revision,
						decision: "finish_run",
						rationale: "continuation complete",
						tasks: [],
						answerEvidenceRefs: snapshot.evidence.slice(-1).map((item) => item.evidenceId),
					};
				}
				if (snapshot.latestFailure) {
					return {
						...singleTaskProposal(snapshot.run.revision, {
							key: "continue-after-missing-commit",
							objective: "continue after the incomplete attempt",
							doneWhen: "follow-up committed",
						}),
					};
				}
				return singleTaskProposal(snapshot.run.revision);
			},
		};
		const executor: PlanningExecutor = {
			async execute({ lease }) {
				calls += 1;
				const result: PlanningExecutionReport["result"] = {
					schemaVersion: PLANNING_SCHEMA_VERSION,
					leaseId: lease.leaseId,
					outcome: "done" as const,
					summary: "completed after recovery",
					suggestedTasks: [],
					flagCandidates: [],
				};
				if (calls === 1) {
					return { result, evidence: [] } as unknown as Awaited<ReturnType<PlanningExecutor["execute"]>>;
				}
				return {
					result,
					evidence: [successfulToolEvidence(lease.objective)],
					commitSource: "planning_commit_result",
				};
			},
		};
		try {
			const controller = new ProgressivePlanningController(controllerOptions(store, "active", supervisor, executor));
			const result = await controller.execute({
				outerTaskId: "commit-retry",
				goal: "recover missing commit",
				async executeDirect() {
					throw new Error("active mode must not call direct");
				},
			});
			expect(calls).toBe(2);
			expect(result.snapshot?.run.status).toBe("completed");
			expect(result.snapshot?.activeLease).toBeUndefined();
			expect(supervisorSnapshots[1]?.latestFailure).toMatchObject({
				code: "executor_error",
				source: "runtime_failure",
			});
			expect(result.snapshot?.tasks.map((task) => [task.objective, task.status])).toEqual([
				["only", "failed"],
				["continue after the incomplete attempt", "done"],
			]);
		} finally {
			store.close();
		}
	});

	it("persists failed-attempt tool evidence before the Supervisor schedules a continuation", async () => {
		const store = await PlanningStore.open(":memory:");
		let calls = 0;
		const goal = "continue after timeout";
		const runId = planningRunId("active:failed-attempt-evidence", goal, "active");
		const supervisor: PlanningSupervisor = {
			async propose({ snapshot }) {
				if (
					snapshot.tasks.some(
						(task) => task.objective === "continue from persisted evidence" && task.status === "done",
					)
				) {
					return {
						schemaVersion: PLANNING_SCHEMA_VERSION,
						expectedRevision: snapshot.run.revision,
						decision: "finish_run",
						rationale: "retry used durable progress",
						tasks: [],
						answerEvidenceRefs: snapshot.evidence.slice(0, 1).map((item) => item.evidenceId),
					};
				}
				if (snapshot.latestFailure) {
					expect(snapshot.latestFailure).toMatchObject({
						code: "executor_timeout",
						checkpointId: "checkpoint-timeout",
						completedItems: ["partial computation"],
						remainingItems: ["narrow the search"],
						suggestedNextSteps: [{ objective: "narrow the search" }],
					});
					return singleTaskProposal(snapshot.run.revision, {
						key: "continue-from-evidence",
						objective: "continue from persisted evidence",
						doneWhen: "continued result committed",
						inputEvidenceRefs: snapshot.latestFailure.evidenceRefs,
					});
				}
				return singleTaskProposal(snapshot.run.revision, {
					key: "initial-attempt",
					objective: "initial attempt",
				});
			},
		};
		const executor: PlanningExecutor = {
			async execute({ lease, context, recordEvidence, recordCheckpoint }) {
				calls += 1;
				if (calls === 1) {
					const evidence = {
						evidenceId: "attempt-evidence-1",
						kind: "tool" as const,
						source: "bash",
						toolName: "bash",
						summary: "partial computation completed",
						excerpt: "checkpoint at iteration 10",
						contentHash: "attempt-evidence-hash",
						metadata: { isError: false },
					};
					recordEvidence?.(evidence);
					expect(store.snapshot(runId).evidence.map((item) => item.evidenceId)).toEqual(["attempt-evidence-1"]);
					recordCheckpoint?.("checkpoint-timeout", {
						summary: "partial computation is available",
						evidenceRefs: ["attempt-evidence-1"],
						completedItems: ["partial computation"],
						remainingItems: ["narrow the search"],
						rejectedDirections: [
							{ direction: "broad brute force", reason: "too expensive", evidenceRefs: ["attempt-evidence-1"] },
						],
						artifacts: [],
						suggestedNextSteps: [
							{
								objective: "narrow the search",
								doneWhen: "narrow search completes",
								inputEvidenceRefs: ["attempt-evidence-1"],
							},
						],
					});
					throw planningFailure("executor", "executor_timeout", "first attempt timed out");
				}
				expect(context).toContain("attempt-evidence-1");
				expect(context).toContain("partial computation is available");
				return {
					result: {
						schemaVersion: PLANNING_SCHEMA_VERSION,
						leaseId: lease.leaseId,
						outcome: "done",
						summary: "continued from the persisted checkpoint",
						suggestedTasks: [],
						flagCandidates: [],
					},
					evidence: [successfulToolEvidence(lease.objective)],
					commitSource: "planning_commit_result",
				};
			},
		};
		try {
			const controller = new ProgressivePlanningController(controllerOptions(store, "active", supervisor, executor));
			const result = await controller.execute({
				outerTaskId: "failed-attempt-evidence",
				goal,
				async executeDirect() {
					throw new Error("active mode must not call direct");
				},
			});

			expect(calls).toBe(2);
			expect(result.snapshot?.run.status).toBe("completed");
			expect(result.snapshot?.latestFailure).toMatchObject({
				code: "executor_timeout",
				objective: "initial attempt",
			});
			expect(result.snapshot?.tasks.map((task) => [task.objective, task.status])).toEqual([
				["initial attempt", "failed"],
				["continue from persisted evidence", "done"],
			]);
			expect(result.snapshot?.tasks[1]?.inputEvidenceRefs).toContain("attempt-evidence-1");
			expect(
				result.snapshot?.evidence.find((item) => item.evidenceId === "attempt-evidence-1")?.metadata,
			).toMatchObject({
				attemptFailed: true,
			});
			const eventTypes = store.listLifecycleEvents(result.runId!).events.map((event) => event.type);
			expect(eventTypes).toContain("evidence_saved");
			expect(eventTypes).toContain("planning_checkpoint_saved");
			expect(eventTypes).toContain("attempt_sealed");
			const contextEvents = store
				.listLifecycleEvents(result.runId!)
				.events.filter((event) => event.type === "planning_context_rendered");
			expect(contextEvents).toHaveLength(2);
			expect(contextEvents[1]?.payload).toMatchObject({
				contextRole: "executor",
				taskId: result.snapshot?.tasks[1]?.taskId,
				leaseId: expect.any(String),
				contextBytes: expect.any(Number),
				contextLimitBytes: 16_384,
				evidenceRefsPresented: expect.arrayContaining(["attempt-evidence-1"]),
				checkpointRefsPresented: expect.arrayContaining(["checkpoint-timeout"]),
			});
		} finally {
			store.close();
		}
	});

	it("does not retry a failed task when the Supervisor has no viable continuation", async () => {
		const store = await PlanningStore.open(":memory:");
		let calls = 0;
		const supervisor: PlanningSupervisor = {
			async propose({ snapshot }) {
				if (snapshot.latestFailure) {
					return {
						schemaVersion: PLANNING_SCHEMA_VERSION,
						expectedRevision: snapshot.run.revision,
						decision: "blocked",
						rationale: "no viable continuation after the missing commit",
						tasks: [],
					};
				}
				return singleTaskProposal(snapshot.run.revision);
			},
		};
		const executor: PlanningExecutor = {
			async execute({ lease }) {
				calls += 1;
				return {
					result: {
						schemaVersion: PLANNING_SCHEMA_VERSION,
						leaseId: lease.leaseId,
						outcome: "done" as const,
						summary: "legacy final text result",
						suggestedTasks: [],
						flagCandidates: [],
					},
					evidence: [],
				} as unknown as Awaited<ReturnType<PlanningExecutor["execute"]>>;
			},
		};
		const goal = "reject missing commit";
		const runId = planningRunId("active:commit-reject", goal, "active");
		try {
			const controller = new ProgressivePlanningController(controllerOptions(store, "active", supervisor, executor));
			const result = await controller.execute({
				outerTaskId: "commit-reject",
				goal,
				async executeDirect() {
					throw new Error("active mode must not call direct");
				},
			});
			expect(result.snapshot?.run.status).toBe("blocked");
			expect(calls).toBe(1);
			expect(store.snapshot(runId).run.status).toBe("blocked");
			expect(store.snapshot(runId).latestFailure).toMatchObject({ code: "executor_error" });
			expect(store.snapshot(runId).tasks[0]?.status).toBe("failed");
			expect(store.snapshot(runId).activeLease).toBeUndefined();
		} finally {
			store.close();
		}
	});

	it("recovers an abandoned active lease before resuming", async () => {
		const store = await PlanningStore.open(":memory:");
		const goal = "resume challenge";
		const outerTaskId = "active:challenge-resume";
		const runId = planningRunId(outerTaskId, goal, "active");
		const executed: string[] = [];
		const supervisor: PlanningSupervisor = {
			async propose({ snapshot }) {
				return orderedProposal(snapshot);
			},
		};
		try {
			store.createRun({ runId, outerTaskId, goal, mode: "active" });
			const firstPlan = proposal(0);
			store.commitPlan({
				runId,
				expectedRevision: 0,
				rationale: firstPlan.rationale,
				idempotencyKey: "seed-plan",
				tasks: [
					{
						taskId: "inspect",
						objective: "inspect",
						doneWhen: "observed",
						priority: 2,
						sequence: 0,
						dependsOnTaskIds: [],
					},
					{
						taskId: "verify",
						objective: "verify",
						doneWhen: "verified",
						priority: 1,
						sequence: 1,
						dependsOnTaskIds: ["inspect"],
					},
				],
			});
			const abandoned = store.leaseTask(runId, "inspect", "/work", 60_000);
			store.startLease(abandoned.leaseId);
			const controller = new ProgressivePlanningController(
				controllerOptions(store, "active", supervisor, successfulExecutor(executed)),
			);
			const result = await controller.execute({
				outerTaskId: "challenge-resume",
				goal,
				async executeDirect() {
					throw new Error("active mode must not call direct");
				},
			});
			expect(result.snapshot?.run.status).toBe("completed");
			expect(executed).toEqual(["inspect", "verify"]);
			expect(result.snapshot?.activeLease).toBeUndefined();
		} finally {
			store.close();
		}
	});

	it("cancels a run while the Supervisor is in flight", async () => {
		const store = await PlanningStore.open(":memory:");
		const abortController = new AbortController();
		let signalObserved!: () => void;
		const supervisor: PlanningSupervisor = {
			propose({ signal }) {
				return new Promise<PlanningPlanProposal>((_resolve, reject) => {
					signalObserved = () => reject(signal?.reason ?? new Error("supervisor aborted"));
					signal?.addEventListener("abort", signalObserved, { once: true });
				});
			},
		};
		const executor: PlanningExecutor = {
			async execute() {
				throw new Error("executor must not start");
			},
		};
		const goal = "cancel supervisor";
		const runId = planningRunId("active:cancel-supervisor", goal, "active");
		try {
			const controller = new ProgressivePlanningController(controllerOptions(store, "active", supervisor, executor));
			const running = controller.execute({
				outerTaskId: "cancel-supervisor",
				goal,
				signal: abortController.signal,
				async executeDirect() {
					throw new Error("active mode must not call direct");
				},
			});
			await vi.waitFor(() => expect(signalObserved).toBeTypeOf("function"));
			abortController.abort(new Error("operator cancelled"));
			await expect(running).rejects.toThrow("operator cancelled");
			expect(store.snapshot(runId).run.status).toBe("cancelled");
			expect(store.snapshot(runId).activeLease).toBeUndefined();
		} finally {
			store.close();
		}
	});

	it("cancels an active lease when the Executor is aborted", async () => {
		const store = await PlanningStore.open(":memory:");
		const abortController = new AbortController();
		let signalObserved!: () => void;
		const supervisor: PlanningSupervisor = {
			async propose({ snapshot }) {
				return singleTaskProposal(snapshot.run.revision);
			},
		};
		const executor: PlanningExecutor = {
			execute({ signal }) {
				return new Promise<PlanningExecutionReport>((_resolve, reject) => {
					signalObserved = () => reject(signal?.reason ?? new Error("executor aborted"));
					signal?.addEventListener("abort", signalObserved, { once: true });
				});
			},
		};
		const goal = "cancel executor";
		const runId = planningRunId("active:cancel-executor", goal, "active");
		try {
			const controller = new ProgressivePlanningController(controllerOptions(store, "active", supervisor, executor));
			const running = controller.execute({
				outerTaskId: "cancel-executor",
				goal,
				signal: abortController.signal,
				async executeDirect() {
					throw new Error("active mode must not call direct");
				},
			});
			await vi.waitFor(() => expect(signalObserved).toBeTypeOf("function"));
			abortController.abort(new Error("operator cancelled"));
			await expect(running).rejects.toThrow("operator cancelled");
			const snapshot = store.snapshot(runId);
			expect(snapshot.run.status).toBe("cancelled");
			expect(snapshot.tasks[0]?.status).toBe("ready");
			expect(snapshot.activeLease).toBeUndefined();
		} finally {
			store.close();
		}
	});

	it("fences a result when the parent aborts before commit", async () => {
		const store = await PlanningStore.open(":memory:");
		const abortController = new AbortController();
		const supervisor: PlanningSupervisor = {
			async propose({ snapshot }) {
				return singleTaskProposal(snapshot.run.revision);
			},
		};
		const executor: PlanningExecutor = {
			async execute({ lease }) {
				abortController.abort(new Error("abort before commit"));
				return {
					result: {
						schemaVersion: PLANNING_SCHEMA_VERSION,
						leaseId: lease.leaseId,
						outcome: "done",
						summary: "late result",
						suggestedTasks: [],
						flagCandidates: [],
					},
					evidence: [{ kind: "tool", source: "late", summary: "late", contentHash: "late" }],
					commitSource: "planning_commit_result",
				};
			},
		};
		const goal = "abort before commit";
		const runId = planningRunId("active:abort-before-commit", goal, "active");
		try {
			const controller = new ProgressivePlanningController(controllerOptions(store, "active", supervisor, executor));
			const running = controller.execute({
				outerTaskId: "abort-before-commit",
				goal,
				signal: abortController.signal,
				async executeDirect() {
					throw new Error("active mode must not call direct");
				},
			});
			await expect(running).rejects.toThrow("abort before commit");
			const snapshot = store.snapshot(runId);
			expect(snapshot.run.status).toBe("cancelled");
			expect(snapshot.tasks[0]?.status).toBe("ready");
			expect(snapshot.activeLease).toBeUndefined();
		} finally {
			store.close();
		}
	});

	it("classifies a finish decision without persisted answer evidence as a terminal contract failure", async () => {
		const store = await PlanningStore.open(":memory:");
		const supervisor: PlanningSupervisor = {
			async propose({ snapshot }) {
				return {
					schemaVersion: PLANNING_SCHEMA_VERSION,
					expectedRevision: snapshot.run.revision,
					decision: "finish_run",
					rationale: "claim completion without evidence",
					tasks: [],
					answerEvidenceRefs: [],
				};
			},
		};
		const goal = "terminal contract smoke";
		const runId = planningRunId("active:terminal-contract", goal, "active");
		try {
			const controller = new ProgressivePlanningController(
				controllerOptions(store, "active", supervisor, {
					async execute() {
						throw new Error("must not execute");
					},
				}),
			);
			await expect(
				controller.execute({
					outerTaskId: "terminal-contract",
					goal,
					async executeDirect() {
						throw new Error("active mode must not call direct");
					},
				}),
			).rejects.toMatchObject({
				name: "PlanningFailureError",
				source: "planning",
				stage: "terminal_contract",
				code: "terminal_contract_error",
			});
			const snapshot = store.snapshot(runId);
			expect(snapshot.run.status).toBe("failed");
			expect(snapshot.run.lastError).toContain("without valid persisted answer evidence");
		} finally {
			store.close();
		}
	});
});
