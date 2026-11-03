import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptOptions } from "../src/bridge/client.ts";
import { type BridgeClientLike, SessionStore } from "../src/store/session-store.ts";
import type {
	BridgeEvent,
	BridgeMessage,
	ConnectionState,
	PermissionRequest,
	SessionStatus,
	SessionSummary,
	WorklistSnapshot,
} from "../src/types.ts";

function session(id: string, role: SessionSummary["role"], updatedAt: number): SessionSummary {
	return {
		id,
		title: id,
		cwd: "/workspace",
		createdAt: updatedAt - 10,
		updatedAt,
		status: "idle",
		role,
		managed: role === "solver",
		taskId: role === "solver" ? id : null,
		category: role === "solver" ? "pwn" : null,
		msgSeq: 0,
		permissionMode: "default",
		persistent: false,
		closed: false,
		lastError: "",
		turnCount: 0,
		watchdogPhase: null,
	};
}

function message(id: number, role: string, content: string, extra: Record<string, unknown> = {}): BridgeMessage {
	return { id, role, content, ts: id, ...extra };
}

class FakeClient implements BridgeClientLike {
	state: ConnectionState = "offline";
	readonly events = new Set<(event: BridgeEvent) => void>();
	readonly connections = new Set<(state: ConnectionState) => void>();
	readonly getMessages = vi.fn(
		async (
			sessionId: string,
			after = 0,
		): Promise<{
			status: SessionStatus;
			messages: BridgeMessage[];
			partial: BridgeMessage | null;
			msgSeq: number;
			updatedAt: number;
			lastError: string;
		}> => ({
			status: "idle",
			messages: after === 0 ? [message(1, "user", `initial ${sessionId}`)] : [],
			partial: null,
			msgSeq: after === 0 ? 1 : 0,
			updatedAt: 100,
			lastError: "",
		}),
	);
	readonly activate = vi.fn(async (_sessionId: string): Promise<void> => {});
	readonly prompt = vi.fn(async (_sessionId: string, _text: string, _options?: PromptOptions) => ({ accepted: true }));
	readonly steer = vi.fn(async (_sessionId: string, _text: string) => ({ accepted: true }));
	readonly followUp = vi.fn(async (_sessionId: string, _text: string) => ({ accepted: true }));
	readonly cancel = vi.fn(async (_sessionId: string, _reason?: string) => ({ accepted: true }));
	readonly abort = vi.fn(async (_sessionId: string, _reason?: string) => ({ accepted: true }));
	readonly setPermissionMode = vi.fn(async (_sessionId: string, _mode: string): Promise<void> => {});
	readonly resolvePermission = vi.fn(
		async (_sessionId: string, _request: PermissionRequest, _decision: string, _answer?: string): Promise<void> => {},
	);
	readonly setModel = vi.fn(async (_sessionId: string, _model: { provider: string; id: string }): Promise<void> => {});
	readonly getWorklist = vi.fn(async (): Promise<WorklistSnapshot | null> => null);
	readonly startWorklist = vi.fn(async (): Promise<WorklistSnapshot | null> => null);
	readonly stopWorklist = vi.fn(async (): Promise<WorklistSnapshot | null> => null);
	readonly syncWorklist = vi.fn(async (): Promise<WorklistSnapshot | null> => null);
	readonly guideWorklist = vi.fn(async (_itemId: string, _message: string): Promise<WorklistSnapshot | null> => null);
	readonly createSession = vi.fn(async (): Promise<{ sessionId: string; session: SessionSummary }> => {
		const created = session("new-session", "main", 200);
		return { sessionId: created.id, session: created };
	});
	readonly listSessions = vi.fn(async () => ({
		sessions: [
			session("main", "main", 100),
			...Array.from({ length: 10 }, (_, index) => session(`solver-${index}`, "solver", 90 - index)),
		],
		activeSessionId: "main",
	}));
	readonly resync = vi.fn(async () => ({
		status: { activeSessionId: "main", managedSessions: true },
		sessions: {
			sessions: [
				session("main", "main", 100),
				...Array.from({ length: 10 }, (_, index) => session(`solver-${index}`, "solver", 90 - index)),
			],
			activeSessionId: "main",
		},
		worklist: null,
	}));

	subscribe(listener: (event: BridgeEvent) => void): () => void {
		this.events.add(listener);
		return () => this.events.delete(listener);
	}

	onConnection(listener: (state: ConnectionState) => void): () => void {
		this.connections.add(listener);
		listener(this.state);
		return () => this.connections.delete(listener);
	}

	connect(): void {
		this.state = "connected";
		for (const listener of this.connections) listener(this.state);
	}

	disconnect(): void {
		this.state = "offline";
		for (const listener of this.connections) listener(this.state);
	}

	emit(event: BridgeEvent): void {
		for (const listener of this.events) listener(event);
	}
}

afterEach(() => {
	vi.useRealTimers();
});

describe("SessionStore", () => {
	it("loads only the active transcript while keeping solver summaries", async () => {
		const client = new FakeClient();
		const store = new SessionStore();
		store.attach(client);
		await store.bootstrap();

		expect(client.getMessages).toHaveBeenCalledTimes(1);
		expect(client.getMessages).toHaveBeenCalledWith("main", 0, 200);
		expect(store.getSnapshot().messagesBySessionId.has("main")).toBe(true);
		expect(store.getSnapshot().messagesBySessionId.has("solver-0")).toBe(false);
		expect(store.getSnapshot().sessionsById.size).toBe(11);

		client.emit({ type: "session-state", sessionId: "solver-0", state: "running", seq: 4, updatedAt: 300 });
		expect(store.getSnapshot().sessionsById.get("solver-0")?.status).toBe("running");
		expect(client.getMessages).toHaveBeenCalledTimes(1);
		store.detach();
	});

	it("does not clear a pending permission from an older session event", async () => {
		const client = new FakeClient();
		const store = new SessionStore();
		store.attach(client);
		await store.bootstrap();

		client.emit({
			type: "session-state",
			sessionId: "main",
			state: "running",
			event: "permission",
			updatedAt: 500,
			permissionRequests: [
				{
					requestId: "permission-1",
					toolName: "bash",
					message: "确认执行危险命令",
					args: { command: "rm -rf output" },
					status: "pending",
					createdAt: 500,
					choices: [],
				},
			],
		});
		expect(store.getSnapshot().permissions.has("main:permission-1")).toBe(true);

		client.emit({
			type: "session-state",
			sessionId: "main",
			state: "running",
			event: "remote-snapshot",
			updatedAt: 400,
			permissionRequests: [],
		});
		expect(store.getSnapshot().permissions.has("main:permission-1")).toBe(true);
		store.detach();
	});

	it("ignores a bootstrap response after the client is replaced", async () => {
		const staleClient = new FakeClient();
		let releaseResync: ((value: Awaited<ReturnType<FakeClient["resync"]>>) => void) | undefined;
		const pendingResync = new Promise<Awaited<ReturnType<FakeClient["resync"]>>>((resolve) => {
			releaseResync = resolve;
		});
		staleClient.resync.mockReturnValueOnce(pendingResync);

		const store = new SessionStore();
		store.attach(staleClient);
		const bootstrap = store.bootstrap();
		const freshClient = new FakeClient();
		store.attach(freshClient);

		releaseResync?.({
			status: { activeSessionId: "stale-session", managedSessions: true },
			sessions: { sessions: [session("stale-session", "main", 900)], activeSessionId: "stale-session" },
			worklist: null,
		});
		await bootstrap;

		expect(store.getSnapshot().sessionsById.has("stale-session")).toBe(false);
		store.detach();
	});

	it("ignores a session summary response after the client is replaced", async () => {
		const staleClient = new FakeClient();
		const store = new SessionStore();
		store.attach(staleClient);
		await store.bootstrap();

		let releaseSummaries: ((value: Awaited<ReturnType<FakeClient["listSessions"]>>) => void) | undefined;
		const pendingSummaries = new Promise<Awaited<ReturnType<FakeClient["listSessions"]>>>((resolve) => {
			releaseSummaries = resolve;
		});
		staleClient.listSessions.mockReturnValueOnce(pendingSummaries);
		const refresh = store.refreshSessionSummaries(true);
		const freshClient = new FakeClient();
		store.attach(freshClient);

		releaseSummaries?.({
			sessions: [session("stale-summary", "solver", 901)],
			activeSessionId: "stale-summary",
		});
		await refresh;

		expect(store.getSnapshot().sessionsById.has("stale-summary")).toBe(false);
		expect(store.getSnapshot().sessionsById.has("main")).toBe(true);
		store.detach();
	});

	it("keeps metadata monotonic without moving rows for background events", async () => {
		const client = new FakeClient();
		const store = new SessionStore();
		store.attach(client);
		await store.bootstrap();

		const stableOrder = [...store.getSnapshot().sessionOrder];
		client.emit({
			type: "session-state",
			sessionId: "solver-0",
			state: "running",
			seq: 4,
			event: "remote-progress",
			updatedAt: 300,
		});
		expect(store.getSnapshot().sessionOrder).toEqual(stableOrder);

		client.emit({ type: "session-state", sessionId: "solver-0", state: "idle", seq: 3, updatedAt: 200 });
		expect(store.getSnapshot().sessionOrder).toEqual(stableOrder);
		expect(store.getSnapshot().sessionsById.get("solver-0")?.updatedAt).toBe(300);
		expect(store.getSnapshot().sessionsById.get("solver-0")?.status).toBe("running");
		store.detach();
	});

	it("keeps the session order stable for background activity", async () => {
		const client = new FakeClient();
		const store = new SessionStore();
		store.attach(client);
		await store.bootstrap();

		const stableOrder = [...store.getSnapshot().sessionOrder];
		client.emit({ type: "session-state", sessionId: "solver-1", state: "running", event: "running", updatedAt: 300 });
		expect(store.getSnapshot().sessionOrder).toEqual(stableOrder);
		client.emit({
			type: "session-state",
			sessionId: "solver-1",
			state: "running",
			event: "remote-progress",
			updatedAt: 301,
		});
		expect(store.getSnapshot().sessionOrder).toEqual(stableOrder);
		client.emit({
			type: "session-state",
			sessionId: "solver-1",
			state: "idle",
			event: "completed",
			updatedAt: 400,
		});
		expect(store.getSnapshot().sessionOrder).toEqual(stableOrder);
		client.emit({ type: "session-state", sessionId: "main", state: "idle", event: "idle", updatedAt: 400 });
		expect(store.getSnapshot().sessionOrder).toEqual(stableOrder);
		client.listSessions.mockResolvedValueOnce({
			sessions: [
				session("solver-1", "solver", 900),
				session("main", "main", 100),
				session("solver-0", "solver", 90),
				...Array.from({ length: 8 }, (_, index) => session(`solver-${index + 2}`, "solver", 80 - index)),
			],
			activeSessionId: "main",
		});
		await store.refreshSessionSummaries(true);
		expect(store.getSnapshot().sessionOrder).toEqual(stableOrder);
		store.detach();
	});

	it("keeps two conversations fixed during alternating tool events and summary refreshes", async () => {
		const client = new FakeClient();
		client.resync.mockResolvedValueOnce({
			status: { activeSessionId: "first", managedSessions: true },
			sessions: {
				sessions: [session("first", "main", 200), session("second", "main", 100)],
				activeSessionId: "first",
			},
			worklist: null,
		});
		const store = new SessionStore();
		store.attach(client);
		await store.bootstrap();
		const stableOrder = store.getSnapshot().sessionOrder;
		expect(stableOrder).toEqual(["first", "second"]);

		for (let index = 0; index < 12; index += 1) {
			const sessionId = index % 2 === 0 ? "second" : "first";
			const otherId = sessionId === "first" ? "second" : "first";
			const updatedAt = 300 + index;
			client.emit({
				type: "session-state",
				sessionId,
				state: "running",
				event: ["tool_execution_start", "tool_execution_update", "tool_execution_end"][index % 3],
				updatedAt,
			});
			expect(store.getSnapshot().sessionOrder).toBe(stableOrder);
			client.listSessions.mockResolvedValueOnce({
				sessions: [session(sessionId, "main", updatedAt), session(otherId, "main", updatedAt - 1)],
				activeSessionId: sessionId,
			});
			await store.refreshSessionSummaries();
			expect(store.getSnapshot().sessionOrder).toBe(stableOrder);
			expect(store.getSnapshot().activeSessionId).toBe("first");
			expect(store.getSnapshot().sessionsById.get(sessionId)?.updatedAt).toBe(updatedAt);
		}
		store.detach();
	});

	it("keeps existing rows fixed during repeated restore events and reconnects", async () => {
		const client = new FakeClient();
		const store = new SessionStore();
		store.attach(client);
		await store.bootstrap();
		const stableOrder = store.getSnapshot().sessionOrder;

		for (const sessionId of ["solver-0", "solver-1", "solver-0"]) {
			client.emit({ type: "session-state", sessionId, state: "idle", event: "restored", updatedAt: 500 });
			expect(store.getSnapshot().sessionOrder).toBe(stableOrder);
		}
		client.listSessions.mockResolvedValueOnce({
			sessions: [...store.getSnapshot().sessionsById.values()].reverse(),
			activeSessionId: "solver-1",
		});
		client.emit({ type: "resync-required" });
		await store.refreshSessionSummaries(true);
		expect(store.getSnapshot().sessionOrder).toBe(stableOrder);
		expect(store.getSnapshot().activeSessionId).toBe("main");

		client.emit({
			type: "session-state",
			sessionId: "newly-restored",
			state: "idle",
			event: "restored",
			updatedAt: 1,
		});
		expect(store.getSnapshot().sessionOrder).toEqual(["newly-restored", ...stableOrder]);
		client.emit({ type: "session-state", sessionId: "solver-1", state: "idle", event: "restored", updatedAt: 600 });
		expect(store.getSnapshot().sessionOrder).toEqual(["newly-restored", ...stableOrder]);
		store.detach();
	});

	it("keeps existing rows fixed when bootstrap repeats with newer snapshots", async () => {
		const client = new FakeClient();
		const store = new SessionStore();
		store.attach(client);
		await store.bootstrap();
		const stableOrder = [...store.getSnapshot().sessionOrder];
		client.resync.mockResolvedValueOnce({
			status: { activeSessionId: "main", managedSessions: true },
			sessions: {
				sessions: [...store.getSnapshot().sessionsById.values()].reverse().map((item, index) => ({
					...item,
					updatedAt: 500 - index,
				})),
				activeSessionId: "main",
			},
			worklist: null,
		});
		await store.bootstrap();
		expect(store.getSnapshot().sessionOrder).toEqual(stableOrder);
		store.detach();
	});

	it("puts a newly created session first without changing order when it is viewed", async () => {
		const client = new FakeClient();
		client.createSession.mockResolvedValueOnce({
			sessionId: "new-session",
			session: session("new-session", "main", 1),
		});
		const store = new SessionStore();
		store.attach(client);
		await store.bootstrap();

		await store.createSession("cairn");
		expect(client.createSession).toHaveBeenCalledWith(undefined, "cairn");
		expect(store.getSnapshot().sessionOrder[0]).toBe("new-session");
		client.getMessages.mockImplementationOnce(async () => ({
			status: "idle",
			messages: [message(1, "user", "newer snapshot discovered while viewing")],
			partial: null,
			msgSeq: 1,
			updatedAt: 500,
			lastError: "",
		}));
		await store.openSession("main");
		expect(store.getSnapshot().sessionOrder[0]).toBe("new-session");
		store.detach();
	});

	it("keeps a conversation in place when the user sends a new message", async () => {
		const client = new FakeClient();
		const store = new SessionStore();
		store.attach(client);
		await store.bootstrap();
		const stableOrder = store.getSnapshot().sessionOrder;

		await store.openSession("solver-0");
		await store.sendPrompt("inspect the challenge");
		expect(client.prompt).toHaveBeenCalledWith("solver-0", "inspect the challenge", {});
		expect(store.getSnapshot().sessionOrder).toBe(stableOrder);
		store.detach();
	});

	it("does not promote a session when sending fails", async () => {
		const client = new FakeClient();
		client.prompt.mockRejectedValueOnce(new Error("send failed"));
		const store = new SessionStore();
		store.attach(client);
		await store.bootstrap();
		const stableOrder = [...store.getSnapshot().sessionOrder];

		await store.openSession("solver-0");
		await store.sendPrompt("inspect the challenge");

		expect(store.getSnapshot().sessionOrder).toEqual(stableOrder);
		store.detach();
	});

	it("keeps the latest session selection when activation responses arrive out of order", async () => {
		const client = new FakeClient();
		const store = new SessionStore();
		store.attach(client);
		await store.bootstrap();

		let resolveFirst: (() => void) | undefined;
		let resolveSecond: (() => void) | undefined;
		const firstActivation = new Promise<void>((resolve) => {
			resolveFirst = resolve;
		});
		const secondActivation = new Promise<void>((resolve) => {
			resolveSecond = resolve;
		});
		client.activate.mockImplementation((sessionId: string) =>
			sessionId === "solver-0" ? firstActivation : secondActivation,
		);

		const firstSelection = store.openSession("solver-0");
		const secondSelection = store.openSession("solver-1");
		resolveSecond?.();
		await secondSelection;
		// The second click wins even though the first activation is still pending.
		expect(store.getSnapshot().activeSessionId).toBe("solver-1");

		resolveFirst?.();
		await firstSelection;
		expect(store.getSnapshot().activeSessionId).toBe("solver-1");
		store.detach();
	});

	it("merges fifteen new solver summaries once and keeps progress events from reordering them", async () => {
		const client = new FakeClient();
		const store = new SessionStore();
		store.attach(client);
		await store.bootstrap();
		client.listSessions.mockResolvedValueOnce({
			sessions: [
				...Array.from({ length: 15 }, (_, index) => {
					const solverNumber = 15 - index;
					return session(`new-solver-${solverNumber}`, "solver", 200 + solverNumber);
				}),
				session("main", "main", 100),
			],
			activeSessionId: "main",
		});
		let notifications = 0;
		const unsubscribe = store.subscribe(() => {
			notifications += 1;
		});

		await store.refreshSessionSummaries();
		const stableOrder = [...store.getSnapshot().sessionOrder];
		expect(notifications).toBe(1);
		expect(store.getSnapshot().sessionsById.size).toBe(16);
		expect(stableOrder.slice(0, 3)).toEqual(["new-solver-15", "new-solver-14", "new-solver-13"]);
		expect(client.getMessages).toHaveBeenCalledTimes(1);

		for (let index = 1; index <= 15; index += 1) {
			client.emit({
				type: "session-state",
				sessionId: `new-solver-${index}`,
				state: "running",
				seq: index,
				event: "remote-progress",
				updatedAt: 1_000 + index,
			});
		}
		expect(store.getSnapshot().sessionOrder).toEqual(stableOrder);
		expect(client.getMessages).toHaveBeenCalledTimes(1);
		unsubscribe();
		store.detach();
	});

	it("merges incremental messages and partial streaming output for the active session", async () => {
		vi.useFakeTimers();
		const client = new FakeClient();
		const store = new SessionStore();
		store.attach(client);
		await store.bootstrap();
		client.getMessages.mockImplementationOnce(async () => ({
			status: "running",
			messages: [message(2, "assistant", "completed")],
			partial: message(3, "assistant", "streaming", { partial: true }),
			msgSeq: 3,
			updatedAt: 400,
			lastError: "",
		}));

		client.emit({ type: "session-state", sessionId: "main", state: "running", seq: 3, updatedAt: 400 });
		await vi.advanceTimersByTimeAsync(60);
		await Promise.resolve();

		expect(client.getMessages).toHaveBeenCalledWith("main", 0, 200);
		expect(store.getMessagesSnapshot("main").map((item) => item.id)).toEqual([1, 2]);
		expect(store.getPartialSnapshot("main")?.content).toBe("streaming");
		expect(store.getSnapshot().operationsBySessionId.get("main")?.status).toBe("running");
		store.detach();
	});

	it("refreshes a same-id streaming record when the sequence does not advance", async () => {
		vi.useFakeTimers();
		const client = new FakeClient();
		const store = new SessionStore();
		store.attach(client);
		await store.bootstrap();
		client.getMessages.mockImplementationOnce(async () => ({
			status: "idle",
			messages: [message(1, "user", "initial replacement")],
			partial: null,
			msgSeq: 1,
			updatedAt: 200,
			lastError: "",
		}));

		client.emit({ type: "session-state", sessionId: "main", state: "idle", seq: 1, event: "message_end" });
		await vi.advanceTimersByTimeAsync(60);
		await Promise.resolve();

		expect(client.getMessages).toHaveBeenLastCalledWith("main", 0, 200);
		expect(store.getMessagesSnapshot("main")[0]?.content).toBe("initial replacement");
		store.detach();
	});

	it("keeps a trailing refresh when a newer event arrives during an in-flight request", async () => {
		const client = new FakeClient();
		const store = new SessionStore();
		store.attach(client);
		await store.bootstrap();
		client.getMessages.mockReset();
		let releaseFirst: ((value: Awaited<ReturnType<FakeClient["getMessages"]>>) => void) | undefined;
		const first = new Promise<Awaited<ReturnType<FakeClient["getMessages"]>>>((resolve) => {
			releaseFirst = resolve;
		});
		client.getMessages
			.mockImplementationOnce(async () => first)
			.mockImplementationOnce(async () => ({
				status: "idle",
				messages: [message(1, "user", "final")],
				partial: null,
				msgSeq: 1,
				updatedAt: 500,
				lastError: "",
			}));

		const inFlight = store.refreshMessages("main");
		const trailing = store.refreshMessages("main");
		expect(client.getMessages).toHaveBeenCalledTimes(1);
		releaseFirst?.({
			status: "running",
			messages: [message(1, "user", "stale")],
			partial: null,
			msgSeq: 1,
			updatedAt: 400,
			lastError: "",
		});
		await inFlight;
		await trailing;
		await Promise.resolve();
		expect(client.getMessages).toHaveBeenCalledTimes(2);
		expect(store.getMessagesSnapshot("main")[0]?.content).toBe("final");
		store.detach();
	});
});
