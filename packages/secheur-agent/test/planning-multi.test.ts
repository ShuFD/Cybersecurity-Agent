import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeSqliteFactory } from "@earendil-works/pi-session-backend-sqlite-node";
import { describe, expect, it, vi } from "vitest";
import {
	PLANNING_SCHEMA_VERSION,
	type PlanningExecutionReport,
	type PlanningPlanProposal,
	type PlanningTaskLease,
	type PlanningTaskResult,
} from "../src/planning/contracts.ts";
import { ProgressivePlanningController } from "../src/planning/controller.ts";
import { PlanningCapacityControl, PlanningExecutorPool } from "../src/planning/execution-pool.ts";
import { planningFailure } from "../src/planning/failures.ts";
import { reduceExecutionFrame } from "../src/planning/frame-reducer.ts";
import {
	type PlanningExecutor,
	type PlanningHarnessOptions,
	type PlanningSupervisor,
	runPlanningHarness,
} from "../src/planning/harness.ts";
import { PlanningStore } from "../src/planning/store.ts";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function seed(runId = "multi", path = ":memory:", dependencies = false, keys = ["a", "b", "c"]) {
	const store = await PlanningStore.open(path);
	store.createRun({ runId, outerTaskId: runId, goal: "investigate", mode: "active" });
	store.commitPlan({
		runId,
		expectedRevision: 0,
		rationale: "independent investigations",
		idempotencyKey: runId,
		tasks: keys.map((key, sequence) => ({
			taskId: `${runId}-${key}`,
			objective: key,
			doneWhen: "observed",
			priority: 3 - sequence,
			sequence,
			dependsOnTaskIds: dependencies && key === "c" ? [`${runId}-a`] : [],
		})),
	});
	return store;
}

function report(lease: PlanningTaskLease, factValue = lease.objective): PlanningExecutionReport {
	return {
		commitSource: "planning_commit_result",
		result: {
			schemaVersion: PLANNING_SCHEMA_VERSION,
			leaseId: lease.leaseId,
			outcome: "done",
			summary: factValue,
			suggestedTasks: [],
			flagCandidates: [],
			evidenceRefs: [`e-${lease.leaseId}`],
			facts: [{ key: "same-key", value: factValue, evidenceRefs: [`e-${lease.leaseId}`] }],
			rejectedDirections: [{ direction: "same-direction", reason: factValue, evidenceRefs: [`e-${lease.leaseId}`] }],
			openQuestions: [{ questionId: "Q1", text: factValue }],
		},
		evidence: [
			{
				evidenceId: `e-${lease.leaseId}`,
				kind: "tool",
				source: "test-tool",
				toolName: "test-tool",
				summary: factValue,
				contentHash: lease.leaseId,
				metadata: { isError: false },
			},
		],
	};
}

function verifiedReport(lease: PlanningTaskLease): PlanningExecutionReport {
	const value = report(lease);
	const evidenceId = `proof-${lease.leaseId}`;
	value.evidence.push({
		evidenceId,
		kind: "tool",
		source: "verify_flag",
		toolName: "verify_flag",
		summary: "accepted fixture",
		contentHash: "proof",
		excerpt: JSON.stringify({ details: { data: { ok: true, status: "correct", verified: true } } }),
		metadata: { isError: false, toolCallId: "proof-call", evidenceId, verificationOutcome: "correct" },
	});
	return value;
}

function options(
	store: PlanningStore,
	executor: PlanningExecutor,
	extra: Partial<PlanningHarnessOptions> = {},
): PlanningHarnessOptions {
	return {
		store,
		executor,
		supervisor: {
			propose: vi.fn<PlanningSupervisor["propose"]>(
				async ({ snapshot }): Promise<PlanningPlanProposal> => ({
					schemaVersion: PLANNING_SCHEMA_VERSION,
					expectedRevision: snapshot.run.revision,
					decision: "blocked",
					rationale: "offline investigation finished",
					tasks: [],
				}),
			),
		},
		maximumSteps: 8,
		maximumTasks: 16,
		leaseTtlMs: 30_000,
		maximumEvidenceBytes: 32_768,
		allowedScope: "/work",
		executionCapacity: 2,
		executorPool: new PlanningExecutorPool(7),
		...extra,
	};
}

it("wakes a long single-owner queue without cancelling that owner or requiring filler work", async () => {
	const store = await seed("vacancy-review", ":memory:", false, ["a"]);
	const gate = deferred();
	const parent = new AbortController();
	const supervisor = vi.fn<PlanningSupervisor["propose"]>(async ({ snapshot }) => ({
		schemaVersion: PLANNING_SCHEMA_VERSION,
		expectedRevision: snapshot.run.revision,
		decision: "blocked",
		rationale: "one owner still covers the synthetic work",
		tasks: [],
	}));
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const run = runPlanningHarness(
		"vacancy-review",
		options(
			store,
			{
				execute: async ({ lease }) => {
					await gate.promise;
					return report(lease);
				},
			},
			{ supervisor: { propose: supervisor }, leaseTtlMs: 1000000, signal: parent.signal },
		),
	);
	try {
		for (let i = 0; i < 20; i++) await Promise.resolve();
		const before = supervisor.mock.calls.length;
		expect(before).toBeGreaterThan(0);
		await vi.advanceTimersByTimeAsync(120001);
		expect(supervisor.mock.calls.length).toBeGreaterThan(before);
		expect(parent.signal.aborted).toBe(false);
		expect(store.snapshot("vacancy-review", true).activeLeases).toHaveLength(1);
		gate.resolve();
		await run;
	} finally {
		gate.resolve();
		await run.catch(() => {});
		vi.useRealTimers();
		store.close();
	}
});

describe("PLAN_MULTI bounded execution", () => {
	it("recovers an empty managed queue after a committed task becomes failed instead of stopping the run", async () => {
		const store = await seed("empty-recovery", ":memory:", false, []);
		const commit = store.commitPlan.bind(store);
		let failFirst = true;
		const spy = vi.spyOn(store, "commitPlan").mockImplementation((input) => {
			const snapshot = commit(input);
			if (!failFirst) return snapshot;
			failFirst = false;
			const lease = store.leaseTask(input.runId, input.tasks[0]!.taskId, "/work", 30_000);
			store.startLease(lease.leaseId);
			return store.commitResult({
				leaseId: lease.leaseId,
				planRevision: lease.planRevision,
				outcome: "failed",
				summary: "prerequisite failed before scheduling",
				evidence: [],
			});
		});
		let calls = 0;
		let recoverySeen = false;
		try {
			const result = await runPlanningHarness(
				"empty-recovery",
				options(
					store,
					{
						execute: async ({ lease }) => verifiedReport(lease),
					},
					{
						requireTrustedCompletion: true,
						recoverPlanningFailures: false,
						supervisor: {
							propose: async ({ snapshot, recovery }) => {
								calls++;
								recoverySeen ||= recovery?.message.includes("No runnable task") === true;
								return {
									schemaVersion: PLANNING_SCHEMA_VERSION,
									expectedRevision: snapshot.run.revision,
									decision: "create_tasks",
									rationale: "recover independently",
									tasks: [
										{
											key: `independent-${calls}`,
											objective: `independent fixture ${calls}`,
											doneWhen: "native proof is saved",
											dependsOn: [],
										},
									],
								};
							},
						},
					},
				),
			);
			expect(result.run.status).toBe("completed");
			expect(recoverySeen).toBe(true);
			expect(store.listLifecycleEvents("empty-recovery").events.some((event) => event.type === "run_blocked")).toBe(
				false,
			);
		} finally {
			spy.mockRestore();
			store.close();
		}
	});
	it("preserves live actionable feedback without model replanning while both slots are occupied", async () => {
		const store = await seed("checkpoint-live", ":memory:", false, ["a", "b"]);
		const hold = deferred();
		let running = 0;
		let save: (() => void) | undefined;
		const supervisor = {
			propose: vi.fn<PlanningSupervisor["propose"]>(async ({ snapshot }) => {
				expect(snapshot.latestCheckpoint?.checkpointId).toBe("live-feedback");
				return {
					schemaVersion: PLANNING_SCHEMA_VERSION,
					expectedRevision: snapshot.run.revision,
					decision: "blocked",
					rationale: "retain useful workers",
					tasks: [],
				};
			}),
		};
		const controller = new AbortController();
		const run = runPlanningHarness(
			"checkpoint-live",
			options(
				store,
				{
					execute: async (input) => {
						running++;
						if (input.lease.taskId.endsWith("-a"))
							save = () =>
								input.recordCheckpoint!("live-feedback", {
									summary: "fixture feedback",
									evidenceRefs: [],
									completedItems: [],
									remainingItems: ["fixture"],
									rejectedDirections: [],
									artifacts: [],
									suggestedNextSteps: [{ objective: "independent next fixture", doneWhen: "observed" }],
								});
						await hold.promise;
						running--;
						return verifiedReport(input.lease);
					},
				},
				{
					supervisor,
					requireTrustedCompletion: true,
					recoverPlanningFailures: true,
					executorPool: undefined,
					signal: controller.signal,
				},
			),
		);
		try {
			await vi.waitFor(() => expect(running).toBe(2));
			save!();
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(supervisor.propose).not.toHaveBeenCalled();
			expect(running).toBe(2);
			hold.resolve();
			expect((await run).run.status).toBe("completed");
			expect(supervisor.propose).not.toHaveBeenCalled();
		} finally {
			hold.resolve();
			controller.abort();
			await run.catch(() => {});
			store.close();
		}
	});
	it("gives five simultaneous runs two independent slots each, without a global seven-slot cap", async () => {
		const stores = await Promise.all(Array.from({ length: 5 }, (_, i) => seed(`isolated-${i}`)));
		const hold = deferred();
		const active = [0, 0, 0, 0, 0],
			peaks = [0, 0, 0, 0, 0];
		let total = 0,
			peak = 0;
		const runs = stores.map((store, i) =>
			runPlanningHarness(
				`isolated-${i}`,
				options(
					store,
					{
						execute: async ({ lease }) => {
							active[i]++;
							peaks[i] = Math.max(peaks[i], active[i]);
							total++;
							peak = Math.max(peak, total);
							await hold.promise;
							active[i]--;
							total--;
							return report(lease);
						},
					},
					{ executorPool: undefined, executionCapacity: 2, maximumSteps: 3 },
				),
			),
		);
		try {
			await expect.poll(() => active).toEqual([2, 2, 2, 2, 2]);
			expect(peak).toBe(10);
			hold.resolve();
			await Promise.all(runs);
			expect(peaks).toEqual([2, 2, 2, 2, 2]);
			expect(total).toBe(0);
		} finally {
			hold.resolve();
			await Promise.allSettled(runs);
			for (const store of stores) store.close();
		}
	});
	it("continues managed work beyond both legacy step and task caps until trusted proof", async () => {
		const store = await seed("multi", ":memory:", false, []);
		let attempts = 0;
		try {
			const result = await runPlanningHarness(
				"multi",
				options(
					store,
					{
						execute: async ({ lease }) => (++attempts === 14 ? verifiedReport(lease) : report(lease)),
					},
					{
						requireTrustedCompletion: true,
						maximumSteps: 12,
						maximumTasks: 12,
						supervisor: {
							propose: async ({ snapshot }) => ({
								schemaVersion: 1,
								expectedRevision: snapshot.run.revision,
								decision: "create_tasks",
								rationale: "continue fixture",
								tasks: [
									{
										key: `next-${snapshot.run.revision}`,
										objective: `step-${snapshot.run.revision}`,
										doneWhen: "saved",
									},
								],
							}),
						},
					},
				),
			);
			expect(attempts).toBe(14);
			expect(result.run.status).toBe("completed");
		} finally {
			store.close();
		}
	});
	it("renews a long managed lease and clears renewal on cancellation", async () => {
		const store = await seed("multi", ":memory:", false, ["a"]);
		const parent = new AbortController();
		const renew = vi.spyOn(store, "renewLease");
		const operation = runPlanningHarness(
			"multi",
			options(
				store,
				{
					execute: async ({ signal }) => {
						await new Promise<void>((resolve) =>
							signal?.addEventListener("abort", () => resolve(), { once: true }),
						);
						throw signal?.reason;
					},
				},
				{ requireTrustedCompletion: true, leaseTtlMs: 30, signal: parent.signal, executionCapacity: 1 },
			),
		);
		const rejected = expect(operation).rejects.toThrow("fixture cancel");
		try {
			await expect.poll(() => renew.mock.calls.length).toBeGreaterThan(1);
			parent.abort(new Error("fixture cancel"));
			await rejected;
			const calls = renew.mock.calls.length;
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(renew).toHaveBeenCalledTimes(calls);
			store.cancelActiveLease("multi", "caller cancelled fixture");
			expect(() => store.renewLease(renew.mock.calls[0][0], 30)).toThrow("Active planning lease not found");
		} finally {
			parent.abort();
			await operation.catch(() => {});
			store.close();
		}
	});
	it("prepares a plan while the global worker pool is full and records the queue wait", async () => {
		const store = await seed("multi", ":memory:", false, []);
		const pool = new PlanningExecutorPool(1);
		const release = await pool.acquire();
		const executor = { execute: vi.fn<PlanningExecutor["execute"]>(async ({ lease }) => report(lease)) };
		let planned = false;
		const operation = runPlanningHarness(
			"multi",
			options(store, executor, {
				executorPool: pool,
				maximumSteps: 1,
				supervisor: {
					propose: async ({ snapshot }) => {
						planned = true;
						return {
							schemaVersion: 1,
							expectedRevision: snapshot.run.revision,
							decision: "create_tasks",
							rationale: "fixture plan",
							tasks: [{ key: "a", objective: "a", doneWhen: "saved" }],
						};
					},
				},
			}),
		);
		try {
			await expect.poll(() => planned).toBe(true);
			await expect.poll(() => store.snapshot("multi").tasks.length).toBe(1);
			expect(executor.execute).not.toHaveBeenCalled();
			release();
			await operation;
			const event = store.listLifecycleEvents("multi").events.find((event) => event.type === "executor_queue_end");
			expect(event?.payload.queueWaitMs).toBeGreaterThanOrEqual(0);
		} finally {
			release();
			await operation.catch(() => {});
			store.close();
		}
	});
	it("honors parent cancellation during proposal backoff without starting more work", async () => {
		const store = await seed("multi", ":memory:", false, []);
		const parent = new AbortController();
		const executor = { execute: vi.fn<PlanningExecutor["execute"]>() };
		const supervisor = {
			propose: vi.fn<PlanningSupervisor["propose"]>(async () => {
				throw planningFailure("supervisor_parse", "supervisor_parse_error", "fixture invalid JSON");
			}),
		};
		try {
			const run = runPlanningHarness(
				"multi",
				options(store, executor, { recoverPlanningFailures: true, signal: parent.signal, supervisor }),
			);
			const rejected = expect(run).rejects.toThrow("operator cancellation");
			await expect
				.poll(() =>
					store.listLifecycleEvents("multi").events.some((event) => event.type === "planning_recovery_pending"),
				)
				.toBe(true);
			parent.abort(new Error("operator cancellation"));
			await rejected;
			expect(supervisor.propose).toHaveBeenCalledOnce();
			expect(executor.execute).not.toHaveBeenCalled();
		} finally {
			parent.abort();
			store.close();
		}
	});
	it.each([
		[1, "supervisor_parse_error"],
		[2, "supervisor_parse_error"],
		[2, "planning_internal_error"],
	] as const)(
		"recovers a failed first plan without needing an existing child (capacity=%s, code=%s)",
		async (executionCapacity, code) => {
			const store = await seed("multi", ":memory:", false, []);
			let calls = 0;
			try {
				const snapshot = await runPlanningHarness(
					"multi",
					options(
						store,
						{ execute: async ({ lease }) => verifiedReport(lease) },
						{
							recoverPlanningFailures: true,
							executionCapacity,
							requireTrustedCompletion: true,
							maximumSteps: 1,
							supervisor: {
								async propose({ snapshot, recovery }) {
									if (++calls === 1)
										throw planningFailure(
											code === "planning_internal_error" ? "supervisor" : "supervisor_parse",
											code,
											"fixture proposal failure",
										);
									expect(recovery?.code).toBe(code);
									return {
										schemaVersion: 1,
										expectedRevision: snapshot.run.revision,
										decision: "create_tasks",
										rationale: "corrected",
										tasks: [{ key: "next", objective: "fixture work", doneWhen: "saved" }],
									};
								},
							},
						},
					),
				);
				expect(calls).toBe(2);
				expect(snapshot.run.status).toBe("completed");
				expect(snapshot.tasks[0].status).toBe("done");
			} finally {
				store.close();
			}
		},
	);
	it("rejects unverified completion while a sibling continues, then appends useful work", async () => {
		const store = await seed("multi", ":memory:", false, ["a", "b"]);
		let calls = 0;
		let siblingAborted = false;
		try {
			const snapshot = await runPlanningHarness(
				"multi",
				options(
					store,
					{
						async execute({ lease, signal }) {
							if (lease.objective === "b") {
								await new Promise((resolve) => setTimeout(resolve, 3_000));
								siblingAborted = signal?.aborted === true;
							}
							return lease.objective === "additional fixture work" ? verifiedReport(lease) : report(lease);
						},
					},
					{
						recoverPlanningFailures: true,
						requireTrustedCompletion: true,
						maximumSteps: 3,
						supervisor: {
							async propose({ snapshot, recovery }) {
								if (++calls === 1)
									return {
										schemaVersion: 1,
										expectedRevision: snapshot.run.revision,
										decision: "finish_run",
										rationale: "model claims done",
										tasks: [],
										answerEvidenceRefs: [snapshot.evidence[0].evidenceId],
									};
								expect(recovery?.code).toBe("terminal_contract_error");
								return {
									schemaVersion: 1,
									expectedRevision: snapshot.run.revision,
									decision: "create_tasks",
									rationale: "continue",
									tasks: [{ key: "next", objective: "additional fixture work", doneWhen: "saved" }],
								};
							},
						},
					},
				),
			);
			expect(snapshot.run.status).toBe("completed");
			expect(siblingAborted).toBe(true);
			expect(
				snapshot.tasks.some((task) => task.objective === "additional fixture work" && task.status === "done"),
			).toBe(true);
		} finally {
			store.close();
		}
	});
	it("keeps a sibling running after a timeout with pending cleanup and retains the cleanup slot", async () => {
		const store = await seed("multi", ":memory:", false, ["a", "b"]);
		const cleanup = deferred();
		const pool = new PlanningExecutorPool(2);
		let siblingAborted = false;
		try {
			const snapshot = await runPlanningHarness(
				"multi",
				options(
					store,
					{
						async execute({ lease, signal, onPendingSettlement }) {
							if (lease.objective === "a") {
								onPendingSettlement?.(cleanup.promise);
								throw planningFailure("executor", "executor_timeout", "fixture timeout");
							}
							await new Promise((resolve) => setTimeout(resolve, 25));
							siblingAborted = signal?.aborted === true;
							return report(lease);
						},
					},
					{ executorPool: pool, maximumSteps: 2 },
				),
			);
			expect(snapshot.run.status).toBe("paused");
			expect(siblingAborted).toBe(false);
			expect(snapshot.tasks.find((task) => task.objective === "b")?.status).toBe("done");
			expect(pool.getStatus().active).toBe(1);
			cleanup.resolve();
			await expect.poll(() => pool.getStatus().active).toBe(0);
		} finally {
			cleanup.resolve();
			store.close();
		}
	});
	it("recovers ordinary verifier errors but preserves quota exhaustion as terminal", async () => {
		for (const code of ["verifier_unavailable", "verifier_quota_exhausted"] as const) {
			const store = await seed("multi", ":memory:", false, ["a"]);
			try {
				const run = runPlanningHarness(
					"multi",
					options(
						store,
						{
							async execute() {
								throw planningFailure("executor", code, "fixture verifier error");
							},
						},
						{ maximumSteps: 1 },
					),
				);
				if (code === "verifier_quota_exhausted") await expect(run).rejects.toMatchObject({ code });
				else expect((await run).run.status).toBe("paused");
			} finally {
				store.close();
			}
		}
	});
	it.each([false, true])("retains a slot until pending settlement completes (reject=%s)", async (reject) => {
		const store = await seed("multi", ":memory:", false, ["a"]);
		const pool = new PlanningExecutorPool(1);
		let finish = () => {};
		const pending = new Promise<void>((resolve, fail) => {
			finish = () => (reject ? fail(new Error("cleanup failed after idle")) : resolve());
		});
		try {
			await runPlanningHarness(
				"multi",
				options(
					store,
					{
						async execute({ lease, onPendingSettlement }) {
							onPendingSettlement?.(pending);
							return report(lease);
						},
					},
					{ executorPool: pool, maximumSteps: 1 },
				),
			);
			expect(pool.getStatus().active).toBe(1);
			finish();
			await expect.poll(() => pool.getStatus().active).toBe(0);
			expect(pool.tryAcquire()).toBeTypeOf("function");
		} finally {
			finish();
			await pending.catch(() => {});
			store.close();
		}
	});

	it("revalidates but still appends a structurally valid task planned before sibling progress", async () => {
		const store = await seed("multi", ":memory:", false, ["a", "b"]);
		const a = deferred(),
			b = deferred(),
			planning = deferred();
		let calls = 0;
		const starts: string[] = [];
		const supervisor: PlanningSupervisor = {
			async propose({ snapshot }) {
				calls++;
				if (calls === 1) {
					expect(snapshot.tasks.find((task) => task.objective === "b")?.status).toBe("running");
					await planning.promise;
					return {
						schemaVersion: 1,
						expectedRevision: snapshot.run.revision,
						decision: "create_tasks",
						rationale: "planned before B delivered progress",
						tasks: [{ key: "c", objective: "c", doneWhen: "observed" }],
					};
				}
				return {
					schemaVersion: 1,
					expectedRevision: snapshot.run.revision,
					decision: "blocked",
					rationale: "finished",
					tasks: [],
				};
			},
		};
		const operation = runPlanningHarness(
			"multi",
			options(
				store,
				{
					async execute({ lease }) {
						starts.push(lease.objective);
						if (lease.objective === "a") await a.promise;
						if (lease.objective === "b") await b.promise;
						return report(lease);
					},
				},
				{ supervisor },
			),
		);
		try {
			await expect.poll(() => starts.length).toBe(2);
			a.resolve();
			await expect.poll(() => calls).toBe(1);
			const oldRevision = store.snapshot("multi").run.revision;
			b.resolve();
			await expect.poll(() => store.snapshot("multi").tasks.every((task) => task.status === "done")).toBe(true);
			expect(store.snapshot("multi").run.revision).toBe(oldRevision);
			expect(store.snapshot("multi").evidence.filter((item) => item.kind === "tool")).toHaveLength(2);
			planning.resolve();
			await operation;
			expect(starts).toEqual(["a", "b", "c"]);
		} finally {
			a.resolve();
			b.resolve();
			planning.resolve();
			await operation.catch(() => {});
			store.close();
		}
	});

	it.each(["supervisor_parse_error", "supervisor_validation_error", "proposal_validation_error"])(
		"waits for healthy sibling progress after rolling %s without same-state retries",
		async (code) => {
			const store = await seed("multi", ":memory:", false, ["a", "b"]);
			const a = deferred(),
				b = deferred();
			let starts = 0,
				cancelled = false;
			const supervisor = {
				propose: vi.fn<PlanningSupervisor["propose"]>(async ({ snapshot }) => {
					if (supervisor.propose.mock.calls.length === 1)
						throw planningFailure("supervisor_parse", code, "recoverable proposal failure");
					expect(snapshot.tasks.every((task) => task.status === "done")).toBe(true);
					return {
						schemaVersion: 1,
						expectedRevision: snapshot.run.revision,
						decision: "blocked",
						rationale: "finished",
						tasks: [],
					};
				}),
			};
			const operation = runPlanningHarness(
				"multi",
				options(
					store,
					{
						async execute({ lease, signal }) {
							starts++;
							signal?.addEventListener(
								"abort",
								() => {
									cancelled = true;
								},
								{ once: true },
							);
							await (lease.objective === "a" ? a.promise : b.promise);
							return report(lease);
						},
					},
					{ supervisor },
				),
			);
			try {
				await expect.poll(() => starts).toBe(2);
				a.resolve();
				await expect.poll(() => supervisor.propose.mock.calls.length).toBe(1);
				await Promise.resolve();
				await Promise.resolve();
				expect(cancelled).toBe(false);
				expect(store.snapshot("multi").tasks.find((task) => task.objective === "b")?.status).toBe("running");
				b.resolve();
				expect((await operation).run.status).toBe("blocked");
				expect(supervisor.propose).toHaveBeenCalledTimes(2);
				expect(store.snapshot("multi").tasks.every((task) => task.status === "done")).toBe(true);
			} finally {
				a.resolve();
				b.resolve();
				await operation.catch(() => {});
				store.close();
			}
		},
	);

	it("also defers append-time validation failure while a healthy sibling runs", async () => {
		const store = await seed("multi", ":memory:", false, ["a", "b"]);
		const a = deferred(),
			b = deferred();
		let starts = 0;
		const supervisor = {
			propose: vi.fn<PlanningSupervisor["propose"]>(
				async ({ snapshot }): Promise<PlanningPlanProposal> => ({
					schemaVersion: 1,
					expectedRevision: snapshot.run.revision,
					decision: supervisor.propose.mock.calls.length === 1 ? "create_tasks" : "blocked",
					rationale: "append",
					tasks:
						supervisor.propose.mock.calls.length === 1
							? [{ key: "other-key", objective: "a", doneWhen: "observed" }]
							: [],
				}),
			),
		};
		const operation = runPlanningHarness(
			"multi",
			options(
				store,
				{
					async execute({ lease }) {
						starts++;
						await (lease.objective === "a" ? a.promise : b.promise);
						return report(lease);
					},
				},
				{ supervisor },
			),
		);
		try {
			await expect.poll(() => starts).toBe(2);
			a.resolve();
			await expect.poll(() => supervisor.propose.mock.calls.length).toBe(1);
			b.resolve();
			expect((await operation).tasks.every((task) => task.status === "done")).toBe(true);
			expect(supervisor.propose).toHaveBeenCalledTimes(2);
		} finally {
			a.resolve();
			b.resolve();
			await operation.catch(() => {});
			store.close();
		}
	});

	it("still propagates the initial Planner failure when no existing work can continue", async () => {
		const store = await PlanningStore.open(":memory:");
		store.createRun({ runId: "multi", outerTaskId: "multi", goal: "test", mode: "active" });
		const supervisor = {
			propose: vi.fn<PlanningSupervisor["propose"]>(async () => {
				throw planningFailure("supervisor_parse", "supervisor_parse_error", "initial failure");
			}),
		};
		try {
			await expect(
				runPlanningHarness("multi", options(store, { execute: vi.fn() }, { supervisor })),
			).rejects.toMatchObject({ code: "supervisor_parse_error" });
			expect(supervisor.propose).toHaveBeenCalledOnce();
		} finally {
			store.close();
		}
	});

	it.each([false, true])(
		"preserves trusted proof but surfaces sibling Store failure (during drain=%s)",
		async (duringDrain) => {
			const store = await seed("multi", ":memory:", false, ["a", "b"]);
			const proofReady = deferred();
			try {
				await expect(
					runPlanningHarness(
						"multi",
						options(store, {
							async execute({ lease, recordEvidence, signal }) {
								if (lease.objective === "a") {
									recordEvidence?.({
										evidenceId: "early-proof",
										kind: "tool",
										source: "verify_flag",
										toolName: "verify_flag",
										summary: "verified",
										contentHash: "proof",
										excerpt: JSON.stringify({
											details: { data: { ok: true, status: "correct", verified: true } },
										}),
										metadata: {
											isError: false,
											toolCallId: "proof-call",
											evidenceId: "early-proof",
											verificationOutcome: "correct",
										},
									});
									proofReady.resolve();
									await new Promise<void>((resolve) =>
										signal?.addEventListener("abort", () => resolve(), { once: true }),
									);
									throw signal?.reason;
								}
								await proofReady.promise;
								if (duringDrain)
									await new Promise<void>((resolve) =>
										signal?.addEventListener("abort", () => resolve(), { once: true }),
									);
								throw planningFailure("controller", "planning_persistence_error", "disk failed");
							},
						}),
					),
				).rejects.toMatchObject({ code: "planning_persistence_error" });
				expect(store.snapshot("multi").evidence.some((item) => item.evidenceId === "early-proof")).toBe(true);
			} finally {
				store.close();
			}
		},
	);

	it("keeps parent cancellation authoritative over a Store failure during sibling drain", async () => {
		const store = await seed("multi", ":memory:", false, ["a", "b"]);
		const parent = new AbortController();
		const reason = new Error("user cancelled");
		let starts = 0;
		const operation = runPlanningHarness(
			"multi",
			options(
				store,
				{
					async execute({ lease, signal }) {
						starts++;
						await new Promise<void>((resolve) =>
							signal?.addEventListener("abort", () => resolve(), { once: true }),
						);
						if (lease.objective === "b")
							throw planningFailure("controller", "planning_persistence_error", "late disk failure");
						throw signal?.reason;
					},
				},
				{ signal: parent.signal },
			),
		).then(
			() => undefined,
			(error: unknown) => error,
		);
		try {
			await expect.poll(() => starts).toBe(2);
			parent.abort(reason);
			expect(await operation).toBe(reason);
		} finally {
			parent.abort(reason);
			await operation;
			store.close();
		}
	});

	it("reconsiders an old blocked decision after a sibling delivered new durable progress during planning", async () => {
		const store = await seed("multi", ":memory:", false, ["a", "b"]);
		const a = deferred(),
			b = deferred(),
			planning = deferred();
		let calls = 0;
		const starts: string[] = [];
		const supervisor = {
			propose: vi.fn<PlanningSupervisor["propose"]>(async ({ snapshot }) => {
				calls++;
				if (calls === 1) await planning.promise;
				if (calls === 2) {
					expect(snapshot.tasks.every((task) => task.status === "done")).toBe(true);
					return {
						schemaVersion: 1,
						expectedRevision: snapshot.run.revision,
						decision: "create_tasks",
						rationale: "use new B result",
						tasks: [{ key: "c", objective: "c", doneWhen: "observed" }],
					};
				}
				return {
					schemaVersion: 1,
					expectedRevision: snapshot.run.revision,
					decision: "blocked",
					rationale: "wait",
					tasks: [],
				};
			}),
		};
		const operation = runPlanningHarness(
			"multi",
			options(
				store,
				{
					async execute({ lease }) {
						starts.push(lease.objective);
						if (lease.objective === "a") await a.promise;
						if (lease.objective === "b") await b.promise;
						return report(lease);
					},
				},
				{ supervisor },
			),
		);
		try {
			await expect.poll(() => starts.length).toBe(2);
			a.resolve();
			await expect.poll(() => calls).toBe(1);
			b.resolve();
			await expect.poll(() => store.snapshot("multi").activeLeases?.length).toBe(0);
			planning.resolve();
			await operation;
			expect(starts).toEqual(["a", "b", "c"]);
			expect(calls).toBe(3);
		} finally {
			a.resolve();
			b.resolve();
			planning.resolve();
			await operation.catch(() => {});
			store.close();
		}
	});

	it("does not repeatedly plan while its appended task is waiting on an active prerequisite", async () => {
		const store = await seed("multi", ":memory:", false, ["a", "b"]);
		const a = deferred(),
			b = deferred();
		let calls = 0;
		const starts: string[] = [];
		const supervisor = {
			propose: vi.fn<PlanningSupervisor["propose"]>(async ({ snapshot }) => {
				calls++;
				if (calls === 1)
					return {
						schemaVersion: 1,
						expectedRevision: snapshot.run.revision,
						decision: "create_tasks",
						rationale: "after B",
						tasks: [{ key: "c", objective: "c", doneWhen: "observed", dependsOn: ["multi-b"] }],
					};
				return {
					schemaVersion: 1,
					expectedRevision: snapshot.run.revision,
					decision: "blocked",
					rationale: "wait",
					tasks: [],
				};
			}),
		};
		const operation = runPlanningHarness(
			"multi",
			options(
				store,
				{
					async execute({ lease }) {
						starts.push(lease.objective);
						if (lease.objective === "a") await a.promise;
						if (lease.objective === "b") await b.promise;
						return report(lease);
					},
				},
				{ supervisor },
			),
		);
		try {
			await expect.poll(() => starts.length).toBe(2);
			a.resolve();
			await expect.poll(() => store.snapshot("multi").tasks.length).toBe(3);
			await new Promise<void>((resolve) => setTimeout(resolve, 30));
			expect(calls).toBe(1);
			expect(starts).toEqual(["a", "b"]);
			b.resolve();
			await operation;
			expect(starts).toEqual(["a", "b", "c"]);
		} finally {
			a.resolve();
			b.resolve();
			await operation.catch(() => {});
			store.close();
		}
	});
	it("rechecks a reduced limit after a host slot was granted but before issuing a lease", async () => {
		const store = await seed();
		const control = new PlanningCapacityControl(3),
			a = deferred();
		const starts: string[] = [];
		const operation = runPlanningHarness(
			"multi",
			options(
				store,
				{
					async execute({ lease }) {
						starts.push(lease.objective);
						if (lease.objective === "a") await a.promise;
						return report(lease);
					},
				},
				{ executionCapacity: 3, capacityControl: control },
			),
		);
		control.setCapacity(1);
		try {
			await expect.poll(() => starts).toEqual(["a"]);
			expect(store.getAttemptCount("multi")).toBe(1);
			a.resolve();
			await operation;
			expect(starts).toEqual(["a", "b", "c"]);
		} finally {
			a.resolve();
			await operation.catch(() => {});
			store.close();
		}
	});

	it("plans an empty run without waiting for other runs to release executor slots", async () => {
		const store = await seed("multi", ":memory:", false, []);
		const pool = new PlanningExecutorPool(1);
		const release = await pool.acquire();
		const config = options(store, { execute: vi.fn() }, { executorPool: pool });
		const operation = runPlanningHarness("multi", config);
		try {
			await Promise.resolve();
			expect(config.supervisor.propose).toHaveBeenCalledOnce();
			release();
			expect((await operation).run.status).toBe("blocked");
			expect(config.supervisor.propose).toHaveBeenCalledOnce();
		} finally {
			release();
			await operation.catch(() => {});
			store.close();
		}
	});

	it("cancels a pending Planner and running sibling without appending late tasks", async () => {
		const store = await PlanningStore.open(":memory:");
		const a = deferred();
		const controller = new AbortController();
		let starts = 0;
		let runId = "";
		const supervisor = {
			propose: vi.fn<PlanningSupervisor["propose"]>(async ({ snapshot, signal }) => {
				runId = snapshot.run.runId;
				if (snapshot.tasks.length === 0)
					return {
						schemaVersion: 1,
						expectedRevision: snapshot.run.revision,
						decision: "create_tasks",
						rationale: "initial work",
						tasks: ["a", "b"].map((key) => ({ key, objective: key, doneWhen: "observed" })),
					};
				await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
				throw signal?.reason;
			}),
		};
		const executor: PlanningExecutor = {
			async execute({ lease, signal }) {
				starts++;
				if (lease.objective === "a") {
					await a.promise;
					return report(lease);
				}
				await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
				throw signal?.reason;
			},
		};
		const operation = new ProgressivePlanningController({
			...options(store, executor, { supervisor }),
			executionMode: { mode: "plan_multi", capacity: 2, legacyPlanningMode: "active", planningEnabled: true },
		})
			.execute({
				outerTaskId: "rolling-cancel",
				goal: "cancel while planning",
				signal: controller.signal,
				executeDirect: async () => {
					throw new Error("unexpected DIRECT");
				},
			})
			.catch((error) => error);
		try {
			await expect.poll(() => starts).toBe(2);
			a.resolve();
			await expect.poll(() => supervisor.propose.mock.calls.length).toBe(2);
			const reason = new Error("operator cancelled");
			controller.abort(reason);
			expect(await operation).toBe(reason);
			expect(store.snapshot(runId).activeLeases).toHaveLength(0);
			expect(store.snapshot(runId).run.status).toBe("cancelled");
			expect(store.snapshot(runId).tasks).toHaveLength(2);
		} finally {
			controller.abort();
			a.resolve();
			await operation;
			store.close();
		}
	});
	it("plans and starts a new task while the slow sibling retains its original lease revision", async () => {
		const store = await seed("multi", ":memory:", false, ["a", "b"]);
		const a = deferred(),
			b = deferred(),
			c = deferred();
		const started: PlanningTaskLease[] = [];
		let calls = 0;
		const config = options(
			store,
			{
				async execute({ lease }) {
					started.push(lease);
					await { a, b, c }[lease.objective as "a" | "b" | "c"].promise;
					return report(lease);
				},
			},
			{
				supervisor: {
					propose: vi.fn<PlanningSupervisor["propose"]>(async ({ snapshot, scheduling }) => {
						calls++;
						if (calls === 1) {
							expect(snapshot.tasks.find((task) => task.objective === "a")?.status).toBe("done");
							expect(snapshot.activeLeases).toHaveLength(1);
							expect(scheduling).toEqual({ capacity: 2, occupied: 1, available: 1 });
							return {
								schemaVersion: 1,
								expectedRevision: snapshot.run.revision,
								decision: "create_tasks" as const,
								rationale: "use A",
								tasks: [
									{
										key: "new-c",
										objective: "c",
										doneWhen: "observed c",
										inputEvidenceRefs: [snapshot.evidence[0].evidenceId],
									},
								],
							};
						}
						return {
							schemaVersion: 1,
							expectedRevision: snapshot.run.revision,
							decision: "blocked" as const,
							rationale: "wait",
							tasks: [],
						};
					}),
				},
			},
		);
		const operation = runPlanningHarness("multi", config);
		try {
			await expect.poll(() => started.length).toBe(2);
			a.resolve();
			await expect.poll(() => started.length).toBe(3);
			expect(started.find((lease) => lease.objective === "b")?.planRevision).toBe(1);
			expect(started.find((lease) => lease.objective === "c")?.planRevision).toBe(2);
			expect(store.snapshot("multi").tasks.find((task) => task.objective === "b")?.status).toBe("running");
			b.resolve();
			c.resolve();
			const snapshot = await operation;
			expect(snapshot.tasks.every((task) => task.status === "done")).toBe(true);
		} finally {
			a.resolve();
			b.resolve();
			c.resolve();
			await operation.catch(() => {});
			store.close();
		}
	});

	it("processes sibling completion while a single Planner call is pending", async () => {
		const store = await seed("multi", ":memory:", false, ["a", "b"]);
		const a = deferred(),
			b = deferred(),
			planning = deferred();
		let calls = 0,
			activePlanners = 0,
			maximumPlanners = 0;
		const started: string[] = [];
		const config = options(
			store,
			{
				async execute({ lease }) {
					started.push(lease.objective);
					if (lease.objective === "a") await a.promise;
					if (lease.objective === "b") await b.promise;
					return report(lease);
				},
			},
			{
				supervisor: {
					propose: vi.fn<PlanningSupervisor["propose"]>(async ({ snapshot }) => {
						calls++;
						activePlanners++;
						maximumPlanners = Math.max(maximumPlanners, activePlanners);
						try {
							if (calls === 1) {
								await planning.promise;
								return {
									schemaVersion: 1,
									expectedRevision: snapshot.run.revision,
									decision: "create_tasks" as const,
									rationale: "next",
									tasks: [{ key: "c", objective: "c", doneWhen: "observed" }],
								};
							}
							return {
								schemaVersion: 1,
								expectedRevision: snapshot.run.revision,
								decision: "blocked" as const,
								rationale: "end",
								tasks: [],
							};
						} finally {
							activePlanners--;
						}
					}),
				},
			},
		);
		const operation = runPlanningHarness("multi", config);
		try {
			await expect.poll(() => started.length).toBe(2);
			a.resolve();
			await expect.poll(() => calls).toBe(1);
			b.resolve();
			await expect.poll(() => store.snapshot("multi").activeLeases?.length).toBe(0);
			expect(store.snapshot("multi").tasks.every((task) => task.status === "done")).toBe(true);
			expect(calls).toBe(1);
			planning.resolve();
			await operation;
			expect(started).toEqual(["a", "b", "c"]);
			expect(maximumPlanners).toBe(1);
		} finally {
			a.resolve();
			b.resolve();
			planning.resolve();
			await operation.catch(() => {});
			store.close();
		}
	});

	it("treats blocked as waiting while a sibling works, without busy-looping the Planner", async () => {
		const store = await seed("multi", ":memory:", false, ["a", "b"]);
		const a = deferred(),
			b = deferred();
		let starts = 0;
		const config = options(store, {
			async execute({ lease }) {
				starts++;
				await (lease.objective === "a" ? a : b).promise;
				return report(lease);
			},
		});
		const operation = runPlanningHarness("multi", config);
		try {
			await expect.poll(() => starts).toBe(2);
			a.resolve();
			await expect.poll(() => vi.mocked(config.supervisor.propose).mock.calls.length).toBe(1);
			await new Promise<void>((resolve) => setTimeout(resolve, 30));
			expect(config.supervisor.propose).toHaveBeenCalledTimes(1);
			expect(store.snapshot("multi").run.status).toBe("running");
			b.resolve();
			expect((await operation).run.status).toBe("blocked");
			expect(config.supervisor.propose).toHaveBeenCalledTimes(2);
		} finally {
			a.resolve();
			b.resolve();
			await operation.catch(() => {});
			store.close();
		}
	});

	it("wakes a PLAN_MULTI run at capacity one when its local limit grows", async () => {
		const store = await seed();
		const control = new PlanningCapacityControl(1);
		const a = deferred(),
			b = deferred();
		const starts: string[] = [];
		const operation = runPlanningHarness(
			"multi",
			options(
				store,
				{
					async execute({ lease }) {
						starts.push(lease.objective);
						if (lease.objective === "a") await a.promise;
						if (lease.objective === "b") await b.promise;
						return report(lease);
					},
				},
				{ executionCapacity: 1, parallelPlanning: true, capacityControl: control },
			),
		);
		try {
			await expect.poll(() => starts).toEqual(["a"]);
			control.setCapacity(2);
			await expect.poll(() => starts).toEqual(["a", "b"]);
			a.resolve();
			b.resolve();
			await operation;
		} finally {
			a.resolve();
			b.resolve();
			await operation.catch(() => {});
			store.close();
		}
	});

	it("shrinks by natural completion without cancelling workers or starting surplus ready work", async () => {
		const store = await seed("multi", ":memory:", false, ["a", "b", "c", "d"]);
		const control = new PlanningCapacityControl(3);
		const a = deferred(),
			b = deferred(),
			c = deferred();
		const starts: string[] = [],
			signals: AbortSignal[] = [];
		const operation = runPlanningHarness(
			"multi",
			options(
				store,
				{
					async execute({ lease, signal }) {
						starts.push(lease.objective);
						if (signal) signals.push(signal);
						if (lease.objective !== "d") await { a, b, c }[lease.objective as "a" | "b" | "c"].promise;
						return report(lease);
					},
				},
				{ executionCapacity: 3, capacityControl: control },
			),
		);
		try {
			await expect.poll(() => starts.length).toBe(3);
			control.setCapacity(1);
			a.resolve();
			await expect.poll(() => store.snapshot("multi").activeLeases?.length).toBe(2);
			expect(starts).toEqual(["a", "b", "c"]);
			b.resolve();
			await expect.poll(() => store.snapshot("multi").activeLeases?.length).toBe(1);
			expect(starts).toEqual(["a", "b", "c"]);
			expect(signals.every((signal) => !signal.aborted)).toBe(true);
			c.resolve();
			await operation;
			expect(starts).toEqual(["a", "b", "c", "d"]);
		} finally {
			a.resolve();
			b.resolve();
			c.resolve();
			await operation.catch(() => {});
			store.close();
		}
	});

	it("cancels only surplus queued slot requests when local capacity shrinks", async () => {
		const store = await seed();
		const pool = new PlanningExecutorPool(1),
			control = new PlanningCapacityControl(3);
		const release = await pool.acquire();
		const a = deferred();
		const starts: string[] = [];
		const operation = runPlanningHarness(
			"multi",
			options(
				store,
				{
					async execute({ lease }) {
						starts.push(lease.objective);
						if (lease.objective === "a") await a.promise;
						return report(lease);
					},
				},
				{ executorPool: pool, executionCapacity: 3, capacityControl: control },
			),
		);
		try {
			await expect.poll(() => pool.getStatus().waiting).toBe(3);
			control.setCapacity(1);
			await expect.poll(() => pool.getStatus().waiting).toBe(1);
			expect(store.getAttemptCount("multi")).toBe(0);
			release();
			await expect.poll(() => starts).toEqual(["a"]);
			a.resolve();
			await operation;
			expect(starts).toEqual(["a", "b", "c"]);
		} finally {
			release();
			a.resolve();
			await operation.catch(() => {});
			store.close();
		}
	});

	it("growing the shared pool wakes queued work and shrinking it never preempts active tools", async () => {
		const pool = new PlanningExecutorPool(1);
		const releaseA = await pool.acquire();
		let startedB = false;
		const b = pool.acquire().then((release) => {
			startedB = true;
			return release;
		});
		pool.setCapacity(2);
		const releaseB = await b;
		expect(startedB).toBe(true);
		pool.setCapacity(1);
		expect(pool.getStatus()).toEqual({ capacity: 1, active: 2, waiting: 0 });
		let startedC = false;
		const c = pool.acquire().then((release) => {
			startedC = true;
			return release;
		});
		releaseA();
		await Promise.resolve();
		expect(startedC).toBe(false);
		releaseB();
		const releaseC = await c;
		releaseC();
		expect(pool.getStatus()).toEqual({ capacity: 1, active: 0, waiting: 0 });
	});
	it("settles a same-run trusted proof before a sibling quota failure while its producer is still running", async () => {
		const store = await seed();
		const proofReady = deferred();
		try {
			const snapshot = await runPlanningHarness(
				"multi",
				options(store, {
					async execute({ lease, recordEvidence, signal }) {
						if (lease.objective === "a") {
							recordEvidence?.({
								evidenceId: "early-proof",
								kind: "tool",
								source: "verify_flag",
								toolName: "verify_flag",
								summary: "verified",
								contentHash: "proof",
								excerpt: JSON.stringify({ details: { data: { ok: true, status: "correct", verified: true } } }),
								metadata: {
									isError: false,
									toolCallId: "proof-call",
									evidenceId: "early-proof",
									verificationOutcome: "correct",
								},
							});
							proofReady.resolve();
							await new Promise<void>((resolve) =>
								signal?.addEventListener("abort", () => resolve(), { once: true }),
							);
							throw signal?.reason;
						}
						await proofReady.promise;
						throw planningFailure("executor", "verifier_quota_exhausted", "quota exhausted");
					},
				}),
			);
			expect(snapshot.run.status).toBe("completed");
			expect(snapshot.activeLeases).toHaveLength(0);
			expect(store.getAttemptCount("multi")).toBe(2);
		} finally {
			store.close();
		}
	});

	it("retains a host slot for a timed-out tool after the outer attempt budget is exhausted", async () => {
		const store = await seed();
		const settlement = deferred();
		const pool = new PlanningExecutorPool(1);
		const supervisor = { propose: vi.fn<PlanningSupervisor["propose"]>() };
		try {
			const snapshot = await runPlanningHarness(
				"multi",
				options(
					store,
					{
						async execute({ onPendingSettlement }) {
							onPendingSettlement?.(settlement.promise);
							throw planningFailure("executor", "executor_timeout", "hard timeout");
						},
					},
					{ executorPool: pool, supervisor, maximumSteps: 1 },
				),
			);
			expect(snapshot.run.status).toBe("paused");
			let acquired = false;
			const next = pool.acquire().then((release) => {
				acquired = true;
				release();
			});
			await Promise.resolve();
			expect(acquired).toBe(false);
			expect(supervisor.propose).not.toHaveBeenCalled();
			settlement.resolve();
			await next;
			expect(acquired).toBe(true);
		} finally {
			settlement.resolve();
			store.close();
		}
	});

	it("completes evidence-only analysis from explicit same-run sibling tool references", async () => {
		const store = await seed();
		try {
			const a = store.leaseTask("multi", "multi-a", "/work", 30_000);
			store.startLease(a.leaseId);
			const source = report(a);
			store.commitResult({
				leaseId: a.leaseId,
				planRevision: a.planRevision,
				...source,
				preserveTaskProvenance: true,
			});
			const b = store.leaseTask("multi", "multi-b", "/work", 30_000);
			store.startLease(b.leaseId);
			const analysis = report(b, "analysis of sibling output");
			analysis.evidence = [];
			analysis.result.evidenceRefs = source.result.evidenceRefs;
			analysis.result.facts = [];
			analysis.result.rejectedDirections = [];
			// PLAN_SINGLE still requires a tool observation from its own attempt.
			expect(() => store.commitResult({ leaseId: b.leaseId, planRevision: b.planRevision, ...analysis })).toThrow(
				"without successful tool evidence",
			);
			const snapshot = store.commitResult({
				leaseId: b.leaseId,
				planRevision: b.planRevision,
				...analysis,
				preserveTaskProvenance: true,
			});
			expect(snapshot.tasks.find((task) => task.taskId === b.taskId)?.status).toBe("done");
			expect(snapshot.run.status).not.toBe("completed");
			expect(snapshot.evidence.filter((item) => item.leaseId === b.leaseId)).toHaveLength(0);
		} finally {
			store.close();
		}
	});

	it.each(["unknown", "wrong-run", "observation", "tool-error"])(
		"rejects %s as an analysis completion basis",
		async (kind) => {
			const store = await seed();
			try {
				const a = store.leaseTask("multi", "multi-a", "/work", 30_000);
				store.startLease(a.leaseId);
				if (kind === "wrong-run")
					store.createRun({ runId: "foreign", outerTaskId: "foreign", goal: "other", mode: "active" });
				const item = report(a).evidence[0];
				item.evidenceId = "basis";
				if (kind === "observation") item.kind = "observation";
				if (kind === "tool-error") item.metadata = { isError: true };
				if (kind !== "unknown" && kind !== "wrong-run") store.recordAttemptEvidence(a.leaseId, [item]);
				// A cross-run ID is not eligible, even when it is present elsewhere.
				if (kind === "wrong-run") {
					store.commitPlan({
						runId: "foreign",
						expectedRevision: 0,
						rationale: "other",
						idempotencyKey: "foreign",
						tasks: [
							{
								taskId: "foreign-a",
								objective: "other",
								doneWhen: "observed",
								priority: 1,
								sequence: 0,
								dependsOnTaskIds: [],
							},
						],
					});
					const foreign = store.leaseTask("foreign", "foreign-a", "/work", 30_000);
					store.startLease(foreign.leaseId);
					store.recordAttemptEvidence(foreign.leaseId, [item]);
				}
				const b = store.leaseTask("multi", "multi-b", "/work", 30_000, Date.now(), 2);
				store.startLease(b.leaseId);
				const analysis = report(b);
				analysis.evidence = [];
				analysis.result.evidenceRefs = ["basis"];
				expect(() =>
					store.commitResult({
						leaseId: b.leaseId,
						planRevision: b.planRevision,
						...analysis,
						preserveTaskProvenance: true,
					}),
				).toThrow();
				expect(store.snapshot("multi").tasks.find((task) => task.taskId === b.taskId)?.status).not.toBe("done");
			} finally {
				store.close();
			}
		},
	);
	it("persists trusted success, stops siblings, drains callbacks, and returns a lease-free terminal snapshot", async () => {
		const store = await seed();
		const siblingStarted = deferred();
		let stopped = false;
		try {
			const snapshot = await runPlanningHarness(
				"multi",
				options(store, {
					async execute({ lease, recordEvidence, signal }) {
						if (lease.objective === "a") {
							await siblingStarted.promise;
							const result = report(lease);
							result.evidence.push({
								evidenceId: "trusted-verifier",
								kind: "tool",
								source: "verify_flag",
								toolName: "verify_flag",
								summary: "success: verify_flag",
								contentHash: "verified-hash",
								excerpt: JSON.stringify({ details: { data: { ok: true, status: "correct", verified: true } } }),
								metadata: {
									isError: false,
									toolCallId: "verified-call",
									evidenceId: "trusted-verifier",
									verificationOutcome: "correct",
								},
							});
							return result;
						}
						recordEvidence?.({
							evidenceId: "sibling-progress",
							kind: "tool",
							source: "tool",
							summary: "sibling progress",
							contentHash: "sibling",
						});
						siblingStarted.resolve();
						await new Promise<void>((resolve) =>
							signal?.addEventListener(
								"abort",
								() => {
									stopped = true;
									resolve();
								},
								{ once: true },
							),
						);
						throw signal?.reason;
					},
				}),
			);
			expect(snapshot.run.status).toBe("completed");
			expect(stopped).toBe(true);
			expect(snapshot.activeLeases).toHaveLength(0);
			expect(snapshot.evidence.some((item) => item.evidenceId === "sibling-progress")).toBe(true);
			expect(store.getAttemptCount("multi")).toBe(2);
		} finally {
			store.close();
		}
	});

	it("starts two attempts and refills a dependency slot before the slow sibling finishes", async () => {
		const store = await seed("multi", ":memory:", true);
		const a = deferred(),
			b = deferred(),
			c = deferred();
		const started: string[] = [];
		const config = options(store, {
			async execute({ lease, context }) {
				started.push(lease.objective);
				if (lease.objective === "a") await a.promise;
				if (lease.objective === "b") await b.promise;
				if (lease.objective === "c") {
					expect(context).toContain("a");
					await c.promise;
				}
				return report(lease);
			},
		});
		const operation = runPlanningHarness("multi", config);
		try {
			await expect.poll(() => started).toEqual(["a", "b"]);
			expect(store.snapshot("multi").activeLeases).toHaveLength(2);
			expect(store.snapshot("multi").activeLease).toBeUndefined();
			expect(config.supervisor.propose).not.toHaveBeenCalled();
			a.resolve();
			await expect.poll(() => started).toEqual(["a", "b", "c"]);
			expect(store.snapshot("multi").tasks.find((task) => task.objective === "b")?.status).toBe("running");
			expect(config.supervisor.propose).not.toHaveBeenCalled();
			b.resolve();
			c.resolve();
			const snapshot = await operation;
			expect(snapshot.activeLeases).toHaveLength(0);
			expect(snapshot.executionFrame.frame.taskSummaries).toHaveLength(3);
			expect(config.supervisor.propose).toHaveBeenCalledTimes(1);
		} finally {
			a.resolve();
			b.resolve();
			c.resolve();
			await operation;
			store.close();
		}
	});

	it("retains conflicting facts with task provenance instead of last-writer overwrite", async () => {
		const store = await seed();
		try {
			const snapshot = await runPlanningHarness(
				"multi",
				options(store, {
					async execute({ lease }) {
						return report(lease);
					},
				}),
			);
			expect(snapshot.executionFrame.frame.facts.map((fact) => fact.value).sort()).toEqual(["a", "b", "c"]);
			expect(new Set(snapshot.executionFrame.frame.facts.map((fact) => fact.sourceTaskId)).size).toBe(3);
			expect(snapshot.executionFrame.revision).toBe(3);
			expect(snapshot.executionFrame.frame.rejectedDirections).toHaveLength(3);
			expect(snapshot.executionFrame.frame.openQuestions).toHaveLength(3);
			expect(new Set(snapshot.executionFrame.frame.openQuestions.map((question) => question.questionId)).size).toBe(
				3,
			);
		} finally {
			store.close();
		}
	});

	it("isolates repeated question labels but allows resolving an explicit sibling Frame ID", async () => {
		const store = await seed();
		try {
			const snapshot = await runPlanningHarness(
				"multi",
				options(store, {
					async execute({ lease }) {
						return report(lease);
					},
				}),
			);
			const task = snapshot.tasks.find((item) => item.taskId === "multi-a");
			expect(task).toBeDefined();
			if (!task) throw new Error("missing fixture task");
			const result: PlanningTaskResult = {
				schemaVersion: PLANNING_SCHEMA_VERSION,
				leaseId: "fixture",
				outcome: "done" as const,
				summary: "close local question",
				suggestedTasks: [],
				flagCandidates: [],
				evidenceRefs: [],
				resolvedQuestionIds: ["Q1"],
			};
			const frame = reduceExecutionFrame({
				frame: snapshot.executionFrame.frame,
				task,
				result,
				evidence: snapshot.evidence,
				allowedScope: "/work",
				preserveTaskProvenance: true,
			});
			expect(frame.openQuestions.map((item) => item.sourceTaskId).sort()).toEqual(["multi-b", "multi-c"]);
			const siblingId = frame.openQuestions.find((item) => item.sourceTaskId === "multi-b")?.questionId;
			if (!siblingId) throw new Error("missing sibling question");
			const resolved = reduceExecutionFrame({
				frame,
				task,
				result: { ...result, resolvedQuestionIds: [siblingId] },
				evidence: snapshot.evidence,
				allowedScope: "/work",
				preserveTaskProvenance: true,
			});
			expect(resolved.openQuestions.map((item) => item.sourceTaskId)).toEqual(["multi-c"]);
		} finally {
			store.close();
		}
	});

	it("seals an ordinary failed attempt, preserves its evidence, and does not cancel siblings", async () => {
		const store = await seed();
		const started: string[] = [];
		try {
			const snapshot = await runPlanningHarness(
				"multi",
				options(store, {
					async execute({ lease, recordEvidence }) {
						started.push(lease.objective);
						if (lease.objective === "a") {
							recordEvidence?.({
								kind: "tool",
								source: "saved-before-failure",
								summary: "useful observation",
								contentHash: "saved",
							});
							throw planningFailure("executor", "executor_timeout", "attempt timeout");
						}
						return report(lease);
					},
				}),
			);
			expect(started.sort()).toEqual(["a", "b", "c"]);
			expect(snapshot.tasks.find((task) => task.objective === "a")?.status).toBe("failed");
			expect(snapshot.tasks.filter((task) => task.status === "done")).toHaveLength(2);
			expect(snapshot.evidence.some((item) => item.source === "saved-before-failure")).toBe(true);
		} finally {
			store.close();
		}
	});

	it("counts attempts rather than waves and never exceeds maxSteps", async () => {
		const store = await seed();
		const started: string[] = [];
		try {
			const snapshot = await runPlanningHarness(
				"multi",
				options(
					store,
					{
						async execute({ lease }) {
							started.push(lease.objective);
							return report(lease);
						},
					},
					{ maximumSteps: 2 },
				),
			);
			expect(started).toHaveLength(2);
			expect(store.getAttemptCount("multi")).toBe(2);
			expect(snapshot.run.status).toBe("paused");
			expect(snapshot.activeLeases).toHaveLength(0);
		} finally {
			store.close();
		}
	});

	it("shares a host limit across runs and waits before issuing a lease", async () => {
		const one = await seed("one"),
			two = await seed("two");
		const pool = new PlanningExecutorPool(1),
			hold = deferred();
		let active = 0,
			maximumActive = 0;
		const executor: PlanningExecutor = {
			async execute({ lease }) {
				active++;
				maximumActive = Math.max(maximumActive, active);
				await hold.promise;
				active--;
				return report(lease);
			},
		};
		const first = runPlanningHarness("one", options(one, executor, { executorPool: pool }));
		const second = runPlanningHarness("two", options(two, executor, { executorPool: pool }));
		try {
			await expect.poll(() => one.getAttemptCount("one") + two.getAttemptCount("two")).toBe(1);
			expect(two.getAttemptCount("two")).toBe(0);
			hold.resolve();
			await Promise.all([first, second]);
			expect(maximumActive).toBe(1);
		} finally {
			hold.resolve();
			await Promise.all([first, second]);
			one.close();
			two.close();
		}
	});

	it("cancels a queued host-slot wait without creating or consuming attempts", async () => {
		const store = await seed(),
			pool = new PlanningExecutorPool(1);
		const release = await pool.acquire(),
			parent = new AbortController();
		const executor = {
			execute: vi.fn(async ({ lease }: Parameters<PlanningExecutor["execute"]>[0]) => report(lease)),
		};
		const operation = runPlanningHarness(
			"multi",
			options(store, executor, { executorPool: pool, signal: parent.signal }),
		);
		try {
			parent.abort(new Error("user cancelled"));
			await expect(operation).rejects.toThrow("user cancelled");
			expect(store.getAttemptCount("multi")).toBe(0);
			expect(executor.execute).not.toHaveBeenCalled();
		} finally {
			release();
			store.close();
		}
	});

	it("drains children before propagating a terminal persistence failure", async () => {
		const store = await seed();
		const siblingStarted = deferred();
		let siblingStopped = false;
		try {
			await expect(
				runPlanningHarness(
					"multi",
					options(store, {
						async execute({ lease, signal }) {
							if (lease.objective === "a") {
								await siblingStarted.promise;
								throw planningFailure("controller", "planning_persistence_error", "disk failed");
							}
							siblingStarted.resolve();
							await new Promise<void>((resolve) =>
								signal?.addEventListener(
									"abort",
									() => {
										siblingStopped = true;
										resolve();
									},
									{ once: true },
								),
							);
							throw signal?.reason;
						},
					}),
				),
			).rejects.toMatchObject({ code: "planning_persistence_error" });
			expect(siblingStopped).toBe(true);
			expect(store.snapshot("multi").evidence).toBeDefined();
		} finally {
			store.close();
		}
	});

	it("allows multiple planned tasks without capping proposal size to capacity", async () => {
		const store = await PlanningStore.open(":memory:");
		store.createRun({ runId: "fresh", outerTaskId: "fresh", goal: "investigate", mode: "active" });
		const config = options(store, {
			async execute({ lease }) {
				return report(lease);
			},
		});
		config.supervisor.propose = vi.fn<PlanningSupervisor["propose"]>(async ({ snapshot }) => ({
			schemaVersion: PLANNING_SCHEMA_VERSION,
			expectedRevision: snapshot.run.revision,
			decision: snapshot.tasks.length ? "blocked" : "create_tasks",
			rationale: "independent tasks",
			tasks: snapshot.tasks.length
				? []
				: ["a", "b", "c"].map((key) => ({ key, objective: key, doneWhen: key, dependsOn: [] })),
		}));
		try {
			const snapshot = await runPlanningHarness("fresh", config);
			expect(snapshot.tasks.filter((task) => task.status === "done")).toHaveLength(3);
		} finally {
			store.close();
		}
	});

	it("migrates an old database, rejects duplicate task leases, and recovers all active leases", async () => {
		const root = mkdtempSync(join(tmpdir(), "planning-multi-migration-")),
			path = join(root, "planning.sqlite");
		let store = await seed("multi", path);
		store.close();
		const old = await createNodeSqliteFactory().open(path);
		old.exec(
			"DROP INDEX planning_active_task_lease_idx; CREATE UNIQUE INDEX planning_active_run_lease_idx ON planning_leases(run_id) WHERE status = 'active';",
		);
		old.close();
		store = await PlanningStore.open(path);
		try {
			const a = store.leaseTask("multi", "multi-a", root, 30_000, Date.now(), 2);
			const b = store.leaseTask("multi", "multi-b", root, 30_000, Date.now(), 2);
			expect(() => store.leaseTask("multi", "multi-a", root, 30_000, Date.now(), 2)).toThrow(/active lease/);
			expect(() =>
				store.commitPlan({
					runId: "multi",
					expectedRevision: 1,
					rationale: "illegal edit",
					idempotencyKey: "new",
					tasks: [],
				}),
			).toThrow(/lease is active/);
			store.startLease(a.leaseId);
			store.startLease(b.leaseId);
			expect(store.recoverActiveLease("multi", "restart")).toBe(true);
			expect(store.snapshot("multi").activeLeases).toHaveLength(0);
			expect(store.snapshot("multi").tasks.filter((task) => task.status === "ready")).toHaveLength(3);
			store.close();
			store = await PlanningStore.open(path);
			expect(store.snapshot("multi").activeLeases).toHaveLength(0);
		} finally {
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("cancels every active lease and keeps persisted progress readable", async () => {
		const store = await seed();
		try {
			for (const key of ["a", "b"]) {
				const lease = store.leaseTask("multi", `multi-${key}`, "/work", 30_000, Date.now(), 2);
				store.startLease(lease.leaseId);
				store.recordEvidence(lease.leaseId, [{ kind: "tool", source: "tool", summary: key, contentHash: key }]);
			}
			store.cancelActiveLease("multi", "cancel all children");
			expect(store.snapshot("multi").activeLeases).toHaveLength(0);
			expect(store.snapshot("multi").evidence).toHaveLength(2);
		} finally {
			store.close();
		}
	});
});
