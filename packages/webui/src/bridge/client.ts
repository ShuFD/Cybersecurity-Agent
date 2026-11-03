import type {
	BridgeEvent,
	BridgeMessage,
	MessagesPage,
	ModelProfile,
	PermissionRequest,
	RuntimeLogPayload,
	SessionStateEvent,
	SessionSummary,
	SessionsPayload,
	StatusPayload,
	WorklistSnapshot,
} from "../types.ts";
import {
	asNumber,
	asString,
	isRecord,
	normalizeMessage,
	normalizeRuntimeTraceEvent,
	normalizeSession,
	normalizeWorklist,
} from "../types.ts";

export interface PromptOptions {
	modelIndex?: number;
	webVerbsEnabled?: boolean;
	force?: boolean;
	images?: unknown[];
	fileAttachments?: unknown[];
}
export type PlanningEngine = "progressive" | "cairn" | "hypothesis" | "artex";
export interface PlanningOptions {
	engine: PlanningEngine;
	engines: PlanningEngine[];
	newSessionsOnly: boolean;
}
export interface ExplorationGraph {
	version: number;
	round: number;
	todo: string;
	foldedNodeCount: number;
	nodes: {
		id: string;
		kind: string;
		state: string;
		payload: string;
		owner?: string;
		evidenceRefs: string[];
		anchors: string[];
	}[];
	edges: { source: string; target: string; relation: string }[];
	assets: { id: string; type: string; label: string }[];
	assetEdges: { source: string; target: string; relation: string }[];
	digests: { id: string; memberIds: string[] }[];
}

export interface RuntimeLogOptions {
	afterEventId?: number;
	afterMessageId?: number;
	logEpoch?: string;
	includeMessages?: boolean;
}

export interface EventSourceLike {
	readonly readyState: number;
	onopen: ((event: Event) => void) | null;
	onerror: ((event: Event) => void) | null;
	onmessage: ((event: MessageEvent<string>) => void) | null;
	addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
	close(): void;
}

export interface WebSocketLike {
	readonly readyState: number;
	onopen: ((event: Event) => void) | null;
	onclose: ((event: CloseEvent) => void) | null;
	onerror: ((event: Event) => void) | null;
	onmessage: ((event: MessageEvent<string>) => void) | null;
	send(data: string): void;
	close(): void;
}

export interface BridgeClientOptions {
	baseUrl?: string;
	fetch?: typeof globalThis.fetch;
	eventSourceFactory?: (url: string) => EventSourceLike;
	webSocketFactory?: (url: string) => WebSocketLike;
	reconnectMinMs?: number;
	reconnectMaxMs?: number;
}

export type BridgeEventListener = (event: BridgeEvent) => void;
export type ConnectionListener = (state: "connecting" | "connected" | "reconnecting" | "offline") => void;

const MAX_PENDING_EVENTS = 256;
const EVENT_FLUSH_MS = 50;

function encodePath(value: string): string {
	return encodeURIComponent(value);
}

function normalizeCursor(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function parseEvent(value: unknown): BridgeEvent | null {
	if (!isRecord(value) || typeof value.type !== "string") return null;
	if (value.type === "session-state") {
		const sessionId = asString(value.sessionId).trim();
		if (!sessionId) return null;
		return {
			type: "session-state",
			eventId: typeof value.eventId === "number" ? value.eventId : undefined,
			sessionId,
			role: typeof value.role === "string" ? value.role : undefined,
			title: typeof value.title === "string" ? value.title : undefined,
			taskId: typeof value.taskId === "string" ? value.taskId : null,
			category: typeof value.category === "string" ? value.category : null,
			state: typeof value.state === "string" ? (value.state as SessionStateEvent["state"]) : undefined,
			event: typeof value.event === "string" ? value.event : undefined,
			seq: typeof value.seq === "number" ? value.seq : undefined,
			updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : undefined,
			permissionRequests: Array.isArray(value.permissionRequests)
				? value.permissionRequests.flatMap((item) => {
						if (!isRecord(item) || typeof item.requestId !== "string") return [];
						return [item as NonNullable<SessionStateEvent["permissionRequests"]>[number]];
					})
				: undefined,
		};
	}
	if (value.type === "worklist-state") {
		return { type: "worklist-state", ...value, eventId: asNumber(value.eventId, 0) || undefined };
	}
	if (value.type === "bridge-ready") {
		return {
			type: "bridge-ready",
			...value,
			eventId: asNumber(value.eventId, 0) || undefined,
			projectRoot: typeof value.projectRoot === "string" ? value.projectRoot : undefined,
			sequence: asNumber(value.sequence, 0) || undefined,
		};
	}
	if (value.type === "resync-required") {
		return {
			type: "resync-required",
			eventId: asNumber(value.eventId, 0) || undefined,
			reason: typeof value.reason === "string" ? value.reason : undefined,
		};
	}
	return null;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

export class BridgeHttpError extends Error {
	readonly status: number;
	readonly payload: unknown;

	constructor(status: number, message: string, payload: unknown) {
		super(message);
		this.name = "BridgeHttpError";
		this.status = status;
		this.payload = payload;
	}
}

export class BridgeClient {
	private readonly baseUrl: string;
	private readonly fetcher: typeof globalThis.fetch;
	private readonly eventSourceFactory?: (url: string) => EventSourceLike;
	private readonly webSocketFactory?: (url: string) => WebSocketLike;
	private readonly reconnectMinMs: number;
	private readonly reconnectMaxMs: number;
	private readonly eventListeners = new Set<BridgeEventListener>();
	private readonly connectionListeners = new Set<ConnectionListener>();
	private readonly pendingEvents = new Map<string, BridgeEvent>();
	private eventFlushTimer: ReturnType<typeof setTimeout> | undefined;
	private eventSource?: EventSourceLike;
	private socket?: WebSocketLike;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private reconnectAttempt = 0;
	private started = false;
	private lastEventId = 0;
	private connectionState: "connecting" | "connected" | "reconnecting" | "offline" = "offline";

	constructor(options: BridgeClientOptions = {}) {
		const origin = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:14168";
		this.baseUrl = (options.baseUrl ?? origin).replace(/\/$/u, "");
		this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
		this.eventSourceFactory =
			options.eventSourceFactory ?? (typeof EventSource !== "undefined" ? (url) => new EventSource(url) : undefined);
		this.webSocketFactory =
			options.webSocketFactory ?? (typeof WebSocket !== "undefined" ? (url) => new WebSocket(url) : undefined);
		this.reconnectMinMs = Math.max(100, options.reconnectMinMs ?? 500);
		this.reconnectMaxMs = Math.max(this.reconnectMinMs, options.reconnectMaxMs ?? 10_000);
	}

	get state(): "connecting" | "connected" | "reconnecting" | "offline" {
		return this.connectionState;
	}

	subscribe(listener: BridgeEventListener): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	onConnection(listener: ConnectionListener): () => void {
		this.connectionListeners.add(listener);
		listener(this.connectionState);
		return () => this.connectionListeners.delete(listener);
	}

	connect(): void {
		if (this.started) return;
		this.started = true;
		this.setConnectionState("connecting");
		this.openEventChannel();
	}

	disconnect(): void {
		this.started = false;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		this.eventSource?.close();
		this.socket?.close();
		this.eventSource = undefined;
		this.socket = undefined;
		this.pendingEvents.clear();
		if (this.eventFlushTimer) clearTimeout(this.eventFlushTimer);
		this.eventFlushTimer = undefined;
		this.setConnectionState("offline");
	}

	async getStatus(): Promise<StatusPayload> {
		return this.request<StatusPayload>("/status");
	}

	async listSessions(includeSolvers = true): Promise<SessionsPayload> {
		const query = includeSolvers ? "" : "?includeSolvers=false";
		const payload = await this.request<{ sessions?: unknown[]; activeSessionId?: unknown }>(`/sessions${query}`);
		const sessions = (payload.sessions ?? []).flatMap((value) => {
			const session = normalizeSession(value);
			return session ? [session] : [];
		});
		return {
			sessions,
			activeSessionId: typeof payload.activeSessionId === "string" ? payload.activeSessionId : null,
		};
	}

	async getSession(sessionId: string): Promise<{
		session: SessionSummary;
		messages: BridgeMessage[];
		partial: BridgeMessage | null;
	}> {
		const payload = await this.request<{ session?: unknown; messages?: unknown[]; partial?: unknown }>(
			`/session/${encodePath(sessionId)}`,
		);
		const session = normalizeSession(payload.session);
		if (!session) throw new Error("bridge returned an invalid session snapshot");
		return {
			session,
			messages: (payload.messages ?? []).flatMap((value) => {
				const message = normalizeMessage(value);
				return message ? [message] : [];
			}),
			partial: normalizeMessage(payload.partial),
		};
	}

	async getMessages(sessionId: string, after = 0, limit = 200): Promise<MessagesPage> {
		const normalizedAfter = Math.max(0, after);
		const normalizedLimit = Math.max(1, Math.min(limit, 500));
		// Incremental pages do not need the expensive blackboard graph.
		const query =
			`?after=${encodeURIComponent(String(normalizedAfter))}` +
			`&limit=${encodeURIComponent(String(normalizedLimit))}` +
			`&includeBlackboard=${normalizedAfter === 0 ? "true" : "false"}`;
		const payload = await this.request<Record<string, unknown>>(`/session/${encodePath(sessionId)}/messages${query}`);
		const messages = (Array.isArray(payload.messages) ? payload.messages : []).flatMap((value) => {
			const message = normalizeMessage(value);
			return message ? [message] : [];
		});
		return {
			...(payload as Omit<MessagesPage, "messages" | "partial">),
			sessionId,
			status: (typeof payload.status === "string" ? payload.status : "idle") as MessagesPage["status"],
			messages,
			partial: normalizeMessage(payload.partial),
			msgSeq: asNumber(payload.msgSeq),
			updatedAt: asNumber(payload.updatedAt, Date.now() / 1000),
			lastError: asString(payload.lastError),
			after: asNumber(payload.after, after),
			limit: asNumber(payload.limit, limit),
			nextAfter: asNumber(payload.nextAfter, after),
		};
	}

	async getRuntimeLog(sessionId: string, options?: RuntimeLogOptions): Promise<RuntimeLogPayload> {
		let path = `/session/${encodePath(sessionId)}/runtime/log`;
		if (options) {
			const query = new URLSearchParams();
			if (options.afterEventId !== undefined)
				query.set("afterEventId", String(normalizeCursor(options.afterEventId)));
			if (options.afterMessageId !== undefined)
				query.set("afterMessageId", String(normalizeCursor(options.afterMessageId)));
			if (options.logEpoch) query.set("logEpoch", options.logEpoch);
			if (options.includeMessages === false) query.set("includeMessages", "false");
			const encodedQuery = query.toString();
			if (encodedQuery) path += `?${encodedQuery}`;
		}
		const payload = await this.request<Record<string, unknown>>(path);
		const session = normalizeSession(payload.session);
		if (!session) throw new Error("bridge returned an invalid runtime log session");
		return {
			sessionId,
			session,
			messages: (Array.isArray(payload.messages) ? payload.messages : []).flatMap((value) => {
				const message = normalizeMessage(value);
				return message ? [message] : [];
			}),
			partial: normalizeMessage(payload.partial),
			events: (Array.isArray(payload.events) ? payload.events : []).flatMap((value) => {
				const event = normalizeRuntimeTraceEvent(value);
				return event ? [event] : [];
			}),
			...(typeof payload.incremental === "boolean" ? { incremental: payload.incremental } : {}),
			...(typeof payload.resetRequired === "boolean" ? { resetRequired: payload.resetRequired } : {}),
			...(typeof payload.logEpoch === "string" ? { logEpoch: payload.logEpoch } : {}),
			...(typeof payload.messageCursor === "number" ? { messageCursor: payload.messageCursor } : {}),
			...(typeof payload.eventCursor === "number" ? { eventCursor: payload.eventCursor } : {}),
			...(typeof payload.eventStartId === "number" ? { eventStartId: payload.eventStartId } : {}),
			...(typeof payload.messagesIncluded === "boolean" ? { messagesIncluded: payload.messagesIncluded } : {}),
		};
	}

	getPlanningOptions(): Promise<PlanningOptions> {
		return this.request("/planning/options");
	}
	setPlanningEngine(engine: PlanningEngine): Promise<PlanningOptions> {
		return this.request("/planning/options", { method: "POST", body: { engine } });
	}
	async getExplorationGraph(sessionId: string): Promise<{ graph: ExplorationGraph }> {
		return this.request(`/session/${encodePath(sessionId)}/planning/graph`);
	}

	async getExplorationNode(sessionId: string, nodeId: string): Promise<{ node: unknown }> {
		return this.request(`/session/${encodePath(sessionId)}/planning/graph?node=${encodeURIComponent(nodeId)}`);
	}

	async createSession(
		cwd?: string,
		planningEngine?: PlanningEngine,
	): Promise<{ sessionId: string; session: SessionSummary }> {
		const payload = await this.request<{ sessionId?: unknown; session?: unknown }>("/session/new", {
			method: "POST",
			body: { ...(cwd ? { cwd } : {}), ...(planningEngine ? { planningEngine, executionMode: "plan_multi" } : {}) },
		});
		const session = normalizeSession(payload.session);
		const sessionId = asString(payload.sessionId || session?.id).trim();
		if (!session || !sessionId) throw new Error("bridge returned an invalid new session");
		return { sessionId, session };
	}

	async activate(sessionId: string): Promise<void> {
		await this.request(`/session/${encodePath(sessionId)}/activate`, { method: "POST", body: {} });
	}

	async prompt(sessionId: string, text: string, options: PromptOptions = {}): Promise<Record<string, unknown>> {
		return this.request<Record<string, unknown>>(`/session/${encodePath(sessionId)}/prompt`, {
			method: "POST",
			body: { prompt: text, ...options },
		});
	}

	async steer(sessionId: string, text: string): Promise<Record<string, unknown>> {
		return this.prompt(sessionId, text, { force: false });
	}

	async followUp(sessionId: string, text: string): Promise<Record<string, unknown>> {
		return this.prompt(sessionId, text, { force: false });
	}

	async cancel(sessionId: string, reason = "operator"): Promise<Record<string, unknown>> {
		return this.request<Record<string, unknown>>(`/session/${encodePath(sessionId)}/cancel`, {
			method: "POST",
			body: { source: "webui", reason },
		});
	}

	async abort(sessionId: string, reason = "operator"): Promise<Record<string, unknown>> {
		return this.cancel(sessionId, reason);
	}

	async setPermissionMode(sessionId: string, mode: string): Promise<void> {
		await this.request(`/session/${encodePath(sessionId)}/permission-mode`, { method: "POST", body: { mode } });
	}

	async resolvePermission(
		sessionId: string,
		request: PermissionRequest,
		decision: string,
		answer?: string,
	): Promise<void> {
		await this.request(`/session/${encodePath(sessionId)}/permission/${encodePath(request.requestId)}`, {
			method: "POST",
			body: { decision, ...(answer ? { answer } : {}) },
		});
	}

	async setModel(sessionId: string, model: { provider: string; id: string }): Promise<void> {
		await this.request(`/session/${encodePath(sessionId)}/model`, {
			method: "POST",
			body: { provider: model.provider, model: model.id },
		});
	}

	async listModels(): Promise<ModelProfile[]> {
		const payload = await this.request<{ profiles?: unknown[] }>("/model-profiles");
		return (payload.profiles ?? []).flatMap((value) => {
			if (!isRecord(value) || typeof value.provider !== "string") return [];
			// The bridge keeps the legacy numeric `id`/`llmNo` for compatibility and
			// exposes the provider model id as `model`. Normalize both shapes here so
			// the browser never has to know which wire version it received.
			const modelId =
				typeof value.model === "string"
					? value.model
					: typeof value.modelId === "string"
						? value.modelId
						: typeof value.id === "string"
							? value.id
							: "";
			if (!modelId) return [];
			const legacyIndex =
				typeof value.llmNo === "number" ? value.llmNo : typeof value.id === "number" ? value.id : undefined;
			return [
				{
					...value,
					provider: value.provider,
					id: modelId,
					name: typeof value.name === "string" ? value.name : undefined,
					...(legacyIndex !== undefined ? { llmNo: legacyIndex } : {}),
					selected: value.selected === true || value.active === true,
				} as ModelProfile,
			];
		});
	}

	async getWorklist(): Promise<WorklistSnapshot | null> {
		return normalizeWorklist(await this.request<unknown>("/worklist"));
	}

	async startWorklist(): Promise<WorklistSnapshot | null> {
		return normalizeWorklist(await this.request<unknown>("/worklist/start", { method: "POST", body: {} }));
	}

	async stopWorklist(): Promise<WorklistSnapshot | null> {
		return normalizeWorklist(await this.request<unknown>("/worklist/stop", { method: "POST", body: {} }));
	}

	async syncWorklist(): Promise<WorklistSnapshot | null> {
		return normalizeWorklist(await this.request<unknown>("/worklist/sync", { method: "POST", body: {} }));
	}

	async guideWorklist(itemId: string, message: string): Promise<WorklistSnapshot | null> {
		return normalizeWorklist(
			await this.request<unknown>(`/worklist/${encodePath(itemId)}/guide`, { method: "POST", body: { message } }),
		);
	}

	async resync(): Promise<{ status: StatusPayload; sessions: SessionsPayload; worklist: WorklistSnapshot | null }> {
		const [status, sessions, worklist] = await Promise.all([
			this.getStatus(),
			this.listSessions(true),
			this.getWorklist().catch(() => null),
		]);
		return { status, sessions, worklist };
	}

	private async request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
		const headers = new Headers({ Accept: "application/json" });
		const init: RequestInit = { method: options.method ?? "GET", headers };
		if (options.body !== undefined) {
			headers.set("Content-Type", "application/json");
			init.body = JSON.stringify(options.body);
		}
		const response = await this.fetcher(`${this.baseUrl}${path}`, init);
		const text = await response.text();
		const payload = text ? parseJson(text) : {};
		if (!response.ok) {
			const message =
				isRecord(payload) && typeof payload.error === "string"
					? payload.error
					: `${response.status} ${response.statusText}`;
			throw new BridgeHttpError(response.status, message, payload);
		}
		return payload as T;
	}

	private openEventChannel(): void {
		if (this.eventSourceFactory) {
			const since = this.lastEventId > 0 ? `?since=${encodeURIComponent(String(this.lastEventId))}` : "";
			try {
				const source = this.eventSourceFactory(`${this.baseUrl}/events${since}`);
				this.eventSource = source;
				source.onopen = () => this.handleChannelOpen();
				source.onerror = () => this.handleEventSourceError(source);
				source.onmessage = (event) => this.handleRawEvent(event.data, event.lastEventId);
				source.addEventListener("bridge", (event) => this.handleRawEvent(event.data, event.lastEventId));
				return;
			} catch {
				this.eventSource = undefined;
			}
		}
		if (this.webSocketFactory) this.openWebSocket();
		else this.scheduleReconnect();
	}

	private handleEventSourceError(source: EventSourceLike): void {
		if (!this.started || this.eventSource !== source) return;
		if (!this.webSocketFactory) {
			this.handleChannelError();
			return;
		}
		// Older bridges expose only /ws. Close the failed EventSource before
		// switching so the browser does not keep a second reconnect loop alive.
		this.eventSource = undefined;
		source.close();
		this.setConnectionState("reconnecting");
		this.openWebSocket();
	}

	private openWebSocket(): void {
		try {
			const url = `${this.baseUrl.replace(/^http/iu, "ws")}/ws`;
			const socket = this.webSocketFactory?.(url);
			if (!socket) {
				this.scheduleReconnect();
				return;
			}
			this.socket = socket;
			socket.onopen = () => this.handleChannelOpen();
			socket.onerror = () => this.handleChannelError();
			socket.onclose = () => this.handleChannelError();
			socket.onmessage = (event) => this.handleRawEvent(event.data);
		} catch {
			this.scheduleReconnect();
		}
	}

	private handleChannelOpen(): void {
		const wasReconnecting = this.connectionState === "reconnecting";
		this.reconnectAttempt = 0;
		this.setConnectionState("connected");
		if (wasReconnecting) {
			this.enqueueEvent({ type: "resync-required", reason: "event channel reconnected" });
		}
	}

	private handleChannelError(): void {
		if (!this.started) return;
		this.setConnectionState("reconnecting");
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (!this.started || this.reconnectTimer) return;
		const delay = Math.min(this.reconnectMaxMs, this.reconnectMinMs * 2 ** this.reconnectAttempt);
		this.reconnectAttempt += 1;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.eventSource?.close();
			this.socket?.close();
			this.eventSource = undefined;
			this.socket = undefined;
			this.openEventChannel();
		}, delay);
	}

	private handleRawEvent(text: string, eventId?: string): void {
		const parsed = parseEvent(parseJson(text));
		if (!parsed) return;
		const numericEventId = Number(eventId ?? parsed.eventId ?? 0);
		if (Number.isFinite(numericEventId) && numericEventId > this.lastEventId) this.lastEventId = numericEventId;
		this.enqueueEvent(parsed);
	}

	private enqueueEvent(event: BridgeEvent): void {
		const key = event.type === "session-state" ? `${event.type}:${event.sessionId}` : event.type;
		this.pendingEvents.set(key, event);
		if (this.pendingEvents.size > MAX_PENDING_EVENTS) {
			const first = this.pendingEvents.keys().next().value;
			if (typeof first === "string") this.pendingEvents.delete(first);
			this.pendingEvents.set("resync-required", { type: "resync-required", reason: "event queue overflow" });
		}
		if (this.eventFlushTimer) return;
		this.eventFlushTimer = setTimeout(() => {
			this.eventFlushTimer = undefined;
			const events = [...this.pendingEvents.values()];
			this.pendingEvents.clear();
			for (const item of events) for (const listener of this.eventListeners) listener(item);
		}, EVENT_FLUSH_MS);
	}

	private setConnectionState(state: "connecting" | "connected" | "reconnecting" | "offline"): void {
		if (state === this.connectionState) return;
		this.connectionState = state;
		for (const listener of this.connectionListeners) listener(state);
	}
}
