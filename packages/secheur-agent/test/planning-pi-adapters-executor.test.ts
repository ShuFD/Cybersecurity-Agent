import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PLANNING_SCHEMA_VERSION,
	type PlanningEvidence,
	type PlanningTaskLease,
	type PlanningTaskResult,
	planningFlagCandidateHash,
} from "../src/planning/contracts.ts";
import { PlanningPersistenceError } from "../src/planning/failures.ts";
import { PiPlanningExecutor, type PiPlanningExtensionBundle } from "../src/planning/pi-adapters.ts";
import { PlanningStore } from "../src/planning/store.ts";
import { type runPiCodingTask, VerifierInfrastructureError } from "../src/subagent.ts";

const mockedRunPiCodingTask = vi.hoisted(() => vi.fn());
const mockedCreatePlanningCommitExtension = vi.hoisted(() => vi.fn());
let committedResult: PlanningTaskResult | undefined;

vi.mock("../src/subagent.ts", () => ({
	runPiCodingTask: mockedRunPiCodingTask,
	VerifierInfrastructureError: class MockVerifierInfrastructureError extends Error {
		readonly source = "verifier" as const;
		readonly code = "verifier_infrastructure_error" as const;
		readonly failureCategory: string;
		constructor(details: { failureCategory: string }) {
			super(details.failureCategory);
			this.failureCategory = details.failureCategory;
		}
	},
}));
vi.mock("../src/planning/result-tool.ts", () => ({
	createPlanningCommitExtension: mockedCreatePlanningCommitExtension,
}));

function lease(): PlanningTaskLease {
	return {
		schemaVersion: PLANNING_SCHEMA_VERSION,
		leaseId: "lease-executor-1",
		runId: "run-executor-1",
		taskId: "task-executor-1",
		planRevision: 7,
		objective: "inspect the target",
		doneWhen: "the result is committed",
		allowedScope: "/work",
		issuedAt: 1_789_000_000,
		expiresAt: 1_789_001_000,
	};
}

function result(): PlanningTaskResult {
	return {
		schemaVersion: PLANNING_SCHEMA_VERSION,
		leaseId: "lease-executor-1",
		outcome: "done",
		summary: "committed",
		suggestedTasks: [],
		flagCandidates: [],
		evidenceRefs: [],
		facts: [],
		rejectedDirections: [],
		openQuestions: [],
		resolvedQuestionIds: [],
		artifacts: [],
	};
}

function executor(
	events: Array<{ type: string; payload: Record<string, unknown> }>,
	close = vi.fn(),
	taskTimeoutMs?: number,
	createExtensionBundle?: () => PiPlanningExtensionBundle,
): {
	executor: PiPlanningExecutor;
	close: ReturnType<typeof vi.fn>;
} {
	return {
		executor: new PiPlanningExecutor({
			config: { stateDir: ":memory:", planning: { engine: "progressive" } } as never,
			cwd: "/work",
			...(taskTimeoutMs === undefined ? {} : { taskTimeoutMs }),
			createExtensionBundle: createExtensionBundle ?? (() => ({ extensionFactories: [], close })),
			onLifecycleEvent: (type, payload) => events.push({ type, payload }),
		}),
		close,
	};
}

describe("Pi planning executor lifecycle", () => {
	it.each(["progressive", "hypothesis"])(
		"refreshes %s shared feedback at the next request without replacing task/tool messages",
		async (engine) => {
			const planningExecutor = new PiPlanningExecutor({
				config: { stateDir: ":memory:", planning: { engine } } as never,
				cwd: "/work",
			});
			const history = [
				{ evidenceId: "fixture-verdict-a", status: "incorrect", taskId: "peer", remainingAttempts: 2 },
			];
			mockedRunPiCodingTask.mockImplementationOnce(async (options: Parameters<typeof runPiCodingTask>[0]) => {
				const handlers: Array<(event: { messages: unknown[] }) => { messages: unknown[] } | undefined> = [];
				for (const extension of options.extensionFactories ?? []) {
					if (typeof extension !== "function") continue;
					await extension({
						on: (
							name: string,
							callback: (event: { messages: unknown[] }) => { messages: unknown[] } | undefined,
						) => {
							if (name === "context") handlers.push(callback);
						},
					} as never);
				}
				const original = [
					{ role: "user", content: "current task" },
					{ role: "toolResult", toolCallId: "fixture-call", content: "prior response" },
				];
				const first = handlers.map((handler) => handler({ messages: original })).find(Boolean)!;
				expect(first.messages.slice(1)).toEqual(original);
				expect(JSON.stringify(first.messages[0])).toContain("fixture-verdict-a");
				history.push({
					evidenceId: "fixture-verdict-b",
					status: "request_error",
					taskId: "peer",
					remainingAttempts: 1,
				});
				const second = handlers.map((handler) => handler({ messages: original })).find(Boolean)!;
				expect(JSON.stringify(second.messages[0])).toContain("fixture-verdict-b");
				expect(JSON.stringify(second.messages[0])).toContain("fixture-task-progress");
				committedResult = result();
				return { messages: [], finalText: "", toolExecutions: [] };
			});
			await planningExecutor.execute({
				lease: lease(),
				context: "task",
				verificationHistory: () => history,
				taskProgress: () => [
					{
						id: "fixture-card",
						summary: "fixture-task-progress",
						scope: "checkpoint",
						keyValues: {},
						limitations: "unverified",
						evidenceRefs: ["fixture-source"],
						sourceHashes: {},
						sourceTaskId: lease().taskId,
						sourceLeaseId: lease().leaseId,
					},
				],
			});
		},
	);
	afterEach(() => {
		vi.useRealTimers();
	});

	beforeEach(() => {
		committedResult = undefined;
		mockedRunPiCodingTask.mockReset();
		mockedCreatePlanningCommitExtension.mockReset();
		mockedCreatePlanningCommitExtension.mockImplementation(() => ({
			extension: {},
			getResult: () => committedResult,
		}));
	});

	it("deduplicates repeated tool completion across clock ticks in the real Store and rejects changed content", async () => {
		const root = mkdtempSync(join(tmpdir(), "planning-duplicate-tool-"));
		const stateDir = join(root, ".state");
		const store = await PlanningStore.open(join(stateDir, "planning.sqlite"));
		try {
			store.createRun({ runId: "duplicate-run", outerTaskId: "duplicate-outer", goal: "test", mode: "active" });
			store.commitPlan({
				runId: "duplicate-run",
				expectedRevision: 0,
				rationale: "test",
				idempotencyKey: "duplicate-plan",
				tasks: [
					{
						taskId: "duplicate-task",
						objective: "test",
						doneWhen: "tested",
						priority: 1,
						sequence: 0,
						dependsOnTaskIds: [],
					},
				],
			});
			const activeLease = store.leaseTask("duplicate-run", "duplicate-task", root, 30_000);
			store.startLease(activeLease.leaseId);
			const execution = {
				toolCallId: "same-call",
				toolName: "bash",
				toolInput: { command: "printf durable" },
				result: { stdout: "durable result" },
				isError: false,
			};
			let firstEvidenceId = "";
			let writes = 0;
			const planningExecutor = new PiPlanningExecutor({
				config: { stateDir, planning: { engine: "progressive" } } as never,
				cwd: root,
			});
			mockedRunPiCodingTask.mockImplementationOnce(async (options: Parameters<typeof runPiCodingTask>[0]) => {
				options.onToolExecution?.(execution);
				await new Promise((resolve) => setTimeout(resolve, 5));
				options.onToolExecution?.(execution);
				committedResult = { ...result(), leaseId: activeLease.leaseId };
				return { messages: [], finalText: "", toolExecutions: [] };
			});
			const report = await planningExecutor.execute({
				lease: activeLease,
				context: "test",
				recordEvidence: (item) => {
					writes += store.recordEvidence(activeLease.leaseId, [item]);
					firstEvidenceId = item.evidenceId ?? "";
				},
			});
			expect(report.evidence).toHaveLength(1);
			expect(writes).toBe(1);
			expect(store.snapshot("duplicate-run").evidence).toHaveLength(1);
			expect(store.readEvidence("duplicate-run", firstEvidenceId).content).toContain("durable result");
			mockedRunPiCodingTask.mockImplementationOnce(async (options: Parameters<typeof runPiCodingTask>[0]) => {
				options.onToolExecution?.({ ...execution, result: { stdout: "different result" } });
				return { messages: [], finalText: "", toolExecutions: [] };
			});
			await expect(
				planningExecutor.execute({
					lease: activeLease,
					context: "test",
					recordEvidence: (item) => {
						store.recordEvidence(activeLease.leaseId, [item]);
					},
				}),
			).rejects.toMatchObject({ code: "planning_persistence_error" });
			expect(store.snapshot("duplicate-run").evidence).toHaveLength(1);
			store.createRun({ runId: "isolated-run", outerTaskId: "isolated-outer", goal: "test", mode: "active" });
			store.commitPlan({
				runId: "isolated-run",
				expectedRevision: 0,
				rationale: "test",
				idempotencyKey: "isolated-plan",
				tasks: [
					{
						taskId: "isolated-task",
						objective: "test",
						doneWhen: "tested",
						priority: 1,
						sequence: 0,
						dependsOnTaskIds: [],
					},
				],
			});
			const isolatedLease = store.leaseTask("isolated-run", "isolated-task", root, 30_000);
			store.startLease(isolatedLease.leaseId);
			mockedRunPiCodingTask.mockImplementationOnce(async (options: Parameters<typeof runPiCodingTask>[0]) => {
				options.onToolExecution?.(execution);
				committedResult = { ...result(), leaseId: isolatedLease.leaseId };
				return { messages: [], finalText: "", toolExecutions: [] };
			});
			await planningExecutor.execute({
				lease: isolatedLease,
				context: "test",
				recordEvidence: (item) => {
					store.recordEvidence(isolatedLease.leaseId, [item]);
				},
			});
			const isolatedEvidence = store.snapshot("isolated-run").evidence;
			expect(isolatedEvidence).toHaveLength(1);
			expect(isolatedEvidence[0]?.evidenceId).not.toBe(firstEvidenceId);
			expect(() => store.readEvidence("duplicate-run", isolatedEvidence[0]!.evidenceId)).toThrow();
		} finally {
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("persists foreground processing and a later background completion as distinct evidence and one host checkpoint", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const { executor: planningExecutor } = executor(events);
		const checkpoint = vi.fn();
		const saved: Array<{ evidenceId?: string }> = [];
		mockedRunPiCodingTask.mockImplementationOnce(async (options: Parameters<typeof runPiCodingTask>[0]) => {
			const execution = {
				toolCallId: "background-call",
				toolName: "bash",
				toolInput: { fixture: true },
				isError: false,
				result: { status: "running" },
			};
			options.onToolExecution?.(execution);
			options.onToolExecution?.({ ...execution, backgroundCompletion: true, result: { status: "completed" } });
			options.onToolExecution?.({ ...execution, backgroundCompletion: true, result: { status: "completed" } });
			committedResult = result();
			return { messages: [], finalText: "", toolExecutions: [] };
		});
		await planningExecutor.execute({
			lease: lease(),
			context: "test",
			recordEvidence: (item) => saved.push(item),
			recordCheckpoint: checkpoint,
		});
		expect(saved).toHaveLength(2);
		expect(saved[0]?.evidenceId).not.toBe(saved[1]?.evidenceId);
		expect(checkpoint).toHaveBeenCalledTimes(1);
		expect(checkpoint.mock.calls[0]?.[1].evidenceRefs).toEqual([saved[1]?.evidenceId]);
		expect(checkpoint.mock.calls[0]?.[1].summary).toContain("goal remains unverified");
	});

	it("traces a successful commit and bundle close with lease identity", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const { executor: planningExecutor, close } = executor(events);
		mockedRunPiCodingTask.mockImplementationOnce(async (options: Parameters<typeof runPiCodingTask>[0]) => {
			options.onLifecycleEvent?.("coding_task_start");
			options.onLifecycleEvent?.("prompt_start");
			options.onLifecycleEvent?.("prompt_end");
			options.onLifecycleEvent?.("tool_execution_start", {
				toolCallId: "inspect-call-1",
				toolName: "bash",
				args: { command: "sensitive command" },
			});
			options.onToolExecution?.({
				toolCallId: "inspect-call-1",
				toolName: "bash",
				result: { stdout: "sensitive output" },
				isError: false,
			});
			options.onLifecycleEvent?.("tool_execution_start", {
				toolCallId: "read-call-1",
				toolName: "planning_read_evidence",
			});
			options.onToolExecution?.({
				toolCallId: "read-call-1",
				toolName: "planning_read_evidence",
				result: { content: "evidence" },
				isError: false,
			});
			options.onLifecycleEvent?.("tool_execution_start", {
				toolCallId: "commit-call-1",
				toolName: "planning_commit_result",
			});
			committedResult = result();
			options.onToolExecution?.({
				toolCallId: "commit-call-1",
				toolName: "planning_commit_result",
				result: { accepted: true },
				isError: false,
			});
			options.onLifecycleEvent?.("coding_task_end");
			return { messages: [], finalText: "", toolExecutions: [] };
		});

		await expect(planningExecutor.execute({ lease: lease(), context: "context" })).resolves.toMatchObject({
			commitSource: "planning_commit_result",
		});
		expect(close).toHaveBeenCalledOnce();
		expect(events.map((event) => event.type)).toEqual([
			"executor_start",
			"extension_bundle_create_start",
			"extension_bundle_create_end",
			"coding_task_start",
			"prompt_start",
			"prompt_end",
			"executor_tool_execution_start",
			"executor_tool_execution_end",
			"executor_tool_execution_start",
			"executor_tool_execution_end",
			"executor_tool_execution_start",
			"executor_tool_execution_end",
			"planning_commit_observed",
			"coding_task_end",
			"extension_bundle_close_start",
			"extension_bundle_close_end",
			"executor_end",
		]);
		for (const event of events) {
			expect(event.payload).toMatchObject({
				runId: "run-executor-1",
				revision: 7,
				taskId: "task-executor-1",
				leaseId: "lease-executor-1",
			});
			expect(event.payload.elapsedMs).toEqual(expect.any(Number));
		}
		expect(events.find((event) => event.type === "planning_commit_observed")?.payload).toMatchObject({
			toolCallId: "commit-call-1",
			isError: false,
			accepted: true,
		});
		const inspectStart = events.find(
			(event) => event.type === "executor_tool_execution_start" && event.payload.toolCallId === "inspect-call-1",
		);
		const inspectEnd = events.find(
			(event) => event.type === "executor_tool_execution_end" && event.payload.toolCallId === "inspect-call-1",
		);
		expect(inspectStart?.payload).toMatchObject({ toolCallId: "inspect-call-1", toolName: "bash" });
		expect(inspectStart?.payload).not.toHaveProperty("args");
		expect(inspectEnd?.payload).toMatchObject({
			toolCallId: "inspect-call-1",
			toolName: "bash",
			isError: false,
			toolElapsedMs: expect.any(Number),
		});
		expect(inspectEnd?.payload).not.toHaveProperty("result");
		expect(events.indexOf(inspectStart!)).toBeLessThan(events.indexOf(inspectEnd!));
		expect(
			events.find(
				(event) => event.type === "executor_tool_execution_start" && event.payload.toolCallId === "read-call-1",
			)?.payload,
		).toMatchObject({ toolCallId: "read-call-1", toolName: "planning_read_evidence" });
		expect(
			events.find(
				(event) => event.type === "executor_tool_execution_end" && event.payload.toolCallId === "read-call-1",
			)?.payload,
		).toMatchObject({ toolCallId: "read-call-1", toolName: "planning_read_evidence", isError: false });
	});

	it("traces an errored tool without turning the tool error into executor failure", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const { executor: planningExecutor } = executor(events);
		mockedRunPiCodingTask.mockImplementationOnce(async (options: Parameters<typeof runPiCodingTask>[0]) => {
			options.onLifecycleEvent?.("tool_execution_start", { toolCallId: "error-call", toolName: "read" });
			options.onToolExecution?.({
				toolCallId: "error-call",
				toolName: "read",
				result: { error: "not found" },
				isError: true,
			});
			options.onLifecycleEvent?.("tool_execution_start", {
				toolCallId: "commit-call-error-tool",
				toolName: "planning_commit_result",
			});
			committedResult = result();
			options.onToolExecution?.({
				toolCallId: "commit-call-error-tool",
				toolName: "planning_commit_result",
				result: { accepted: true },
				isError: false,
			});
			return { messages: [], finalText: "", toolExecutions: [] };
		});

		await expect(planningExecutor.execute({ lease: lease(), context: "context" })).resolves.toMatchObject({
			commitSource: "planning_commit_result",
		});
		expect(
			events.find(
				(event) => event.type === "executor_tool_execution_end" && event.payload.toolCallId === "error-call",
			)?.payload,
		).toMatchObject({
			toolCallId: "error-call",
			toolName: "read",
			isError: true,
		});
		expect(events.some((event) => event.type === "executor_error")).toBe(false);
	});

	it("forwards completed tool evidence to the runtime before executor completion", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const { executor: planningExecutor } = executor(events);
		const recordEvidence = vi.fn();
		const recordCheckpoint = vi.fn();
		mockedRunPiCodingTask.mockImplementationOnce(async (options: Parameters<typeof runPiCodingTask>[0]) => {
			options.onToolExecution?.({
				toolCallId: "incremental-tool-call",
				toolName: "bash",
				result: { stdout: "partial output" },
				isError: false,
			});
			committedResult = result();
			return { messages: [], finalText: "", toolExecutions: [] };
		});

		await expect(
			planningExecutor.execute({
				lease: lease(),
				context: "context",
				recordEvidence,
				recordCheckpoint,
			}),
		).resolves.toMatchObject({ commitSource: "planning_commit_result" });
		expect(recordEvidence).toHaveBeenCalledOnce();
		expect(recordEvidence.mock.calls[0]?.[0]).toMatchObject({
			kind: "tool",
			toolName: "bash",
			metadata: { toolCallId: "incremental-tool-call", isError: false },
		});
		expect(mockedCreatePlanningCommitExtension.mock.calls[0]?.[0].recordCheckpoint).toEqual(expect.any(Function));
	});

	it("keeps all optional capabilities off at the baseline prompt and extension boundary", async () => {
		let capturedOptions: Parameters<typeof runPiCodingTask>[0] | undefined;
		const listEvidence = vi.fn();
		const recordEvidence = vi.fn();
		const recordObservation = vi.fn();
		const planningExecutor = new PiPlanningExecutor({
			config: {
				stateDir: ":memory:",
				planning: {
					evidenceCatalogEnabled: false,
					observerMode: "off",
					taskGranularityPromptEnabled: false,
					executorContextBytes: 16_384,
				},
			} as never,
			cwd: "/work",
		});
		mockedRunPiCodingTask.mockImplementationOnce(async (options: Parameters<typeof runPiCodingTask>[0]) => {
			capturedOptions = options;
			committedResult = result();
			return { messages: [], finalText: "", toolExecutions: [] };
		});

		await planningExecutor.execute({
			lease: lease(),
			context: "baseline rendered context",
			listEvidence,
			recordEvidence,
			recordObservation,
		});

		expect(mockedRunPiCodingTask).toHaveBeenCalledOnce();
		expect(capturedOptions?.task).toBe(
			[
				"baseline rendered context",
				"Execute the leased objective end to end. Continue through dependent local steps without handing each tool call back to the Supervisor. Verify any grounded candidate with the available native verifier before finishing. Before finishing, call planning_commit_result exactly once.",
				"Use planning_checkpoint at meaningful milestones to save a bounded progress summary. It does not complete the task.",
				"Do not commit the task merely because a command moved to background. Keep its task ID, continue independent work, and consume completion evidence before the final task report.",
				"If an evidence excerpt is truncated or you need exact output, call planning_read_evidence with its evidenceId and use offset/nextOffset for large content.",
				"Reuse evidence already read in this session and committed artifacts; do not repeatedly read the same unchanged page. If a tool remains processing, continue independent work and consume its completion notification instead of repeatedly polling.",
				"If repeated tool errors or a disproved direction materially change the approach, save planning_checkpoint with rejectedDirections and suggestedNextSteps while continuing useful work. A checkpoint can inform the Supervisor before this attempt ends; it never requires abandoning the attempt.",
				"Report outcome and summary, plus grounded facts, rejectedDirections, openQuestions, resolvedQuestionIds, and artifacts.",
				"Facts and rejected directions must be based on successful tool evidence. Omit evidenceRefs to bind all current tool evidence.",
				"suggestedTasks are hints only; the Supervisor decides all future tasks.",
				"Set outcome to exactly one of done, disproved, blocked, failed.",
			].join("\n\n"),
		);
		expect(capturedOptions).not.toHaveProperty("onSteerReady");
		expect(mockedCreatePlanningCommitExtension.mock.calls[0]?.[0]).not.toHaveProperty("listEvidence");
		expect(listEvidence).not.toHaveBeenCalled();
		expect(recordEvidence).not.toHaveBeenCalled();
		expect(recordObservation).not.toHaveBeenCalled();
		expect(committedResult?.summary).toBe("committed");
		expect(capturedOptions?.requiredToolName).toBe("planning_commit_result");
	});

	it.each(["progressive", "hypothesis", "artex"])(
		"exposes the default %s run catalog without storing catalog queries as evidence",
		async (engine) => {
			const listEvidence = vi.fn(() => ({ items: [], totalCount: 0, hasMore: false, nextCursor: null }));
			const recordEvidence = vi.fn();
			const planningExecutor = new PiPlanningExecutor({
				config: {
					stateDir: ":memory:",
					planning: { engine, observerMode: "off" },
				} as never,
				cwd: "/work",
			});
			mockedRunPiCodingTask.mockImplementationOnce(async (options: Parameters<typeof runPiCodingTask>[0]) => {
				expect(options.task).toContain("Use planning_list_evidence to discover persisted evidence");
				options.onToolExecution?.({
					toolCallId: "catalog-call",
					toolName: "planning_list_evidence",
					result: { items: [{ evidenceId: "historical-evidence" }] },
					isError: false,
				});
				options.onToolExecution?.({
					toolCallId: "ordinary-call",
					toolName: "bash",
					result: { stdout: "a real observation" },
					isError: false,
				});
				committedResult = result();
				return { messages: [], finalText: "", toolExecutions: [] };
			});

			const report = await planningExecutor.execute({
				lease: lease(),
				context: "catalog enabled context",
				listEvidence,
				recordEvidence,
			});

			expect(mockedCreatePlanningCommitExtension.mock.calls[0]?.[0]).toMatchObject({ listEvidence });
			expect(recordEvidence).toHaveBeenCalledOnce();
			expect(recordEvidence.mock.calls[0]?.[0]).toMatchObject({ toolName: "bash", kind: "tool" });
			expect(report.evidence.map((item) => item.toolName)).toEqual(["bash"]);
		},
	);

	it("runs the Observer independently and queues guidance through the Executor steer hook", async () => {
		vi.useFakeTimers();
		const stored: PlanningEvidence[] = [];
		const observations: PlanningEvidence[] = [];
		const steered: string[] = [];
		let observedEvidenceId = "";
		let modelCalls = 0;
		const planningExecutor = new PiPlanningExecutor({
			config: {
				stateDir: ":memory:",
				planning: { observerMode: "guidance", evidenceCatalogEnabled: false },
			} as never,
			cwd: "/work",
		});
		mockedRunPiCodingTask.mockImplementation(async (options: Parameters<typeof runPiCodingTask>[0]) => {
			modelCalls += 1;
			if (options.allowedTools?.length === 0) {
				expect(options.task).toContain("A readable ID only confirms that the same-run record can be read");
				expect(options.task).toContain("observerJudgments");
				expect(options.systemPrompt).toContain("never describe readable references as semantic verification");
				return {
					messages: [],
					finalText: JSON.stringify({
						attempted: ["inspect command output"],
						observedResults: [
							{ text: "The command returned a candidate value", evidenceIds: [observedEvidenceId] },
						],
						observerJudgments: [],
						unverifiedHypotheses: [],
						failuresOrStalls: [],
						avoidRepeating: ["Do not rerun the same command"],
						openQuestions: ["Does the candidate work with a second input?"],
						guidance: "Read the exact command output before choosing the next input.",
					}),
					toolExecutions: [],
				};
			}
			options.onSteerReady?.(async (message) => {
				steered.push(message);
			});
			options.onToolExecution?.({
				toolCallId: "guidance-evidence-call",
				toolName: "bash",
				result: { stderr: "the first candidate was rejected" },
				isError: true,
			});
			observedEvidenceId = stored[0]?.evidenceId ?? "";
			await vi.advanceTimersByTimeAsync(180_000);
			committedResult = result();
			return { messages: [], finalText: "", toolExecutions: [] };
		});

		await planningExecutor.execute({
			lease: lease(),
			context: "guidance adapter context",
			recordEvidence: (item) => {
				stored.push({
					...item,
					evidenceId: item.evidenceId ?? "missing-id",
					runId: "run-executor-1",
					taskId: "task-executor-1",
					leaseId: "lease-executor-1",
					contentRef: null,
					excerpt: item.excerpt ?? "",
					contentBytes: item.contentBytes ?? 0,
					contentComplete: item.contentComplete ?? true,
					isTruncated: item.isTruncated ?? false,
					locator: item.locator ?? {},
					metadata: item.metadata ?? {},
					createdAt: Date.now(),
				});
			},
			listEvidence: () => ({
				items: stored,
				totalCount: stored.length,
				hasMore: false,
				nextCursor: null,
			}),
			readEvidence: async (evidenceId) => ({
				contentRef: `blob-${evidenceId}`,
				contentHash: "readable-hash",
				offset: 0,
				nextOffset: 16,
				totalBytes: 16,
				hasMore: false,
				content: "candidate value",
				contentComplete: true,
			}),
			recordObservation: (source, summary, metadata) => {
				const item: PlanningEvidence = {
					...stored[0]!,
					evidenceId: "observer-report",
					kind: "observation",
					source,
					summary,
					metadata,
				};
				observations.push(item);
				return item;
			},
		});

		expect(modelCalls).toBe(2);
		expect(observations).toHaveLength(2);
		expect(observations[0]).toMatchObject({ kind: "observation", source: "planning_observer_report" });
		expect(observations[1]).toMatchObject({
			kind: "observation",
			source: "planning_observer_runtime",
			metadata: expect.objectContaining({ semanticReportGenerated: true }),
		});
		expect(steered).toHaveLength(1);
		expect(steered[0]).toContain("advisory only");
		expect(steered[0]).toContain("not an approval or proof");
		expect(steered[0]).toContain("readability does not prove the interpretation");
		expect(steered[0]).toContain(observedEvidenceId);
	});

	it("lets the Executor commit while a slow Observer call is still running", async () => {
		vi.useFakeTimers();
		const stored: PlanningEvidence[] = [];
		const savedObservations: string[] = [];
		let observerStarted = false;
		let observedEvidenceId = "";
		const planningExecutor = new PiPlanningExecutor({
			config: {
				stateDir: ":memory:",
				planning: { observerMode: "report", evidenceCatalogEnabled: false },
			} as never,
			cwd: "/work",
		});
		mockedRunPiCodingTask.mockImplementation(async (options: Parameters<typeof runPiCodingTask>[0]) => {
			if (options.allowedTools?.length === 0) {
				observerStarted = true;
				return await new Promise(() => {});
			}
			options.onToolExecution?.({
				toolCallId: "slow-observer-evidence-call",
				toolName: "bash",
				result: { stdout: "durable before the observer finishes" },
				isError: false,
			});
			observedEvidenceId = stored[0]?.evidenceId ?? "";
			await vi.advanceTimersByTimeAsync(180_000);
			committedResult = result();
			return { messages: [], finalText: "", toolExecutions: [] };
		});

		const report = await planningExecutor.execute({
			lease: lease(),
			context: "slow observer context",
			recordEvidence: (item) => {
				stored.push({
					...item,
					evidenceId: item.evidenceId ?? "missing-id",
					runId: "run-executor-1",
					taskId: "task-executor-1",
					leaseId: "lease-executor-1",
					contentRef: null,
					excerpt: item.excerpt ?? "",
					contentBytes: item.contentBytes ?? 0,
					contentComplete: item.contentComplete ?? true,
					isTruncated: item.isTruncated ?? false,
					locator: item.locator ?? {},
					metadata: item.metadata ?? {},
					createdAt: Date.now(),
				});
			},
			listEvidence: () => ({ items: stored, totalCount: stored.length, hasMore: false, nextCursor: null }),
			recordObservation: (source, summary) => {
				savedObservations.push(summary);
				return {
					...stored[0]!,
					evidenceId: "slow-observer-fallback",
					kind: "observation",
					source,
					summary,
				};
			},
		});

		expect(report.commitSource).toBe("planning_commit_result");
		expect(report.result.summary).toBe("committed");
		expect(observerStarted).toBe(true);
		expect(observedEvidenceId).toBe(stored[0]?.evidenceId);
		expect(savedObservations).toHaveLength(1);
		expect(JSON.parse(savedObservations[0] ?? "{}")).toMatchObject({
			status: "Observer semantic report not generated",
			toolEvidenceIds: [observedEvidenceId],
		});
	});

	it("persists a verifier candidate hash and structured verdict without copying the candidate into metadata", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const { executor: planningExecutor } = executor(events);
		const candidate = "flag{candidate-redacted-from-metadata}";
		mockedRunPiCodingTask.mockImplementationOnce(async (options: Parameters<typeof runPiCodingTask>[0]) => {
			options.onLifecycleEvent?.("tool_execution_start", { toolCallId: "verify-call", toolName: "verify_flag" });
			options.onToolExecution?.({
				toolCallId: "verify-call",
				toolName: "verify_flag",
				toolInput: { flag: candidate },
				result: {
					details: {
						data: { ok: true, verified: false, status: "incorrect", verificationOutcome: "incorrect" },
					},
				},
				isError: false,
			});
			committedResult = result();
			return { messages: [], finalText: "", toolExecutions: [] };
		});

		const report = await planningExecutor.execute({ lease: lease(), context: "context" });
		const verifierEvidence = report.evidence.find((item) => item.toolName === "verify_flag");

		expect(verifierEvidence?.metadata).toMatchObject({
			candidateHash: planningFlagCandidateHash(candidate),
			verifierStatus: "incorrect",
			verificationOutcome: "incorrect",
		});
		expect(JSON.stringify(verifierEvidence?.metadata)).not.toContain(candidate);
	});

	it("records a tool start without a fabricated end when the local worker times out", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const { executor: planningExecutor } = executor(events, vi.fn(), 10);
		mockedRunPiCodingTask.mockImplementationOnce(async (options: Parameters<typeof runPiCodingTask>[0]) => {
			options.onLifecycleEvent?.("assistant_message_end", { stopReason: "toolUse" });
			options.onLifecycleEvent?.("tool_execution_start", { toolCallId: "hanging-call", toolName: "run_linux_elf" });
			await new Promise((resolve) => setTimeout(resolve, 30));
			throw options.signal?.reason ?? new Error("worker timeout");
		});

		await expect(planningExecutor.execute({ lease: lease(), context: "context" })).rejects.toMatchObject({
			code: "executor_timeout",
		});
		const start = events.find((event) => event.type === "executor_tool_execution_start");
		expect(start?.payload).toMatchObject({ toolCallId: "hanging-call", toolName: "run_linux_elf" });
		expect(events.some((event) => event.type === "executor_tool_execution_end")).toBe(false);
		expect(events.find((event) => event.type === "executor_failure_progress")?.payload).toMatchObject({
			completedToolEvidenceCount: 0,
			inFlightToolCount: 1,
			inFlightToolNames: ["run_linux_elf"],
		});
		expect(events.find((event) => event.type === "executor_error")?.payload).toMatchObject({
			phase: "coding_task",
			executorPhase: "coding_task",
			failureSource: "planning",
			failureStage: "executor",
			failureCode: "executor_timeout",
		});
	});

	it("distinguishes a toolUse response with no dispatched tool start", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const { executor: planningExecutor } = executor(events, vi.fn(), 10);
		mockedRunPiCodingTask.mockImplementationOnce(async (options: Parameters<typeof runPiCodingTask>[0]) => {
			options.onLifecycleEvent?.("assistant_message_end", { stopReason: "toolUse" });
			await new Promise((resolve) => setTimeout(resolve, 30));
			throw options.signal?.reason ?? new Error("worker timeout");
		});

		await expect(planningExecutor.execute({ lease: lease(), context: "context" })).rejects.toMatchObject({
			code: "executor_timeout",
		});
		expect(events.some((event) => event.type === "executor_tool_execution_start")).toBe(false);
		expect(events.some((event) => event.type === "executor_tool_execution_end")).toBe(false);
	});

	it("keeps a parent-cancelled tool start without fabricating an end", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const controller = new AbortController();
		const { executor: planningExecutor } = executor(events, vi.fn(), 1_000);
		mockedRunPiCodingTask.mockImplementationOnce(async (options: Parameters<typeof runPiCodingTask>[0]) => {
			options.onLifecycleEvent?.("tool_execution_start", {
				toolCallId: "cancelled-call",
				toolName: "run_linux_elf",
			});
			controller.abort(new Error("parent cancelled"));
			await new Promise((resolve) => setTimeout(resolve, 10));
			throw options.signal?.reason ?? new Error("parent cancelled");
		});

		await expect(
			planningExecutor.execute({ lease: lease(), context: "context", signal: controller.signal }),
		).rejects.toThrow("parent cancelled");
		expect(events.find((event) => event.type === "executor_cancelled")?.payload).toMatchObject({
			phase: "coding_task",
			executorPhase: "coding_task",
			failureSource: "unknown",
			failureStage: "unknown",
			failureCode: "unclassified",
		});
		expect(events.find((event) => event.type === "executor_cancelled")?.payload.failureCode).not.toBe(
			"executor_timeout",
		);
		expect(events.find((event) => event.type === "executor_tool_execution_start")?.payload).toMatchObject({
			toolCallId: "cancelled-call",
			toolName: "run_linux_elf",
		});
		expect(events.some((event) => event.type === "executor_tool_execution_end")).toBe(false);
		expect(events.some((event) => event.type === "planning_commit_observed")).toBe(false);
	});

	it("records a missing commit as executor error after closing the bundle", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const { executor: planningExecutor } = executor(events);
		mockedRunPiCodingTask.mockImplementationOnce(async (options: Parameters<typeof runPiCodingTask>[0]) => {
			options.onLifecycleEvent?.("prompt_end");
			return { messages: [], finalText: "no commit", toolExecutions: [] };
		});

		await expect(planningExecutor.execute({ lease: lease(), context: "context" })).rejects.toMatchObject({
			code: "executor_error",
		});
		expect(events.map((event) => event.type)).toEqual([
			"executor_start",
			"extension_bundle_create_start",
			"extension_bundle_create_end",
			"prompt_end",
			"executor_failure_progress",
			"executor_error",
			"extension_bundle_close_start",
			"extension_bundle_close_end",
		]);
		expect(events.find((event) => event.type === "executor_error")?.payload.error).toContain(
			"did not submit planning_commit_result",
		);
		expect(events.find((event) => event.type === "executor_error")?.payload).toMatchObject({
			phase: "commit_validation",
			executorPhase: "commit_validation",
			failureSource: "planning",
			failureStage: "executor",
			failureCode: "executor_error",
		});
		expect(events.some((event) => event.type === "executor_end")).toBe(false);
	});

	it("classifies an ordinary provider error without inferring a code from its message", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const { executor: planningExecutor } = executor(events);
		mockedRunPiCodingTask.mockRejectedValueOnce(new Error("provider timeout response"));

		await expect(planningExecutor.execute({ lease: lease(), context: "context" })).rejects.toMatchObject({
			code: "executor_error",
		});
		expect(events.find((event) => event.type === "executor_error")?.payload).toMatchObject({
			phase: "coding_task",
			executorPhase: "coding_task",
			failureSource: "planning",
			failureStage: "executor",
			failureCode: "executor_error",
		});
		expect(events.find((event) => event.type === "executor_error")?.payload.failureCode).not.toBe("executor_timeout");
	});

	it("keeps a confirmed verifier quota failure when the child deadline also expires", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const { executor: planningExecutor } = executor(events, vi.fn(), 5);
		mockedRunPiCodingTask.mockImplementationOnce(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			throw new VerifierInfrastructureError({ toolName: "verify_flag", failureCategory: "quota_exhausted" });
		});

		await expect(planningExecutor.execute({ lease: lease(), context: "context" })).rejects.toMatchObject({
			code: "verifier_quota_exhausted",
		});
		expect(mockedRunPiCodingTask).toHaveBeenCalledOnce();
		expect(events.find((event) => event.type === "executor_error")?.payload).toMatchObject({
			failureCode: "verifier_quota_exhausted",
			timeoutObserved: true,
		});
	});

	it("prioritizes confirmed verifier quota over a simultaneous evidence-store fault", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const { executor: planningExecutor } = executor(events);
		const persistenceFailure = new PlanningPersistenceError("evidence write failed");
		mockedRunPiCodingTask.mockImplementationOnce(async (options: Parameters<typeof runPiCodingTask>[0]) => {
			try {
				options.onToolExecution?.({
					toolCallId: "verifier-call",
					toolName: "verify_flag",
					result: {
						details: { data: { verificationOutcome: "infra_error", failureCategory: "quota_exhausted" } },
					},
					isError: true,
				});
			} catch {
				// The real Pi adapter retains the structured Verifier observation even
				// when its evidence observer simultaneously fails.
			}
			throw new VerifierInfrastructureError({ toolName: "verify_flag", failureCategory: "quota_exhausted" });
		});
		await expect(
			planningExecutor.execute({
				lease: lease(),
				context: "context",
				recordEvidence: () => {
					throw persistenceFailure;
				},
			}),
		).rejects.toMatchObject({ code: "verifier_quota_exhausted" });
		expect(events.find((event) => event.type === "executor_error")?.payload).toMatchObject({
			failureCode: "verifier_quota_exhausted",
			secondaryFailureCodes: ["planning_persistence_error"],
		});
	});

	it("keeps a confirmed PlanningStore failure when the child deadline also expires", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const persistenceFailure = new Error("checkpoint database unavailable");
		mockedCreatePlanningCommitExtension.mockImplementationOnce(() => ({
			extension: {},
			getResult: () => undefined,
			getCheckpointFailure: () => persistenceFailure,
		}));
		const { executor: planningExecutor } = executor(events, vi.fn(), 5);
		mockedRunPiCodingTask.mockImplementationOnce(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			throw new Error("child deadline reached");
		});

		await expect(planningExecutor.execute({ lease: lease(), context: "context" })).rejects.toMatchObject({
			code: "planning_persistence_error",
		});
		expect(mockedRunPiCodingTask).toHaveBeenCalledOnce();
		expect(events.find((event) => event.type === "executor_error")?.payload).toMatchObject({
			failureCode: "planning_persistence_error",
			timeoutObserved: true,
		});
	});

	it("keeps an evidence persistence failure when it races the child deadline", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const { executor: planningExecutor } = executor(events, vi.fn(), 5);
		const persistenceFailure = new PlanningPersistenceError("evidence database unavailable");
		mockedRunPiCodingTask.mockImplementationOnce(async (options: Parameters<typeof runPiCodingTask>[0]) => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			options.onToolExecution?.({
				toolCallId: "evidence-race",
				toolName: "bash",
				result: { stdout: "completed before durable write" },
				isError: false,
			});
		});

		await expect(
			planningExecutor.execute({
				lease: lease(),
				context: "context",
				recordEvidence: () => {
					throw persistenceFailure;
				},
			}),
		).rejects.toMatchObject({ code: "planning_persistence_error" });
		expect(events.find((event) => event.type === "executor_error")?.payload).toMatchObject({
			failureCode: "planning_persistence_error",
			timeoutObserved: true,
		});
	});

	it("records a failed commit observation without treating it as accepted", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const { executor: planningExecutor } = executor(events);
		mockedRunPiCodingTask.mockImplementationOnce(async (options: Parameters<typeof runPiCodingTask>[0]) => {
			options.onToolExecution?.({
				toolCallId: "commit-call-error",
				toolName: "planning_commit_result",
				result: { error: "invalid" },
				isError: true,
			});
			return { messages: [], finalText: "", toolExecutions: [] };
		});

		await expect(planningExecutor.execute({ lease: lease(), context: "context" })).rejects.toMatchObject({
			code: "executor_error",
		});
		expect(events.find((event) => event.type === "planning_commit_observed")?.payload).toMatchObject({
			isError: true,
			accepted: false,
		});
	});

	it("reports bundle close failure as executor error", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const close = vi.fn(() => {
			throw new Error("bundle close failed");
		});
		const { executor: planningExecutor } = executor(events, close);
		committedResult = result();
		mockedRunPiCodingTask.mockResolvedValueOnce({ messages: [], finalText: "", toolExecutions: [] });

		await expect(planningExecutor.execute({ lease: lease(), context: "context" })).rejects.toThrow(
			"bundle close failed",
		);
		expect(events.map((event) => event.type)).toContain("extension_bundle_close_start");
		expect(events.map((event) => event.type)).toContain("extension_bundle_close_end");
		expect(events.filter((event) => event.type === "executor_error").at(-1)?.payload).toMatchObject({
			phase: "extension_bundle_close",
			executorPhase: "extension_bundle_close",
			failureSource: "planning",
			failureStage: "executor",
			failureCode: "executor_error",
			error: "bundle close failed",
		});
		expect(events.some((event) => event.type === "executor_end")).toBe(false);
	});

	it("keeps the local worker timeout when no parent signal is provided", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const { executor: planningExecutor } = executor(events, vi.fn(), 10);
		let workerSignal: AbortSignal | undefined;
		mockedRunPiCodingTask.mockImplementationOnce(async (options: Parameters<typeof runPiCodingTask>[0]) => {
			workerSignal = options.signal;
			await new Promise((resolve) => setTimeout(resolve, 30));
			if (!workerSignal?.aborted) throw new Error("local timeout was not propagated");
			throw workerSignal.reason;
		});

		await expect(planningExecutor.execute({ lease: lease(), context: "context" })).rejects.toBeDefined();
		expect(workerSignal).toBeDefined();
		expect(workerSignal?.aborted).toBe(true);
		expect(events.map((event) => event.type)).toContain("extension_bundle_close_end");
	});
});
