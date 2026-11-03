import { describe, expect, it } from "vitest";
import { resolveExecutionMode } from "../src/execution-mode.ts";
import {
	PLANNING_SCHEMA_VERSION,
	type PlanningExecutionReport,
	type PlanningFlagCandidate,
	type PlanningPlanProposal,
} from "../src/planning/contracts.ts";
import { ProgressivePlanningController } from "../src/planning/controller.ts";
import { planningFailure } from "../src/planning/failures.ts";
import { type PlanningExecutor, type PlanningSupervisor, runPlanningHarness } from "../src/planning/harness.ts";
import { PlanningStore } from "../src/planning/store.ts";

const RUN_ID = "terminal-evidence-run";

async function seededStore(): Promise<PlanningStore> {
	const store = await PlanningStore.open(":memory:");
	store.createRun({ runId: RUN_ID, outerTaskId: "outer", goal: "solve", mode: "active" }, 1);
	store.commitPlan(
		{
			runId: RUN_ID,
			expectedRevision: 0,
			rationale: "seed",
			idempotencyKey: "seed-plan",
			tasks: [
				{
					taskId: "task-1",
					objective: "solve",
					doneWhen: "result persisted",
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

function harnessOptions(
	store: PlanningStore,
	supervisor: PlanningSupervisor,
	executor: PlanningExecutor,
	signal?: AbortSignal,
) {
	return {
		store,
		supervisor,
		executor,
		maximumSteps: 4,
		maximumTasks: 8,
		leaseTtlMs: 30_000,
		maximumEvidenceBytes: 16_384,
		allowedScope: "/work",
		signal,
	};
}

function blockedSupervisor(calls: { value: number }): PlanningSupervisor {
	return {
		async propose({ snapshot }): Promise<PlanningPlanProposal> {
			calls.value += 1;
			return {
				schemaVersion: PLANNING_SCHEMA_VERSION,
				expectedRevision: snapshot.run.revision,
				decision: "blocked",
				rationale: "no further action in smoke",
				tasks: [],
			};
		},
	};
}

function executorWithEvidence(
	evidence: PlanningExecutionReport["evidence"],
	flagCandidates: PlanningFlagCandidate[] = [],
): PlanningExecutor {
	return {
		async execute({ lease }) {
			return {
				result: {
					schemaVersion: PLANNING_SCHEMA_VERSION,
					leaseId: lease.leaseId,
					outcome: "done",
					summary: "task completed",
					suggestedTasks: [],
					flagCandidates,
				},
				evidence,
				commitSource: "planning_commit_result",
			};
		},
	};
}

function verifierEvidence(result: Record<string, unknown>, toolName = "verify_flag") {
	const evidenceId = `tool-${toolName}-terminal-evidence`;
	const verificationOutcome =
		result.verificationOutcome ??
		(result.status === "correct" ? "correct" : result.status === "incorrect" ? "incorrect" : undefined);
	return {
		evidenceId,
		kind: "tool" as const,
		source: toolName,
		toolName,
		summary: `success: ${toolName}`,
		excerpt: JSON.stringify({ details: { data: result } }),
		contentHash: `${toolName}-hash-${JSON.stringify(result)}`,
		metadata: {
			isError: false,
			toolCallId: `call-${toolName}-terminal-evidence`,
			evidenceId,
			...(verificationOutcome ? { verificationOutcome } : {}),
		},
	};
}

describe("Planning terminal evidence handoff", () => {
	it("stops before Supervisor replan when persisted verifier evidence is correct", async () => {
		const store = await seededStore();
		const supervisorCalls = { value: 0 };
		try {
			const snapshot = await runPlanningHarness(
				RUN_ID,
				harnessOptions(
					store,
					blockedSupervisor(supervisorCalls),
					executorWithEvidence([verifierEvidence({ ok: true, verified: true, status: "correct" })]),
				),
			);
			expect(snapshot.run.status).toBe("completed");
			expect(supervisorCalls.value).toBe(0);
			expect(snapshot.evidence.some((item) => item.toolName === "verify_flag")).toBe(true);
			expect(
				store
					.listLifecycleEvents(RUN_ID)
					.events.filter((event) => event.type === "planning_terminal_evidence_observed"),
			).toHaveLength(1);
		} finally {
			store.close();
		}
	});

	it("settles persisted trusted evidence after timeout without pretending the task committed", async () => {
		const store = await seededStore();
		const supervisorCalls = { value: 0 };
		let executorCalls = 0;
		const verification = verifierEvidence({
			ok: true,
			verified: true,
			status: "correct",
			verificationOutcome: "correct",
			challenge_id: "mock-challenge",
		});
		try {
			const snapshot = await runPlanningHarness(
				RUN_ID,
				harnessOptions(store, blockedSupervisor(supervisorCalls), {
					async execute({ recordEvidence }) {
						executorCalls += 1;
						recordEvidence?.(verification);
						throw planningFailure("executor", "executor_timeout", "mock child deadline after verifier result");
					},
				}),
			);
			const events = store.listLifecycleEvents(RUN_ID).events;
			const sealed = events.find((event) => event.type === "attempt_sealed");
			const terminal = events.find((event) => event.type === "planning_terminal_evidence_observed");
			expect(snapshot.run.status).toBe("completed");
			expect(snapshot.tasks[0]?.status).toBe("failed");
			expect(snapshot.latestFailure).toMatchObject({ code: "executor_timeout" });
			expect(snapshot.evidence).toHaveLength(1);
			expect(snapshot.evidence[0]).toMatchObject({
				runId: RUN_ID,
				taskId: "task-1",
				leaseId: expect.any(String),
				evidenceId: verification.evidenceId,
			});
			expect(terminal?.sequence).toBeGreaterThan(sealed?.sequence ?? Number.POSITIVE_INFINITY);
			expect(terminal?.payload).toMatchObject({
				taskId: "task-1",
				leaseId: snapshot.evidence[0]?.leaseId,
				evidenceId: verification.evidenceId,
				verificationOutcome: "correct",
			});
			expect(events.some((event) => event.type === "task_committed")).toBe(false);
			expect(supervisorCalls.value).toBe(0);
			expect(executorCalls).toBe(1);
		} finally {
			store.close();
		}
	});

	it.each(["executor_timeout", "verifier_quota_exhausted"] as const)(
		"returns a trusted verifier proof from the Controller after %s sealing",
		async (failureCode) => {
			const store = await PlanningStore.open(":memory:");
			let supervisorCalls = 0;
			const verification = verifierEvidence({
				ok: true,
				verified: true,
				status: "correct",
				verificationOutcome: "correct",
				challenge_id: "controller-mock-challenge",
			});
			try {
				const controller = new ProgressivePlanningController({
					executionMode: resolveExecutionMode({ legacyPlanningMode: "active" }),
					store,
					supervisor: {
						async propose({ snapshot }) {
							supervisorCalls += 1;
							return {
								schemaVersion: PLANNING_SCHEMA_VERSION,
								expectedRevision: snapshot.run.revision,
								decision: "create_tasks",
								rationale: "Run the verifier once before accepting completion.",
								tasks: [{ key: "verify", objective: "verify", doneWhen: "result persisted" }],
							};
						},
					},
					executor: {
						async execute({ recordEvidence }) {
							recordEvidence?.(verification);
							throw planningFailure("executor", failureCode, "failure after persisted verifier result");
						},
					},
					maximumSteps: 3,
					maximumTasks: 3,
					leaseTtlMs: 30_000,
					maximumEvidenceBytes: 16_384,
					allowedScope: "/work",
				});
				const result = await controller.execute({
					outerTaskId: "trusted-timeout-controller",
					goal: "settle already persisted verifier evidence",
					executeDirect: async () => {
						throw new Error("Direct execution is disabled in this test");
					},
				});
				expect(result.snapshot?.run.status).toBe("completed");
				expect(result.snapshot?.tasks[0]?.status).toBe("failed");
				expect(result.snapshot?.latestFailure).toMatchObject({ code: failureCode });
				expect(result.trustedVerification).toMatchObject({
					source: "planning_verifier_evidence",
					verificationOutcome: "correct",
					planningRunId: result.runId,
					taskId: result.snapshot?.tasks[0]?.taskId,
					evidenceId: verification.evidenceId,
					challengeId: "controller-mock-challenge",
				});
				expect(supervisorCalls).toBe(1);
				expect(
					store.listLifecycleEvents(result.runId ?? "").events.some((event) => event.type === "task_committed"),
				).toBe(false);
			} finally {
				store.close();
			}
		},
	);

	it("settles a persisted trusted result from the failed lease before a later quota error", async () => {
		const store = await seededStore();
		let supervisorCalls = 0;
		const verification = verifierEvidence({
			ok: true,
			verified: true,
			status: "correct",
			verificationOutcome: "correct",
		});
		try {
			const snapshot = await runPlanningHarness(
				RUN_ID,
				harnessOptions(
					store,
					{
						async propose() {
							supervisorCalls += 1;
							throw new Error("must not replan");
						},
					},
					{
						async execute({ recordEvidence }) {
							recordEvidence?.(verification);
							throw planningFailure(
								"executor",
								"verifier_quota_exhausted",
								"later verifier call exhausted quota",
							);
						},
					},
				),
			);
			const events = store.listLifecycleEvents(RUN_ID).events;
			expect(snapshot.run.status).toBe("completed");
			expect(snapshot.tasks[0]?.status).toBe("failed");
			expect(snapshot.latestFailure).toMatchObject({ code: "verifier_quota_exhausted" });
			expect(events.some((event) => event.type === "planning_terminal_evidence_observed")).toBe(true);
			expect(
				events.some(
					(event) =>
						event.type === "attempt_routing_decided" &&
						event.payload.routingState === "terminal" &&
						event.payload.replanStarted === false,
				),
			).toBe(true);
			expect(events.some((event) => event.type === "task_committed")).toBe(false);
			expect(supervisorCalls).toBe(0);
		} finally {
			store.close();
		}
	});

	it("keeps quota exhaustion terminal when the saved verdict is not trusted", async () => {
		const store = await seededStore();
		let supervisorCalls = 0;
		try {
			await expect(
				runPlanningHarness(
					RUN_ID,
					harnessOptions(
						store,
						{
							async propose() {
								supervisorCalls += 1;
								throw new Error("must not replan");
							},
						},
						{
							async execute({ recordEvidence }) {
								recordEvidence?.(verifierEvidence({ ok: true, verified: false, status: "correct" }));
								throw planningFailure("executor", "verifier_quota_exhausted", "quota exhausted");
							},
						},
					),
				),
			).rejects.toMatchObject({ code: "verifier_quota_exhausted" });
			expect(supervisorCalls).toBe(0);
			expect(store.snapshot(RUN_ID).run.status).not.toBe("completed");
			expect(
				store
					.listLifecycleEvents(RUN_ID)
					.events.some((event) => event.type === "planning_terminal_evidence_observed"),
			).toBe(false);
		} finally {
			store.close();
		}
	});

	it("keeps persistence errors terminal even if accepted-shaped evidence was already saved", async () => {
		const code = "planning_persistence_error";
		const source = "controller";
		const store = await seededStore();
		let supervisorCalls = 0;
		const verification = verifierEvidence({
			ok: true,
			verified: true,
			status: "correct",
			verificationOutcome: "correct",
		});
		try {
			await expect(
				runPlanningHarness(
					RUN_ID,
					harnessOptions(
						store,
						{
							async propose() {
								supervisorCalls += 1;
								throw new Error("must not replan");
							},
						},
						{
							async execute({ recordEvidence }) {
								recordEvidence?.(verification);
								throw planningFailure(source, code, "terminal fault after saved evidence");
							},
						},
					),
				),
			).rejects.toMatchObject({ code });
			expect(supervisorCalls).toBe(0);
			expect(
				store
					.listLifecycleEvents(RUN_ID)
					.events.some((event) => event.type === "planning_terminal_evidence_observed"),
			).toBe(false);
		} finally {
			store.close();
		}
	});

	it("does not terminalize from an evidence callback that arrives after the lease was sealed", async () => {
		const store = await seededStore();
		const lateEvidence = verifierEvidence({
			ok: true,
			verified: true,
			status: "correct",
			verificationOutcome: "correct",
		});
		let writeLateEvidence: ((item: typeof lateEvidence) => void) | undefined;
		try {
			const snapshot = await runPlanningHarness(
				RUN_ID,
				harnessOptions(store, blockedSupervisor({ value: 0 }), {
					async execute({ recordEvidence }) {
						writeLateEvidence = recordEvidence;
						throw planningFailure("executor", "executor_timeout", "deadline won before result callback");
					},
				}),
			);
			expect(snapshot.run.status).toBe("blocked");
			expect(snapshot.evidence).toHaveLength(0);
			expect(() => writeLateEvidence?.(lateEvidence)).toThrow(/Active planning lease not found|active lease/u);
			expect(store.snapshot(RUN_ID).run.status).toBe("blocked");
		} finally {
			store.close();
		}
	});

	it("does not treat a flag candidate alone as terminal evidence", async () => {
		const store = await seededStore();
		const supervisorCalls = { value: 0 };
		try {
			const snapshot = await runPlanningHarness(
				RUN_ID,
				harnessOptions(
					store,
					blockedSupervisor(supervisorCalls),
					executorWithEvidence(
						[
							{
								kind: "tool",
								source: "bash",
								toolName: "bash",
								summary: "success: bash",
								excerpt: "candidate output",
								contentHash: "bash-hash",
								metadata: { isError: false },
							},
						],
						[{ candidate: "flag{candidate-only}", confidence: 1, rationale: "candidate" }],
					),
				),
			);
			expect(snapshot.run.status).toBe("blocked");
			expect(supervisorCalls.value).toBe(1);
		} finally {
			store.close();
		}
	});

	it("does not complete on an incorrect verifier result", async () => {
		const store = await seededStore();
		const supervisorCalls = { value: 0 };
		try {
			const snapshot = await runPlanningHarness(
				RUN_ID,
				harnessOptions(
					store,
					blockedSupervisor(supervisorCalls),
					executorWithEvidence([verifierEvidence({ ok: true, verified: false, status: "incorrect" })]),
				),
			);
			expect(snapshot.run.status).toBe("blocked");
			expect(supervisorCalls.value).toBe(1);
		} finally {
			store.close();
		}
	});

	it("does not retry a planning task after verifier quota exhaustion", async () => {
		const store = await seededStore();
		let executorCalls = 0;
		const executor: PlanningExecutor = {
			async execute() {
				executorCalls += 1;
				throw planningFailure("executor", "verifier_quota_exhausted", "Flag verifier quota exhausted");
			},
		};
		try {
			await expect(
				runPlanningHarness(RUN_ID, harnessOptions(store, blockedSupervisor({ value: 0 }), executor)),
			).rejects.toMatchObject({ code: "verifier_quota_exhausted" });
			expect(executorCalls).toBe(1);
		} finally {
			store.close();
		}
	});

	it("stops on an evidence persistence failure without asking the Supervisor to replan", async () => {
		const store = await seededStore();
		let supervisorCalls = 0;
		let executorCalls = 0;
		const originalRecordEvidence = store.recordEvidence.bind(store);
		store.recordEvidence = (() => {
			throw new Error("mock PlanningStore write failure");
		}) as PlanningStore["recordEvidence"];
		const supervisor: PlanningSupervisor = {
			async propose() {
				supervisorCalls += 1;
				return blockedSupervisor({ value: 0 }).propose({ snapshot: store.snapshot(RUN_ID) });
			},
		};
		const executor: PlanningExecutor = {
			async execute({ recordEvidence }) {
				executorCalls += 1;
				recordEvidence?.({
					kind: "tool",
					source: "mock-tool",
					summary: "cannot persist",
					contentHash: "persistence-failure",
				});
				return {
					result: {
						schemaVersion: PLANNING_SCHEMA_VERSION,
						leaseId: "unused",
						outcome: "failed",
						summary: "unreachable",
						suggestedTasks: [],
						flagCandidates: [],
					},
					evidence: [],
					commitSource: "planning_commit_result",
				};
			},
		};
		try {
			await expect(runPlanningHarness(RUN_ID, harnessOptions(store, supervisor, executor))).rejects.toMatchObject({
				code: "planning_persistence_error",
			});
			expect(executorCalls).toBe(1);
			expect(supervisorCalls).toBe(0);
			expect(store.snapshot(RUN_ID).tasks[0]?.status).toBe("failed");
			expect(store.snapshot(RUN_ID).latestFailure).toMatchObject({ code: "planning_persistence_error" });
		} finally {
			store.recordEvidence = originalRecordEvidence;
			store.close();
		}
	});

	it("does not complete when verifier evidence lacks the Bridge acceptance contract", async () => {
		const store = await seededStore();
		const supervisorCalls = { value: 0 };
		try {
			const snapshot = await runPlanningHarness(
				RUN_ID,
				harnessOptions(
					store,
					blockedSupervisor(supervisorCalls),
					executorWithEvidence([
						verifierEvidence({ verified: true, correct: true, verificationOutcome: "correct" }),
					]),
				),
			);
			expect(snapshot.run.status).toBe("blocked");
			expect(supervisorCalls.value).toBe(1);
		} finally {
			store.close();
		}
	});

	it("treats an accepted result without successful tool evidence as an executor failure", async () => {
		const store = await seededStore();
		const supervisorCalls = { value: 0 };
		const executor: PlanningExecutor = {
			async execute({ lease }) {
				return {
					result: {
						schemaVersion: PLANNING_SCHEMA_VERSION,
						leaseId: lease.leaseId,
						outcome: "done",
						summary: "model claimed completion without a tool result",
						suggestedTasks: [],
						flagCandidates: [],
					},
					evidence: [],
					commitSource: "planning_commit_result",
				};
			},
		};
		try {
			const snapshot = await runPlanningHarness(
				RUN_ID,
				harnessOptions(store, blockedSupervisor(supervisorCalls), executor),
			);
			expect(snapshot.run.status).toBe("blocked");
			expect(supervisorCalls.value).toBe(1);
			expect(snapshot.tasks[0]?.status).toBe("failed");
			expect(snapshot.latestFailure).toMatchObject({ code: "executor_error" });
		} finally {
			store.close();
		}
	});

	it("does not accept a nested correct-shaped debug verdict", async () => {
		const store = await seededStore();
		const supervisorCalls = { value: 0 };
		try {
			const snapshot = await runPlanningHarness(
				RUN_ID,
				harnessOptions(
					store,
					blockedSupervisor(supervisorCalls),
					executorWithEvidence([
						verifierEvidence({
							ok: false,
							verified: false,
							status: "incorrect",
							debug: { echo: { ok: true, verified: true, status: "correct" } },
						}),
					]),
				),
			);
			expect(snapshot.run.status).toBe("blocked");
			expect(supervisorCalls.value).toBe(1);
		} finally {
			store.close();
		}
	});

	it("does not complete if cancellation wins before the terminal evidence gate", async () => {
		const store = await seededStore();
		const controller = new AbortController();
		const supervisorCalls = { value: 0 };
		const commitResult = store.commitResult.bind(store);
		store.commitResult = ((input) => {
			const snapshot = commitResult(input);
			controller.abort("smoke cancellation");
			return snapshot;
		}) as PlanningStore["commitResult"];
		try {
			await expect(
				runPlanningHarness(
					RUN_ID,
					harnessOptions(
						store,
						blockedSupervisor(supervisorCalls),
						executorWithEvidence([verifierEvidence({ ok: true, verified: true, status: "correct" })]),
						controller.signal,
					),
				),
			).rejects.toThrow("smoke cancellation");
			expect(store.snapshot(RUN_ID).run.status).not.toBe("completed");
			expect(supervisorCalls.value).toBe(0);
		} finally {
			store.close();
		}
	});

	it("treats completion as winning when cancellation races after setRunStatus", async () => {
		const store = await seededStore();
		const controller = new AbortController();
		const supervisorCalls = { value: 0 };
		const setRunStatus = store.setRunStatus.bind(store);
		store.setRunStatus = ((...args) => {
			const run = setRunStatus(...args);
			controller.abort("late smoke cancellation");
			return run;
		}) as PlanningStore["setRunStatus"];
		try {
			const snapshot = await runPlanningHarness(
				RUN_ID,
				harnessOptions(
					store,
					blockedSupervisor(supervisorCalls),
					executorWithEvidence([verifierEvidence({ ok: true, verified: true, status: "correct" })]),
					controller.signal,
				),
			);
			expect(snapshot.run.status).toBe("completed");
			expect(store.snapshot(RUN_ID).run.status).toBe("completed");
			expect(supervisorCalls.value).toBe(0);
		} finally {
			store.close();
		}
	});

	it("keeps completion when the post-terminal diagnostic event fails", async () => {
		const store = await seededStore();
		const supervisorCalls = { value: 0 };
		const recordLifecycleEvent = store.recordLifecycleEvent.bind(store);
		store.recordLifecycleEvent = ((runId, type, payload, now) => {
			if (type === "planning_terminal_evidence_observed") throw new Error("diagnostic write failed");
			return recordLifecycleEvent(runId, type, payload, now);
		}) as PlanningStore["recordLifecycleEvent"];
		try {
			const snapshot = await runPlanningHarness(
				RUN_ID,
				harnessOptions(
					store,
					blockedSupervisor(supervisorCalls),
					executorWithEvidence([verifierEvidence({ ok: true, verified: true, status: "correct" })]),
				),
			);
			expect(snapshot.run.status).toBe("completed");
			expect(store.snapshot(RUN_ID).run.status).toBe("completed");
			expect(supervisorCalls.value).toBe(0);
		} finally {
			store.close();
		}
	});

	it("keeps normal replan behavior for unrelated successful evidence", async () => {
		const store = await seededStore();
		const supervisorCalls = { value: 0 };
		try {
			const snapshot = await runPlanningHarness(
				RUN_ID,
				harnessOptions(
					store,
					blockedSupervisor(supervisorCalls),
					executorWithEvidence([verifierEvidence({ ok: true, verified: true, status: "correct" }, "other_tool")]),
				),
			);
			expect(snapshot.run.status).toBe("blocked");
			expect(supervisorCalls.value).toBe(1);
		} finally {
			store.close();
		}
	});

	it("records terminal routing for quota exhaustion and never starts a Supervisor", async () => {
		const store = await seededStore();
		const supervisorCalls = { value: 0 };
		try {
			await expect(
				runPlanningHarness(
					RUN_ID,
					harnessOptions(store, blockedSupervisor(supervisorCalls), {
						async execute() {
							throw planningFailure("executor", "verifier_quota_exhausted", "quota exhausted");
						},
					}),
				),
			).rejects.toMatchObject({ code: "verifier_quota_exhausted" });
			expect(supervisorCalls.value).toBe(0);
			const events = store.listLifecycleEvents(RUN_ID).events;
			expect(events.find((event) => event.type === "attempt_sealed")?.payload).not.toHaveProperty(
				"returnedToSupervisor",
			);
			expect(events.find((event) => event.type === "attempt_routing_decided")?.payload).toMatchObject({
				routingState: "terminal",
				replanAllowed: false,
				replanStarted: false,
			});
		} finally {
			store.close();
		}
	});

	it("records queued and started routing for a recoverable failed attempt", async () => {
		const store = await seededStore();
		const supervisorCalls = { value: 0 };
		try {
			const snapshot = await runPlanningHarness(RUN_ID, {
				...harnessOptions(store, blockedSupervisor(supervisorCalls), {
					async execute() {
						throw planningFailure("executor", "executor_timeout", "ordinary child timeout");
					},
				}),
			});
			expect(snapshot.run.status).toBe("blocked");
			expect(supervisorCalls.value).toBe(1);
			const routing = store
				.listLifecycleEvents(RUN_ID)
				.events.filter((event) => event.type === "attempt_routing_decided");
			expect(routing.map((event) => event.payload.routingState)).toEqual(["replan_queued", "supervisor_started"]);
			expect(routing[0]?.payload).toMatchObject({ replanAllowed: true, replanStarted: false });
			expect(routing[1]?.payload).toMatchObject({ replanAllowed: true, replanStarted: true });
		} finally {
			store.close();
		}
	});

	it("records a terminal budget decision without starting the Supervisor", async () => {
		const store = await seededStore();
		const supervisorCalls = { value: 0 };
		try {
			const snapshot = await runPlanningHarness(RUN_ID, {
				...harnessOptions(store, blockedSupervisor(supervisorCalls), {
					async execute() {
						throw planningFailure("executor", "executor_timeout", "budgeted timeout");
					},
				}),
				maximumSteps: 1,
			});
			expect(snapshot.run.status).toBe("paused");
			expect(supervisorCalls.value).toBe(0);
			expect(
				store.listLifecycleEvents(RUN_ID).events.find((event) => event.type === "attempt_routing_decided")?.payload,
			).toMatchObject({
				routingState: "terminal",
				replanAllowed: false,
				replanStarted: false,
				replanReason: "maximum planning steps reached after failed attempt",
			});
		} finally {
			store.close();
		}
	});

	it("records cancellation after sealing and before Supervisor start", async () => {
		const store = await seededStore();
		const controller = new AbortController();
		const supervisorCalls = { value: 0 };
		const originalSeal = store.sealActiveLease.bind(store);
		store.sealActiveLease = ((input, now) => {
			const snapshot = originalSeal(input, now);
			controller.abort(new Error("cancelled between seal and replan"));
			return snapshot;
		}) as PlanningStore["sealActiveLease"];
		try {
			await expect(
				runPlanningHarness(RUN_ID, {
					...harnessOptions(store, blockedSupervisor(supervisorCalls), {
						async execute() {
							throw planningFailure("executor", "executor_timeout", "cancel race");
						},
					}),
					signal: controller.signal,
				}),
			).rejects.toThrow("cancelled between seal and replan");
			expect(supervisorCalls.value).toBe(0);
			expect(
				store.listLifecycleEvents(RUN_ID).events.find((event) => event.type === "attempt_routing_decided")?.payload,
			).toMatchObject({
				routingState: "terminal",
				replanAllowed: false,
				replanStarted: false,
				replanReason: "parent or user cancellation after attempt sealing",
			});
		} finally {
			store.close();
		}
	});
});
