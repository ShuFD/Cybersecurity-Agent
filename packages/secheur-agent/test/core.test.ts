import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSecHeurConfig } from "../src/config.ts";
import {
	buildDesktopRegistry,
	deleteApiConfig,
	deleteMcpServer,
	deleteProjectAgent,
	deleteProjectSkill,
	readApiConfig,
	saveApiConfig,
	saveMcpServer,
	saveProjectAgent,
	saveProjectSkill,
	writeDesktopConfig,
	writeRegistryState,
} from "../src/desktop-config.ts";
import { createSecHeurExtension, createSecHeurExtensionFactory } from "../src/extension.ts";
import { type McpExposedTool, McpManager, makeMcpToolName, registerMcpExtension } from "../src/mcp.ts";
import {
	evaluateToolPermission,
	isDangerousCommand,
	isPlanSafeCommand,
	PermissionBroker,
	PermissionController,
} from "../src/permissions.ts";
import { formatLegacyEnvironmentReport, inspectLegacyEnvironment } from "../src/python-runtime.ts";
import { createSecHeurRuntime } from "../src/runtime.ts";
import { discoverPiSubAgents, runPiSubAgent } from "../src/subagent.ts";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "secheur-agent-test-"));
	temporaryRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("configuration", () => {
	it("loads desktop bridge output watchdog settings with the expected precedence", () => {
		const defaults = loadSecHeurConfig({
			projectRoot: temporaryRoot(),
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		expect(defaults).toMatchObject({
			agentFirstOutputTimeoutMs: 120_000,
			agentOutputIdleTimeoutMs: 600_000,
		});

		const environment = loadSecHeurConfig({
			projectRoot: temporaryRoot(),
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {
				SECHEUR_AGENT_FIRST_OUTPUT_TIMEOUT: "3",
				SECHEUR_AGENT_OUTPUT_IDLE_TIMEOUT: "5",
			},
		});
		expect(environment).toMatchObject({
			agentFirstOutputTimeoutMs: 3_000,
			agentOutputIdleTimeoutMs: 5_000,
		});

		const desktopRoot = temporaryRoot();
		writeDesktopConfig(desktopRoot, {
			agentFirstOutputTimeoutSeconds: 7,
			agentOutputIdleTimeoutSeconds: 11,
		});
		const desktop = loadSecHeurConfig({
			projectRoot: desktopRoot,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {
				SECHEUR_AGENT_FIRST_OUTPUT_TIMEOUT: "3",
				SECHEUR_AGENT_OUTPUT_IDLE_TIMEOUT: "5",
			},
		});
		expect(desktop).toMatchObject({
			agentFirstOutputTimeoutMs: 7_000,
			agentOutputIdleTimeoutMs: 11_000,
		});
	});

	it("loads desktop, permission, judge, and MCP settings", () => {
		const root = temporaryRoot();
		writeDesktopConfig(root, {
			permissionMode: "plan",
			judge: { enabled: false, every_n_turns: 3, max_history_messages: 6, model_profile: "1" },
		});
		saveMcpServer(root, { config: { name: "local", command: "node", args: ["server.js"], timeout: 2 } });

		const config = loadSecHeurConfig({
			projectRoot: root,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});

		expect(config.permissionMode).toBe("plan");
		expect(config.judge).toEqual({ enabled: false, everyNTurns: 3, maxHistoryMessages: 6, modelProfile: "1" });
		expect(config.mcpServers.local).toMatchObject({
			transport: "stdio",
			command: "node",
			args: ["server.js"],
			timeoutMs: 2000,
		});
	});

	it("normalizes the deployed streamable-http MCP configuration", () => {
		const root = temporaryRoot();
		const stateDir = join(root, ".secheur-agent");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			join(stateDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"ctf-toolbox": {
						transport: "streamable-http",
						url: "http://127.0.0.1:18080/mcp",
						timeout: 120,
					},
				},
			}),
		);

		const config = loadSecHeurConfig({
			projectRoot: root,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});

		expect(config.mcpServers["ctf-toolbox"]).toMatchObject({
			transport: "http",
			url: "http://127.0.0.1:18080/mcp",
			timeoutMs: 120_000,
		});
	});

	it("reports actionable Python compatibility setup diagnostics", () => {
		const root = temporaryRoot();
		const config = loadSecHeurConfig({
			projectRoot: root,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const diagnostic = inspectLegacyEnvironment({ ...config, pythonExecutable: process.execPath });
		const report = formatLegacyEnvironmentReport(diagnostic);

		expect(diagnostic.ready).toBe(false);
		expect(diagnostic.errors).toEqual(expect.arrayContaining([expect.stringContaining("Python probe failed")]));
		expect(diagnostic.setupCommands).toHaveLength(2);
		expect(report).toContain("Legacy Python runtime is not ready.");
		expect(report).toContain("-m venv");
		expect(report).toContain("-m pip install");
	});

	it("does not append the legacy system prompt a second time before a turn", async () => {
		const root = temporaryRoot();
		const config = loadSecHeurConfig({
			projectRoot: root,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const created = createSecHeurExtension({ config });
		type TestHandler = (event: Record<string, unknown>, ctx: unknown) => unknown;
		const handlers = new Map<string, TestHandler[]>();
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
		};
		try {
			if (typeof created.extension === "function") created.extension(pi as never);
			else created.extension.factory(pi as never);
			created.state.setMemoryReferenceEnabled(false);
			const handler = handlers.get("before_agent_start")?.[0];
			expect(handler).toBeDefined();
			const legacyPrompt = readFileSync(config.systemPromptPath, "utf8").trim();
			const result = (await handler?.({ prompt: "test", systemPrompt: legacyPrompt }, {})) as
				| { systemPrompt?: string }
				| undefined;

			expect(result?.systemPrompt?.split(legacyPrompt)).toHaveLength(2);
			expect(result?.systemPrompt).toContain("# SecHeur Agent Integration");
		} finally {
			created.state.close();
		}
	});

	it("bounds and synchronously injects memory prefetch without changing the main Legacy tool timeout", async () => {
		const root = temporaryRoot();
		const config = loadSecHeurConfig({
			projectRoot: root,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const created = createSecHeurExtension({ config });
		type TestHandler = (event: Record<string, unknown>, ctx: unknown) => unknown;
		const handlers = new Map<string, TestHandler[]>();
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
		};
		const call = vi.spyOn(created.state.legacyHost, "call").mockResolvedValue({
			id: 1,
			ok: true,
			data: { status: "success" },
			content: "memory context",
		} as never);
		try {
			if (typeof created.extension === "function") created.extension(pi as never);
			else created.extension.factory(pi as never);
			const handler = handlers.get("before_agent_start")?.[0];
			const result = (await handler?.({ prompt: "inspect target", systemPrompt: "base" }, {})) as
				| { systemPrompt?: string }
				| undefined;

			expect(call).toHaveBeenCalledWith(
				"__memory_prefetch",
				{ query: "inspect target", limit: 5 },
				undefined,
				3_000,
			);
			expect(result?.systemPrompt).toContain("memory context");
			expect(result?.systemPrompt).toContain("# SecHeur Agent Integration");
		} finally {
			created.state.close();
		}
	});
});

describe("extension lifecycle", () => {
	it("creates independent state for each Pi session", async () => {
		const root = temporaryRoot();
		const config = loadSecHeurConfig({
			projectRoot: root,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const extension = createSecHeurExtensionFactory({ config });
		const cancelAll = vi.spyOn(PermissionBroker.prototype, "cancelAll");

		type TestHandler = (...args: unknown[]) => unknown;
		function createPi() {
			const handlers = new Map<string, TestHandler[]>();
			return {
				handlers,
				api: {
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
				},
			};
		}

		const first = createPi();
		const second = createPi();
		if (typeof extension === "function") {
			await extension(first.api as never);
			await extension(second.api as never);
		} else {
			await extension.factory(first.api as never);
			await extension.factory(second.api as never);
		}

		for (const handler of first.handlers.get("session_shutdown") ?? []) await handler({});
		expect(cancelAll).toHaveBeenCalledTimes(1);
		const firstBroker = cancelAll.mock.contexts[0];

		for (const handler of second.handlers.get("session_shutdown") ?? []) await handler({});
		expect(cancelAll).toHaveBeenCalledTimes(2);
		expect(cancelAll.mock.contexts[1]).not.toBe(firstBroker);
	});
});

describe("sub-agents", () => {
	it("does not initialize a child runtime for an already-aborted request", async () => {
		const root = temporaryRoot();
		const config = loadSecHeurConfig({
			projectRoot: root,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const controller = new AbortController();
		controller.abort();
		const createChildExtension = vi.fn();

		await expect(
			runPiSubAgent(
				{
					config,
					agentType: "reviewer",
					task: "Review the change",
					permissionMode: "default",
					createChildExtension,
				},
				{ cwd: root } as never,
				controller.signal,
			),
		).rejects.toThrow("Sub-agent aborted");
		expect(createChildExtension).not.toHaveBeenCalled();
	});
});

describe("permissions", () => {
	it("blocks mutations in plan mode and prompts for dangerous shell commands", () => {
		expect(isDangerousCommand("rm -rf ./output")).toBe(true);
		expect(isPlanSafeCommand("git status --short")).toBe(true);
		expect(isPlanSafeCommand("cat 'notes with spaces.txt'")).toBe(true);
		expect(isPlanSafeCommand("find . -name '*.ts'")).toBe(true);
		for (const command of [
			'cat "$(touch changed)"',
			"find . -exec rm {} +",
			"git status $(rm -rf output)",
			"git diff --output=changed.patch",
			"git branch -Dtopic",
			"git branch --delete=topic",
			"sed -i 's/a/b/' file.txt",
			"awk 'BEGIN { system(\"touch changed\") }'",
			"rg --pre 'touch changed' pattern",
		]) {
			expect(isPlanSafeCommand(command), command).toBe(false);
		}
		expect(evaluateToolPermission("plan", "write", { path: "a.txt" }).action).toBe("deny");
		expect(evaluateToolPermission("default", "bash", { command: "rm -rf ./output" }).action).toBe("confirm");
		expect(evaluateToolPermission("dontAsk", "bash", { command: "rm -rf ./output" }).action).toBe("deny");
	});

	it("remembers allow_session grants for canonical tool arguments", () => {
		const controller = new PermissionController("default");
		const input = { command: "rm -rf ./output", metadata: { reason: "cleanup", attempt: 1 } };

		expect(controller.evaluate("bash", input).action).toBe("confirm");
		const signature = controller.allowForSession("bash", input);
		expect(
			controller.evaluate("bash", { metadata: { attempt: 1, reason: "cleanup" }, command: input.command }),
		).toEqual({
			action: "allow",
			reason: "Tool arguments were allowed for this session",
		});
		expect(controller.evaluate("bash", { ...input, command: "rm -rf ./other-output" }).action).toBe("confirm");

		const restored = new PermissionController("default");
		restored.restoreSessionGrants([signature]);
		expect(restored.evaluate("bash", input).action).toBe("allow");
	});

	it("passes an ask_user answer through the permission broker", async () => {
		const broker = new PermissionBroker();
		const answer = broker.requestAnswer("ask_user", { question: "Continue?" }, "Continue?");
		const request = broker.list()[0];

		expect(request).toBeDefined();
		expect(broker.resolve(request.id, true, "yes")).toBe(true);
		await expect(answer).resolves.toBe("yes");
	});
});

describe("MCP tool names", () => {
	it("creates stable safe names within the provider limit", () => {
		const shortName = makeMcpToolName("ctf toolbox", "read/file");
		const longName = makeMcpToolName("server".repeat(20), "tool".repeat(30));

		expect(shortName).toBe("mcp__ctf_toolbox__read_file");
		expect(longName.length).toBeLessThanOrEqual(64);
		expect(longName).toBe(makeMcpToolName("server".repeat(20), "tool".repeat(30)));
	});

	it("deactivates remote tools that disappear after refresh", async () => {
		const manager = new McpManager({});
		const remoteTool: McpExposedTool = {
			name: "echo",
			exposedName: "mcp__fixture__echo",
			serverName: "fixture",
			description: "Echo",
			inputSchema: { type: "object" } as never,
		};
		const refresh = vi.spyOn(manager, "refresh").mockResolvedValueOnce([remoteTool]).mockResolvedValueOnce([]);
		type TestHandler = (...args: unknown[]) => unknown;
		type TestTool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
		const handlers = new Map<string, TestHandler>();
		const tools = new Map<string, TestTool>();
		let activeTools = ["read"];
		const context = {
			getActiveTools: () => [...activeTools],
			setActiveTools: (names: string[]) => {
				activeTools = [...names];
			},
			ui: { notify: vi.fn() },
		};
		const pi = {
			registerTool: (tool: TestTool) => {
				tools.set(tool.name, tool);
				if (tool.name.startsWith("mcp__")) activeTools.push(tool.name);
			},
			registerCommand: () => undefined,
			on: (event: string, handler: TestHandler) => handlers.set(event, handler),
			getActiveTools: () => [...activeTools],
			setActiveTools: (names: string[]) => {
				activeTools = [...names];
			},
		};
		registerMcpExtension(pi as never, manager);

		handlers.get("session_start")?.({}, context);
		await vi.waitFor(() => expect(activeTools).toContain(remoteTool.exposedName));
		const refreshTool = tools.get("mcp_refresh");
		expect(refreshTool).toBeDefined();

		await refreshTool?.execute("call-1", {}, new AbortController().signal, () => undefined, context);
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(activeTools).not.toContain(remoteTool.exposedName);
	});
});

describe("desktop compatibility configuration", () => {
	it("quotes YAML frontmatter values without changing their text", () => {
		const root = temporaryRoot();
		const description = 'Use: "focused evidence" # keep this text';
		const whenToUse = "Use when: evidence # needs review";
		saveProjectSkill(root, {
			config: { name: "quoted-skill", description, body: "Use local evidence." },
		});
		saveProjectAgent(root, {
			config: { name: "quoted-agent", description, whenToUse, body: "Review the evidence." },
		});
		const config = loadSecHeurConfig({
			projectRoot: root,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const registry = buildDesktopRegistry(root, config);
		const skill = (registry.skills as Array<Record<string, unknown>>).find((item) => item.name === "quoted-skill");
		const agent = (registry.agents as Array<Record<string, unknown>>).find((item) => item.name === "quoted-agent");

		expect(skill?.description).toBe(description);
		expect(agent).toMatchObject({ description, whenToUse });
		expect(readFileSync(join(root, ".secheur-agent", "skills", "quoted-skill", "SKILL.md"), "utf8")).toContain(
			`description: ${JSON.stringify(description)}`,
		);
	});

	it("persists profiles and resources without returning API secrets", () => {
		const root = temporaryRoot();
		const response = saveApiConfig(root, {
			config: {
				name: "local-model",
				apibase: "http://127.0.0.1:9000/v1",
				model: "test-model",
				apikey: "test-secret-value",
			},
		});
		expect(JSON.stringify(response)).not.toContain("test-secret-value");
		expect(readApiConfig(root)).toMatchObject({ hasApiKey: true, activeNames: ["local-model"] });
		expect(readFileSync(join(root, "mykey.py"), "utf8")).toContain("test-secret-value");

		saveProjectSkill(root, { config: { name: "local-skill", body: "Use local evidence." } });
		saveProjectAgent(root, { config: { name: "local-agent", body: "Complete the focused task." } });
		saveMcpServer(root, { config: { name: "local-mcp", command: "node", args: ["server.js"] } });
		writeRegistryState(root, { skills: { "local-skill": false } });
		const config = loadSecHeurConfig({
			projectRoot: root,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		const registry = buildDesktopRegistry(root, config);
		const skills = registry.skills as Array<Record<string, unknown>>;

		expect(skills.find((skill) => skill.name === "local-skill")?.enabled).toBe(false);
		expect((registry.tools as Array<Record<string, unknown>>).some((tool) => tool.name === "read")).toBe(true);
		expect((registry.tools as Array<Record<string, unknown>>).some((tool) => tool.name === "file_read")).toBe(true);
		expect(
			(registry.agents as Array<Record<string, unknown>>).filter((agent) => agent.source === "builtin"),
		).toHaveLength(3);
		expect((registry.agents as Array<Record<string, unknown>>).some((agent) => agent.name === "local-agent")).toBe(
			true,
		);
		expect(
			(registry.mcpServers as Array<Record<string, unknown>>).some((server) => server.name === "local-mcp"),
		).toBe(true);

		deleteProjectSkill(root, "local-skill");
		deleteProjectAgent(root, "local-agent");
		deleteMcpServer(root, "local-mcp");
		deleteApiConfig(root, "local-model");
		expect(existsSync(join(root, "mykey.py"))).toBe(false);
	});

	it("only treats the current API key mask as a secret placeholder", () => {
		const root = temporaryRoot();
		const secret = "ab.+/token=value?";
		const saved = saveApiConfig(root, {
			config: {
				name: "punctuation-key",
				apibase: "https://api.example.test/v1",
				model: "test-model",
				apikey: secret,
			},
		});
		const profile = (saved.profiles as Array<Record<string, unknown>>)[0];
		expect(profile?.maskedApiKey).toBe("ab.+...lue?");

		saveApiConfig(root, {
			config: {
				...(profile?.config as Record<string, unknown>),
				name: "punctuation-key",
				apikey: profile?.maskedApiKey,
			},
		});
		let stored = JSON.parse(readFileSync(join(root, ".secheur-agent", "api-profiles.json"), "utf8")) as {
			profiles: Array<Record<string, unknown>>;
		};
		expect(stored.profiles[0]?.apikey).toBe(secret);

		saveApiConfig(root, {
			config: {
				...(profile?.config as Record<string, unknown>),
				name: "punctuation-key",
				apikey: "next...key2",
			},
		});
		stored = JSON.parse(readFileSync(join(root, ".secheur-agent", "api-profiles.json"), "utf8")) as {
			profiles: Array<Record<string, unknown>>;
		};
		expect(stored.profiles[0]?.apikey).toBe("next...key2");
	});

	it("synchronizes SecHeur profiles into Pi without replacing user-owned configuration", () => {
		const root = temporaryRoot();
		const piDir = join(root, ".secheur-agent", "pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(
			join(piDir, "models.json"),
			JSON.stringify({
				providers: {
					existing: { baseUrl: "https://existing.test/v1", api: "openai-completions", models: [{ id: "keep" }] },
					"secheur-local-model": {
						baseUrl: "https://user-owned.test/v1",
						api: "openai-completions",
						models: [{ id: "do-not-replace" }],
					},
				},
			}),
		);
		writeFileSync(
			join(piDir, "auth.json"),
			JSON.stringify({
				existing: { type: "api_key", key: "existing-key" },
				"secheur-local-model": { type: "api_key", key: "user-owned-key" },
			}),
		);
		writeFileSync(join(piDir, "settings.json"), JSON.stringify({ theme: "dark", defaultProvider: "existing" }));

		const localResponse = saveApiConfig(root, {
			config: {
				name: "local-model",
				apibase: "http://127.0.0.1:9000/v1",
				model: "test-model",
				apikey: "test-secret-value",
				api_mode: "responses",
				context_win: 200000,
				max_tokens: 32000,
				reasoning_effort: "high",
				temperature: 0.2,
				input_cost_per_1m: 1,
				output_cost_per_1m: 2,
			},
		});
		const localProfile = (localResponse.profiles as Array<Record<string, unknown>>)[0];
		const localProviderId = String(localProfile.piProviderId);
		expect(localProviderId).toMatch(/^secheur-local-model-/u);

		let models = JSON.parse(readFileSync(join(piDir, "models.json"), "utf8")) as Record<string, unknown>;
		let providers = models.providers as Record<string, Record<string, unknown>>;
		expect(providers.existing).toMatchObject({ models: [{ id: "keep" }] });
		expect(providers["secheur-local-model"]).toMatchObject({ models: [{ id: "do-not-replace" }] });
		expect(providers[localProviderId]).toMatchObject({
			name: "local-model",
			baseUrl: "http://127.0.0.1:9000/v1",
			api: "openai-responses",
			models: [
				{
					id: "test-model",
					reasoning: true,
					input: ["text", "image"],
					contextWindow: 200000,
					maxTokens: 32000,
					samplingParams: { temperature: 0.2 },
					cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
				},
			],
		});
		let auth = JSON.parse(readFileSync(join(piDir, "auth.json"), "utf8")) as Record<string, unknown>;
		expect(auth).toMatchObject({
			existing: { type: "api_key", key: "existing-key" },
			"secheur-local-model": { type: "api_key", key: "user-owned-key" },
			[localProviderId]: { type: "api_key", key: "test-secret-value" },
		});
		expect(JSON.parse(readFileSync(join(piDir, "settings.json"), "utf8"))).toMatchObject({
			theme: "dark",
			defaultProvider: localProviderId,
			defaultModel: "test-model",
		});

		const anthropicResponse = saveApiConfig(root, {
			config: {
				name: "claude-relay",
				type: "native_anthropic",
				apibase: "https://relay.test",
				model: "claude-test",
				apikey: "anthropic-secret",
			},
		});
		const anthropicProfile = (anthropicResponse.profiles as Array<Record<string, unknown>>).find(
			(profile) => profile.name === "claude-relay",
		);
		const anthropicProviderId = String(anthropicProfile?.piProviderId);
		providers = (JSON.parse(readFileSync(join(piDir, "models.json"), "utf8")) as { providers: typeof providers })
			.providers;
		expect(providers[anthropicProviderId]).toMatchObject({ api: "anthropic-messages" });

		deleteApiConfig(root, "claude-relay");
		models = JSON.parse(readFileSync(join(piDir, "models.json"), "utf8")) as Record<string, unknown>;
		providers = models.providers as Record<string, Record<string, unknown>>;
		auth = JSON.parse(readFileSync(join(piDir, "auth.json"), "utf8")) as Record<string, unknown>;
		expect(providers[anthropicProviderId]).toBeUndefined();
		expect(auth[anthropicProviderId]).toBeUndefined();
		expect(JSON.parse(readFileSync(join(piDir, "settings.json"), "utf8"))).toMatchObject({
			defaultProvider: localProviderId,
			defaultModel: "test-model",
		});

		writeFileSync(
			join(piDir, "settings.json"),
			JSON.stringify({ theme: "light", defaultProvider: "existing", defaultModel: "keep" }),
		);
		deleteApiConfig(root, "local-model");
		providers = (JSON.parse(readFileSync(join(piDir, "models.json"), "utf8")) as { providers: typeof providers })
			.providers;
		auth = JSON.parse(readFileSync(join(piDir, "auth.json"), "utf8")) as Record<string, unknown>;
		expect(providers[localProviderId]).toBeUndefined();
		expect(providers.existing).toBeDefined();
		expect(providers["secheur-local-model"]).toBeDefined();
		expect(auth[localProviderId]).toBeUndefined();
		expect(auth.existing).toEqual({ type: "api_key", key: "existing-key" });
		expect(JSON.parse(readFileSync(join(piDir, "settings.json"), "utf8"))).toEqual({
			theme: "light",
			defaultProvider: "existing",
			defaultModel: "keep",
		});
	});

	it("uses the active desktop API profile for a newly created Pi runtime", async () => {
		const root = temporaryRoot();
		const legacyRoot = resolve(import.meta.dirname, "../../../legacy");
		const response = saveApiConfig(root, {
			config: {
				name: "runtime-model",
				apibase: "https://runtime.test/v1",
				model: "runtime-test-model",
				apikey: "runtime-test-key",
			},
		});
		const providerId = String((response.profiles as Array<Record<string, unknown>>)[0].piProviderId);

		const runtime = await createSecHeurRuntime({ projectRoot: root, legacyRoot, persist: false });
		try {
			expect(runtime.session.model).toMatchObject({
				provider: providerId,
				id: "runtime-test-model",
				baseUrl: "https://runtime.test/v1",
				api: "openai-completions",
			});
		} finally {
			runtime.dispose();
		}
	});

	it("exposes the complete Pi built-in slash command catalog", async () => {
		const root = temporaryRoot();
		const legacyRoot = resolve(import.meta.dirname, "../../../legacy");
		const runtime = await createSecHeurRuntime({ projectRoot: root, legacyRoot, persist: false });
		try {
			const commands = runtime.getCommands();
			expect(commands.filter((command) => command.source === "builtin").map((command) => command.name)).toEqual([
				"settings",
				"model",
				"scoped-models",
				"export",
				"import",
				"share",
				"copy",
				"name",
				"session",
				"changelog",
				"hotkeys",
				"fork",
				"clone",
				"tree",
				"trust",
				"login",
				"logout",
				"new",
				"compact",
				"resume",
				"reload",
				"quit",
			]);
			expect(new Set(commands.map((command) => command.name)).size).toBe(commands.length);
		} finally {
			runtime.dispose();
		}
	});

	it("applies disabled registry entries to new Pi runtimes", async () => {
		const root = temporaryRoot();
		const legacyRoot = resolve(import.meta.dirname, "../../../legacy");
		saveProjectSkill(root, {
			config: { name: "disabled-skill", description: "Must stay hidden", body: "Never load this skill." },
		});
		saveProjectAgent(root, { config: { name: "disabled-agent", body: "Never run this agent." } });
		saveMcpServer(root, { config: { name: "disabled-mcp", command: "definitely-not-a-command" } });
		writeRegistryState(root, {
			tools: { bash: false, skill: false },
			skills: { "disabled-skill": false },
			agents: { "disabled-agent": false, reviewer: false },
			mcpServers: { "disabled-mcp": false },
		});
		const config = loadSecHeurConfig({ projectRoot: root, legacyRoot, env: {} });

		expect(config.registry.tools).toMatchObject({ bash: false, skill: false });
		expect(discoverPiSubAgents(config).map((agent) => agent.name)).not.toEqual(
			expect.arrayContaining(["disabled-agent", "reviewer"]),
		);

		const runtime = await createSecHeurRuntime({ projectRoot: root, legacyRoot, persist: false });
		try {
			const allTools = runtime.session.getAllTools().map((tool) => tool.name);
			expect(allTools).not.toEqual(expect.arrayContaining(["bash", "skill"]));
			expect(runtime.session.getActiveToolNames()).not.toEqual(expect.arrayContaining(["bash", "skill"]));
			expect(runtime.session.systemPrompt).not.toContain("disabled-skill");
			expect(runtime.state.mcp.diagnostics).toEqual({});
		} finally {
			runtime.dispose();
		}
	});

	it("keeps attack knowledge disabled by default and honors the runtime override", async () => {
		const root = temporaryRoot();
		const legacyRoot = resolve(import.meta.dirname, "../../../legacy");
		const disabled = await createSecHeurRuntime({ projectRoot: root, legacyRoot, persist: false });
		try {
			expect(disabled.config.knowledgeBaseEnabled).toBe(false);
			expect(disabled.session.getAllTools().map((tool) => tool.name)).toContain("attack_memory_search");
			expect(disabled.session.getActiveToolNames()).not.toContain("attack_memory_search");
			disabled.setKnowledgeBaseEnabled(true);
			expect(disabled.config.knowledgeBaseEnabled).toBe(true);
			expect(disabled.state.isKnowledgeBaseEnabled()).toBe(true);
			expect(disabled.session.getActiveToolNames()).toContain("attack_memory_search");
		} finally {
			disabled.dispose();
		}

		const enabled = await createSecHeurRuntime({
			projectRoot: root,
			legacyRoot,
			persist: false,
			knowledgeBaseEnabled: true,
		});
		try {
			expect(enabled.config.knowledgeBaseEnabled).toBe(true);
			expect(enabled.session.getAllTools().map((tool) => tool.name)).toContain("attack_memory_search");
			enabled.setKnowledgeBaseEnabled(false);
			expect(enabled.config.knowledgeBaseEnabled).toBe(false);
			expect(enabled.state.isKnowledgeBaseEnabled()).toBe(false);
			expect(enabled.session.getActiveToolNames()).not.toContain("attack_memory_search");
			enabled.setKnowledgeBaseEnabled(true);
			expect(enabled.session.getActiveToolNames()).toContain("attack_memory_search");
		} finally {
			enabled.dispose();
		}
	});
});
