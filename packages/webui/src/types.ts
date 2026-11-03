export type ConnectionState = "connecting" | "connected" | "reconnecting" | "offline";

export type SessionStatus = "idle" | "running" | "error" | "paused" | "cancelled" | "closed";

export interface SessionSummary {
	id: string;
	title: string;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	status: SessionStatus;
	role: "local" | "main" | "solver" | "agent" | string;
	managed: boolean;
	taskId: string | null;
	category: string | null;
	msgSeq: number;
	permissionMode: string;
	persistent: boolean;
	closed: boolean;
	lastError: string;
	turnCount: number;
	watchdogPhase: string | null;
	permissionRequests?: PermissionRequest[];
	[key: string]: unknown;
}

export interface BridgeMessage {
	id: number;
	role: string;
	content: string;
	ts: number;
	thinking?: string;
	thinkingRedacted?: boolean;
	partial?: boolean;
	status?: string;
	toolName?: string;
	tool_name?: string;
	toolCallId?: string;
	tool_call_id?: string;
	toolCalls?: BridgeToolCall[];
	isError?: boolean;
	requestId?: string;
	request_id?: string;
	[key: string]: unknown;
}

export interface BridgeToolCall {
	id: string;
	name: string;
	argsText: string;
}

export interface RuntimeTraceEvent {
	id?: number;
	event: string;
	timestamp: number;
	role?: string;
	toolCallId?: string;
	toolName?: string;
	argsText?: string;
	resultText?: string;
	contentText?: string;
	thinkingText?: string;
	thinkingRedacted?: boolean;
	messageTimestamp?: number;
	isError?: boolean;
	[key: string]: unknown;
}

export interface RuntimeLogPayload {
	sessionId: string;
	session: SessionSummary;
	messages: BridgeMessage[];
	partial: BridgeMessage | null;
	events: RuntimeTraceEvent[];
	incremental?: boolean;
	resetRequired?: boolean;
	logEpoch?: string;
	messageCursor?: number;
	eventCursor?: number;
	eventStartId?: number;
	messagesIncluded?: boolean;
}

export interface PermissionRequest {
	sessionId: string;
	requestId: string;
	toolName: string;
	message: string;
	args: unknown;
	status: "pending" | "resolved";
	createdAt: number;
	choices: string[];
}

export interface WorklistItem {
	id: string;
	sessionId?: string;
	exerciseId?: string;
	name: string;
	category?: string;
	description?: string;
	status: string;
	attempts: number;
	priority: number;
	updatedAt: number;
	[key: string]: unknown;
}

export interface WorklistSnapshot {
	running: boolean;
	configured: boolean;
	managed?: boolean;
	controller?: string;
	items: WorklistItem[];
	activeEnvironmentCount?: number;
	maxEnvironmentCount?: number;
	updatedAt: number;
	[key: string]: unknown;
}

export interface StatusPayload {
	ok: boolean;
	running: boolean;
	ready: boolean;
	managedSessions: boolean;
	sessionCount: number;
	activeSessionId: string | null;
	transport?: { http?: boolean; wsEventsOnly?: boolean };
	projectRoot?: string;
	[key: string]: unknown;
}

export interface ModelProfile {
	provider: string;
	id: string;
	name?: string;
	selected?: boolean;
	[key: string]: unknown;
}

export interface MessagesPage {
	sessionId: string;
	status: SessionStatus;
	messages: BridgeMessage[];
	partial: BridgeMessage | null;
	msgSeq: number;
	updatedAt: number;
	lastError: string;
	after: number;
	limit: number;
	nextAfter: number;
	[key: string]: unknown;
}

export interface SessionsPayload {
	sessions: SessionSummary[];
	activeSessionId: string | null;
}

export interface SessionStateEvent {
	type: "session-state";
	eventId?: number;
	sessionId: string;
	role?: string;
	title?: string;
	taskId?: string | null;
	category?: string | null;
	state?: SessionStatus;
	event?: string;
	seq?: number;
	updatedAt?: number;
	permissionRequests?: Array<Omit<PermissionRequest, "sessionId">>;
}

export interface WorklistStateEvent {
	type: "worklist-state";
	eventId?: number;
	[key: string]: unknown;
}

export interface BridgeReadyEvent {
	type: "bridge-ready";
	eventId?: number;
	projectRoot?: string;
	sequence?: number;
	[key: string]: unknown;
}

export interface ResyncRequiredEvent {
	type: "resync-required";
	eventId?: number;
	reason?: string;
}

export type BridgeEvent = SessionStateEvent | WorklistStateEvent | BridgeReadyEvent | ResyncRequiredEvent;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asBoolean(value: unknown, fallback = false): boolean {
	return typeof value === "boolean" ? value : fallback;
}

export function normalizeSession(value: unknown): SessionSummary | null {
	if (!isRecord(value)) return null;
	const id = asString(value.id || value.sessionId).trim();
	if (!id) return null;
	const rawStatus = asString(value.status, "idle");
	const status: SessionStatus = ["idle", "running", "error", "paused", "cancelled", "closed"].includes(rawStatus)
		? (rawStatus as SessionStatus)
		: "idle";
	const permissionRequests = Array.isArray(value.permissionRequests)
		? value.permissionRequests.flatMap((item) => normalizePermissionRequest(item, id))
		: [];
	return {
		...value,
		id,
		title: asString(value.title || value.name, "未命名会话"),
		cwd: asString(value.cwd, ""),
		createdAt: asNumber(value.createdAt, Date.now() / 1000),
		updatedAt: asNumber(value.updatedAt, asNumber(value.createdAt, Date.now() / 1000)),
		status,
		role: asString(value.role, "local"),
		managed: asBoolean(value.managed),
		taskId: typeof value.taskId === "string" ? value.taskId : null,
		category: typeof value.category === "string" ? value.category : null,
		msgSeq: asNumber(value.msgSeq),
		permissionMode: asString(value.permissionMode, "default"),
		persistent: asBoolean(value.persistent),
		closed: asBoolean(value.closed),
		lastError: asString(value.lastError),
		turnCount: asNumber(value.turnCount),
		watchdogPhase: typeof value.watchdogPhase === "string" ? value.watchdogPhase : null,
		permissionRequests,
	};
}

function normalizePermissionRequest(value: unknown, sessionId: string): PermissionRequest[] {
	if (!isRecord(value)) return [];
	const requestId = asString(value.requestId || value.request_id).trim();
	if (!requestId) return [];
	return [
		{
			sessionId,
			requestId,
			toolName: asString(value.toolName || value.tool_name, "工具"),
			message: asString(value.message || value.content),
			args: value.args ?? value.detail ?? null,
			status: value.status === "resolved" ? "resolved" : "pending",
			createdAt: asNumber(value.createdAt ?? value.created_at ?? value.ts, Date.now()),
			choices: Array.isArray(value.choices)
				? value.choices.filter((choice): choice is string => typeof choice === "string")
				: [],
		},
	];
}

export function normalizeMessage(value: unknown): BridgeMessage | null {
	if (!isRecord(value)) return null;
	const messageId = asNumber(value.id, 0);
	if (messageId <= 0) return null;
	const rawContent = value.content;
	const content =
		typeof rawContent === "string" ? rawContent : rawContent === undefined ? "" : JSON.stringify(rawContent);
	const rawToolCalls = Array.isArray(value.toolCalls)
		? value.toolCalls
		: Array.isArray(value.tool_calls)
			? value.tool_calls
			: undefined;
	const toolCalls = rawToolCalls
		? rawToolCalls.flatMap((toolCall, index) => {
				if (!isRecord(toolCall)) return [];
				const id =
					asString(toolCall.id || toolCall.toolCallId || toolCall.tool_call_id).trim() ||
					`message-${messageId}-${index}`;
				const name = asString(toolCall.name || toolCall.toolName, "tool");
				const rawArgs = toolCall.argsText ?? toolCall.arguments ?? toolCall.args ?? toolCall.input;
				return [
					{
						id,
						name,
						argsText:
							typeof rawArgs === "string" ? rawArgs : rawArgs === undefined ? "" : JSON.stringify(rawArgs),
					},
				];
			})
		: undefined;
	return {
		...value,
		id: messageId,
		role: asString(value.role, "system"),
		content,
		ts: asNumber(value.ts, Date.now() / 1000),
		...(typeof value.thinking === "string" ? { thinking: value.thinking } : {}),
		...(typeof value.thinkingRedacted === "boolean" ? { thinkingRedacted: value.thinkingRedacted } : {}),
		...(toolCalls ? { toolCalls } : {}),
	};
}

export function normalizeRuntimeTraceEvent(value: unknown): RuntimeTraceEvent | null {
	if (!isRecord(value)) return null;
	const event = asString(value.event || value.type).trim();
	if (!event) return null;
	return {
		...value,
		event,
		timestamp: asNumber(value.timestamp ?? value.ts, Date.now()),
		...(typeof value.id === "number" ? { id: value.id } : {}),
		...(typeof value.role === "string" ? { role: value.role } : {}),
		...(typeof value.toolCallId === "string" ? { toolCallId: value.toolCallId } : {}),
		...(typeof value.toolName === "string" ? { toolName: value.toolName } : {}),
		...(typeof value.argsText === "string" ? { argsText: value.argsText } : {}),
		...(typeof value.resultText === "string" ? { resultText: value.resultText } : {}),
		...(typeof value.contentText === "string" ? { contentText: value.contentText } : {}),
		...(typeof value.thinkingText === "string" ? { thinkingText: value.thinkingText } : {}),
		...(typeof value.thinkingRedacted === "boolean" ? { thinkingRedacted: value.thinkingRedacted } : {}),
		...(typeof value.messageTimestamp === "number" ? { messageTimestamp: value.messageTimestamp } : {}),
		...(typeof value.isError === "boolean" ? { isError: value.isError } : {}),
	};
}

export function normalizeWorklist(value: unknown): WorklistSnapshot | null {
	if (!isRecord(value)) return null;
	const rawItems = Array.isArray(value.items) ? value.items : [];
	const items = rawItems.flatMap((item) => {
		if (!isRecord(item)) return [];
		const id = asString(item.id || item.taskId).trim();
		if (!id) return [];
		return [
			{
				...item,
				id,
				name: asString(item.name || item.exerciseId, id),
				status: asString(item.status, "queued"),
				attempts: asNumber(item.attempts),
				priority: asNumber(item.priority),
				updatedAt: asNumber(item.updatedAt, Date.now()),
			},
		];
	});
	return {
		...value,
		running: asBoolean(value.running),
		configured: asBoolean(value.configured),
		items,
		updatedAt: asNumber(value.updatedAt, Date.now()),
	};
}
