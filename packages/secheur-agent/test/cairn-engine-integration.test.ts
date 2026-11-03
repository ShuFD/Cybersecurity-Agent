import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { type Context, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { type InlineExtension, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { loadSecHeurConfig } from "../src/config.ts";
import { CairnPlanningEngine, cairnRunDirectory } from "../src/planning/cairn/engine.ts";
import { CairnHostEvidence } from "../src/planning/cairn/host-evidence.ts";
import { GraphStore } from "../src/planning/cairn/store.ts";
import { PlanningCapacityControl, PlanningExecutorPool } from "../src/planning/execution-pool.ts";
import { PiCodingSessionOwner, runPiCodingTask } from "../src/subagent.ts";

const sharedPlanningExecutorPool = new PlanningExecutorPool(2);

it("publishes shared cards and links checkpoint Facts on the actual Pi tool path without capturing board reads as evidence", async () => {
	const root = mkdtempSync(join(tmpdir(), "cairn-shared-card-"));
	const faux = registerFauxProvider();
	let evidenceId = "";
	const summary = "Local fixture observed an exact count of sixty-eight.";
	faux.setResponses(
		Array.from({ length: 12 }, () => (context: Context) => {
			const last = context.messages.at(-1);
			if (last?.role === "toolResult" && last.toolName === "shared_fixture")
				return tool("graph_list_evidence", {}, "catalog");
			if (last?.role === "toolResult" && last.toolName === "graph_list_evidence") {
				const text = last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
				evidenceId = JSON.parse(text).items[0].evidenceId as string;
				return tool(
					"planning_publish_evidence_card",
					{
						summary,
						keyValues: { count: 68 },
						scope: "local fixture",
						limitations: "not goal verification",
						evidenceRefs: [evidenceId],
						basis: "observed",
					},
					"card",
				);
			}
			if (last?.role === "toolResult" && last.toolName === "planning_publish_evidence_card")
				return tool(
					"conclude_intent",
					{ outcome: "success", facts: [{ kind: "fact", statement: summary, evidenceRefs: [evidenceId] }] },
					"finish",
				);
			return tool("shared_fixture", {}, "observe");
		}),
	);
	const extension: InlineExtension = {
		name: "shared-fixture",
		factory(pi) {
			pi.registerTool({
				name: "shared_fixture",
				label: "Fixture",
				description: "Offline fixture",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "count=68" }], details: { count: 68 } }),
			});
		},
	};
	try {
		const config = configAt(root);
		const result = await new CairnPlanningEngine({
			config,
			cwd: root,
			...(await runtime(faux)),
			executorPool: sharedPlanningExecutorPool,
			capacityControl: new PlanningCapacityControl(1),
			extensionFactories: [extension],
			reasonModel: { generate: async () => proposal(["local-card-fixture"]) },
		}).execute({ outerTaskId: "shared-cards", goal: "Offline card handoff", signal: AbortSignal.timeout(10_000) });
		const host = new CairnHostEvidence(join(cairnRunDirectory(config.stateDir, result.runId), "host.sqlite"));
		try {
			expect(host.listAll(result.runId)).toHaveLength(1);
			expect(
				host
					.cards(result.runId)
					.some((card) => card.keyValues.count === 68 && card.evidenceRefs.includes(evidenceId)),
			).toBe(true);
			const fact = result.graph.facts.find((fact) => fact.statement === summary)!;
			expect(fact).toBeDefined();
			expect(host.cards(result.runId).some((card) => card.keyValues.cairnFactId === fact.id)).toBe(true);
			expect(host.proof(result.runId)).toBeUndefined();
		} finally {
			host.close();
		}
	} finally {
		faux.unregister();
		rmSync(root, { recursive: true, force: true });
	}
});

it("surfaces a permanent executor request failure through the existing engine failure boundary", async () => {
	const root = mkdtempSync(join(tmpdir(), "cairn-invalid-request-"));
	const faux = registerFauxProvider();
	faux.setResponses([
		fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage:
				'400: {"error":{"message":"Invalid schema for function conclude_intent","type":"invalid_request_error"}}',
		}),
	]);
	const pool = new PlanningExecutorPool(1);
	try {
		await expect(
			new CairnPlanningEngine({
				config: configAt(root),
				cwd: root,
				executorPool: pool,
				...(await runtime(faux)),
				capacityControl: new PlanningCapacityControl(1),
				reasonModel: { generate: async () => proposal(["request-validation-fixture"]) },
			}).execute({
				outerTaskId: "invalid-request",
				goal: "Synthetic request validation",
				signal: AbortSignal.timeout(5_000),
			}),
		).rejects.toMatchObject({ code: "model_invalid_request" });
		expect(faux.state.callCount).toBe(1);
		expect(pool.getStatus().active).toBe(0);
	} finally {
		faux.unregister();
		rmSync(root, { recursive: true, force: true });
	}
});

function configAt(root: string) {
	const config = loadSecHeurConfig({
		projectRoot: root,
		stateDir: join(root, "state"),
		legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
		env: {},
	});
	config.agentDir = join(root, "pi");
	config.skillPaths = [];
	config.systemPromptPath = "";
	config.knowledgeBaseEnabled = false;
	config.planning.engine = "cairn";
	config.planning.maxSteps = 1;
	config.planning.maxTasks = 8;
	config.planning.taskTimeoutMs = 10_000;
	return config;
}
async function runtime(faux: ReturnType<typeof registerFauxProvider>) {
	const model = faux.getModel();
	const credentials = AuthStorage.inMemory();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "local-faux-only" }));
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
	return { model, modelRuntime };
}
function proposal(routes: string[], tags: string[] = []) {
	return {
		text: JSON.stringify({
			rationaleSummary: "Execute independent local fixture routes",
			proposedIntents: routes.map((objective, index) => ({
				clientId: objective,
				objective,
				successCriteria: ["Save a local observation"],
				rationale: "Independent route",
				fromFactIds: [],
				sourceHintIds: [],
				capabilityTags: tags,
				priority: 10 - index,
				supersedesIntentIds: [],
			})),
			supersedeRecommendations: [],
		}),
		model: "fixture",
		provider: "fixture",
	};
}
function lastTask(context: Context): string {
	const user = [...context.messages].reverse().find((message) => message.role === "user");
	if (!user) return "";
	return typeof user.content === "string"
		? user.content
		: user.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
}
function tool(name: string, args: Record<string, unknown>, id: string) {
	return fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
}
it("injects durable verifier feedback and another task's latest checkpoint into actual Pi requests", async () => {
	const root = mkdtempSync(join(tmpdir(), "cairn-feedback-handoff-"));
	const faux = registerFauxProvider({ tokenSize: { min: 100, max: 100 } });
	let firstTurns = 0;
	let sawOwnFeedback = false;
	let sawHandoff = false;
	const extension: InlineExtension = {
		name: "feedback-handoff-fixture",
		factory(pi) {
			pi.registerTool({
				name: "verify_flag",
				label: "Fixture verification",
				description: "Local fixture only",
				parameters: Type.Object({}),
				execute: async () => ({
					content: [{ type: "text", text: "fixture incorrect" }],
					details: {
						data: { status: "incorrect", verificationOutcome: "incorrect", requestSent: true },
						remainingAttempts: 2,
					},
				}),
			});
			pi.registerTool({
				name: "update_working_checkpoint",
				label: "Fixture checkpoint",
				description: "Save a local fixture report",
				parameters: Type.Object({ completed: Type.String(), next: Type.String() }),
				execute: async () => ({ content: [{ type: "text", text: "saved" }], details: {} }),
			});
		},
	};
	faux.setResponses(
		Array.from({ length: 8 }, () => (context: Context) => {
			const text = JSON.stringify(context.messages);
			if (!lastTask(context).includes("second-route")) {
				firstTurns++;
				if (firstTurns === 1) return tool("verify_flag", {}, "fixture-verification");
				if (firstTurns === 2) {
					sawOwnFeedback =
						text.includes("[Shared native verification history]") &&
						text.includes("remainingAttempts") &&
						text.includes("incorrect");
					return tool(
						"update_working_checkpoint",
						{ completed: "fixture-shared-progress", next: "fixture-next-step" },
						"fixture-checkpoint",
					);
				}
			} else {
				sawHandoff =
					text.includes("[Shared task progress;") &&
					text.includes("fixture-shared-progress") &&
					text.includes("fixture-next-step") &&
					text.includes("[Shared native verification history]");
			}
			return tool("conclude_intent", { outcome: "inconclusive" }, `fixture-finish-${firstTurns}`);
		}),
	);
	try {
		const config = configAt(root);
		const result = await new CairnPlanningEngine({
			config,
			cwd: root,
			...(await runtime(faux)),
			executorPool: new PlanningExecutorPool(1),
			capacityControl: new PlanningCapacityControl(1),
			extensionFactories: [extension],
			reasonModel: { generate: async () => proposal(["first-route", "second-route"]) },
		}).execute({
			outerTaskId: "feedback-handoff",
			goal: "Synthetic shared feedback",
			signal: AbortSignal.timeout(10_000),
		});
		expect(sawOwnFeedback).toBe(true);
		expect(sawHandoff).toBe(true);
		expect(result.graph.intents.filter((intent) => intent.status === "concluded")).toHaveLength(2);
	} finally {
		faux.unregister();
		rmSync(root, { recursive: true, force: true });
	}
});

describe("Cairn harness on the shared actual Pi runtime", () => {
	it("runs the copied Reason generation and parser with real Pi instead of an injected Reason model", async () => {
		const root = mkdtempSync(join(tmpdir(), "cairn-source-reason-model-"));
		const faux = registerFauxProvider({ tokenSize: { min: 100, max: 100 } });
		const reasonContexts: Context[] = [];
		faux.setResponses(
			Array.from({ length: 4 }, () => (context: Context) => {
				if (lastTask(context).includes("<UNTRUSTED_REASON_CONTEXT>")) {
					reasonContexts.push(context);
					return tool(
						"submit_planning_proposal",
						JSON.parse(proposal(["copied-route"]).text),
						"reason-submission",
					);
				}
				return tool(
					"conclude_intent",
					{ outcome: "success", facts: [{ kind: "fact", statement: "local observation" }] },
					"conclude",
				);
			}),
		);
		try {
			const result = await new CairnPlanningEngine({
				executorPool: sharedPlanningExecutorPool,
				config: configAt(root),
				cwd: root,
				...(await runtime(faux)),
				capacityControl: new PlanningCapacityControl(1),
			}).execute({ outerTaskId: "copied", goal: "Local fixture", signal: AbortSignal.timeout(10_000) });
			expect(reasonContexts).toHaveLength(1);
			expect(reasonContexts[0].tools?.map((item) => item.name).sort()).toEqual(["submit_planning_proposal"]);
			expect(reasonContexts[0].messages).toHaveLength(1);
			expect(JSON.stringify(reasonContexts[0].messages)).toContain("selectionCatalog");
			expect(reasonContexts[0].systemPrompt).toContain("You are the planner");
			const graph = new GraphStore(join(cairnRunDirectory(configAt(root).stateDir, result.runId), "graph.sqlite"));
			try {
				expect(graph.listReasonProposals(result.runId, 10)[0].status).toBe("applied");
			} finally {
				graph.close();
			}
			expect(result.graph.intents[0].status).toBe("concluded");
		} finally {
			faux.unregister();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("waits for a pending trigger beyond 100 completed entries instead of ending idle", async () => {
		const root = mkdtempSync(join(tmpdir(), "cairn-trigger-history-"));
		const config = configAt(root);
		config.planning.maxSteps = 2;
		let calls = 0;
		try {
			const result = await new CairnPlanningEngine({
				executorPool: sharedPlanningExecutorPool,
				config,
				cwd: root,
				capacityControl: new PlanningCapacityControl(1),
				onRunStarted: async (runId) => {
					const history = new GraphStore(join(cairnRunDirectory(config.stateDir, runId), "graph.sqlite"));
					try {
						history.initialize();
						history.ensureServiceChallenge(runId);
						for (let i = 0; i <= 100; i++) {
							const time =
								i === 100
									? new Date(Date.now() + 1_200).toISOString()
									: new Date(Date.UTC(2000, 0, 1) + i).toISOString();
							const sequence = history.appendServiceEvent({
								challengeId: runId,
								type: "reason_trigger_ensured",
								entityId: runId,
								actorId: "host",
								idempotencyKey: `history-${i}`,
								payload: {},
								createdAt: time,
							});
							history.insertReasonTrigger({
								id: `history-${i}`,
								challengeId: runId,
								reason: "fact_confirmed",
								sourceEventSequence: sequence,
								sourceEntityId: `history-${i}`,
								payloadFingerprint: `history-${i}`,
								status: i === 100 ? "pending" : "completed",
								attemptCount: 0,
								notBefore: time,
								createdAt: time,
								updatedAt: time,
							});
						}
					} finally {
						history.close();
					}
				},
				reasonModel: {
					generate: async () => {
						calls++;
						return proposal([`history-fixture-${calls}`], ["unavailable-fixture-profile"]);
					},
				},
			}).execute({
				outerTaskId: "trigger-history",
				goal: "Drain all pending work",
				signal: AbortSignal.timeout(5_000),
			});
			expect(calls).toBe(2);
			const saved = new GraphStore(join(cairnRunDirectory(config.stateDir, result.runId), "graph.sqlite"));
			try {
				saved.initialize();
				expect(saved.readReasonTrigger(result.runId, "history-100")?.status).toBe("completed");
			} finally {
				saved.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 10_000);

	it("compensates a slot stolen between planning and reuse, retries without queuing, and still concludes", async () => {
		const root = mkdtempSync(join(tmpdir(), "cairn-slot-race-"));
		const faux = registerFauxProvider({ tokenSize: { min: 100, max: 100 } });
		const oldCapacity = sharedPlanningExecutorPool.getStatus().capacity;
		sharedPlanningExecutorPool.setCapacity(1);
		const reserve = sharedPlanningExecutorPool.tryAcquire.bind(sharedPlanningExecutorPool);
		let attempts = 0,
			calls = 0,
			busyWaiters = -1;
		let releaseOther: (() => void) | undefined;
		let releaseTimer: ReturnType<typeof setTimeout> | undefined;
		const reservation = vi.spyOn(sharedPlanningExecutorPool, "tryAcquire").mockImplementation(() => {
			attempts++;
			if (attempts === 2) {
				releaseOther = reserve();
				const result = reserve();
				busyWaiters = sharedPlanningExecutorPool.getStatus().waiting;
				releaseTimer = setTimeout(() => releaseOther?.(), 800);
				return result;
			}
			return reserve();
		});
		try {
			const conclusion = tool(
				"conclude_intent",
				{ outcome: "partial", facts: [{ kind: "fact", statement: "saved local progress" }] },
				"repeated-conclude",
			);
			faux.setResponses([conclusion, conclusion]);
			const config = configAt(root);
			config.planning.maxSteps = 2;
			const result = await new CairnPlanningEngine({
				executorPool: sharedPlanningExecutorPool,
				config,
				cwd: root,
				...(await runtime(faux)),
				capacityControl: new PlanningCapacityControl(1),
				reasonModel: { generate: async () => proposal([++calls === 1 ? "first-route" : "next-route"]) },
			}).execute({
				outerTaskId: "slot-race",
				goal: "Retry busy execution slot",
				signal: AbortSignal.timeout(8_000),
			});
			expect(attempts).toBeGreaterThanOrEqual(3);
			expect(busyWaiters).toBe(0);
			expect(result.graph.intents).toHaveLength(2);
			expect(result.graph.intents.every((intent) => intent.status === "concluded")).toBe(true);
			expect(sharedPlanningExecutorPool.getStatus()).toEqual({ capacity: 1, active: 0, waiting: 0 });
		} finally {
			if (releaseTimer) clearTimeout(releaseTimer);
			releaseOther?.();
			reservation.mockRestore();
			sharedPlanningExecutorPool.setCapacity(oldCapacity);
			faux.unregister();
			rmSync(root, { recursive: true, force: true });
		}
	}, 12_000);

	it("rolls a third Intent into a freed Solver while another remains active, retaining current-lease handoff", async () => {
		const root = mkdtempSync(join(tmpdir(), "cairn-rolling-"));
		const faux = registerFauxProvider({ tokenSize: { min: 100, max: 100 } });
		const savedCapacity = sharedPlanningExecutorPool.getStatus().capacity;
		sharedPlanningExecutorPool.setCapacity(2);
		const sessions = new Map<string, string>();
		const closed = vi.fn();
		let active = 0,
			maxActive = 0,
			thirdStarted = false;
		let releaseThird = () => {};
		const third = new Promise<void>((resolvePromise) => {
			releaseThird = resolvePromise;
		});
		const extension: InlineExtension = {
			name: "local-observation",
			factory: (pi) => {
				pi.registerTool({
					name: "observe_fixture",
					label: "Observe",
					description: "Local fixture observation",
					parameters: Type.Object({ route: Type.String() }),
					async execute(_id, args, _signal, _update, ctx) {
						sessions.set(args.route, ctx.sessionManager.getSessionId());
						active++;
						maxActive = Math.max(maxActive, active);
						try {
							if (args.route === "route-B") await Promise.race([third, wait(4_000)]);
							if (args.route === "route-C") {
								thirdStarted = true;
								releaseThird();
							}
							return {
								content: [{ type: "text", text: "observation " + args.route }],
								details: { route: args.route },
							};
						} finally {
							active--;
						}
					},
				});
			},
		};
		faux.setResponses(
			Array.from({ length: 30 }, () => (context: Context) => {
				const route = /Primary Graph Intent: (route-[ABC])/.exec(lastTask(context))?.[1];
				if (!route) throw new Error("Missing current Intent context");
				const last = context.messages.at(-1);
				if (last?.role === "toolResult" && last.toolName === "observe_fixture")
					return tool(
						"checkpoint_intent",
						{ facts: [{ kind: "fact", statement: "observed " + route }] },
						route + "-checkpoint",
					);
				if (last?.role === "toolResult" && last.toolName === "checkpoint_intent")
					return tool(
						"conclude_intent",
						{ outcome: "success", facts: [{ kind: "fact", statement: "finished " + route }] },
						"shared-conclude",
					);
				return tool("observe_fixture", { route }, route + "-observe");
			}),
		);
		try {
			const config = configAt(root);
			config.planning.maxSteps = 2;
			let reasonCalls = 0;
			const reasonModel = {
				generate: vi.fn(async () => proposal(++reasonCalls === 1 ? ["route-A", "route-B"] : ["route-C"])),
			};
			const engine = new CairnPlanningEngine({
				executorPool: sharedPlanningExecutorPool,
				config,
				cwd: root,
				...(await runtime(faux)),
				capacityControl: new PlanningCapacityControl(2),
				reasonModel,
				createExtensionBundle: () => ({ extensionFactories: [extension], close: closed }),
			});
			const result = await engine.execute({
				outerTaskId: "rolling",
				goal: "Local parallel workflow",
				signal: AbortSignal.timeout(15_000),
			});
			if (result.graph.intents.some((intent) => intent.outcome !== "success")) {
				const diagnostic = new CairnHostEvidence(
					join(cairnRunDirectory(config.stateDir, result.runId), "host.sqlite"),
				);
				try {
					throw new Error(
						JSON.stringify({
							intents: result.graph.intents,
							events: diagnostic.events(result.runId, 0, 1000).events,
						}),
					);
				} finally {
					diagnostic.close();
				}
			}
			expect(result.status).toBe("exhausted");
			expect(result.graph.intents).toHaveLength(3);
			expect(
				result.graph.intents.every((intent) => intent.status === "concluded" && intent.outcome === "success"),
			).toBe(true);
			expect(thirdStarted).toBe(true);
			expect(reasonModel.generate).toHaveBeenCalledTimes(2);
			expect(maxActive).toBe(2);
			expect(new Set(sessions.values()).size).toBe(2);
			expect(sessions.get("route-C")).toBe(sessions.get("route-A"));
			expect(result.graph.facts.filter((fact) => fact.statement.startsWith("finished "))).toHaveLength(3);
			expect(existsSync(join(config.stateDir, "planning.sqlite"))).toBe(false);
			const directory = cairnRunDirectory(config.stateDir, result.runId);
			const evidence = new CairnHostEvidence(join(directory, "host.sqlite"));
			try {
				expect(evidence.list(result.runId).items).toHaveLength(3);
				const events = evidence.events(result.runId, 0, 1000).events;
				expect(events.filter((event) => event.type === "cairn_submission_durable")).toHaveLength(6);
				expect(events.filter((event) => event.type === "cairn_executor_error")).toHaveLength(0);
			} finally {
				evidence.close();
			}
			const reopened = new GraphStore(join(directory, "graph.sqlite"));
			reopened.initialize();
			expect(reopened.readServiceGraph(result.runId)).toEqual(result.graph);
			reopened.close();
			expect(sharedPlanningExecutorPool.getStatus().active).toBe(0);
			expect(closed).toHaveBeenCalledTimes(2);
		} finally {
			releaseThird();
			faux.unregister();
			sharedPlanningExecutorPool.setCapacity(savedCapacity);
			rmSync(root, { recursive: true, force: true });
		}
	}, 20_000);

	it("returns idle for an unschedulable profile instead of hanging, without starting a Solver", async () => {
		const root = mkdtempSync(join(tmpdir(), "cairn-idle-"));
		const createBundle = vi.fn();
		try {
			const result = await new CairnPlanningEngine({
				executorPool: sharedPlanningExecutorPool,
				config: configAt(root),
				cwd: root,
				capacityControl: new PlanningCapacityControl(2),
				reasonModel: { generate: async () => proposal(["unavailable-route"], ["unavailable-profile"]) },
				createExtensionBundle: createBundle,
			}).execute({ outerTaskId: "idle", goal: "No matching local profile", signal: AbortSignal.timeout(3_000) });
			expect(result.status).toBe("exhausted");
			expect(result.graph.intents[0].status).toBe("open");
			expect(createBundle).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("recovers a missing conclusion using the existing required-tool recovery", async () => {
		const root = mkdtempSync(join(tmpdir(), "cairn-recovery-"));
		const faux = registerFauxProvider({ tokenSize: { min: 100, max: 100 } });
		faux.setResponses([
			fauxAssistantMessage("Local work complete; no tool yet."),
			tool(
				"conclude_intent",
				{ outcome: "partial", facts: [{ kind: "fact", statement: "recovered local progress" }] },
				"recovered",
			),
		]);
		try {
			const config = configAt(root);
			const result = await new CairnPlanningEngine({
				executorPool: sharedPlanningExecutorPool,
				config,
				cwd: root,
				...(await runtime(faux)),
				capacityControl: new PlanningCapacityControl(1),
				reasonModel: { generate: async () => proposal(["recovery-route"]) },
			}).execute({ outerTaskId: "recovery", goal: "Recover local report", signal: AbortSignal.timeout(8_000) });
			expect(result.graph.intents[0].outcome).toBe("partial");
			const host = new CairnHostEvidence(join(cairnRunDirectory(config.stateDir, result.runId), "host.sqlite"));
			try {
				expect(
					host.events(result.runId).events.some((event) => event.type === "cairn_required_tool_recovery_start"),
				).toBe(true);
			} finally {
				host.close();
			}
			expect(sharedPlanningExecutorPool.getStatus().active).toBe(0);
		} finally {
			faux.unregister();
			rmSync(root, { recursive: true, force: true });
		}
	}, 10_000);

	it("cancels active Solvers, waits for tools to settle, then releases the shared slot", async () => {
		const root = mkdtempSync(join(tmpdir(), "cairn-cancel-"));
		const faux = registerFauxProvider({ tokenSize: { min: 100, max: 100 } });
		const controller = new AbortController();
		let started = () => {};
		let release = () => {};
		const ready = new Promise<void>((resolvePromise) => {
			started = resolvePromise;
		});
		const held = new Promise<void>((resolvePromise) => {
			release = resolvePromise;
		});
		const close = vi.fn();
		let finished = false;
		const extension: InlineExtension = {
			name: "local-held",
			factory: (pi) => {
				pi.registerTool({
					name: "held_fixture",
					label: "Held",
					description: "Wait for test release",
					parameters: Type.Object({}),
					async execute() {
						started();
						await held;
						finished = true;
						return { content: [{ type: "text", text: "settled" }], details: {} };
					},
				});
			},
		};
		faux.setResponses([tool("held_fixture", {}, "held")]);
		try {
			const config = configAt(root);
			const operation = new CairnPlanningEngine({
				executorPool: sharedPlanningExecutorPool,
				config,
				cwd: root,
				...(await runtime(faux)),
				capacityControl: new PlanningCapacityControl(1),
				reasonModel: { generate: async () => proposal(["cancel-route"]) },
				createExtensionBundle: () => ({ extensionFactories: [extension], close }),
			}).execute({ outerTaskId: "cancel", goal: "Local cancellation", signal: controller.signal });
			const caught = operation.catch((error) => error);
			await ready;
			controller.abort(new Error("cancel fixture"));
			await wait(50);
			expect(sharedPlanningExecutorPool.getStatus().active).toBe(1);
			expect(close).not.toHaveBeenCalled();
			release();
			expect(await caught).toEqual(new Error("cancel fixture"));
			expect(finished).toBe(true);
			expect(close).toHaveBeenCalledOnce();
			expect(sharedPlanningExecutorPool.getStatus().active).toBe(0);
		} finally {
			release();
			controller.abort();
			faux.unregister();
			rmSync(root, { recursive: true, force: true });
		}
	}, 10_000);

	it("retains earlier tool evidence and a failure handoff when an Intent hits its hard deadline", async () => {
		const root = mkdtempSync(join(tmpdir(), "cairn-timeout-"));
		const faux = registerFauxProvider({ tokenSize: { min: 100, max: 100 } });
		const extension: InlineExtension = {
			name: "local-timeout",
			factory: (pi) => {
				pi.registerTool({
					name: "fast_fixture",
					label: "Fast",
					description: "Save a local observation",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "saved before timeout" }], details: {} }),
				});
				pi.registerTool({
					name: "waiting_fixture",
					label: "Waiting",
					description: "Cooperative local wait",
					parameters: Type.Object({}),
					execute: async (_id, _args, signal) => {
						await wait(5_000, undefined, { signal });
						return { content: [{ type: "text", text: "late" }], details: {} };
					},
				});
			},
		};
		faux.setResponses([tool("fast_fixture", {}, "fast"), tool("waiting_fixture", {}, "waiting")]);
		try {
			const config = configAt(root);
			config.planning.taskTimeoutMs = 800;
			const result = await new CairnPlanningEngine({
				executorPool: sharedPlanningExecutorPool,
				config,
				cwd: root,
				...(await runtime(faux)),
				capacityControl: new PlanningCapacityControl(1),
				reasonModel: { generate: async () => proposal(["timeout-route"]) },
				extensionFactories: [extension],
			}).execute({ outerTaskId: "timeout", goal: "Local deadline", signal: AbortSignal.timeout(8_000) });
			expect(result.graph.intents[0]).toMatchObject({ status: "concluded", outcome: "failure" });
			expect(result.graph.facts.some((fact) => fact.kind === "failure_boundary")).toBe(true);
			const host = new CairnHostEvidence(join(cairnRunDirectory(config.stateDir, result.runId), "host.sqlite"));
			try {
				expect(host.list(result.runId).items).toHaveLength(1);
				expect(host.events(result.runId).events).toContainEqual(
					expect.objectContaining({
						type: "cairn_executor_error",
						payload: expect.objectContaining({ failureCode: "executor_timeout" }),
					}),
				);
				expect(host.events(result.runId).events).toContainEqual(
					expect.objectContaining({
						type: "cairn_submission_durable",
						payload: expect.objectContaining({ durable: true, status: "runtime_failure" }),
					}),
				);
			} finally {
				host.close();
			}
			expect(sharedPlanningExecutorPool.getStatus().active).toBe(0);
		} finally {
			faux.unregister();
			rmSync(root, { recursive: true, force: true });
		}
	}, 10_000);

	it("supports sequential Pi session reuse without permitting concurrent prompts on the same owner", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-owner-"));
		const faux = registerFauxProvider({ tokenSize: { min: 100, max: 100 } });
		const owner = new PiCodingSessionOwner();
		faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		try {
			const options = {
				config: configAt(root),
				cwd: root,
				...(await runtime(faux)),
				sessionOwner: owner,
				allowedTools: [],
			};
			await runPiCodingTask({ ...options, task: "first" });
			const first = owner.session;
			await runPiCodingTask({ ...options, task: "second" });
			expect(owner.session).toBe(first);
			expect(first?.messages.filter((message) => message.role === "user")).toHaveLength(2);
			owner.inUse = true;
			await expect(runPiCodingTask({ ...options, task: "overlap" })).rejects.toThrow("already has an active task");
			owner.inUse = false;
			owner.dispose();
			expect(owner.session).toBeUndefined();
		} finally {
			owner.inUse = false;
			owner.dispose();
			faux.unregister();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
