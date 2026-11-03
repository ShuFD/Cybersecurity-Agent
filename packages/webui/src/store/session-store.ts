import { useCallback, useSyncExternalStore } from "react";
import { BridgeClient, type PlanningEngine, type PromptOptions } from "../bridge/client.ts";
import type {
	BridgeEvent,
	BridgeMessage,
	ConnectionState,
	PermissionRequest,
	SessionStatus,
	SessionSummary,
	WorklistSnapshot,
} from "../types.ts";
import { asNumber, asString, normalizeSession, normalizeWorklist } from "../types.ts";

export interface OperationState {
	status: "idle" | "running" | "queued" | "error" | "cancelled";
	label: string;
	startedAt: number | null;
	updatedAt: number;
}

export interface SessionStoreState {
	connection: ConnectionState;
	sessionsById: ReadonlyMap<string, SessionSummary>;
	sessionOrder: readonly string[];
	messagesBySessionId: ReadonlyMap<string, readonly BridgeMessage[]>;
	partialsBySessionId: ReadonlyMap<string, BridgeMessage | null>;
	activeSessionId: string | null;
	operationsBySessionId: ReadonlyMap<string, OperationState>;
	worklist: WorklistSnapshot | null;
	permissions: ReadonlyMap<string, PermissionRequest>;
	lastError: string | null;
	lastEventAt: number | null;
}

export interface BridgeClientLike {
	readonly state: ConnectionState;
	subscribe(listener: (event: BridgeEvent) => void): () => void;
	onConnection(listener: (state: ConnectionState) => void): () => void;
	connect(): void;
	disconnect(): void;
	resync(): Promise<{
		status: { activeSessionId: string | null; managedSessions?: boolean };
		sessions: { sessions: SessionSummary[]; activeSessionId: string | null };
		worklist: WorklistSnapshot | null;
	}>;
	listSessions(includeSolvers?: boolean): Promise<{ sessions: SessionSummary[]; activeSessionId: string | null }>;
	getMessages(
		sessionId: string,
		after?: number,
		limit?: number,
	): Promise<{
		status: SessionStatus;
		messages: BridgeMessage[];
		partial: BridgeMessage | null;
		msgSeq: number;
		updatedAt: number;
		lastError: string;
	}>;
	createSession(
		cwd?: string,
		planningEngine?: PlanningEngine,
	): Promise<{ sessionId: string; session: SessionSummary }>;
	activate(sessionId: string): Promise<void>;
	prompt(sessionId: string, text: string, options?: PromptOptions): Promise<Record<string, unknown>>;
	steer(sessionId: string, text: string): Promise<Record<string, unknown>>;
	followUp(sessionId: string, text: string): Promise<Record<string, unknown>>;
	cancel(sessionId: string, reason?: string): Promise<Record<string, unknown>>;
	abort(sessionId: string, reason?: string): Promise<Record<string, unknown>>;
	setPermissionMode(sessionId: string, mode: string): Promise<void>;
	resolvePermission(sessionId: string, request: PermissionRequest, decision: string, answer?: string): Promise<void>;
	setModel(sessionId: string, model: { provider: string; id: string }): Promise<void>;
	getWorklist(): Promise<WorklistSnapshot | null>;
	startWorklist(): Promise<WorklistSnapshot | null>;
	stopWorklist(): Promise<WorklistSnapshot | null>;
	syncWorklist(): Promise<WorklistSnapshot | null>;
	guideWorklist(itemId: string, message: string): Promise<WorklistSnapshot | null>;
}

const INITIAL_STATE: SessionStoreState = {
	connection: "offline",
	sessionsById: new Map(),
	sessionOrder: [],
	messagesBySessionId: new Map(),
	partialsBySessionId: new Map(),
	activeSessionId: null,
	operationsBySessionId: new Map(),
	worklist: null,
	permissions: new Map(),
	lastError: null,
	lastEventAt: null,
};

function permissionKey(sessionId: string, requestId: string): string {
	return `${sessionId}:${requestId}`;
}

function permissionMapFor(session: SessionSummary): PermissionRequest[] {
	return session.permissionRequests ?? [];
}

function operationFor(status: SessionStatus, event = ""): OperationState {
	const normalized: OperationState["status"] =
		status === "running" ? "running" : status === "cancelled" ? "cancelled" : status === "error" ? "error" : "idle";
	return {
		status: normalized,
		label:
			normalized === "running"
				? event === "permission"
					? "等待权限"
					: event === "tool_execution_start"
						? "执行工具"
						: "正在处理"
				: normalized === "cancelled"
					? "已停止"
					: normalized === "error"
						? "执行失败"
						: "空闲",
		startedAt: normalized === "running" ? Date.now() : null,
		updatedAt: Date.now(),
	};
}

const EMPTY_MESSAGES: readonly BridgeMessage[] = [];
const IDLE_OPERATION: OperationState = operationFor("idle");
const SESSION_SUMMARY_REFRESH_MS = 3_000;
const STREAM_EVENTS = new Set([
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"bash_execution_update",
	"remote-snapshot",
	"remote-progress",
	"remote-prompt",
	"remote-complete",
]);

export class SessionStore {
	private state: SessionStoreState = INITIAL_STATE;
	private readonly listeners = new Set<() => void>();
	private readonly positionBySessionId = new Map<string, number>();
	private nextSessionPosition = 0;
	private readonly messageRequests = new Map<string, Promise<void>>();
	private readonly pendingMessageRefreshes = new Set<string>();
	private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private sessionSummaryRequest?: Promise<void>;
	private sessionSummaryTimer?: ReturnType<typeof setInterval>;
	private managedBridge = false;
	// 请求完成后要确认仍属于同一次 client 生命周期，避免断开重连时旧响应污染新状态。
	private clientGeneration = 0;
	// 每次选择会话都递增。网络请求可能乱序返回，只允许最后一次选择更新当前会话。
	private sessionSelectionVersion = 0;
	private client?: BridgeClientLike;
	private unsubscribeEvents?: () => void;
	private unsubscribeConnection?: () => void;

	getSnapshot = (): SessionStoreState => this.state;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	get connection(): ConnectionState {
		return this.state.connection;
	}

	clearError(): void {
		if (this.state.lastError !== null) this.setState({ lastError: null });
	}

	getSessionsSnapshot = (): ReadonlyMap<string, SessionSummary> => this.state.sessionsById;
	getSessionOrderSnapshot = (): readonly string[] => this.state.sessionOrder;
	getMessagesSnapshot = (sessionId: string): readonly BridgeMessage[] =>
		this.state.messagesBySessionId.get(sessionId) ?? EMPTY_MESSAGES;
	getPartialSnapshot = (sessionId: string): BridgeMessage | null =>
		this.state.partialsBySessionId.get(sessionId) ?? null;
	getOperationSnapshot = (sessionId: string): OperationState =>
		this.state.operationsBySessionId.get(sessionId) ?? IDLE_OPERATION;
	getWorklistSnapshot = (): WorklistSnapshot | null => this.state.worklist;
	getPermissionsSnapshot = (): ReadonlyMap<string, PermissionRequest> => this.state.permissions;

	attach(client: BridgeClientLike): void {
		if (this.client === client) return;
		this.detach();
		this.client = client;
		this.unsubscribeEvents = client.subscribe((event) => this.handleEvent(event));
		this.unsubscribeConnection = client.onConnection((connection) => this.setState({ connection }));
		client.connect();
	}

	detach(): void {
		this.clientGeneration += 1;
		this.sessionSelectionVersion += 1;
		for (const timer of this.refreshTimers.values()) clearTimeout(timer);
		this.refreshTimers.clear();
		this.messageRequests.clear();
		this.pendingMessageRefreshes.clear();
		if (this.sessionSummaryTimer) clearInterval(this.sessionSummaryTimer);
		this.sessionSummaryTimer = undefined;
		this.sessionSummaryRequest = undefined;
		this.managedBridge = false;
		this.positionBySessionId.clear();
		this.nextSessionPosition = 0;
		this.unsubscribeEvents?.();
		this.unsubscribeConnection?.();
		this.unsubscribeEvents = undefined;
		this.unsubscribeConnection = undefined;
		this.client?.disconnect();
		this.client = undefined;
	}

	async bootstrap(): Promise<void> {
		const client = this.client;
		const clientGeneration = this.clientGeneration;
		if (!client) return;
		try {
			const result = await client.resync();
			if (!this.isCurrentClient(client, clientGeneration)) return;
			const sessions = new Map<string, SessionSummary>();
			for (const raw of result.sessions.sessions) {
				const session = normalizeSession(raw);
				if (session) sessions.set(session.id, session);
			}
			this.initializeSessionPositions([...sessions.values()]);
			const permissions = new Map<string, PermissionRequest>();
			for (const session of sessions.values()) {
				for (const request of permissionMapFor(session))
					permissions.set(permissionKey(session.id, request.requestId), request);
			}
			const active = result.sessions.activeSessionId ?? result.status.activeSessionId;
			const activeSessionId = active && sessions.has(active) ? active : this.pickInitialSession(sessions);
			this.setState({
				sessionsById: sessions,
				sessionOrder: this.sortSessionIds(sessions.values()),
				activeSessionId,
				worklist: result.worklist,
				messagesBySessionId: new Map(),
				partialsBySessionId: new Map(),
				operationsBySessionId: new Map(),
				permissions,
				connection: "connected",
				lastError: null,
			});
			this.managedBridge = result.status.managedSessions === true;
			if (this.managedBridge) this.startSessionSummaryRefresh();
			if (activeSessionId) await this.openSession(activeSessionId);
		} catch (error) {
			if (this.isCurrentClient(client, clientGeneration)) this.setState({ lastError: this.errorText(error) });
		}
	}

	async openSession(sessionId: string): Promise<void> {
		const client = this.client;
		const selectionVersion = ++this.sessionSelectionVersion;
		if (!client || !this.state.sessionsById.has(sessionId)) return;
		await client.activate(sessionId).catch(() => undefined);
		// 选择动作可能在 activate 请求完成前再次发生；旧请求不得覆盖新选择。
		if (selectionVersion !== this.sessionSelectionVersion || this.client !== client) return;
		this.setState({ activeSessionId: sessionId });
		// A solver can keep running while it is not selected. Reload the selected
		// transcript on every activation so same-id stream updates remain authoritative.
		await this.refreshMessages(sessionId, true);
	}

	async refreshMessages(sessionId: string, initial = false): Promise<void> {
		const client = this.client;
		const clientGeneration = this.clientGeneration;
		if (!client) return;
		const existing = this.messageRequests.get(sessionId);
		if (existing) {
			// Keep one trailing refresh when a completion event arrives while the prior
			// request is still in flight; otherwise the final same-id message can remain stale.
			this.pendingMessageRefreshes.add(sessionId);
			return existing;
		}
		const current = this.state.messagesBySessionId.get(sessionId) ?? [];
		const highest = current.reduce((value, message) => Math.max(value, message.id), 0);
		// The bridge can replace the latest record while it streams. Include the last
		// known record in incremental pages so the store can replace it by id.
		const after = initial ? 0 : Math.max(0, highest - 1);
		let request: Promise<void>;
		request = client
			.getMessages(sessionId, after, 200)
			.then((page) => {
				if (this.client !== client || this.clientGeneration !== clientGeneration) return;
				const previousUpdatedAt = this.state.sessionsById.get(sessionId)?.updatedAt ?? 0;
				const pageIsStale = page.updatedAt < previousUpdatedAt;
				this.applyMessages(sessionId, page.messages, page.partial, initial);
				const session = this.state.sessionsById.get(sessionId);
				if (session) {
					this.updateSession({
						...session,
						status: page.status,
						msgSeq: Math.max(session.msgSeq, page.msgSeq),
						updatedAt: Math.max(session.updatedAt, page.updatedAt),
						lastError: page.lastError,
					});
				}
				if (!pageIsStale) this.setOperation(sessionId, operationFor(page.status));
			})
			.catch((error) => {
				if (this.client === client && this.clientGeneration === clientGeneration)
					this.setState({ lastError: this.errorText(error) });
			})
			.finally(() => {
				if (this.messageRequests.get(sessionId) !== request) return;
				this.messageRequests.delete(sessionId);
				if (
					this.client === client &&
					this.clientGeneration === clientGeneration &&
					this.pendingMessageRefreshes.delete(sessionId)
				)
					void this.refreshMessages(sessionId);
			});
		this.messageRequests.set(sessionId, request);
		return request;
	}

	async sendPrompt(text: string, options: PromptOptions = {}): Promise<void> {
		const sessionId = this.state.activeSessionId;
		if (!this.client || !sessionId || !text.trim()) return;
		this.setOperation(sessionId, { ...operationFor("running"), label: "已提交" });
		try {
			const result = await this.client.prompt(sessionId, text.trim(), options);
			const queued = result.queued === true;
			if (queued) this.setOperation(sessionId, { ...operationFor("running"), status: "queued", label: "排队中" });
			await this.refreshMessages(sessionId);
		} catch (error) {
			this.setOperation(sessionId, { ...operationFor("error"), label: "提交失败" });
			this.setState({ lastError: this.errorText(error) });
		}
	}

	async cancelActive(): Promise<void> {
		const sessionId = this.state.activeSessionId;
		if (!this.client || !sessionId) return;
		try {
			await this.client.cancel(sessionId, "由 WebUI 停止");
			await this.refreshMessages(sessionId);
		} catch (error) {
			this.setState({ lastError: this.errorText(error) });
		}
	}

	async createSession(planningEngine?: PlanningEngine): Promise<void> {
		if (!this.client) return;
		try {
			const result = await this.client.createSession(undefined, planningEngine);
			this.updateSession(result.session);
			this.setState({ activeSessionId: result.sessionId });
			await this.openSession(result.sessionId);
		} catch (error) {
			this.setState({ lastError: this.errorText(error) });
		}
	}

	async setPermissionMode(mode: string): Promise<void> {
		const sessionId = this.state.activeSessionId;
		if (!this.client || !sessionId) return;
		try {
			await this.client.setPermissionMode(sessionId, mode);
			const session = this.state.sessionsById.get(sessionId);
			if (session) this.updateSession({ ...session, permissionMode: mode });
		} catch (error) {
			this.setState({ lastError: this.errorText(error) });
		}
	}

	async resolvePermission(request: PermissionRequest, decision: string, answer?: string): Promise<void> {
		const sessionId = request.sessionId;
		if (!this.client || !sessionId) return;
		try {
			await this.client.resolvePermission(sessionId, request, decision, answer);
			const permissions = new Map(this.state.permissions);
			permissions.delete(permissionKey(sessionId, request.requestId));
			this.setState({ permissions });
			await this.refreshMessages(sessionId);
		} catch (error) {
			this.setState({ lastError: this.errorText(error) });
		}
	}

	async setModel(model: { provider: string; id: string }): Promise<void> {
		const sessionId = this.state.activeSessionId;
		if (!this.client || !sessionId) return;
		try {
			await this.client.setModel(sessionId, model);
			await this.refreshMessages(sessionId);
		} catch (error) {
			this.setState({ lastError: this.errorText(error) });
		}
	}

	async changeWorklist(action: "start" | "stop" | "sync"): Promise<void> {
		if (!this.client) return;
		try {
			const worklist =
				action === "start"
					? await this.client.startWorklist()
					: action === "stop"
						? await this.client.stopWorklist()
						: await this.client.syncWorklist();
			this.setState({ worklist });
		} catch (error) {
			this.setState({ lastError: this.errorText(error) });
		}
	}

	async guideWorklist(itemId: string, message: string): Promise<void> {
		if (!this.client) return;
		try {
			this.setState({ worklist: await this.client.guideWorklist(itemId, message) });
		} catch (error) {
			this.setState({ lastError: this.errorText(error) });
		}
	}

	async refreshSessionSummaries(force = false): Promise<void> {
		const client = this.client;
		const clientGeneration = this.clientGeneration;
		if (!client || (!this.managedBridge && !force)) return;
		if (this.sessionSummaryRequest) return this.sessionSummaryRequest;
		let request: Promise<void>;
		request = client
			.listSessions(true)
			.then((payload) => {
				if (this.isCurrentClient(client, clientGeneration))
					this.applySessionSummaries(payload.sessions, payload.activeSessionId);
			})
			.catch((error) => {
				if (this.isCurrentClient(client, clientGeneration)) this.setState({ lastError: this.errorText(error) });
			})
			.finally(() => {
				if (this.sessionSummaryRequest === request) this.sessionSummaryRequest = undefined;
			});
		this.sessionSummaryRequest = request;
		return request;
	}

	private handleEvent(event: BridgeEvent): void {
		this.setState({ lastEventAt: Date.now() }, false);
		if (event.type === "bridge-ready") {
			this.setState({ connection: "connected" });
			return;
		}
		if (event.type === "resync-required") {
			void this.resyncAfterReconnect();
			return;
		}
		if (event.type === "worklist-state") {
			const worklist = normalizeWorklist(event);
			if (worklist) this.setState({ worklist });
			else {
				const client = this.client;
				const clientGeneration = this.clientGeneration;
				void client
					?.getWorklist()
					.then((value) => {
						if (client && this.isCurrentClient(client, clientGeneration)) this.setState({ worklist: value });
					})
					.catch(() => undefined);
			}
			if (this.managedBridge) void this.refreshSessionSummaries();
			return;
		}
		const session = this.state.sessionsById.get(event.sessionId);
		const eventUpdatedAt = event.updatedAt;
		const eventIsStale = session !== undefined && eventUpdatedAt !== undefined && eventUpdatedAt < session.updatedAt;
		const nextSession = normalizeSession({
			...(session ?? { id: event.sessionId, title: event.title ?? "未命名会话", cwd: "" }),
			id: event.sessionId,
			...(event.title ? { title: event.title } : {}),
			...(event.role ? { role: event.role } : {}),
			...(event.taskId !== undefined ? { taskId: event.taskId } : {}),
			...(event.category !== undefined ? { category: event.category } : {}),
			...(event.state ? { status: event.state } : {}),
			...(event.seq !== undefined ? { msgSeq: event.seq } : {}),
			...(event.updatedAt !== undefined ? { updatedAt: event.updatedAt } : {}),
			...(event.permissionRequests !== undefined ? { permissionRequests: event.permissionRequests } : {}),
		});
		if (nextSession)
			this.updateSession(
				nextSession,
				event.state && !eventIsStale ? operationFor(event.state, event.event) : undefined,
			);
		else if (event.state) this.setOperation(event.sessionId, operationFor(event.state, event.event));
		if (event.permissionRequests !== undefined && !eventIsStale)
			this.replaceSessionPermissions(
				event.sessionId,
				event.permissionRequests.map((request) => ({ ...request, sessionId: event.sessionId })),
			);
		if (
			event.sessionId === this.state.activeSessionId &&
			((event.seq ?? 0) > (this.state.messagesBySessionId.get(event.sessionId)?.at(-1)?.id ?? 0) ||
				STREAM_EVENTS.has(event.event ?? ""))
		) {
			this.scheduleRefresh(event.sessionId);
		}
	}

	private scheduleRefresh(sessionId: string): void {
		if (this.refreshTimers.has(sessionId)) return;
		const timer = setTimeout(() => {
			this.refreshTimers.delete(sessionId);
			void this.refreshMessages(sessionId);
		}, 60);
		this.refreshTimers.set(sessionId, timer);
	}

	private applyMessages(
		sessionId: string,
		incoming: BridgeMessage[],
		partial: BridgeMessage | null,
		replace = false,
	): void {
		const previous = replace ? [] : (this.state.messagesBySessionId.get(sessionId) ?? []);
		const byId = new Map(previous.map((message) => [message.id, message]));
		for (const message of incoming) byId.set(message.id, message);
		const messages = [...byId.values()].sort((left, right) => left.id - right.id);
		const messagesBySessionId = new Map(this.state.messagesBySessionId);
		messagesBySessionId.set(sessionId, messages);
		const partialsBySessionId = new Map(this.state.partialsBySessionId);
		partialsBySessionId.set(sessionId, partial);
		const permissions = new Map(this.state.permissions);
		if (replace) {
			for (const key of permissions.keys()) {
				if (key.startsWith(`${sessionId}:`)) permissions.delete(key);
			}
			for (const request of this.state.sessionsById.get(sessionId)?.permissionRequests ?? [])
				permissions.set(permissionKey(sessionId, request.requestId), request);
		}
		for (const message of [...messages, ...(partial ? [partial] : [])]) {
			if (message.role !== "permission") continue;
			const requestId = asString(message.requestId || message.request_id);
			if (!requestId) continue;
			permissions.set(permissionKey(sessionId, requestId), {
				sessionId,
				requestId,
				toolName: asString(message.toolName || message.tool_name, "工具"),
				message: asString(message.content || message.title),
				args: message.detail ?? null,
				status: message.status === "resolved" ? "resolved" : "pending",
				createdAt: asNumber(message.ts, Date.now() / 1000),
				choices: Array.isArray(message.choices)
					? message.choices.filter((choice): choice is string => typeof choice === "string")
					: [],
			});
		}
		this.setState({ messagesBySessionId, partialsBySessionId, permissions });
	}

	private updateSession(session: SessionSummary, operation?: OperationState): void {
		const previous = this.state.sessionsById.get(session.id);
		const incomingUpdatedAt = Number.isFinite(session.updatedAt) ? session.updatedAt : 0;
		const isStale = previous !== undefined && incomingUpdatedAt < previous.updatedAt;
		const nextSession = previous
			? {
					...previous,
					...session,
					// 事件可能乱序到达，旧快照不能回退会话时间或覆盖更新的运行状态。
					updatedAt: Math.max(previous.updatedAt, incomingUpdatedAt),
					createdAt: Math.min(previous.createdAt, session.createdAt),
					msgSeq: Math.max(previous.msgSeq, session.msgSeq),
					...(isStale
						? {
								status: previous.status,
								lastError: previous.lastError,
								permissionRequests: previous.permissionRequests,
							}
						: {}),
				}
			: session;
		const sessions = new Map(this.state.sessionsById);
		sessions.set(nextSession.id, nextSession);
		this.recordSessionPosition(nextSession.id);
		const sessionOrder = this.sortSessionIds(sessions.values());
		const patch: Partial<SessionStoreState> = {
			sessionsById: sessions,
			sessionOrder: this.sameSessionOrder(sessionOrder) ? this.state.sessionOrder : sessionOrder,
		};
		if (session.permissionRequests !== undefined && !isStale) {
			const permissions = new Map(this.state.permissions);
			for (const key of permissions.keys()) if (key.startsWith(`${session.id}:`)) permissions.delete(key);
			for (const request of session.permissionRequests)
				permissions.set(permissionKey(session.id, request.requestId), request);
			patch.permissions = permissions;
		}
		if (operation) {
			const operations = new Map(this.state.operationsBySessionId);
			operations.set(session.id, operation);
			patch.operationsBySessionId = operations;
		}
		this.setState(patch);
	}

	private applySessionSummaries(rawSessions: SessionSummary[], preferredSessionId: string | null): void {
		const incoming = rawSessions.flatMap((raw) => {
			const session = normalizeSession(raw);
			return session ? [session] : [];
		});
		const sessions = new Map<string, SessionSummary>();
		const newSessions: SessionSummary[] = [];
		for (const session of incoming) {
			const previous = this.state.sessionsById.get(session.id);
			if (!previous) {
				sessions.set(session.id, session);
				newSessions.push(session);
				continue;
			}
			const isStale = session.updatedAt < previous.updatedAt;
			sessions.set(session.id, {
				...previous,
				...session,
				createdAt: Math.min(previous.createdAt, session.createdAt),
				updatedAt: Math.max(previous.updatedAt, session.updatedAt),
				msgSeq: Math.max(previous.msgSeq, session.msgSeq),
				...(isStale
					? {
							status: previous.status,
							lastError: previous.lastError,
							permissionRequests: previous.permissionRequests,
						}
					: {}),
			});
		}
		const ids = new Set(sessions.keys());
		const permissions = new Map(this.state.permissions);
		for (const id of this.positionBySessionId.keys()) {
			if (!ids.has(id)) this.positionBySessionId.delete(id);
		}
		for (const key of permissions.keys()) if (!ids.has(key.slice(0, key.indexOf(":")))) permissions.delete(key);
		for (const session of sessions.values()) {
			for (const key of permissions.keys()) if (key.startsWith(`${session.id}:`)) permissions.delete(key);
			for (const request of permissionMapFor(session))
				permissions.set(permissionKey(session.id, request.requestId), request);
		}
		// Bridge 已按最新优先返回；反向登记可让一批新 Solver 一次落到稳定顺序。
		for (let index = newSessions.length - 1; index >= 0; index -= 1) {
			const session = newSessions[index];
			this.recordSessionPosition(session.id);
		}
		const currentActive = this.state.activeSessionId;
		const activeSessionId =
			(currentActive && sessions.has(currentActive) ? currentActive : null) ??
			(preferredSessionId && sessions.has(preferredSessionId) ? preferredSessionId : null) ??
			this.pickInitialSession(sessions);
		const sessionOrder = this.sortSessionIds(sessions.values());
		this.setState({
			sessionsById: sessions,
			sessionOrder: this.sameSessionOrder(sessionOrder) ? this.state.sessionOrder : sessionOrder,
			activeSessionId,
			permissions,
		});
	}

	private replaceSessionPermissions(sessionId: string, requests: PermissionRequest[]): void {
		const permissions = new Map(this.state.permissions);
		for (const key of permissions.keys()) if (key.startsWith(`${sessionId}:`)) permissions.delete(key);
		for (const request of requests) permissions.set(permissionKey(sessionId, request.requestId), request);
		this.setState({ permissions });
	}

	private startSessionSummaryRefresh(): void {
		if (this.sessionSummaryTimer) return;
		this.sessionSummaryTimer = setInterval(() => void this.refreshSessionSummaries(), SESSION_SUMMARY_REFRESH_MS);
	}

	private async resyncAfterReconnect(): Promise<void> {
		const client = this.client;
		const clientGeneration = this.clientGeneration;
		if (!client) return;
		const activeSessionId = this.state.activeSessionId;
		await Promise.all([
			this.refreshSessionSummaries(true),
			activeSessionId ? this.refreshMessages(activeSessionId, true) : Promise.resolve(),
			client
				.getWorklist()
				.then((worklist) => {
					if (this.isCurrentClient(client, clientGeneration)) this.setState({ worklist });
				})
				.catch(() => undefined),
		]);
	}

	private isCurrentClient(client: BridgeClientLike, generation: number): boolean {
		return this.client === client && this.clientGeneration === generation;
	}

	private setOperation(sessionId: string, operation: OperationState): void {
		const operations = new Map(this.state.operationsBySessionId);
		operations.set(sessionId, operation);
		this.setState({ operationsBySessionId: operations });
	}

	private pickInitialSession(sessions: ReadonlyMap<string, SessionSummary>): string | null {
		return (
			this.sortSessionIds(sessions.values()).find((id) => sessions.get(id)?.role !== "solver") ??
			this.sortSessionIds(sessions.values())[0] ??
			null
		);
	}

	private initializeSessionPositions(sessions: SessionSummary[]): void {
		const ids = new Set(sessions.map((session) => session.id));
		for (const id of this.positionBySessionId.keys()) {
			if (!ids.has(id)) this.positionBySessionId.delete(id);
		}
		// Bridge 返回的会话已经按最新优先排列，反向分配序号即可保留首次加载顺序。
		for (let index = sessions.length - 1; index >= 0; index -= 1) {
			const session = sessions[index];
			this.recordSessionPosition(session.id);
		}
	}

	private recordSessionPosition(sessionId: string): void {
		// 顺序只在首次发现会话时登记，已有会话的消息和恢复事件不得改变位置。
		if (this.positionBySessionId.has(sessionId)) return;
		this.positionBySessionId.set(sessionId, ++this.nextSessionPosition);
	}

	private sortSessionIds(sessions: Iterable<SessionSummary>): string[] {
		return [...sessions]
			.filter((session) => !session.closed)
			.sort((left, right) => {
				const leftPosition = this.positionBySessionId.get(left.id) ?? 0;
				const rightPosition = this.positionBySessionId.get(right.id) ?? 0;
				return rightPosition - leftPosition || String(right.id).localeCompare(String(left.id));
			})
			.map((session) => session.id);
	}

	private sameSessionOrder(next: readonly string[]): boolean {
		return (
			next.length === this.state.sessionOrder.length &&
			next.every((id, index) => id === this.state.sessionOrder[index])
		);
	}

	private setState(patch: Partial<SessionStoreState>, notify = true): void {
		this.state = { ...this.state, ...patch };
		if (!notify) return;
		for (const listener of this.listeners) listener();
	}

	private errorText(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}

export const sessionStore = new SessionStore();

export function useSessionStore<T>(selector: (state: SessionStoreState) => T): T {
	const getSnapshot = useCallback(() => selector(sessionStore.getSnapshot()), [selector]);
	return useSyncExternalStore(sessionStore.subscribe, getSnapshot, getSnapshot);
}

export function useSessionMessages(sessionId: string | null): readonly BridgeMessage[] {
	const getSnapshot = useCallback(
		() => (sessionId ? sessionStore.getMessagesSnapshot(sessionId) : EMPTY_MESSAGES),
		[sessionId],
	);
	return useSyncExternalStore(sessionStore.subscribe, getSnapshot, getSnapshot);
}

export function useSessionPartial(sessionId: string | null): BridgeMessage | null {
	const getSnapshot = useCallback(() => (sessionId ? sessionStore.getPartialSnapshot(sessionId) : null), [sessionId]);
	return useSyncExternalStore(sessionStore.subscribe, getSnapshot, getSnapshot);
}

export function useSessionOperation(sessionId: string | null): OperationState {
	const getSnapshot = useCallback(
		() => (sessionId ? sessionStore.getOperationSnapshot(sessionId) : IDLE_OPERATION),
		[sessionId],
	);
	return useSyncExternalStore(sessionStore.subscribe, getSnapshot, getSnapshot);
}

export function useSessionPermissions(): ReadonlyMap<string, PermissionRequest> {
	return useSyncExternalStore(
		sessionStore.subscribe,
		sessionStore.getPermissionsSnapshot,
		sessionStore.getPermissionsSnapshot,
	);
}

export function createDefaultClient(): BridgeClient {
	return new BridgeClient();
}
