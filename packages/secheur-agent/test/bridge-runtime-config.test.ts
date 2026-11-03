import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSecHeurConfig, type PermissionMode } from "../src/config.ts";
import { writeDesktopConfig } from "../src/desktop-config.ts";
import { resolveExecutionMode } from "../src/execution-mode.ts";
import { PermissionController } from "../src/permissions.ts";
import type { CreateSecHeurRuntimeOptions, SecHeurRuntime } from "../src/runtime.ts";

const runtimeFactory = vi.hoisted(() => vi.fn());
vi.mock("../src/runtime.ts", () => ({
	createSecHeurRuntime: runtimeFactory,
}));

import { SecHeurBridge } from "../src/bridge.ts";

const bridges: SecHeurBridge[] = [];
const roots: string[] = [];

function runtimeStub(
	dispose: () => void,
	prompt: () => Promise<void> = async () => undefined,
	permissions = new PermissionController("default"),
	config: unknown = {},
) {
	return {
		config: config as never,
		state: {
			permissions,
			permissionBroker: permissions.broker,
			getTurnCount: () => 0,
			getLastJudge: () => undefined,
			close: () => undefined,
		},
		session: {
			messages: [],
			sessionId: "bridge-runtime-config-session",
			sessionFile: undefined,
			sessionName: undefined,
			model: undefined,
			setSessionName: vi.fn(),
			modelRuntime: { getAvailableSnapshot: () => [] },
			abort: async () => undefined,
		},
		extensionsResult: {} as never,
		subscribe: () => () => undefined,
		prompt,
		abort: async () => undefined,
		getBudgetStatus: () => ({ maxTurns: 3, turnsUsed: 0, cost: 0, stopped: false }),
		setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
		setMemoryReferenceEnabled: () => undefined,
		setKnowledgeBaseEnabled: () => undefined,
		setWebVerbsEnabled: () => undefined,
		dispose,
	} as never;
}

afterEach(async () => {
	for (const bridge of bridges.splice(0)) await bridge.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	runtimeFactory.mockReset();
});

describe("desktop runtime configuration", () => {
	it("updates local and shared Planning capacity while a session is running without restarting it", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-capacity-"));
		roots.push(root);
		const config = loadSecHeurConfig({
			projectRoot: root,
			env: {},
			executionMode: "plan_multi",
			executionCapacity: 2,
		});
		let finish = () => {};
		const blocked = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const prompt = vi.fn(async () => blocked),
			dispose = vi.fn();
		const setCapacity = vi.fn((capacity: number) => {
			config.executionMode.capacity = capacity;
			return capacity;
		});
		const stub = runtimeStub(dispose, prompt, undefined, config) as SecHeurRuntime;
		stub.setExecutionCapacity = setCapacity;
		runtimeFactory.mockResolvedValue(stub);
		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			schedulerBackend: false,
			env: {
				SECHEUR_COMPETITION_SOCKET:
					process.platform === "win32"
						? `\\\\.\\pipe\\planning-capacity-${process.pid}-${Date.now()}`
						: join(root, "competition.sock"),
			},
		});
		bridges.push(bridge);
		try {
			await bridge.listen();
			const base = `http://127.0.0.1:${bridge.address.port}`;
			const post = (path: string, value: Record<string, unknown>) =>
				fetch(base + path, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(value),
				});
			const created = (await (
				await post("/session/new", { cwd: root, persist: false, executionMode: "plan_multi" })
			).json()) as { sessionId: string };
			await post(`/session/${created.sessionId}/prompt`, { prompt: "work" });
			await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
			const local = await post(`/session/${created.sessionId}/planning/capacity`, { executionCapacity: 3 });
			expect(local.status).toBe(200);
			expect(await local.json()).toMatchObject({ executionCapacity: 3, persistent: false });
			expect(setCapacity).toHaveBeenCalledWith(3);
			const global = await post("/planning/capacity", { globalExecutorCapacity: 4 });
			expect(global.status).toBe(409);
			expect(await global.json()).toMatchObject({ error: expect.stringContaining("disabled") });
			expect(await (await fetch(`${base}/planning/capacity`)).json()).toMatchObject({ enabled: false, scope: "per_run", capacity: null });
			expect((await post("/planning/capacity", { globalExecutorCapacity: 0 })).status).toBe(409);
			expect(
				(await post(`/session/${created.sessionId}/planning/capacity`, { executionCapacity: 1.5 })).status,
			).toBe(400);
			expect(dispose).not.toHaveBeenCalled();
			expect(runtimeFactory).toHaveBeenCalledOnce();
		} finally {
			finish();
		}
	});
	it("uses the environment knowledge-base override for new sessions", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-knowledge-env-test-"));
		roots.push(root);
		writeDesktopConfig(root, { knowledgeBaseEnabled: false });
		let markPromptStarted = (): void => {};
		let releasePrompt = (): void => {};
		const promptStarted = new Promise<void>((resolvePromise) => {
			markPromptStarted = resolvePromise;
		});
		const promptBlocked = new Promise<void>((resolvePromise) => {
			releasePrompt = resolvePromise;
		});
		const dispose = vi.fn();
		runtimeFactory.mockResolvedValue(
			runtimeStub(dispose, async () => {
				markPromptStarted();
				await promptBlocked;
			}),
		);
		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			schedulerBackend: false,
			env: { SECHEUR_KNOWLEDGE_BASE_ENABLED: "1" },
		});
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;

		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false }),
		}).then((response) => response.json())) as {
			sessionId: string;
			session: { knowledgeBaseEnabled: boolean };
		};

		try {
			expect(runtimeFactory.mock.calls[0]?.[0]).toMatchObject({ knowledgeBaseEnabled: true });
			expect(created.session.knowledgeBaseEnabled).toBe(true);

			await fetch(`${base}/session/${created.sessionId}/prompt`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ prompt: "keep the effective knowledge setting" }),
			});
			await promptStarted;
			const saved = (await fetch(`${base}/config`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ knowledgeBaseEnabled: false }),
			}).then((response) => response.json())) as { runtimeReloadPending: number };
			expect(saved.runtimeReloadPending).toBe(1);
			const updated = (await fetch(`${base}/session/${created.sessionId}`).then((response) => response.json())) as {
				session: { knowledgeBaseEnabled: boolean };
			};
			expect(updated.session.knowledgeBaseEnabled).toBe(true);
		} finally {
			releasePrompt();
		}
		await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
	});

	it("recreates an idle runtime after agent settings change", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-runtime-config-test-"));
		roots.push(root);
		const disposes: Array<ReturnType<typeof vi.fn>> = [];
		runtimeFactory.mockImplementation(async () => {
			const dispose = vi.fn();
			disposes.push(dispose);
			return runtimeStub(dispose);
		});
		const bridge = new SecHeurBridge({ projectRoot: root, port: 0, schedulerBackend: false });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false }),
		}).then((response) => response.json())) as { sessionId: string };

		const saved = (await fetch(`${base}/config`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				maxTurns: 3,
				maxCost: "",
				thinkingMode: "disabled",
				thinkingBudget: "",
				attemptDedupEnabled: true,
				customSkillDirectories: "extra-skills",
			}),
		}).then((response) => response.json())) as { ok: boolean; runtimeReloadPending: number };

		expect(saved).toMatchObject({ ok: true, runtimeReloadPending: 0 });
		expect(disposes[0]).toHaveBeenCalledTimes(1);
		const config = loadSecHeurConfig({
			projectRoot: root,
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: {},
		});
		expect(config).toMatchObject({
			maxTurns: 3,
			thinkingMode: "disabled",
			attemptDedupEnabled: true,
			skillPaths: expect.arrayContaining([join(root, "extra-skills")]),
		});
		expect(config.maxCost).toBeUndefined();

		await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "after config change" }),
		});
		await vi.waitFor(() => expect(runtimeFactory).toHaveBeenCalledTimes(2));
	});

	it("recreates the runtime when the attack knowledge-base setting changes", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-knowledge-config-test-"));
		roots.push(root);
		const disposes: Array<ReturnType<typeof vi.fn>> = [];
		runtimeFactory.mockImplementation(async () => {
			const dispose = vi.fn();
			disposes.push(dispose);
			return runtimeStub(dispose);
		});
		const bridge = new SecHeurBridge({ projectRoot: root, port: 0, schedulerBackend: false });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false }),
		}).then((response) => response.json())) as { sessionId: string };

		expect(runtimeFactory.mock.calls[0]?.[0]).toMatchObject({ knowledgeBaseEnabled: false });
		const initial = (await fetch(`${base}/session/${created.sessionId}`).then((response) => response.json())) as {
			session: { knowledgeBaseEnabled: boolean };
		};
		expect(initial.session.knowledgeBaseEnabled).toBe(false);

		const saved = (await fetch(`${base}/config`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ knowledgeBaseEnabled: true }),
		}).then((response) => response.json())) as { ok: boolean; runtimeReloadPending: number };
		expect(saved).toMatchObject({ ok: true, runtimeReloadPending: 0 });
		expect(disposes[0]).toHaveBeenCalledTimes(1);

		const updated = (await fetch(`${base}/session/${created.sessionId}`).then((response) => response.json())) as {
			session: { knowledgeBaseEnabled: boolean };
		};
		expect(updated.session.knowledgeBaseEnabled).toBe(true);
		expect(
			loadSecHeurConfig({
				projectRoot: root,
				legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
				env: {},
			}).knowledgeBaseEnabled,
		).toBe(true);

		await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "use the enabled attack knowledge base" }),
		});
		await vi.waitFor(() => expect(runtimeFactory).toHaveBeenCalledTimes(2));
		expect(runtimeFactory.mock.calls[1]?.[0]).toMatchObject({ knowledgeBaseEnabled: true });
	});

	it("does not send runtime settings as model prompts", () => {
		const source = readFileSync(
			resolve(import.meta.dirname, "../../../legacy/frontends/desktop/static/app.js"),
			"utf8",
		);
		const start = source.indexOf("async function applyRuntimeSettings()");
		const end = source.indexOf("async function setComposerPermissionMode", start);
		const implementation = source.slice(start, end);

		expect(implementation).toContain("await saveSettings();");
		expect(implementation).not.toContain("/agent.max_turns");
		expect(implementation).not.toContain("/agent.max_cost");
		expect(implementation).not.toContain("/thinking");
		expect(implementation).not.toContain("sendPrompt(");
	});

	it("routes supported Pi built-ins to Web or Bridge actions", () => {
		const source = readFileSync(
			resolve(import.meta.dirname, "../../../legacy/frontends/desktop/static/app.js"),
			"utf8",
		);
		const supportedStart = source.indexOf("const WEB_PI_BUILTIN_NAMES");
		const supportedEnd = source.indexOf("let slashSuggestionIndex", supportedStart);
		const supported = source.slice(supportedStart, supportedEnd);
		const handlerStart = source.indexOf("async function handlePiBuiltinSlashCommand");
		const handlerEnd = source.indexOf("// ─── Slash commands", handlerStart);
		const handler = source.slice(handlerStart, handlerEnd);
		for (const name of [
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
		]) {
			expect(supported).toContain(`'${name}'`);
		}
		for (const bridgeCommand of [
			"export",
			"import",
			"share",
			"name",
			"session",
			"fork",
			"clone",
			"tree",
			"trust",
			"compact",
			"reload",
		]) {
			expect(handler).toContain(`runPiSessionCommand('${bridgeCommand}'`);
		}
		expect(source).toContain("bridgeApi.rpc('session/command'");
	});

	it("does not change permission mode while a session is running", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-permission-config-test-"));
		roots.push(root);
		let finishPrompt: (() => void) | undefined;
		const prompt = vi.fn(
			() =>
				new Promise<void>((resolvePrompt) => {
					finishPrompt = resolvePrompt;
				}),
		);
		const permissions = new PermissionController("default");
		const runtime = runtimeStub(vi.fn(), prompt, permissions);
		runtimeFactory.mockResolvedValue(runtime);
		const bridge = new SecHeurBridge({ projectRoot: root, port: 0, schedulerBackend: false });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false }),
		}).then((response) => response.json())) as { sessionId: string };

		await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "keep current permissions" }),
		});
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));

		await fetch(`${base}/config`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ permissionMode: "bypassPermissions" }),
		});
		const running = (await fetch(`${base}/session/${created.sessionId}`).then((response) => response.json())) as {
			session: { permissionMode: PermissionMode };
		};
		expect(running.session.permissionMode).toBe("default");
		expect(permissions.mode).toBe("default");

		finishPrompt?.();
		await vi.waitFor(async () => {
			const payload = (await fetch(`${base}/session/${created.sessionId}`).then((response) => response.json())) as {
				session: { status: string };
			};
			expect(payload.session.status).toBe("idle");
		});

		await fetch(`${base}/config`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ permissionMode: "acceptEdits" }),
		});
		expect(permissions.mode).toBe("acceptEdits");
	});

	it("records the resolved execution mode from the production runtime callback", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-mode-observability-test-"));
		roots.push(root);
		const mode = resolveExecutionMode({ mode: "direct" });
		const permissions = new PermissionController("default");
		const dispose = vi.fn();
		runtimeFactory.mockImplementation(async (options: CreateSecHeurRuntimeOptions) =>
			runtimeStub(dispose, async () => options.onExecutionModeSelected?.(mode), permissions, {
				executionMode: mode,
			}),
		);
		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
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
			body: JSON.stringify({ cwd: root, persist: false, executionMode: "direct" }),
		}).then((response) => response.json())) as { sessionId: string };

		await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "record direct mode" }),
		});
		await vi.waitFor(async () => {
			const payload = (await fetch(`${base}/session/${created.sessionId}/runtime/log`).then((response) =>
				response.json(),
			)) as { events: Array<Record<string, unknown>> };
			const event = payload.events.find((item) => item.event === "execution_mode_selected");
			expect(event).toMatchObject({
				mode: "direct",
				planningEnabled: false,
				capacity: 1,
				legacyPlanningMode: "off",
			});
		});
		const snapshot = (await fetch(`${base}/session/${created.sessionId}`).then((response) => response.json())) as {
			session: Record<string, unknown>;
		};
		expect(snapshot.session).toMatchObject({
			executionMode: "direct",
			executionCapacity: 1,
			legacyPlanningMode: "off",
		});
	});
});
