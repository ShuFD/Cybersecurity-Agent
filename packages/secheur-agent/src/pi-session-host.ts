import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type {
	JsonValue,
	ModelMetadata,
	ModelRef,
	SessionMetadata,
	SessionPhase,
	SessionSnapshot,
	ThinkingLevel,
	TranscriptItem,
	UserTranscriptItem,
} from "@earendil-works/pi-protocol";
import type {
	CreateSessionOptions,
	PiServerService,
	PiSessionRuntime,
	PiSessionRuntimeEvent,
	PromptInput,
	SteerInput,
} from "@earendil-works/pi-server";
import {
	toProtocolAssistantMessage,
	toProtocolModelMetadata,
	toProtocolToolResultMessage,
	toProtocolUserMessage,
} from "@earendil-works/pi-server";
import { createUnixServer } from "@earendil-works/pi-server/unix";
import { loadSecHeurConfig } from "./config.ts";
import type { PermissionController } from "./permissions.ts";
import {
	type PiSessionRegistration,
	removeSessionRegistration,
	sessionSocketPath,
	writeSessionRegistrationAt,
} from "./session-registry.ts";

export interface PiSessionHostOptions {
	stateDir: string;
	role: PiSessionRegistration["role"];
	title: string;
	knowledgeBaseEnabled?: boolean | (() => boolean);
	env?: NodeJS.ProcessEnv;
	taskId?: string;
	category?: string;
	parentMainSessionId?: string;
	tmuxTarget?: string;
	mainSessionId?: string;
	permissionController?: PermissionController;
}

function millisFromTimestamp(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function asJsonValue(value: unknown): JsonValue {
	try {
		const encoded = JSON.stringify(value);
		return encoded === undefined ? {} : (JSON.parse(encoded) as JsonValue);
	} catch {
		return {};
	}
}

function transcriptId(entryId: string): string {
	return entryId.length > 0 ? entryId : "entry";
}

function isUserMessage(message: AgentMessage): message is UserMessage {
	return message.role === "user";
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant";
}

function isToolResultMessage(message: AgentMessage): message is ToolResultMessage<unknown> {
	return message.role === "toolResult";
}

function findToolCall(session: AgentSession, toolCallId: string): ToolCall {
	for (const entry of session.sessionManager.getBranch()) {
		if (entry.type !== "message" || !isAssistantMessage(entry.message)) continue;
		for (const content of entry.message.content) {
			if (content.type === "toolCall" && content.id === toolCallId) return content;
		}
	}
	return { type: "toolCall", id: toolCallId, name: "unknown", arguments: {} };
}

function toTranscriptItem(session: AgentSession, entryId: string, message: AgentMessage): TranscriptItem | undefined {
	try {
		if (isUserMessage(message)) return toProtocolUserMessage(message, { id: transcriptId(entryId) });
		if (isAssistantMessage(message)) return toProtocolAssistantMessage(message, { id: transcriptId(entryId) });
		if (isToolResultMessage(message)) {
			return toProtocolToolResultMessage(message, {
				id: transcriptId(entryId),
				call: findToolCall(session, message.toolCallId),
			});
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function toQueuedSteerItem(id: string, text: string, timestamp: number): UserTranscriptItem {
	return {
		id,
		role: "user",
		content: [{ type: "text", text }],
		timestamp,
	};
}

class LocalPiSessionRuntime implements PiSessionRuntime {
	private readonly host: PiSessionHost;
	private readonly listeners = new Set<(event: PiSessionRuntimeEvent) => void>();
	private unsubscribeSession: (() => void) | undefined;
	private session: AgentSession;
	private revision = 0;
	private queuedSteer: string[] = [];
	private commandActive = false;

	constructor(host: PiSessionHost, session: AgentSession) {
		this.host = host;
		this.session = session;
		this.subscribeToSession(session);
	}

	bindSession(session: AgentSession): void {
		this.unsubscribeSession?.();
		this.session = session;
		this.queuedSteer = [];
		this.subscribeToSession(session);
		this.emitSnapshot();
	}

	private subscribeToSession(session: AgentSession): void {
		this.unsubscribeSession = session.subscribe((event) => this.handleEvent(event));
	}

	private handleEvent(event: AgentSessionEvent): void {
		if (event.type === "queue_update") this.queuedSteer = [...event.steering];
		this.host.updateStatus(this.getPhase() === "idle" ? "idle" : "running");
		this.emitSnapshot();
	}

	private emitSnapshot(): void {
		this.revision += 1;
		for (const listener of this.listeners) listener({ type: "snapshot" });
	}

	notifySnapshot(): void {
		this.emitSnapshot();
	}

	async snapshot(): Promise<SessionSnapshot> {
		return this.host.snapshot(this.session, this.revision, this.queuedSteer);
	}

	getPhase(): SessionPhase {
		if (this.session.isCompacting) return "compaction";
		if (this.session.retryAttempt > 0) return "retry";
		return this.commandActive || !this.session.isIdle ? "turn" : "idle";
	}

	async prompt(input: PromptInput): Promise<void> {
		this.commandActive = true;
		this.host.updateStatus("running");
		this.emitSnapshot();
		try {
			await this.session.prompt(input.text);
			while (this.queuedSteer.length > 0) {
				const next = this.queuedSteer.shift();
				if (next) await this.session.prompt(next);
			}
		} finally {
			this.commandActive = false;
			this.host.updateStatus(this.session.isIdle ? "idle" : "running");
			this.emitSnapshot();
		}
	}

	async steer(input: SteerInput): Promise<void> {
		if (this.commandActive && this.session.isIdle) {
			this.queuedSteer.push(input.text);
			this.emitSnapshot();
			return;
		}
		await this.session.steer(input.text);
	}

	async abort(): Promise<void> {
		await this.session.abort();
	}

	async setModel(ref: ModelRef): Promise<void> {
		const model = this.host.runtime.services.modelRuntime.getModel(ref.provider, ref.id);
		if (!model) throw new Error(`Model is unavailable: ${ref.provider}/${ref.id}`);
		await this.session.setModel(model);
	}

	async setThinking(thinkingLevel: ThinkingLevel): Promise<void> {
		this.session.setThinkingLevel(thinkingLevel);
	}

	async resolvePermission(input: {
		requestId: string;
		decision: "allow_once" | "allow_session" | "deny" | "answer";
		answer?: string;
	}): Promise<void> {
		await this.host.resolvePermission(input);
		this.emitSnapshot();
	}

	subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async dispose(): Promise<void> {
		this.unsubscribeSession?.();
		this.unsubscribeSession = undefined;
		this.listeners.clear();
		this.host.removeRuntime(this);
	}
}

class LocalPiSessionService implements PiServerService {
	private readonly host: PiSessionHost;

	constructor(host: PiSessionHost) {
		this.host = host;
	}

	async listSessions(): Promise<SessionMetadata[]> {
		const snapshot = await this.host.snapshot(this.host.runtime.session, 0, []);
		return [
			{
				id: snapshot.id,
				createdAt: snapshot.createdAt,
				updatedAt: snapshot.updatedAt,
				sessionName: snapshot.name,
				cwd: snapshot.cwd,
			},
		];
	}

	async listModels(): Promise<ModelMetadata[]> {
		const models = this.host.runtime.services.modelRuntime.getAvailableSnapshot();
		const metadata: ModelMetadata[] = [];
		for (const model of models) {
			const authenticated = (await this.host.runtime.services.modelRuntime.checkAuth(model.provider)) !== undefined;
			metadata.push(toProtocolModelMetadata(model, authenticated));
		}
		return metadata;
	}

	async createSession(_options: CreateSessionOptions): Promise<PiSessionRuntime> {
		throw new Error("A local Pi host does not create sessions; attach to the Main or solver TUI");
	}

	async openSession(sessionId: string): Promise<PiSessionRuntime> {
		if (sessionId !== this.host.sessionId) throw new Error(`Unknown local Pi session: ${sessionId}`);
		return this.host.createRuntime();
	}
}

export class PiSessionHost {
	readonly runtime: AgentSessionRuntime;
	readonly sessionId: string;
	readonly socketPath: string;
	private readonly options: PiSessionHostOptions;
	private readonly service: LocalPiSessionService;
	private readonly server;
	private readonly adapters = new Set<LocalPiSessionRuntime>();
	private readonly createdAt = Date.now();
	private unregisterSessionChange: (() => void) | undefined;
	private registrationStatus: PiSessionRegistration["status"] = "starting";
	private registrationWriteTail: Promise<void> = Promise.resolve();
	private started = false;
	private unsubscribePermission: (() => void) | undefined;

	constructor(runtime: AgentSessionRuntime, options: PiSessionHostOptions) {
		this.runtime = runtime;
		this.options = options;
		this.sessionId = runtime.session.sessionId;
		this.socketPath = sessionSocketPath(options.stateDir, this.sessionId);
		this.service = new LocalPiSessionService(this);
		this.server = createUnixServer(this.service, { path: this.socketPath, mode: 0o660 });
		this.unsubscribePermission = options.permissionController?.broker.subscribe(() => {
			for (const adapter of this.adapters) adapter.notifySnapshot();
		});
		this.unregisterSessionChange = runtime.subscribeSessionChanges((session) => {
			for (const adapter of this.adapters) adapter.bindSession(session);
			this.registrationStatus = "idle";
			this.refreshRegistration();
		});
	}

	async start(): Promise<void> {
		if (this.started) return;
		const socketDirectory = dirname(this.socketPath);
		await mkdir(socketDirectory, { recursive: true, mode: 0o2770 });
		await this.server.start();
		this.started = true;
		this.registrationStatus = "idle";
		await this.writeRegistration("idle");
	}

	updateStatus(status: PiSessionRegistration["status"]): void {
		if (!this.started || status === this.registrationStatus) return;
		this.registrationStatus = status;
		this.refreshRegistration();
	}

	private refreshRegistration(): void {
		if (!this.started) return;
		const status = this.registrationStatus;
		this.registrationWriteTail = this.registrationWriteTail
			.then(() => this.writeRegistration(status))
			.catch(() => undefined);
	}

	private knowledgeBaseEnabled(): boolean {
		const setting = this.options.knowledgeBaseEnabled;
		if (typeof setting === "function") return setting();
		if (typeof setting === "boolean") return setting;
		return loadSecHeurConfig({
			projectRoot: this.runtime.cwd,
			stateDir: this.options.stateDir,
			env: this.options.env,
		}).knowledgeBaseEnabled;
	}

	private async writeRegistration(status: PiSessionRegistration["status"]): Promise<void> {
		const now = Date.now();
		const tools = this.runtime.session.getAllTools().map((tool) => tool.name);
		const activeTools = this.runtime.session.getActiveToolNames();
		const registration: PiSessionRegistration = {
			sessionId: this.sessionId,
			role: this.options.role,
			title: this.options.title,
			socketPath: this.socketPath,
			pid: process.pid,
			cwd: this.runtime.cwd,
			createdAt: this.createdAt,
			updatedAt: now,
			status,
			...(this.options.taskId ? { taskId: this.options.taskId } : {}),
			...(this.options.category ? { category: this.options.category } : {}),
			...(this.options.parentMainSessionId ? { parentMainSessionId: this.options.parentMainSessionId } : {}),
			...(this.options.tmuxTarget ? { tmuxTarget: this.options.tmuxTarget } : {}),
			...(this.options.mainSessionId ? { mainSessionId: this.options.mainSessionId } : {}),
			tools,
			activeTools,
			knowledgeBaseEnabled: this.knowledgeBaseEnabled(),
		};
		await writeSessionRegistrationAt(this.options.stateDir, registration);
	}

	createRuntime(): LocalPiSessionRuntime {
		this.options.permissionController?.broker.setRemoteUiAvailable(true);
		const adapter = new LocalPiSessionRuntime(this, this.runtime.session);
		this.adapters.add(adapter);
		return adapter;
	}

	removeRuntime(adapter: LocalPiSessionRuntime): void {
		this.adapters.delete(adapter);
		if (this.adapters.size === 0) this.options.permissionController?.broker.setRemoteUiAvailable(false);
	}

	async resolvePermission(input: {
		requestId: string;
		decision: "allow_once" | "allow_session" | "deny" | "answer";
		answer?: string;
	}): Promise<void> {
		const controller = this.options.permissionController;
		if (!controller) throw new Error("Permission broker is unavailable");
		const pending = controller.broker.list().find((request) => request.id === input.requestId);
		if (!pending) throw new Error(`Permission request not found: ${input.requestId}`);
		if (input.decision === "answer" && pending.toolName !== "ask_user" && pending.toolName !== "exit_plan_mode") {
			throw new Error(`Permission request does not accept an answer: ${pending.toolName}`);
		}
		const affirmative = /^(?:approve|approved|allow|ok|y|yes)$/iu.test((input.answer ?? "").trim());
		const allowed =
			input.decision === "allow_once" ||
			input.decision === "allow_session" ||
			(input.decision === "answer" && (pending.toolName !== "exit_plan_mode" || affirmative));
		if (input.decision === "allow_session") controller.allowForSession(pending.toolName, pending.input);
		if (!controller.broker.resolve(input.requestId, allowed, input.answer)) {
			throw new Error(`Permission request not found: ${input.requestId}`);
		}
	}

	async snapshot(session: AgentSession, revision: number, queuedSteer: string[]): Promise<SessionSnapshot> {
		const now = Date.now();
		const header = session.sessionManager.getHeader();
		const createdAt = millisFromTimestamp(header?.timestamp, this.createdAt);
		const branch = session.sessionManager.getBranch();
		const lastEntry = branch.at(-1);
		const updatedAt = millisFromTimestamp(lastEntry?.timestamp, now);
		const available = this.runtime.services.modelRuntime.getAvailableSnapshot();
		const fallback = available[0]
			? { provider: available[0].provider, id: available[0].id }
			: { provider: "unknown", id: "unknown" };
		const transcript: TranscriptItem[] = [];
		for (const entry of branch) {
			if (entry.type !== "message") continue;
			const item = toTranscriptItem(session, entry.id, entry.message);
			if (item) transcript.push(item);
		}
		const model = session.model ? { provider: session.model.provider, id: session.model.id } : fallback;
		return {
			id: this.sessionId,
			name: session.sessionName ?? this.options.title,
			cwd: this.runtime.cwd,
			createdAt,
			updatedAt,
			phase: session.isCompacting
				? "compaction"
				: session.retryAttempt > 0
					? "retry"
					: session.isIdle
						? "idle"
						: "turn",
			model,
			thinkingLevel: session.thinkingLevel as ThinkingLevel,
			attached: false,
			locked: true,
			revision,
			transcript,
			queuedSteer: queuedSteer.map((text, index) =>
				toQueuedSteerItem(`${this.sessionId}-steer-${index}`, text, now),
			),
			queuedSteerCount: queuedSteer.length,
			permissionRequests:
				this.options.permissionController?.broker.list().map((request) => ({
					requestId: request.id,
					toolName: request.toolName,
					message: request.message,
					args: asJsonValue(request.input),
					status: "pending" as const,
					createdAt: request.createdAt,
					choices: Array.isArray(request.input.candidates)
						? request.input.candidates.filter((choice): choice is string => typeof choice === "string")
						: [],
				})) ?? [],
		};
	}

	async close(): Promise<void> {
		this.unregisterSessionChange?.();
		this.unregisterSessionChange = undefined;
		this.unsubscribePermission?.();
		this.unsubscribePermission = undefined;
		for (const adapter of [...this.adapters]) await adapter.dispose();
		await this.server.close();
		await this.registrationWriteTail;
		await removeSessionRegistration(this.options.stateDir, this.sessionId);
		this.started = false;
	}
}
