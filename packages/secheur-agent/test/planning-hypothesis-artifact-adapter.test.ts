import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	PlanningCheckpoint,
	PlanningCheckpointInput,
	PlanningTaskLease,
	PlanningTaskResult,
} from "../src/planning/contracts.ts";
import type { PlanningExecutor } from "../src/planning/harness.ts";
import { PiPlanningExecutor } from "../src/planning/pi-adapters.ts";
import type { PlanningCommitExtensionOptions } from "../src/planning/result-tool.ts";
import type { runPiCodingTask } from "../src/subagent.ts";

const mockedRunPiCodingTask = vi.hoisted(() => vi.fn());
const mockedCreatePlanningCommitExtension = vi.hoisted(() => vi.fn());
let committedResult: PlanningTaskResult | undefined;
let commitOptions: PlanningCommitExtensionOptions | undefined;

vi.mock("../src/subagent.ts", () => ({
	runPiCodingTask: mockedRunPiCodingTask,
	VerifierInfrastructureError: class MockVerifierInfrastructureError extends Error {
		readonly source = "verifier" as const;
		readonly code = "verifier_infrastructure_error" as const;
	},
}));
vi.mock("../src/planning/result-tool.ts", () => ({
	createPlanningCommitExtension: mockedCreatePlanningCommitExtension,
}));

describe("hypothesis artifact workspace adapter handoff", () => {
	beforeEach(() => {
		committedResult = undefined;
		commitOptions = undefined;
		mockedRunPiCodingTask.mockReset();
		mockedCreatePlanningCommitExtension.mockReset();
		mockedCreatePlanningCommitExtension.mockImplementation((options: PlanningCommitExtensionOptions) => {
			commitOptions = options;
			return { extension: {}, getResult: () => committedResult };
		});
	});

	it.each(["hypothesis", "progressive"] as const)(
		"passes the actual isolated cwd only for %s artifact alias registration",
		async (engine) => {
			const root = mkdtempSync(join(tmpdir(), "hypothesis-artifact-adapter-"));
			const lease: PlanningTaskLease = {
				schemaVersion: 1,
				leaseId: "fixture-isolated-lease",
				runId: "fixture-adapter-run",
				taskId: "fixture-adapter-producer",
				planRevision: 1,
				objective: "Exercise the host artifact handoff",
				doneWhen: "Record synthetic partial and final artifacts",
				allowedScope: root,
				issuedAt: Date.now(),
				expiresAt: Date.now() + 300_000,
			};
			const inputCheckpoint: PlanningCheckpointInput = {
				summary: "Synthetic partial observation",
				evidenceRefs: [],
				completedItems: ["Synthetic partial result"],
				remainingItems: ["Synthetic final delivery"],
				rejectedDirections: [],
				artifacts: [],
				suggestedNextSteps: [],
			};
			const recordCheckpoint = vi.fn<NonNullable<Parameters<PlanningExecutor["execute"]>[0]["recordCheckpoint"]>>(
				(checkpointId, checkpoint): PlanningCheckpoint => ({
					...checkpoint,
					schemaVersion: 1,
					checkpointId,
					runId: lease.runId,
					taskId: lease.taskId,
					leaseId: lease.leaseId,
					checkpointSequence: 1,
					source: "executor",
					createdAt: Date.now(),
				}),
			);
			let actualCwd = "";
			const executor = new PiPlanningExecutor({
				config: {
					stateDir: join(root, ".state"),
					executionMode: { mode: "plan_multi", capacity: 2 },
					planning: { engine, observerMode: "off" },
				} as never,
				cwd: root,
			});
			mockedRunPiCodingTask.mockImplementationOnce(async (options: Parameters<typeof runPiCodingTask>[0]) => {
				actualCwd = options.cwd;
				expect(actualCwd).not.toBe(root);
				expect(relative(root, actualCwd).split(sep)[0]).toBe(".planning-attempts");
				expect(existsSync(actualCwd)).toBe(true);
				inputCheckpoint.artifacts = [
					{
						path: join(actualCwd, "notes", "partial.json"),
						type: "json",
						description: "Synthetic partial artifact",
					},
				];
				expect(commitOptions?.recordCheckpoint).toEqual(expect.any(Function));
				const saved = await commitOptions!.recordCheckpoint!("fixture-partial", inputCheckpoint);
				expect(saved).toMatchObject({ checkpointId: "fixture-partial", leaseId: lease.leaseId });
				committedResult = {
					schemaVersion: 1,
					leaseId: lease.leaseId,
					outcome: "done",
					summary: "Synthetic final delivery",
					suggestedTasks: [],
					flagCandidates: [],
					evidenceRefs: [],
					artifacts: [
						{
							path: join(actualCwd, "notes", "final.json"),
							type: "json",
							description: "Synthetic final artifact",
						},
					],
				};
				return { messages: [], finalText: "", toolExecutions: [] };
			});
			try {
				const report = await executor.execute({ lease, context: "Synthetic fixture context", recordCheckpoint });
				expect(mockedRunPiCodingTask).toHaveBeenCalledOnce();
				expect(recordCheckpoint).toHaveBeenCalledExactlyOnceWith(
					"fixture-partial",
					inputCheckpoint,
					expect.any(Number),
					engine === "hypothesis" ? actualCwd : undefined,
				);
				expect(report.result).toBe(committedResult);
				expect(report.result).not.toHaveProperty("artifactWorkspace");
				if (engine === "hypothesis") expect(report.artifactWorkspace).toBe(actualCwd);
				else expect(report).not.toHaveProperty("artifactWorkspace");
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
});
