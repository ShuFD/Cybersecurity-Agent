import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PLANNING_SCHEMA_VERSION, type PlanningTaskLease } from "../src/planning/contracts.ts";
import { PlanningPersistenceError } from "../src/planning/failures.ts";
import { PiPlanningExecutor } from "../src/planning/pi-adapters.ts";
import { type RunPiCodingTaskOptions, runPiCodingTask } from "../src/subagent.ts";

type SessionEvent = (event: Record<string, unknown>) => void;

const fake = vi.hoisted(() => ({
	session: undefined as
		| {
				sessionId: string;
				messages: unknown[];
				bindExtensions: ReturnType<typeof vi.fn>;
				getAllTools: ReturnType<typeof vi.fn>;
				getActiveToolNames: ReturnType<typeof vi.fn>;
				setActiveToolsByName: ReturnType<typeof vi.fn>;
				steer: ReturnType<typeof vi.fn>;
				subscribe: ReturnType<typeof vi.fn>;
				prompt: ReturnType<typeof vi.fn>;
				dispose: ReturnType<typeof vi.fn>;
				abort: ReturnType<typeof vi.fn>;
				waitForIdle: ReturnType<typeof vi.fn>;
		  }
		| undefined,
	createAgentSession: vi.fn(),
	subscriber: undefined as SessionEvent | undefined,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	SettingsManager: { create: vi.fn(() => ({})) },
	DefaultResourceLoader: class {
		async reload() {}
	},
	SessionManager: { inMemory: vi.fn(() => ({})) },
	createAgentSession: fake.createAgentSession,
}));

function makeSession(mode: "success" | "failure", verifierFailureCategory?: string) {
	const session = {
		sessionId: "session-recovery",
		messages: [] as unknown[],
		bindExtensions: vi.fn(async () => undefined),
		getAllTools: vi.fn(() => [{ name: "required_result" }]),
		getActiveToolNames: vi.fn(() => ["bash"]),
		setActiveToolsByName: vi.fn(),
		steer: vi.fn(),
		subscribe: vi.fn((callback: SessionEvent) => {
			fake.subscriber = callback;
			return () => {
				fake.subscriber = undefined;
			};
		}),
		prompt: vi.fn(async (_message: string) => {
			if (session.messages.length === 0) {
				if (verifierFailureCategory) {
					fake.subscriber?.({
						type: "tool_execution_end",
						toolCallId: "verify-call",
						toolName: "verify_flag",
						result: {
							details: {
								data: {
									ok: false,
									status:
										verifierFailureCategory === "quota_exhausted"
											? "limit_exceeded"
											: verifierFailureCategory,
									verified: false,
									correct: false,
									verificationOutcome: "infra_error",
									failureCategory: verifierFailureCategory,
								},
							},
						},
						isError: true,
					});
					return;
				}
				session.messages.push({
					role: "assistant",
					content: [{ type: "text", text: "not committed" }],
					stopReason: "stop",
				});
				fake.subscriber?.({ type: "message_start", message: { role: "assistant" } });
				fake.subscriber?.({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
				return;
			}
			if (mode === "failure") throw new Error("recovery provider failed");
			fake.subscriber?.({
				type: "tool_execution_start",
				toolCallId: "required-call",
				toolName: "required_result",
				args: {},
			});
			fake.subscriber?.({
				type: "tool_execution_end",
				toolCallId: "required-call",
				toolName: "required_result",
				result: { accepted: true },
				isError: false,
			});
		}),
		dispose: vi.fn(),
		abort: vi.fn(async (): Promise<void> => undefined),
		waitForIdle: vi.fn(async (): Promise<void> => undefined),
	};
	return session;
}

function makeHangingSession(withTool = false) {
	const session = makeSession("success");
	let capturedSubscriber: SessionEvent | undefined;
	session.subscribe = vi.fn((callback: SessionEvent) => {
		capturedSubscriber = callback;
		fake.subscriber = callback;
		return () => {
			fake.subscriber = undefined;
		};
	});
	session.prompt = vi.fn(() => {
		if (withTool) {
			capturedSubscriber?.({
				type: "tool_execution_start",
				toolCallId: "hanging-call",
				toolName: "run_linux_elf",
				args: {},
			});
		}
		return new Promise<void>(() => {});
	});
	return { session, getSubscriber: () => capturedSubscriber };
}

function options(events: Array<{ type: string; payload: Record<string, unknown> }>, signal?: AbortSignal) {
	return {
		config: {
			agentDir: "/state/pi",
			skillPaths: [],
			stateDir: "/state",
			systemPromptPath: undefined,
			knowledgeBaseEnabled: false,
			executionMode: { mode: "direct", legacyPlanningMode: "off", planningEnabled: false, capacity: 1 },
			planning: { mode: "off" },
			registry: { mcpServers: {}, skills: {}, tools: {}, agents: {} },
		} as unknown as RunPiCodingTaskOptions["config"],
		cwd: "/work",
		task: "recovery smoke",
		requiredToolName: "required_result",
		requiredToolRecoveryAttempts: 1,
		signal,
		onLifecycleEvent: (type: string, payload: Record<string, unknown> = {}) => events.push({ type, payload }),
	};
}

function planningLease(): PlanningTaskLease {
	return {
		schemaVersion: PLANNING_SCHEMA_VERSION,
		leaseId: "lease-settlement",
		runId: "run-settlement",
		taskId: "task-settlement",
		planRevision: 1,
		objective: "exercise a hanging worker",
		doneWhen: "the worker settles on cancellation",
		allowedScope: "/work",
		issuedAt: Date.now(),
		expiresAt: Date.now() + 10_000,
	};
}

describe("required-tool recovery lifecycle", () => {
	it("persists in-flight results after terminal cancellation without applying them to the plan", async () => {
		const root = mkdtempSync(join(tmpdir(), "late-evidence-"));
		const { session } = makeHangingSession(true);
		const controller = new AbortController();
		const apply = vi.fn();
		session.abort = vi.fn(async () => {
			fake.subscriber?.({
				type: "tool_execution_end",
				toolCallId: "late-tool",
				toolName: "read",
				result: { content: [{ type: "text", text: "synthetic completed output" }] },
				isError: false,
			});
		});
		fake.createAgentSession.mockResolvedValue({ session });
		try {
			const settings = options([], controller.signal);
			const operation = runPiCodingTask({
				...settings,
				config: { ...settings.config, stateDir: root },
				executionIdentity: { runId: "run-a", taskId: "task-a", leaseId: "lease-a" },
				onToolExecution: apply,
			});
			const rejected = expect(operation).rejects.toThrow("outer cancellation");
			await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
			controller.abort(new Error("outer cancellation"));
			await rejected;
			const directory = join(root, "planning", "inflight-settlements");
			const files = readdirSync(directory);
			expect(files).toHaveLength(1);
			expect(JSON.parse(readFileSync(join(directory, files[0]), "utf8"))).toMatchObject({
				runId: "run-a",
				taskId: "task-a",
				leaseId: "lease-a",
				afterTerminal: true,
				toolCallId: "late-tool",
				isError: false,
			});
			expect(apply).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("keeps outer cancellation responsive when managed repair adapters resolve immediately", async () => {
		const session = makeSession("success");
		fake.createAgentSession.mockResolvedValue({ session });
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const signal = AbortSignal.timeout(30);
		await expect(
			runPiCodingTask({
				...options(events, signal),
				continueUntilRequiredTool: true,
				isRequiredToolComplete: () => false,
			}),
		).rejects.toMatchObject({ name: "TimeoutError" });
		expect(session.prompt.mock.calls.length).toBeGreaterThan(2);
		expect(session.abort).toHaveBeenCalledOnce();
		expect(session.dispose).toHaveBeenCalledOnce();
	});
	it("reports unavailable managed result tools without an immediate retry spin", async () => {
		const session = makeSession("success");
		session.getAllTools.mockReturnValue([]);
		fake.createAgentSession.mockResolvedValue({ session });
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		await expect(runPiCodingTask({ ...options(events), continueUntilRequiredTool: true })).rejects.toThrow(
			"Required result tool unavailable",
		);
		expect(session.prompt).toHaveBeenCalledOnce();
	});
	it("waits for Pi abort settlement before disposing, without changing cancellation reason", async () => {
		const { session } = makeHangingSession(true);
		let finish = () => {};
		let abortStarted = () => {};
		const started = new Promise<void>((resolve) => {
			abortStarted = resolve;
		});
		session.abort = vi.fn(() => {
			abortStarted();
			return new Promise<void>((resolve) => {
				finish = resolve;
			});
		});
		fake.createAgentSession.mockResolvedValue({ session });
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const controller = new AbortController();
		const reason = new Error("operator cancellation");
		let returned = false;
		const operation = runPiCodingTask(options(events, controller.signal)).catch((error) => {
			returned = true;
			return error;
		});
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
		controller.abort(reason);
		await started;
		await Promise.resolve();
		expect(returned).toBe(false);
		expect(session.dispose).not.toHaveBeenCalled();
		finish();
		expect(await operation).toBe(reason);
		expect(session.dispose).toHaveBeenCalledOnce();
		expect(events.at(-1)).toMatchObject({ type: "coding_task_end", payload: { settled: true } });
	});

	it("bounds cleanup wait and transfers pending resource ownership without claiming idle", async () => {
		vi.useFakeTimers();
		let finish = () => {};
		try {
			const { session } = makeHangingSession(true);
			session.abort = vi.fn(
				() =>
					new Promise<void>((resolve) => {
						finish = resolve;
					}),
			);
			fake.createAgentSession.mockResolvedValue({ session });
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			const controller = new AbortController();
			const pending = vi.fn();
			const reason = new Error("hard deadline");
			const operation = runPiCodingTask({
				...options(events, controller.signal),
				onPendingSettlement: pending,
			}).catch((error) => error);
			await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
			controller.abort(reason);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(await operation).toBe(reason);
			expect(pending).toHaveBeenCalledOnce();
			expect(session.dispose).not.toHaveBeenCalled();
			expect(events.at(-1)).toMatchObject({ type: "coding_task_end", payload: { settled: false } });
			finish();
			await pending.mock.calls[0][0];
			expect(session.dispose).toHaveBeenCalledOnce();
		} finally {
			finish();
			vi.useRealTimers();
		}
	});
	beforeEach(() => {
		fake.subscriber = undefined;
		fake.session = undefined;
		fake.createAgentSession.mockReset();
	});

	it("traces a successful required-tool recovery attempt", async () => {
		const session = makeSession("success");
		fake.session = session;
		fake.createAgentSession.mockResolvedValue({ session });
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

		await runPiCodingTask(options(events));

		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(events.map((event) => event.type)).toEqual([
			"coding_task_start",
			"resource_reload_start",
			"resource_reload_end",
			"session_create_start",
			"session_create_end",
			"extensions_bind_start",
			"extensions_bind_end",
			"prompt_start",
			"assistant_message_start",
			"assistant_message_end",
			"prompt_end",
			"required_tool_recovery_start",
			"required_tool_recovery_attempt_start",
			"tool_execution_start",
			"required_tool_recovery_attempt_end",
			"required_tool_recovery_end",
			"coding_task_end",
		]);
		expect(events.find((event) => event.type === "required_tool_recovery_attempt_end")?.payload).toMatchObject({
			attempt: 1,
			accepted: true,
		});
		expect(events.find((event) => event.type === "tool_execution_start")?.payload).toMatchObject({
			toolCallId: "required-call",
			toolName: "required_result",
		});
		expect(events.find((event) => event.type === "tool_execution_start")?.payload).not.toHaveProperty("args");
		expect(events.find((event) => event.type === "required_tool_recovery_end")?.payload).toMatchObject({
			attemptsUsed: 1,
			recovered: true,
		});
	});

	it("exposes the live Pi AgentSession steer method to an advisory observer", async () => {
		const session = makeSession("success");
		session.steer.mockResolvedValue(undefined);
		fake.session = session;
		fake.createAgentSession.mockResolvedValue({ session });
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		let steerFromCurrentSession: ((message: string) => Promise<void>) | undefined;
		await runPiCodingTask({
			...options(events),
			onSteerReady: (steer) => {
				steerFromCurrentSession = steer;
			},
		});

		expect(steerFromCurrentSession).toEqual(expect.any(Function));
		await expect(steerFromCurrentSession?.("Observer reminder with evidence evidence-123")).resolves.toBeUndefined();
		expect(session.steer).toHaveBeenCalledOnce();
		expect(session.steer).toHaveBeenCalledWith("Observer reminder with evidence evidence-123");
		expect(events.map((event) => event.type)).toContain("session_create_end");
	});

	it("returns the AgentSession steer rejection to the Observer caller", async () => {
		const session = makeSession("success");
		session.steer.mockRejectedValueOnce(new Error("session cannot queue guidance"));
		fake.session = session;
		fake.createAgentSession.mockResolvedValue({ session });
		let steerFromCurrentSession: ((message: string) => Promise<void>) | undefined;
		await runPiCodingTask({
			...options([]),
			onSteerReady: (steer) => {
				steerFromCurrentSession = steer;
			},
		});

		expect(steerFromCurrentSession).toEqual(expect.any(Function));
		await expect(steerFromCurrentSession?.("Observer suggestion")).rejects.toThrow("session cannot queue guidance");
	});

	it.each(["quota_exhausted", "timeout", "transport_error"])(
		"does not start required-tool recovery after a verifier %s result",
		async (failureCategory) => {
			const session = makeSession("success", failureCategory);
			fake.session = session;
			fake.createAgentSession.mockResolvedValue({ session });
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

			await expect(runPiCodingTask(options(events))).rejects.toMatchObject({
				name: "VerifierInfrastructureError",
				failureCategory,
			});
			expect(session.prompt).toHaveBeenCalledTimes(1);
			expect(events.some((event) => event.type === "required_tool_recovery_start")).toBe(false);
			expect(events.find((event) => event.type === "coding_task_error")?.payload.error).toContain(failureCategory);
		},
	);

	it("traces a required-tool recovery provider failure and preserves the error", async () => {
		const session = makeSession("failure");
		fake.session = session;
		fake.createAgentSession.mockResolvedValue({ session });
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

		await expect(runPiCodingTask(options(events))).rejects.toThrow("recovery provider failed");
		expect(events.find((event) => event.type === "required_tool_recovery_attempt_end")?.payload).toMatchObject({
			attempt: 1,
			error: "recovery provider failed",
		});
		expect(events.find((event) => event.type === "required_tool_recovery_end")?.payload).toMatchObject({
			attemptsUsed: 1,
			recovered: false,
			error: "recovery provider failed",
		});
		expect(events.map((event) => event.type)).toContain("coding_task_error");
		expect(events.at(-1)?.type).toBe("coding_task_end");
	});

	it("stops required-tool recovery when its tool observer reports persistence failure", async () => {
		const session = makeSession("success");
		fake.session = session;
		fake.createAgentSession.mockResolvedValue({ session });
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const persistenceFailure = new PlanningPersistenceError("checkpoint/evidence storage failed");
		const onToolExecution = vi.fn(() => {
			throw persistenceFailure;
		});

		await expect(
			runPiCodingTask({
				...options(events),
				onToolExecution,
				propagateToolExecutionObserverErrors: true,
			}),
		).rejects.toBe(persistenceFailure);
		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(onToolExecution).toHaveBeenCalledOnce();
		expect(events.filter((event) => event.type === "required_tool_recovery_attempt_start")).toHaveLength(1);
		expect(events.find((event) => event.type === "required_tool_recovery_end")?.payload).toMatchObject({
			attemptsUsed: 1,
			recovered: false,
			error: "checkpoint/evidence storage failed",
		});
	});

	it("stops required-tool recovery when the parent signal aborts", async () => {
		const session = makeSession("success");
		const originalPrompt = session.prompt;
		const abortController = new AbortController();
		let promptCount = 0;
		session.prompt = vi.fn(async (message: string) => {
			promptCount += 1;
			if (promptCount === 1) return originalPrompt(message);
			abortController.abort(new Error("operator cancelled"));
		});
		fake.session = session;
		fake.createAgentSession.mockResolvedValue({ session });
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

		await expect(runPiCodingTask(options(events, abortController.signal))).rejects.toThrow("operator cancelled");
		expect(promptCount).toBe(2);
		expect(events.filter((event) => event.type === "required_tool_recovery_attempt_start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "required_tool_recovery_attempt_end")).toHaveLength(1);
		expect(events.some((event) => event.type === "signal_abort")).toBe(true);
		expect(events.at(-1)?.type).toBe("coding_task_end");
	});

	it("settles a hanging prompt on local timeout and disposes the session", async () => {
		const { session } = makeHangingSession();
		fake.session = session;
		fake.createAgentSession.mockResolvedValue({ session });
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

		await expect(runPiCodingTask(options(events, AbortSignal.timeout(20)))).rejects.toBeDefined();
		expect(session.abort).toHaveBeenCalledOnce();
		expect(session.dispose).toHaveBeenCalledOnce();
		expect(events.map((event) => event.type)).toEqual(
			expect.arrayContaining(["prompt_start", "signal_abort", "coding_task_error", "coding_task_end"]),
		);
	});

	it("settles a hanging tool without fabricating a tool end or accepting late events", async () => {
		const { session, getSubscriber } = makeHangingSession(true);
		fake.session = session;
		fake.createAgentSession.mockResolvedValue({ session });
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const onToolExecution = vi.fn();

		await expect(
			runPiCodingTask({ ...options(events, AbortSignal.timeout(20)), onToolExecution }),
		).rejects.toBeDefined();
		expect(events.map((event) => event.type)).toEqual(
			expect.arrayContaining(["tool_execution_start", "signal_abort", "coding_task_error", "coding_task_end"]),
		);
		expect(events.some((event) => event.type === "tool_execution_end")).toBe(false);
		expect(onToolExecution).not.toHaveBeenCalled();

		getSubscriber()?.({
			type: "tool_execution_end",
			toolCallId: "hanging-call",
			toolName: "run_linux_elf",
			result: { details: { data: { ok: true } } },
			isError: false,
		});
		expect(onToolExecution).not.toHaveBeenCalled();
		expect(events.some((event) => event.type === "tool_execution_end")).toBe(false);
	});

	it("preserves the original parent cancellation reason for a hanging prompt", async () => {
		const { session } = makeHangingSession();
		fake.session = session;
		fake.createAgentSession.mockResolvedValue({ session });
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const controller = new AbortController();
		const prompt = runPiCodingTask(options(events, controller.signal));
		setTimeout(() => controller.abort(new Error("operator cancelled")), 20);

		await expect(prompt).rejects.toThrow("operator cancelled");
		expect(session.abort).toHaveBeenCalledOnce();
		expect(events.map((event) => event.type)).toEqual(
			expect.arrayContaining(["signal_abort", "coding_task_error", "coding_task_end"]),
		);
	});

	it("settles a hanging required-tool recovery prompt without another attempt", async () => {
		const session = makeSession("success");
		const controller = new AbortController();
		let promptCount = 0;
		session.prompt = vi.fn(async (_message: string) => {
			promptCount += 1;
			if (promptCount === 1) {
				return;
			}
			setTimeout(() => controller.abort(new Error("operator cancelled")), 10);
			return new Promise<void>(() => {});
		});
		fake.session = session;
		fake.createAgentSession.mockResolvedValue({ session });
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

		await expect(runPiCodingTask(options(events, controller.signal))).rejects.toThrow("operator cancelled");
		expect(promptCount).toBe(2);
		expect(events.filter((event) => event.type === "required_tool_recovery_attempt_start")).toHaveLength(1);
		expect(events.at(-1)?.type).toBe("coding_task_end");
	});

	it("maps verifier quota exhaustion through the Planning Executor without recovery", async () => {
		const session = makeSession("success", "quota_exhausted");
		fake.session = session;
		fake.createAgentSession.mockResolvedValue({ session });
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const close = vi.fn();
		const executor = new PiPlanningExecutor({
			config: {
				agentDir: "/state/pi",
				skillPaths: [],
				stateDir: "/state",
				systemPromptPath: undefined,
				knowledgeBaseEnabled: false,
				executionMode: { mode: "direct", legacyPlanningMode: "off", planningEnabled: false, capacity: 1 },
				planning: { mode: "off" },
				registry: { mcpServers: {}, skills: {}, tools: {}, agents: {} },
			} as never,
			cwd: "/work",
			createExtensionBundle: () => ({ extensionFactories: [], close }),
			onLifecycleEvent: (type, payload) => events.push({ type, payload }),
		});

		await expect(executor.execute({ lease: planningLease(), context: "quota smoke" })).rejects.toMatchObject({
			stage: "executor",
			code: "verifier_quota_exhausted",
		});
		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(events.some((event) => event.type === "required_tool_recovery_start")).toBe(false);
		expect(events.find((event) => event.type === "executor_error")?.payload).toMatchObject({
			failureStage: "executor",
			failureCode: "verifier_quota_exhausted",
		});
		expect(close).toHaveBeenCalledOnce();
	});

	it("does not settle rejected abort cleanup before Pi is idle", async () => {
		vi.useFakeTimers();
		let finishIdle = () => {};
		try {
			const { session } = makeHangingSession(true);
			const abortError = new Error("abort failed");
			session.abort.mockRejectedValue(abortError);
			session.waitForIdle.mockImplementation(
				() =>
					new Promise<void>((resolve) => {
						finishIdle = resolve;
					}),
			);
			fake.createAgentSession.mockResolvedValue({ session });
			const controller = new AbortController();
			const parentError = new Error("parent cancelled");
			const pending = vi.fn();
			const close = vi.fn();
			const executor = new PiPlanningExecutor({
				config: options([]).config,
				cwd: "/work",
				createExtensionBundle: () => ({ extensionFactories: [], close }),
			});
			const operation = executor
				.execute({
					lease: planningLease(),
					context: "abort failure",
					signal: controller.signal,
					onPendingSettlement: pending,
				})
				.catch((error) => error);
			await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
			controller.abort(parentError);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(await operation).toBe(parentError);
			expect(session.waitForIdle).toHaveBeenCalledOnce();
			expect(session.dispose).not.toHaveBeenCalled();
			expect(close).not.toHaveBeenCalled();
			expect(pending).toHaveBeenCalledOnce();
			let ended = false;
			const settlement = pending.mock.calls[0][0] as Promise<void>;
			const observed = settlement.then(
				() => {
					ended = true;
				},
				() => {
					ended = true;
				},
			);
			await Promise.resolve();
			expect(ended).toBe(false);
			finishIdle();
			await expect(settlement).rejects.toBe(abortError);
			await observed;
			expect(ended).toBe(true);
			expect(session.dispose).toHaveBeenCalledOnce();
			expect(close).toHaveBeenCalledOnce();
		} finally {
			finishIdle();
			vi.useRealTimers();
		}
	});

	it("keeps the Planning extension bundle owned until pending Pi cleanup finishes", async () => {
		vi.useFakeTimers();
		let finish = () => {};
		try {
			const { session } = makeHangingSession(true);
			session.abort = vi.fn(
				() =>
					new Promise<void>((resolve) => {
						finish = resolve;
					}),
			);
			fake.createAgentSession.mockResolvedValue({ session });
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			const close = vi.fn();
			const pending = vi.fn();
			const controller = new AbortController();
			const reason = new Error("parent cancelled");
			const executor = new PiPlanningExecutor({
				config: options(events).config,
				cwd: "/work",
				createExtensionBundle: () => ({ extensionFactories: [], close }),
			});
			const operation = executor
				.execute({
					lease: planningLease(),
					context: "cancel smoke",
					signal: controller.signal,
					onPendingSettlement: pending,
				})
				.catch((error) => error);
			await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
			controller.abort(reason);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(await operation).toBe(reason);
			expect(close).not.toHaveBeenCalled();
			expect(pending).toHaveBeenCalledOnce();
			finish();
			await pending.mock.calls[0][0];
			expect(close).toHaveBeenCalledOnce();
			expect(session.dispose).toHaveBeenCalledOnce();
		} finally {
			finish();
			vi.useRealTimers();
		}
	});

	it("settles PiPlanningExecutor with executor_timeout and closes its bundle", async () => {
		const { session, getSubscriber } = makeHangingSession(true);
		fake.session = session;
		fake.createAgentSession.mockResolvedValue({ session });
		const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const close = vi.fn();
		const executor = new PiPlanningExecutor({
			config: {
				agentDir: "/state/pi",
				skillPaths: [],
				stateDir: "/state",
				systemPromptPath: undefined,
				knowledgeBaseEnabled: false,
				executionMode: { mode: "direct", legacyPlanningMode: "off", planningEnabled: false, capacity: 1 },
				planning: { mode: "off" },
				registry: { mcpServers: {}, skills: {}, tools: {}, agents: {} },
			} as never,
			cwd: "/work",
			taskTimeoutMs: 20,
			createExtensionBundle: () => ({ extensionFactories: [], close }),
			onLifecycleEvent: (type, payload) => events.push({ type, payload }),
		});

		await expect(executor.execute({ lease: planningLease(), context: "hanging worker" })).rejects.toMatchObject({
			code: "executor_timeout",
		});
		expect(close).toHaveBeenCalledOnce();
		expect(session.abort).toHaveBeenCalledOnce();
		expect(session.dispose).toHaveBeenCalledOnce();
		expect(events.map((event) => event.type)).toEqual(
			expect.arrayContaining([
				"executor_tool_execution_start",
				"signal_abort",
				"executor_error",
				"extension_bundle_close_end",
			]),
		);
		expect(events.some((event) => event.type === "executor_tool_execution_end")).toBe(false);
		getSubscriber()?.({
			type: "tool_execution_end",
			toolCallId: "late-commit",
			toolName: "planning_commit_result",
			result: { accepted: true },
			isError: false,
		});
		expect(events.some((event) => event.type === "planning_commit_observed")).toBe(false);
	});
});
