import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveExecutionMode } from "../src/execution-mode.ts";
import {
	PLANNING_SCHEMA_VERSION,
	type PlanningPlanProposal,
	type PlanningSnapshot,
} from "../src/planning/contracts.ts";
import { ProgressivePlanningController } from "../src/planning/controller.ts";
import { PlanningPersistenceError } from "../src/planning/failures.ts";
import { PiPlanningExecutor } from "../src/planning/pi-adapters.ts";
import { PlanningStore } from "../src/planning/store.ts";

interface FakeTool {
	name: string;
	execute: (toolCallId: string, params: unknown) => Promise<unknown>;
}

interface FakeSession {
	sessionId: string;
	messages: unknown[];
	bindExtensions: ReturnType<typeof vi.fn>;
	getAllTools: ReturnType<typeof vi.fn>;
	getActiveToolNames: ReturnType<typeof vi.fn>;
	setActiveToolsByName: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
}

const fake = vi.hoisted(() => ({
	mode: "normal" as "normal" | "persistence_failure",
	sessionNumber: 0,
	artifactPath: "",
	readArtifact: vi.fn(),
	seenPrompts: [] as string[],
	lifecycleEvents: [] as string[],
	sessions: [] as FakeSession[],
	createAgentSession: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	SettingsManager: { create: vi.fn(() => ({})) },
	DefaultResourceLoader: class {
		readonly extensionFactories: unknown[];
		constructor(options: { extensionFactories?: unknown[] }) {
			this.extensionFactories = options.extensionFactories ?? [];
		}
		async reload() {}
	},
	SessionManager: { inMemory: vi.fn(() => ({})) },
	createAgentSession: fake.createAgentSession,
}));

function emit(
	sessionSubscriber: ((event: Record<string, unknown>) => void) | undefined,
	event: Record<string, unknown>,
) {
	sessionSubscriber?.(event);
}

function makeSession(sessionNumber: number): FakeSession {
	let subscriber: ((event: Record<string, unknown>) => void) | undefined;
	let abortReason: unknown;
	const session: FakeSession = {
		sessionId: `planning-integration-session-${sessionNumber}`,
		messages: [],
		bindExtensions: vi.fn(async () => undefined),
		getAllTools: vi.fn(() => [...toolsByName(session).values()].map((tool) => ({ name: tool.name }))),
		getActiveToolNames: vi.fn(() => [...toolsByName(session).keys()]),
		setActiveToolsByName: vi.fn(),
		subscribe: vi.fn((callback: (event: Record<string, unknown>) => void) => {
			subscriber = callback;
			return () => {
				subscriber = undefined;
			};
		}),
		prompt: vi.fn(async (message: string) => {
			fake.seenPrompts.push(message);
			const externalTool = (toolCallId: string, toolName: string, result: unknown, isError = false): void => {
				emit(subscriber, { type: "tool_execution_start", toolCallId, toolName, args: {} });
				emit(subscriber, { type: "tool_execution_end", toolCallId, toolName, result, isError });
			};
			if (sessionNumber === 1) {
				externalTool("collect-call", "collect_artifact", { stdout: "partial discovery" });
				const checkpoint = toolsByName(session).get("planning_checkpoint");
				if (!checkpoint) throw new Error("planning_checkpoint was not registered");
				try {
					const response = await checkpoint.execute("checkpoint-call", {
						summary: "artifact was created before the attempt timed out",
						evidenceRefs: [],
						completedItems: ["collect artifact"],
						remainingItems: ["read artifact and verify the method"],
						rejectedDirections: [],
						artifacts: [
							{
								path: fake.artifactPath,
								type: "text",
								description: "partial artifact from the first method",
								sha256: createHash("sha256").update(readFileSync(fake.artifactPath)).digest("hex"),
							},
						],
						suggestedNextSteps: [
							{
								objective: "read the persisted artifact",
								doneWhen: "the artifact contents are incorporated",
								inputEvidenceRefs: [],
							},
						],
					});
					externalTool("checkpoint-call", "planning_checkpoint", response);
				} catch (error) {
					externalTool(
						"checkpoint-call",
						"planning_checkpoint",
						{ error: error instanceof Error ? error.message : String(error) },
						true,
					);
					if (fake.mode === "persistence_failure") return;
				}
				if (fake.mode === "persistence_failure") return;
				return new Promise<void>((_resolve, reject) => {
					if (abortReason) reject(abortReason);
					else setTimeout(() => reject(new Error("integration fixture did not receive timeout")), 250);
				});
			}

			const encodedArtifactPath = fake.artifactPath.replaceAll("\\", "\\\\");
			if (!message.includes(fake.artifactPath) && !message.includes(encodedArtifactPath))
				throw new Error("follow-up context did not expose checkpoint artifact");
			const content = readFileSync(fake.artifactPath, "utf8");
			fake.readArtifact(content);
			externalTool("read-artifact-call", "read_artifact", { path: fake.artifactPath, content });
			const commit = toolsByName(session).get("planning_commit_result");
			if (!commit) throw new Error("planning_commit_result was not registered");
			const response = await commit.execute("commit-call", {
				outcome: "done",
				summary: "follow-up read the checkpoint artifact",
				suggestedTasks: [],
				flagCandidates: [],
			});
			externalTool("commit-call", "planning_commit_result", response);
		}),
		dispose: vi.fn(),
		abort: vi.fn(async (reason?: unknown) => {
			abortReason = reason;
		}),
	};
	return session;
}

function bindExtensions(session: FakeSession, resourceLoader: { extensionFactories: unknown[] }): void {
	const extensionApi = {
		on: vi.fn(),
		registerTool(tool: FakeTool) {
			toolsByName(session).set(tool.name, tool);
		},
	};
	for (const extension of resourceLoader.extensionFactories) {
		const factory =
			typeof extension === "function"
				? extension
				: extension && typeof extension === "object" && "factory" in extension
					? (extension as { factory: unknown }).factory
					: undefined;
		if (typeof factory === "function") void factory(extensionApi);
	}
}

const toolMaps = new WeakMap<FakeSession, Map<string, FakeTool>>();
function toolsByName(session: FakeSession): Map<string, FakeTool> {
	let tools = toolMaps.get(session);
	if (!tools) {
		tools = new Map();
		toolMaps.set(session, tools);
	}
	return tools;
}

function config(stateDir: string) {
	return {
		agentDir: join(stateDir, "pi"),
		skillPaths: [],
		stateDir,
		systemPromptPath: undefined,
		knowledgeBaseEnabled: false,
		executionMode: { mode: "plan_single", legacyPlanningMode: "active", planningEnabled: true, capacity: 1 },
		planning: { mode: "active", maxEvidenceBytes: 32_768 },
		registry: { mcpServers: {}, skills: {}, tools: {}, agents: {} },
	} as never;
}

function initialProposal(revision: number): PlanningPlanProposal {
	return {
		schemaVersion: PLANNING_SCHEMA_VERSION,
		expectedRevision: revision,
		decision: "create_tasks",
		rationale: "start the scoped method",
		tasks: [{ key: "first-method", objective: "collect the artifact", doneWhen: "artifact is checkpointed" }],
	};
}

function followupProposal(snapshot: PlanningSnapshot): PlanningPlanProposal {
	return {
		schemaVersion: PLANNING_SCHEMA_VERSION,
		expectedRevision: snapshot.run.revision,
		decision: "create_tasks",
		rationale: "use the checkpoint artifact with a smaller method",
		tasks: [
			{
				key: "read-artifact",
				objective: "read the persisted artifact",
				doneWhen: "the artifact contents are incorporated",
				inputEvidenceRefs: snapshot.latestFailure?.evidenceRefs ?? [],
			},
		],
	};
}

function controllerOptions(
	store: PlanningStore,
	root: string,
	supervisor: { propose(input: { snapshot: PlanningSnapshot; signal?: AbortSignal }): Promise<PlanningPlanProposal> },
) {
	const executor = new PiPlanningExecutor({
		config: config(join(root, ".state")),
		cwd: root,
		taskTimeoutMs: 35,
		onLifecycleEvent: (type) => fake.lifecycleEvents.push(type),
	});
	return {
		executionMode: resolveExecutionMode({ legacyPlanningMode: "active" }),
		store,
		supervisor,
		executor,
		maximumSteps: 4,
		maximumTasks: 8,
		leaseTtlMs: 30_000,
		maximumEvidenceBytes: 32_768,
		allowedScope: root,
	};
}

describe("Pi Planning executor with a synthetic session event fixture", () => {
	const roots: string[] = [];

	beforeEach(() => {
		fake.mode = "normal";
		fake.sessionNumber = 0;
		fake.artifactPath = "";
		fake.readArtifact.mockReset();
		fake.seenPrompts.length = 0;
		fake.lifecycleEvents.length = 0;
		fake.sessions.length = 0;
		fake.createAgentSession.mockReset();
		fake.createAgentSession.mockImplementation(
			async ({ resourceLoader }: { resourceLoader: { extensionFactories: unknown[] } }) => {
				fake.sessionNumber += 1;
				const session = makeSession(fake.sessionNumber);
				toolMaps.set(session, new Map());
				session.bindExtensions.mockImplementation(async () => bindExtensions(session, resourceLoader));
				fake.sessions.push(session);
				return { session };
			},
		);
	});

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("runs Harness -> PiPlanningExecutor -> runPiCodingTask -> checkpoint -> timeout -> replan -> artifact read", async () => {
		const root = mkdtempSync(join(tmpdir(), "planning-pi-integration-"));
		roots.push(root);
		const artifactPath = join(root, "partial.txt");
		writeFileSync(artifactPath, "persisted checkpoint artifact\n");
		fake.artifactPath = artifactPath;
		const store = await PlanningStore.open(":memory:");
		const supervisorSnapshots: PlanningSnapshot[] = [];
		let supervisorCalls = 0;
		const supervisor = {
			async propose({ snapshot }: { snapshot: PlanningSnapshot }): Promise<PlanningPlanProposal> {
				supervisorCalls += 1;
				supervisorSnapshots.push(snapshot);
				if (
					snapshot.tasks.some((task) => task.objective === "read the persisted artifact" && task.status === "done")
				) {
					return {
						schemaVersion: PLANNING_SCHEMA_VERSION,
						expectedRevision: snapshot.run.revision,
						decision: "finish_run" as const,
						rationale: "the follow-up evidence is persisted",
						tasks: [],
						answerEvidenceRefs: snapshot.evidence.slice(-1).map((item) => item.evidenceId),
					};
				}
				return snapshot.latestFailure ? followupProposal(snapshot) : initialProposal(snapshot.run.revision);
			},
		};
		try {
			const result = await new ProgressivePlanningController(controllerOptions(store, root, supervisor)).execute({
				outerTaskId: "pi-integration",
				goal: "read the artifact after the first method times out",
				executeDirect: async () => undefined,
			});
			const runId = result.runId as string;
			const snapshot = result.snapshot as PlanningSnapshot;
			expect(snapshot.run.status).toBe("completed");
			expect(supervisorCalls).toBe(3);
			expect(supervisorSnapshots[1]?.latestFailure).toMatchObject({
				code: "executor_timeout",
				checkpoint: { artifacts: [{ path: artifactPath, type: "text" }] },
			});
			expect(supervisorSnapshots[1]?.latestCheckpoint?.artifacts[0]).toMatchObject({
				path: artifactPath,
				type: "text",
			});
			expect(fake.readArtifact).toHaveBeenCalledWith("persisted checkpoint artifact\n");
			expect(fake.seenPrompts.some((prompt) => prompt.includes(artifactPath.replaceAll("\\", "\\\\")))).toBe(true);
			expect(snapshot.evidence.some((item) => item.toolName === "collect_artifact")).toBe(true);
			expect(snapshot.evidence.some((item) => item.toolName === "read_artifact")).toBe(true);
			expect(snapshot.tasks.map((task) => [task.objective, task.status])).toEqual([
				["collect the artifact", "failed"],
				["read the persisted artifact", "done"],
			]);
			const events = store.listLifecycleEvents(runId).events;
			expect(events.map((event) => event.type)).toEqual(
				expect.arrayContaining([
					"evidence_saved",
					"planning_checkpoint_saved",
					"attempt_sealed",
					"attempt_routing_decided",
					"task_committed",
				]),
			);
			expect(events.find((event) => event.type === "attempt_routing_decided")?.payload).toMatchObject({
				routingState: "replan_queued",
				replanAllowed: true,
				replanStarted: false,
			});
			expect(
				events.find(
					(event) =>
						event.type === "attempt_routing_decided" && event.payload.routingState === "supervisor_started",
				)?.payload,
			).toMatchObject({
				replanAllowed: true,
				replanStarted: true,
			});
		} finally {
			store.close();
		}
	});

	it("stops on an injected checkpoint persistence fault without recovery or replan", async () => {
		const root = mkdtempSync(join(tmpdir(), "planning-pi-persistence-"));
		roots.push(root);
		const artifactPath = join(root, "partial.txt");
		writeFileSync(artifactPath, "persisted before failure\n");
		fake.artifactPath = artifactPath;
		fake.mode = "persistence_failure";
		const store = await PlanningStore.open(":memory:");
		const originalRecordCheckpoint = store.recordCheckpoint.bind(store);
		store.recordCheckpoint = (() => {
			throw new PlanningPersistenceError("injected checkpoint database failure");
		}) as PlanningStore["recordCheckpoint"];
		let supervisorCalls = 0;
		let runId = "";
		const supervisor = {
			async propose({ snapshot }: { snapshot: PlanningSnapshot }) {
				supervisorCalls += 1;
				runId = snapshot.run.runId;
				return initialProposal(snapshot.run.revision);
			},
		};
		try {
			await expect(
				new ProgressivePlanningController(controllerOptions(store, root, supervisor)).execute({
					outerTaskId: "pi-persistence",
					goal: "stop when checkpoint storage fails",
					executeDirect: async () => undefined,
				}),
			).rejects.toMatchObject({ code: "planning_persistence_error" });
			expect(supervisorCalls).toBe(1);
			expect(fake.sessions).toHaveLength(1);
			expect(fake.sessions[0]?.prompt).toHaveBeenCalledTimes(1);
			expect(fake.sessions[0]?.dispose).toHaveBeenCalledOnce();
			expect(fake.lifecycleEvents).not.toContain("required_tool_recovery_start");
			if (runId) {
				const events = store.listLifecycleEvents(runId).events;
				expect(events.find((event) => event.type === "attempt_sealed")?.payload).not.toHaveProperty(
					"returnedToSupervisor",
				);
				expect(events.find((event) => event.type === "attempt_routing_decided")?.payload).toMatchObject({
					routingState: "terminal",
					replanAllowed: false,
					replanStarted: false,
				});
			}
		} finally {
			store.recordCheckpoint = originalRecordCheckpoint;
			store.close();
		}
	});
});
