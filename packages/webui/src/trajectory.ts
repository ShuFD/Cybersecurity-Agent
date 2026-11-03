import { prettyConversationToolText } from "./conversation-trace.ts";
import type { BridgeMessage, RuntimeLogPayload, RuntimeTraceEvent } from "./types.ts";

export type TrajectoryKind = "system" | "context" | "user" | "assistant" | "tool";

export interface TrajectoryRecord {
	id: string;
	kind: TrajectoryKind;
	timestamp: number;
	endTimestamp: number;
	turn: number | null;
	order: number;
	content: string;
	preview: string;
	thinkingText?: string;
	toolCallId?: string;
	toolName?: string;
	requestText?: string;
	resultText?: string;
	provider?: string;
	model?: string;
	eventName?: string;
	isError: boolean;
	running: boolean;
	source: "message" | "runtime";
}

export interface TrajectoryModel {
	records: TrajectoryRecord[];
	turns: number;
	calls: number;
}

const PARTIAL_TERMINAL_EVENTS = new Set([
	"runtime-reset",
	"cancelled",
	"error",
	"closed",
	"remote-complete",
	"remote-error",
	"turn_end",
]);

function lightDeltaClearsPartial(payload: RuntimeLogPayload): boolean {
	const status = payload.session.status;
	if (status !== "running" && status !== "paused") return true;
	return payload.events.some((event) => {
		const name = event.event.trim().toLowerCase();
		if (PARTIAL_TERMINAL_EVENTS.has(name)) return true;
		if (name !== "message_end") return false;
		const role = typeof event.role === "string" ? event.role.trim().toLowerCase() : "";
		return role === "assistant" || role === "";
	});
}

/** Merge a runtime-log delta into the last snapshot without duplicating cursored items. */
export function mergeRuntimeLogPayload(previous: RuntimeLogPayload | null, next: RuntimeLogPayload): RuntimeLogPayload {
	if (
		!previous ||
		next.incremental !== true ||
		next.resetRequired === true ||
		previous.sessionId !== next.sessionId ||
		(previous.logEpoch !== undefined && next.logEpoch !== undefined && previous.logEpoch !== next.logEpoch)
	) {
		return next;
	}

	const messagesIncluded = next.messagesIncluded !== false;
	const messagesById = new Map(previous.messages.map((message) => [message.id, message]));
	if (messagesIncluded) {
		for (const message of next.messages) messagesById.set(message.id, message);
	}
	const eventsById = new Map<number, RuntimeLogPayload["events"][number]>();
	const eventsWithoutId: RuntimeLogPayload["events"] = [];
	const eventSignaturesWithoutId = new Set<string>();
	const signatureForEvent = (event: RuntimeLogPayload["events"][number]): string => {
		try {
			return JSON.stringify(event);
		} catch {
			return `${event.event}:${event.timestamp}:${event.toolCallId ?? ""}`;
		}
	};
	for (const event of previous.events) {
		if (typeof event.id === "number") eventsById.set(event.id, event);
		else {
			const signature = signatureForEvent(event);
			if (!eventSignaturesWithoutId.has(signature)) {
				eventSignaturesWithoutId.add(signature);
				eventsWithoutId.push(event);
			}
		}
	}
	for (const event of next.events) {
		if (typeof event.id === "number") eventsById.set(event.id, event);
		else {
			const signature = signatureForEvent(event);
			if (!eventSignaturesWithoutId.has(signature)) {
				eventSignaturesWithoutId.add(signature);
				eventsWithoutId.push(event);
			}
		}
	}
	const events = [...eventsById.values(), ...eventsWithoutId].sort(
		(left, right) => (left.id ?? Number.MAX_SAFE_INTEGER) - (right.id ?? Number.MAX_SAFE_INTEGER),
	);
	let maxMessageId = 0;
	for (const messageId of messagesById.keys()) maxMessageId = Math.max(maxMessageId, messageId);
	let maxEventId = 0;
	for (const event of events) maxEventId = Math.max(maxEventId, event.id ?? 0);
	const messageCursor = next.messageCursor ?? maxMessageId;
	const eventCursor = next.eventCursor ?? maxEventId;
	const partial = messagesIncluded
		? next.partial
		: (next.partial ?? (lightDeltaClearsPartial(next) ? null : previous.partial));
	return {
		...previous,
		...next,
		messages: messagesIncluded
			? [...messagesById.values()].sort((left, right) => left.id - right.id)
			: previous.messages,
		partial,
		events,
		messageCursor,
		eventCursor,
		logEpoch: next.logEpoch ?? previous.logEpoch,
		messagesIncluded: messagesIncluded || previous.messagesIncluded,
	};
}

interface RuntimeInterval {
	start: number;
	end: number;
	turn: number;
}

interface RuntimeModel {
	intervals: Map<TrajectoryKind, RuntimeInterval[]>;
	toolStates: Map<string, ToolState>;
	toolKeysByScope: Map<string, string[]>;
	toolKeysByRawId: Map<string, string[]>;
	contextRecords: TrajectoryRecord[];
	eventTurn: number;
}

interface ToolState {
	record: TrajectoryRecord;
	hasStart: boolean;
	hasEnd: boolean;
	hasResult: boolean;
}

const CONTEXT_EVENTS = new Set([
	"created",
	"restored",
	"runtime-reset",
	"running",
	"cancelled",
	"paused",
	"resumed",
	"error",
	"model",
	"model-error",
	"permission-mode",
	"output-timeout-retry",
	"compaction_start",
	"compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"summarization_retry_scheduled",
	"summarization_retry_attempt_start",
	"summarization_retry_finished",
]);

const EVENT_LABELS: Record<string, string> = {
	created: "会话已创建",
	restored: "会话已恢复",
	"runtime-reset": "Runtime 已重置",
	running: "Agent 已启动",
	cancelled: "运行已停止",
	paused: "会话已暂停",
	resumed: "会话已继续",
	error: "运行失败",
	model: "模型已切换",
	"model-error": "模型切换失败",
	"permission-mode": "权限模式已更改",
	"output-timeout-retry": "输出超时，正在重试",
	compaction_start: "上下文压缩开始",
	compaction_end: "上下文压缩完成",
	auto_retry_start: "自动重试开始",
	auto_retry_end: "自动重试完成",
	summarization_retry_scheduled: "摘要重试已排程",
	summarization_retry_attempt_start: "摘要重试开始",
	summarization_retry_finished: "摘要重试完成",
};

export const TRAJECTORY_LANE: Record<TrajectoryKind, number> = {
	system: 0,
	context: 0,
	user: 0,
	assistant: 1,
	tool: 2,
};

function finiteNumber(value: unknown): number | null {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

export function timestampMs(value: unknown, fallback = Date.now()): number {
	const number = finiteNumber(value);
	if (number === null || number <= 0) return fallback;
	return number > 10_000_000_000 ? number : number * 1000;
}

function normalizeKind(role: unknown): TrajectoryKind {
	const value = typeof role === "string" ? role.toLowerCase() : "";
	if (value === "system") return "system";
	if (value === "user") return "user";
	if (value === "assistant") return "assistant";
	if (value === "toolresult" || value === "tool_result" || value === "tool") return "tool";
	return "context";
}

function compactText(value: unknown, limit = 180): string {
	const text = String(value ?? "")
		.replace(/\s+/gu, " ")
		.trim();
	if (!text) return "";
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function toolScope(turn: number | null, toolCallId: string): string {
	return `${turn ?? 0}\u0000${toolCallId}`;
}

function canonicalToolKey(turn: number | null, toolCallId: string, occurrence: number): string {
	return `${turn ?? 0}:${toolCallId}#${occurrence}`;
}

function eventDetailText(event: RuntimeTraceEvent): string {
	const parts: string[] = [];
	for (const [label, key] of [
		["Level", "level"],
		["Reason", "reason"],
		["Error", "errorMessage"],
		["Final error", "finalError"],
	] as const) {
		const value = event[key];
		if (typeof value === "string" && value) parts.push(`${label}: ${value}`);
	}
	if (typeof event.attempt === "number") {
		parts.push(`Attempt: ${event.attempt}${typeof event.maxAttempts === "number" ? `/${event.maxAttempts}` : ""}`);
	}
	if (typeof event.delayMs === "number") parts.push(`Delay: ${event.delayMs}ms`);
	if (event.aborted === true) parts.push("Aborted");
	if (event.willRetry === true) parts.push("Will retry");
	return parts.join("\n");
}

function addInterval(
	map: Map<TrajectoryKind, RuntimeInterval[]>,
	kind: TrajectoryKind,
	interval: RuntimeInterval,
): void {
	const entries = map.get(kind) ?? [];
	entries.push(interval);
	map.set(kind, entries);
}

function buildRuntimeModel(events: readonly RuntimeTraceEvent[], running: boolean): RuntimeModel {
	const ordered = [...events].sort(
		(left, right) =>
			timestampMs(left.timestamp, 0) - timestampMs(right.timestamp, 0) || (left.id ?? 0) - (right.id ?? 0),
	);
	const openMessages = new Map<TrajectoryKind, Array<{ timestamp: number; turn: number }>>();
	const intervals = new Map<TrajectoryKind, RuntimeInterval[]>();
	const toolStates = new Map<string, ToolState>();
	const toolKeysByScope = new Map<string, string[]>();
	const toolKeysByRawId = new Map<string, string[]>();
	const occurrenceByScope = new Map<string, number>();
	const activeToolKeysByScope = new Map<string, string[]>();
	const pendingEndKeysByScope = new Map<string, string[]>();
	const contextRecords: TrajectoryRecord[] = [];
	let eventTurn = 0;

	function eventTurnFor(event: RuntimeTraceEvent): number {
		const explicit = finiteNumber(event.turn ?? event.turnIndex ?? event.turnNumber);
		return explicit === null ? eventTurn : Math.max(0, Math.floor(explicit));
	}

	function allocateToolKey(turn: number, toolCallId: string): string {
		const scope = toolScope(turn, toolCallId);
		const occurrence = (occurrenceByScope.get(scope) ?? 0) + 1;
		occurrenceByScope.set(scope, occurrence);
		const key = canonicalToolKey(turn, toolCallId, occurrence);
		const scoped = toolKeysByScope.get(scope) ?? [];
		scoped.push(key);
		toolKeysByScope.set(scope, scoped);
		const raw = toolKeysByRawId.get(toolCallId) ?? [];
		raw.push(key);
		toolKeysByRawId.set(toolCallId, raw);
		return key;
	}

	function resolveToolStart(turn: number, toolCallId: string): string {
		const scope = toolScope(turn, toolCallId);
		const pending = pendingEndKeysByScope.get(scope);
		const reordered = pending?.shift();
		const key = reordered ?? allocateToolKey(turn, toolCallId);
		const active = activeToolKeysByScope.get(scope) ?? [];
		active.push(key);
		activeToolKeysByScope.set(scope, active);
		return key;
	}

	function resolveToolEnd(turn: number, toolCallId: string): string {
		const scope = toolScope(turn, toolCallId);
		const active = activeToolKeysByScope.get(scope);
		const key = active?.shift() ?? allocateToolKey(turn, toolCallId);
		if (!active || active.length === 0) activeToolKeysByScope.delete(scope);
		if (!active) {
			const pending = pendingEndKeysByScope.get(scope) ?? [];
			pending.push(key);
			pendingEndKeysByScope.set(scope, pending);
		}
		return key;
	}

	function toolStateFor(
		key: string,
		toolCallId: string,
		turn: number,
		event: RuntimeTraceEvent,
		timestamp: number,
		order: number,
	): ToolState {
		const existing = toolStates.get(key);
		if (existing) return existing;
		const record: TrajectoryRecord = {
			id: `tool:${key}`,
			kind: "tool",
			timestamp,
			endTimestamp: timestamp,
			turn: turn || null,
			order,
			content: "",
			preview: "工具调用",
			toolCallId,
			toolName: event.toolName || "tool",
			requestText: "",
			resultText: "",
			isError: false,
			running: false,
			source: "runtime",
		};
		const state = { record, hasStart: false, hasEnd: false, hasResult: false } satisfies ToolState;
		toolStates.set(key, state);
		return state;
	}

	function applyToolStart(event: RuntimeTraceEvent, timestamp: number, order: number, index: number): void {
		const toolCallId = String(event.toolCallId || `event-${event.id ?? index}`);
		const turn = eventTurnFor(event);
		const key = resolveToolStart(turn, toolCallId);
		const state = toolStateFor(key, toolCallId, turn, event, timestamp, order);
		const record = state.record;
		state.hasStart = true;
		record.timestamp = Math.min(record.timestamp, timestamp);
		record.order = Math.min(record.order, order);
		record.turn = record.turn ?? (turn || null);
		record.toolName = event.toolName || record.toolName || "tool";
		const requestText = prettyConversationToolText(event.argsText);
		if (requestText) record.requestText = requestText;
		record.content = `${record.toolName}\n${record.requestText}`.trim();
		record.preview = compactText(record.requestText || record.resultText || "工具调用");
		if (!state.hasEnd) record.running = running;
	}

	function applyToolEnd(event: RuntimeTraceEvent, timestamp: number, order: number, index: number): void {
		const toolCallId = String(event.toolCallId || `event-${event.id ?? index}`);
		const turn = eventTurnFor(event);
		const key = resolveToolEnd(turn, toolCallId);
		const state = toolStateFor(key, toolCallId, turn, event, timestamp, order);
		const record = state.record;
		state.hasEnd = true;
		state.hasResult = true;
		record.timestamp = Math.min(record.timestamp, timestamp);
		record.endTimestamp = Math.max(record.endTimestamp, timestamp);
		record.order = Math.min(record.order, order);
		record.turn = record.turn ?? (turn || null);
		record.toolName = event.toolName || record.toolName || "tool";
		const resultText = prettyConversationToolText(event.resultText);
		if (resultText) record.resultText = resultText;
		record.content = `${record.toolName}\n${record.requestText}`.trim() || record.resultText || "工具结果";
		record.preview = compactText(record.requestText || record.resultText || "工具结果");
		record.isError ||= event.isError === true;
		record.running = false;
	}

	for (const [index, event] of ordered.entries()) {
		const timestamp = timestampMs(event.timestamp);
		if (event.event === "turn_start") {
			const explicit = finiteNumber(event.turn ?? event.turnIndex ?? event.turnNumber);
			eventTurn = explicit === null ? eventTurn + 1 : Math.max(0, Math.floor(explicit));
		}
		if (event.event === "message_start") {
			const kind = normalizeKind(event.role);
			const entries = openMessages.get(kind) ?? [];
			entries.push({ timestamp, turn: eventTurn });
			openMessages.set(kind, entries);
			continue;
		}
		if (event.event === "message_end") {
			const kind = normalizeKind(event.role);
			const start = openMessages.get(kind)?.shift();
			addInterval(intervals, kind, {
				start: start?.timestamp ?? timestamp,
				end: timestamp,
				turn: start?.turn || eventTurn,
			});
			continue;
		}
		if (event.event === "tool_execution_start") {
			applyToolStart(event, timestamp, event.id ?? index, index);
			continue;
		}
		if (event.event === "tool_execution_end") {
			applyToolEnd(event, timestamp, event.id ?? index, index);
			continue;
		}
		if (CONTEXT_EVENTS.has(event.event)) {
			const detail = eventDetailText(event);
			const isError = event.event === "error" || event.event === "model-error";
			contextRecords.push({
				id: `event:${event.id ?? index}:${event.event}`,
				kind: isError ? "system" : "context",
				timestamp,
				endTimestamp: timestamp,
				turn: eventTurn || null,
				order: event.id ?? index,
				content: detail || EVENT_LABELS[event.event] || event.event,
				preview: detail
					? `${EVENT_LABELS[event.event] || event.event}: ${compactText(detail, 120)}`
					: EVENT_LABELS[event.event] || event.event,
				eventName: event.event,
				isError,
				running: false,
				source: "runtime",
			});
		}
	}

	for (const state of toolStates.values()) {
		const record = state.record;
		if (!state.hasEnd) {
			record.running = running;
			record.endTimestamp = running ? Date.now() : record.timestamp;
		}
		if (!record.turn) record.turn = eventTurn || null;
		record.content =
			`${record.toolName || "tool"}\n${record.requestText || ""}`.trim() || record.resultText || "工具结果";
		record.preview = compactText(
			record.requestText || record.resultText || (record.running ? "工具调用中" : "工具结果"),
		);
	}
	for (const entries of intervals.values()) entries.sort((left, right) => left.start - right.start);
	return { intervals, toolStates, toolKeysByScope, toolKeysByRawId, contextRecords, eventTurn };
}

function turnAt(timestamp: number, userTimestamps: readonly number[]): number | null {
	let turn = 0;
	for (const userTimestamp of userTimestamps) {
		if (userTimestamp > timestamp) break;
		turn += 1;
	}
	return turn || null;
}

function messageTimestamp(message: BridgeMessage, fallback: number): number {
	return timestampMs(message.ts, fallback);
}

export function buildTrajectory(payload: RuntimeLogPayload): TrajectoryModel {
	const messages = [...payload.messages];
	if (payload.partial) {
		const existingIndex = messages.findIndex((message) => message.id === payload.partial?.id);
		if (existingIndex >= 0) {
			// Managed sessions expose the streaming transcript item and `partial` with
			// the same id. Overlay the partial so the completed record is not rendered
			// ahead of the latest streamed content.
			messages[existingIndex] = { ...messages[existingIndex], ...payload.partial, partial: true };
		} else {
			messages.push(payload.partial);
		}
	}
	const sessionCreatedAt = timestampMs(payload.session.createdAt);
	messages.sort(
		(left, right) =>
			messageTimestamp(left, sessionCreatedAt) - messageTimestamp(right, sessionCreatedAt) || left.id - right.id,
	);
	const runtime = buildRuntimeModel(payload.events, payload.session.status === "running");
	const toolStates = runtime.toolStates;
	const transcriptCallQueues = new Map<string, string[]>();
	const transcriptPendingResults = new Map<string, string[]>();
	const transcriptCallOccurrences = new Map<string, number>();
	const transcriptResultOccurrences = new Map<string, number>();
	const claimedRuntimeKeys = new Set<string>();

	function runtimeToolCandidates(toolCallId: string, turn: number | null): string[] {
		if (turn !== null) {
			const scoped = runtime.toolKeysByScope.get(toolScope(turn, toolCallId));
			if (scoped && scoped.length > 0) return scoped;
		}
		return runtime.toolKeysByRawId.get(toolCallId) ?? [];
	}

	function selectRuntimeToolKey(candidates: readonly string[], preferredIndex: number): string | undefined {
		const preferred = candidates[preferredIndex];
		if (preferred && !claimedRuntimeKeys.has(preferred)) return preferred;
		return candidates.find((candidate) => !claimedRuntimeKeys.has(candidate));
	}

	function transcriptToolKeyForCall(toolCallId: string, turn: number | null): string {
		const scope = toolScope(turn, toolCallId);
		const pending = transcriptPendingResults.get(scope);
		const reordered = pending?.shift();
		if (pending && pending.length === 0) transcriptPendingResults.delete(scope);
		const occurrence = (transcriptCallOccurrences.get(scope) ?? 0) + 1;
		transcriptCallOccurrences.set(scope, occurrence);
		const candidates = runtimeToolCandidates(toolCallId, turn);
		const key =
			reordered ??
			selectRuntimeToolKey(candidates, occurrence - 1) ??
			canonicalToolKey(turn, toolCallId, occurrence);
		if (runtime.toolStates.has(key)) claimedRuntimeKeys.add(key);
		const queue = transcriptCallQueues.get(scope) ?? [];
		queue.push(key);
		transcriptCallQueues.set(scope, queue);
		return key;
	}

	function transcriptToolKeyForResult(toolCallId: string, turn: number | null): string {
		const scope = toolScope(turn, toolCallId);
		const callQueue = transcriptCallQueues.get(scope);
		const fromCall = callQueue?.shift();
		if (callQueue && callQueue.length === 0) transcriptCallQueues.delete(scope);
		if (fromCall) return fromCall;
		const occurrence = (transcriptResultOccurrences.get(scope) ?? 0) + 1;
		transcriptResultOccurrences.set(scope, occurrence);
		const candidates = runtimeToolCandidates(toolCallId, turn);
		const key = selectRuntimeToolKey(candidates, occurrence - 1) ?? canonicalToolKey(turn, toolCallId, occurrence);
		if (runtime.toolStates.has(key)) claimedRuntimeKeys.add(key);
		const pending = transcriptPendingResults.get(scope) ?? [];
		pending.push(key);
		transcriptPendingResults.set(scope, pending);
		return key;
	}

	function mergeTranscriptTool(
		toolKey: string,
		toolCallId: string,
		patch: {
			timestamp: number;
			order: number;
			turn: number | null;
			toolName?: string;
			requestText?: string;
			resultText?: string;
			isError?: boolean;
			running: boolean;
			hasStart?: boolean;
			hasEnd?: boolean;
			hasResult?: boolean;
		},
	): TrajectoryRecord {
		let state = toolStates.get(toolKey);
		if (!state) {
			state = {
				record: {
					id: `tool:${toolKey}`,
					kind: "tool",
					timestamp: patch.timestamp,
					endTimestamp: patch.timestamp,
					turn: patch.turn,
					order: patch.order,
					content: "",
					preview: "工具调用",
					toolCallId,
					toolName: patch.toolName || "tool",
					requestText: "",
					resultText: "",
					isError: false,
					running: patch.running,
					source: "message",
				},
				hasStart: false,
				hasEnd: false,
				hasResult: false,
			};
			toolStates.set(toolKey, state);
		}
		const record = state.record;
		state.hasStart ||= patch.hasStart === true;
		state.hasEnd ||= patch.hasEnd === true;
		state.hasResult ||= patch.hasResult === true;
		record.timestamp = Math.min(record.timestamp, patch.timestamp);
		record.endTimestamp = Math.max(record.endTimestamp, patch.timestamp);
		record.order = Math.min(record.order, patch.order);
		record.turn ||= patch.turn;
		if (patch.toolName) record.toolName = patch.toolName;
		if (patch.requestText) record.requestText = patch.requestText;
		if (patch.resultText) record.resultText = patch.resultText;
		record.isError ||= patch.isError === true;
		if (state.hasEnd || state.hasResult) record.running = false;
		else record.running = patch.running;
		if (record.source !== "runtime") record.source = "message";
		record.content =
			`${record.toolName || "tool"}\n${record.requestText || ""}`.trim() || record.resultText || "工具结果";
		record.preview = compactText(
			record.requestText || record.resultText || (record.running ? "工具调用中" : "工具结果"),
		);
		return record;
	}

	const messageRecords: TrajectoryRecord[] = [];
	const userTimestamps = messages
		.filter((message) => normalizeKind(message.role) === "user")
		.map((message, index) => messageTimestamp(message, sessionCreatedAt + index));
	let messageTurn = 0;

	for (const [index, message] of messages.entries()) {
		const kind = normalizeKind(message.role);
		const timestamp = messageTimestamp(message, sessionCreatedAt + index);
		if (kind === "user") messageTurn += 1;
		for (const [toolIndex, call] of (message.toolCalls ?? []).entries()) {
			const toolCallId = call.id || `message-${message.id}-${toolIndex}`;
			const requestText = prettyConversationToolText(call.argsText);
			const turn = messageTurn || turnAt(timestamp, userTimestamps);
			mergeTranscriptTool(transcriptToolKeyForCall(toolCallId, turn), toolCallId, {
				timestamp: timestamp + toolIndex / 10,
				order: message.id + (toolIndex + 1) / 100,
				turn,
				toolName: call.name,
				requestText,
				running: message.partial === true || payload.session.status === "running",
				hasStart: true,
			});
		}

		if (kind === "tool") {
			const toolCallId = String(message.toolCallId || message.tool_call_id || `result-${message.id}`);
			const resultText = prettyConversationToolText(message.content);
			const turn = messageTurn || turnAt(timestamp, userTimestamps);
			mergeTranscriptTool(transcriptToolKeyForResult(toolCallId, turn), toolCallId, {
				timestamp,
				order: message.id,
				turn,
				toolName: String(message.toolName || message.tool_name || "tool"),
				resultText,
				isError: message.isError === true,
				running: false,
				hasEnd: true,
				hasResult: true,
			});
			continue;
		}

		const interval = runtime.intervals.get(kind)?.shift();
		const content = message.content;
		const thinkingText = message.thinking?.trim() || undefined;
		messageRecords.push({
			id: `message:${message.id}:${kind}`,
			kind,
			timestamp: interval?.start ?? timestamp,
			endTimestamp: message.partial ? Date.now() : (interval?.end ?? timestamp),
			turn:
				kind === "system" || (kind === "context" && messageTurn === 0)
					? null
					: messageTurn || interval?.turn || null,
			order: message.id,
			content,
			preview: compactText(content || thinkingText || (message.partial ? "流式回复" : "空消息")),
			...(thinkingText ? { thinkingText } : {}),
			...(typeof message.provider === "string" ? { provider: message.provider } : {}),
			...(typeof message.model === "string" ? { model: message.model } : {}),
			isError: message.isError === true || message.stopReason === "error",
			running: message.partial === true,
			source: "message",
		});
	}

	for (const record of [...toolStates.values()].map((state) => state.record).concat(runtime.contextRecords)) {
		if (!record.turn) record.turn = turnAt(record.timestamp, userTimestamps);
	}
	const toolRecords = [...toolStates.values()].map((state) => state.record);
	const records = [...messageRecords, ...toolRecords, ...runtime.contextRecords].sort(
		(left, right) =>
			left.timestamp - right.timestamp ||
			left.order - right.order ||
			TRAJECTORY_LANE[left.kind] - TRAJECTORY_LANE[right.kind],
	);
	return {
		records,
		turns: Math.max(userTimestamps.length, runtime.eventTurn),
		calls: toolRecords.length,
	};
}

export function trajectoryRange(records: readonly TrajectoryRecord[]): { start: number; end: number } {
	if (records.length === 0) return { start: Date.now(), end: Date.now() };
	return {
		start: Math.min(...records.map((record) => record.timestamp)),
		end: Math.max(
			...records.map((record) => (record.running ? Date.now() : record.endTimestamp || record.timestamp)),
		),
	};
}

export function recordDuration(record: TrajectoryRecord): number {
	return Math.max(0, (record.running ? Date.now() : record.endTimestamp) - record.timestamp);
}

export function matchesTrajectoryQuery(record: TrajectoryRecord, query: string): boolean {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return true;
	return [
		record.kind,
		record.content,
		record.preview,
		record.thinkingText,
		record.toolName,
		record.requestText,
		record.resultText,
		record.provider,
		record.model,
		record.eventName,
		record.turn,
	]
		.filter((value) => value !== undefined && value !== null)
		.join("\n")
		.toLowerCase()
		.includes(normalized);
}
