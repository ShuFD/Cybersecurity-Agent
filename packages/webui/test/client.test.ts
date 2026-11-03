import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeClient, type EventSourceLike, type WebSocketLike } from "../src/bridge/client.ts";
import type { BridgeEvent } from "../src/types.ts";

describe("PLAN selection", () => {
	it("sends the selected engine with new sessions and surfaces save errors", async () => {
		const calls: Array<{ path: string; body: unknown }> = [];
		const client = new BridgeClient({
			baseUrl: "http://bridge",
			fetch: async (input, init) => {
				const path = String(input);
				const body = init?.body ? JSON.parse(String(init.body)) : null;
				calls.push({ path, body });
				if (body?.engine === "invalid")
					return new Response(JSON.stringify({ error: "invalid PLAN engine" }), { status: 400 });
				return new Response(
					JSON.stringify(
						path.endsWith("/session/new")
							? { sessionId: "new", session: { id: "new", status: "idle", planningEngine: body.planningEngine } }
							: {
									engine: body?.engine ?? "hypothesis",
									engines: ["progressive", "cairn", "hypothesis", "artex"],
									newSessionsOnly: true,
								},
					),
					{ status: 200 },
				);
			},
		});
		await expect(client.getPlanningOptions()).resolves.toMatchObject({ engine: "hypothesis" });
		await client.setPlanningEngine("cairn");
		await client.createSession(undefined, "cairn");
		expect(calls.at(-1)).toEqual({
			path: "http://bridge/session/new",
			body: { planningEngine: "cairn", executionMode: "plan_multi" },
		});
		await expect(client.setPlanningEngine("invalid" as "cairn")).rejects.toThrow("invalid PLAN engine");
		await client.setPlanningEngine("artex");
		await client.createSession(undefined, "artex");
		expect(calls.at(-1)?.body).toEqual({ planningEngine: "artex", executionMode: "plan_multi" });
		await client.getExplorationNode("session/one", "artex-node/one");
		expect(calls.at(-1)?.path).toBe("http://bridge/session/session%2Fone/planning/graph?node=artex-node%2Fone");
	});
});

class FakeEventSource implements EventSourceLike {
	readonly url: string;
	readyState = 0;
	onopen: ((event: Event) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent<string>) => void) | null = null;
	private readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();

	constructor(url: string) {
		this.url = url;
	}

	addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
		const listeners = this.listeners.get(type) ?? new Set<(event: MessageEvent<string>) => void>();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	open(): void {
		this.readyState = 1;
		this.onopen?.({} as Event);
	}

	emit(value: unknown, eventId = "", type = "bridge"): void {
		const event = { data: JSON.stringify(value), lastEventId: eventId } as MessageEvent<string>;
		if (type === "message") this.onmessage?.(event);
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}

	fail(): void {
		this.readyState = 2;
		this.onerror?.({} as Event);
	}

	close(): void {
		this.readyState = 2;
	}
}

class FakeWebSocket implements WebSocketLike {
	readonly url: string;
	readyState = 0;
	onopen: ((event: Event) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent<string>) => void) | null = null;

	constructor(url: string) {
		this.url = url;
	}

	send(_data: string): void {}

	open(): void {
		this.readyState = 1;
		this.onopen?.({} as Event);
	}

	close(): void {
		this.readyState = 3;
	}
}

afterEach(() => {
	vi.useRealTimers();
});

describe("BridgeClient", () => {
	it("coalesces session events while retaining the latest state", async () => {
		vi.useFakeTimers();
		const sources: FakeEventSource[] = [];
		const client = new BridgeClient({
			baseUrl: "http://bridge",
			eventSourceFactory: (url) => {
				const source = new FakeEventSource(url);
				sources.push(source);
				return source;
			},
		});
		const events: BridgeEvent[] = [];
		client.subscribe((event) => events.push(event));
		client.connect();
		sources[0].open();
		sources[0].emit({ type: "session-state", sessionId: "solver-1", state: "running", seq: 1, event: "start" }, "1");
		sources[0].emit({ type: "session-state", sessionId: "solver-1", state: "idle", seq: 2, event: "done" }, "2");
		sources[0].emit({ type: "session-state", sessionId: "solver-2", state: "running", seq: 1, event: "start" }, "3");

		await vi.advanceTimersByTimeAsync(49);
		expect(events).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);

		const sessionEvents = events.filter(
			(event): event is Extract<BridgeEvent, { type: "session-state" }> => event.type === "session-state",
		);
		expect(sessionEvents).toHaveLength(2);
		expect(sessionEvents.find((event) => event.sessionId === "solver-1")).toMatchObject({
			state: "idle",
			seq: 2,
		});
		client.disconnect();
	});

	it("reconnects with the last event id and requests a store snapshot resync", async () => {
		vi.useFakeTimers();
		const sources: FakeEventSource[] = [];
		const states: string[] = [];
		const events: BridgeEvent[] = [];
		const client = new BridgeClient({
			baseUrl: "http://bridge",
			reconnectMinMs: 100,
			reconnectMaxMs: 100,
			webSocketFactory: () => {
				throw new Error("WebSocket unavailable");
			},
			eventSourceFactory: (url) => {
				const source = new FakeEventSource(url);
				sources.push(source);
				return source;
			},
		});
		client.onConnection((state) => states.push(state));
		client.subscribe((event) => events.push(event));
		client.connect();
		sources[0].open();
		sources[0].emit({ type: "bridge-ready", sequence: 7 }, "7");
		sources[0].fail();
		expect(client.state).toBe("reconnecting");

		await vi.advanceTimersByTimeAsync(100);
		expect(sources).toHaveLength(2);
		expect(sources[1].url).toBe("http://bridge/events?since=7");
		sources[1].open();
		await vi.advanceTimersByTimeAsync(50);

		expect(events).toContainEqual({ type: "resync-required", reason: "event channel reconnected" });
		expect(states).toContain("reconnecting");
		expect(states.at(-1)).toBe("connected");
		client.disconnect();
	});

	it("falls back to WebSocket when SSE construction fails", () => {
		const sockets: FakeWebSocket[] = [];
		const client = new BridgeClient({
			baseUrl: "https://bridge/",
			eventSourceFactory: () => {
				throw new Error("SSE unavailable");
			},
			webSocketFactory: (url) => {
				const socket = new FakeWebSocket(url);
				sockets.push(socket);
				return socket;
			},
		});
		client.connect();
		expect(sockets).toHaveLength(1);
		expect(sockets[0].url).toBe("wss://bridge/ws");
		sockets[0].open();
		expect(client.state).toBe("connected");
		client.disconnect();
	});

	it("falls back to WebSocket when an SSE channel reports an error", () => {
		const sources: FakeEventSource[] = [];
		const sockets: FakeWebSocket[] = [];
		const client = new BridgeClient({
			baseUrl: "http://bridge",
			eventSourceFactory: (url) => {
				const source = new FakeEventSource(url);
				sources.push(source);
				return source;
			},
			webSocketFactory: (url) => {
				const socket = new FakeWebSocket(url);
				sockets.push(socket);
				return socket;
			},
		});
		client.connect();
		sources[0].fail();
		expect(sockets).toHaveLength(1);
		expect(sockets[0].url).toBe("ws://bridge/ws");
		sockets[0].open();
		expect(client.state).toBe("connected");
		client.disconnect();
	});

	it("normalizes session snapshots and encodes session paths", async () => {
		const requests: string[] = [];
		const fetcher: typeof fetch = async (input) => {
			requests.push(String(input));
			return new Response(
				JSON.stringify({
					session: { id: "a/b", title: "Fixture", status: "idle" },
					messages: [
						{ id: 1, role: "user", content: "hello" },
						{ id: 0, role: "assistant", content: "ignored" },
					],
					partial: { id: 2, role: "assistant", content: "streaming" },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};
		const client = new BridgeClient({ baseUrl: "http://bridge/", fetch: fetcher });
		const result = await client.getSession("a/b");
		expect(requests[0]).toBe("http://bridge/session/a%2Fb");
		expect(result.session.id).toBe("a/b");
		expect(result.messages).toHaveLength(1);
		expect(result.partial?.content).toBe("streaming");
	});

	it("normalizes legacy numeric model profiles for the browser client", async () => {
		const fetcher: typeof fetch = async () =>
			new Response(
				JSON.stringify({
					profiles: [
						{ id: 3, llmNo: 3, provider: "fixture", model: "m3", name: "Fixture M3", active: true },
						{ id: "fallback-id", provider: "fixture", name: "Fallback" },
					],
				}),
				{ status: 200 },
			);
		const client = new BridgeClient({ baseUrl: "http://bridge", fetch: fetcher });
		await expect(client.listModels()).resolves.toEqual([
			expect.objectContaining({ provider: "fixture", id: "m3", llmNo: 3, selected: true }),
			expect.objectContaining({ provider: "fixture", id: "fallback-id", selected: false }),
		]);
	});

	it("loads runtime logs with thinking and stable fallback tool call ids", async () => {
		const requests: string[] = [];
		const fetcher: typeof fetch = async (input) => {
			requests.push(String(input));
			return new Response(
				JSON.stringify({
					session: { id: "trace/session", title: "Trace", status: "running" },
					messages: [
						{
							id: 7,
							role: "assistant",
							content: "answer",
							thinking: "reasoning",
							thinkingRedacted: true,
							toolCalls: [{ name: "shell", arguments: { command: "pwd" } }],
						},
					],
					partial: null,
					events: [
						{
							id: 4,
							event: "message_end",
							timestamp: 1_700_000_000,
							thinkingText: "reasoning",
							thinkingRedacted: true,
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};
		const client = new BridgeClient({ baseUrl: "http://bridge", fetch: fetcher });
		const result = await client.getRuntimeLog("trace/session");

		expect(requests).toEqual(["http://bridge/session/trace%2Fsession/runtime/log"]);
		expect(result.messages[0]).toMatchObject({
			thinking: "reasoning",
			thinkingRedacted: true,
			toolCalls: [{ id: "message-7-0", name: "shell", argsText: '{"command":"pwd"}' }],
		});
		expect(result.events[0]).toMatchObject({
			event: "message_end",
			thinkingText: "reasoning",
			thinkingRedacted: true,
		});
	});

	it("encodes runtime log cursors while preserving the no-options URL", async () => {
		const requests: string[] = [];
		const fetcher: typeof fetch = async (input) => {
			requests.push(String(input));
			return new Response(
				JSON.stringify({
					session: { id: "trace", title: "Trace", status: "idle" },
					messages: [],
					partial: null,
					events: [],
					incremental: true,
					resetRequired: false,
					logEpoch: "epoch-1",
					messageCursor: 8,
					eventCursor: 12,
					eventStartId: 1,
				}),
				{ status: 200 },
			);
		};
		const client = new BridgeClient({ baseUrl: "http://bridge", fetch: fetcher });
		const result = await client.getRuntimeLog("trace", {
			afterEventId: 10,
			afterMessageId: 7,
			logEpoch: "epoch 1",
			includeMessages: false,
		});
		expect(requests[0]).toBe(
			"http://bridge/session/trace/runtime/log?afterEventId=10&afterMessageId=7&logEpoch=epoch+1&includeMessages=false",
		);
		expect(result).toMatchObject({
			incremental: true,
			resetRequired: false,
			logEpoch: "epoch-1",
			messageCursor: 8,
			eventCursor: 12,
			eventStartId: 1,
		});
	});
});
