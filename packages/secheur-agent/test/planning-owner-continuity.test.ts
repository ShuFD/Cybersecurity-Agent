import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compilePlanningProposal } from "../src/planning/compiler.ts";
import {
	HypothesisPlanningSupervisor,
	hypothesisPlannerView,
	parseHypothesisProposal,
} from "../src/planning/hypothesis-adapters.ts";
import { PiPlanningExecutor, PiPlanningSupervisor } from "../src/planning/pi-adapters.ts";
import { generatePlanningProposal } from "../src/planning/proposal-model.ts";
import { PlanningStore } from "../src/planning/store.ts";
import { runPiCodingTask } from "../src/subagent.ts";

vi.mock("../src/planning/proposal-model.ts", () => ({ generatePlanningProposal: vi.fn() }));
vi.mock("../src/subagent.ts", () => ({ runPiCodingTask: vi.fn() }));

const runId = "synthetic-owner-continuity";

async function storeFixture() {
	const store = await PlanningStore.open(":memory:");
	store.createRun({
		runId,
		outerTaskId: "fixture-outer",
		goal: "Produce and verify a synthetic result",
		mode: "active",
	});
	return store;
}

function proposal() {
	return {
		schemaVersion: 1,
		expectedRevision: 0,
		decision: "create_tasks",
		rationale: "Start solving while independent supporting work proceeds",
		newHypotheses: [],
		tasks: [
			{
				key: "owner",
				objective: "Produce the synthetic result and perform native goal verification",
				doneWhen: "The synthetic goal has native verification evidence",
				dependsOn: [],
				hypothesisIds: [],
				purpose: "gather_evidence",
			},
			{
				key: "auxiliary",
				objective: "Produce a reusable synthetic input and publish it before the final report",
				doneWhen: "The synthetic input and its limitations are recorded",
				dependsOn: [],
				hypothesisIds: [],
				purpose: "gather_evidence",
			},
		],
		answerEvidenceRefs: [],
	};
}

describe("planning owner continuity and partial delivery", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it.each([
		{ engine: "progressive", granularity: false },
		{ engine: "progressive", granularity: true },
		{ engine: "hypothesis", granularity: false },
	] as const)("restores flexible task division for $engine (granularity=$granularity)", async (mode) => {
		const store = await storeFixture();
		try {
			const snapshot = store.snapshot(runId, true);
			const options = {
				config: {
					executionMode: { mode: "plan_multi", capacity: 2 },
					planning: {
						engine: mode.engine,
						maxEvidenceBytes: 32_768,
						taskGranularityPromptEnabled: mode.granularity,
					},
				} as never,
				cwd: "/fixture",
			};
			vi.mocked(generatePlanningProposal).mockResolvedValueOnce({
				finalText: JSON.stringify(proposal()),
				messages: [],
			});
			const supervisor =
				mode.engine === "hypothesis"
					? new HypothesisPlanningSupervisor(options)
					: new PiPlanningSupervisor(options);
			const accepted = await supervisor.propose({ snapshot });
			const request = vi.mocked(generatePlanningProposal).mock.calls[0][0];
			expect(request.task).not.toContain("Keep one runnable end-to-end owner");
			expect(request.task).not.toContain("Any task granularity guidance below applies to auxiliary work");
			if (mode.engine === "hypothesis") {
				expect(request.task).toContain(
					"Keep end-to-end ownership of the critical path and use independent side work when useful",
				);
				expect(request.task).toContain(
					"Never wait for a full report if the necessary checkpoint artifact is available",
				);
				expect(request.nativeSession?.queryContext).toBe(false);
			} else {
				expect(request.task).toContain("check whether two distinct bounded investigations can start immediately");
				expect(request.nativeSession?.queryPolicy).toBe("board_only");
			}
			const compiled = compilePlanningProposal(runId, accepted, snapshot.tasks, 48);
			expect(compiled.map((task) => task.dependsOnTaskIds)).toEqual([[], []]);
			const planned = store.commitPlan({
				runId,
				expectedRevision: 0,
				rationale: accepted.rationale,
				idempotencyKey: "synthetic-initial",
				tasks: compiled,
				hypothesisUpdate: accepted.hypothesisUpdate,
			});
			expect(planned.tasks.map((task) => task.status)).toEqual(["ready", "ready"]);
			expect(planned.tasks[0].objective).toBe(proposal().tasks[0].objective);
		} finally {
			store.close();
		}
	});

	it.each(["progressive", "hypothesis"] as const)(
		"publishes a usable %s partial artifact while its producer and goal owner continue",
		async (engine) => {
			const root = mkdtempSync(join(tmpdir(), "planning-owner-continuity-"));
			const store = await storeFixture();
			try {
				store.commitPlan({
					runId,
					expectedRevision: 0,
					rationale: "Synthetic owner and auxiliary work",
					idempotencyKey: "synthetic-initial",
					tasks: ["owner", "auxiliary"].map((taskId, sequence) => ({
						taskId,
						objective: proposal().tasks[sequence].objective,
						doneWhen: proposal().tasks[sequence].doneWhen,
						priority: 0,
						sequence,
						dependsOnTaskIds: [],
					})),
				});
				const owner = store.leaseTask(runId, "owner", root, 300_000, Date.now(), 2);
				store.startLease(owner.leaseId);
				const auxiliary = store.leaseTask(runId, "auxiliary", root, 300_000, Date.now(), 2);
				store.startLease(auxiliary.leaseId);
				let artifactPath = "";
				vi.mocked(runPiCodingTask).mockImplementationOnce(async (request) => {
					expect(request.task).toContain(
						"publish it immediately with planning_checkpoint before preparing the final report",
					);
					expect(request.task).toContain("original evidenceRefs, completedItems and remainingItems");
					const tools = new Map<
						string,
						{ name: string; execute: (id: string, parameters: unknown) => Promise<unknown> }
					>();
					for (const extension of request.extensionFactories ?? []) {
						if (typeof extension === "function") continue;
						await extension.factory({
							registerTool: (tool: {
								name: string;
								execute: (id: string, parameters: unknown) => Promise<unknown>;
							}) => tools.set(tool.name, tool),
						} as never);
					}
					artifactPath = join(request.cwd, "partial.json");
					writeFileSync(artifactPath, '{"syntheticInput":7}\n');
					request.onToolExecution?.({
						toolCallId: "synthetic-input",
						toolName: "fixture_observe",
						result: { syntheticInput: 7 },
						isError: false,
					});
					const evidenceId = store.snapshot(runId).evidence[0].evidenceId;
					await tools.get("planning_checkpoint")!.execute("partial", {
						summary: "Synthetic input is usable before the final report",
						evidenceRefs: [evidenceId],
						completedItems: ["Reusable synthetic input saved"],
						remainingItems: ["Describe remaining limitations in the final report"],
						artifacts: [{ path: artifactPath, type: "json", description: "Synthetic partial input" }],
					});
					const partial = store.snapshot(runId, true);
					expect(partial.tasks.map((task) => task.status)).toEqual(["running", "running"]);
					expect(partial.executionFrame.frame.taskSummaries).toEqual([]);
					expect(partial.latestCheckpoint?.artifacts[0].path).toBe(artifactPath);
					expect(partial.latestCheckpoint?.evidenceRefs).toEqual([evidenceId]);
					expect(readFileSync(artifactPath, "utf8")).toContain('"syntheticInput":7');
					if (engine === "hypothesis") {
						expect(hypothesisPlannerView(partial).checkpoint?.artifacts[0].path).toBe(artifactPath);
					}
					await tools.get("planning_commit_result")!.execute("final", {
						outcome: "done",
						summary: "Synthetic supporting input delivered with limitations",
						suggestedTasks: [],
						flagCandidates: [],
					});
					return { messages: [], finalText: "", toolExecutions: [] };
				});
				const executor = new PiPlanningExecutor({
					config: {
						stateDir: join(root, ".state"),
						executionMode: { mode: "plan_multi", capacity: 2 },
						planning: { engine, observerMode: "off" },
					} as never,
					cwd: root,
				});
				const report = await executor.execute({
					lease: auxiliary,
					context: "Synthetic auxiliary assignment",
					recordEvidence: (evidence) => {
						store.recordEvidence(auxiliary.leaseId, [evidence]);
					},
					recordCheckpoint: (id, checkpoint, elapsedMs, artifactWorkspace) =>
						store.recordCheckpoint(auxiliary.leaseId, id, checkpoint, Date.now(), elapsedMs, artifactWorkspace),
				});
				const delivered = store.commitResult({
					...report,
					leaseId: auxiliary.leaseId,
					planRevision: auxiliary.planRevision,
				});
				expect(delivered.tasks.map((task) => task.status)).toEqual(["running", "done"]);
				expect(delivered.run.status).toBe("running");
				expect(delivered.latestCheckpoint?.artifacts[0].path).toBe(artifactPath);
			} finally {
				store.close();
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it("releases a registered partial input while retaining an explicit full-completion prerequisite", async () => {
		const root = mkdtempSync(join(tmpdir(), "planning-partial-prerequisite-"));
		const store = await storeFixture();
		try {
			const artifactPath = join(root, "partial.json");
			writeFileSync(artifactPath, '{"syntheticInput":7}\n');
			const value = proposal();
			const tasks = [
				value.tasks[0],
				{
					...value.tasks[1],
					requiredInputs: [{ sourceTaskId: "owner", artifactPath }],
				},
				{
					...value.tasks[1],
					key: "completion-consumer",
					objective: "Consume the input only after its producer has fully completed",
					dependsOn: ["owner"],
					requiredInputs: [{ sourceTaskId: "owner", artifactPath }],
				},
			];
			const initial = store.snapshot(runId);
			const parsed = parseHypothesisProposal({ ...value, tasks }, initial);
			const compiled = compilePlanningProposal(runId, parsed, [], 48);
			store.commitPlan({
				runId,
				expectedRevision: 0,
				rationale: value.rationale,
				idempotencyKey: "synthetic-prerequisites",
				tasks: compiled,
				hypothesisUpdate: parsed.hypothesisUpdate,
			});
			const source = store.leaseTask(runId, compiled[0].taskId, root, 300_000);
			store.startLease(source.leaseId);
			store.recordCheckpoint(source.leaseId, "synthetic-partial", {
				summary: "Synthetic input ready while its producer continues",
				evidenceRefs: [],
				completedItems: ["Synthetic input saved"],
				remainingItems: ["Producer's remaining work"],
				rejectedDirections: [],
				artifacts: [{ path: artifactPath, type: "json", description: "Synthetic partial input" }],
				suggestedNextSteps: [],
			});
			const partial = store.snapshot(runId, true);
			expect(partial.tasks.map((task) => task.status)).toEqual(["running", "ready", "proposed"]);
			expect(partial.tasks[2].dependsOnTaskIds).toEqual([source.taskId]);
			expect(parsed.hypothesisUpdate?.newBindings.slice(1).map((binding) => binding.requiredInputs)).toEqual([
				[{ sourceTaskId: source.taskId, artifactPath }],
				[{ sourceTaskId: source.taskId, artifactPath }],
			]);
		} finally {
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
