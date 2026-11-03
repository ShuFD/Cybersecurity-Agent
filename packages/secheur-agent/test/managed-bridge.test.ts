import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { TestServerService } from "@earendil-works/pi-server/testing";
import { createUnixServer } from "@earendil-works/pi-server/unix";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecHeurBridge } from "../src/bridge.ts";
import type { PermissionMode } from "../src/config.ts";
import { writeDesktopConfig } from "../src/desktop-config.ts";
import { PermissionController } from "../src/permissions.ts";
import { PiSessionHost } from "../src/pi-session-host.ts";
import {
	type PiSessionRegistration,
	listSessionRegistrations,
	sessionSocketPath,
	writeSessionRegistrationAt,
} from "../src/session-registry.ts";

const runtimeFactory = vi.hoisted(() => vi.fn());
vi.mock("../src/runtime.ts", () => ({
	createSecHeurRuntime: runtimeFactory,
}));

const bridges: SecHeurBridge[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];
const roots: string[] = [];

afterEach(async () => {
	for (const bridge of bridges.splice(0)) await bridge.close();
	for (const server of servers.splice(0)) await server.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	runtimeFactory.mockReset();
});

async function startManagedMainAgent(root: string, sessionId = "main-session"): Promise<TestServerService> {
	const service = new TestServerService();
	service.seed(sessionId, "Main Agent", root);
	const stateDir = join(root, ".secheur-agent");
	const socketPath = sessionSocketPath(stateDir, sessionId);
	const server = createUnixServer(service, { path: socketPath });
	servers.push(server);
	await server.start();
	const now = Date.now();
	await writeSessionRegistrationAt(stateDir, {
		sessionId,
		role: "main",
		title: "Main Agent",
		socketPath,
		pid: process.pid,
		cwd: root,
		createdAt: now,
		updatedAt: now,
		status: "idle",
	});
	return service;
}

describe("managed desktop bridge", () => {
	it("publishes effective knowledge-base state when the host starts, runs, and replaces its session", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-managed-host-knowledge-state-"));
		roots.push(root);
		const stateDir = join(root, ".secheur-agent");
		writeDesktopConfig(root, { knowledgeBaseEnabled: false });
		const session = {
			sessionId: "managed-host-knowledge-session",
			getAllTools: () => [],
			getActiveToolNames: () => [],
		};
		let replaceSession = (): void => {};
		const runtime = {
			cwd: root,
			session,
			subscribeSessionChanges(listener: (next: typeof session) => void | Promise<void>) {
				replaceSession = () => {
					void listener(session);
				};
				return () => undefined;
			},
		};
		const host = new PiSessionHost(runtime as never, {
			stateDir,
			role: "main",
			title: "Main Agent",
			env: {},
		});
		try {
			await host.start();
			expect(await listSessionRegistrations(stateDir)).toEqual([
				expect.objectContaining({ knowledgeBaseEnabled: false, status: "idle" }),
			]);

			writeDesktopConfig(root, { knowledgeBaseEnabled: true });
			host.updateStatus("running");
			await vi.waitFor(async () => {
				expect(await listSessionRegistrations(stateDir)).toEqual([
					expect.objectContaining({ knowledgeBaseEnabled: true, status: "running" }),
				]);
			});

			writeDesktopConfig(root, { knowledgeBaseEnabled: false });
			replaceSession();
			await vi.waitFor(async () => {
				expect(await listSessionRegistrations(stateDir)).toEqual([
					expect.objectContaining({ knowledgeBaseEnabled: false, status: "idle" }),
				]);
			});
		} finally {
			await host.close();
		}
	});

	it("does not expose persisted JSONL sessions as active managed sessions", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-managed-bridge-"));
		roots.push(root);
		const manager = SessionManager.create(root, join(root, ".secheur-agent", "pi", "sessions", "fixture"));
		manager.appendMessage({ role: "user", content: "must remain TUI-owned", timestamp: 1 });

		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			schedulerBackend: false,
			managedSessions: true,
			worklist: false,
			competition: false,
		});
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;

		const status = (await fetch(`${base}/status`).then((response) => response.json())) as {
			managedSessions: boolean;
			sessionCount: number;
		};
		expect(status).toMatchObject({ managedSessions: true, sessionCount: 0 });
		const sessions = (await fetch(`${base}/sessions`).then((response) => response.json())) as { sessions: unknown[] };
		expect(sessions.sessions).toEqual([]);
		const persisted = await fetch(`${base}/session/${manager.getSessionId()}`);
		expect(persisted.status).toBe(404);
		const created = await fetch(`${base}/session/new`, { method: "POST" });
		expect(created.status).toBe(409);
	});

	it("allows creating a new session once the Main Agent is registered", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-managed-bridge-create-"));
		roots.push(root);
		await startManagedMainAgent(root);
		const permissions = new PermissionController("default");
		runtimeFactory.mockResolvedValue({
			config: {} as never,
			state: {
				permissions,
				permissionBroker: permissions.broker,
				getTurnCount: () => 0,
				getLastJudge: () => undefined,
				close: () => undefined,
			},
			session: {
				messages: [],
				sessionId: "managed-created-session",
				sessionFile: undefined,
				sessionName: undefined,
				setSessionName: vi.fn(),
				modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
				abort: async () => undefined,
			},
			extensionsResult: {} as never,
			subscribe: () => () => undefined,
			prompt: async () => undefined,
			setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
			setMemoryReferenceEnabled: () => undefined,
			setKnowledgeBaseEnabled: () => undefined,
			setWebVerbsEnabled: () => undefined,
			dispose: () => undefined,
		} as never);

		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			schedulerBackend: false,
			managedSessions: true,
			worklist: false,
			competition: false,
		});
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;

		const created = await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false }),
		});
		expect(created.status).toBe(201);
		const payload = (await created.json()) as {
			ok: boolean;
			sessionId: string;
			session: { id: string };
		};
		expect(payload).toMatchObject({
			ok: true,
			sessionId: "managed-created-session",
			session: { id: "managed-created-session" },
		});
		const sessions = (await fetch(`${base}/sessions`).then((response) => response.json())) as {
			activeSessionId: string;
			sessions: Array<{ id: string }>;
		};
		expect(sessions.activeSessionId).toBe("managed-created-session");
		expect(sessions.sessions.map((session) => session.id)).toEqual(
			expect.arrayContaining(["main-session", "managed-created-session"]),
		);
	});

	it("reconnects a managed session before stopping it after the client disconnects", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-managed-bridge-stop-"));
		roots.push(root);
		const service = await startManagedMainAgent(root);

		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			schedulerBackend: false,
			managedSessions: true,
			worklist: false,
			competition: false,
		});
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		await fetch(`${base}/session/main-session`);
		const internals = bridge as unknown as {
			sessions: Map<string, { managed?: { client: { connected: boolean; disconnect(): void } } }>;
		};
		const managed = internals.sessions.get("main-session");
		expect(managed?.managed?.client.connected).toBe(true);
		const runtime = service.latestRuntime("main-session");
		const running = runtime.prompt({ text: "hold" });
		await vi.waitFor(async () => {
			const snapshot = (await fetch(`${base}/session/main-session`).then((response) => response.json())) as {
				session: { status: string };
			};
			expect(snapshot.session.status).toBe("running");
		});
		managed?.managed?.client.disconnect();
		const cancelled = await fetch(`${base}/session/main-session/cancel`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ source: "test", reason: "operator stop" }),
		}).then((response) => response.json());
		expect(cancelled).toMatchObject({ ok: true, cancelled: true });
		await expect(running).resolves.toBeUndefined();
		await vi.waitFor(async () => {
			const snapshot = (await fetch(`${base}/session/main-session`).then((response) => response.json())) as {
				session: { status: string };
			};
			expect(snapshot.session.status).toBe("idle");
		});
	});

	it("lists registered solvers without waiting for an unavailable socket", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-managed-bridge-registry-"));
		roots.push(root);
		const stateDir = join(root, ".secheur-agent");
		const now = Date.now();
		await writeSessionRegistrationAt(stateDir, {
			sessionId: "solver-stalled",
			role: "solver",
			title: "Solver 10756",
			socketPath: join(stateDir, "stale.sock"),
			pid: process.pid,
			cwd: root,
			createdAt: now,
			updatedAt: now,
			status: "running",
			taskId: "ctfd:10756",
			category: "pwn",
			tmuxTarget: "secheur-main:solver-10756",
		});

		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			schedulerBackend: false,
			managedSessions: true,
			worklist: false,
			competition: false,
		});
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const startedAt = Date.now();
		const [status, sessions] = (await Promise.all([
			fetch(`${base}/status`).then((response) => response.json()),
			fetch(`${base}/sessions`).then((response) => response.json()),
		])) as [{ managedSessions: boolean; sessionCount: number }, { sessions: unknown[] }];

		expect(Date.now() - startedAt).toBeLessThan(1_000);
		expect(status).toMatchObject({ managedSessions: true, sessionCount: 1 });
		expect(sessions.sessions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "solver-stalled",
					role: "solver",
					taskId: "ctfd:10756",
					managed: true,
				}),
			]),
		);
	});

	it("can hide solver registrations from the desktop session refresh", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-managed-bridge-filter-"));
		roots.push(root);
		const stateDir = join(root, ".secheur-agent");
		const now = Date.now();
		await writeSessionRegistrationAt(stateDir, {
			sessionId: "main-session",
			role: "main",
			title: "Main Agent",
			socketPath: join(stateDir, "main.sock"),
			pid: process.pid,
			cwd: root,
			createdAt: now,
			updatedAt: now,
			status: "idle",
		});
		await writeSessionRegistrationAt(stateDir, {
			sessionId: "solver-session",
			role: "solver",
			title: "Solver 10756",
			socketPath: join(stateDir, "solver.sock"),
			pid: process.pid,
			cwd: root,
			createdAt: now,
			updatedAt: now,
			status: "running",
			taskId: "ctfd:10756",
			category: "pwn",
		});

		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			schedulerBackend: false,
			managedSessions: true,
			worklist: false,
			competition: false,
		});
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const all = (await fetch(`${base}/sessions`).then((response) => response.json())) as {
			sessions: Array<{ id: string; role?: string }>;
		};
		const desktop = (await fetch(`${base}/sessions?includeSolvers=false`).then((response) => response.json())) as {
			sessions: Array<{ id: string; role?: string }>;
		};

		expect(all.sessions.map((session) => session.id)).toEqual(
			expect.arrayContaining(["main-session", "solver-session"]),
		);
		expect(desktop.sessions).toHaveLength(1);
		expect(desktop.sessions[0]).toMatchObject({ id: "main-session", role: "main" });
	});

	it("serves registered tools and independent knowledge-base state without creating a local runtime", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-managed-bridge-tools-"));
		roots.push(root);
		const stateDir = join(root, ".secheur-agent");
		const sessionId = "main-tools-session";
		const service = new TestServerService();
		service.seed(sessionId, "Main Agent", root);
		const socketPath = sessionSocketPath(stateDir, sessionId);
		const server = createUnixServer(service, { path: socketPath });
		servers.push(server);
		await server.start();
		const now = Date.now();
		const tools = ["read", "attack_memory_search", "competition_sync", "competition_dispatch_solver"];
		const registration: PiSessionRegistration = {
			sessionId,
			role: "main",
			title: "Main Agent",
			socketPath,
			pid: process.pid,
			cwd: root,
			createdAt: now,
			updatedAt: now,
			status: "idle",
			tools,
			activeTools: ["read", "competition_sync"],
			knowledgeBaseEnabled: true,
		};
		await writeSessionRegistrationAt(stateDir, registration);

		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			schedulerBackend: false,
			managedSessions: true,
			worklist: false,
			competition: false,
		});
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const response = await fetch(`${base}/session/${sessionId}/tools`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			sessionId,
			tools,
			activeTools: ["read", "competition_sync"],
		});
		const session = (await fetch(`${base}/session/${sessionId}`).then((item) => item.json())) as {
			session: { knowledgeBaseEnabled: boolean };
		};
		expect(session.session.knowledgeBaseEnabled).toBe(true);

		await writeSessionRegistrationAt(stateDir, {
			...registration,
			updatedAt: now + 1,
			activeTools: ["read", "attack_memory_search", "competition_sync"],
			knowledgeBaseEnabled: false,
		});
		const refreshed = (await fetch(`${base}/sessions`).then((item) => item.json())) as {
			sessions: Array<{ id: string; knowledgeBaseEnabled: boolean }>;
		};
		expect(refreshed.sessions).toEqual([
			expect.objectContaining({ id: sessionId, knowledgeBaseEnabled: false }),
		]);
	});

	it.runIf(process.platform !== "win32")(
		"prefers a reachable registered socket and falls back to the mounted state socket",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "s-"));
			const externalRoot = mkdtempSync(join(tmpdir(), "x-"));
			roots.push(root, externalRoot);
			const stateDir = join(root, ".secheur-agent");
			const sessionId = "socket-path-session";
			const externalService = new TestServerService();
			externalService.seed("unrelated-session");
			const externalSocket = sessionSocketPath(externalRoot, sessionId);
			const externalServer = createUnixServer(externalService, { path: externalSocket });
			servers.push(externalServer);
			await externalServer.start();

			const mountedService = new TestServerService();
			mountedService.seed(sessionId, "Mounted session", root);
			const mountedSocket = sessionSocketPath(stateDir, sessionId);
			const mountedServer = createUnixServer(mountedService, { path: mountedSocket });
			servers.push(mountedServer);
			await mountedServer.start();

			const externalOpen = vi.spyOn(externalService, "openSession");
			const mountedOpen = vi.spyOn(mountedService, "openSession");
			const now = Date.now();
			await writeSessionRegistrationAt(stateDir, {
				sessionId,
				role: "main",
				title: "Registered session",
				socketPath: externalSocket,
				pid: process.pid,
				cwd: root,
				createdAt: now,
				updatedAt: now,
				status: "idle",
			});

			const bridge = new SecHeurBridge({
				projectRoot: root,
				port: 0,
				schedulerBackend: false,
				managedSessions: true,
				worklist: false,
				competition: false,
			});
			bridges.push(bridge);
			await bridge.listen();
			const base = `http://127.0.0.1:${bridge.address.port}`;
			const response = await fetch(`${base}/session/${sessionId}`);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				sessionId,
				session: {
					id: sessionId,
					managed: true,
					title: "Registered session",
				},
			});
			expect(externalOpen).toHaveBeenCalledWith(sessionId);
			expect(mountedOpen).toHaveBeenCalledWith(sessionId);
		},
	);
});
