import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { type AgentSession, type InlineExtension, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { loadSecHeurConfig } from "../src/config.ts";
import { resolveExecutionMode } from "../src/execution-mode.ts";
import { CairnPlanningEngine, cairnRunDirectory } from "../src/planning/cairn/engine.ts";
import { CairnHostEvidence } from "../src/planning/cairn/host-evidence.ts";
import { PlanningCapacityControl } from "../src/planning/execution-pool.ts";
import { attachProgressivePlanningController } from "../src/planning/session-controller.ts";
import { runPiCodingTask } from "../src/subagent.ts";

function proposal(tags: string[] = []) {
	return {
		text: JSON.stringify({
			rationaleSummary: "Independent local fixture",
			proposedIntents: [0, 1].map((i) => ({
				clientId: `fixture-${i}`,
				objective: `Local fixture ${i}`,
				successCriteria: ["Host observation"],
				rationale: "Independent local work",
				fromFactIds: [],
				sourceHintIds: [],
				capabilityTags: tags,
				priority: 2 - i,
				supersedesIntentIds: [],
			})),
			supersedeRecommendations: [],
		}),
		model: "fixture",
		provider: "fixture",
	};
}

async function fixture(delayMs = 0, quota = false) {
	const root = mkdtempSync(join(tmpdir(), "cairn-managed-"));
	const faux = registerFauxProvider({ tokenSize: { min: 100, max: 100 } });
	const model = faux.getModel();
	const credentials = AuthStorage.inMemory();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "local-faux-only" }));
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
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
	config.planning.maxTasks = 1;
	config.planning.taskTimeoutMs = 5;
	const extension: InlineExtension = {
		name: "local-native-verifier-fixture",
		factory: (pi) => {
			pi.registerTool({
				name: "verify_flag",
				label: "Verify local fixture",
				description: "Synthetic host verification",
				parameters: Type.Object({}),
				execute: async (_id, _args, signal) => {
					await wait(delayMs, undefined, { signal });
					const data = quota
						? {
								verificationOutcome: "infra_error",
								failureCategory: "quota_exhausted",
								message: "Local fixture quota exhausted",
							}
						: { ok: true, verified: true, status: "correct", challenge_id: "local-fixture" };
					return { content: [{ type: "text", text: JSON.stringify(data) }], details: { data } };
				},
			});
		},
	};
	faux.setResponses(
		Array.from({ length: 40 }, (_, i) =>
			fauxAssistantMessage(fauxToolCall("verify_flag", {}, { id: `verify-${i}` }), { stopReason: "toolUse" }),
		),
	);
	return {
		root,
		config,
		model,
		modelRuntime,
		faux,
		extensionFactories: [extension],
		cleanup: () => {
			faux.unregister();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

describe("managed Cairn recovery boundaries on real Pi", () => {
	it.each([false, true])(
		"keeps work tools usable through required-result recovery without premature managed handoff (managed=%s)",
		async (managed) => {
			const f = await fixture();
			let work = 0;
			let reports = 0;
			const extension: InlineExtension = {
				name: "protocol-repair-fixture",
				factory: (pi) => {
					for (const name of ["work_step", "required_result"])
						pi.registerTool({
							name,
							label: name,
							description: "Local protocol repair fixture",
							parameters: Type.Object({}),
							execute: async () => {
								if (name === "work_step") work++;
								else reports++;
								return {
									content: [{ type: "text", text: "accepted local observation" }],
									details: { accepted: true },
								};
							},
						});
				},
			};
			f.faux.setResponses([
				fauxAssistantMessage("A further observation is needed."),
				...(managed
					? Array.from({ length: 3 }, () =>
							fauxAssistantMessage("Work remains unfinished; continue this owned task."),
						)
					: []),
				(context) =>
					fauxAssistantMessage(
						fauxToolCall(
							context.tools?.some((tool) => tool.name === "work_step") ? "work_step" : "missing_work_tool",
							{},
							{ id: "repair-work" },
						),
						{ stopReason: "toolUse" },
					),
				fauxAssistantMessage(fauxToolCall("required_result", {}, { id: "repair-report" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Report persisted."),
			]);
			try {
				const result = await runPiCodingTask({
					...f,
					cwd: f.root,
					task: "Local result repair",
					extensionFactories: [extension],
					allowedTools: ["work_step", "required_result"],
					requiredToolName: "required_result",
					continueUntilRequiredTool: managed,
					requiredToolRecoveryAttempts: 1,
					signal: AbortSignal.timeout(5_000),
				});
				expect(work).toBe(1);
				expect(reports).toBe(1);
				expect(result.toolExecutions.every((execution) => !execution.isError)).toBe(true);
				expect(result.toolExecutions.map((execution) => execution.toolName)).toEqual([
					"work_step",
					"required_result",
				]);
			} finally {
				f.cleanup();
			}
		},
	);
	it.each(["one-route", "malformed"])(
		"preserves the supported single route with %s output without inventing a filler task",
		async (mode) => {
			const f = await fixture(80);
			let calls = 0;
			try {
				const result = await new CairnPlanningEngine({
					...f,
					cwd: f.root,
					requireTrustedCompletion: true,
					capacityControl: new PlanningCapacityControl(2),
					reasonModel: {
						generate: async () => {
							calls++;
							const data = proposal();
							if (mode === "malformed" && calls <= 2) return { ...data, text: "not valid JSON" };
							const parsed = JSON.parse(data.text);
							parsed.proposedIntents = parsed.proposedIntents.slice(0, 1);
							return { ...data, text: JSON.stringify(parsed) };
						},
					},
				}).execute({ outerTaskId: mode, goal: "Synthetic local fixture", signal: AbortSignal.timeout(5_000) });
				expect(result.status).toBe("completed");
				expect(result.graph.intents.filter((intent) => intent.attemptCount > 0)).toHaveLength(1);
				expect(result.trustedVerification?.verificationOutcome).toBe("correct");
				expect(calls).toBe(mode === "malformed" ? 3 : 1);
			} finally {
				f.cleanup();
			}
		},
	);
	it.each([false, true])(
		"charges the parent outer budget and preserves proof on its last turn (accepted=%s)",
		async (accepted) => {
			const f = await fixture();
			const acceptedCallback = vi.fn(() => true);
			const costs: number[] = [];
			f.config.executionMode = resolveExecutionMode({ mode: "plan_multi", capacity: 2 });
			f.faux.setResponses(
				Array.from(
					{ length: 10 },
					() => (context) =>
						context.tools?.some((t) => t.name === "submit_planning_proposal")
							? fauxAssistantMessage(
									fauxToolCall("submit_planning_proposal", JSON.parse(proposal().text), {
										id: "reason-submit",
									}),
									{ stopReason: "toolUse" },
								)
							: fauxAssistantMessage(fauxToolCall("verify_flag", {}, { id: "verified-local" }), {
									stopReason: "toolUse",
								}),
				),
			);
			const send = vi.fn(async (message: { customType: string }) => {
				if (message.customType === "cairn-planning-result") throw new Error("Local notification failure");
			});
			const session = {
				sessionId: "local-budget",
				model: f.model,
				modelRuntime: f.modelRuntime,
				thinkingLevel: "off",
				prompt: vi.fn(),
				sendCustomMessage: send,
			} as unknown as AgentSession;
			const binding = attachProgressivePlanningController(session, {
				config: f.config,
				cwd: f.root,
				createExtensionBundle: () => ({ extensionFactories: f.extensionFactories, close: () => {} }),
				onTrustedPlanningVerification: acceptedCallback,
				onModelTurn: (cost) => {
					costs.push(cost);
					return { stopped: accepted ? costs.length >= 2 : true, message: "Outer budget fixture exhausted" };
				},
			});
			try {
				if (accepted) {
					await session.prompt("Local budget and proof fixture");
					expect(acceptedCallback).toHaveBeenCalledOnce();
					expect(costs.length).toBeGreaterThanOrEqual(2);
					expect(send).toHaveBeenCalledWith(expect.objectContaining({ customType: "cairn-planning-result" }), {
						triggerTurn: false,
					});
				} else {
					await expect(session.prompt("Local budget fixture")).rejects.toThrow("Outer budget fixture exhausted");
					expect(acceptedCallback).not.toHaveBeenCalled();
					expect(costs).toHaveLength(1);
				}
			} finally {
				binding.close();
				f.cleanup();
			}
		},
		10_000,
	);
	it("recovers unschedulable tags after bounded corrections without applying inner step/task caps", async () => {
		const f = await fixture();
		let calls = 0;
		try {
			const engine = new CairnPlanningEngine({
				...f,
				cwd: f.root,
				requireTrustedCompletion: true,
				capacityControl: new PlanningCapacityControl(2),
				reasonModel: { generate: async () => proposal(++calls <= 2 ? ["unavailable-fixture-profile"] : []) },
			});
			const result = await engine.execute({
				outerTaskId: "managed",
				goal: "Local fixtures",
				signal: AbortSignal.timeout(40_000),
			});
			expect(calls).toBe(3);
			expect(result.status).toBe("completed");
			expect(result.graph.intents).toHaveLength(2);
			expect(result.graph.intents.every((i) => i.capabilityTags.length === 0)).toBe(true);
			expect(result.trustedVerification?.verificationOutcome).toBe("correct");
		} finally {
			f.cleanup();
		}
	}, 45_000);
	it("lets active tools finish beyond the obsolete child deadline and counts their Pi turns", async () => {
		const f = await fixture(80);
		const turns = vi.fn();
		try {
			const result = await new CairnPlanningEngine({
				...f,
				cwd: f.root,
				requireTrustedCompletion: true,
				onModelTurn: turns,
				capacityControl: new PlanningCapacityControl(2),
				reasonModel: { generate: async () => proposal() },
			}).execute({ outerTaskId: "long-tools", goal: "Local tool wait", signal: AbortSignal.timeout(5_000) });
			expect(result.status).toBe("completed");
			expect(turns).toHaveBeenCalled();
			const host = new CairnHostEvidence(join(cairnRunDirectory(f.config.stateDir, result.runId), "host.sqlite"));
			try {
				const events = host.events(result.runId, 0, 1000).events;
				expect(events.some((e) => e.type === "cairn_executor_error")).toBe(false);
				expect(events.some((e) => e.type === "cairn_model_turn_completed")).toBe(true);
			} finally {
				host.close();
			}
		} finally {
			f.cleanup();
		}
	});
	it("preserves typed verifier quota exhaustion across the engine boundary", async () => {
		const f = await fixture(0, true);
		try {
			await expect(
				new CairnPlanningEngine({
					...f,
					cwd: f.root,
					requireTrustedCompletion: true,
					capacityControl: new PlanningCapacityControl(2),
					reasonModel: { generate: async () => proposal() },
				}).execute({ outerTaskId: "quota", goal: "Local verifier quota", signal: AbortSignal.timeout(5_000) }),
			).rejects.toMatchObject({ code: "verifier_quota_exhausted", stage: "executor" });
		} finally {
			f.cleanup();
		}
	});
	it("still propagates outer cancellation and releases all live executor slots", async () => {
		const f = await fixture(5_000);
		const control = new AbortController();
		try {
			const run = new CairnPlanningEngine({
				...f,
				cwd: f.root,
				requireTrustedCompletion: true,
				capacityControl: new PlanningCapacityControl(2),
				reasonModel: { generate: async () => proposal() },
			}).execute({ outerTaskId: "cancel", goal: "Local cancellation", signal: control.signal });
			const caught = run.catch((error) => error);
			await wait(150);
			const reason = new Error("Outer fixture cancellation");
			control.abort(reason);
			expect(await caught).toBe(reason);
		} finally {
			control.abort();
			f.cleanup();
		}
	});
});
