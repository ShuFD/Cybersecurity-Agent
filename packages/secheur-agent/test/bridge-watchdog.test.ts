import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionMode } from "../src/config.ts";
import { PermissionController } from "../src/permissions.ts";

const runtimeFactory = vi.hoisted(() => vi.fn());
vi.mock("../src/runtime.ts", () => ({
	createSecHeurRuntime: runtimeFactory,
}));

import { SecHeurBridge } from "../src/bridge.ts";

const bridges: SecHeurBridge[] = [];
const roots: string[] = [];

interface RuntimeHarness {
	runtime: never;
	prompt: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	messages: Array<Record<string, unknown>>;
}

function createRuntimeHarness(
	sessionManager: object,
	onPrompt: (
		prompt: string,
		emit: (event: AgentSessionEvent) => void,
		messages: Array<Record<string, unknown>>,
	) => Promise<void>,
	pendingCommands: () => number = () => 0,
): RuntimeHarness {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const messages: Array<Record<string, unknown>> = [];
	const permissions = new PermissionController("default");
	const abort = vi.fn(async () => undefined);
	const dispose = vi.fn();
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const prompt = vi.fn(async (value: string) => {
		messages.push({ role: "user", content: [{ type: "text", text: value }], timestamp: Date.now() });
		await onPrompt(value, emit, messages);
	});
	return {
		messages,
		prompt,
		abort,
		dispose,
		runtime: {
			config: {},
			state: {
				commandTasks: {
					get pendingCount() {
						return pendingCommands();
					},
				},
				permissions,
				permissionBroker: permissions.broker,
				getTurnCount: () => 0,
				getLastJudge: () => undefined,
				close: () => undefined,
			},
			session: {
				messages,
				sessionId: "bridge-watchdog-session",
				sessionFile: undefined,
				sessionManager,
				sessionName: undefined,
				model: undefined,
				setSessionName: vi.fn(),
				modelRuntime: { getAvailableSnapshot: () => [] },
				abort,
			},
			extensionsResult: {},
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			prompt,
			abort,
			getBudgetStatus: () => ({ maxTurns: 80, turnsUsed: 0, cost: 0, stopped: false }),
			setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
			setMemoryReferenceEnabled: () => undefined,
			setKnowledgeBaseEnabled: () => undefined,
			setWebVerbsEnabled: () => undefined,
			dispose,
		} as never,
	};
}

async function createBridgeWithSession(
	root: string,
): Promise<{ bridge: SecHeurBridge; base: string; sessionId: string }> {
	const bridge = new SecHeurBridge({
		projectRoot: root,
		port: 0,
		env: {
			SECHEUR_AGENT_FIRST_OUTPUT_TIMEOUT: "1",
			SECHEUR_AGENT_OUTPUT_IDLE_TIMEOUT: "1",
		},
		schedulerBackend: false,
		competition: false,
		worklist: false,
	});
	bridges.push(bridge);
	await bridge.listen();
	const base = `http://127.0.0.1:${bridge.address.port}`;
	const created = (await fetch(`${base}/session/new`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cwd: root, persist: false }),
	}).then((response) => response.json())) as { sessionId: string };
	return { bridge, base, sessionId: created.sessionId };
}

async function submitPrompt(base: string, sessionId: string): Promise<void> {
	await fetch(`${base}/session/${sessionId}/prompt`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ prompt: "inspect the target" }),
	});
}

async function sessionMessages(
	base: string,
	sessionId: string,
): Promise<{ status: string; lastError: string; messages: Array<Record<string, unknown>> }> {
	return (await fetch(`${base}/session/${sessionId}/messages`).then((response) => response.json())) as {
		status: string;
		lastError: string;
		messages: Array<Record<string, unknown>>;
	};
}

async function sessionSnapshot(base: string, sessionId: string): Promise<{ session: Record<string, unknown> }> {
	return (await fetch(`${base}/session/${sessionId}`).then((response) => response.json())) as {
		session: Record<string, unknown>;
	};
}

afterEach(async () => {
	for (const bridge of bridges.splice(0)) await bridge.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	runtimeFactory.mockReset();
});

describe("desktop bridge output watchdog", () => {
	it("bounds cancel latency when runtime abort never settles and rejects late output", async () => {
		const root = mkdtempSync(join(tmpdir(), "bridge-bounded-cancel-"));
		roots.push(root);
		let finish: (() => void) | undefined;
		const harness = createRuntimeHarness({}, async (_prompt, emit, messages) => {
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			const message = {
				role: "assistant",
				content: [{ type: "text", text: "late output" }],
				stopReason: "stop",
				timestamp: Date.now(),
			};
			messages.push(message);
			emit({ type: "message_end", message } as AgentSessionEvent);
		});
		harness.abort.mockImplementation(async () => new Promise<void>(() => {}));
		runtimeFactory.mockResolvedValue(harness.runtime);
		const { base, sessionId } = await createBridgeWithSession(root);
		await submitPrompt(base, sessionId);
		await vi.waitFor(() => expect(harness.prompt).toHaveBeenCalled());
		const started = Date.now();
		const response = await fetch(`${base}/session/${sessionId}/cancel`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ source: "user", reason: "test cancellation" }),
		});
		expect(response.ok).toBe(true);
		expect(Date.now() - started).toBeLessThan(6500);
		expect(harness.dispose).toHaveBeenCalledTimes(1);
		finish?.();
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect((await sessionMessages(base, sessionId)).status).toBe("cancelled");
	}, 10_000);
	it("suspends model idle timeout while waiting for background work and resumes on wakeup", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-background-"));
		roots.push(root);
		let pending = 1;
		const harness = createRuntimeHarness(
			{},
			async (_prompt, emit, messages) => {
				emit({ type: "agent_settled" } as AgentSessionEvent);
				await new Promise((resolve) => setTimeout(resolve, 1500));
				pending = 0;
				emit({ type: "agent_start" } as AgentSessionEvent);
				const message = {
					role: "assistant",
					content: [{ type: "text", text: "Background result received." }],
					stopReason: "stop",
					timestamp: Date.now(),
				};
				messages.push(message);
				emit({ type: "message_end", message } as AgentSessionEvent);
			},
			() => pending,
		);
		runtimeFactory.mockResolvedValue(harness.runtime);
		const { base, sessionId } = await createBridgeWithSession(root);
		await submitPrompt(base, sessionId);
		await vi.waitFor(
			async () => {
				expect((await sessionMessages(base, sessionId)).status).toBe("idle");
			},
			{ timeout: 3000 },
		);
		expect(harness.abort).not.toHaveBeenCalled();
	});
	it("refreshes the tool-stalled deadline on RepoAudit heartbeat updates", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-repoaudit-heartbeat-"));
		roots.push(root);
		const harness = createRuntimeHarness({}, async (_prompt, emit, messages) => {
			emit({
				type: "tool_execution_start",
				toolCallId: "repoaudit-call",
				toolName: "repoaudit_scan",
				args: { repoPath: ".", language: "Python", bugType: "NPD" },
			} as AgentSessionEvent);
			for (let index = 0; index < 4; index += 1) {
				await new Promise((resolve) => setTimeout(resolve, 300));
				emit({
					type: "tool_execution_update",
					toolCallId: "repoaudit-call",
					toolName: "repoaudit_scan",
					args: { repoPath: ".", language: "Python", bugType: "NPD" },
					partialResult: { details: { heartbeat: true } },
				} as AgentSessionEvent);
			}
			emit({
				type: "tool_execution_end",
				toolCallId: "repoaudit-call",
				toolName: "repoaudit_scan",
				args: { repoPath: ".", language: "Python", bugType: "NPD" },
				result: { content: [], details: {} },
				isError: false,
			} as AgentSessionEvent);
			messages.push({
				role: "assistant",
				content: [{ type: "text", text: "scan complete" }],
				stopReason: "stop",
				timestamp: Date.now(),
			});
		});
		runtimeFactory.mockResolvedValue(harness.runtime);
		const { base, sessionId } = await createBridgeWithSession(root);

		await submitPrompt(base, sessionId);
		await vi.waitFor(async () => expect((await sessionMessages(base, sessionId)).status).toBe("idle"), {
			timeout: 3_000,
			interval: 25,
		});

		expect(harness.abort).not.toHaveBeenCalled();
		expect((await sessionMessages(base, sessionId)).lastError).toBe("");
	});

	it("does not treat custom message_end as model output", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-custom-message-watchdog-"));
		roots.push(root);
		const harness = createRuntimeHarness({}, async (_prompt, emit) => {
			const message = {
				role: "custom",
				customType: "unrelated-custom-message",
				content: "planning is still running",
				display: false,
				timestamp: Date.now(),
			};
			emit({ type: "message_start", message } as AgentSessionEvent);
			emit({ type: "message_end", message } as AgentSessionEvent);
			await new Promise<void>(() => {});
		});
		runtimeFactory.mockResolvedValue(harness.runtime);
		const { base, sessionId } = await createBridgeWithSession(root);

		await submitPrompt(base, sessionId);
		await vi.waitFor(async () => expect((await sessionMessages(base, sessionId)).status).toBe("error"), {
			timeout: 3_500,
			interval: 25,
		});

		expect((await sessionMessages(base, sessionId)).lastError).toContain("模型首个输出超时");
	});

	it("suspends the parent model watchdog during active planning", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-planning-watchdog-"));
		roots.push(root);
		let releasePlanning = () => {};
		const planningGate = new Promise<void>((resolve) => {
			releasePlanning = resolve;
		});
		const harness = createRuntimeHarness({}, async (_prompt, emit) => {
			const goal = {
				role: "custom",
				customType: "progressive-planning-goal",
				content: "planning is still running",
				display: false,
				timestamp: Date.now(),
			};
			emit({ type: "message_start", message: goal } as AgentSessionEvent);
			emit({ type: "message_end", message: goal } as AgentSessionEvent);
			await planningGate;
			emit({
				type: "message_start",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "presentation" }],
					timestamp: Date.now(),
				},
			} as AgentSessionEvent);
			await new Promise<void>(() => {});
		});
		runtimeFactory.mockResolvedValue(harness.runtime);
		const { base, sessionId } = await createBridgeWithSession(root);

		await submitPrompt(base, sessionId);
		await vi.waitFor(async () => {
			expect((await sessionSnapshot(base, sessionId)).session).toMatchObject({
				status: "running",
				watchdogPhase: "planning",
			});
		});
		await new Promise((resolve) => setTimeout(resolve, 1_300));
		expect((await sessionSnapshot(base, sessionId)).session).toMatchObject({
			status: "running",
			watchdogPhase: "planning",
		});

		releasePlanning();
		await vi.waitFor(async () => expect((await sessionMessages(base, sessionId)).status).toBe("error"), {
			timeout: 3_500,
			interval: 25,
		});
		expect((await sessionMessages(base, sessionId)).lastError).toContain("模型输出中断");
	});

	it("rearms first-output watchdog when planning result starts parent presentation", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-planning-result-watchdog-"));
		roots.push(root);
		let releasePlanning = () => {};
		const planningGate = new Promise<void>((resolve) => {
			releasePlanning = resolve;
		});
		const harness = createRuntimeHarness({}, async (_prompt, emit) => {
			const goal = {
				role: "custom",
				customType: "progressive-planning-goal",
				content: "planning",
				display: false,
				timestamp: Date.now(),
			};
			emit({ type: "message_start", message: goal } as AgentSessionEvent);
			emit({ type: "message_end", message: goal } as AgentSessionEvent);
			await planningGate;
			const result = {
				role: "custom",
				customType: "progressive-planning-result",
				content: "planning complete",
				display: false,
				timestamp: Date.now(),
			};
			emit({ type: "message_start", message: result } as AgentSessionEvent);
			emit({ type: "message_end", message: result } as AgentSessionEvent);
			await new Promise<void>(() => {});
		});
		runtimeFactory.mockResolvedValue(harness.runtime);
		const { base, sessionId } = await createBridgeWithSession(root);

		await submitPrompt(base, sessionId);
		await vi.waitFor(async () => {
			expect((await sessionSnapshot(base, sessionId)).session).toMatchObject({
				status: "running",
				watchdogPhase: "planning",
			});
		});
		await new Promise((resolve) => setTimeout(resolve, 1_300));
		expect((await sessionSnapshot(base, sessionId)).session).toMatchObject({
			status: "running",
			watchdogPhase: "planning",
		});

		releasePlanning();
		await vi.waitFor(async () => expect((await sessionMessages(base, sessionId)).status).toBe("error"), {
			timeout: 3_500,
			interval: 25,
		});
		expect((await sessionMessages(base, sessionId)).lastError).toContain("模型首个输出超时");
	});

	it("arms model-stream idle when the assistant message starts", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-assistant-start-watchdog-"));
		roots.push(root);
		const harness = createRuntimeHarness({}, async (_prompt, emit) => {
			emit({
				type: "message_start",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "partial" }],
					timestamp: Date.now(),
				},
			} as AgentSessionEvent);
			await new Promise<void>(() => {});
		});
		runtimeFactory.mockResolvedValue(harness.runtime);
		const { base, sessionId } = await createBridgeWithSession(root);

		await submitPrompt(base, sessionId);
		await vi.waitFor(async () => expect((await sessionMessages(base, sessionId)).status).toBe("error"), {
			timeout: 3_500,
			interval: 25,
		});

		expect((await sessionMessages(base, sessionId)).lastError).toContain("模型输出中断");
	});

	it("aborts and releases a runtime when the model never produces output", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-first-output-timeout-"));
		roots.push(root);
		const harness = createRuntimeHarness({}, async () => new Promise<void>(() => {}));
		harness.abort.mockImplementation(async () => new Promise<void>(() => {}));
		runtimeFactory.mockResolvedValue(harness.runtime);
		const { base, sessionId } = await createBridgeWithSession(root);

		await submitPrompt(base, sessionId);
		await vi.waitFor(async () => expect((await sessionMessages(base, sessionId)).status).toBe("error"), {
			timeout: 3_500,
			interval: 25,
		});

		const state = await sessionMessages(base, sessionId);
		expect(harness.abort).toHaveBeenCalledWith("host_watchdog");
		expect(harness.dispose).toHaveBeenCalledTimes(1);
		expect(state.lastError).toContain("模型首个输出超时");
		expect(state.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: "error", content: expect.stringContaining("API Base") }),
			]),
		);
	});

	it("rebuilds the runtime and continues once after output becomes idle", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-output-idle-timeout-"));
		roots.push(root);
		const sessionManager = {};
		const first = createRuntimeHarness(sessionManager, async (_prompt, emit) => {
			emit({
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "partial evidence" }] },
				assistantMessageEvent: { type: "text_delta", delta: "partial evidence" },
			} as AgentSessionEvent);
			await new Promise<void>(() => {});
		});
		const second = createRuntimeHarness(sessionManager, async (_prompt, _emit, messages) => {
			messages.push({
				role: "assistant",
				content: [{ type: "text", text: "completed result" }],
				stopReason: "stop",
				timestamp: Date.now(),
			});
		});
		runtimeFactory.mockResolvedValueOnce(first.runtime).mockResolvedValueOnce(second.runtime);
		const { base, sessionId } = await createBridgeWithSession(root);

		await submitPrompt(base, sessionId);
		await vi.waitFor(async () => expect((await sessionMessages(base, sessionId)).status).toBe("idle"), {
			timeout: 2_500,
			interval: 25,
		});

		const state = await sessionMessages(base, sessionId);
		expect(first.abort).toHaveBeenCalledWith("host_watchdog");
		expect(first.dispose).toHaveBeenCalledTimes(1);
		expect(runtimeFactory).toHaveBeenCalledTimes(2);
		expect(runtimeFactory).toHaveBeenLastCalledWith(expect.objectContaining({ sessionManager }));
		expect(second.prompt).toHaveBeenCalledWith(
			expect.stringContaining("上一轮模型输出在中途停止"),
			expect.anything(),
		);
		expect(second.prompt.mock.calls[0]?.[0]).toContain("partial evidence");
		expect(state.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(state.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: "assistant", content: "partial evidence", interrupted: true }),
				expect.objectContaining({ role: "assistant", content: "completed result" }),
			]),
		);
	});

	it("stops after the automatic continuation also becomes idle", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-output-idle-retry-timeout-"));
		roots.push(root);
		const hangingRuntime = (text: string) =>
			createRuntimeHarness({}, async (_prompt, emit) => {
				emit({
					type: "message_update",
					message: { role: "assistant", content: [{ type: "text", text }] },
					assistantMessageEvent: { type: "text_delta", delta: text },
				} as AgentSessionEvent);
				await new Promise<void>(() => {});
			});
		const first = hangingRuntime("first partial");
		const second = hangingRuntime("retry partial");
		runtimeFactory.mockResolvedValueOnce(first.runtime).mockResolvedValueOnce(second.runtime);
		const { base, sessionId } = await createBridgeWithSession(root);

		await submitPrompt(base, sessionId);
		await vi.waitFor(async () => expect((await sessionMessages(base, sessionId)).status).toBe("error"), {
			timeout: 3_500,
			interval: 25,
		});

		const state = await sessionMessages(base, sessionId);
		expect(runtimeFactory).toHaveBeenCalledTimes(2);
		expect(first.abort).toHaveBeenCalledWith("host_watchdog");
		expect(second.abort).toHaveBeenCalledWith("host_watchdog");
		expect(second.dispose).toHaveBeenCalledTimes(1);
		expect(state.lastError).toContain("自动续作后再次中断");
		expect(state.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(state.messages.at(-1)).toMatchObject({ role: "error" });
	});
});
