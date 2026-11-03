import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSecHeurConfig } from "../src/config.ts";
import { writeDesktopConfig } from "../src/desktop-config.ts";
import { createSecHeurExtension } from "../src/extension.ts";

const temporaryRoots: string[] = [];
type TestHandler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "secheur-knowledge-routing-"));
	temporaryRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createPiHarness(
	allTools: Array<{ name: string; description: string }> = [],
	initialActiveTools: string[] = [],
) {
	const handlers = new Map<string, TestHandler[]>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<Record<string, unknown>> }>();
	const activeTools = new Set(initialActiveTools);
	const sendMessage = vi.fn();
	return {
		handlers,
		tools,
		activeTools,
		sendMessage,
		pi: {
			registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<Record<string, unknown>> }) => {
				tools.set(tool.name, tool);
			},
			registerCommand: () => undefined,
			on: (event: string, handler: TestHandler) => {
				const current = handlers.get(event) ?? [];
				current.push(handler);
				handlers.set(event, current);
			},
			getAllTools: () => allTools,
			getActiveTools: () => [...activeTools],
			setActiveTools: (names: string[]) => {
				activeTools.clear();
				for (const name of names) activeTools.add(name);
			},
			sendMessage,
		},
	};
}

function requiredHandler(harness: ReturnType<typeof createPiHarness>, event: string, index = 0): TestHandler {
	const eventHandlers = harness.handlers.get(event);
	const handler = index < 0 ? eventHandlers?.at(index) : eventHandlers?.[index];
	if (!handler) throw new Error(`${event} handler was not registered`);
	return handler;
}

describe("attack knowledge-base routing", () => {
	it("keeps the attack tool out of the runtime schema and tool_search when disabled", async () => {
		const config = loadSecHeurConfig({
			projectRoot: temporaryRoot(),
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const created = createSecHeurExtension({ config });
		const harness = createPiHarness([
			{ name: "attack_memory_search", description: "Search curated attack patterns" },
			{ name: "memory_search", description: "Search operational memory" },
		]);
		try {
			if (typeof created.extension === "function") created.extension(harness.pi as never);
			else created.extension.factory(harness.pi as never);

			expect(config.knowledgeBaseEnabled).toBe(false);
			expect(harness.tools.has("attack_memory_search")).toBe(false);
			expect(readFileSync(config.systemPromptPath, "utf8")).not.toContain("attack_memory_search");
			const toolSearch = harness.tools.get("tool_search");
			if (!toolSearch) throw new Error("tool_search was not registered");
			const result = await toolSearch.execute("call-1", { query: "memory" }, undefined, undefined, {});
			expect(result?.details).toMatchObject({ matches: [{ name: "memory_search" }] });
		} finally {
			created.state.close();
		}
	});

	it("registers and executes attack_memory_search when explicitly enabled", async () => {
		const base = loadSecHeurConfig({
			projectRoot: temporaryRoot(),
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const created = createSecHeurExtension({ config: { ...base, knowledgeBaseEnabled: true } });
		const harness = createPiHarness([
			{ name: "attack_memory_search", description: "Search curated attack patterns" },
		]);
		const call = vi.spyOn(created.state.legacyHost, "call").mockResolvedValue({
			id: 1,
			ok: true,
			content: "Attack memory matches",
			data: { status: "success" },
		} as never);
		try {
			if (typeof created.extension === "function") created.extension(harness.pi as never);
			else created.extension.factory(harness.pi as never);

			const attackSearch = harness.tools.get("attack_memory_search");
			expect(attackSearch).toBeDefined();
			if (!attackSearch) throw new Error("attack_memory_search was not registered");
			const toolSearch = harness.tools.get("tool_search");
			if (!toolSearch) throw new Error("tool_search was not registered");
			const discovered = await toolSearch.execute("call-1", { query: "attack" }, undefined, undefined, {});
			expect(discovered.details).toMatchObject({ matches: [{ name: "attack_memory_search" }] });
			await attackSearch.execute("call-2", { query: "heap use-after-free", top_k: 3 }, undefined, undefined, {});
			expect(call).toHaveBeenCalledWith(
				"attack_memory_search",
				{ query: "heap use-after-free", top_k: 3 },
				undefined,
			);

			created.state.setKnowledgeBaseEnabled(false);
			await expect(attackSearch.execute("call-3", { query: "heap" }, undefined, undefined, {})).rejects.toThrow(
				"Attack knowledge base is disabled. Enable it before using attack_memory_search.",
			);
		} finally {
			created.state.close();
		}
	});

	it("injects one operational-memory result synchronously without reviewer steering", async () => {
		const config = loadSecHeurConfig({
			projectRoot: temporaryRoot(),
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const created = createSecHeurExtension({ config });
		const harness = createPiHarness();
		const call = vi.spyOn(created.state.legacyHost, "call").mockImplementation(async (tool) => {
			if (tool === "__memory_prefetch") {
				return {
					id: 2,
					ok: true,
					data: { status: "success" },
					nextPrompt: "[MemorySearch] operational result",
				} as never;
			}
			return { id: 1, ok: true } as never;
		});
		try {
			if (typeof created.extension === "function") created.extension(harness.pi as never);
			else created.extension.factory(harness.pi as never);
			const beforeStart = requiredHandler(harness, "before_agent_start");
			const result = (await beforeStart(
				{ prompt: "inspect this repository", systemPrompt: "BASE" },
				{ sessionManager: { getSessionId: () => "session-1" }, signal: undefined },
			)) as { systemPrompt?: string };

			expect(result.systemPrompt?.split("[MemorySearch] operational result")).toHaveLength(2);
			expect(result.systemPrompt).not.toContain("attack_memory_search");
			expect(harness.sendMessage).not.toHaveBeenCalled();
			expect(call).not.toHaveBeenCalledWith("__knowledge_reviewed", expect.anything());
		} finally {
			created.state.close();
		}
	});

	it.each([
		"solve this heap use-after-free exploit",
		"review this project and use the knowledge base to exploit its SQL injection",
		"exploit this command injection vulnerability",
		"bypass this CSRF protection",
		"exploit this file upload vulnerability",
		"reverse this crackme",
		"factor this RSA modulus",
	])("bootstraps attack knowledge before a concrete attack task: %s", async (prompt) => {
		const base = loadSecHeurConfig({
			projectRoot: temporaryRoot(),
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const created = createSecHeurExtension({ config: { ...base, knowledgeBaseEnabled: true } });
		created.state.setMemoryReferenceEnabled(false);
		const harness = createPiHarness([
			{ name: "attack_memory_search", description: "Search curated attack patterns" },
		]);
		const signal = new AbortController().signal;
		const call = vi.spyOn(created.state.legacyHost, "call").mockImplementation(async (tool, args) => {
			if (tool === "attack_memory_search") {
				const input = (args ?? {}) as Record<string, unknown>;
				const family = /heap use-after-free/i.test(prompt)
					? ["use-after-free"]
					: /SQL injection/i.test(prompt)
						? ["sql injection"]
						: /command injection/i.test(prompt)
							? ["command injection"]
							: /CSRF/i.test(prompt)
								? ["csrf"]
								: /file upload/i.test(prompt)
									? ["file upload"]
									: /crackme/i.test(prompt)
										? ["crackme"]
										: ["rsa"];
				return {
					id: 2,
					ok: true,
					data: {
						status: "success",
						knowledge_packet: [
							{
								record_id: "card-1",
								category: input.category ?? "web",
								kind: "knowledge_card",
								score: 9.5,
								challenge: "matched family",
								label: family[0],
								attack_pattern: family,
								why_matched: `attack pattern ${family[0]}`,
								recognition_signals: family,
								preconditions: ["The target is string-concatenated."],
								attack_steps: ["Inject the payload."],
								poc: "",
								failure_modes: ["WAF blocks quotes"],
								source_urls: ["https://example.test/match"],
								review_status: "draft",
							},
						],
					},
				} as never;
			}
			return { id: 1, ok: true } as never;
		});
		try {
			if (typeof created.extension === "function") created.extension(harness.pi as never);
			else created.extension.factory(harness.pi as never);
			const beforeStart = requiredHandler(harness, "before_agent_start");
			const result = (await beforeStart(
				{ prompt, systemPrompt: "BASE" },
				{ sessionManager: { getSessionId: () => "session-2" }, signal },
			)) as { systemPrompt?: string };

			const attackCall = call.mock.calls.find(([tool]) => tool === "attack_memory_search");
			expect(attackCall).toBeDefined();
			expect(attackCall?.[1]).toMatchObject({ top_k: 20, include_full_record: true });
			expect(attackCall?.[1]).toHaveProperty("category");
			expect(result.systemPrompt).toContain('<runtime_attack_knowledge trigger="task_bootstrap"');
			expect(result.systemPrompt).toContain("card_id: card-1");
		} finally {
			created.state.close();
		}
	});

	it("prioritizes attack retrieval on the serialized legacy host", async () => {
		const base = loadSecHeurConfig({
			projectRoot: temporaryRoot(),
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const created = createSecHeurExtension({ config: { ...base, knowledgeBaseEnabled: true } });
		const harness = createPiHarness([
			{ name: "attack_memory_search", description: "Search curated attack patterns" },
		]);
		const calledTools: string[] = [];
		vi.spyOn(created.state.legacyHost, "call").mockImplementation(async (tool) => {
			calledTools.push(tool);
			if (tool === "attack_memory_search") {
				return { id: 2, ok: true, data: { status: "not_found" } } as never;
			}
			if (tool === "__memory_prefetch") {
				return { id: 3, ok: true, data: { status: "not_found" } } as never;
			}
			return { id: 1, ok: true } as never;
		});
		try {
			if (typeof created.extension === "function") created.extension(harness.pi as never);
			else created.extension.factory(harness.pi as never);
			const beforeStart = requiredHandler(harness, "before_agent_start");
			await beforeStart(
				{ prompt: "exploit this command injection", systemPrompt: "BASE" },
				{ sessionManager: { getSessionId: () => "session-prefetch-order" }, signal: undefined },
			);

			expect(calledTools).toEqual(expect.arrayContaining(["attack_memory_search", "__memory_prefetch"]));
			expect(calledTools.indexOf("attack_memory_search")).toBeLessThan(calledTools.indexOf("__memory_prefetch"));
		} finally {
			created.state.close();
		}
	});

	it.each([
		"inspect this repository",
		"CTF challenge ID 123",
		"find the flag",
		"solve this binary search tree test failure",
		"fix the use-after-free regression in this codebase",
		"\u4fee\u590d\u9879\u76ee\u91cc\u7684 SQL \u6ce8\u5165\u6d4b\u8bd5",
		"optimize attack_memory_search routing for heap use-after-free tests",
	])("does not prefetch attack knowledge for a generic prompt: %s", async (prompt) => {
		const base = loadSecHeurConfig({
			projectRoot: temporaryRoot(),
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const created = createSecHeurExtension({ config: { ...base, knowledgeBaseEnabled: true } });
		created.state.setMemoryReferenceEnabled(false);
		const harness = createPiHarness([
			{ name: "attack_memory_search", description: "Search curated attack patterns" },
		]);
		const call = vi.spyOn(created.state.legacyHost, "call").mockResolvedValue({ id: 1, ok: true } as never);
		try {
			if (typeof created.extension === "function") created.extension(harness.pi as never);
			else created.extension.factory(harness.pi as never);
			const beforeStart = requiredHandler(harness, "before_agent_start");
			await beforeStart(
				{ prompt, systemPrompt: "BASE" },
				{ sessionManager: { getSessionId: () => "session-generic" }, signal: new AbortController().signal },
			);

			expect(call.mock.calls.some(([tool]) => tool === "attack_memory_search")).toBe(false);
		} finally {
			created.state.close();
		}
	});

	it("does not prefetch attack knowledge when the independent switch is disabled", async () => {
		const config = loadSecHeurConfig({
			projectRoot: temporaryRoot(),
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const created = createSecHeurExtension({ config });
		created.state.setMemoryReferenceEnabled(false);
		const harness = createPiHarness([
			{ name: "attack_memory_search", description: "Search curated attack patterns" },
		]);
		const call = vi.spyOn(created.state.legacyHost, "call").mockResolvedValue({ id: 1, ok: true } as never);
		try {
			if (typeof created.extension === "function") created.extension(harness.pi as never);
			else created.extension.factory(harness.pi as never);
			const beforeStart = requiredHandler(harness, "before_agent_start");
			await beforeStart(
				{ prompt: "solve this heap use-after-free exploit", systemPrompt: "BASE" },
				{ sessionManager: { getSessionId: () => "session-disabled" }, signal: new AbortController().signal },
			);

			expect(call.mock.calls.some(([tool]) => tool === "attack_memory_search")).toBe(false);
		} finally {
			created.state.close();
		}
	});

	it("does not bypass a session-level attack_memory_search exclusion", async () => {
		const base = loadSecHeurConfig({
			projectRoot: temporaryRoot(),
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const created = createSecHeurExtension({ config: { ...base, knowledgeBaseEnabled: true } });
		created.state.setMemoryReferenceEnabled(false);
		const harness = createPiHarness([{ name: "memory_search", description: "Search operational memory" }]);
		const call = vi.spyOn(created.state.legacyHost, "call").mockResolvedValue({ id: 1, ok: true } as never);
		try {
			if (typeof created.extension === "function") created.extension(harness.pi as never);
			else created.extension.factory(harness.pi as never);
			const beforeStart = requiredHandler(harness, "before_agent_start");
			const result = (await beforeStart(
				{ prompt: "exploit this SQL injection", systemPrompt: "BASE" },
				{ sessionManager: { getSessionId: () => "session-excluded" }, signal: undefined },
			)) as { systemPrompt?: string };

			expect(call.mock.calls.some(([tool]) => tool === "attack_memory_search")).toBe(false);
			expect(result.systemPrompt).not.toContain("Runtime Attack Knowledge Retrieval");
			expect(result.systemPrompt).not.toContain("attack_memory_search");
		} finally {
			created.state.close();
		}
	});

	it("shares the parent task context and does not repeat the bootstrap in a sub-agent", async () => {
		const base = loadSecHeurConfig({
			projectRoot: temporaryRoot(),
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const parent = createSecHeurExtension({ config: { ...base, knowledgeBaseEnabled: true } });
		parent.state.setMemoryReferenceEnabled(false);
		const parentHarness = createPiHarness([
			{ name: "attack_memory_search", description: "Search curated attack patterns" },
		]);
		const call = vi.spyOn(parent.state.legacyHost, "call").mockImplementation(async (tool, args) => {
			if (tool === "attack_memory_search") {
				const input = (args ?? {}) as Record<string, unknown>;
				return {
					id: 2,
					ok: true,
					data: {
						status: "success",
						knowledge_packet: [
							{
								record_id: "card-parent",
								category: input.category ?? "web",
								kind: "knowledge_card",
								score: 9.5,
								challenge: "parent match",
								label: "command injection",
								attack_pattern: ["command injection"],
								why_matched: "attack pattern command injection",
								recognition_signals: ["command injection"],
								preconditions: ["Shell metacharacters reach the sink."],
								attack_steps: ["Inject a shell payload."],
								poc: "",
								failure_modes: [],
								source_urls: ["https://example.test/command-injection"],
								review_status: "draft",
							},
						],
					},
				} as never;
			}
			return { id: 1, ok: true } as never;
		});
		try {
			if (typeof parent.extension === "function") parent.extension(parentHarness.pi as never);
			else parent.extension.factory(parentHarness.pi as never);
			const parentBeforeStart = requiredHandler(parentHarness, "before_agent_start");
			await parentBeforeStart(
				{ prompt: "exploit this command injection", systemPrompt: "BASE" },
				{ sessionManager: { getSessionId: () => "session-parent" }, signal: undefined },
			);
			const parentCalls = call.mock.calls.filter(([tool]) => tool === "attack_memory_search").length;
			expect(parentCalls).toBe(1);

			const child = createSecHeurExtension({
				config: { ...base, knowledgeBaseEnabled: true },
				subAgentDepth: 1,
				knowledgeCoordinator: parent.state.knowledgeCoordinator,
			});
			child.state.setMemoryReferenceEnabled(false);
			const childHarness = createPiHarness([
				{ name: "attack_memory_search", description: "Search curated attack patterns" },
			]);
			const childCall = vi.spyOn(child.state.legacyHost, "call").mockResolvedValue({ id: 3, ok: true } as never);
			try {
				if (typeof child.extension === "function") child.extension(childHarness.pi as never);
				else child.extension.factory(childHarness.pi as never);
				const childBeforeStart = requiredHandler(childHarness, "before_agent_start");
				await childBeforeStart(
					{ prompt: "exploit this command injection", systemPrompt: "BASE" },
					{ sessionManager: { getSessionId: () => "session-parent" }, signal: undefined },
				);

				// The child shares the parent's ledger: no repeated first search.
				expect(call.mock.calls.filter(([tool]) => tool === "attack_memory_search")).toHaveLength(1);
				expect(childCall.mock.calls.some(([tool]) => tool === "attack_memory_search")).toBe(false);
			} finally {
				child.state.close();
			}
		} finally {
			parent.state.close();
		}
	});

	it("preserves a parent knowledge exclusion in a planning sub-agent", async () => {
		const base = loadSecHeurConfig({
			projectRoot: temporaryRoot(),
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const created = createSecHeurExtension({
			config: { ...base, knowledgeBaseEnabled: true },
			subAgentDepth: 1,
			allowKnowledgeBaseRetrieval: false,
		});
		created.state.setMemoryReferenceEnabled(false);
		const harness = createPiHarness([
			{ name: "attack_memory_search", description: "Search curated attack patterns" },
		]);
		const call = vi.spyOn(created.state.legacyHost, "call").mockResolvedValue({ id: 1, ok: true } as never);
		try {
			if (typeof created.extension === "function") created.extension(harness.pi as never);
			else created.extension.factory(harness.pi as never);
			const beforeStart = requiredHandler(harness, "before_agent_start");
			await beforeStart(
				{ prompt: "exploit this command injection", systemPrompt: "BASE" },
				{ sessionManager: { getSessionId: () => "session-sub-agent-excluded" }, signal: undefined },
			);

			expect(harness.tools.has("attack_memory_search")).toBe(false);
			expect(call.mock.calls.some(([tool]) => tool === "attack_memory_search")).toBe(false);
		} finally {
			created.state.close();
		}
	});

	it("keeps the triggering technique in a bounded long-prompt query", async () => {
		const base = loadSecHeurConfig({
			projectRoot: temporaryRoot(),
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const created = createSecHeurExtension({ config: { ...base, knowledgeBaseEnabled: true } });
		created.state.setMemoryReferenceEnabled(false);
		const harness = createPiHarness([
			{ name: "attack_memory_search", description: "Search curated attack patterns" },
		]);
		const prompt = `${"background context ".repeat(400)}exploit this SQL injection`;
		const call = vi.spyOn(created.state.legacyHost, "call").mockResolvedValue({
			id: 1,
			ok: true,
			data: { status: "not_found" },
		} as never);
		try {
			if (typeof created.extension === "function") created.extension(harness.pi as never);
			else created.extension.factory(harness.pi as never);
			const beforeStart = requiredHandler(harness, "before_agent_start");
			await beforeStart(
				{ prompt, systemPrompt: "BASE" },
				{ sessionManager: { getSessionId: () => "session-long" }, signal: undefined },
			);

			const attackCall = call.mock.calls.find(([tool]) => tool === "attack_memory_search");
			expect(attackCall).toBeDefined();
			const args = attackCall?.[1] as { query?: unknown; category?: unknown } | undefined;
			expect(args?.category).toBe("web");
			const query = args?.query;
			expect(query).toEqual(expect.any(String));
			// The structured query keeps the attack-anchored objective window
			// instead of shipping the whole 4,000-character prompt.
			expect((query as string).length).toBeLessThanOrEqual(1_000);
			expect((query as string).toLowerCase()).toContain("exploit this sql injection");
		} finally {
			created.state.close();
		}
	});

	it("reloads desktop knowledge configuration before a managed CLI prompt", async () => {
		const root = temporaryRoot();
		writeDesktopConfig(root, { knowledgeBaseEnabled: false });
		const config = loadSecHeurConfig({
			projectRoot: root,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const created = createSecHeurExtension({
			config,
			env: {},
			registerInactiveKnowledgeBaseTool: true,
			reloadKnowledgeBaseConfigBeforePrompt: true,
		});
		created.state.setMemoryReferenceEnabled(false);
		const harness = createPiHarness(
			[{ name: "attack_memory_search", description: "Search curated attack patterns" }],
			["attack_memory_search"],
		);
		const call = vi.spyOn(created.state.legacyHost, "call").mockImplementation(async (tool, args) => {
			if (tool === "attack_memory_search") {
				const input = (args ?? {}) as Record<string, unknown>;
				return {
					id: 2,
					ok: true,
					data: {
						status: "success",
						knowledge_packet: [
							{
								record_id: "card-refreshed",
								category: input.category ?? "pwn",
								kind: "knowledge_card",
								score: 9.5,
								challenge: "heap match",
								label: "use-after-free",
								attack_pattern: ["use-after-free"],
								why_matched: "attack pattern use-after-free",
								recognition_signals: ["use-after-free"],
								preconditions: ["A dangling pointer is dereferenced."],
								attack_steps: ["Reallocate the chunk."],
								poc: "",
								failure_modes: [],
								source_urls: ["https://example.test/uaf"],
								review_status: "draft",
							},
						],
					},
				} as never;
			}
			return { id: 1, ok: true } as never;
		});
		try {
			if (typeof created.extension === "function") created.extension(harness.pi as never);
			else created.extension.factory(harness.pi as never);
			for (const sessionStart of harness.handlers.get("session_start") ?? []) {
				await sessionStart({}, { hasUI: false, ui: { notify: () => undefined } });
			}
			expect(harness.activeTools.has("attack_memory_search")).toBe(false);

			writeDesktopConfig(root, { knowledgeBaseEnabled: true });
			const beforeStart = requiredHandler(harness, "before_agent_start");
			const result = (await beforeStart(
				{ prompt: "solve this heap use-after-free exploit", systemPrompt: "BASE" },
				{ sessionManager: { getSessionId: () => "session-managed" }, signal: undefined },
			)) as { systemPrompt?: string };

			expect(created.state.isKnowledgeBaseEnabled()).toBe(true);
			expect(harness.activeTools.has("attack_memory_search")).toBe(true);
			expect(call.mock.calls.some(([tool]) => tool === "attack_memory_search")).toBe(true);
			expect(result.systemPrompt).toContain('<runtime_attack_knowledge trigger="task_bootstrap"');
			expect(result.systemPrompt).toContain("card_id: card-refreshed");
		} finally {
			created.state.close();
		}
	});

	it("hides the model-side knowledge tool in solve mode but keeps the runtime path", async () => {
		const root = temporaryRoot();
		writeDesktopConfig(root, { knowledgeBaseEnabled: true });
		const base = loadSecHeurConfig({
			projectRoot: root,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const created = createSecHeurExtension({
			config: { ...base, knowledgeBaseEnabled: true },
			registerInactiveKnowledgeBaseTool: true,
			reloadKnowledgeBaseConfigBeforePrompt: true,
		});
		created.state.setMemoryReferenceEnabled(false);
		created.state.knowledgeCoordinator.bindCompetitionEnvelope({
			taskId: "task-solve-1",
			category: "Web",
			name: "Login",
			description: "SQL injection bypass",
		});
		const harness = createPiHarness(
			[{ name: "attack_memory_search", description: "Search curated attack patterns" }],
			["attack_memory_search"],
		);
		const call = vi.spyOn(created.state.legacyHost, "call").mockImplementation(async (tool, args) => {
			if (tool === "attack_memory_search") {
				const input = (args ?? {}) as Record<string, unknown>;
				return {
					id: 2,
					ok: true,
					data: {
						status: "success",
						knowledge_packet: [
							{
								record_id: "card-solve",
								category: input.category ?? "web",
								kind: "knowledge_card",
								score: 9.5,
								challenge: "solve match",
								label: "sql injection",
								attack_pattern: ["sql injection"],
								why_matched: "attack pattern sql injection",
								recognition_signals: ["sql injection"],
								preconditions: ["The query is string-concatenated."],
								attack_steps: ["Inject the payload."],
								poc: "",
								failure_modes: [],
								source_urls: ["https://example.test/solve"],
								review_status: "draft",
							},
						],
					},
				} as never;
			}
			return { id: 1, ok: true } as never;
		});
		try {
			if (typeof created.extension === "function") created.extension(harness.pi as never);
			else created.extension.factory(harness.pi as never);
			const beforeStart = requiredHandler(harness, "before_agent_start");
			const result = (await beforeStart(
				{ prompt: "solve it", systemPrompt: "BASE" },
				{ sessionManager: { getSessionId: () => "session-solve" }, signal: undefined },
			)) as { systemPrompt?: string };

			// Runtime-only: the tool leaves the active model tools and tool_search...
			expect(harness.activeTools.has("attack_memory_search")).toBe(false);
			const toolSearch = harness.tools.get("tool_search");
			if (!toolSearch) throw new Error("tool_search was not registered");
			const discovered = await toolSearch.execute("call-1", { query: "attack" }, undefined, undefined, {});
			expect(discovered.details).toMatchObject({ matches: [] });
			// ...while the runtime still bootstraps from the competition envelope.
			expect(call.mock.calls.some(([tool]) => tool === "attack_memory_search")).toBe(true);
			expect(result.systemPrompt).toContain("card_id: card-solve");
			expect(result.systemPrompt?.toLowerCase()).toContain("do not call the knowledge tool yourself");
		} finally {
			created.state.close();
		}
	});

	it("hides the knowledge tool once competition_claim binds the solve envelope mid-turn", async () => {
		const root = temporaryRoot();
		writeDesktopConfig(root, { knowledgeBaseEnabled: true });
		const base = loadSecHeurConfig({
			projectRoot: root,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const claim = vi.fn().mockResolvedValue({
			taskId: "task-claim-1",
			challenge: { category: "Web", name: "Login", description: "SQL injection bypass" },
		});
		const created = createSecHeurExtension({
			config: { ...base, knowledgeBaseEnabled: true },
			competition: { taskId: "task-claim-1", claim } as never,
			reloadKnowledgeBaseConfigBeforePrompt: true,
		});
		created.state.setMemoryReferenceEnabled(false);
		const harness = createPiHarness(
			[{ name: "attack_memory_search", description: "Search curated attack patterns" }],
			["attack_memory_search"],
		);
		vi.spyOn(created.state.legacyHost, "call").mockImplementation(async (tool, args) => {
			if (tool === "attack_memory_search") {
				const input = (args ?? {}) as Record<string, unknown>;
				return {
					id: 2,
					ok: true,
					data: {
						status: "success",
						knowledge_packet: [
							{
								record_id: "card-claim",
								category: input.category ?? "web",
								kind: "knowledge_card",
								score: 9.5,
								challenge: "solve match",
								label: "sql injection",
								attack_pattern: ["sql injection"],
								why_matched: "attack pattern sql injection",
								recognition_signals: ["sql injection"],
								preconditions: ["The query is string-concatenated."],
								attack_steps: ["Inject the payload."],
								poc: "",
								failure_modes: [],
								source_urls: ["https://example.test/solve"],
								review_status: "draft",
							},
						],
					},
				} as never;
			}
			return { id: 1, ok: true } as never;
		});
		try {
			if (typeof created.extension === "function") created.extension(harness.pi as never);
			else created.extension.factory(harness.pi as never);
			// No solve envelope is bound yet, so before_agent_start keeps the tool visible.
			const beforeStart = requiredHandler(harness, "before_agent_start");
			await beforeStart(
				{ prompt: "solve it", systemPrompt: "BASE" },
				{ sessionManager: { getSessionId: () => "session-claim" }, signal: undefined },
			);
			expect(harness.activeTools.has("attack_memory_search")).toBe(true);

			// Claiming the immutable envelope flips the coordinator into solve mode
			// and must hide the model-side knowledge tool mid-turn.
			const claimTool = harness.tools.get("competition_claim");
			if (!claimTool) throw new Error("competition_claim was not registered");
			await claimTool.execute("call-1", { task_id: "task-claim-1" }, undefined, undefined, {});
			expect(claim).toHaveBeenCalled();
			expect(created.state.knowledgeCoordinator.isSolveMode()).toBe(true);
			expect(harness.activeTools.has("attack_memory_search")).toBe(false);

			// The claim tool result must not overwrite the mandatory bootstrap
			// trigger that bindCompetitionEnvelope just queued.
			const toolResultHandler = requiredHandler(harness, "tool_result");
			await toolResultHandler(
				{
					toolName: "competition_claim",
					content: [
						{
							type: "text",
							text: JSON.stringify({
								taskId: "task-claim-1",
								challenge: { category: "Web", name: "Login", description: "SQL injection bypass" },
							}),
						},
					],
					isError: false,
					details: {},
				},
				{},
			);
			expect(created.state.knowledgeCoordinator.getState().retrieval.pendingTrigger).toBe("task_bootstrap");
		} finally {
			created.state.close();
		}
	});
});
