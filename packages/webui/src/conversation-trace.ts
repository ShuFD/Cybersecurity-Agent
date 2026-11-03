import type { BridgeMessage, BridgeToolCall } from "./types.ts";

export type ConversationToolStatus = "running" | "complete" | "error" | "stopped";

export interface ConversationToolRecord {
	toolCallId: string;
	toolName: string;
	requestText: string;
	resultText: string;
	status: ConversationToolStatus;
	isError: boolean;
	timestamp: number;
}

export type ConversationRow =
	| { kind: "message"; key: string; message: BridgeMessage }
	| { kind: "tool"; key: string; tool: ConversationToolRecord };

export interface AssistantContentSections {
	summary: string;
	thinking: string;
	response: string;
}

function textValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

export function prettyConversationToolText(value: unknown): string {
	const text = textValue(value).trim();
	if (!text || !/^[{[]/u.test(text)) return text;
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}

export function conversationToolStatus(status: unknown, isError = false, resultText = ""): ConversationToolStatus {
	const normalized = typeof status === "string" ? status.trim().toLowerCase() : "";
	if (isError || /^(?:error|failed|failure)$/iu.test(normalized)) return "error";
	if (/^(?:cancelled|canceled|stopped|interrupted)$/iu.test(normalized)) return "stopped";
	if (/^(?:complete|completed|success|succeeded|done)$/iu.test(normalized)) return "complete";
	if (resultText) return "complete";
	return "running";
}

function firstLine(value: string, fallback: string): string {
	const line = value
		.split(/\r?\n/u)
		.map((part) => part.trim())
		.find(Boolean);
	return line || fallback;
}

export function conversationToolSummary(record: ConversationToolRecord): string {
	if (record.status === "error" && record.resultText) {
		return firstLine(record.resultText, record.toolCallId);
	}
	try {
		const args: unknown = JSON.parse(record.requestText);
		if (typeof args === "object" && args !== null && !Array.isArray(args)) {
			const values = args as Record<string, unknown>;
			for (const key of ["description", "command", "path", "file_path", "query", "pattern", "url", "name"]) {
				const value = values[key];
				if (typeof value === "string" && value.trim()) return firstLine(value, record.toolCallId);
			}
			const value = Object.values(values).find((candidate) => typeof candidate === "string" && candidate.trim());
			if (typeof value === "string") return firstLine(value, record.toolCallId);
		}
	} catch {
		// 非 JSON 参数使用首行作为摘要。
	}
	return firstLine(record.requestText, record.toolCallId || "运行工具");
}

function toolRecordFromCall(call: BridgeToolCall, message: BridgeMessage, index: number): ConversationToolRecord {
	return {
		toolCallId: call.id || `message-${message.id}-${index}`,
		toolName: call.name || "tool",
		requestText: prettyConversationToolText(call.argsText),
		resultText: "",
		status: "running",
		isError: false,
		timestamp: message.ts,
	};
}

function toolRecordFromResult(message: BridgeMessage): ConversationToolRecord {
	const resultText = prettyConversationToolText(message.content);
	return {
		toolCallId: String(message.toolCallId || message.tool_call_id || `result-${message.id}`),
		toolName: String(message.toolName || message.tool_name || "tool"),
		requestText: "",
		resultText,
		status: conversationToolStatus(message.status, message.isError === true, resultText),
		isError: message.isError === true,
		timestamp: message.ts,
	};
}

function mergeToolRecord(current: ConversationToolRecord, next: ConversationToolRecord): ConversationToolRecord {
	const resultText = next.resultText || current.resultText;
	const isError = next.isError || current.isError;
	const requestedStatus = current.status !== "running" && next.status === "running" ? current.status : next.status;
	return {
		...current,
		...next,
		toolName: next.toolName || current.toolName,
		requestText: next.requestText || current.requestText,
		resultText,
		status: conversationToolStatus(requestedStatus, isError, resultText),
		isError,
		timestamp: Math.min(current.timestamp, next.timestamp),
	};
}

export function buildConversationRows(messages: readonly BridgeMessage[]): ConversationRow[] {
	const rows: ConversationRow[] = [];
	const toolRowByKey = new Map<string, number>();
	const activeToolKeyById = new Map<string, string>();
	const pendingResultKeysById = new Map<string, string[]>();
	const occurrenceById = new Map<string, number>();

	function nextToolKey(toolCallId: string): string {
		const occurrence = (occurrenceById.get(toolCallId) ?? 0) + 1;
		occurrenceById.set(toolCallId, occurrence);
		return occurrence === 1 ? toolCallId : `${toolCallId}#${occurrence}`;
	}

	function toolKeyForCall(toolCallId: string): string {
		const active = activeToolKeyById.get(toolCallId);
		if (active) return active;
		const pending = pendingResultKeysById.get(toolCallId);
		const reordered = pending?.pop();
		if (reordered) {
			activeToolKeyById.set(toolCallId, reordered);
			return reordered;
		}
		const key = nextToolKey(toolCallId);
		activeToolKeyById.set(toolCallId, key);
		return key;
	}

	function toolKeyForResult(toolCallId: string): string {
		const active = activeToolKeyById.get(toolCallId);
		if (active) {
			activeToolKeyById.delete(toolCallId);
			return active;
		}
		const key = nextToolKey(toolCallId);
		const pending = pendingResultKeysById.get(toolCallId) ?? [];
		pending.push(key);
		pendingResultKeysById.set(toolCallId, pending);
		return key;
	}

	function upsertTool(record: ConversationToolRecord, rowKey: string): void {
		const existingIndex = toolRowByKey.get(rowKey);
		if (existingIndex === undefined) {
			toolRowByKey.set(rowKey, rows.length);
			rows.push({ kind: "tool", key: `tool:${rowKey}`, tool: record });
			return;
		}
		const existing = rows[existingIndex];
		if (existing.kind === "tool") {
			rows[existingIndex] = { ...existing, tool: mergeToolRecord(existing.tool, record) };
		}
	}

	// A streaming bridge can expose the same message in both `messages` and
	// `partial`. Normalize that pair before building rows so it cannot render
	// duplicate assistant bubbles or duplicate tool calls.
	const normalizedMessages = new Map<number, BridgeMessage>();
	const normalizedOrder: number[] = [];
	for (const message of messages) {
		const previous = normalizedMessages.get(message.id);
		if (!previous) normalizedOrder.push(message.id);
		normalizedMessages.set(
			message.id,
			previous
				? {
						...previous,
						...message,
						...(previous.toolCalls && !message.toolCalls ? { toolCalls: previous.toolCalls } : {}),
						partial: previous.partial === true || message.partial === true,
					}
				: message,
		);
	}

	for (const messageId of normalizedOrder) {
		const message = normalizedMessages.get(messageId);
		if (!message) continue;
		const isTool = message.role === "tool" || message.role === "toolResult" || message.role === "tool_result";
		if (isTool) {
			const tool = toolRecordFromResult(message);
			upsertTool(tool, toolKeyForResult(tool.toolCallId));
			continue;
		}
		const hasVisibleAssistantContent =
			message.role !== "assistant" || Boolean(message.content.trim() || message.thinking?.trim());
		if (hasVisibleAssistantContent) {
			rows.push({
				kind: "message",
				key: `message:${message.id}:${message.partial ? "partial" : "complete"}`,
				message,
			});
		}
		for (const [index, call] of (message.toolCalls ?? []).entries()) {
			const tool = toolRecordFromCall(call, message, index);
			upsertTool(tool, toolKeyForCall(tool.toolCallId));
		}
	}

	return rows;
}

export function splitAssistantContent(content: string, explicitThinking = ""): AssistantContentSections {
	let remaining = content.trimStart();
	let summary = "";
	let taggedThinking = "";
	const summaryMatch = remaining.match(/^<summary\b[^>]*>([\s\S]*?)<\/summary>\s*/iu);
	if (summaryMatch) {
		summary = summaryMatch[1].trim();
		remaining = remaining.slice(summaryMatch[0].length);
	}
	const thinkMatch = remaining.match(/^<think\b[^>]*>([\s\S]*?)<\/think>\s*/iu);
	if (thinkMatch) {
		taggedThinking = thinkMatch[1].trim();
		remaining = remaining.slice(thinkMatch[0].length);
	}
	const thinking = explicitThinking.trim() || taggedThinking;
	return {
		summary: summary || firstLine(thinking, "分析问题并规划下一步"),
		thinking,
		response: remaining.trim(),
	};
}
