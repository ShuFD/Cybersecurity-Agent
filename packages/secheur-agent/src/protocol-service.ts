import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { type AgentMessage, type Session, SessionError, type TelemetryContext } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
	type Usage as AiUsage,
	type Api,
	type AssistantMessage,
	getSupportedThinkingLevels,
	type Model,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { type AgentSessionEvent, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type {
	AssistantTranscriptItem,
	JsonValue,
	ModelMetadata,
	ModelRef,
	SessionMetadata,
	SessionPhase,
	SessionSnapshot,
	ThinkingLevel,
	ToolTranscriptItem,
	TranscriptItem,
	Usage,
	UserTranscriptItem,
} from "@earendil-works/pi-protocol";
import {
	type CreateSessionOptions,
	PiServerError,
	type PiServerService,
	type PiSessionRuntime,
	type PiSessionRuntimeEvent,
	type PromptInput,
	type ResolvePermissionInput,
	SessionLockedError,
	SessionNotFoundError,
	type SteerInput,
} from "@earendil-works/pi-server";
import {
	createNodeSqliteFactory,
	type SqliteSessionMetadata,
	SqliteSessionRepository,
} from "@earendil-works/pi-session-backend-sqlite-node";
import { NOOP_TELEMETRY_CONTEXT } from "@earendil-works/pi-telemetry";
import { type LoadSecHeurConfigOptions, loadSecHeurConfig, type SecHeurConfig } from "./config.ts";
import {
	type CreateSecHeurRuntimeOptions,
	createSecHeurRuntime,
	type SecHeurRuntime,
	secHeurSessionDirectory,
} from "./runtime.ts";

const PROTOCOL_STATE_TYPE = "secheur.protocol.state";
const PROTOCOL_STATE_VERSION = 1;

type StandardAgentMessage = Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }>;
type FinishedToolTranscriptItem = Extract<ToolTranscriptItem, { status: "complete" | "error" }>;

interface StoredProtocolState {
	version: number;
	model: ModelRef;
	thinkingLevel: ThinkingLevel;
	revision: number;
	updatedAt: number;
}

interface PendingMessage {
	id: string;
	message: StandardAgentMessage;
}

interface CreateProtocolRuntimeOptions {
	runtime: SecHeurRuntime;
	repository: SqliteSessionRepository;
	session: Session<SqliteSessionMetadata>;
	metadata: SqliteSessionMetadata;
	storedState?: StoredProtocolState;
	persistInitialState: boolean;
	onDispose: () => void;
}

export interface CreateSecHeurProtocolServiceOptions extends LoadSecHeurConfigOptions {
	databasePath?: string;
	modelRuntime?: ModelRuntime;
	telemetryContext?: TelemetryContext;
	permissionMode?: SecHeurConfig["permissionMode"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asJsonValue(value: unknown): JsonValue | undefined {
	try {
		const encoded = JSON.stringify(value);
		return encoded === undefined ? undefined : (JSON.parse(encoded) as JsonValue);
	} catch {
		return undefined;
	}
}

function cloneMessage(message: StandardAgentMessage): StandardAgentMessage {
	const encoded = JSON.stringify(message);
	if (encoded === undefined) throw new TypeError("Agent message is not JSON serializable");
	return JSON.parse(encoded) as StandardAgentMessage;
}

function isStandardMessage(message: AgentMessage): message is StandardAgentMessage {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function normalizeTimestamp(value: number, fallback: number): number {
	return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function nonNegativeNumber(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function nonNegativeInteger(value: number): number {
	return Number.isSafeInteger(value) ? Math.max(0, value) : 0;
}

function positiveInteger(value: number): number {
	return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function protocolUsage(usage: AiUsage): Usage {
	return {
		input: nonNegativeInteger(usage.input),
		output: nonNegativeInteger(usage.output),
		cacheRead: nonNegativeInteger(usage.cacheRead),
		cacheWrite: nonNegativeInteger(usage.cacheWrite),
		...(usage.reasoning === undefined ? {} : { reasoning: nonNegativeInteger(usage.reasoning) }),
		totalTokens: nonNegativeInteger(usage.totalTokens),
		cost: {
			input: nonNegativeNumber(usage.cost.input),
			output: nonNegativeNumber(usage.cost.output),
			cacheRead: nonNegativeNumber(usage.cost.cacheRead),
			cacheWrite: nonNegativeNumber(usage.cost.cacheWrite),
			total: nonNegativeNumber(usage.cost.total),
		},
	};
}

function userContent(message: Extract<StandardAgentMessage, { role: "user" }>): UserTranscriptItem["content"] {
	if (typeof message.content === "string") return [{ type: "text", text: message.content }];
	return message.content.map((part) =>
		part.type === "text"
			? { type: "text" as const, text: part.text }
			: { type: "image" as const, data: part.data, mimeType: part.mimeType },
	);
}

function assistantContent(message: AssistantMessage): AssistantTranscriptItem["content"] {
	const content: AssistantTranscriptItem["content"] = [];
	for (const part of message.content) {
		switch (part.type) {
			case "text":
				content.push({ type: "text", text: part.text });
				break;
			case "thinking":
				content.push({
					type: "thinking",
					thinking: part.thinking,
					...(part.redacted === undefined ? {} : { redacted: part.redacted }),
				});
				break;
			case "toolCall":
				content.push({
					type: "toolCall",
					toolCallId: part.id,
					toolName: part.name,
					input: asJsonValue(part.arguments) ?? {},
				});
				break;
		}
	}
	return content;
}

function assistantItem(id: string, message: AssistantMessage, streaming = false): AssistantTranscriptItem {
	const base = {
		id,
		role: "assistant" as const,
		content: assistantContent(message),
		model: { provider: message.provider, id: message.model },
		...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
		usage: protocolUsage(message.usage),
		timestamp: normalizeTimestamp(message.timestamp, Date.now()),
	};
	if (streaming || message.stopReason === "pending") return { ...base, status: "streaming" };
	if (message.stopReason === "error") {
		return {
			...base,
			status: "error",
			stopReason: "error",
			...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
		};
	}
	if (message.stopReason === "aborted") {
		return {
			...base,
			status: "aborted",
			stopReason: "aborted",
			...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
		};
	}
	return {
		...base,
		status: "complete",
		stopReason: message.stopReason === "length" || message.stopReason === "toolUse" ? message.stopReason : "stop",
	};
}

function toolContent(message: ToolResultMessage): ToolTranscriptItem["content"] {
	return message.content.map((part) =>
		part.type === "text"
			? { type: "text" as const, text: part.text }
			: { type: "image" as const, data: part.data, mimeType: part.mimeType },
	);
}

function toolItem(
	id: string,
	message: ToolResultMessage,
	toolCalls: ReadonlyMap<string, { name: string; input: JsonValue }>,
): FinishedToolTranscriptItem {
	const call = toolCalls.get(message.toolCallId);
	const details = asJsonValue(message.details);
	const base = {
		id,
		role: "tool" as const,
		toolCallId: message.toolCallId,
		toolName: message.toolName || call?.name || "unknown",
		input: call?.input ?? {},
		content: toolContent(message),
		...(details === undefined ? {} : { details }),
		...(message.usage === undefined ? {} : { usage: protocolUsage(message.usage) }),
		timestamp: normalizeTimestamp(message.timestamp, Date.now()),
	};
	return message.isError
		? { ...base, status: "error", isError: true }
		: { ...base, status: "complete", isError: false };
}

function transcriptFromEntries(
	entries: Awaited<ReturnType<Session<SqliteSessionMetadata>["findEntries"]>>,
): TranscriptItem[] {
	const transcript: TranscriptItem[] = [];
	const toolCalls = new Map<string, { name: string; input: JsonValue }>();
	for (const entry of entries) {
		if (entry.type !== "message" || !isStandardMessage(entry.message)) continue;
		const message = entry.message;
		if (message.role === "user") {
			transcript.push({
				id: entry.id,
				role: "user",
				content: userContent(message),
				timestamp: normalizeTimestamp(message.timestamp, entry.timestamp),
			});
			continue;
		}
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "toolCall") {
					toolCalls.set(part.id, { name: part.name, input: asJsonValue(part.arguments) ?? {} });
				}
			}
			transcript.push(assistantItem(entry.id, message));
			continue;
		}
		transcript.push(toolItem(entry.id, message, toolCalls));
	}
	return transcript;
}

function parseStoredState(value: unknown): StoredProtocolState | undefined {
	if (!isRecord(value) || value.version !== PROTOCOL_STATE_VERSION) return undefined;
	const model = value.model;
	if (
		!isRecord(model) ||
		typeof model.provider !== "string" ||
		!model.provider ||
		typeof model.id !== "string" ||
		!model.id
	) {
		return undefined;
	}
	const thinkingLevels = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	if (typeof value.thinkingLevel !== "string" || !thinkingLevels.has(value.thinkingLevel as ThinkingLevel)) {
		return undefined;
	}
	if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) return undefined;
	if (!Number.isSafeInteger(value.updatedAt) || Number(value.updatedAt) < 0) return undefined;
	return {
		version: PROTOCOL_STATE_VERSION,
		model: { provider: model.provider, id: model.id },
		thinkingLevel: value.thinkingLevel as ThinkingLevel,
		revision: Number(value.revision),
		updatedAt: Number(value.updatedAt),
	};
}

async function latestStoredState(session: Session<SqliteSessionMetadata>): Promise<StoredProtocolState | undefined> {
	const [entry] = await session.findEntries({
		type: "custom",
		customType: PROTOCOL_STATE_TYPE,
		order: "newestFirst",
		limit: 1,
	});
	return entry?.type === "custom" ? parseStoredState(entry.data) : undefined;
}

function modelMetadata(model: Model<Api>, runtime: ModelRuntime): ModelMetadata {
	return {
		provider: model.provider,
		id: model.id,
		name: model.name || model.id,
		api: model.api || "unknown",
		reasoning: model.reasoning,
		input: [...model.input],
		contextWindow: positiveInteger(model.contextWindow),
		maxTokens: positiveInteger(model.maxTokens),
		cost: {
			input: nonNegativeNumber(model.cost.input),
			output: nonNegativeNumber(model.cost.output),
			cacheRead: nonNegativeNumber(model.cost.cacheRead),
			cacheWrite: nonNegativeNumber(model.cost.cacheWrite),
		},
		supportedThinkingLevels: getSupportedThinkingLevels(model),
		authenticated: runtime.hasConfiguredAuth(model.provider),
	};
}

function persistenceError(): PiServerError {
	return new SessionLockedError("Session persistence is unavailable");
}

function mapRepositoryError(error: unknown, sessionId: string): Error {
	if (error instanceof PiServerError) return error;
	if (error instanceof SessionError) {
		if (error.code === "not_found") return new SessionNotFoundError(`Unknown session: ${sessionId}`);
		if (error.code === "already_exists") return new SessionLockedError(`Session already exists: ${sessionId}`);
		if (error.code === "storage" && error.message.includes("active writer")) {
			return new SessionLockedError(`Session is locked: ${sessionId}`);
		}
	}
	return error instanceof Error ? error : new Error(String(error));
}

function toolResultContent(value: unknown): ToolTranscriptItem["content"] {
	if (!isRecord(value) || !Array.isArray(value.content)) return [];
	const content: ToolTranscriptItem["content"] = [];
	for (const part of value.content) {
		if (!isRecord(part) || typeof part.type !== "string") continue;
		if (part.type === "text" && typeof part.text === "string") {
			content.push({ type: "text", text: part.text });
			continue;
		}
		if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
			content.push({ type: "image", data: part.data, mimeType: part.mimeType });
		}
	}
	return content;
}

function runningToolItem(
	id: string,
	toolCallId: string,
	toolName: string,
	input: unknown,
	timestamp: number,
): ToolTranscriptItem {
	return {
		id,
		role: "tool",
		toolCallId,
		toolName,
		input: asJsonValue(input) ?? {},
		content: [],
		status: "running",
		isError: false,
		timestamp,
	};
}

export class SecHeurProtocolRuntime implements PiSessionRuntime {
	private readonly runtime: SecHeurRuntime;
	private readonly repository: SqliteSessionRepository;
	private readonly storage: Session<SqliteSessionMetadata>;
	private readonly metadata: SqliteSessionMetadata;
	private readonly onDispose: () => void;
	private readonly listeners = new Set<(event: PiSessionRuntimeEvent) => void>();
	private readonly runningTools = new Map<string, ToolTranscriptItem>();
	private queuedSteer: UserTranscriptItem[] = [];
	private pendingMessage?: PendingMessage;
	private unsubscribe: () => void = () => {};
	private writeTail: Promise<void> = Promise.resolve();
	private writeError?: PiServerError;
	private writeErrorReported = false;
	private revision: number;
	private updatedAt: number;
	private commandActive = false;
	private closing = false;
	private disposed = false;
	private disposePromise?: Promise<void>;
	private readonly operationBarriers = new Set<Promise<void>>();

	private constructor(options: CreateProtocolRuntimeOptions) {
		this.runtime = options.runtime;
		this.repository = options.repository;
		this.storage = options.session;
		this.metadata = options.metadata;
		this.onDispose = options.onDispose;
		this.revision = options.storedState?.revision ?? 0;
		this.updatedAt = options.storedState?.updatedAt ?? options.metadata.createdAt;
	}

	static async create(options: CreateProtocolRuntimeOptions): Promise<SecHeurProtocolRuntime> {
		const instance = new SecHeurProtocolRuntime(options);
		await instance.reconcileTranscript();
		instance.unsubscribe = instance.runtime.subscribe((event) => instance.handleEvent(event));
		if (options.persistInitialState) await instance.persistState();
		return instance;
	}

	getPhase(): SessionPhase {
		if (this.runtime.session.isCompacting) return "compaction";
		if (this.runtime.session.retryAttempt > 0) return "retry";
		if (this.commandActive || !this.runtime.session.isIdle) return "turn";
		return "idle";
	}

	async snapshot(): Promise<SessionSnapshot> {
		this.assertOpen();
		const releaseOperation = this.beginOperation();
		try {
			await this.awaitWrites();
			const model = this.runtime.session.model;
			if (!model) throw new PiServerError("invalid_request", "Session has no configured model");
			const entries = await this.storage.findEntries({ type: "message", order: "oldestFirst" });
			const transcript = transcriptFromEntries(entries);
			if (this.pendingMessage) {
				const pending = this.pendingMessage;
				if (pending.message.role === "user") {
					transcript.push({
						id: pending.id,
						role: "user",
						content: userContent(pending.message),
						timestamp: normalizeTimestamp(pending.message.timestamp, this.updatedAt),
					});
				} else if (pending.message.role === "assistant") {
					transcript.push(assistantItem(pending.id, pending.message, true));
				}
			}
			for (const item of this.runningTools.values()) {
				if (!transcript.some((candidate) => candidate.id === item.id)) transcript.push(item);
			}
			const name = await this.storage.getName();
			return {
				id: this.metadata.id,
				...(name === undefined ? {} : { name }),
				cwd: this.metadata.cwd,
				createdAt: this.metadata.createdAt,
				updatedAt: this.updatedAt,
				phase: this.getPhase(),
				model: { provider: model.provider, id: model.id },
				thinkingLevel: this.runtime.session.thinkingLevel,
				attached: false,
				locked: true,
				revision: this.revision,
				transcript,
				queuedSteer: [...this.queuedSteer],
				queuedSteerCount: this.queuedSteer.length,
				permissionRequests: this.runtime.state.permissionBroker.list().map((request) => ({
					requestId: request.id,
					toolName: request.toolName,
					message: request.message,
					args: asJsonValue(request.input) ?? {},
					status: "pending" as const,
					createdAt: request.createdAt,
					choices: Array.isArray(request.input.candidates)
						? request.input.candidates.filter((choice): choice is string => typeof choice === "string")
						: [],
				})),
			};
		} finally {
			releaseOperation();
		}
	}

	async prompt(input: PromptInput): Promise<void> {
		this.assertOpen();
		const releaseOperation = this.beginOperation();
		try {
			if (this.commandActive || this.getPhase() !== "idle") throw new PiServerError("busy", "Session is busy");
			this.commandActive = true;
			this.changed();
			let completed = false;
			try {
				await this.runtime.prompt(input.text, { source: "rpc" });
				await this.awaitWrites();
				completed = true;
			} catch (error) {
				if (error instanceof PiServerError) throw error;
				throw new PiServerError("invalid_request", error instanceof Error ? error.message : "Prompt was rejected");
			} finally {
				this.commandActive = false;
				this.changed();
				if (completed) await this.persistState();
			}
		} finally {
			releaseOperation();
		}
	}

	async steer(input: SteerInput): Promise<void> {
		this.assertOpen();
		const releaseOperation = this.beginOperation();
		try {
			if (!this.commandActive && this.runtime.session.isIdle) {
				throw new PiServerError("busy", "There is no active prompt to steer");
			}
			await this.runtime.session.steer(input.text);
			this.changed();
		} finally {
			releaseOperation();
		}
	}

	async abort(): Promise<void> {
		this.assertOpen();
		const releaseOperation = this.beginOperation();
		try {
			if (!this.commandActive && this.runtime.session.isIdle) {
				throw new PiServerError("busy", "There is no active prompt to abort");
			}
			await this.runtime.abort("Protocol session abort");
			await this.awaitWrites();
			this.changed();
			await this.persistState();
		} finally {
			releaseOperation();
		}
	}

	async setModel(modelRef: ModelRef): Promise<void> {
		this.assertIdle();
		const releaseOperation = this.beginOperation();
		try {
			const model = this.runtime.session.modelRuntime.getModel(modelRef.provider, modelRef.id);
			if (!model) throw new PiServerError("invalid_request", `Unknown model: ${modelRef.provider}/${modelRef.id}`);
			try {
				await this.runtime.session.setModel(model);
			} catch (error) {
				throw new PiServerError(
					"invalid_request",
					error instanceof Error ? error.message : `Cannot use model: ${modelRef.provider}/${modelRef.id}`,
				);
			}
			this.changed();
			await this.persistState();
		} finally {
			releaseOperation();
		}
	}

	async setThinking(thinkingLevel: ThinkingLevel): Promise<void> {
		this.assertIdle();
		const releaseOperation = this.beginOperation();
		try {
			const model = this.runtime.session.model;
			if (!model) throw new PiServerError("invalid_request", "Session has no configured model");
			if (!getSupportedThinkingLevels(model).includes(thinkingLevel)) {
				throw new PiServerError(
					"invalid_request",
					`Thinking level ${thinkingLevel} is not supported by ${model.provider}/${model.id}`,
				);
			}
			this.runtime.session.setThinkingLevel(thinkingLevel);
			this.changed();
			await this.persistState();
		} finally {
			releaseOperation();
		}
	}

	async resolvePermission(input: ResolvePermissionInput): Promise<void> {
		this.assertOpen();
		const pending = this.runtime.state.permissionBroker.list().find((request) => request.id === input.requestId);
		if (!pending) throw new PiServerError("not_found", `Permission request not found: ${input.requestId}`);
		if (input.decision === "answer" && pending.toolName !== "ask_user" && pending.toolName !== "exit_plan_mode") {
			throw new PiServerError(
				"invalid_request",
				`Permission request does not accept an answer: ${pending.toolName}`,
			);
		}
		const affirmative = /^(?:approve|approved|allow|ok|y|yes)$/iu.test((input.answer ?? "").trim());
		const allowed =
			input.decision === "allow_once" ||
			input.decision === "allow_session" ||
			(input.decision === "answer" && (pending.toolName !== "exit_plan_mode" || affirmative));
		if (input.decision === "allow_session")
			this.runtime.state.permissions.allowForSession(pending.toolName, pending.input);
		if (!this.runtime.state.permissionBroker.resolve(input.requestId, allowed, input.answer)) {
			throw new PiServerError("not_found", `Permission request not found: ${input.requestId}`);
		}
		this.changed();
	}

	subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void {
		this.assertOpen();
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dispose(): Promise<void> {
		this.disposePromise ??= this.disposeInternal();
		return this.disposePromise;
	}

	private async disposeInternal(): Promise<void> {
		if (this.disposed) return;
		this.closing = true;
		try {
			if (this.commandActive || !this.runtime.session.isIdle)
				await this.runtime.abort("Protocol session dispose").catch(() => {});
			await Promise.allSettled([...this.operationBarriers]);
			this.unsubscribe();
			await this.awaitWrites().catch(() => {});
			if (!this.writeError) await this.persistState().catch(() => {});
		} finally {
			try {
				this.runtime.dispose();
			} finally {
				try {
					await this.repository.close();
				} finally {
					this.disposed = true;
					this.listeners.clear();
					this.onDispose();
				}
			}
		}
	}

	private assertOpen(): void {
		if (this.closing || this.disposed) throw new PiServerError("session_locked", "Session runtime is closed");
		if (this.writeError) throw this.writeError;
	}

	private beginOperation(): () => void {
		let resolveBarrier = () => {};
		const barrier = new Promise<void>((resolvePromise) => {
			resolveBarrier = resolvePromise;
		});
		this.operationBarriers.add(barrier);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.operationBarriers.delete(barrier);
			resolveBarrier();
		};
	}

	private assertIdle(): void {
		this.assertOpen();
		if (this.commandActive || this.getPhase() !== "idle") throw new PiServerError("busy", "Session is busy");
	}

	private changed(): void {
		this.revision += 1;
		this.updatedAt = Date.now();
		this.emit({ type: "snapshot" });
	}

	private emit(event: PiSessionRuntimeEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// 监听器不能破坏会话状态。
			}
		}
	}

	private queueWrite(operation: () => Promise<void>): void {
		this.writeTail = this.writeTail
			.then(async () => {
				if (this.writeError) throw this.writeError;
				await operation();
			})
			.catch(() => {
				this.writeError ??= persistenceError();
				if (!this.writeErrorReported) {
					this.writeErrorReported = true;
					this.emit({ type: "error", error: this.writeError });
				}
			});
	}

	private async awaitWrites(): Promise<void> {
		await this.writeTail;
		if (this.writeError) throw this.writeError;
	}

	private async persistState(): Promise<void> {
		const model = this.runtime.session.model;
		if (!model) throw new PiServerError("invalid_request", "Session has no configured model");
		const state: StoredProtocolState = {
			version: PROTOCOL_STATE_VERSION,
			model: { provider: model.provider, id: model.id },
			thinkingLevel: this.runtime.session.thinkingLevel,
			revision: this.revision,
			updatedAt: this.updatedAt,
		};
		this.queueWrite(async () => {
			await this.storage.appendCustomEntry(PROTOCOL_STATE_TYPE, state);
		});
		await this.awaitWrites();
	}

	private async reconcileTranscript(): Promise<void> {
		const persisted = (await this.storage.findEntries({ type: "message", order: "oldestFirst" })).filter(
			(entry) => entry.type === "message" && isStandardMessage(entry.message),
		);
		const runtimeMessages = this.runtime.session.messages;
		const current = runtimeMessages.filter(isStandardMessage).map(cloneMessage);
		const sharedLength = Math.min(persisted.length, current.length);
		for (let index = 0; index < sharedLength; index += 1) {
			const entry = persisted[index];
			if (entry.type !== "message" || JSON.stringify(entry.message) !== JSON.stringify(current[index])) return;
		}
		if (persisted.length > current.length) {
			// 非标准消息可能表示 compaction 上下文，无法在不改变语义的情况下合并原始 transcript。
			if (runtimeMessages.length !== current.length) return;
			for (const entry of persisted.slice(current.length)) {
				if (entry.type !== "message" || !isStandardMessage(entry.message)) continue;
				const message = cloneMessage(entry.message);
				this.runtime.session.sessionManager.appendMessage(message);
				this.runtime.session.agent.state.messages.push(cloneMessage(message));
			}
			return;
		}
		for (const message of current.slice(persisted.length)) {
			await this.storage.appendEntry({ type: "message", id: randomUUID(), message }, "main");
		}
	}

	private handleEvent(event: AgentSessionEvent): void {
		if (this.disposed) return;
		switch (event.type) {
			case "message_start":
				this.handleMessageStart(event.message);
				break;
			case "message_update":
				this.handleMessageUpdate(event);
				break;
			case "message_end":
				this.handleMessageEnd(event.message);
				break;
			case "tool_execution_start": {
				const item = runningToolItem(randomUUID(), event.toolCallId, event.toolName, event.args, Date.now());
				this.runningTools.set(event.toolCallId, item);
				this.emit({ type: "progress", progress: { type: "item_started", item } });
				break;
			}
			case "tool_execution_update": {
				const current = this.runningTools.get(event.toolCallId);
				if (current) {
					const updated: ToolTranscriptItem = {
						...current,
						content: toolResultContent(event.partialResult),
						status: "running",
						isError: false,
					};
					this.runningTools.set(event.toolCallId, updated);
					this.emit({ type: "progress", progress: { type: "item_updated", item: updated } });
				}
				break;
			}
			case "tool_execution_end": {
				const current =
					this.runningTools.get(event.toolCallId) ??
					runningToolItem(randomUUID(), event.toolCallId, event.toolName, {}, Date.now());
				const finished: ToolTranscriptItem = event.isError
					? {
							...current,
							content: toolResultContent(event.result),
							status: "error",
							isError: true,
						}
					: {
							...current,
							content: toolResultContent(event.result),
							status: "complete",
							isError: false,
						};
				this.runningTools.set(event.toolCallId, finished);
				this.emit({ type: "progress", progress: { type: "item_finished", item: finished } });
				break;
			}
			case "queue_update":
				this.queuedSteer = event.steering.map((text, index) => {
					const previous = this.queuedSteer[index];
					return previous?.content[0]?.type === "text" && previous.content[0].text === text
						? previous
						: {
								id: randomUUID(),
								role: "user",
								content: [{ type: "text", text }],
								timestamp: Date.now(),
							};
				});
				break;
		}
		this.changed();
	}

	private handleMessageStart(message: AgentMessage): void {
		if (!isStandardMessage(message)) return;
		const running = message.role === "toolResult" ? this.runningTools.get(message.toolCallId) : undefined;
		this.pendingMessage = { id: running?.id ?? randomUUID(), message };
		if (message.role === "user") {
			this.emit({
				type: "progress",
				progress: {
					type: "item_started",
					item: {
						id: this.pendingMessage.id,
						role: "user",
						content: userContent(message),
						timestamp: normalizeTimestamp(message.timestamp, Date.now()),
					},
				},
			});
		} else if (message.role === "assistant") {
			this.emit({
				type: "progress",
				progress: { type: "item_started", item: assistantItem(this.pendingMessage.id, message, true) },
			});
		}
	}

	private handleMessageUpdate(event: Extract<AgentSessionEvent, { type: "message_update" }>): void {
		if (event.message.role !== "assistant") return;
		const id = this.pendingMessage?.id ?? randomUUID();
		this.pendingMessage = { id, message: event.message };
		const update = event.assistantMessageEvent;
		if (update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta") {
			this.emit({
				type: "progress",
				progress: {
					type: "assistant_delta",
					messageId: id,
					contentIndex: update.contentIndex,
					kind: update.type === "text_delta" ? "text" : update.type === "thinking_delta" ? "thinking" : "toolCall",
					delta: update.delta,
				},
			});
			return;
		}
		this.emit({
			type: "progress",
			progress: { type: "item_updated", item: assistantItem(id, event.message, true) },
		});
	}

	private handleMessageEnd(message: AgentMessage): void {
		if (!isStandardMessage(message)) {
			this.pendingMessage = undefined;
			return;
		}
		const running = message.role === "toolResult" ? this.runningTools.get(message.toolCallId) : undefined;
		const id = this.pendingMessage?.id ?? running?.id ?? randomUUID();
		const persisted = cloneMessage(message);
		this.queueWrite(async () => {
			await this.storage.appendEntry({ type: "message", id, message: persisted }, "main");
		});
		if (message.role === "assistant") {
			const item = assistantItem(id, message);
			if (item.status !== "streaming") {
				this.emit({ type: "progress", progress: { type: "item_finished", item } });
			}
		} else if (message.role === "toolResult" && !running) {
			const item = toolItem(id, message, new Map());
			this.emit({ type: "progress", progress: { type: "item_finished", item } });
		}
		if (message.role === "toolResult") this.runningTools.delete(message.toolCallId);
		this.pendingMessage = undefined;
	}
}

export class SecHeurProtocolService implements PiServerService, AsyncDisposable {
	readonly config: SecHeurConfig;
	readonly databasePath: string;
	readonly modelRuntime: ModelRuntime;

	private readonly options: CreateSecHeurProtocolServiceOptions;
	private readonly telemetryContext: TelemetryContext;
	private readonly executionEnv: NodeExecutionEnv;
	private readonly catalogRepository: SqliteSessionRepository;
	private readonly runtimes = new Set<SecHeurProtocolRuntime>();
	private readonly acquiring = new Set<string>();
	private readonly acquisitionBarriers = new Set<Promise<void>>();
	private closing = false;
	private closePromise?: Promise<void>;

	private constructor(
		options: CreateSecHeurProtocolServiceOptions,
		config: SecHeurConfig,
		databasePath: string,
		modelRuntime: ModelRuntime,
	) {
		this.options = options;
		this.config = config;
		this.databasePath = databasePath;
		this.modelRuntime = modelRuntime;
		this.telemetryContext = options.telemetryContext ?? NOOP_TELEMETRY_CONTEXT;
		this.executionEnv = new NodeExecutionEnv({ cwd: config.projectRoot });
		this.catalogRepository = this.createRepository();
	}

	static async create(options: CreateSecHeurProtocolServiceOptions = {}): Promise<SecHeurProtocolService> {
		const config = loadSecHeurConfig(options);
		const databasePath = resolve(
			config.projectRoot,
			options.databasePath ?? join(config.stateDir, "protocol-sessions.sqlite"),
		);
		const modelRuntime =
			options.modelRuntime ??
			(await ModelRuntime.create({
				authPath: join(config.agentDir, "auth.json"),
				modelsPath: join(config.agentDir, "models.json"),
			}));
		const service = new SecHeurProtocolService(options, config, databasePath, modelRuntime);
		try {
			await service.catalogRepository.list();
			return service;
		} catch (error) {
			await service.catalogRepository.close().catch(() => {});
			throw error;
		}
	}

	async listSessions(): Promise<SessionMetadata[]> {
		this.assertOpen();
		return (await this.catalogRepository.list()).map((metadata) => ({
			id: metadata.id,
			createdAt: metadata.createdAt,
			...(metadata.parentSessionId === undefined ? {} : { parentSessionId: metadata.parentSessionId }),
			...(metadata.name === undefined ? {} : { sessionName: metadata.name }),
			cwd: metadata.cwd,
		}));
	}

	async listModels(): Promise<ModelMetadata[]> {
		this.assertOpen();
		return this.modelRuntime.getModels().map((model) => modelMetadata(model, this.modelRuntime));
	}

	async createSession(options: CreateSessionOptions): Promise<PiSessionRuntime> {
		this.assertOpen();
		if (this.acquiring.has(options.id)) throw new SessionLockedError(`Session is locked: ${options.id}`);
		const requestedModel = options.model
			? this.modelRuntime.getModel(options.model.provider, options.model.id)
			: undefined;
		if (options.model && !requestedModel) {
			throw new PiServerError("invalid_request", `Unknown model: ${options.model.provider}/${options.model.id}`);
		}
		if (requestedModel && !this.modelRuntime.hasConfiguredAuth(requestedModel.provider)) {
			throw new PiServerError(
				"invalid_request",
				`No authentication is configured for ${requestedModel.provider}/${requestedModel.id}`,
			);
		}
		if (requestedModel && options.thinkingLevel) {
			if (!getSupportedThinkingLevels(requestedModel).includes(options.thinkingLevel)) {
				throw new PiServerError(
					"invalid_request",
					`Thinking level ${options.thinkingLevel} is not supported by ${requestedModel.provider}/${requestedModel.id}`,
				);
			}
		}

		const releaseAcquisition = this.beginAcquisition(options.id);
		let repository: SqliteSessionRepository | undefined;
		let metadata: SqliteSessionMetadata | undefined;
		let runtime: SecHeurRuntime | undefined;
		try {
			repository = this.createRepository();
			const cwd = resolve(this.config.projectRoot, options.cwd ?? this.config.projectRoot);
			const storage = await repository.create({ cwd, id: options.id });
			metadata = await storage.getMetadata();
			if (options.name !== undefined) await storage.setName(options.name);
			runtime = await this.createRuntime({
				cwd,
				sessionId: options.id,
				model: requestedModel,
				thinkingLevel: options.thinkingLevel,
			});
			if (!runtime.session.model) throw new PiServerError("invalid_request", "No authenticated model is configured");
			const protocolRuntime = await SecHeurProtocolRuntime.create({
				runtime,
				repository,
				session: storage,
				metadata,
				persistInitialState: true,
				onDispose: () => {
					this.runtimes.delete(protocolRuntime);
				},
			});
			this.runtimes.add(protocolRuntime);
			return protocolRuntime;
		} catch (error) {
			runtime?.dispose();
			await repository?.close().catch(() => {});
			if (metadata) await this.catalogRepository.delete(metadata).catch(() => {});
			throw mapRepositoryError(error, options.id);
		} finally {
			releaseAcquisition();
		}
	}

	async openSession(sessionId: string): Promise<PiSessionRuntime> {
		const releaseAcquisition = this.beginAcquisition(sessionId);
		let repository: SqliteSessionRepository | undefined;
		let runtime: SecHeurRuntime | undefined;
		try {
			repository = this.createRepository();
			const metadata = (await this.catalogRepository.list()).find((candidate) => candidate.id === sessionId);
			if (!metadata) throw new SessionNotFoundError(`Unknown session: ${sessionId}`);
			const storage = await repository.open(metadata);
			const storedState = await latestStoredState(storage);
			const sessionManager = await this.sessionManagerFor(metadata);
			const storedModel = storedState
				? this.modelRuntime.getModel(storedState.model.provider, storedState.model.id)
				: undefined;
			const model =
				storedModel && this.modelRuntime.hasConfiguredAuth(storedModel.provider) ? storedModel : undefined;
			runtime = await this.createRuntime({
				cwd: metadata.cwd,
				sessionId,
				sessionManager,
				model,
				thinkingLevel: storedState?.thinkingLevel,
			});
			if (!runtime.session.model) throw new PiServerError("invalid_request", "No authenticated model is configured");
			const protocolRuntime = await SecHeurProtocolRuntime.create({
				runtime,
				repository,
				session: storage,
				metadata,
				storedState,
				persistInitialState: storedState === undefined,
				onDispose: () => {
					this.runtimes.delete(protocolRuntime);
				},
			});
			this.runtimes.add(protocolRuntime);
			return protocolRuntime;
		} catch (error) {
			runtime?.dispose();
			await repository?.close().catch(() => {});
			throw mapRepositoryError(error, sessionId);
		} finally {
			releaseAcquisition();
		}
	}

	close(): Promise<void> {
		this.closePromise ??= this.closeInternal();
		return this.closePromise;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}

	private async closeInternal(): Promise<void> {
		this.closing = true;
		await Promise.allSettled([...this.acquisitionBarriers]);
		await Promise.allSettled([...this.runtimes].map((runtime) => runtime.dispose()));
		this.runtimes.clear();
		await this.catalogRepository.close();
	}

	private assertOpen(): void {
		if (this.closing) throw new PiServerError("session_locked", "SecHeur protocol service is closed");
	}

	private beginAcquisition(sessionId: string): () => void {
		this.assertOpen();
		if (this.acquiring.has(sessionId)) throw new SessionLockedError(`Session is locked: ${sessionId}`);
		this.acquiring.add(sessionId);
		let resolveBarrier = () => {};
		const barrier = new Promise<void>((resolvePromise) => {
			resolveBarrier = resolvePromise;
		});
		this.acquisitionBarriers.add(barrier);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.acquiring.delete(sessionId);
			this.acquisitionBarriers.delete(barrier);
			resolveBarrier();
		};
	}

	private createRepository(): SqliteSessionRepository {
		return new SqliteSessionRepository({
			env: this.executionEnv,
			sqlite: createNodeSqliteFactory(),
			databasePath: this.databasePath,
		});
	}

	private async createRuntime(
		options: Pick<CreateSecHeurRuntimeOptions, "cwd" | "sessionId" | "sessionManager" | "model" | "thinkingLevel">,
	): Promise<SecHeurRuntime> {
		return createSecHeurRuntime({
			projectRoot: this.config.projectRoot,
			stateDir: this.config.stateDir,
			legacyRoot: this.config.legacyRoot,
			env: this.options.env,
			permissionMode: this.options.permissionMode,
			modelRuntime: this.modelRuntime,
			telemetryContext: this.telemetryContext,
			mode: "rpc",
			executionMode: this.config.executionMode.mode,
			executionCapacity: this.config.executionMode.capacity,
			...options,
		});
	}

	private async sessionManagerFor(metadata: SqliteSessionMetadata): Promise<SessionManager> {
		const config = { ...this.config, projectRoot: metadata.cwd };
		const directory = secHeurSessionDirectory(config, metadata.cwd);
		const existing = (await SessionManager.list(metadata.cwd, directory)).find(
			(session) => session.id === metadata.id,
		);
		return existing
			? SessionManager.open(existing.path, directory, metadata.cwd)
			: SessionManager.create(metadata.cwd, directory, { id: metadata.id });
	}
}
