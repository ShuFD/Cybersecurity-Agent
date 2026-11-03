import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSecHeurConfig } from "../src/config.ts";
import {
	type CtfContinuationState,
	createSecHeurExtension,
	seedRejectedPlanningVerifierEvidence,
	sharePlanningVerifierState,
} from "../src/extension.ts";
import { FlagOracleClient } from "../src/flag-oracle.ts";
import type { MainWorkflowBinding } from "../src/main-agent.ts";
import { OperationalGuard } from "../src/operational-guard.ts";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "secheur-runtime-context-"));
	temporaryRoots.push(root);
	return root;
}

async function listenVerifierSocket(
	responses: Array<Record<string, unknown>>,
): Promise<{ path: string; requests: Array<Record<string, unknown>>; close: () => Promise<void> }> {
	const path =
		process.platform === "win32"
			? `\\\\.\\pipe\\secheur-runtime-context-verifier-${randomUUID()}`
			: join(tmpdir(), `secheur-runtime-context-verifier-${randomUUID()}.sock`);
	const requests: Array<Record<string, unknown>> = [];
	const server = createServer((socket: Socket) => {
		let buffer = "";
		socket.on("data", (chunk: Buffer | string) => {
			buffer += chunk.toString();
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			requests.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
			const response = responses[Math.min(requests.length - 1, responses.length - 1)] ?? {
				ok: false,
				status: "incorrect",
				verified: false,
			};
			socket.end(`${JSON.stringify(response)}\n`);
		});
	});
	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(path, () => {
			server.removeListener("error", reject);
			resolvePromise();
		});
	});
	return {
		path,
		requests,
		close: () =>
			new Promise<void>((resolvePromise, reject) => {
				server.close((error) => (error ? reject(error) : resolvePromise()));
			}),
	};
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Pi runtime context bridge", () => {
	it("registers background tools for planning children without replacing the shared ledger", async () => {
		const root = temporaryRoot();
		const config = loadSecHeurConfig({ projectRoot: root, env: {} });
		const identity = { challengeId: "fixture/target", runId: "fixture-run" };
		const parent = createSecHeurExtension({ config, trustedTaskIdentity: identity });
		parent.state.operationalGuard = new OperationalGuard(config.stateDir, "parent");
		const continuation: CtfContinuationState = {
			taskKind: "ctf",
			verificationState: "not_attempted",
			consecutiveNoToolTurns: 0,
		};
		const children = ["lease-a", "lease-b"].map((commandTaskScope) =>
			createSecHeurExtension({
				config,
				trustedTaskIdentity: identity,
				subAgentDepth: 1,
				commandTaskScope,
				ctfContinuation: { ...continuation },
			}),
		);
		try {
			for (const child of children) {
				sharePlanningVerifierState(parent.state, child.state);
				const tools = new Set<string>();
				const pi = {
					registerTool: (tool: { name: string }) => tools.add(tool.name),
					registerCommand: () => {},
					on: () => {},
					sendMessage: () => {},
					getAllTools: () => [],
					getActiveTools: () => [],
					setActiveTools: () => {},
				};
				if (typeof child.extension === "function") child.extension(pi as never);
				else child.extension.factory(pi as never);
				expect(tools.has("bash")).toBe(true);
				expect(tools.has("command_task_output")).toBe(true);
				expect(child.state.operationalGuard).toBe(parent.state.operationalGuard);
			}
			let finish = () => {};
			const gate = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const job = await children[0].state.commandTasks!.run(
				"bash",
				{ run_in_background: true },
				undefined,
				async () => {
					await gate;
					return { content: [], details: {} };
				},
			);
			const id = (job.details as { task_id: string }).task_id;
			expect(children[1].state.commandTasks!.owns(id)).toBe(false);
			await children[1].state.commandTasks!.close();
			expect(children[0].state.commandTasks!.pendingCount).toBe(1);
			finish();
			await children[0].state.commandTasks!.waitForSettlement();
		} finally {
			for (const child of children) child.state.close();
			parent.state.close();
		}
	});
	it("shares quota while permitting corrections without new observations", async () => {
		const root = temporaryRoot();
		const config = loadSecHeurConfig({
			projectRoot: root,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const identity = { challengeId: "fixture/target", runId: "shared-ledger" };
		const parent = createSecHeurExtension({ config, trustedTaskIdentity: identity, requireTrustedChallengeId: true });
		parent.state.operationalGuard = new OperationalGuard(config.stateDir, "shared-ledger");
		const child = createSecHeurExtension({
			config,
			trustedTaskIdentity: identity,
			requireTrustedChallengeId: true,
			subAgentDepth: 1,
		});
		sharePlanningVerifierState(parent.state, child.state);
		const handlers = new Map<string, (event: Record<string, unknown>) => unknown>();
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<Record<string, unknown>> }>();
		const pi = {
			registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<Record<string, unknown>> }) =>
				tools.set(tool.name, tool),
			registerCommand: () => {},
			on: (name: string, fn: (event: Record<string, unknown>) => unknown) => handlers.set(name, fn),
			getAllTools: () => [],
			getActiveTools: () => [],
			setActiveTools: () => {},
		};
		if (typeof child.extension === "function") child.extension(pi as never);
		else child.extension.factory(pi as never);
		const oracle = vi.spyOn(FlagOracleClient.prototype, "verify").mockResolvedValue({
			ok: true,
			status: "incorrect",
			verified: false,
			correct: false,
			verificationOutcome: "incorrect",
		});
		const tool = tools.get("verify_flag")!;
		const ctx = { sessionManager: { getSessionId: () => "fixture-child" } };
		try {
			const first = await tool.execute("first", { flag: "FIXTURE_ONE" }, undefined, undefined, ctx);
			expect(first.details).toMatchObject({ data: { verificationOutcome: "incorrect" } });
			expect(oracle).toHaveBeenCalledOnce();
			const observe = handlers.get("tool_result")!;
			observe({ toolName: "read", input: {}, content: [{ type: "text", text: "failed" }], isError: true });
			observe({
				toolName: "read",
				input: {},
				content: [{ type: "text", text: "fixture evidence" }],
				isError: false,
			});
			await tool.execute("retry", { flag: "FIXTURE_ONE" }, undefined, undefined, ctx);
			expect(oracle).toHaveBeenCalledOnce();
			expect(parent.state.operationalGuard.remainingAttempts).toBe(2);
			expect(child.state.operationalGuard).toBe(parent.state.operationalGuard);
			expect(parent.state.operationalGuard.toolCallsUsed).toBe(2);
			observe({
				toolName: "read",
				input: {},
				content: [{ type: "text", text: "fixture evidence" }],
				isError: false,
			});
			await tool.execute("correction", { flag: "FIXTURE_TWO" }, undefined, undefined, ctx);
			expect(oracle).toHaveBeenCalledTimes(2);
			expect(parent.state.operationalGuard.remainingAttempts).toBe(1);
		} finally {
			oracle.mockRestore();
			child.state.close();
			parent.state.close();
		}
	});
	it.each(["incorrect", "correct"] as const)(
		"shares %s native verifier results between siblings without sharing hosts or other runs",
		async (verdict) => {
			const root = temporaryRoot();
			const config = loadSecHeurConfig({
				projectRoot: root,
				legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
				env: {},
			});
			const makeTools = (runId: string) => {
				const created = createSecHeurExtension({
					config,
					env: {},
					trustedTaskIdentity: { challengeId: "fixture/target", runId },
					requireTrustedChallengeId: true,
				});
				const tools = new Map<string, { execute: (...args: unknown[]) => Promise<Record<string, unknown>> }>();
				const pi = {
					registerTool: (tool: {
						name: string;
						execute: (...args: unknown[]) => Promise<Record<string, unknown>>;
					}) => tools.set(tool.name, tool),
					registerCommand: () => undefined,
					on: () => undefined,
					getAllTools: () => [],
					getActiveTools: () => [],
					setActiveTools: () => undefined,
				};
				if (typeof created.extension === "function") created.extension(pi as never);
				else created.extension.factory(pi as never);
				return { created, tool: tools.get("verify_flag")! };
			};
			const parent = makeTools("run-one"),
				a = makeTools("run-one"),
				b = makeTools("run-one");
			const otherParent = makeTools("run-two"),
				other = makeTools("run-two");
			sharePlanningVerifierState(parent.created.state, a.created.state);
			sharePlanningVerifierState(parent.created.state, b.created.state);
			sharePlanningVerifierState(otherParent.created.state, other.created.state);
			let unblock = () => {};
			const hold = new Promise<void>((resolve) => {
				unblock = resolve;
			});
			let calls = 0,
				active = 0,
				maximumActive = 0;
			const verify = vi.spyOn(FlagOracleClient.prototype, "verify").mockImplementation(async () => {
				calls++;
				active++;
				maximumActive = Math.max(maximumActive, active);
				await hold;
				active--;
				return {
					ok: true,
					status: verdict,
					verified: verdict === "correct",
					correct: verdict === "correct",
					verificationOutcome: verdict,
				};
			});
			const ctx = { sessionManager: { getSessionId: () => "local-child" } };
			try {
				expect(a.created.state.legacyHost).not.toBe(b.created.state.legacyHost);
				const first = a.tool.execute("first", { flag: "FIXTURE_REJECTED" }, undefined, undefined, ctx);
				const duplicate = b.tool.execute("same", { flag: "FIXTURE_REJECTED" }, undefined, undefined, ctx);
				const different = b.tool.execute("other", { flag: "FIXTURE_OTHER" }, undefined, undefined, ctx);
				await expect.poll(() => calls).toBe(1);
				unblock();
				const results = await Promise.all([first, duplicate, different]);
				expect(results[1]?.details).toMatchObject({
					data: { status: verdict === "incorrect" ? "duplicate" : "correct" },
				});
				expect(calls).toBe(2);
				expect(maximumActive).toBe(1);
				await other.tool.execute("other-run", { flag: "FIXTURE_REJECTED" }, undefined, undefined, ctx);
				expect(calls).toBe(3);
			} finally {
				unblock();
				verify.mockRestore();
				for (const child of [parent, a, b, otherParent, other]) child.created.state.close();
			}
		},
	);

	it("exposes Main solver dispatch and forwards the active model context", async () => {
		const root = temporaryRoot();
		const config = loadSecHeurConfig({
			projectRoot: root,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const dispatchSolver = vi.fn(async () => ({ taskId: "ctfd:1", status: "starting" }));
		const mainWorkflow = {
			configureCompetition: vi.fn(async () => ({})),
			sync: vi.fn(async () => ({})),
			setAttemptBudgets: vi.fn(async () => ({})),
			requeueTasks: vi.fn(async () => ({})),
			dispatchSolver,
			listSolvers: vi.fn(async () => []),
			guideSolver: vi.fn(async () => ({})),
			stopSolver: vi.fn(async () => ({})),
		} as unknown as MainWorkflowBinding;
		const created = createSecHeurExtension({ config, mainWorkflow });
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		const pi = {
			registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
				tools.set(tool.name, tool);
			},
			registerCommand: () => undefined,
			on: () => undefined,
			getAllTools: () => [],
			getActiveTools: () => [],
			setActiveTools: () => undefined,
		};
		try {
			if (typeof created.extension === "function") created.extension(pi as never);
			else created.extension.factory(pi as never);
			const dispatch = tools.get("competition_dispatch_solver");
			expect(dispatch).toBeDefined();
			await dispatch?.execute(
				"call-1",
				{ task_id: "ctfd:1", prompt: "solve the challenge", title: "Demo" },
				undefined,
				undefined,
				{
					model: { provider: "custom", id: "MiniMax-M3" },
					thinkingLevel: "off",
				} as never,
			);
			expect(dispatchSolver).toHaveBeenCalledWith({
				taskId: "ctfd:1",
				prompt: "solve the challenge",
				title: "Demo",
				model: { provider: "custom", id: "MiniMax-M3" },
				thinkingLevel: "off",
			});
		} finally {
			created.state.close();
		}
	});

	it("initializes Legacy supervision and observes tools and final responses", async () => {
		const root = temporaryRoot();
		const config = loadSecHeurConfig({
			projectRoot: root,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const created = createSecHeurExtension({ config: { ...config, attemptDedupEnabled: true } });
		type TestHandler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;
		const handlers = new Map<string, TestHandler[]>();
		const sendMessage = vi.fn();
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<Record<string, unknown>> }>();
		const pi = {
			registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<Record<string, unknown>> }) => {
				tools.set(tool.name, tool);
			},
			registerCommand: () => undefined,
			on: (event: string, handler: TestHandler) => {
				const current = handlers.get(event) ?? [];
				current.push(handler);
				handlers.set(event, current);
			},
			getAllTools: () => [],
			getActiveTools: () => [],
			setActiveTools: () => undefined,
			sendMessage,
		};
		const call = vi.spyOn(created.state.legacyHost, "call").mockImplementation(async (tool) => {
			if (tool === "__task_start") return { id: 1, ok: true, nextPrompt: "TASK_CONTEXT" } as never;
			if (tool === "__memory_prefetch") {
				return { id: 2, ok: true, data: { status: "success" }, nextPrompt: "MEMORY_CONTEXT" } as never;
			}
			if (tool === "__observe_external_tool") {
				return { id: 3, ok: true, nextPrompt: "TOOL_RECOVERY" } as never;
			}
			if (tool === "__assistant_response") {
				return { id: 4, ok: true, nextPrompt: "ANSWER_GATE", shouldExit: false } as never;
			}
			if (tool === "__turn_end") return { id: 5, ok: true, nextPrompt: "TURN_CONTEXT" } as never;
			return { id: 6, ok: true } as never;
		});
		const availableTools = [
			{
				type: "function" as const,
				function: {
					name: "mcp__ctf_toolbox__identify_file",
					description: "Identify a file",
					parameters: { type: "object" } as never,
				},
			},
		];
		vi.spyOn(created.state.mcp, "legacyToolSchemas", "get").mockReturnValue(availableTools);

		try {
			if (typeof created.extension === "function") created.extension(pi as never);
			else created.extension.factory(pi as never);
			const ctx = {
				sessionManager: { getSessionId: () => "pi-session-1" },
				signal: undefined,
			};
			const before = handlers.get("before_agent_start")?.[0];
			const beforeResult = (await before?.({ prompt: "solve target", systemPrompt: "BASE" }, ctx)) as {
				systemPrompt?: string;
			};

			expect(call).toHaveBeenCalledWith(
				"__task_start",
				expect.objectContaining({
					prompt: "solve target",
					session_id: "pi-session-1",
					state_dir: config.stateDir,
					attempt_dedup_enabled: true,
				}),
				undefined,
				15_000,
			);
			expect(beforeResult.systemPrompt).toContain("TASK_CONTEXT");
			expect(beforeResult.systemPrompt).toContain("MEMORY_CONTEXT");
			expect(call).toHaveBeenCalledWith("__memory_prefetch", { query: "solve target", limit: 5 }, undefined, 3_000);

			const turnStart = handlers.get("turn_start")?.[0];
			await turnStart?.({ turnIndex: 0 }, ctx);
			expect(call).toHaveBeenCalledWith("__turn_start", { turn: 1 }, undefined, 5_000);

			const toolResult = handlers.get("tool_result")?.at(-1);
			const observed = (await toolResult?.(
				{
					toolName: "bash",
					input: { command: "false" },
					isError: true,
					content: [{ type: "text", text: "command failed" }],
					details: {
						structuredContent: { exit_code: 1, stderr: "command failed" },
					},
				},
				ctx,
			)) as { content?: Array<{ type: string; text: string }> };
			expect(observed.content?.at(-1)?.text).toBe("TOOL_RECOVERY");
			expect(call).toHaveBeenCalledWith(
				"__observe_external_tool",
				expect.objectContaining({
					tool_name: "bash",
					args: { command: "false" },
					data: {
						status: "error",
						content: "command failed",
						result: { exit_code: 1, stderr: "command failed" },
					},
					available_tools: availableTools,
				}),
				undefined,
				5_000,
			);

			const legacyObserved = await toolResult?.(
				{
					toolName: "file_read",
					input: { path: "README.md" },
					isError: false,
					content: [{ type: "text", text: "content" }],
				},
				ctx,
			);
			expect(legacyObserved).toBeUndefined();

			const turnEnd = handlers.get("turn_end")?.[0];
			await turnEnd?.(
				{
					toolResults: [{ details: {} }],
					message: {
						role: "assistant",
						content: [{ type: "toolCall", name: "bash", arguments: { command: "false" } }],
					},
				},
				ctx,
			);
			expect(call).toHaveBeenCalledWith(
				"__turn_end",
				expect.objectContaining({
					tool_calls: [{ tool_name: "bash", args: { command: "false" } }],
				}),
				undefined,
				5_000,
			);
			expect(sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ customType: "secheur-turn-context", content: "TURN_CONTEXT", display: false }),
				{ triggerTurn: true, deliverAs: "steer" },
			);

			await turnEnd?.(
				{
					toolResults: [],
					message: { role: "assistant", content: [{ type: "text", text: "flag{guess}" }] },
				},
				ctx,
			);
			expect(sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ customType: "secheur-response-guard", content: "ANSWER_GATE", display: false }),
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			expect(call).toHaveBeenCalledWith(
				"__assistant_response",
				{ content: "flag{guess}", thinking: "" },
				undefined,
				5_000,
			);

			call.mockClear();
			sendMessage.mockClear();
			await turnEnd?.(
				{
					toolResults: [],
					message: { role: "assistant", content: [], stopReason: "stop" },
				},
				ctx,
			);
			expect(call).toHaveBeenCalledWith("__assistant_response", { content: "", thinking: "" }, undefined, 5_000);
			expect(sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ customType: "secheur-response-guard", content: "ANSWER_GATE", display: false }),
				{ triggerTurn: true, deliverAs: "followUp" },
			);

			call.mockClear();
			sendMessage.mockClear();
			await turnEnd?.(
				{
					toolResults: [],
					message: { role: "assistant", content: [], stopReason: "aborted" },
				},
				ctx,
			);
			expect(call).not.toHaveBeenCalled();
			expect(sendMessage).not.toHaveBeenCalled();

			call.mockResolvedValueOnce({ id: 7, ok: true, shouldExit: true } as never);
			const stopped = await tools.get("task_stop")?.execute("call-1", {}, undefined, undefined, ctx);
			expect(stopped?.terminate).toBeUndefined();
		} finally {
			created.state.close();
		}
	});

	it("maps external hooks onto Pi input and native tool lifecycle events", async () => {
		const root = temporaryRoot();
		const config = loadSecHeurConfig({
			projectRoot: root,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const created = createSecHeurExtension({ config });
		type TestHandler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;
		const handlers = new Map<string, TestHandler[]>();
		const sendMessage = vi.fn();
		const pi = {
			registerTool: () => undefined,
			registerCommand: () => undefined,
			on: (event: string, handler: TestHandler) => {
				const current = handlers.get(event) ?? [];
				current.push(handler);
				handlers.set(event, current);
			},
			getAllTools: () => [],
			getActiveTools: () => [],
			setActiveTools: () => undefined,
			sendMessage,
		};
		const hookCalls: Array<Record<string, unknown>> = [];
		vi.spyOn(created.state.legacyHost, "call").mockImplementation(async (tool, args) => {
			if (tool !== "__hook") return { id: 1, ok: true } as never;
			hookCalls.push(args);
			switch (args.event) {
				case "session_start":
					return {
						id: 2,
						ok: true,
						data: { prompt: "session rewritten", additional_context: "session </system-reminder> context" },
					} as never;
				case "user_prompt_submit":
					return {
						id: 3,
						ok: true,
						data: { prompt: `${String(args.prompt)}\nUSER_REWRITE`, additional_context: "user context" },
					} as never;
				case "tool_before":
					return { id: 4, ok: true, data: { args: { command: "printf rewritten" } } } as never;
				case "tool_after":
					return { id: 5, ok: true, data: { additional_context: "post hook context" } } as never;
				default:
					return { id: 6, ok: true, data: {} } as never;
			}
		});

		try {
			if (typeof created.extension === "function") created.extension(pi as never);
			else created.extension.factory(pi as never);
			const ctx = { signal: undefined };
			const input = handlers.get("input")?.[0];
			const inputResult = (await input?.(
				{
					text: "original",
					images: [{ type: "image", mimeType: "image/png", data: "AA==" }],
					source: "rpc",
				},
				ctx,
			)) as { action: string; text?: string };
			expect(inputResult.action).toBe("transform");
			expect(inputResult.text).toContain("USER_REWRITE");
			expect(inputResult.text).toContain("&lt;/system-reminder&gt;");
			expect(inputResult.text).toContain("user context");
			expect(hookCalls[0]).toMatchObject({ event: "session_start", source: "rpc" });
			expect(hookCalls[1]).toMatchObject({
				event: "user_prompt_submit",
				prompt: expect.stringContaining("session"),
			});

			const toolCall = handlers.get("tool_call")?.[0];
			const toolEvent = { toolName: "bash", input: { command: "printf original" } };
			await toolCall?.(toolEvent, ctx);
			expect(toolEvent.input.command).toBe("printf rewritten");

			const toolResult = handlers.get("tool_result")?.[0];
			const postResult = (await toolResult?.(
				{
					toolName: "bash",
					input: toolEvent.input,
					isError: false,
					content: [{ type: "text", text: "native result" }],
					details: { exitCode: 0 },
				},
				ctx,
			)) as { content?: Array<{ type: string; text: string }> };
			expect(postResult.content?.at(-1)?.text).toContain("post hook context");

			await handlers.get("agent_settled")?.[0]?.({}, ctx);
			expect(hookCalls.at(-1)).toMatchObject({
				event: "stop",
				prompt: expect.stringContaining("USER_REWRITE"),
				source: "rpc",
				stop_reason: "completed",
			});
		} finally {
			created.state.close();
		}
	});

	it("surfaces external hook blocks without executing the affected Pi action", async () => {
		const root = temporaryRoot();
		const config = loadSecHeurConfig({
			projectRoot: root,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const created = createSecHeurExtension({ config });
		type TestHandler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;
		const handlers = new Map<string, TestHandler[]>();
		const sendMessage = vi.fn();
		const pi = {
			registerTool: () => undefined,
			registerCommand: () => undefined,
			on: (event: string, handler: TestHandler) => {
				const current = handlers.get(event) ?? [];
				current.push(handler);
				handlers.set(event, current);
			},
			getAllTools: () => [],
			getActiveTools: () => [],
			setActiveTools: () => undefined,
			sendMessage,
		};
		vi.spyOn(created.state.legacyHost, "call").mockImplementation(async (tool, args) => {
			if (tool === "__hook" && args.event === "session_start") return { id: 1, ok: true, data: {} } as never;
			if (tool === "__hook") {
				return { id: 2, ok: true, data: { blocked: true, message: "blocked by policy" } } as never;
			}
			return { id: 3, ok: true } as never;
		});

		try {
			if (typeof created.extension === "function") created.extension(pi as never);
			else created.extension.factory(pi as never);
			const ctx = { signal: undefined };
			const inputResult = (await handlers.get("input")?.[0]?.(
				{ text: "blocked prompt", images: [], source: "interactive" },
				ctx,
			)) as { action: string };
			expect(inputResult.action).toBe("handled");
			expect(sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ customType: "secheur-hook-blocked", content: "[Hook] blocked by policy" }),
			);

			const blocked = await handlers.get("tool_call")?.[0]?.({ toolName: "bash", input: { command: "true" } }, ctx);
			expect(blocked).toEqual({ block: true, reason: "blocked by policy" });
		} finally {
			created.state.close();
		}
	});

	it("routes verify_flag and check_flag through the native verifier", async () => {
		const root = temporaryRoot();
		const config = loadSecHeurConfig({
			projectRoot: root,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: { CTF_ORACLE_SOCKET: join(root, "missing-verifier.sock") },
		});
		const created = createSecHeurExtension({
			config,
			env: { CTF_ORACLE_SOCKET: join(root, "missing-verifier.sock") },
		});
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<Record<string, unknown>> }>();
		const pi = {
			registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<Record<string, unknown>> }) => {
				tools.set(tool.name, tool);
			},
			registerCommand: () => undefined,
			on: () => undefined,
			getAllTools: () => [],
			getActiveTools: () => [],
			setActiveTools: () => undefined,
		};
		const legacyCall = vi.spyOn(created.state.legacyHost, "call");
		try {
			if (typeof created.extension === "function") created.extension(pi as never);
			else created.extension.factory(pi as never);
			expect(tools.has("verify_flag")).toBe(true);
			expect(tools.has("check_flag")).toBe(true);
			const result = await tools
				.get("verify_flag")
				?.execute("verify-call", { flag: "flag{candidate}", challenge_id: "target/1" }, undefined, undefined, {
					sessionManager: { getSessionId: () => "native-run" },
				} as never);
			expect(result?.details).toMatchObject({
				data: { verificationOutcome: "infra_error", failureCategory: "transport_error" },
				verificationOutcome: "infra_error",
			});
			expect(result?.terminate).toBeUndefined();
			const checkResult = await tools
				.get("check_flag")
				?.execute("check-call", { flag: "flag{candidate}", challenge_id: "target/1" }, undefined, undefined, {
					sessionManager: { getSessionId: () => "native-run" },
				} as never);
			expect(checkResult?.details).toMatchObject({
				data: { verificationOutcome: "infra_error", failureCategory: "transport_error" },
			});
			expect(checkResult?.terminate).toBeUndefined();
			expect(legacyCall).not.toHaveBeenCalledWith("verify_flag", expect.anything(), expect.anything());
			expect(legacyCall).not.toHaveBeenCalledWith("check_flag", expect.anything(), expect.anything());
		} finally {
			created.state.close();
		}
	});

	it("uses the trusted Field target for a PLAN_SINGLE verifier call when the model omits challenge_id", async () => {
		const root = temporaryRoot();
		const verifier = await listenVerifierSocket([{ ok: false, status: "incorrect", verified: false }]);
		const env = { CTF_ORACLE_SOCKET: verifier.path };
		const config = loadSecHeurConfig({
			projectRoot: root,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env,
		});
		const created = createSecHeurExtension({
			config,
			env,
			trustedTaskIdentity: { challengeId: "cybench/target-a", runId: "field-run-a" },
			requireTrustedChallengeId: true,
		});
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<Record<string, unknown>> }>();
		const pi = {
			registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<Record<string, unknown>> }) => {
				tools.set(tool.name, tool);
			},
			registerCommand: () => undefined,
			on: () => undefined,
			getAllTools: () => [],
			getActiveTools: () => [],
			setActiveTools: () => undefined,
		};
		try {
			if (typeof created.extension === "function") created.extension(pi as never);
			else created.extension.factory(pi as never);
			const result = await tools
				.get("verify_flag")
				?.execute("plan-single-child-call", { flag: "MOCK_CANDIDATE" }, undefined, undefined, {
					sessionManager: { getSessionId: () => "child-session-a" },
				} as never);
			expect(result?.details).toMatchObject({ data: { status: "incorrect", verificationOutcome: "incorrect" } });
			expect(verifier.requests).toEqual([
				{ flag: "MOCK_CANDIDATE", challenge_id: "cybench/target-a", agent_id: "secheur-pi", run_id: "field-run-a" },
			]);
		} finally {
			created.state.close();
			await verifier.close();
		}
	});

	it("does not resend a nested rejected candidate through either parent verifier alias", async () => {
		const root = temporaryRoot();
		const verifier = await listenVerifierSocket([{ ok: false, status: "incorrect", verified: false }]);
		const env = { CTF_ORACLE_SOCKET: verifier.path };
		const config = loadSecHeurConfig({
			projectRoot: root,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env,
		});
		const identity = { challengeId: "cybench/target-a", runId: "field-run-a" };
		const child = createSecHeurExtension({
			config,
			env,
			trustedTaskIdentity: identity,
			requireTrustedChallengeId: true,
		});
		const parent = createSecHeurExtension({
			config,
			env,
			trustedTaskIdentity: identity,
			requireTrustedChallengeId: true,
		});
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<Record<string, unknown>> }>();
		const pi = {
			registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<Record<string, unknown>> }) => {
				tools.set(tool.name, tool);
			},
			registerCommand: () => undefined,
			on: () => undefined,
			getAllTools: () => [],
			getActiveTools: () => [],
			setActiveTools: () => undefined,
		};
		const context = { sessionManager: { getSessionId: () => "parent-session" } } as never;
		try {
			if (typeof child.extension === "function") child.extension(pi as never);
			else child.extension.factory(pi as never);
			const first = await tools
				.get("verify_flag")
				?.execute("child-call", { flag: "MOCK_BAD" }, undefined, undefined, context);
			expect(first?.details).toMatchObject({ data: { status: "incorrect" } });
			seedRejectedPlanningVerifierEvidence(parent.state, {
				run: { runId: "planning-run-a" },
				evidence: [
					{
						runId: "planning-run-a",
						kind: "tool",
						source: "verify_flag",
						toolName: "verify_flag",
						metadata: {
							verifierStatus: "incorrect",
							candidateHash: createHash("sha256").update("MOCK_BAD").digest("hex"),
						},
					},
				],
			} as never);
			if (typeof parent.extension === "function") parent.extension(pi as never);
			else parent.extension.factory(pi as never);
			const repeated = await tools
				.get("check_flag")
				?.execute("parent-call", { flag: "MOCK_BAD" }, undefined, undefined, context);
			expect(repeated?.details).toMatchObject({ data: { status: "duplicate", verificationOutcome: "incorrect" } });
			const newCandidate = await tools
				.get("verify_flag")
				?.execute("parent-new", { flag: "MOCK_OTHER" }, undefined, undefined, context);
			expect(newCandidate?.details).toMatchObject({ data: { status: "incorrect" } });
			const aliasRepeat = await tools
				.get("check_flag")
				?.execute("parent-repeat", { flag: "MOCK_OTHER" }, undefined, undefined, context);
			expect(aliasRepeat?.details).toMatchObject({
				data: { status: "duplicate", verificationOutcome: "incorrect" },
			});
			expect(verifier.requests).toHaveLength(2);
		} finally {
			child.state.close();
			parent.state.close();
			await verifier.close();
		}
	});

	it("accepts the bound challenge_id, rejects a conflicting one, and fails closed without a target", async () => {
		const root = temporaryRoot();
		const verifier = await listenVerifierSocket([{ ok: true, status: "correct", verified: true }]);
		const env = { CTF_ORACLE_SOCKET: verifier.path };
		const config = loadSecHeurConfig({
			projectRoot: root,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env,
		});
		const makeTools = (trustedTaskIdentity?: { challengeId?: string; runId?: string }) => {
			const created = createSecHeurExtension({
				config,
				env,
				trustedTaskIdentity,
				requireTrustedChallengeId: true,
			});
			const tools = new Map<
				string,
				{
					parameters: { properties?: Record<string, unknown> };
					execute: (...args: unknown[]) => Promise<Record<string, unknown>>;
				}
			>();
			const pi = {
				registerTool: (tool: {
					name: string;
					parameters: { properties?: Record<string, unknown> };
					execute: (...args: unknown[]) => Promise<Record<string, unknown>>;
				}) => {
					tools.set(tool.name, tool);
				},
				registerCommand: () => undefined,
				on: () => undefined,
				getAllTools: () => [],
				getActiveTools: () => [],
				setActiveTools: () => undefined,
			};
			if (typeof created.extension === "function") created.extension(pi as never);
			else created.extension.factory(pi as never);
			return { created, tool: tools.get("verify_flag")! };
		};
		const bound = makeTools({ challengeId: "cybench/target-b", runId: "field-run-b" });
		const missing = makeTools();
		try {
			expect(Object.keys(bound.tool.parameters.properties ?? {})).toEqual(["flag"]);
			expect(Object.keys(missing.tool.parameters.properties ?? {})).toContain("challenge_id");
			const hostBound = await bound.tool.execute("host-bound-id", { flag: "MOCK_CORRECT" }, undefined, undefined, {
				sessionManager: { getSessionId: () => "child-session-b" },
			} as never);
			expect(hostBound?.details).toMatchObject({ data: { status: "correct", verified: true } });
			const accepted = await bound.tool.execute(
				"matching-id",
				{ flag: "MOCK_CORRECT", challenge_id: "cybench/target-b" },
				undefined,
				undefined,
				{ sessionManager: { getSessionId: () => "child-session-b" } } as never,
			);
			expect(accepted?.details).toMatchObject({ data: { status: "correct", verified: true } });
			const conflict = await bound.tool.execute(
				"conflicting-id",
				{ flag: "MOCK_CORRECT", challenge_id: "cybench/other" },
				undefined,
				undefined,
				{ sessionManager: { getSessionId: () => "child-session-b" } } as never,
			);
			expect(conflict?.details).toMatchObject({ data: { failureCategory: "identity_conflict" } });
			expect(conflict?.terminate).toBeUndefined();
			const missingResult = await missing.tool.execute(
				"missing-id",
				{ flag: "MUST_NOT_BE_SENT" },
				undefined,
				undefined,
				{ sessionManager: { getSessionId: () => "child-session-missing" } } as never,
			);
			expect(missingResult?.details).toMatchObject({ data: { failureCategory: "identity_missing" } });
			expect(verifier.requests).toHaveLength(1);
			expect(verifier.requests[0]).toMatchObject({ challenge_id: "cybench/target-b" });
		} finally {
			bound.created.state.close();
			missing.created.state.close();
			await verifier.close();
		}
	});

	it("keeps parent and child identities isolated across sequential CTF sessions", async () => {
		const root = temporaryRoot();
		const verifier = await listenVerifierSocket([
			{ ok: false, status: "incorrect", verified: false },
			{ ok: false, status: "incorrect", verified: false },
		]);
		const env = { CTF_ORACLE_SOCKET: verifier.path };
		const config = loadSecHeurConfig({
			projectRoot: root,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env,
		});
		const createTool = (challengeId: string, runId: string) => {
			const created = createSecHeurExtension({
				config,
				env,
				subAgentDepth: 1,
				trustedTaskIdentity: { challengeId, runId },
				requireTrustedChallengeId: true,
			});
			const tools = new Map<string, { execute: (...args: unknown[]) => Promise<Record<string, unknown>> }>();
			const pi = {
				registerTool: (tool: {
					name: string;
					execute: (...args: unknown[]) => Promise<Record<string, unknown>>;
				}) => {
					tools.set(tool.name, tool);
				},
				registerCommand: () => undefined,
				on: () => undefined,
				getAllTools: () => [],
				getActiveTools: () => [],
				setActiveTools: () => undefined,
			};
			if (typeof created.extension === "function") created.extension(pi as never);
			else created.extension.factory(pi as never);
			return { created, tool: tools.get("verify_flag")! };
		};
		const first = createTool("cybench/first", "run-first");
		const second = createTool("cybench/second", "run-second");
		try {
			await first.tool.execute("first", { flag: "FIRST" }, undefined, undefined, {
				sessionManager: { getSessionId: () => "child-first" },
			} as never);
			await second.tool.execute("second", { flag: "SECOND" }, undefined, undefined, {
				sessionManager: { getSessionId: () => "child-second" },
			} as never);
			expect(verifier.requests).toEqual([
				{ flag: "FIRST", challenge_id: "cybench/first", agent_id: "secheur-pi", run_id: "run-first" },
				{ flag: "SECOND", challenge_id: "cybench/second", agent_id: "secheur-pi", run_id: "run-second" },
			]);
		} finally {
			first.created.state.close();
			second.created.state.close();
			await verifier.close();
		}
	});
});
