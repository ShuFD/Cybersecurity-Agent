import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { type InlineExtension, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { loadSecHeurConfig, type SecHeurConfig } from "../src/config.ts";
import { resolveExecutionMode } from "../src/execution-mode.ts";
import { createSecHeurExtension } from "../src/extension.ts";
import { PLANNING_SCHEMA_VERSION, type PlanningSnapshot } from "../src/planning/contracts.ts";
import { ProgressivePlanningController } from "../src/planning/controller.ts";
import { PlanningPersistenceError } from "../src/planning/failures.ts";
import { PiPlanningExecutor, PiPlanningSupervisor } from "../src/planning/pi-adapters.ts";
import { planningExecutorExtensionBundle } from "../src/planning/session-controller.ts";
import { PlanningStore } from "../src/planning/store.ts";
import { runPiCodingTask } from "../src/subagent.ts";

async function localFauxRuntime(faux: ReturnType<typeof registerFauxProvider>) {
	const model = faux.getModel();
	const credentials = AuthStorage.inMemory();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "local-faux-only" }));
	const modelRuntime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			},
		],
	});
	return { model, modelRuntime };
}

function planningTextSubmission(text: string) {
	return fauxAssistantMessage(fauxToolCall("submit_planning_proposal", JSON.parse(text)), { stopReason: "toolUse" });
}

function localConfig(root: string, stateDir: string, evidenceCatalogEnabled = false) {
	return {
		agentDir: join(root, "pi"),
		skillPaths: [],
		stateDir,
		knowledgeBaseEnabled: false,
		executionMode: { mode: "plan_single", legacyPlanningMode: "active", planningEnabled: true, capacity: 1 },
		planning: {
			mode: "active",
			maxEvidenceBytes: 32_768,
			...(evidenceCatalogEnabled ? { evidenceCatalogEnabled: true } : {}),
		},
		registry: { mcpServers: {}, skills: {}, tools: {}, agents: {} },
	} as never;
}

function promptText(context: Context): string {
	const parts = [context.systemPrompt ?? ""];
	for (const message of context.messages) {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") {
			parts.push(content);
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const item of content) {
			if (typeof item === "object" && item !== null && "text" in item && typeof item.text === "string") {
				parts.push(item.text);
			}
		}
	}
	return parts.join("\n");
}

function contextBlock(context: Context, heading: string): Record<string, unknown> | undefined {
	const prompt = promptText(context);
	const marker = `${heading}\n`;
	const start = prompt.lastIndexOf(marker);
	if (start < 0) return undefined;
	const contentStart = start + marker.length;
	const end = prompt.indexOf("\n\n# ", contentStart);
	try {
		const parsed: unknown = JSON.parse(prompt.slice(contentStart, end < 0 ? undefined : end));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function evidenceIdFromPrompt(context: Context): string | undefined {
	const block = contextBlock(context, "# Evidence map: raw observations and attributed claims");
	const items = block && Array.isArray(block.items) ? block.items : [];
	const item = items.find(
		(value): value is Record<string, unknown> =>
			typeof value === "object" && value !== null && !Array.isArray(value) && typeof value.evidenceId === "string",
	);
	return item?.evidenceId as string | undefined;
}

async function listenMockFlagOracle(): Promise<{
	url: string;
	requests: Array<Record<string, unknown>>;
	close: () => Promise<void>;
}> {
	const requests: Array<Record<string, unknown>> = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
		});
		request.on("end", () => {
			if (request.method !== "POST" || request.url !== "/api/v1/verify") {
				response.writeHead(404).end();
				return;
			}
			requests.push(JSON.parse(body) as Record<string, unknown>);
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({ ok: true, status: "correct", verified: true, challenge_id: "fixture/challenge" }),
			);
		});
	});
	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolvePromise();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Mock Oracle did not bind a TCP port");
	return {
		url: `http://127.0.0.1:${address.port}`,
		requests,
		close: () => {
			server.closeAllConnections();
			return new Promise<void>((resolvePromise, reject) =>
				server.close((error) => (error ? reject(error) : resolvePromise())),
			);
		},
	};
}

describe("Planning through the actual Pi AgentSession", () => {
	it("does not return or dispose while a real Pi tool is still settling after cancellation", async () => {
		const root = mkdtempSync(join(tmpdir(), "planning-abort-drain-"));
		const faux = registerFauxProvider({ tokenSize: { min: 100, max: 100 } });
		let releaseTool = () => {};
		let toolStarted = () => {};
		const started = new Promise<void>((resolve) => {
			toolStarted = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		let toolFinished = false;
		const extension: InlineExtension = {
			name: "cancellation-fixture",
			factory: (pi) => {
				pi.registerTool({
					name: "slow_fixture",
					label: "Slow fixture",
					description: "Wait for test release",
					parameters: Type.Object({}),
					async execute() {
						toolStarted();
						await release;
						toolFinished = true;
						return { content: [{ type: "text", text: "finished" }], details: {} };
					},
				});
			},
		};
		try {
			const runtime = await localFauxRuntime(faux);
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("slow_fixture", {}, { id: "slow" }), { stopReason: "toolUse" }),
			]);
			const controller = new AbortController();
			const reason = new Error("test cancellation");
			let returned = false;
			const operation = runPiCodingTask({
				config: localConfig(root, join(root, "state")),
				cwd: root,
				task: "run fixture",
				...runtime,
				extensionFactories: [extension],
				allowedTools: ["slow_fixture"],
				signal: controller.signal,
			}).catch((error) => {
				returned = true;
				return error;
			});
			await started;
			controller.abort(reason);
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
			expect(returned).toBe(false);
			expect(toolFinished).toBe(false);
			releaseTool();
			expect(await operation).toBe(reason);
			expect(toolFinished).toBe(true);
		} finally {
			releaseTool();
			faux.unregister();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("runs two real Pi sessions in separate workspaces and durably joins both reports", async () => {
		const root = mkdtempSync(join(tmpdir(), "planning-real-pi-multi-"));
		const store = await PlanningStore.open(join(root, "state", "planning.sqlite"));
		const faux = registerFauxProvider({ tokenSize: { min: 100, max: 100 } });
		const config: SecHeurConfig = localConfig(root, join(root, "state"), true);
		config.executionMode = resolveExecutionMode({ mode: "plan_multi", capacity: 2 });
		const sessions = new Set<string>(),
			directories = new Set<string>();
		let releaseTools = () => {};
		const bothToolsStarted = new Promise<void>((resolve) => {
			releaseTools = resolve;
		});
		let createdBundles = 0,
			closedBundles = 0;
		try {
			const { model, modelRuntime } = await localFauxRuntime(faux);
			faux.setResponses(
				Array.from({ length: 20 }, () => (context: Context) => {
					const text = promptText(context);
					if (text.includes("planning_commit_result was already accepted") || text.includes('"accepted":true')) {
						return fauxAssistantMessage("The branch result is submitted.");
					}
					if (text.includes("offline-branch-observation")) {
						return fauxAssistantMessage(
							fauxToolCall("planning_commit_result", {
								outcome: "done",
								summary: "Independent branch observed.",
							}),
							{ stopReason: "toolUse" },
						);
					}
					return fauxAssistantMessage(fauxToolCall("observe_branch", {}), { stopReason: "toolUse" });
				}),
			);
			const executor = new PiPlanningExecutor({
				config,
				cwd: root,
				model,
				modelRuntime,
				taskTimeoutMs: 5_000,
				createExtensionBundle: () => {
					createdBundles++;
					return {
						extensionFactories: [
							{
								name: "offline-branch-tools",
								factory: (pi) =>
									pi.registerTool({
										name: "observe_branch",
										label: "Observe branch",
										description: "Offline independent observation",
										parameters: Type.Object({}),
										async execute(_id, _params, _signal, _update, ctx) {
											sessions.add(ctx.sessionManager.getSessionId());
											directories.add(ctx.cwd);
											if (sessions.size === 2) releaseTools();
											await bothToolsStarted;
											return {
												content: [{ type: "text", text: "offline-branch-observation" }],
												details: { source: "local-fixture" },
											};
										},
									}),
							},
						],
						close: () => {
							closedBundles++;
						},
					};
				},
			});
			const controller = new ProgressivePlanningController({
				executionMode: config.executionMode,
				store,
				executor,
				supervisor: {
					async propose({ snapshot }) {
						return {
							schemaVersion: PLANNING_SCHEMA_VERSION,
							expectedRevision: snapshot.run.revision,
							decision: snapshot.tasks.length ? "blocked" : "create_tasks",
							rationale: "offline parallel investigation",
							tasks: snapshot.tasks.length
								? []
								: ["branch-a", "branch-b"].map((key) => ({
										key,
										objective: key,
										doneWhen: "observed",
										dependsOn: [],
									})),
						};
					},
				},
				maximumSteps: 4,
				maximumTasks: 8,
				leaseTtlMs: 30_000,
				maximumEvidenceBytes: 32_768,
				allowedScope: root,
			});
			const result = await controller.execute({
				outerTaskId: "offline-multi",
				goal: "independent observations",
				executeDirect: async () => {
					throw new Error("DIRECT forbidden");
				},
			});
			expect(sessions.size).toBe(2);
			expect(directories.size).toBe(2);
			expect([...directories].every((path) => path.startsWith(join(root, ".planning-attempts")))).toBe(true);
			expect(createdBundles).toBe(2);
			expect(closedBundles).toBe(2);
			expect(result.executionMode).toBe("plan_multi");
			expect(result.snapshot?.tasks.map((task) => task.status)).toEqual(["done", "done"]);
			expect(result.snapshot?.executionFrame.frame.taskSummaries).toHaveLength(2);
			expect(result.snapshot?.activeLeases).toHaveLength(0);
		} finally {
			releaseTools();
			store.close();
			faux.unregister();
			rmSync(root, { recursive: true, force: true });
		}
	}, 15_000);

	it("recovers from an invalid evidence cursor in the real Pi session and commits the task", async () => {
		const root = mkdtempSync(join(tmpdir(), "planning-real-pi-evidence-cursor-recovery-"));
		const stateDir = join(root, ".state");
		const config = localConfig(root, stateDir, true);
		const store = await PlanningStore.open(join(stateDir, "planning.sqlite"));
		const faux = registerFauxProvider({ tokenSize: { min: 100, max: 100 } });
		let correctionFeedbackReceived = false;
		let firstPageResultReceived = false;
		let supervisorCalls = 0;
		const lifecycle: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const localTools: InlineExtension = {
			name: "planning-evidence-cursor-recovery-tools",
			factory: (pi) => {
				pi.registerTool({
					name: "confirm_cursor_recovery",
					label: "Confirm cursor recovery",
					description: "Return an offline receipt after recovering the evidence query.",
					parameters: Type.Object({}),
					executionMode: "sequential",
					async execute() {
						return {
							content: [{ type: "text", text: "first-page evidence query recovery confirmed" }],
							details: { source: "local-fixture" },
						};
					},
				});
			},
		};
		try {
			const { model, modelRuntime } = await localFauxRuntime(faux);
			faux.setResponses([
				() =>
					fauxAssistantMessage(
						fauxToolCall(
							"planning_list_evidence",
							{ cursor: "invalid-cursor-from-model" },
							{ id: "list-evidence-invalid-cursor" },
						),
						{ stopReason: "toolUse" },
					),
				(context) => {
					const feedback = promptText(context);
					correctionFeedbackReceived =
						feedback.includes("Planning evidence cursor is invalid or belongs to a different query") &&
						feedback.includes("restart from the first page") &&
						!feedback.includes("planning_persistence_error");
					if (!correctionFeedbackReceived)
						throw new Error("The real Pi session did not receive correctable cursor feedback");
					return fauxAssistantMessage(
						fauxToolCall("planning_list_evidence", {}, { id: "list-evidence-first-page" }),
						{ stopReason: "toolUse" },
					);
				},
				(context) => {
					const feedback = promptText(context);
					firstPageResultReceived = feedback.includes('"totalCount":0') && feedback.includes('"hasMore":false');
					if (!firstPageResultReceived)
						throw new Error("The real Pi session did not receive the successful first-page result");
					return fauxAssistantMessage(
						fauxToolCall("confirm_cursor_recovery", {}, { id: "confirm-cursor-recovery" }),
						{ stopReason: "toolUse" },
					);
				},
				(context) => {
					const feedback = promptText(context);
					if (!feedback.includes("first-page evidence query recovery confirmed"))
						throw new Error("The real Pi session did not receive the successful recovery receipt");
					return fauxAssistantMessage(
						fauxToolCall(
							"planning_commit_result",
							{ outcome: "done", summary: "Recovered from the invalid evidence cursor and committed." },
							{ id: "commit-after-cursor-recovery" },
						),
						{ stopReason: "toolUse" },
					);
				},
				() => fauxAssistantMessage("The recovered catalog query and task result are committed."),
			]);
			const controller = new ProgressivePlanningController({
				executionMode: resolveExecutionMode({ legacyPlanningMode: "active" }),
				store,
				supervisor: {
					async propose({ snapshot }: { snapshot: PlanningSnapshot }) {
						supervisorCalls += 1;
						return {
							schemaVersion: PLANNING_SCHEMA_VERSION,
							expectedRevision: snapshot.run.revision,
							decision: supervisorCalls === 1 ? ("create_tasks" as const) : ("blocked" as const),
							rationale: "Exercise cursor recovery entirely within the actual Executor Pi session.",
							tasks:
								supervisorCalls === 1
									? [
											{
												key: "recover-evidence-query",
												objective: "query the evidence catalog and recover from a bad cursor",
												doneWhen: "a first-page query succeeds and the task result is committed",
												dependsOn: [],
											},
										]
									: [],
						};
					},
				},
				executor: new PiPlanningExecutor({
					config,
					cwd: root,
					model,
					modelRuntime,
					extensionFactories: [localTools],
					allowedTools: ["planning_list_evidence", "confirm_cursor_recovery", "planning_commit_result"],
					onLifecycleEvent: (type, payload) => lifecycle.push({ type, payload }),
				}),
				maximumSteps: 2,
				maximumTasks: 2,
				leaseTtlMs: 30_000,
				maximumEvidenceBytes: 8_192,
				allowedScope: root,
			});
			const result = await controller.execute({
				outerTaskId: "mock-evidence-cursor-recovery-outer",
				goal: "Exercise invalid-cursor recovery using an offline Pi session.",
				executeDirect: async () => {
					throw new Error("Direct execution is disabled in this integration test");
				},
			});
			if (!result.runId || !result.snapshot) throw new Error("Cursor recovery returned no durable snapshot");
			expect(correctionFeedbackReceived).toBe(true);
			expect(firstPageResultReceived).toBe(true);
			expect(result.snapshot.run.status).toBe("blocked");
			expect(result.snapshot.tasks.map((task) => task.status)).toEqual(["done"]);
			expect(result.snapshot.executionFrame.frame.taskSummaries[0]?.outcome).toBe("done");
			expect(supervisorCalls).toBe(2);
			expect(lifecycle.filter((event) => event.type === "executor_error")).toHaveLength(0);
			expect(lifecycle.filter((event) => event.type === "planning_persistence_error")).toHaveLength(0);
			expect(
				lifecycle
					.filter(
						(event) =>
							event.type === "executor_tool_execution_end" &&
							event.payload.toolName === "planning_list_evidence",
					)
					.map((event) => event.payload.isError),
			).toEqual([true, false]);
			expect(result.snapshot.evidence.some((item) => item.toolName === "confirm_cursor_recovery")).toBe(true);
			expect(result.snapshot.evidence.some((item) => item.toolName === "planning_list_evidence")).toBe(false);
		} finally {
			store.close();
			faux.unregister();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("hands Supervisor-selected evidence through the real renderer, Store, read tool, and corrective checkpoint", async () => {
		const root = mkdtempSync(join(tmpdir(), "planning-real-pi-evidence-handoff-"));
		const stateDir = join(root, ".state");
		const store = await PlanningStore.open(join(stateDir, "planning.sqlite"));
		const faux = registerFauxProvider({ tokenSize: { min: 100, max: 100 } });
		let supervisorStarts = 0;
		let sourceTaskId = "";
		let handedEvidenceId = "";
		let executorSawEvidenceId = "";
		let evidenceBodyObserved = false;
		let checkpointCorrectionObserved = false;
		const lifecycle: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const localTools: InlineExtension = {
			name: "planning-evidence-fixture-tools",
			factory: (pi) => {
				pi.registerTool({
					name: "collect_fixture",
					label: "Collect fixture evidence",
					description: "Return a fixed offline fixture payload.",
					parameters: Type.Object({}),
					executionMode: "sequential",
					async execute() {
						return {
							content: [{ type: "text", text: "fixture-only durable payload: aqua-kite-731" }],
							details: { source: "local-fixture" },
						};
					},
				});
				pi.registerTool({
					name: "confirm_fixture_read",
					label: "Confirm fixture read",
					description: "Persist a local receipt after the model has inspected the fixture evidence.",
					parameters: Type.Object({}),
					executionMode: "sequential",
					async execute() {
						return {
							content: [{ type: "text", text: "fixture read receipt: prior payload inspected" }],
							details: { source: "local-fixture" },
						};
					},
				});
			},
		};
		try {
			const { model, modelRuntime } = await localFauxRuntime(faux);
			faux.setResponses([
				() =>
					planningTextSubmission(
						JSON.stringify({
							decision: "create_tasks",
							rationale: "collect one deterministic local result",
							tasks: [
								{
									key: "collect-fixture",
									objective: "collect fixture evidence",
									doneWhen: "the local result is persisted",
									dependsOn: [],
								},
							],
						}),
					),
				() =>
					fauxAssistantMessage(fauxToolCall("collect_fixture", {}, { id: "collect-fixture-call" }), {
						stopReason: "toolUse",
					}),
				() =>
					fauxAssistantMessage(
						fauxToolCall(
							"planning_commit_result",
							{ outcome: "done", summary: "Local fixture result collected." },
							{ id: "commit-fixture-collection" },
						),
						{ stopReason: "toolUse" },
					),
				() => fauxAssistantMessage("Collection report committed."),
				(context) => {
					const id = evidenceIdFromPrompt(context);
					const supplemental = contextBlock(context, "# Supplemental planning state");
					const tasks = supplemental && Array.isArray(supplemental.tasks) ? supplemental.tasks : [];
					const source = tasks.find(
						(value): value is Record<string, unknown> =>
							typeof value === "object" &&
							value !== null &&
							!Array.isArray(value) &&
							value.objective === "collect fixture evidence",
					);
					if (!id || typeof source?.taskId !== "string")
						throw new Error("Supervisor prompt did not render persisted evidence and its source task");
					handedEvidenceId = id;
					sourceTaskId = source.taskId;
					return planningTextSubmission(
						JSON.stringify({
							decision: "create_tasks",
							rationale: "read the persisted dependency result",
							tasks: [
								{
									key: "read-fixture",
									increment:
										"Read the prior evidence, correct its checkpoint and save a new confirmation receipt.",
									objective: "read the prior fixture evidence and save corrected progress",
									doneWhen:
										"the prior content is read, checkpoint progress is saved, and a local confirmation is persisted",
									dependsOn: [source.taskId],
									inputEvidenceRefs: [id],
								},
							],
						}),
					);
				},
				(context) => {
					executorSawEvidenceId = evidenceIdFromPrompt(context) ?? "";
					if (executorSawEvidenceId !== handedEvidenceId)
						throw new Error("Executor prompt did not preserve Supervisor's complete evidenceId");
					return fauxAssistantMessage(
						fauxToolCall(
							"planning_read_evidence",
							{ evidenceId: executorSawEvidenceId, offset: 0, maxBytes: 1_024 },
							{ id: "read-prior-evidence" },
						),
						{ stopReason: "toolUse" },
					);
				},
				(context) => {
					evidenceBodyObserved = promptText(context).includes("fixture-only durable payload: aqua-kite-731");
					if (!evidenceBodyObserved)
						throw new Error("planning_read_evidence did not return the fixture content to the model");
					return fauxAssistantMessage(
						fauxToolCall(
							"planning_checkpoint",
							{ summary: "checkpoint with a mistaken alias", evidenceRefs: ["read-fixture-call-id"] },
							{ id: "checkpoint-invalid-ref" },
						),
						{ stopReason: "toolUse" },
					);
				},
				(context) => {
					const feedback = promptText(context);
					checkpointCorrectionObserved =
						feedback.includes("planning_checkpoint_validation_error") &&
						feedback.includes("evidence_reference_not_persisted_or_wrong_run") &&
						feedback.includes("exact persisted evidenceId visible in this run's rendered Planning context");
					if (!checkpointCorrectionObserved)
						throw new Error(
							"The real Pi model context did not receive actionable checkpoint correction feedback",
						);
					return fauxAssistantMessage(
						fauxToolCall(
							"planning_checkpoint",
							{
								summary: "corrected checkpoint uses the persisted evidence id",
								evidenceRefs: [handedEvidenceId],
							},
							{ id: "checkpoint-valid-ref" },
						),
						{ stopReason: "toolUse" },
					);
				},
				(context) => {
					const feedback = promptText(context);
					if (
						!feedback.includes("fixture-only durable payload: aqua-kite-731") ||
						!feedback.includes("checkpointSequence")
					)
						throw new Error(
							"Model did not receive both the evidence body and accepted checkpoint before confirming",
						);
					return fauxAssistantMessage(fauxToolCall("confirm_fixture_read", {}, { id: "confirm-fixture-read" }), {
						stopReason: "toolUse",
					});
				},
				() =>
					fauxAssistantMessage(
						fauxToolCall(
							"planning_commit_result",
							{ outcome: "done", summary: "Prior fixture evidence read and checkpoint corrected." },
							{ id: "commit-read-fixture" },
						),
						{ stopReason: "toolUse" },
					),
				() => fauxAssistantMessage("Read and checkpoint report committed."),
				(context) => {
					const id = evidenceIdFromPrompt(context);
					if (id !== handedEvidenceId)
						throw new Error("Final Supervisor prompt lost the persisted result evidence");
					return planningTextSubmission(
						JSON.stringify({
							decision: "finish_run",
							rationale: "the fixture evidence was read and the checkpoint correction persisted",
							tasks: [],
							answerEvidenceRefs: [id],
						}),
					);
				},
			]);
			const supervisor = new PiPlanningSupervisor({
				config: localConfig(root, stateDir),
				cwd: root,
				model,
				modelRuntime,
				onLifecycleEvent: (type, payload) => {
					if (type === "supervisor_propose_start") supervisorStarts += 1;
					lifecycle.push({ type, payload });
				},
			});
			const executor = new PiPlanningExecutor({
				config: localConfig(root, stateDir),
				cwd: root,
				model,
				modelRuntime,
				extensionFactories: [localTools],
				allowedTools: [
					"collect_fixture",
					"confirm_fixture_read",
					"planning_read_evidence",
					"planning_checkpoint",
					"planning_commit_result",
				],
				onLifecycleEvent: (type, payload) => lifecycle.push({ type, payload }),
			});
			const result = await new ProgressivePlanningController({
				executionMode: resolveExecutionMode({ legacyPlanningMode: "active" }),
				store,
				supervisor,
				executor,
				maximumSteps: 3,
				maximumTasks: 3,
				leaseTtlMs: 30_000,
				maximumEvidenceBytes: 8_192,
				allowedScope: root,
			}).execute({
				outerTaskId: "mock-evidence-handoff-outer",
				goal: "prove complete evidence handoff using only offline fixtures",
				executeDirect: async () => {
					throw new Error("Direct execution is disabled in this integration test");
				},
			});
			const runId = result.runId;
			if (!runId || !result.snapshot) throw new Error("Evidence handoff run returned no durable snapshot");
			const secondTask = result.snapshot.tasks.find((task) =>
				task.objective.startsWith("read the prior fixture evidence"),
			);
			expect(result.snapshot.run.status).toBe("completed");
			expect(result.snapshot.tasks.map((task) => task.status)).toEqual(["done", "done"]);
			expect(sourceTaskId).toBe(result.snapshot.tasks[0]?.taskId);
			expect(secondTask?.dependsOnTaskIds).toContain(sourceTaskId);
			expect(secondTask?.inputEvidenceRefs).toEqual([handedEvidenceId]);
			expect(executorSawEvidenceId).toBe(handedEvidenceId);
			expect(evidenceBodyObserved).toBe(true);
			expect(checkpointCorrectionObserved).toBe(true);
			expect(store.readEvidence(runId, handedEvidenceId).content).toContain(
				"fixture-only durable payload: aqua-kite-731",
			);
			expect(store.snapshot(runId).latestCheckpoint?.summary).toBe(
				"corrected checkpoint uses the persisted evidence id",
			);
			expect(supervisorStarts).toBe(3);
			expect(
				store.listLifecycleEvents(runId).events.filter((event) => event.type === "planning_checkpoint_rejected"),
			).toEqual([
				expect.objectContaining({
					payload: expect.objectContaining({
						diagnosticLayer: "store_validation",
						diagnosticReason: "evidence_reference_not_persisted_or_wrong_run",
					}),
				}),
			]);
			expect(
				store.listLifecycleEvents(runId).events.filter((event) => event.type === "planning_checkpoint_saved"),
			).toHaveLength(1);
		} finally {
			store.close();
			faux.unregister();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("persists a canonical Native Verifier result and returns its trusted proof through the actual Planning Harness", async () => {
		const root = mkdtempSync(join(tmpdir(), "planning-real-pi-verifier-"));
		const stateDir = join(root, ".state");
		const oracle = await listenMockFlagOracle();
		const env = {
			CTF_ORACLE_URL: oracle.url,
			CTF_ORACLE_TOKEN: "mock-oracle-only",
			CTF_ORACLE_TIMEOUT: "3",
		};
		const config = loadSecHeurConfig({
			projectRoot: root,
			stateDir,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env,
		});
		const store = await PlanningStore.open(join(stateDir, "planning.sqlite"));
		const faux = registerFauxProvider({ tokenSize: { min: 100, max: 100 } });
		let supervisorCalls = 0;
		const lifecycle: Array<{ type: string; payload: Record<string, unknown> }> = [];
		try {
			const { model, modelRuntime } = await localFauxRuntime(faux);
			faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall("verify_flag", { flag: "mock-only-candidate" }, { id: "mock-verifier-call" }),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					fauxToolCall(
						"planning_commit_result",
						{
							outcome: "done",
							summary: "Mock-only verifier accepted; task report committed.",
							suggestedTasks: [],
							flagCandidates: [],
						},
						{ id: "mock-planning-commit" },
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("The mock task report is committed."),
			]);
			const executor = new PiPlanningExecutor({
				config,
				cwd: root,
				model,
				modelRuntime,
				allowedTools: ["verify_flag", "planning_commit_result"],
				createExtensionBundle() {
					const child = createSecHeurExtension({
						config,
						env,
						trustedTaskIdentity: { challengeId: "fixture/challenge", runId: "mock-field-run" },
						requireTrustedChallengeId: true,
					});
					return planningExecutorExtensionBundle(child.extension, () => child.state.close());
				},
				onLifecycleEvent: (type, payload) => lifecycle.push({ type, payload }),
			});
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
							rationale: "Run the canonical verifier in the actual child Pi session.",
							tasks: [
								{
									key: "verify-mock-candidate",
									objective: "Verify the mock-only candidate using the bound challenge identity.",
									doneWhen: "Native verifier evidence is persisted and the task report is committed.",
								},
							],
						};
					},
				},
				executor,
				maximumSteps: 3,
				maximumTasks: 3,
				leaseTtlMs: 30_000,
				maximumEvidenceBytes: 32_768,
				allowedScope: root,
			});
			const result = await controller.execute({
				outerTaskId: "mock-native-verifier-outer",
				goal: "Exercise only the local mocked verifier contract.",
				executeDirect: async () => {
					throw new Error("Direct execution is disabled in this integration test");
				},
			});
			const runId = result.runId;
			if (!runId || !result.snapshot) throw new Error("Controller did not return its completed Planning snapshot");
			const evidence = result.snapshot.evidence.find((item) => item.toolName === "verify_flag");
			expect(result.snapshot.run.status).toBe("completed");
			expect(result.snapshot.tasks[0]?.status).toBe("done");
			expect(result.trustedVerification).toMatchObject({
				source: "planning_verifier_evidence",
				verificationOutcome: "correct",
				planningRunId: runId,
				evidenceId: evidence?.evidenceId,
				challengeId: "fixture/challenge",
			});
			expect(evidence).toMatchObject({
				runId,
				taskId: result.snapshot.tasks[0]?.taskId,
				leaseId: expect.any(String),
				kind: "tool",
				source: "verify_flag",
				metadata: {
					isError: false,
					toolCallId: "mock-verifier-call",
					verificationOutcome: "correct",
				},
			});
			expect(oracle.requests).toEqual([
				{
					flag: "mock-only-candidate",
					challenge_id: "fixture/challenge",
					agent_id: "secheur-pi",
					run_id: "mock-field-run",
				},
			]);
			expect(supervisorCalls).toBe(1);
			expect(faux.state.callCount).toBe(3);
			expect(lifecycle.some((event) => event.type === "required_tool_recovery_start")).toBe(true);
			expect(
				lifecycle.some(
					(event) =>
						event.type === "executor_tool_execution_end" &&
						event.payload.toolName === "verify_flag" &&
						event.payload.isError === false,
				),
			).toBe(true);
			expect(
				store
					.listLifecycleEvents(runId)
					.events.some((event) => event.type === "planning_terminal_evidence_observed"),
			).toBe(true);
		} finally {
			store.close();
			faux.unregister();
			await oracle.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("lets the real session correct an invalid checkpoint reference and then commit", async () => {
		const root = mkdtempSync(join(tmpdir(), "planning-real-pi-correction-"));
		const stateDir = join(root, ".state");
		const store = await PlanningStore.open(join(stateDir, "planning.sqlite"));
		const faux = registerFauxProvider({ tokenSize: { min: 100, max: 100 } });
		try {
			store.createRun({
				runId: "correction-run",
				outerTaskId: "correction-outer",
				goal: "correct checkpoint",
				mode: "active",
			});
			store.commitPlan({
				runId: "correction-run",
				expectedRevision: 0,
				rationale: "test",
				idempotencyKey: "correction-plan",
				tasks: [
					{
						taskId: "correction-task",
						objective: "correct checkpoint",
						doneWhen: "commit",
						priority: 1,
						sequence: 0,
						dependsOnTaskIds: [],
					},
				],
			});
			const lease = store.leaseTask("correction-run", "correction-task", root, 30_000);
			store.startLease(lease.leaseId);
			const { model, modelRuntime } = await localFauxRuntime(faux);
			faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall(
						"planning_checkpoint",
						{
							summary: "invalid reference",
							evidenceRefs: ["foreign-evidence"],
						},
						{ id: "bad-checkpoint" },
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					fauxToolCall(
						"planning_checkpoint",
						{
							summary: "corrected local progress",
							evidenceRefs: [],
						},
						{ id: "good-checkpoint" },
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					fauxToolCall(
						"planning_commit_result",
						{
							outcome: "done",
							summary: "corrected and committed",
							suggestedTasks: [],
							flagCandidates: [],
						},
						{ id: "commit-after-correction" },
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("complete"),
			]);
			const toolEvents: Array<{ toolName?: unknown; isError?: unknown }> = [];
			const report = await new PiPlanningExecutor({
				config: localConfig(root, stateDir),
				cwd: root,
				model,
				modelRuntime,
				onLifecycleEvent: (type, payload) => {
					if (type === "executor_tool_execution_end") toolEvents.push(payload);
				},
			}).execute({
				lease,
				context: "correct the checkpoint",
				recordCheckpoint: (checkpointId, checkpoint) =>
					store.recordCheckpoint(lease.leaseId, checkpointId, checkpoint),
				readEvidence: (evidenceId, offset, maxBytes) =>
					store.readEvidence(lease.runId, evidenceId, { offset, maxBytes }),
			});
			expect(report.commitSource).toBe("planning_commit_result");
			expect(report.result.summary).toBe("corrected and committed");
			expect(store.snapshot("correction-run").latestCheckpoint?.summary).toBe("corrected local progress");
			expect(toolEvents.filter((event) => event.toolName === "planning_checkpoint")).toEqual([
				expect.objectContaining({ isError: true }),
				expect.objectContaining({ isError: false }),
			]);
			expect(faux.state.callCount).toBe(4);
		} finally {
			store.close();
			faux.unregister();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("stops Pi scheduling and recovery after checkpoint storage fails, retaining prior tool evidence", async () => {
		const root = mkdtempSync(join(tmpdir(), "planning-real-pi-"));
		const stateDir = join(root, ".state");
		const store = await PlanningStore.open(join(stateDir, "planning.sqlite"));
		const faux = registerFauxProvider({ tokenSize: { min: 100, max: 100 } });
		const collect = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "durable discovery" }],
			details: { result: "durable discovery" },
		}));
		const shouldNotRun = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "should not run" }],
			details: {},
		}));
		const extension: InlineExtension = {
			name: "local-planning-test-tools",
			factory: (pi) => {
				pi.registerTool({
					name: "collect_local",
					label: "Collect local evidence",
					description: "Return an in-memory test observation",
					parameters: Type.Object({}),
					executionMode: "sequential",
					execute: collect,
				});
				pi.registerTool({
					name: "after_failure",
					label: "After failure",
					description: "This must never be started",
					parameters: Type.Object({}),
					executionMode: "sequential",
					execute: shouldNotRun,
				});
			},
		};
		const { model, modelRuntime } = await localFauxRuntime(faux);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("collect_local", {}, { id: "collect-1" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall(
					"planning_checkpoint",
					{ summary: "saved before fault", evidenceRefs: [] },
					{ id: "checkpoint-1" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("after_failure", {}, { id: "late-1" }), { stopReason: "toolUse" }),
		]);
		const originalCheckpoint = store.recordCheckpoint.bind(store);
		store.recordCheckpoint = (() => {
			throw new PlanningPersistenceError("injected checkpoint write fault");
		}) as PlanningStore["recordCheckpoint"];
		let supervisorCalls = 0;
		let runId = "";
		const lifecycle: string[] = [];
		const errors: unknown[] = [];
		try {
			let observed: unknown;
			try {
				await new ProgressivePlanningController({
					executionMode: resolveExecutionMode({ legacyPlanningMode: "active" }),
					store,
					supervisor: {
						async propose({ snapshot }: { snapshot: PlanningSnapshot }) {
							supervisorCalls += 1;
							runId = snapshot.run.runId;
							return {
								schemaVersion: PLANNING_SCHEMA_VERSION,
								expectedRevision: snapshot.run.revision,
								decision: "create_tasks" as const,
								rationale: "test the actual Pi session",
								tasks: [{ key: "collect", objective: "collect local evidence", doneWhen: "checkpoint saved" }],
							};
						},
					},
					executor: new PiPlanningExecutor({
						config: localConfig(root, stateDir),
						cwd: root,
						model,
						modelRuntime,
						extensionFactories: [extension],
						allowedTools: ["collect_local", "planning_checkpoint", "after_failure", "planning_commit_result"],
						onLifecycleEvent: (type, payload) => {
							lifecycle.push(type);
							if (type.includes("error")) errors.push(payload);
						},
					}),
					maximumSteps: 3,
					maximumTasks: 3,
					leaseTtlMs: 30_000,
					maximumEvidenceBytes: 32_768,
					allowedScope: root,
				}).execute({
					outerTaskId: "real-pi-fault",
					goal: "preserve the observation and stop on storage failure",
					executeDirect: async () => {
						throw new Error("direct mode is forbidden in this test");
					},
				});
			} catch (error) {
				observed = error;
			}
			if ((observed as { code?: string })?.code !== "planning_persistence_error") {
				throw new Error(
					JSON.stringify({
						observed: String(observed),
						lifecycle,
						errors,
						supervisorCalls,
						modelCalls: faux.state.callCount,
						events: store.listLifecycleEvents(runId).events.map((item) => [item.type, item.payload.failureCode]),
					}),
				);
			}
			expect(collect).toHaveBeenCalledOnce();
			expect(shouldNotRun).not.toHaveBeenCalled();
			expect(faux.state.callCount).toBe(2);
			expect(supervisorCalls).toBe(1);
			expect(lifecycle).not.toContain("required_tool_recovery_start");
			const snapshot = store.snapshot(runId);
			expect(snapshot.evidence).toHaveLength(1);
			expect(snapshot.evidence[0]?.toolName).toBe("collect_local");
			expect(store.readEvidence(runId, snapshot.evidence[0]!.evidenceId).content).toContain("durable discovery");
			expect(snapshot.tasks[0]?.status).toBe("failed");
			expect(
				store.listLifecycleEvents(runId).events.find((event) => event.type === "attempt_routing_decided")?.payload,
			).toMatchObject({ routingState: "terminal", replanAllowed: false, replanStarted: false });
		} finally {
			store.recordCheckpoint = originalCheckpoint;
			store.close();
			faux.unregister();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
