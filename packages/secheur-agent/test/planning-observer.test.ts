import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	PlanningCheckpoint,
	PlanningEvidence,
	PlanningEvidenceListOptions,
	PlanningEvidenceListResult,
	PlanningEvidenceReadResult,
	PlanningObserverReport,
	PlanningTaskLease,
} from "../src/planning/contracts.ts";
import { PLANNING_OBSERVER_MIN_INTERVAL_MS, PlanningObserverRuntime } from "../src/planning/observer.ts";

const observerLease: PlanningTaskLease = {
	schemaVersion: 1,
	leaseId: "observer-lease",
	runId: "observer-run",
	taskId: "observer-task",
	planRevision: 1,
	objective: "inspect one path",
	doneWhen: "return the observation and evidence",
	allowedScope: "/work",
	issuedAt: 1,
	expiresAt: 600_001,
};

function toolEvidence(evidenceId: string, createdAt: number): PlanningEvidence {
	return {
		evidenceId,
		runId: observerLease.runId,
		taskId: observerLease.taskId,
		leaseId: observerLease.leaseId,
		kind: "tool",
		source: "shell",
		toolName: "shell",
		summary: "success: shell",
		excerpt: "observed output",
		contentRef: "blob-ref",
		contentHash: `hash-${evidenceId}`,
		locator: {},
		contentBytes: 16,
		contentComplete: true,
		isTruncated: false,
		metadata: { isError: false },
		createdAt,
	};
}

function failedToolEvidence(evidenceId: string, createdAt: number): PlanningEvidence {
	return {
		...toolEvidence(evidenceId, createdAt),
		summary: "error: shell",
		metadata: { isError: true },
	};
}

function observerReport(evidenceId: string, guidance?: string): PlanningObserverReport {
	return {
		attempted: ["inspect the parser branch"],
		observedResults: [{ text: "The parser returned a bounded error", evidenceIds: [evidenceId] }],
		observerJudgments: [{ text: "The validation branch may have executed", evidenceIds: [evidenceId] }],
		unverifiedHypotheses: ["A nearby branch may be reachable"],
		failuresOrStalls: ["The wider binary was not analyzed"],
		avoidRepeating: ["Do not retry the same malformed input"],
		openQuestions: ["Is the accepted format documented?"],
		...(guidance ? { guidance } : {}),
	};
}

function checkpoint(): PlanningCheckpoint {
	return {
		schemaVersion: 1,
		checkpointId: "observer-checkpoint",
		runId: observerLease.runId,
		taskId: observerLease.taskId,
		leaseId: observerLease.leaseId,
		checkpointSequence: 1,
		source: "executor",
		createdAt: Date.now(),
		summary: "A candidate path was inspected",
		evidenceRefs: ["observer-evidence-1"],
		completedItems: ["ran the parser"],
		remainingItems: ["check the successful input format"],
		rejectedDirections: [],
		artifacts: [],
		suggestedNextSteps: [],
	};
}

function page(items: PlanningEvidence[]): PlanningEvidenceListResult {
	return { items, totalCount: items.length, hasMore: false, nextCursor: null };
}

describe("Planning Observer runtime", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does no work when mode is off", async () => {
		vi.useFakeTimers();
		const observe = vi.fn(async () => JSON.stringify(observerReport("observer-evidence-1")));
		const recordObservation = vi.fn();
		const onLifecycleEvent = vi.fn();
		const runtime = new PlanningObserverRuntime({
			mode: "off",
			startedAt: Date.now(),
			lease: observerLease,
			context: "original executor context",
			listEvidence: () => page([toolEvidence("observer-evidence-1", Date.now())]),
			recordObservation,
			observe,
			onLifecycleEvent,
			onPersistenceFailure: vi.fn(),
		});
		runtime.start();
		await vi.advanceTimersByTimeAsync(600_000);
		runtime.close();
		expect(observe).not.toHaveBeenCalled();
		expect(recordObservation).not.toHaveBeenCalled();
		expect(onLifecycleEvent).not.toHaveBeenCalled();
	});

	it("observes after six distinct durable tool records and the minimum cooldown", async () => {
		vi.useFakeTimers();
		const evidence: PlanningEvidence[] = [];
		const savedSources: string[] = [];
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const observe = vi.fn(async () => JSON.stringify(observerReport("growth-evidence-1")));
		const runtime = new PlanningObserverRuntime({
			mode: "report",
			startedAt: Date.now(),
			lease: observerLease,
			context: "task context",
			listEvidence: () => page(evidence),
			readEvidence: async (evidenceId) => ({
				contentRef: `blob-${evidenceId}`,
				contentHash: `hash-${evidenceId}`,
				offset: 0,
				nextOffset: 16,
				totalBytes: 16,
				hasMore: false,
				content: "full tool output",
				contentComplete: true,
			}),
			recordObservation: (source, summary, metadata) => {
				savedSources.push(source);
				return {
					...toolEvidence("growth-observation", Date.now()),
					kind: "observation",
					source,
					summary,
					metadata,
				};
			},
			observe,
			onLifecycleEvent: (type, payload) => events.push({ type, payload }),
			onPersistenceFailure: vi.fn(),
		});
		runtime.start();
		for (let index = 1; index <= 6; index += 1) {
			const item = toolEvidence(`growth-evidence-${index}`, Date.now());
			evidence.push(item);
			runtime.recordToolEvidence([item.evidenceId], `call-${index}`);
		}
		runtime.recordToolEvidence(["growth-evidence-1"], "duplicate-call");
		await vi.advanceTimersByTimeAsync(PLANNING_OBSERVER_MIN_INTERVAL_MS - 1);
		expect(observe).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await vi.advanceTimersByTimeAsync(0);
		expect(observe).toHaveBeenCalledTimes(1);
		expect(events.find((event) => event.type === "planning_observer_started")?.payload).toMatchObject({
			triggerReason: "durable_evidence_growth",
			newEvidenceCount: 6,
		});
		runtime.close();
		expect(savedSources).toEqual(["planning_observer_report", "planning_observer_runtime"]);
	});

	it("persists a readable report in report mode without sending guidance", async () => {
		vi.useFakeTimers();
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const saved: Array<{ source: string; summary: string; metadata: Record<string, unknown> }> = [];
		const evidence = toolEvidence("observer-evidence-1", Date.now());
		const steer = vi.fn();
		const runtime = new PlanningObserverRuntime({
			mode: "report",
			startedAt: Date.now(),
			lease: observerLease,
			context: "rendered executor context",
			listEvidence: (options: PlanningEvidenceListOptions) => {
				expect(options).toMatchObject({ leaseId: observerLease.leaseId, limit: 50 });
				return page([evidence]);
			},
			readEvidence: async (evidenceId): Promise<PlanningEvidenceReadResult> => ({
				contentRef: `blob-${evidenceId}`,
				contentHash: `hash-${evidenceId}`,
				offset: 0,
				nextOffset: 10,
				totalBytes: 10,
				hasMore: false,
				content: "readable",
				contentComplete: true,
			}),
			recordObservation: (source, summary, metadata) => {
				saved.push({ source, summary, metadata });
				return { ...evidence, kind: "observation", source, summary, metadata };
			},
			observe: async (input) => {
				expect(input.evidence).toMatchObject([{ evidenceId: evidence.evidenceId, outcome: "success" }]);
				return JSON.stringify(observerReport(evidence.evidenceId, "inspect the related input"));
			},
			onLifecycleEvent: (type, payload) => events.push({ type, payload }),
			onPersistenceFailure: vi.fn(),
		});
		runtime.setExecutorSteer(steer);
		runtime.start();
		await vi.advanceTimersByTimeAsync(180_000);
		runtime.close();

		expect(saved).toHaveLength(2);
		expect(saved.map((item) => item.source)).toEqual(["planning_observer_report", "planning_observer_runtime"]);
		expect(saved[0]).toMatchObject({
			source: "planning_observer_report",
			metadata: {
				semanticReportGenerated: true,
				interpretationOnly: true,
				evidenceReferenceCheck: "same_run_readable_only",
				semanticVerification: "not_performed",
				evidenceRefs: [evidence.evidenceId],
			},
		});
		expect(JSON.parse(saved[0]?.summary ?? "{}")).toMatchObject({
			observerJudgments: [{ evidenceIds: [evidence.evidenceId] }],
		});
		expect(events.map((event) => event.type)).toContain("planning_observer_completed");
		expect(events.map((event) => event.type)).not.toContain("planning_observer_guidance_sent");
		expect(steer).not.toHaveBeenCalled();
	});

	it("sends no more than two queued guidance reminders per attempt", async () => {
		vi.useFakeTimers();
		const first = failedToolEvidence("observer-evidence-1", Date.now());
		let currentEvidence = [first];
		const steers: string[] = [];
		const events: string[] = [];
		let reportNumber = 0;
		const runtime = new PlanningObserverRuntime({
			mode: "guidance",
			startedAt: Date.now(),
			lease: observerLease,
			context: "rendered executor context",
			listEvidence: () => page(currentEvidence),
			readEvidence: async (evidenceId): Promise<PlanningEvidenceReadResult> => ({
				contentRef: `blob-${evidenceId}`,
				contentHash: `hash-${evidenceId}`,
				offset: 0,
				nextOffset: 10,
				totalBytes: 10,
				hasMore: false,
				content: "readable",
				contentComplete: true,
			}),
			recordObservation: (source, summary, metadata) => ({
				...first,
				kind: "observation",
				source,
				summary,
				metadata,
			}),
			observe: async () => {
				reportNumber += 1;
				return JSON.stringify(
					observerReport(`observer-evidence-${reportNumber}`, `check evidence ${reportNumber}`),
				);
			},
			onLifecycleEvent: (type) => events.push(type),
			onPersistenceFailure: vi.fn(),
		});
		runtime.setExecutorSteer(async (message) => {
			steers.push(message);
		});
		runtime.start();
		await vi.advanceTimersByTimeAsync(180_000);
		currentEvidence = [first, failedToolEvidence("observer-evidence-2", Date.now())];
		await vi.advanceTimersByTimeAsync(240_000);
		await vi.advanceTimersByTimeAsync(120_000);
		runtime.close();

		expect(reportNumber).toBe(2);
		expect(steers).toHaveLength(2);
		expect(events.filter((event) => event === "planning_observer_guidance_sent")).toHaveLength(2);
		expect(events).toContain("planning_observer_guidance_skipped");
	});

	it.each([
		[
			"synchronous throw",
			() => {
				throw new Error("steer sync failure");
			},
		],
		[
			"asynchronous rejection",
			async () => {
				throw new Error("steer async failure");
			},
		],
	] as const)("counts and traces only successful steer requests after a %s", async (_failureKind, failFirstSteer) => {
		vi.useFakeTimers();
		let currentEvidence = [failedToolEvidence("observer-evidence-1", Date.now())];
		let reportNumber = 0;
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const steered: string[] = [];
		const runtime = new PlanningObserverRuntime({
			mode: "guidance",
			startedAt: Date.now(),
			lease: observerLease,
			context: "context",
			listEvidence: () => page(currentEvidence),
			readEvidence: async (evidenceId): Promise<PlanningEvidenceReadResult> => ({
				contentRef: `blob-${evidenceId}`,
				contentHash: `hash-${evidenceId}`,
				offset: 0,
				nextOffset: 10,
				totalBytes: 10,
				hasMore: false,
				content: "readable",
				contentComplete: true,
			}),
			recordObservation: (source, summary, metadata) => ({
				...currentEvidence[0]!,
				kind: "observation",
				source,
				summary,
				metadata,
			}),
			observe: async () => {
				reportNumber += 1;
				return JSON.stringify(
					observerReport(`observer-evidence-${reportNumber}`, `inspect evidence ${reportNumber}`),
				);
			},
			onLifecycleEvent: (type, payload) => events.push({ type, payload }),
			onPersistenceFailure: vi.fn(),
		});
		let steerCalls = 0;
		runtime.setExecutorSteer((message) => {
			steerCalls += 1;
			if (steerCalls === 1) return failFirstSteer();
			steered.push(message);
			return Promise.resolve();
		});
		runtime.start();
		await vi.advanceTimersByTimeAsync(180_000);
		currentEvidence = [...currentEvidence, failedToolEvidence("observer-evidence-2", Date.now())];
		await vi.advanceTimersByTimeAsync(240_000);
		runtime.close();

		expect(events.filter((event) => event.type === "planning_observer_error")).toHaveLength(1);
		expect(events.find((event) => event.type === "planning_observer_error")?.payload).toMatchObject({
			failureCode: "observer_guidance_queue_failed",
		});
		expect(events.filter((event) => event.type === "planning_observer_guidance_sent")).toHaveLength(1);
		expect(events.find((event) => event.type === "planning_observer_guidance_sent")?.payload).toMatchObject({
			reminderNumber: 1,
		});
		expect(steered).toHaveLength(1);
	});

	it("saves an early runtime handoff for durable tool evidence without invoking the Observer model", () => {
		vi.useFakeTimers();
		const saved: Array<{ source: string; summary: string; metadata: Record<string, unknown> }> = [];
		const evidence = toolEvidence("observer-evidence-full-id-0123456789", Date.now());
		const observe = vi.fn(async () => JSON.stringify(observerReport(evidence.evidenceId)));
		const runtime = new PlanningObserverRuntime({
			mode: "report",
			startedAt: Date.now(),
			lease: observerLease,
			context: "context",
			listEvidence: () => page([evidence]),
			recordObservation: (source, summary, metadata) => {
				saved.push({ source, summary, metadata });
				return { ...evidence, kind: "observation", source, summary, metadata };
			},
			observe,
			onLifecycleEvent: vi.fn(),
			onPersistenceFailure: vi.fn(),
		});
		runtime.start();
		runtime.recordTimeline("executor_tool_execution_end", { toolName: "bash", isError: false });
		runtime.close();

		expect(observe).not.toHaveBeenCalled();
		expect(saved).toHaveLength(1);
		expect(saved[0]).toMatchObject({
			source: "planning_observer_runtime",
			metadata: { semanticReportGenerated: false, evidenceRefs: [evidence.evidenceId] },
		});
		expect(saved[0]?.summary).toContain(evidence.evidenceId);
		expect(JSON.parse(saved[0]?.summary ?? "{}")).toMatchObject({
			semanticReportGenerated: false,
			toolEvidenceIds: [evidence.evidenceId],
			evidenceIdsComplete: true,
			timeline: [{ type: "executor_tool_execution_end", toolName: "bash", isError: false }],
		});
	});

	it("keeps the newest unique evidence IDs first and marks capped handoffs incomplete", () => {
		vi.useFakeTimers();
		const saved: Array<{ source: string; summary: string }> = [];
		const allEvidence = Array.from({ length: 70 }, (_, index) => toolEvidence(`recent-evidence-${index}`, index + 1));
		const newestFirst = [...allEvidence].reverse();
		const runtime = new PlanningObserverRuntime({
			mode: "report",
			startedAt: Date.now(),
			hardTimeoutMs: 30_000,
			lease: observerLease,
			context: "context",
			listEvidence: () => ({ items: newestFirst.slice(0, 50), totalCount: 70, hasMore: true, nextCursor: "next" }),
			recordObservation: (source, summary) => {
				saved.push({ source, summary });
				return { ...allEvidence[0]!, kind: "observation", source, summary };
			},
			observe: vi.fn(async () => JSON.stringify(observerReport("unused"))),
			onLifecycleEvent: vi.fn(),
			onPersistenceFailure: vi.fn(),
		});
		runtime.start();
		for (let index = 0; index < allEvidence.length; index += 1) {
			const evidenceId = allEvidence[index]!.evidenceId;
			runtime.recordToolEvidence([evidenceId], `call-${index}`);
			if (index % 7 === 0) runtime.recordToolEvidence([evidenceId], `duplicate-call-${index}`);
		}
		runtime.close();

		const handoff = JSON.parse(saved[0]?.summary ?? "{}") as {
			toolEvidenceIds: string[];
			evidenceIdsComplete: boolean;
			toolEvidenceCount: number;
		};
		expect(handoff.toolEvidenceIds).toEqual(
			Array.from({ length: 32 }, (_, index) => `recent-evidence-${69 - index}`),
		);
		expect(new Set(handoff.toolEvidenceIds).size).toBe(32);
		expect(handoff.toolEvidenceCount).toBe(70);
		expect(handoff.evidenceIdsComplete).toBe(false);
	});

	it("keeps a durable attempt handoff on parent cancellation without replacing the cancellation", () => {
		const controller = new AbortController();
		const cancellation = new Error("parent stopped the attempt");
		controller.abort(cancellation);
		const saved: Array<{ source: string; summary: string; metadata: Record<string, unknown> }> = [];
		const evidence = toolEvidence("cancelled-attempt-tool-evidence", Date.now());
		const runtime = new PlanningObserverRuntime({
			mode: "report",
			startedAt: Date.now(),
			lease: observerLease,
			context: "context",
			signal: controller.signal,
			listEvidence: () => page([evidence]),
			recordObservation: (source, summary, metadata) => {
				saved.push({ source, summary, metadata });
				return { ...evidence, kind: "observation", source, summary, metadata };
			},
			observe: vi.fn(async () => JSON.stringify(observerReport("unused"))),
			onLifecycleEvent: vi.fn(),
			onPersistenceFailure: vi.fn(),
		});
		runtime.recordTimeline("executor_tool_execution_end", {
			toolCallId: "cancelled-tool-call",
			toolName: "bash",
			isError: false,
		});
		runtime.recordToolEvidence([evidence.evidenceId], "cancelled-tool-call");
		runtime.close({
			commitToolSubmissionAvailable: false,
			failure: { stage: "executor", code: "parent_cancelled", message: cancellation.message },
		});

		expect(controller.signal.reason).toBe(cancellation);
		expect(saved).toHaveLength(1);
		expect(saved[0]).toMatchObject({ source: "planning_observer_runtime" });
		expect(JSON.parse(saved[0]?.summary ?? "{}")).toMatchObject({
			semanticReportGenerated: false,
			toolEvidenceIds: [evidence.evidenceId],
			failure: { code: "parent_cancelled", message: cancellation.message },
			storeSettlementAtHandoffWrite: { durableTaskResultPresent: false },
		});
	});

	it("saves a checkpoint-only early handoff but does not create a note without progress", () => {
		vi.useFakeTimers();
		const saved: Array<{ source: string; summary: string }> = [];
		const observe = vi.fn(async () => JSON.stringify(observerReport("unused")));
		const createRuntime = () =>
			new PlanningObserverRuntime({
				mode: "report",
				startedAt: Date.now(),
				lease: observerLease,
				context: "context",
				listEvidence: () => page([]),
				recordObservation: (source, summary) => {
					saved.push({ source, summary });
					return { ...toolEvidence("fallback-record", Date.now()), kind: "observation", source, summary };
				},
				observe,
				onLifecycleEvent: vi.fn(),
				onPersistenceFailure: vi.fn(),
			});
		const checkpointRuntime = createRuntime();
		checkpointRuntime.recordCheckpoint(checkpoint());
		checkpointRuntime.start();
		checkpointRuntime.close();
		const emptyRuntime = createRuntime();
		emptyRuntime.start();
		emptyRuntime.close();

		expect(observe).not.toHaveBeenCalled();
		expect(saved).toHaveLength(1);
		expect(saved[0]?.source).toBe("planning_observer_runtime");
		expect(JSON.parse(saved[0]?.summary ?? "{}")).toMatchObject({
			semanticReportGenerated: false,
			toolEvidenceIds: [],
			lastCheckpoint: { checkpointId: "observer-checkpoint", summary: "A candidate path was inspected" },
		});
	});

	it("surfaces a runtime fallback persistence failure to the owning Executor", () => {
		const persistenceFailure = new Error("observer fallback store is unavailable");
		const controller = new AbortController();
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const runtime = new PlanningObserverRuntime({
			mode: "report",
			startedAt: Date.now(),
			lease: observerLease,
			context: "context",
			listEvidence: () => page([toolEvidence("durable-tool-evidence", Date.now())]),
			recordObservation: () => {
				throw persistenceFailure;
			},
			observe: vi.fn(async () => JSON.stringify(observerReport("unused"))),
			onLifecycleEvent: (type, payload) => events.push({ type, payload }),
			onPersistenceFailure: (error) => controller.abort(error),
		});
		runtime.close();

		expect(controller.signal.aborted).toBe(true);
		expect(controller.signal.reason).toBe(persistenceFailure);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "planning_observer_error",
				payload: expect.objectContaining({
					failureCode: "planning_persistence_error",
					stage: "runtime_fallback_persistence",
				}),
			}),
		);
	});

	it("queues the next checkpoint behind a slow Observer call and never overlaps Observer model calls", async () => {
		vi.useFakeTimers();
		let currentEvidence = [toolEvidence("observer-evidence-1", Date.now())];
		let activeCalls = 0;
		let maximumActiveCalls = 0;
		let releaseFirst: ((value: string) => void) | undefined;
		let observeCount = 0;
		const saved: string[] = [];
		const runtime = new PlanningObserverRuntime({
			mode: "report",
			startedAt: Date.now(),
			lease: observerLease,
			context: "context",
			listEvidence: () => page(currentEvidence),
			readEvidence: async (evidenceId): Promise<PlanningEvidenceReadResult> => ({
				contentRef: `blob-${evidenceId}`,
				contentHash: `hash-${evidenceId}`,
				offset: 0,
				nextOffset: 10,
				totalBytes: 10,
				hasMore: false,
				content: "readable",
				contentComplete: true,
			}),
			recordObservation: (_source, summary) => {
				saved.push(summary);
				return { ...currentEvidence[0]!, kind: "observation", source: "planning_observer_report", summary };
			},
			observe: async (input) => {
				observeCount += 1;
				activeCalls += 1;
				maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
				if (observeCount === 1) {
					return await new Promise<string>((resolve) => {
						releaseFirst = (value) => {
							activeCalls -= 1;
							resolve(value);
						};
					});
				}
				activeCalls -= 1;
				const selectedEvidenceId = input.evidence.at(-1)?.evidenceId ?? "observer-evidence-2";
				return JSON.stringify(observerReport(selectedEvidenceId));
			},
			onLifecycleEvent: vi.fn(),
			onPersistenceFailure: vi.fn(),
		});
		runtime.start();
		await vi.advanceTimersByTimeAsync(180_000);
		currentEvidence = [...currentEvidence, toolEvidence("observer-evidence-2", Date.now())];
		await vi.advanceTimersByTimeAsync(240_000);
		expect(observeCount).toBe(1);
		releaseFirst?.(JSON.stringify(observerReport("observer-evidence-1")));
		await vi.advanceTimersByTimeAsync(0);
		runtime.close();

		expect(observeCount).toBe(2);
		expect(maximumActiveCalls).toBe(1);
		expect(saved).toHaveLength(3);
	});

	it("records an explicit runtime fallback when semantic reporting fails", async () => {
		vi.useFakeTimers();
		const saved: Array<{ source: string; summary: string; metadata: Record<string, unknown> }> = [];
		const runtime = new PlanningObserverRuntime({
			mode: "report",
			startedAt: Date.now(),
			lease: observerLease,
			context: "context",
			listEvidence: () => page([toolEvidence("observer-evidence-1", Date.now())]),
			recordObservation: (source, summary, metadata) => {
				saved.push({ source, summary, metadata });
				return { ...toolEvidence("fallback-record", Date.now()), kind: "observation", source, summary, metadata };
			},
			observe: async () => {
				throw new Error("observer model unavailable");
			},
			onLifecycleEvent: vi.fn(),
			onPersistenceFailure: vi.fn(),
		});
		runtime.recordCheckpoint(checkpoint());
		runtime.start();
		await vi.advanceTimersByTimeAsync(180_000);
		runtime.close();

		expect(saved).toHaveLength(1);
		expect(saved[0]?.source).toBe("planning_observer_runtime");
		expect(saved[0]?.metadata.semanticReportGenerated).toBe(false);
		expect(JSON.parse(saved[0]?.summary ?? "{}")).toMatchObject({
			status: "Observer semantic report not generated",
			toolEvidenceIds: ["observer-evidence-1"],
			lastCheckpoint: { checkpointId: "observer-checkpoint", evidenceRefs: ["observer-evidence-1"] },
		});
	});

	it("hands an existing checkpoint forward when a checkpoint had no new tool evidence to report", async () => {
		vi.useFakeTimers();
		const saved: Array<{ source: string; summary: string }> = [];
		const observe = vi.fn(async () => JSON.stringify(observerReport("unused")));
		const runtime = new PlanningObserverRuntime({
			mode: "report",
			startedAt: Date.now(),
			lease: observerLease,
			context: "context",
			listEvidence: () => page([]),
			recordObservation: (source, summary) => {
				saved.push({ source, summary });
				return { ...toolEvidence("fallback-record", Date.now()), kind: "observation", source, summary };
			},
			observe,
			onLifecycleEvent: vi.fn(),
			onPersistenceFailure: vi.fn(),
		});
		runtime.recordCheckpoint(checkpoint());
		runtime.start();
		await vi.advanceTimersByTimeAsync(180_000);
		runtime.close();

		expect(observe).not.toHaveBeenCalled();
		expect(saved).toHaveLength(1);
		expect(saved[0]?.source).toBe("planning_observer_runtime");
		expect(JSON.parse(saved[0]?.summary ?? "{}")).toMatchObject({
			status: "Observer semantic report not generated",
			toolEvidenceIds: [],
			lastCheckpoint: { checkpointId: "observer-checkpoint", evidenceRefs: ["observer-evidence-1"] },
		});
	});

	it("marks unreadable or wrong-run references unverified and records the diagnostic", async () => {
		vi.useFakeTimers();
		const saved: Array<{ summary: string; metadata: Record<string, unknown> }> = [];
		const events: string[] = [];
		const runtime = new PlanningObserverRuntime({
			mode: "report",
			startedAt: Date.now(),
			lease: observerLease,
			context: "context",
			listEvidence: () => page([toolEvidence("observer-evidence-1", Date.now())]),
			readEvidence: async (): Promise<PlanningEvidenceReadResult> => {
				throw new Error("evidence does not belong to this run");
			},
			recordObservation: (_source, summary, metadata) => {
				saved.push({ summary, metadata });
				return {
					...toolEvidence("report", Date.now()),
					kind: "observation",
					source: "planning_observer_report",
					summary,
					metadata,
				};
			},
			observe: async () => JSON.stringify(observerReport("wrong-run-evidence")),
			onLifecycleEvent: (type) => events.push(type),
			onPersistenceFailure: vi.fn(),
		});
		runtime.start();
		await vi.advanceTimersByTimeAsync(180_000);
		runtime.close();

		const report = JSON.parse(saved[0]?.summary ?? "{}") as PlanningObserverReport;
		expect(saved[0]?.metadata).toMatchObject({ evidenceRefs: [], invalidEvidenceReferenceCount: 1 });
		expect(report.observerJudgments).toEqual([]);
		expect(report.unverifiedHypotheses.some((item) => item.includes("evidence reference absent or unreadable"))).toBe(
			true,
		);
		expect(events).toContain("planning_observer_error");
	});
});
