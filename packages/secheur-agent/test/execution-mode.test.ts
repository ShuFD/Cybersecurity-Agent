import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { loadSecHeurConfig } from "../src/config.ts";
import { ExecutionModeResolutionError, type ExecutionModeSpec, resolveExecutionMode } from "../src/execution-mode.ts";
import { ProgressivePlanningController, planningRunIdForExecution } from "../src/planning/controller.ts";
import type { PlanningExecutor, PlanningSupervisor } from "../src/planning/harness.ts";
import { attachProgressivePlanningController } from "../src/planning/session-controller.ts";
import { PlanningStore } from "../src/planning/store.ts";

describe("execution mode contract", () => {
	it("normalizes legacy planning-enabled configuration to PLAN_SINGLE", () => {
		expect(resolveExecutionMode({ legacyPlanningMode: "active" })).toEqual({
			mode: "plan_single",
			planningEnabled: true,
			capacity: 1,
			legacyPlanningMode: "active",
		});
		expect(resolveExecutionMode({ legacyPlanningMode: "shadow" })).toMatchObject({
			mode: "plan_single",
			planningEnabled: true,
			capacity: 1,
			legacyPlanningMode: "shadow",
		});
	});

	it("maps planning off to a real DIRECT mode", () => {
		expect(resolveExecutionMode({ legacyPlanningMode: "off" })).toEqual({
			mode: "direct",
			planningEnabled: false,
			capacity: 1,
			legacyPlanningMode: "off",
		});
		expect(resolveExecutionMode({ planningEnabled: false })).toMatchObject({
			mode: "direct",
			planningEnabled: false,
		});
		expect(resolveExecutionMode({ planningEnabled: "true" })).toMatchObject({ mode: "plan_single", capacity: 1 });
	});

	it("accepts explicit single and multi modes without deriving mode from capacity", () => {
		expect(resolveExecutionMode({ mode: "PLAN_SINGLE" })).toMatchObject({
			mode: "plan_single",
			planningEnabled: true,
			capacity: 1,
		});
		expect(resolveExecutionMode({ mode: "plan_single", legacyPlanningMode: "shadow" })).toMatchObject({
			mode: "plan_single",
			planningEnabled: true,
			capacity: 1,
			legacyPlanningMode: "active",
		});
		expect(resolveExecutionMode({ mode: "plan_multi", capacity: 3 })).toMatchObject({
			mode: "plan_multi",
			planningEnabled: true,
			capacity: 3,
		});
		expect(resolveExecutionMode({ mode: "direct", legacyPlanningMode: "obsolete" })).toMatchObject({
			mode: "direct",
			planningEnabled: false,
			capacity: 1,
		});
	});

	it("rejects invalid modes and invalid capacity contracts", () => {
		expect(() => resolveExecutionMode({ mode: "foo" })).toThrow(ExecutionModeResolutionError);
		expect(() => resolveExecutionMode({ legacyPlanningMode: "foo" })).toThrow(/invalid execution mode: foo/u);
		expect(() => resolveExecutionMode({ mode: "direct", capacity: 2 })).toThrow(/DIRECT requires capacity 1/u);
		expect(resolveExecutionMode({ mode: "plan_multi", capacity: 1 })).toMatchObject({
			mode: "plan_multi",
			capacity: 1,
		});
		expect(() => resolveExecutionMode({ mode: "plan_single", capacity: 2 })).toThrow(/capacity 1/u);
	});

	it("normalizes explicit mode values from the persisted desktop config", async () => {
		const root = await mkdtemp(join(tmpdir(), "secheur-execution-mode-config-"));
		const stateDir = join(root, "state");
		const legacyRoot = join(root, "legacy");
		mkdirSync(stateDir, { recursive: true });
		mkdirSync(legacyRoot, { recursive: true });
		try {
			writeFileSync(
				join(stateDir, "desktop-config.json"),
				JSON.stringify({ executionMode: "plan_single", planning: { mode: "off" } }),
			);
			const config = loadSecHeurConfig({ projectRoot: root, stateDir, legacyRoot, env: {} });
			expect(config.executionMode).toMatchObject({ mode: "plan_single", planningEnabled: true, capacity: 1 });
			expect(config.planning.mode).toBe("active");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not let empty environment overrides erase a legacy mode", async () => {
		const root = await mkdtemp(join(tmpdir(), "secheur-empty-mode-env-"));
		const stateDir = join(root, "state");
		const legacyRoot = join(root, "legacy");
		mkdirSync(stateDir, { recursive: true });
		mkdirSync(legacyRoot, { recursive: true });
		writeFileSync(join(stateDir, "desktop-config.json"), JSON.stringify({ planning: { mode: "active" } }));
		try {
			const config = loadSecHeurConfig({
				projectRoot: root,
				stateDir,
				legacyRoot,
				env: { SECHEUR_PLANNING_MODE: "", SECHEUR_EXECUTION_MODE: "" },
			});
			expect(config.executionMode).toMatchObject({ mode: "plan_single", capacity: 1 });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("fails configuration loading for an invalid planning mode", async () => {
		const root = await mkdtemp(join(tmpdir(), "secheur-invalid-mode-config-"));
		const stateDir = join(root, "state");
		const legacyRoot = join(root, "legacy");
		mkdirSync(stateDir, { recursive: true });
		mkdirSync(legacyRoot, { recursive: true });
		writeFileSync(join(stateDir, "desktop-config.json"), JSON.stringify({ planning: { mode: "foo" } }));
		try {
			expect(() => loadSecHeurConfig({ projectRoot: root, stateDir, legacyRoot, env: {} })).toThrow(
				/invalid execution mode: foo/u,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("records the resolved mode and capacity for PLAN_SINGLE runs", async () => {
		const store = await PlanningStore.open(":memory:");
		const executionMode: ExecutionModeSpec = resolveExecutionMode({ mode: "plan_single" });
		const supervisor: PlanningSupervisor = {
			async propose({ snapshot }) {
				return {
					schemaVersion: 1,
					expectedRevision: snapshot.run.revision,
					decision: "blocked",
					rationale: "no test work",
					tasks: [],
				};
			},
		};
		const executor: PlanningExecutor = {
			async execute() {
				throw new Error("executor must not run");
			},
		};
		try {
			const recordLifecycleEvent = vi.spyOn(store, "recordLifecycleEvent");
			const controller = new ProgressivePlanningController({
				executionMode,
				store,
				supervisor,
				executor,
				maximumSteps: 1,
				maximumTasks: 4,
				leaseTtlMs: 30_000,
				maximumEvidenceBytes: 8_192,
				allowedScope: "/work",
			});
			const result = await controller.execute({
				outerTaskId: "mode-event",
				goal: "mode event",
				async executeDirect() {
					throw new Error("PLAN_SINGLE must not use direct execution");
				},
			});
			expect(result.executionMode).toBe("plan_single");
			const runId = result.runId as string;
			const events = recordLifecycleEvent.mock.calls.filter((call) => call[1] === "execution_mode_selected");
			expect(events).toHaveLength(1);
			expect(events[0]?.[0]).toBe(runId);
			expect(events[0]?.[2]).toMatchObject({
				mode: "plan_single",
				planningEnabled: true,
				capacity: 1,
				legacyPlanningMode: "active",
			});
		} finally {
			store.close();
		}
	});

	it("runs PLAN_MULTI without degrading to PLAN_SINGLE or DIRECT", async () => {
		const store = await PlanningStore.open(":memory:");
		const controller = new ProgressivePlanningController({
			executionMode: resolveExecutionMode({ mode: "plan_multi", capacity: 2 }),
			store,
			supervisor: {
				async propose({ snapshot }) {
					return {
						schemaVersion: 1,
						expectedRevision: snapshot.run.revision,
						decision: "blocked",
						rationale: "offline multi route",
						tasks: [],
					};
				},
			},
			executor: {
				async execute() {
					throw new Error("Executor must not run");
				},
			},
			maximumSteps: 1,
			maximumTasks: 4,
			leaseTtlMs: 30_000,
			maximumEvidenceBytes: 8_192,
			allowedScope: "/work",
		});
		try {
			const result = await controller.execute({
				outerTaskId: "multi",
				goal: "multi",
				executeDirect: async () => {
					throw new Error("DIRECT must not run");
				},
			});
			expect(result).toMatchObject({
				executionMode: "plan_multi",
				direct: false,
				snapshot: { run: { status: "blocked" } },
			});
		} finally {
			store.close();
		}
	});

	it("bypasses the Planning Store and Supervisor for DIRECT prompts", async () => {
		const root = await mkdtemp(join(tmpdir(), "secheur-direct-mode-"));
		const stateDir = join(root, "state");
		const legacyRoot = join(root, "legacy");
		mkdirSync(stateDir, { recursive: true });
		mkdirSync(legacyRoot, { recursive: true });
		writeFileSync(join(stateDir, "desktop-config.json"), JSON.stringify({ planning: { mode: "off" } }));
		const directPrompt = vi.fn(async () => undefined);
		const session = {
			sessionId: "direct-mode-session",
			model: undefined,
			thinkingLevel: "max",
			prompt: directPrompt,
			getActiveToolNames: () => ["read"],
			setActiveToolsByName: vi.fn(),
			getAllTools: () => [{ name: "read" }],
			subscribe: () => () => undefined,
			sendCustomMessage: vi.fn(async () => undefined),
		} as unknown as AgentSession;
		try {
			const config = loadSecHeurConfig({ projectRoot: root, stateDir, legacyRoot, env: {} });
			expect(config.executionMode.mode).toBe("direct");
			const onExecutionModeSelected = vi.fn();
			const binding = attachProgressivePlanningController(session, {
				config,
				cwd: root,
				onExecutionModeSelected,
				controllerFactory: () => {
					throw new Error("DIRECT must not construct Planning");
				},
			});
			try {
				await session.prompt("direct task");
			} finally {
				binding.close();
			}
			expect(directPrompt).toHaveBeenCalledWith("direct task", undefined);
			expect(onExecutionModeSelected).toHaveBeenCalledWith(
				expect.objectContaining({
					mode: "direct",
					planningEnabled: false,
					capacity: 1,
					legacyPlanningMode: "off",
				}),
			);
			expect(existsSync(join(stateDir, "planning.sqlite"))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("updates the attached Planning capacity control during a routed prompt", async () => {
		const root = await mkdtemp(join(tmpdir(), "secheur-live-capacity-"));
		let finish = () => {};
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const session = {
			sessionId: "capacity-session",
			prompt: vi.fn(),
			sendCustomMessage: vi.fn(async () => {}),
			getActiveToolNames: () => [],
			getAllTools: () => [],
			setActiveToolsByName: vi.fn(),
			subscribe: () => () => {},
		} as unknown as AgentSession;
		const config = loadSecHeurConfig({
			projectRoot: root,
			env: {},
			executionMode: "plan_multi",
			executionCapacity: 2,
		});
		const notify = vi.fn();
		let getCapacity = () => 0;
		const binding = attachProgressivePlanningController(session, {
			config,
			cwd: root,
			controllerFactory: (input) => {
				getCapacity = () => input.capacityControl?.getCapacity() ?? 0;
				input.capacityControl?.subscribe(notify);
				return {
					async execute(request) {
						await pending;
						const runId = planningRunIdForExecution(config.executionMode, request.outerTaskId, request.goal);
						if (!runId) throw new Error("missing run");
						input.store.createRun({
							runId,
							outerTaskId: request.outerTaskId,
							goal: request.goal,
							mode: "active",
						});
						input.store.setRunStatus(runId, "blocked", "fixture");
						return {
							mode: "active",
							executionMode: "plan_multi",
							runId,
							direct: false,
							snapshot: input.store.snapshot(runId),
						};
					},
				};
			},
		});
		const operation = session.prompt("capacity test");
		try {
			await expect.poll(() => getCapacity()).toBe(2);
			expect(binding.setExecutionCapacity(3)).toBe(3);
			expect(getCapacity()).toBe(3);
			expect(binding.setExecutionCapacity(1)).toBe(1);
			expect(getCapacity()).toBe(1);
			expect(config.executionMode).toMatchObject({ mode: "plan_multi", capacity: 1 });
			expect(notify).toHaveBeenCalledTimes(2);
			expect(() => binding.setExecutionCapacity(0)).toThrow();
			finish();
			await operation;
		} finally {
			finish();
			await operation.catch(() => {});
			binding.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("routes PLAN_MULTI through the Planning Store with its requested capacity", async () => {
		const root = await mkdtemp(join(tmpdir(), "secheur-multi-mode-"));
		const stateDir = join(root, "state");
		const legacyRoot = join(root, "legacy");
		mkdirSync(stateDir, { recursive: true });
		mkdirSync(legacyRoot, { recursive: true });
		writeFileSync(
			join(stateDir, "desktop-config.json"),
			JSON.stringify({ executionMode: "plan_multi", executionCapacity: 2 }),
		);
		const onExecutionModeSelected = vi.fn();
		const session = {
			sessionId: "multi-mode-session",
			model: undefined,
			thinkingLevel: "max",
			prompt: vi.fn(async () => undefined),
			getActiveToolNames: () => ["read"],
			setActiveToolsByName: vi.fn(),
			getAllTools: () => [{ name: "read" }],
			subscribe: () => () => undefined,
			sendCustomMessage: vi.fn(async () => undefined),
		} as unknown as AgentSession;
		try {
			const config = loadSecHeurConfig({ projectRoot: root, stateDir, legacyRoot, env: {} });
			expect(config.executionMode).toMatchObject({ mode: "plan_multi", planningEnabled: true, capacity: 2 });
			const binding = attachProgressivePlanningController(session, {
				config,
				cwd: root,
				onExecutionModeSelected,
				controllerFactory: (input) => {
					expect(input.executionMode?.capacity).toBe(2);
					return {
						async execute(request) {
							const runId = planningRunIdForExecution(config.executionMode, request.outerTaskId, request.goal);
							if (!runId) throw new Error("missing multi run id");
							input.store.createRun({
								runId,
								outerTaskId: request.outerTaskId,
								goal: request.goal,
								mode: "active",
							});
							input.store.setRunStatus(runId, "blocked", "offline route");
							return {
								mode: "active",
								executionMode: "plan_multi",
								runId,
								direct: false,
								snapshot: input.store.snapshot(runId),
							};
						},
					};
				},
			});
			try {
				await session.prompt("multi task");
			} finally {
				binding.close();
			}
			expect(onExecutionModeSelected).toHaveBeenCalledWith(
				expect.objectContaining({ mode: "plan_multi", planningEnabled: true, capacity: 2 }),
			);
			expect(existsSync(join(stateDir, "planning.sqlite"))).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
