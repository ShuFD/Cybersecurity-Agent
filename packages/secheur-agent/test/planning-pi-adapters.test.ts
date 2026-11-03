import { beforeEach, describe, expect, it, vi } from "vitest";
import { compilePlanningProposal } from "../src/planning/compiler.ts";
import {
	PLANNING_SCHEMA_VERSION,
	type PlanningPlanProposal,
	type PlanningSnapshot,
	stablePlanningTaskId,
} from "../src/planning/contracts.ts";
import { MAX_CORRECTION_OUTPUT_CHARS, PiPlanningExecutor, PiPlanningSupervisor } from "../src/planning/pi-adapters.ts";
import { runPiCodingTask } from "../src/subagent.ts";

const modelAndExecutor = vi.hoisted(() => vi.fn());
vi.mock("../src/subagent.ts", () => ({ runPiCodingTask: modelAndExecutor }));
vi.mock("../src/planning/proposal-model.ts", () => ({ generatePlanningProposal: modelAndExecutor }));

const mockedRunPiCodingTask = vi.mocked(runPiCodingTask);

function planningSnapshot(withExistingTask = true): PlanningSnapshot {
	const now = 1_789_000_000;
	return {
		run: {
			runId: "run-dependency-contract",
			outerTaskId: "outer",
			goal: "solve challenge",
			mode: "active",
			status: "running",
			revision: 4,
			createdAt: now,
			updatedAt: now,
		},
		tasks: withExistingTask
			? [
					{
						taskId: "plan_123",
						runId: "run-dependency-contract",
						objective: "inspect the target",
						doneWhen: "inspection evidence is persisted",
						status: "done",
						priority: 1,
						sequence: 0,
						dependsOnTaskIds: [],
						createdAt: now,
						updatedAt: now,
					},
				]
			: [],
		evidence: [],
		executionFrame: {
			runId: "run-dependency-contract",
			revision: 4,
			updatedAt: now,
			frame: {
				schemaVersion: PLANNING_SCHEMA_VERSION,
				taskSummaries: [],
				facts: [],
				rejectedDirections: [],
				openQuestions: [],
				artifacts: [],
			},
		},
	};
}

function proposal(dependsOn: string[], key = "verify"): PlanningPlanProposal {
	return {
		schemaVersion: PLANNING_SCHEMA_VERSION,
		expectedRevision: 4,
		decision: "create_tasks",
		rationale: "next step",
		tasks: [
			{
				key,
				objective: "verify the finding",
				doneWhen: "the finding is verified",
				priority: 1,
				dependsOn,
			},
		],
		answerEvidenceRefs: [],
	};
}

function supervisor(
	onLifecycleEvent?: (type: string, payload: Record<string, unknown>) => void,
	taskGranularityPromptEnabled = false,
	multi = false,
): PiPlanningSupervisor {
	return new PiPlanningSupervisor({
		config: {
			executionMode: { mode: multi ? "plan_multi" : "plan_single" },
			planning: { maxEvidenceBytes: 32_768, taskGranularityPromptEnabled },
		} as never,
		cwd: "/work",
		onLifecycleEvent,
	});
}

function modelTextResult(finalText: string) {
	return { finalText, messages: [] } as never;
}

function modelResult(value: PlanningPlanProposal) {
	return modelTextResult(JSON.stringify(value));
}

function finishProposal(answerEvidenceRefs: string[]): PlanningPlanProposal {
	return {
		schemaVersion: PLANNING_SCHEMA_VERSION,
		expectedRevision: 4,
		decision: "finish_run",
		rationale: "the persisted evidence proves the answer",
		tasks: [],
		answerEvidenceRefs,
	};
}

describe("Pi planning supervisor dependency contract", () => {
	beforeEach(() => {
		mockedRunPiCodingTask.mockReset();
	});

	it("accepts a multi-task proposal with same-proposal dependencies without contradictory prompt guidance", async () => {
		const snapshot = planningSnapshot(false);
		const value = proposal([], "inspect");
		value.tasks.push({
			key: "reproduce",
			objective: "reproduce the observation",
			doneWhen: "reproduction recorded",
			dependsOn: ["inspect"],
		});
		mockedRunPiCodingTask.mockResolvedValueOnce(modelResult(value));
		const accepted = await supervisor(undefined, false, true).propose({ snapshot });
		expect(accepted.tasks).toHaveLength(2);
		expect(mockedRunPiCodingTask).toHaveBeenCalledTimes(1);
		expect(mockedRunPiCodingTask.mock.calls[0]?.[0].task).toContain("or a key in this same proposal");
		expect(mockedRunPiCodingTask.mock.calls[0]?.[0].task).not.toContain("dependsOn may only reference a taskId");
		const compiled = compilePlanningProposal(snapshot.run.runId, accepted, [], 48);
		expect(compiled[1].dependsOnTaskIds).toEqual([compiled[0].taskId]);
	});

	it("retries once with allowed persisted task ids and compiles the correction", async () => {
		const snapshot = planningSnapshot();
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		mockedRunPiCodingTask
			.mockResolvedValueOnce(modelResult(proposal(["inspect"])))
			.mockResolvedValueOnce(modelResult(proposal(["plan_123"])));

		const corrected = await supervisor((type, payload) => events.push({ type, payload })).propose({ snapshot });

		expect(mockedRunPiCodingTask).toHaveBeenCalledTimes(2);
		expect(mockedRunPiCodingTask.mock.calls[0]?.[0].task).toContain('allowedDependencyTaskIds:\n[\n  "plan_123"\n]');
		expect(mockedRunPiCodingTask.mock.calls[0]?.[0].task).toContain("inputEvidenceRefs is optional");
		expect(mockedRunPiCodingTask.mock.calls[0]?.[0].task).toContain(
			"do not use toolCallId, taskId, contentRef, or artifact paths",
		);
		expect(mockedRunPiCodingTask.mock.calls[1]?.[0].task).toContain("unknown dependency: inspect");
		expect(mockedRunPiCodingTask.mock.calls[1]?.[0].task).toContain("inputEvidenceRefs is optional");
		expect(mockedRunPiCodingTask.mock.calls[1]?.[0].task).toContain("Allowed existing taskIds:\nplan_123");
		expect(corrected.tasks[0]?.objective).toBe("verify the finding");
		const compiled = compilePlanningProposal(snapshot.run.runId, corrected, snapshot.tasks, 8);
		expect(compiled[0]?.dependsOnTaskIds).toEqual(["plan_123"]);
		expect(events.map((event) => event.type)).toEqual([
			"supervisor_propose_start",
			"planning_context_rendered",
			"supervisor_attempt_start",
			"supervisor_attempt_end",
			"supervisor_parse_start",
			"supervisor_parse_end",
			"supervisor_dependency_validation_failed",
			"supervisor_attempt_start",
			"supervisor_attempt_end",
			"supervisor_parse_start",
			"supervisor_parse_end",
			"supervisor_propose_end",
		]);
		expect(events[0]?.payload).toMatchObject({ runId: snapshot.run.runId, revision: snapshot.run.revision });
		expect(events.find((event) => event.type === "supervisor_dependency_validation_failed")?.payload).toMatchObject({
			attempt: "primary",
			dependencyError: expect.stringContaining("unknown dependency: inspect"),
		});
		expect(
			events.find((event) => event.type === "supervisor_attempt_start" && event.payload.attempt === "correction")
				?.payload,
		).toMatchObject({ attempt: "correction" });
		expect(events.map((event) => event.payload.elapsedMs as number)).toEqual(
			[...events.map((event) => event.payload.elapsedMs as number)].sort((left, right) => left - right),
		);
	});

	it("returns a valid proposal without recovery", async () => {
		const snapshot = planningSnapshot();
		mockedRunPiCodingTask.mockResolvedValueOnce(modelResult(proposal(["plan_123"])));

		const valid = await supervisor().propose({ snapshot });

		expect(mockedRunPiCodingTask).toHaveBeenCalledTimes(1);
		expect(valid.tasks[0]?.dependsOn).toEqual(["plan_123"]);
		expect(() => compilePlanningProposal(snapshot.run.runId, valid, snapshot.tasks, 8)).not.toThrow();
	});

	it("adds only task granularity guidance when enabled and preserves the proposal contract", async () => {
		const snapshot = planningSnapshot();
		const expectedProposal = proposal(["plan_123"]);
		mockedRunPiCodingTask
			.mockResolvedValueOnce(modelResult(expectedProposal))
			.mockResolvedValueOnce(modelResult(expectedProposal));

		const offProposal = await supervisor().propose({ snapshot });
		const offPrompt = mockedRunPiCodingTask.mock.calls[0]?.[0].task;
		const enabledProposal = await supervisor(undefined, true).propose({ snapshot });
		const enabledPrompt = mockedRunPiCodingTask.mock.calls[1]?.[0].task;
		const guidance = [
			"Task granularity guidance: frame one task as a question or key unknown, the decision-changing observation or artifact to hand back, and what may remain unknown. It is not one tool call and need not solve the whole challenge.",
			"Too small: run one script or read one file without saying what question it answers. Suitable: determine whether a nonce is reused; hand back the reproduction input, raw observation/evidence IDs, and cases still not excluded. Too large: reverse engineer the whole binary, build an exploit, submit a Flag, and verify the entire challenge in one task.",
			"Describe doneWhen as the expected observation or artifact, and allow an honest disproved hypothesis or unresolved result. Let the Executor choose its tools and path; one new evidence item alone does not require a new task. Consider a new task when evidence materially changes direction, the current hypothesis is rejected, a new prerequisite appears, or the attempt ends. This is guidance only, with no tool-call or fixed-minute requirement.",
		].join("\n\n");

		expect(offPrompt).not.toContain("Task granularity guidance:");
		expect(enabledPrompt?.replace(`${guidance}\n\n`, "")).toBe(offPrompt);
		expect(offProposal).toEqual(expectedProposal);
		expect(enabledProposal).toEqual(expectedProposal);
		expect(() => compilePlanningProposal(snapshot.run.runId, enabledProposal, snapshot.tasks, 8)).not.toThrow();
		expect(mockedRunPiCodingTask).toHaveBeenCalledTimes(2);
	});

	it("parses and validates a Supervisor-provided current-run input evidence reference", async () => {
		const snapshot = planningSnapshot();
		snapshot.evidence.push({
			evidenceId: "evidence-from-prior-attempt",
			runId: snapshot.run.runId,
			taskId: "plan_123",
			leaseId: "lease-prior-attempt",
			kind: "tool",
			source: "mock-tool",
			summary: "durable prior result",
			excerpt: "bounded prior result",
			contentRef: null,
			contentHash: "prior-result-hash",
			locator: {},
			contentBytes: 19,
			contentComplete: true,
			isTruncated: false,
			metadata: {},
			createdAt: 1_789_000_001,
		});
		const value = proposal(["plan_123"], "continue-from-evidence");
		value.tasks[0]!.inputEvidenceRefs = ["evidence-from-prior-attempt"];
		mockedRunPiCodingTask.mockResolvedValueOnce(modelResult(value));

		const parsed = await supervisor().propose({ snapshot });
		const compiled = compilePlanningProposal(snapshot.run.runId, parsed, snapshot.tasks, 8);

		expect(parsed.tasks[0]?.inputEvidenceRefs).toEqual(["evidence-from-prior-attempt"]);
		expect(compiled[0]?.inputEvidenceRefs).toEqual(["evidence-from-prior-attempt"]);
		expect(mockedRunPiCodingTask.mock.calls[0]?.[0].task).toContain("evidence-from-prior-attempt");
		expect(mockedRunPiCodingTask.mock.calls[0]?.[0].task).toContain("complete persisted evidenceId values");
		expect(mockedRunPiCodingTask).toHaveBeenCalledTimes(1);
	});

	it("uses validation correction when finish_run omits persisted answer evidence", async () => {
		const snapshot = planningSnapshot();
		snapshot.evidence.push({
			evidenceId: "evidence-current-run",
			runId: snapshot.run.runId,
			taskId: "plan_123",
			leaseId: "lease_123",
			kind: "observation",
			source: "planning-task-result",
			summary: "answer evidence",
			excerpt: "answer evidence",
			contentRef: null,
			contentHash: "hash",
			locator: {},
			contentBytes: 15,
			contentComplete: true,
			isTruncated: false,
			metadata: {},
			createdAt: 1_789_000_001,
		});
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		mockedRunPiCodingTask
			.mockResolvedValueOnce(modelResult(finishProposal([])))
			.mockResolvedValueOnce(modelResult(finishProposal(["evidence-current-run"])));

		const corrected = await supervisor((type, payload) => events.push({ type, payload })).propose({ snapshot });

		expect(corrected.answerEvidenceRefs).toEqual(["evidence-current-run"]);
		expect(mockedRunPiCodingTask).toHaveBeenCalledTimes(2);
		expect(mockedRunPiCodingTask.mock.calls[1]?.[0].task).toContain(
			"cannot finish the run without persisted answer evidence",
		);
		expect(events.some((event) => event.payload.attemptType === "validation_correction")).toBe(true);
	});

	it("shows task-to-evidence IDs when finish_run incorrectly cites a task ID", async () => {
		const snapshot = planningSnapshot();
		snapshot.evidence.push({
			evidenceId: "tool-actual-proof",
			runId: snapshot.run.runId,
			taskId: "plan_123",
			leaseId: "lease_123",
			kind: "observation",
			source: "planning-task-result",
			summary: "grounded result",
			excerpt: "grounded result",
			contentRef: null,
			contentHash: "hash",
			locator: {},
			contentBytes: 15,
			contentComplete: true,
			isTruncated: false,
			metadata: {},
			createdAt: 1_789_000_001,
		});
		mockedRunPiCodingTask
			.mockResolvedValueOnce(modelResult(finishProposal(["plan_123"])))
			.mockResolvedValueOnce(modelResult(finishProposal(["tool-actual-proof"])));
		const corrected = await supervisor().propose({ snapshot });
		expect(corrected.answerEvidenceRefs).toEqual(["tool-actual-proof"]);
		expect(mockedRunPiCodingTask).toHaveBeenCalledTimes(2);
		const prompt = mockedRunPiCodingTask.mock.calls[1]?.[0].task;
		expect(prompt).toContain("plan_123 -> tool-actual-proof");
		expect(prompt).toContain("A taskId does not itself prove completion");
	});

	it("rejects cross-run evidence after two corrections without allowing a fourth Supervisor call", async () => {
		const snapshot = planningSnapshot();
		mockedRunPiCodingTask
			.mockResolvedValueOnce(modelResult(finishProposal(["evidence-from-another-run"])))
			.mockResolvedValue(modelResult(finishProposal(["still-unknown"])));

		await expect(supervisor().propose({ snapshot })).rejects.toMatchObject({
			stage: "proposal_validation",
			code: "proposal_validation_error",
			message: expect.stringContaining("unknown evidence: still-unknown"),
		});
		expect(mockedRunPiCodingTask).toHaveBeenCalledTimes(3);
	});

	it("corrects malformed JSON and then a failed dependency within the same two-correction budget", async () => {
		const snapshot = planningSnapshot();
		snapshot.tasks[0]!.status = "failed";
		mockedRunPiCodingTask
			.mockResolvedValueOnce(modelTextResult("not-json"))
			.mockResolvedValueOnce(modelResult(proposal(["plan_123"])))
			.mockResolvedValueOnce(modelResult(proposal([])));
		const corrected = await supervisor().propose({ snapshot });
		expect(corrected.tasks[0]?.dependsOn).toEqual([]);
		expect(mockedRunPiCodingTask).toHaveBeenCalledTimes(3);
		expect(mockedRunPiCodingTask.mock.calls[2]?.[0].task).toContain("unrunnable dependency");
	});

	it("accepts fenced JSON without a format correction", async () => {
		const snapshot = planningSnapshot();
		mockedRunPiCodingTask.mockResolvedValueOnce(
			modelTextResult(`\`\`\`json\n${JSON.stringify(proposal(["plan_123"]))}\n\`\`\``),
		);

		const valid = await supervisor().propose({ snapshot });

		expect(mockedRunPiCodingTask).toHaveBeenCalledTimes(1);
		expect(valid.tasks[0]?.dependsOn).toEqual(["plan_123"]);
	});

	it("uses validation correction for valid JSON with an empty doneWhen", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		mockedRunPiCodingTask
			.mockResolvedValueOnce(
				modelTextResult(
					JSON.stringify({
						decision: "create_tasks",
						tasks: [{ key: "verify", objective: "verify the finding", doneWhen: "", priority: 1, dependsOn: [] }],
					}),
				),
			)
			.mockResolvedValueOnce(modelResult(proposal([])));

		const corrected = await supervisor((type, payload) => events.push({ type, payload })).propose({
			snapshot: planningSnapshot(false),
		});

		expect(corrected.tasks[0]?.doneWhen).toBe("the finding is verified");
		expect(mockedRunPiCodingTask).toHaveBeenCalledTimes(2);
		expect(events.some((event) => event.payload.attemptType === "format_correction")).toBe(false);
		expect(events.some((event) => event.payload.attemptType === "validation_correction")).toBe(true);
		expect(events.find((event) => event.type === "supervisor_parse_end")?.payload).toMatchObject({
			parseSucceeded: true,
			validationSucceeded: false,
		});
	});

	it("uses validation correction for valid JSON with an empty objective", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		mockedRunPiCodingTask
			.mockResolvedValueOnce(
				modelTextResult(
					JSON.stringify({
						decision: "create_tasks",
						tasks: [{ key: "verify", objective: "", doneWhen: "the finding is verified" }],
					}),
				),
			)
			.mockResolvedValueOnce(modelResult(proposal([])));

		const corrected = await supervisor((type, payload) => events.push({ type, payload })).propose({
			snapshot: planningSnapshot(false),
		});

		expect(corrected.tasks[0]?.objective).toBe("verify the finding");
		expect(mockedRunPiCodingTask).toHaveBeenCalledTimes(2);
		expect(events.some((event) => event.payload.attemptType === "format_correction")).toBe(false);
		expect(events.some((event) => event.payload.attemptType === "validation_correction")).toBe(true);
		expect(events.find((event) => event.type === "supervisor_parse_end")?.payload).toMatchObject({
			parseSucceeded: true,
			validationSucceeded: false,
		});
	});

	it("uses validation correction for a non-array tasks field", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		mockedRunPiCodingTask
			.mockResolvedValueOnce(modelTextResult(JSON.stringify({ decision: "create_tasks", tasks: "bad" })))
			.mockResolvedValueOnce(modelResult(proposal([])));

		const corrected = await supervisor((type, payload) => events.push({ type, payload })).propose({
			snapshot: planningSnapshot(false),
		});

		expect(corrected.tasks[0]?.key).toBe("verify");
		expect(mockedRunPiCodingTask).toHaveBeenCalledTimes(2);
		expect(events.some((event) => event.payload.attemptType === "format_correction")).toBe(false);
		expect(events.some((event) => event.payload.attemptType === "validation_correction")).toBe(true);
	});

	it("stops local corrections after the third call when validation correction remains schema-invalid", async () => {
		mockedRunPiCodingTask
			.mockResolvedValueOnce(
				modelTextResult(
					JSON.stringify({
						decision: "create_tasks",
						tasks: [{ key: "verify", objective: "verify the finding", doneWhen: "" }],
					}),
				),
			)
			.mockResolvedValue(
				modelTextResult(
					JSON.stringify({
						decision: "create_tasks",
						tasks: [{ key: "verify", objective: "verify the finding", doneWhen: "" }],
					}),
				),
			);

		await expect(supervisor().propose({ snapshot: planningSnapshot(false) })).rejects.toMatchObject({
			stage: "proposal_validation",
			code: "proposal_validation_error",
		});
		expect(mockedRunPiCodingTask).toHaveBeenCalledTimes(3);
	});

	it("stops local corrections after the third call when format correction produces schema-invalid JSON", async () => {
		mockedRunPiCodingTask.mockResolvedValueOnce(modelTextResult("not-json")).mockResolvedValue(
			modelTextResult(
				JSON.stringify({
					decision: "create_tasks",
					tasks: [{ key: "verify", objective: "verify the finding", doneWhen: "" }],
				}),
			),
		);

		await expect(supervisor().propose({ snapshot: planningSnapshot(false) })).rejects.toMatchObject({
			stage: "proposal_validation",
			code: "proposal_validation_error",
		});
		expect(mockedRunPiCodingTask).toHaveBeenCalledTimes(3);
	});

	it("preserves a correction provider failure without retrying", async () => {
		mockedRunPiCodingTask
			.mockResolvedValueOnce(
				modelTextResult(
					JSON.stringify({
						decision: "create_tasks",
						tasks: [{ key: "verify", objective: "verify the finding", doneWhen: "" }],
					}),
				),
			)
			.mockRejectedValueOnce(new Error("correction provider timeout"));

		await expect(supervisor().propose({ snapshot: planningSnapshot(false) })).rejects.toMatchObject({
			stage: "supervisor",
			code: "planning_internal_error",
			message: "correction provider timeout",
		});
		expect(mockedRunPiCodingTask).toHaveBeenCalledTimes(2);
	});

	it("uses one bounded format correction when the primary output is malformed", async () => {
		const snapshot = planningSnapshot(false);
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		mockedRunPiCodingTask
			.mockResolvedValueOnce(modelTextResult("Here is the plan: not JSON"))
			.mockResolvedValueOnce(modelResult(proposal([])));

		const corrected = await supervisor((type, payload) => events.push({ type, payload })).propose({ snapshot });

		expect(mockedRunPiCodingTask).toHaveBeenCalledTimes(2);
		expect(corrected.tasks[0]?.key).toBe("verify");
		expect(mockedRunPiCodingTask.mock.calls[1]?.[0].task).toContain(
			"The previous response was not a valid Planning proposal.",
		);
		expect(mockedRunPiCodingTask.mock.calls[1]?.[0].task).toContain("allowedDependencyTaskIds:\n[]");
		expect(
			events.find(
				(event) => event.type === "supervisor_attempt_start" && event.payload.attemptType === "format_correction",
			)?.payload,
		).toMatchObject({
			attempt: "correction",
			originalOutputChars: 26,
			correctionInputChars: 26,
			truncated: false,
		});
		expect(
			events.filter((event) => event.type === "supervisor_parse_end").map((event) => event.payload.parseSucceeded),
		).toEqual([false, true]);
	});

	it("reports the corrected validation error after two bounded corrections", async () => {
		const snapshot = planningSnapshot();
		mockedRunPiCodingTask
			.mockResolvedValueOnce(modelTextResult("not-json"))
			.mockResolvedValue(modelResult(proposal(["missing-dependency"])));

		await expect(supervisor().propose({ snapshot })).rejects.toMatchObject({
			name: "PlanningFailureError",
			stage: "supervisor_validation",
			code: "supervisor_validation_error",
			message: expect.stringContaining("unknown dependency: missing-dependency"),
		});
		expect(mockedRunPiCodingTask).toHaveBeenCalledTimes(3);
	});

	it("bounds the malformed output copied into a format correction", async () => {
		const snapshot = planningSnapshot(false);
		const oversized = "x".repeat(MAX_CORRECTION_OUTPUT_CHARS + 10);
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		mockedRunPiCodingTask
			.mockResolvedValueOnce(modelTextResult(oversized))
			.mockResolvedValueOnce(modelResult(proposal([])));

		await supervisor((type, payload) => events.push({ type, payload })).propose({ snapshot });

		expect(
			events.find(
				(event) => event.type === "supervisor_attempt_start" && event.payload.attemptType === "format_correction",
			)?.payload,
		).toMatchObject({
			originalOutputChars: MAX_CORRECTION_OUTPUT_CHARS + 10,
			correctionInputChars: MAX_CORRECTION_OUTPUT_CHARS,
			truncated: true,
		});
		expect(mockedRunPiCodingTask.mock.calls[1]?.[0].task).toContain(
			`Previous malformed output (bounded; ${MAX_CORRECTION_OUTPUT_CHARS}/${MAX_CORRECTION_OUTPUT_CHARS + 10} characters):`,
		);
	});

	it("keeps a length-truncated late proposal out of the correction prompt", async () => {
		const snapshot = planningSnapshot(false);
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		mockedRunPiCodingTask
			.mockResolvedValueOnce({
				finalText: "analysis ".repeat(6_000),
				messages: [{ role: "assistant", stopReason: "length" }],
			} as never)
			.mockResolvedValueOnce(modelResult(proposal([])));

		const corrected = await supervisor((type, payload) => events.push({ type, payload })).propose({ snapshot });

		expect(corrected.decision).toBe("create_tasks");
		expect(events.find((event) => event.type === "supervisor_parse_end")?.payload).toMatchObject({
			stopReason: "length",
			parseSucceeded: false,
		});
		expect(mockedRunPiCodingTask.mock.calls[0]?.[0].task).toContain("Do not output drafts or analysis.");
		const correctionTask = mockedRunPiCodingTask.mock.calls[1]?.[0].task ?? "";
		expect(correctionTask).toContain(
			`Previous malformed output (bounded; ${MAX_CORRECTION_OUTPUT_CHARS}/54000 characters):`,
		);
		expect(correctionTask.length).toBeLessThan(12_000);
	});

	it("traces a normal primary proposal without a correction attempt", async () => {
		const snapshot = planningSnapshot();
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		mockedRunPiCodingTask.mockResolvedValueOnce(modelResult(proposal(["plan_123"])));

		await supervisor((type, payload) => events.push({ type, payload })).propose({ snapshot });

		expect(events.map((event) => event.type)).toEqual([
			"supervisor_propose_start",
			"planning_context_rendered",
			"supervisor_attempt_start",
			"supervisor_attempt_end",
			"supervisor_parse_start",
			"supervisor_parse_end",
			"supervisor_propose_end",
		]);
		expect(events.find((event) => event.type === "planning_context_rendered")?.payload).toMatchObject({
			contextRole: "supervisor",
			contextBytes: expect.any(Number),
			contextLimitBytes: 32_768,
		});
		expect(events.find((event) => event.type === "supervisor_attempt_start")?.payload).toMatchObject({
			attempt: "primary",
		});
		expect(events.at(-1)?.payload).toMatchObject({ decision: "create_tasks", taskCount: 1 });
	});

	it("throws the correction dependency error when the correction is still invalid", async () => {
		const snapshot = planningSnapshot();
		mockedRunPiCodingTask
			.mockResolvedValueOnce(modelResult(proposal(["inspect"])))
			.mockResolvedValue(modelResult(proposal(["still-unknown"])));

		await expect(supervisor().propose({ snapshot })).rejects.toThrow(
			"unknown dependency: still-unknown\nallowed existing taskIds:\n- plan_123",
		);
		expect(mockedRunPiCodingTask).toHaveBeenCalledTimes(3);
	});

	it("reports the correction validation error instead of the primary identity error", async () => {
		const base = planningSnapshot();
		const snapshot: PlanningSnapshot = {
			...base,
			tasks: [{ ...base.tasks[0], taskId: stablePlanningTaskId(base.run.runId, "verify") }],
		};
		mockedRunPiCodingTask
			.mockResolvedValueOnce(modelResult(proposal([], "verify")))
			.mockResolvedValue(modelResult(proposal(["missing-dependency"], "verify-next")));

		await expect(supervisor().propose({ snapshot })).rejects.toMatchObject({
			name: "PlanningFailureError",
			source: "planning",
			stage: "supervisor_validation",
			code: "supervisor_validation_error",
			message: expect.stringContaining("unknown dependency: missing-dependency"),
		});
		expect(mockedRunPiCodingTask).toHaveBeenCalledTimes(3);
	});

	it("corrects a proposal that reuses a historical task key", async () => {
		const base = planningSnapshot();
		const snapshot: PlanningSnapshot = {
			...base,
			tasks: [
				{
					...base.tasks[0],
					taskId: stablePlanningTaskId(base.run.runId, "verify"),
				},
			],
		};
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		mockedRunPiCodingTask
			.mockResolvedValueOnce(modelResult(proposal([], "verify")))
			.mockResolvedValueOnce(modelResult(proposal([], "verify-next")));

		const corrected = await supervisor((type, payload) => events.push({ type, payload })).propose({ snapshot });

		expect(mockedRunPiCodingTask).toHaveBeenCalledTimes(2);
		expect(mockedRunPiCodingTask.mock.calls[1]?.[0].task).toContain("Choose a genuinely new next action/key");
		expect(corrected.tasks[0]?.key).toBe("verify-next");
		expect(() => compilePlanningProposal(snapshot.run.runId, corrected, snapshot.tasks, 8)).not.toThrow();
		expect(events.map((event) => event.type)).toContain("supervisor_task_identity_validation_failed");
	});

	it("rejects a correction that reuses the historical task key again", async () => {
		const base = planningSnapshot();
		const snapshot: PlanningSnapshot = {
			...base,
			tasks: [{ ...base.tasks[0], taskId: stablePlanningTaskId(base.run.runId, "verify") }],
		};
		mockedRunPiCodingTask
			.mockResolvedValueOnce(modelResult(proposal([], "verify")))
			.mockResolvedValue(modelResult(proposal([], "verify")));

		await expect(supervisor().propose({ snapshot })).rejects.toThrow("task key already exists in this run: verify");
		expect(mockedRunPiCodingTask).toHaveBeenCalledTimes(3);
	});

	it("records a supervisor error when the provider fails", async () => {
		const snapshot = planningSnapshot();
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		mockedRunPiCodingTask.mockRejectedValueOnce(new Error("provider unavailable"));

		await expect(supervisor((type, payload) => events.push({ type, payload })).propose({ snapshot })).rejects.toThrow(
			"provider unavailable",
		);
		expect(events.map((event) => event.type)).toEqual([
			"supervisor_propose_start",
			"planning_context_rendered",
			"supervisor_attempt_start",
			"supervisor_attempt_end",
			"supervisor_propose_error",
		]);
		expect(events.at(-1)?.payload).toMatchObject({
			phase: "primary",
			error: "provider unavailable",
			runId: snapshot.run.runId,
			revision: snapshot.run.revision,
		});
	});

	it("accepts an empty dependency list when no persisted task exists", async () => {
		const snapshot = planningSnapshot(false);
		mockedRunPiCodingTask.mockResolvedValueOnce(modelResult(proposal([])));

		const valid = await supervisor().propose({ snapshot });

		expect(mockedRunPiCodingTask).toHaveBeenCalledTimes(1);
		expect(valid.tasks[0]?.dependsOn).toEqual([]);
		expect(() => compilePlanningProposal(snapshot.run.runId, valid, snapshot.tasks, 8)).not.toThrow();
	});

	it("classifies malformed Supervisor output with a stable parse code", async () => {
		const snapshot = planningSnapshot(false);
		mockedRunPiCodingTask
			.mockResolvedValueOnce(modelTextResult("not-json"))
			.mockResolvedValue(modelTextResult("still not-json"));

		await expect(supervisor().propose({ snapshot })).rejects.toMatchObject({
			name: "PlanningFailureError",
			source: "planning",
			stage: "supervisor_parse",
			code: "supervisor_parse_error",
		});
		expect(mockedRunPiCodingTask).toHaveBeenCalledTimes(3);
	});

	it("preserves parent cancellation during format correction", async () => {
		const snapshot = planningSnapshot(false);
		const controller = new AbortController();
		let correctionStarted!: () => void;
		const correctionReady = new Promise<void>((resolve) => {
			correctionStarted = resolve;
		});
		mockedRunPiCodingTask.mockResolvedValueOnce(modelTextResult("not-json")).mockImplementationOnce(
			(options) =>
				new Promise((_, reject) => {
					correctionStarted();
					if (options.signal?.aborted) {
						reject(options.signal.reason ?? new Error("parent cancelled"));
						return;
					}
					options.signal?.addEventListener(
						"abort",
						() => reject(options.signal?.reason ?? new Error("parent cancelled")),
						{ once: true },
					);
				}),
		);

		const pending = supervisor().propose({ snapshot, signal: controller.signal });
		await correctionReady;
		controller.abort(new Error("parent cancelled"));

		await expect(pending).rejects.toMatchObject({ message: "parent cancelled" });
		expect(mockedRunPiCodingTask).toHaveBeenCalledTimes(2);
	});

	it("classifies a repeated task identity without relying on error text", async () => {
		const base = planningSnapshot();
		const snapshot: PlanningSnapshot = {
			...base,
			tasks: [{ ...base.tasks[0], taskId: stablePlanningTaskId(base.run.runId, "verify") }],
		};
		mockedRunPiCodingTask
			.mockResolvedValueOnce(modelResult(proposal([], "verify")))
			.mockResolvedValue(modelResult(proposal([], "verify")));

		await expect(supervisor().propose({ snapshot })).rejects.toMatchObject({
			name: "PlanningFailureError",
			code: "duplicate_task_identity",
			stage: "supervisor_validation",
		});
	});

	it("exports extension-input checkpoint rejection reason through the Pi lifecycle event", async () => {
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const registeredToolNames: string[] = [];
		mockedRunPiCodingTask.mockImplementationOnce(async (options) => {
			const extension = options.extensionFactories?.at(-1) as unknown as {
				factory: (pi: {
					registerTool: (tool: {
						name: string;
						execute: (toolCallId: string, params: unknown) => Promise<unknown>;
					}) => void;
				}) => void;
			};
			const tools: Array<{
				name: string;
				execute: (toolCallId: string, params: unknown) => Promise<unknown>;
			}> = [];
			extension.factory({
				registerTool: (tool) => {
					registeredToolNames.push(tool.name);
					tools.push(tool);
				},
			});
			await tools
				.find((tool) => tool.name === "planning_checkpoint")
				?.execute("bad-checkpoint", {
					summary: 42,
				});
			return modelResult(proposal([], "unused"));
		});
		const executor = new PiPlanningExecutor({
			config: { planning: { maxEvidenceBytes: 32_768 }, stateDir: "." } as never,
			cwd: "/work",
			onLifecycleEvent: (type, payload = {}) => events.push({ type, payload }),
		});
		const lease = {
			schemaVersion: 1,
			leaseId: "lease-checkpoint-diagnostic",
			runId: "run-checkpoint-diagnostic",
			taskId: "taREMOVED_CONFIGURE_VIA_ENVIRONMENT",
			planRevision: 1,
			objective: "save bounded progress",
			doneWhen: "checkpoint input is diagnosed",
			allowedScope: "/work",
			issuedAt: 1,
			expiresAt: 2,
		} as never;

		await expect(
			executor.execute({
				lease,
				context: "",
				recordCheckpoint: () => {
					throw new Error("invalid checkpoint must not reach durable storage");
				},
			}),
		).rejects.toBeDefined();
		expect(mockedRunPiCodingTask).toHaveBeenCalledOnce();
		expect(mockedRunPiCodingTask.mock.calls[0]?.[0].extensionFactories).toHaveLength(2);
		expect(registeredToolNames).toContain("planning_checkpoint");
		expect(events.map((event) => event.type)).toContain("planning_checkpoint_rejected");
		expect(events.find((event) => event.type === "planning_checkpoint_rejected")?.payload).toMatchObject({
			checkpointId: "checkpoint-lease-checkpoint-diagnostic-bad-checkpoint",
			failureCode: "planning_checkpoint_validation_error",
			diagnosticLayer: "extension_input",
			diagnosticReason: "checkpoint_summary_invalid",
			fieldName: "summary",
			scopeDecision: "not_checked",
		});
	});

	it("classifies a local Executor timeout separately from parent cancellation", async () => {
		mockedRunPiCodingTask.mockImplementationOnce(
			() => new Promise((resolve) => setTimeout(() => resolve({ finalText: "", messages: [] } as never), 30)),
		);
		const executor = new PiPlanningExecutor({
			config: { planning: { maxEvidenceBytes: 32_768 }, stateDir: "." } as never,
			cwd: "/work",
			taskTimeoutMs: 5,
		});
		const lease = {
			schemaVersion: 1,
			leaseId: "lease-timeout",
			runId: "run-timeout",
			taskId: "task-timeout",
			planRevision: 1,
			objective: "timeout",
			doneWhen: "done",
			allowedScope: "/work",
			issuedAt: 1,
			expiresAt: 2,
		} as never;

		await expect(executor.execute({ lease, context: "" })).rejects.toMatchObject({
			name: "PlanningFailureError",
			code: "executor_timeout",
			stage: "executor",
			source: "planning",
		});
	});
});
