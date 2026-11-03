import { randomUUID } from "node:crypto";
import type { CompetitionBrokerStatus, CompetitionSyncResult } from "./competition-broker.ts";
import {
	COMPETITION_PROTOCOL,
	COMPETITION_PROTOCOL_VERSION,
	type CompetitionEvent,
	type CompetitionEventPayload,
	type CompetitionEventType,
	type CompetitionPlan,
	type CompetitionTaskEnvelope,
	parseCompetitionTaskEnvelope,
} from "./competition-protocol.ts";
import { CompetitionBrokerClient } from "./competition-protocol-service.ts";
import type { CompetitionAdapterConfigPatch } from "./competition-runtime.ts";
import type { CompetitionTaskRecord } from "./competition-store.ts";

export interface CompetitionSolverBindingOptions {
	socketPath: string;
	taskId: string;
	solverId: string;
	requestTimeoutMs?: number;
}

export interface CompetitionCoordinatorBindingOptions {
	socketPath: string;
	clientId: string;
	requestTimeoutMs?: number;
}

export interface CompetitionTaskSummary {
	taskId: string;
	exerciseId: string | number;
	shortTask: string;
	name: string;
	category: string;
	description: string;
	status: CompetitionTaskRecord["status"];
	priority: number;
	score: number;
	requiresEnvironment: boolean;
	environmentStatus: CompetitionTaskRecord["challenge"]["environment"]["status"];
	attachmentCount: number;
	attachmentNames: string[];
	actualAttempts: number;
	maxAttempts: number;
	plan?: CompetitionTaskRecord["plan"];
	lastError?: string;
}

export interface CompetitionEventSummary {
	eventId: string;
	taskId: string;
	solverId: string;
	type: CompetitionEvent["type"];
	occurredAt: number;
	kind?: string;
	status?: string;
	summary?: string;
	reason?: string;
	category?: string;
	confidence?: number;
	evidenceRefs?: string[];
	basis?: string[];
	refs?: string[];
}

function preview(value: string, limit: number): string {
	const normalized = value.trim();
	return normalized.length > limit ? `${normalized.slice(0, limit)}...[truncated]` : normalized;
}

export function summarizeCompetitionTask(task: CompetitionTaskRecord): CompetitionTaskSummary {
	return {
		taskId: task.taskId,
		exerciseId: task.challenge.exerciseId,
		shortTask: preview(task.shortTask, 120),
		name: task.challenge.name,
		category: task.challenge.category,
		description: preview(task.challenge.description, 180),
		status: task.status,
		priority: task.priority,
		score: task.challenge.scoring.challengeValue,
		requiresEnvironment: task.challenge.environment.required,
		environmentStatus: task.challenge.environment.status,
		attachmentCount: task.challenge.attachments.length,
		attachmentNames: task.challenge.attachments.map((attachment) => attachment.name),
		actualAttempts: task.actualAttempts,
		maxAttempts: task.attemptBudget ?? task.submission.maxAttempts,
		...(task.plan ? { plan: task.plan } : {}),
		...(task.lastError ? { lastError: preview(task.lastError, 200) } : {}),
	};
}

function stringList(value: unknown, limit: number): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const values = value
		.filter((item): item is string => typeof item === "string")
		.slice(0, limit)
		.map((item) => preview(item, 120));
	return values.length > 0 ? values : undefined;
}

export function summarizeCompetitionEvent(event: CompetitionEvent): CompetitionEventSummary {
	const payload: Record<string, unknown> = isRecord(event.payload) ? event.payload : {};
	const evidenceRefs = stringList(payload.evidenceRefs, 8);
	const basis = stringList(payload.basis, 8);
	const refs = stringList(payload.refs, 8);
	return {
		eventId: event.eventId,
		taskId: event.taskId,
		solverId: event.solverId,
		type: event.type,
		occurredAt: event.occurredAt,
		...(typeof payload.kind === "string" ? { kind: preview(payload.kind, 80) } : {}),
		...(typeof payload.status === "string" ? { status: preview(payload.status, 80) } : {}),
		...(typeof payload.summary === "string" ? { summary: preview(payload.summary, 240) } : {}),
		...(typeof payload.reason === "string" ? { reason: preview(payload.reason, 240) } : {}),
		...(typeof payload.category === "string" ? { category: preview(payload.category, 80) } : {}),
		...(typeof payload.confidence === "number" ? { confidence: payload.confidence } : {}),
		...(evidenceRefs ? { evidenceRefs } : {}),
		...(basis ? { basis } : {}),
		...(refs ? { refs } : {}),
	};
}

export class CompetitionCoordinatorBinding {
	private readonly client: CompetitionBrokerClient;

	constructor(options: CompetitionCoordinatorBindingOptions) {
		this.client = new CompetitionBrokerClient({
			socketPath: options.socketPath,
			clientId: `coordinator:${options.clientId}`,
			...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
		});
	}

	async status(): Promise<CompetitionBrokerStatus> {
		return (await this.client.request("status")) as CompetitionBrokerStatus;
	}

	async sync(): Promise<CompetitionSyncResult> {
		return (await this.client.request("sync")) as CompetitionSyncResult;
	}

	async configureAdapter(input: CompetitionAdapterConfigPatch): Promise<Record<string, unknown>> {
		return (await this.client.request("configure_adapter", input as Record<string, unknown>)) as Record<
			string,
			unknown
		>;
	}

	async listTasks(): Promise<CompetitionTaskRecord[]> {
		return (await this.client.request("list_tasks")) as CompetitionTaskRecord[];
	}

	async listEvents(taskId?: string, limit = 200): Promise<CompetitionEvent[]> {
		const result = await this.client.request("list_events", {
			...(taskId ? { taskId } : {}),
			limit: Math.max(1, Math.min(500, Math.trunc(limit))),
		});
		return Array.isArray(result) ? (result as CompetitionEvent[]) : [];
	}

	async getPlan(): Promise<{ plan?: CompetitionPlan; tasks: CompetitionTaskRecord[] }> {
		const result = await this.client.request("get_plan");
		if (!isRecord(result) || !Array.isArray(result.tasks))
			throw new Error("Competition broker returned an invalid plan");
		return {
			tasks: result.tasks as CompetitionTaskRecord[],
			...(isRecord(result.plan) ? { plan: result.plan as unknown as CompetitionPlan } : {}),
		};
	}

	async setPlan(input: {
		taskIds: string[];
		rationale: string;
		generatedBy?: string;
		expectedRevision?: number;
	}): Promise<{ plan: CompetitionPlan; tasks: CompetitionTaskRecord[] }> {
		const result = await this.client.request("set_plan", {
			taskIds: input.taskIds,
			rationale: input.rationale,
			...(input.generatedBy ? { generatedBy: input.generatedBy } : {}),
			...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
		});
		if (!isRecord(result) || !isRecord(result.plan) || !Array.isArray(result.tasks))
			throw new Error("Competition broker returned an invalid plan result");
		return { plan: result.plan as unknown as CompetitionPlan, tasks: result.tasks as CompetitionTaskRecord[] };
	}

	async clearPlan(): Promise<{ cleared: true; tasks: CompetitionTaskRecord[] }> {
		const result = await this.client.request("clear_plan");
		if (!isRecord(result) || result.cleared !== true || !Array.isArray(result.tasks))
			throw new Error("Competition broker returned an invalid clear-plan result");
		return { cleared: true, tasks: result.tasks as CompetitionTaskRecord[] };
	}

	async setAttemptBudgets(
		budgets: Array<{ taskId: string; budget: number }>,
	): Promise<{ tasks: CompetitionTaskRecord[] }> {
		const result = await this.client.request("set_attempt_budgets", { budgets });
		if (!isRecord(result) || !Array.isArray(result.tasks))
			throw new Error("Competition broker returned invalid budgets");
		return { tasks: result.tasks as CompetitionTaskRecord[] };
	}

	async requeueTasks(
		taskIds: string[],
		reason?: string,
	): Promise<{ tasks: CompetitionTaskRecord[]; previousStatuses: Record<string, string>; reason: string }> {
		const result = await this.client.request("requeue_tasks", {
			taskIds,
			...(reason?.trim() ? { reason: reason.trim() } : {}),
		});
		if (!isRecord(result) || !Array.isArray(result.tasks) || !isRecord(result.previousStatuses))
			throw new Error("Competition broker returned invalid requeue result");
		return {
			tasks: result.tasks as CompetitionTaskRecord[],
			reason: typeof result.reason === "string" ? result.reason : "Requeued by Main Agent",
			previousStatuses: Object.fromEntries(
				Object.entries(result.previousStatuses).filter(
					(entry): entry is [string, string] => typeof entry[1] === "string",
				),
			),
		};
	}

	async stopTask(taskId: string, reason: string): Promise<Record<string, unknown>> {
		const result = await this.client.request("stop_task", { taskId, reason });
		return isRecord(result) ? result : { result };
	}

	close(): void {
		this.client.close();
	}
}

export class CompetitionSolverBinding {
	readonly taskId: string;
	readonly solverId: string;
	private readonly client: CompetitionBrokerClient;
	private envelope?: CompetitionTaskEnvelope;
	private heartbeatTimer?: ReturnType<typeof setInterval>;
	private closed = false;
	private acceptedSubmission?: { recordId: string; taskId: string; assignmentId: string };
	private attemptsRemaining?: number;

	constructor(options: CompetitionSolverBindingOptions) {
		this.taskId = options.taskId;
		this.solverId = options.solverId;
		this.client = new CompetitionBrokerClient({
			socketPath: options.socketPath,
			clientId: `solver:${options.solverId}`,
			...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
		});
	}

	get task(): CompetitionTaskEnvelope | undefined {
		return this.envelope;
	}

	/** Set only from a broker-confirmed submission for this immutable assignment. */
	get verifiedSubmission(): Readonly<{ recordId: string; taskId: string; assignmentId: string }> | undefined {
		return this.acceptedSubmission;
	}

	get remainingAttempts(): number | undefined {
		return this.attemptsRemaining;
	}

	async claim(): Promise<CompetitionTaskEnvelope> {
		if (this.closed) throw new Error("Competition solver binding is closed");
		if (this.envelope) return this.envelope;
		const event: CompetitionEvent = {
			protocol: COMPETITION_PROTOCOL,
			version: COMPETITION_PROTOCOL_VERSION,
			eventId: randomUUID(),
			taskId: this.taskId,
			assignmentId: "pending",
			solverId: this.solverId,
			type: "claim",
			occurredAt: Date.now(),
			payload: { taskId: this.taskId },
		};
		const result = await this.client.request("event", { event });
		if (!isRecord(result) || !isRecord(result.task)) throw new Error("Competition broker returned no task envelope");
		const envelope = parseCompetitionTaskEnvelope(result.task);
		this.envelope = envelope;
		this.startHeartbeat();
		return envelope;
	}

	async heartbeat(): Promise<Record<string, unknown>> {
		const envelope = this.requireEnvelope();
		const result = await this.sendEvent("heartbeat", {
			leaseId: envelope.lease.leaseId,
			leaseTtlMs: Math.max(5_000, envelope.lease.expiresAt - envelope.lease.assignedAt),
		});
		if (result.accepted !== true) throw new Error("Competition task heartbeat was rejected");
		return result;
	}

	async sendEvent(type: CompetitionEventType, payload: CompetitionEventPayload): Promise<Record<string, unknown>> {
		const envelope = this.requireEnvelope();
		const event: CompetitionEvent = {
			protocol: COMPETITION_PROTOCOL,
			version: COMPETITION_PROTOCOL_VERSION,
			eventId: randomUUID(),
			taskId: envelope.taskId,
			assignmentId: envelope.assignmentId,
			solverId: this.solverId,
			type,
			occurredAt: Date.now(),
			payload,
		};
		const result = await this.client.request("event", { event });
		if (
			type === "submit_request" &&
			isRecord(result) &&
			typeof result.remainingAttempts === "number" &&
			Number.isSafeInteger(result.remainingAttempts) &&
			result.remainingAttempts >= 0
		)
			this.attemptsRemaining = result.remainingAttempts;
		if (
			type === "submit_request" &&
			isRecord(result) &&
			result.accepted === true &&
			isRecord(result.submission) &&
			result.submission.category === "accepted" &&
			result.submission.isCorrect === true &&
			result.submission.taskId === envelope.taskId &&
			result.submission.assignmentId === envelope.assignmentId &&
			typeof result.submission.recordId === "string" &&
			result.submission.recordId.length > 0
		) {
			this.acceptedSubmission = {
				recordId: result.submission.recordId,
				taskId: envelope.taskId,
				assignmentId: envelope.assignmentId,
			};
			if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
		return isRecord(result) ? result : { result };
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
		this.client.close();
	}

	private requireEnvelope(): CompetitionTaskEnvelope {
		if (this.closed) throw new Error("Competition solver binding is closed");
		if (!this.envelope) throw new Error("Competition task has not been claimed");
		return this.envelope;
	}

	private startHeartbeat(): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		const expiresIn = Math.max(5_000, this.envelope!.lease.expiresAt - Date.now());
		const interval = Math.max(1_000, Math.trunc(expiresIn / 3));
		this.heartbeatTimer = setInterval(() => {
			void this.heartbeat().catch(() => undefined);
		}, interval);
		this.heartbeatTimer.unref();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
