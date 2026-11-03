import { randomUUID } from "node:crypto";
import {
	type CompetitionChallenge,
	type CompetitionPlatformAdapter,
	CompetitionPlatformError,
	validateSubmissionFlag,
} from "./competition-adapters.ts";
import { CompetitionAuditObserver, type CompetitionAuditResult } from "./competition-audit.ts";
import {
	type ChallengeSnapshot,
	COMPETITION_PROTOCOL,
	COMPETITION_PROTOCOL_VERSION,
	type CompetitionCommandRequest,
	type CompetitionEvent,
	type CompetitionEventPayload,
	type CompetitionPlan,
	type CompetitionRpcRequest,
	type CompetitionRpcResponse,
	type CompetitionTaskEnvelope,
	type CompetitionTaskPlan,
	type EnvironmentAccess,
	parseCompetitionEvent,
	type ScoreSnapshot,
	sha256Text,
} from "./competition-protocol.ts";
import type {
	CompetitionAdapterBuild,
	CompetitionAdapterConfigPatch,
	CompetitionAdapterSummary,
} from "./competition-runtime.ts";
import { CompetitionStore, type CompetitionTaskRecord, type SubmissionRecord } from "./competition-store.ts";

export interface CompetitionBrokerOptions {
	store: CompetitionStore;
	adapter: CompetitionPlatformAdapter;
	adapterSummary?: CompetitionAdapterSummary;
	reconfigureAdapter?: (patch: CompetitionAdapterConfigPatch) => Promise<CompetitionAdapterBuild>;
	ownerId?: string;
	maxEnvironmentSlots?: number;
	taskLeaseTtlMs?: number;
	environmentLeaseTtlMs?: number;
	environmentPollAttempts?: number;
	environmentPollIntervalMs?: number;
	audit?: CompetitionAuditObserver;
}

export interface CompetitionBrokerOpenOptions extends Omit<CompetitionBrokerOptions, "store"> {
	databasePath: string;
}

export interface CompetitionSyncResult {
	policySnapshotId: string;
	listed: number;
	snapshotted: number;
	failedDetails: string[];
}

export interface RegisterCompetitionTaskInput {
	taskId: string;
	shortTask: string;
	challenge: CompetitionTaskRecord["challenge"];
	submission: CompetitionTaskRecord["submission"];
	policySnapshotId: string;
	priority: number;
}

export interface CompetitionBrokerStatus {
	ok: true;
	platform: string;
	ownerId: string;
	activeEnvironmentCount: number;
	maxEnvironmentSlots: number;
	adapter?: CompetitionAdapterSummary;
	plan?: CompetitionPlan;
	tasks: CompetitionTaskRecord[];
	lastAudit: Array<NonNullable<ReturnType<CompetitionStore["getAuditVerdict"]>>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function number(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function taskIdFor(adapter: CompetitionPlatformAdapter, exerciseId: string | number): string {
	return `${adapter.platform}:${String(exerciseId)}`;
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (isRecord(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}

function clampProbability(value: number): number {
	return Math.min(1, Math.max(0, value));
}

export function computeCompetitionPriority(scoring: ScoreSnapshot): number {
	return (
		(scoring.currentScore * clampProbability(scoring.estimatedSolveProbability)) /
			Math.max(scoring.expectedRemainingMinutes + scoring.environmentWaitMinutes, 1) +
		Math.max(0, scoring.agingBonus)
	);
}

function environmentRequired(challenge: ChallengeSnapshot): boolean {
	return challenge.environment.required;
}

function redact(value: unknown, depth = 0): unknown {
	if (depth > 8) return "[TRUNCATED]";
	if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, child]) => {
			if (/(?:authorization|access[_-]?key|api[_-]?key|password|passwd|secret|cookie|credential)/iu.test(key))
				return [key, "[REDACTED]"];
			return [key, redact(child, depth + 1)];
		}),
	);
}

function platformError(error: unknown): CompetitionPlatformError {
	if (error instanceof CompetitionPlatformError) return error;
	return new CompetitionPlatformError(error instanceof Error ? error.message : String(error));
}

function responseRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? (redact(value) as Record<string, unknown>) : { value: String(value) };
}

export class CompetitionBroker {
	readonly store: CompetitionStore;
	readonly ownerId: string;
	private adapterValue: CompetitionPlatformAdapter;
	private adapterSummary?: CompetitionAdapterSummary;
	private readonly reconfigureAdapter?: CompetitionBrokerOptions["reconfigureAdapter"];
	private adapterConfigurationTail: Promise<void> = Promise.resolve();
	private readonly maxEnvironmentSlots?: number;
	private readonly taskLeaseTtlMs: number;
	private readonly environmentLeaseTtlMs: number;
	private readonly environmentPollAttempts: number;
	private readonly environmentPollIntervalMs: number;
	private readonly audit: CompetitionAuditObserver;
	private readonly ownsStore: boolean;

	private constructor(options: CompetitionBrokerOptions, ownsStore: boolean) {
		this.store = options.store;
		this.adapterValue = options.adapter;
		this.adapterSummary = options.adapterSummary;
		this.reconfigureAdapter = options.reconfigureAdapter;
		this.ownerId = options.ownerId ?? `${process.pid}:${randomUUID()}`;
		this.maxEnvironmentSlots = options.maxEnvironmentSlots;
		this.taskLeaseTtlMs = Math.max(5_000, Math.trunc(options.taskLeaseTtlMs ?? 30 * 60_000));
		this.environmentLeaseTtlMs = Math.max(5_000, Math.trunc(options.environmentLeaseTtlMs ?? 30 * 60_000));
		this.environmentPollAttempts = Math.max(1, Math.trunc(options.environmentPollAttempts ?? 60));
		this.environmentPollIntervalMs = Math.max(10, Math.trunc(options.environmentPollIntervalMs ?? 5_000));
		this.audit = options.audit ?? new CompetitionAuditObserver(this.store);
		this.ownsStore = ownsStore;
	}

	static async open(options: CompetitionBrokerOpenOptions): Promise<CompetitionBroker> {
		const store = await CompetitionStore.open(options.databasePath);
		return new CompetitionBroker({ ...options, store }, true);
	}

	static from(options: CompetitionBrokerOptions): CompetitionBroker {
		return new CompetitionBroker(options, false);
	}

	get adapter(): CompetitionPlatformAdapter {
		return this.adapterValue;
	}

	async configureAdapter(patch: CompetitionAdapterConfigPatch): Promise<Record<string, unknown>> {
		const operation = this.adapterConfigurationTail.then(
			() => this.configureAdapterNow(patch),
			() => this.configureAdapterNow(patch),
		);
		this.adapterConfigurationTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	private async configureAdapterNow(patch: CompetitionAdapterConfigPatch): Promise<Record<string, unknown>> {
		if (!this.reconfigureAdapter)
			throw new Error("Competition adapter runtime reconfiguration is not available in this broker");
		const activeEnvironmentCount = this.store.activeEnvironmentCount();
		if (activeEnvironmentCount > 0 && !patch.force)
			throw new Error(
				`Cannot switch competition credentials while ${activeEnvironmentCount} environment lease(s) are active; set force=true after verifying the leases`,
			);
		const built = await this.reconfigureAdapter(patch);
		this.adapterValue = built.adapter;
		this.adapterSummary = built.summary;
		return {
			changed: true,
			adapter: built.summary,
			preservedTaskCount: this.store.listTasks().length,
			activeEnvironmentCount,
			forced: Boolean(patch.force),
		};
	}

	async close(): Promise<void> {
		if (this.ownsStore) this.store.close();
	}

	async sync(signal?: AbortSignal): Promise<CompetitionSyncResult> {
		const policy = await this.adapter.getPolicy(signal);
		const policySnapshotId = sha256Text(stableJson({ platform: this.adapter.platform, policy })).slice(0, 32);
		this.store.putPolicySnapshot(
			policySnapshotId,
			redact({
				...policy.raw,
				flagFormat: policy.flagFormat,
				submission: policy.submission,
				maxEnvironmentSlots: policy.maxEnvironmentSlots,
			}) as Record<string, unknown>,
		);
		const summaries = await this.adapter.listChallenges(signal);
		let snapshotted = 0;
		const failedDetails: string[] = [];
		for (const summary of summaries) {
			const taskId = taskIdFor(this.adapter, summary.exerciseId);
			const existing = this.store.getTask(taskId);
			if (!summary.isOpen && !summary.hasSolved) {
				if (existing && existing.status !== "solved")
					this.store.setTaskStatus(taskId, "platform_closed", "Platform no longer lists this challenge as open");
				continue;
			}
			try {
				// Refresh solved details too, so persisted snapshots do not retain stale platform payloads.
				const fetchedChallenge = await this.adapter.getChallenge(summary.exerciseId, signal);
				const challenge: CompetitionChallenge = {
					...fetchedChallenge,
					platform: redact(fetchedChallenge.platform) as Record<string, unknown>,
				};
				const challengeSnapshot: ChallengeSnapshot = {
					exerciseId: challenge.exerciseId,
					name: challenge.name,
					category: challenge.category,
					description: challenge.description,
					hints: challenge.hints,
					flagFormat: challenge.flagFormat,
					attachments: challenge.attachments,
					environment: challenge.environment,
					scoring: challenge.scoring,
					platform: challenge.platform,
				};
				const task = this.store.upsertTask({
					taskId,
					shortTask: `${challenge.category}: ${challenge.name}`,
					challenge: challengeSnapshot,
					submission: { ...policy.submission, flagFormat: challenge.flagFormat },
					policySnapshotId,
					priority: computeCompetitionPriority({
						...challenge.scoring,
						challengeValue: summary.score || challenge.scoring.challengeValue,
						difficulty: summary.difficulty ?? challenge.scoring.difficulty,
					}),
					status:
						summary.hasSolved || challenge.hasSolved ? "solved" : challenge.isOpen ? "queued" : "platform_closed",
				});
				if (challenge.hasSolved && task.status !== "solved")
					this.store.setTaskStatus(task.taskId, "solved", "Platform reports challenge solved");
				snapshotted += 1;
			} catch (error) {
				failedDetails.push(
					`${String(summary.exerciseId)}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return { policySnapshotId, listed: summaries.length, snapshotted, failedDetails };
	}

	status(): CompetitionBrokerStatus {
		const tasks = this.store.listTasks();
		const lastAudit = tasks.flatMap((task) => {
			const verdict = this.store.getAuditVerdict(task.taskId);
			return verdict ? [verdict] : [];
		});
		return {
			ok: true,
			platform: this.adapter.platform,
			ownerId: this.ownerId,
			activeEnvironmentCount: this.store.activeEnvironmentCount(),
			maxEnvironmentSlots: this.maxEnvironmentSlots ?? 3,
			...(this.adapterSummary ? { adapter: this.adapterSummary } : {}),
			...(this.store.getPlan() ? { plan: this.store.getPlan() } : {}),
			tasks,
			lastAudit,
		};
	}

	listTasks(): CompetitionTaskRecord[] {
		return this.store.listTasks();
	}

	getPlan(): CompetitionPlan | undefined {
		return this.store.getPlan();
	}

	setPlan(input: { taskIds: string[]; rationale: string; generatedBy?: string; expectedRevision?: number }): {
		plan: CompetitionPlan;
		tasks: CompetitionTaskRecord[];
	} {
		const requested = input.taskIds.map((taskId) => taskId.trim()).filter(Boolean);
		const unique = [...new Set(requested)];
		if (unique.length === 0) throw new Error("Competition plan must contain at least one task");
		if (!input.rationale.trim()) throw new Error("Competition plan rationale must not be empty");
		if (!(input.generatedBy ?? this.ownerId).trim())
			throw new Error("Competition plan generatedBy must not be empty");
		const tasks = this.store.listTasks();
		const known = new Map(tasks.map((task) => [task.taskId, task]));
		const unknown = unique.filter((taskId) => !known.has(taskId));
		if (unknown.length > 0) throw new Error(`Competition plan contains unknown task(s): ${unknown.join(", ")}`);
		const current = this.store.getPlan();
		const orderedTaskIds = [
			...unique,
			...(current?.orderedTaskIds ?? []).filter((taskId) => !unique.includes(taskId) && known.has(taskId)),
			...tasks
				.filter((task) => !unique.includes(task.taskId) && !(current?.orderedTaskIds ?? []).includes(task.taskId))
				.map((task) => task.taskId),
		];
		const plan = this.store.setPlan({
			orderedTaskIds,
			rationale: input.rationale.trim().slice(0, 8_000),
			generatedBy: (input.generatedBy ?? this.ownerId).trim().slice(0, 200),
			expectedRevision: input.expectedRevision,
		});
		return { plan, tasks: this.store.listTasks() };
	}

	clearPlan(): { cleared: true; tasks: CompetitionTaskRecord[] } {
		this.store.clearPlan();
		return { cleared: true, tasks: this.store.listTasks() };
	}

	setAttemptBudgets(budgets: Array<{ taskId: string; budget: number }>): { tasks: CompetitionTaskRecord[] } {
		if (budgets.length === 0) throw new Error("At least one attempt budget is required");
		return { tasks: this.store.setAttemptBudgets(budgets) };
	}

	async requeueTasks(
		taskIds: string[],
		reason = "Requeued by Main Agent",
	): Promise<{ tasks: CompetitionTaskRecord[]; previousStatuses: Record<string, string>; reason: string }> {
		const unique = [...new Set(taskIds.map((taskId) => taskId.trim()).filter(Boolean))];
		if (unique.length === 0) throw new Error("At least one competition task is required");
		const current = unique.map((taskId) => {
			const task = this.store.getTask(taskId);
			if (!task) throw new Error(`Competition task not found: ${taskId}`);
			if (task.status === "solved") throw new Error(`Competition task is already solved: ${taskId}`);
			if (task.status === "platform_closed")
				throw new Error(`Competition task is platform-closed and cannot be requeued: ${taskId}`);
			if (
				["assigned", "preparing", "running", "verifying"].includes(task.status) &&
				task.lease &&
				task.lease.expiresAt > Date.now()
			)
				throw new Error(`Competition task has an active solver lease: ${taskId}`);
			return task;
		});
		const normalizedReason = text(reason).slice(0, 1_000) || "Requeued by Main Agent";
		const previousStatuses = Object.fromEntries(current.map((task) => [task.taskId, task.status]));
		const tasks: CompetitionTaskRecord[] = [];
		for (const task of current) {
			if (task.environmentLeaseId) {
				try {
					await this.adapterValue.releaseEnvironment(task.challenge.exerciseId);
					this.store.releaseEnvironmentLease(task.environmentLeaseId);
				} catch (error) {
					throw new Error(
						`Cannot requeue ${task.taskId} while its environment is active: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			}
			const queued = this.store.requeueTask(task.taskId);
			if (!queued) throw new Error(`Competition task disappeared while requeuing: ${task.taskId}`);
			tasks.push(queued);
		}
		return { tasks, previousStatuses, reason: normalizedReason };
	}

	registerTask(input: RegisterCompetitionTaskInput): CompetitionTaskRecord {
		return this.store.upsertTask(input);
	}

	async submitLegacyCandidate(input: {
		taskId: string;
		solverId: string;
		candidate: string;
		evidenceSummary: string;
		evidenceSource: string;
		signal?: AbortSignal;
	}): Promise<Record<string, unknown>> {
		let task = this.store.getTask(input.taskId);
		if (!task) throw new Error(`Unknown competition task: ${input.taskId}`);
		if (!task.lease || task.solverId !== input.solverId) {
			const claim = this.store.claimTask(input.taskId, input.solverId, this.taskLeaseTtlMs);
			if (!claim.granted || !claim.task)
				throw new Error(`Legacy solver could not claim competition task: ${claim.reason}`);
			task = claim.task;
		}
		const evidenceId = `legacy-${sha256Text(`${input.taskId}:${input.solverId}:${input.candidate}`).slice(0, 24)}`;
		const evidenceEvent: CompetitionEvent = {
			protocol: COMPETITION_PROTOCOL,
			version: COMPETITION_PROTOCOL_VERSION,
			eventId: randomUUID(),
			taskId: task.taskId,
			assignmentId: task.assignmentId,
			solverId: input.solverId,
			type: "evidence",
			occurredAt: Date.now(),
			payload: {
				evidenceId,
				kind: "observation",
				summary: input.evidenceSummary.slice(0, 8_000),
				source: input.evidenceSource,
				refs: [input.evidenceSource],
				confidence: 0.2,
			},
		};
		await this.handleEvent(evidenceEvent, input.signal);
		const submitEvent: CompetitionEvent = {
			protocol: COMPETITION_PROTOCOL,
			version: COMPETITION_PROTOCOL_VERSION,
			eventId: randomUUID(),
			taskId: task.taskId,
			assignmentId: task.assignmentId,
			solverId: input.solverId,
			type: "submit_request",
			occurredAt: Date.now(),
			payload: {
				candidate: input.candidate,
				evidenceRefs: [evidenceId],
				confidence: 0.2,
				rationale: "Compatibility fallback from legacy FINAL_ANSWER parser",
			},
		};
		return this.handleEvent(submitEvent, input.signal);
	}

	getTask(taskId: string): CompetitionTaskRecord | undefined {
		return this.store.getTask(taskId);
	}

	releaseTask(taskId: string, solverId: string, status: CompetitionTaskRecord["status"] = "queued"): boolean {
		return this.store.releaseTask(taskId, solverId, status);
	}

	async claim(
		taskId: string,
		solverId: string,
		leaseTtlMs = this.taskLeaseTtlMs,
		signal?: AbortSignal,
	): Promise<CompetitionTaskEnvelope> {
		const claim = this.store.claimTask(taskId, solverId, leaseTtlMs);
		if (!claim.granted || !claim.task) throw new Error(`Task cannot be claimed: ${claim.reason}`);
		let task: CompetitionTaskRecord = claim.task;
		const needsEnvironment =
			environmentRequired(task.challenge) &&
			(task.challenge.environment.status !== "ready" || task.environmentLeaseId === undefined);
		if (needsEnvironment) {
			task = await this.prepareEnvironment(task, signal);
			if (task.status === "environment_blocked" || task.status === "platform_closed") {
				this.store.releaseTask(task.taskId, solverId, task.status);
				throw new Error(task.lastError ?? task.status);
			}
		}
		if (task.status !== "running") task = this.store.setTaskStatus(task.taskId, "running", undefined) ?? task;
		return this.envelope(task);
	}

	async handleEvent(event: CompetitionEvent, signal?: AbortSignal): Promise<Record<string, unknown>> {
		let task = this.store.getTask(event.taskId);
		if (!task) throw new Error(`Unknown competition task: ${event.taskId}`);
		if (event.type === "claim") {
			const payload = event.payload as Extract<CompetitionEventPayload, { taskId: string; leaseTtlMs?: number }>;
			if (payload.taskId !== event.taskId) throw new Error("claim event taskId does not match the event taskId");
			const claim = this.store.claimTask(event.taskId, event.solverId, payload.leaseTtlMs ?? this.taskLeaseTtlMs);
			if (!claim.granted || !claim.task) return { accepted: false, reason: claim.reason };
			task = claim.task;
			const storedClaim = this.store.appendEvent({ ...event, assignmentId: task.assignmentId });
			if (!storedClaim.inserted) return { duplicate: true, eventId: event.eventId };
			const envelope = await this.claim(
				event.taskId,
				event.solverId,
				payload.leaseTtlMs ?? this.taskLeaseTtlMs,
				signal,
			);
			return { accepted: true, type: event.type, task: envelope };
		}
		if (task.assignmentId !== event.assignmentId || task.solverId !== event.solverId)
			throw new Error("event does not match the active task lease");
		const stored = this.store.appendEvent(event);
		if (!stored.inserted) return { duplicate: true, eventId: event.eventId };
		// Late progress/completed messages must not undo the platform verdict.
		if (task.status === "solved" && event.type !== "submit_request") return { accepted: true, terminal: "solved" };
		if (event.type === "heartbeat") {
			const payload = event.payload as Extract<CompetitionEventPayload, { leaseId: string }>;
			const ok = this.store.heartbeatTask(
				event.taskId,
				payload.leaseId,
				event.solverId,
				payload.leaseTtlMs ?? this.taskLeaseTtlMs,
			);
			let environmentOk = task.environmentLeaseId
				? this.store.heartbeatEnvironmentLease(
						task.environmentLeaseId,
						this.ownerId,
						payload.leaseTtlMs ?? this.environmentLeaseTtlMs,
					)
				: true;
			if (environmentOk && task.environmentLeaseId && this.adapter.heartbeatEnvironment) {
				try {
					const remote = await this.adapter.heartbeatEnvironment(task.challenge.exerciseId, signal);
					environmentOk = remote.status === "ready";
				} catch (error) {
					const failure = platformError(error);
					environmentOk = false;
					this.store.setTaskStatus(task.taskId, "environment_blocked", failure.message);
				}
			}
			return { accepted: ok && environmentOk, type: event.type };
		}
		if (event.type === "submit_request" && ["solved", "platform_closed", "stopped"].includes(task.status))
			return {
				accepted: false,
				result: { kind: "terminal", task },
			};
		const audit = this.audit.observe(event);
		if (event.type === "evidence") return { accepted: true, audit };
		if (audit.paused && event.type === "progress_report") {
			this.store.setTaskStatus(
				event.taskId,
				audit.verdict === "environment_blocked" ? "environment_blocked" : "blocked",
				audit.reason,
			);
			return { accepted: false, audit };
		}
		if (event.type === "flag_candidate") {
			const payload = event.payload as Extract<
				CompetitionEventPayload,
				{ candidate: string; evidenceRefs: string[]; confidence: number }
			>;
			const candidateAudit = this.audit.evaluateCandidate({
				taskId: event.taskId,
				candidate: payload.candidate,
				evidenceRefs: payload.evidenceRefs,
				confidence: payload.confidence,
				candidateEventId: event.eventId,
			});
			if (candidateAudit.paused) this.store.setTaskStatus(event.taskId, "blocked", candidateAudit.reason);
			return { accepted: !candidateAudit.paused, audit: candidateAudit };
		}
		if (event.type === "submit_request") {
			const payload = event.payload as Extract<
				CompetitionEventPayload,
				{ candidate: string; evidenceRefs: string[]; confidence: number }
			>;
			const candidateAudit = this.audit.evaluateCandidate({
				taskId: event.taskId,
				candidate: payload.candidate,
				evidenceRefs: payload.evidenceRefs,
				confidence: payload.confidence,
				candidateEventId: event.eventId,
			});
			if (candidateAudit.paused) {
				this.store.setTaskStatus(event.taskId, "blocked", candidateAudit.reason);
				return this.submissionFeedback(task, { accepted: false, audit: candidateAudit });
			}
			return this.submissionFeedback(task, await this.submit(task, event, signal, candidateAudit));
		}
		if (event.type === "blocked") {
			const payload = event.payload as Extract<CompetitionEventPayload, { category: string; reason: string }>;
			this.store.setTaskStatus(
				event.taskId,
				payload.category === "environment" ? "environment_blocked" : "blocked",
				payload.reason,
			);
			return { accepted: true, audit };
		}
		if (event.type === "completed") {
			const payload = event.payload as Extract<CompetitionEventPayload, { summary: string; evidenceRefs: string[] }>;
			this.store.setTaskStatus(event.taskId, "verifying", payload.summary);
			return { accepted: true, audit };
		}
		return { accepted: true, audit };
	}

	async handleRequest(request: CompetitionRpcRequest): Promise<CompetitionRpcResponse> {
		if (request.type === "hello")
			return {
				protocol: COMPETITION_PROTOCOL,
				version: COMPETITION_PROTOCOL_VERSION,
				requestId: request.requestId,
				ok: true,
				result: { clientId: request.clientId },
			};
		try {
			const result = await this.handleCommand(request);
			return {
				protocol: COMPETITION_PROTOCOL,
				version: COMPETITION_PROTOCOL_VERSION,
				requestId: request.requestId,
				ok: true,
				result,
			};
		} catch (error) {
			return {
				protocol: COMPETITION_PROTOCOL,
				version: COMPETITION_PROTOCOL_VERSION,
				requestId: request.requestId,
				ok: false,
				error: {
					code: error instanceof CompetitionPlatformError ? error.category : "command_failed",
					message: error instanceof Error ? error.message : String(error),
				},
			};
		}
	}

	private async handleCommand(request: CompetitionCommandRequest): Promise<unknown> {
		const payload = request.payload;
		if (request.operation === "status") return this.status();
		if (request.operation === "configure_adapter")
			return this.configureAdapter(payload as CompetitionAdapterConfigPatch);
		if (request.operation === "sync") return this.sync();
		if (request.operation === "list_tasks") return this.listTasks();
		if (request.operation === "list_events") {
			return this.store.listEvents(text(payload.taskId) || undefined, number(payload.limit, 500));
		}
		if (request.operation === "get_task") return this.getTask(text(payload.taskId));
		if (request.operation === "get_plan") return { plan: this.getPlan() ?? null, tasks: this.listTasks() };
		if (request.operation === "set_plan") {
			const taskIds = Array.isArray(payload.taskIds)
				? payload.taskIds.filter((taskId): taskId is string => typeof taskId === "string")
				: [];
			const rationale = text(payload.rationale);
			if (!rationale) throw new Error("set_plan requires a non-empty rationale");
			return this.setPlan({
				taskIds,
				rationale,
				...(typeof payload.generatedBy === "string" ? { generatedBy: payload.generatedBy } : {}),
				...(typeof payload.expectedRevision === "number" ? { expectedRevision: payload.expectedRevision } : {}),
			});
		}
		if (request.operation === "clear_plan") return this.clearPlan();
		if (request.operation === "set_attempt_budgets") {
			const budgets = Array.isArray(payload.budgets)
				? payload.budgets.flatMap((entry) => {
						if (!isRecord(entry) || typeof entry.taskId !== "string" || typeof entry.budget !== "number")
							return [];
						return [{ taskId: entry.taskId, budget: entry.budget }];
					})
				: [];
			return this.setAttemptBudgets(budgets);
		}
		if (request.operation === "requeue_tasks") {
			const taskIds = Array.isArray(payload.taskIds)
				? payload.taskIds.filter((taskId): taskId is string => typeof taskId === "string")
				: [];
			return this.requeueTasks(taskIds, text(payload.reason) || undefined);
		}
		if (request.operation === "claim")
			return this.claim(
				text(payload.taskId),
				text(payload.solverId),
				number(payload.leaseTtlMs, this.taskLeaseTtlMs),
			);
		if (request.operation === "release_environment") {
			const leaseId = text(payload.leaseId);
			const lease = this.store.getEnvironmentLease(leaseId);
			if (!lease) return { released: false };
			const released = await this.adapter.releaseEnvironment(lease.exerciseId);
			this.store.releaseEnvironmentLease(leaseId, this.ownerId);
			const task = this.store.getTask(lease.taskId);
			if (task && !["solved", "stopped"].includes(task.status))
				this.store.setTaskStatus(task.taskId, "environment_blocked", "Environment released by operator");
			return { released: true, platform: released };
		}
		if (request.operation === "stop_task") {
			const taskId = text(payload.taskId);
			const task = this.store.getTask(taskId);
			if (!task) return undefined;
			if (task.status === "solved") return { task, environmentRelease: undefined };
			let environmentRelease: unknown;
			let clearEnvironmentLease = task.environmentLeaseId === undefined;
			if (task.environmentLeaseId) {
				try {
					environmentRelease = await this.adapter.releaseEnvironment(task.challenge.exerciseId);
					this.store.releaseEnvironmentLease(task.environmentLeaseId, this.ownerId);
					clearEnvironmentLease = true;
				} catch (error) {
					environmentRelease = {
						error: error instanceof Error ? error.message : String(error),
					};
				}
			}
			const stopped = this.store.stopTask(
				taskId,
				text(payload.reason) || "Stopped by operator",
				clearEnvironmentLease,
			);
			return { task: stopped, environmentRelease };
		}
		const event = parseCompetitionEvent(payload.event);
		return this.handleEvent(event);
	}

	private envelope(task: CompetitionTaskRecord): CompetitionTaskEnvelope {
		if (!task.lease) throw new Error(`Task has no active lease: ${task.taskId}`);
		const plan = this.store.getPlan();
		const taskPlan: CompetitionTaskPlan | undefined =
			plan && task.plan
				? {
						planId: plan.planId,
						revision: plan.revision,
						rank: task.plan.rank,
						total: plan.orderedTaskIds.length,
					}
				: undefined;
		return {
			taskId: task.taskId,
			assignmentId: task.assignmentId,
			shortTask: task.shortTask,
			challenge: task.challenge,
			submission: task.submission,
			...(task.attemptBudget === undefined ? {} : { attemptBudget: task.attemptBudget }),
			lease: task.lease,
			policySnapshotId: task.policySnapshotId,
			...(taskPlan ? { plan: taskPlan } : {}),
		};
	}

	private async prepareEnvironment(task: CompetitionTaskRecord, signal?: AbortSignal): Promise<CompetitionTaskRecord> {
		const maxSlots = this.maxEnvironmentSlots ?? 3;
		const leaseResult = this.store.claimEnvironmentLease(
			task.challenge.exerciseId,
			task.taskId,
			this.ownerId,
			maxSlots,
			this.environmentLeaseTtlMs,
		);
		if (!leaseResult.granted || !leaseResult.lease)
			return (
				this.store.setTaskStatus(task.taskId, "environment_blocked", "No environment slot is available") ?? task
			);
		const environmentLease = leaseResult.lease;
		this.store.setTaskStatus(task.taskId, "preparing");
		const build = this.store.beginEnvironmentBuild(task.challenge.exerciseId, this.ownerId);
		if (build.state === "retry_wait") {
			const retryAt = build.retryAt ?? Date.now();
			const message = `Environment build is backing off until ${new Date(retryAt).toISOString()}`;
			this.store.setTaskStatus(task.taskId, "environment_blocked", message);
			this.store.releaseEnvironmentLease(environmentLease.leaseId, this.ownerId);
			return this.store.getTask(task.taskId) ?? task;
		}
		try {
			let start =
				build.state === "acquired"
					? await this.adapter.startEnvironment(task.challenge.exerciseId, signal)
					: build.state === "ready"
						? await this.adapter.getEnvironment(task.challenge.exerciseId, signal)
						: undefined;
			if (start?.status !== "ready") {
				if (start?.status === "blocked")
					throw new CompetitionPlatformError("Environment platform blocked the challenge", {
						category: "environment_error",
					});
				for (let attempt = 0; attempt < this.environmentPollAttempts; attempt += 1) {
					if (attempt > 0)
						await new Promise<void>((resolve, reject) => {
							let timer: ReturnType<typeof setTimeout>;
							const cleanup = (): void => {
								clearTimeout(timer);
								signal?.removeEventListener("abort", abort);
							};
							const done = (): void => {
								cleanup();
								resolve();
							};
							const abort = (): void => {
								cleanup();
								reject(signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
							};
							timer = setTimeout(done, this.environmentPollIntervalMs);
							signal?.addEventListener("abort", abort, { once: true });
						});
					try {
						start = await this.adapter.getEnvironment(task.challenge.exerciseId, signal);
					} catch (error) {
						const failure = platformError(error);
						if (failure.category === "rate_limited") {
							await new Promise<void>((resolve) =>
								setTimeout(resolve, failure.retryAfterMs ?? this.environmentPollIntervalMs),
							);
							continue;
						}
						throw failure;
					}
					if (start.status === "blocked")
						throw new CompetitionPlatformError("Environment platform blocked the challenge", {
							category: "environment_error",
						});
					if (start.status === "ready") break;
				}
			}
			if (!start || start.status !== "ready")
				throw new CompetitionPlatformError("Environment did not become ready", { category: "environment_error" });
			if (build.state === "acquired")
				this.store.completeEnvironmentBuild(task.challenge.exerciseId, build.token, start.leaseMetadata);
			const environment: EnvironmentAccess = {
				required: true,
				status: "ready",
				endpoints: start.endpoints,
				leaseId: environmentLease.leaseId,
				expiresAt: environmentLease.expiresAt,
			};
			const updated = this.store.updateTaskChallenge(task.taskId, { ...task.challenge, environment });
			return updated ?? task;
		} catch (error) {
			const failure = platformError(error);
			if (build.state === "acquired") {
				const retryAfter =
					failure.retryAfterMs ??
					Math.min(60_000, 1_000 * 2 ** Math.min(build.failureCount ?? 0, 6)) + Math.trunc(Math.random() * 250);
				this.store.failEnvironmentBuild(task.challenge.exerciseId, build.token, Date.now() + retryAfter, {
					message: failure.message,
					category: failure.category,
				});
			}
			const status = failure.category === "platform_closed" ? "platform_closed" : "environment_blocked";
			this.store.setTaskStatus(task.taskId, status, failure.message);
			this.store.releaseEnvironmentLease(environmentLease.leaseId, this.ownerId);
			return this.store.getTask(task.taskId) ?? task;
		}
	}

	private submissionFeedback(task: CompetitionTaskRecord, result: Record<string, unknown>): Record<string, unknown> {
		const current = this.store.getTask(task.taskId) ?? task;
		const remainingAttempts = Math.max(
			0,
			(current.attemptBudget ?? current.submission.maxAttempts) - current.actualAttempts,
		);
		const submission = isRecord(result.submission) ? result.submission : {};
		const audit = isRecord(result.audit) ? result.audit : {};
		const error = isRecord(result.error) ? result.error : {};
		const begun = isRecord(result.result) ? result.result : {};
		const category =
			typeof submission.category === "string"
				? submission.category
				: typeof begun.kind === "string"
					? begun.kind
					: "blocked";
		const accepted = category === "accepted" && submission.isCorrect === true;
		const canContinue =
			!accepted &&
			remainingAttempts > 0 &&
			audit.paused !== true &&
			!["stopped", "solved", "platform_closed", "environment_blocked"].includes(current.status) &&
			["incorrect", "format_mismatch", "duplicate"].includes(category);
		const message =
			typeof result.message === "string"
				? result.message
				: typeof error.message === "string"
					? error.message
					: typeof audit.reason === "string"
						? audit.reason
						: accepted
							? "Platform accepted the answer. This solver is complete."
							: category === "incorrect"
								? "Platform rejected the answer. Review the evidence and correct the candidate."
								: `Submission result: ${category}. This is not a confirmed incorrect answer.`;
		return {
			...result,
			remainingAttempts,
			canContinue,
			feedback: {
				category,
				message,
				nextAction: accepted
					? "complete"
					: remainingAttempts === 0
						? "budget_exhausted"
						: canContinue
							? "revise_candidate"
							: "resolve_blocker",
				...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
			},
		};
	}

	private async submit(
		task: CompetitionTaskRecord,
		event: CompetitionEvent,
		signal: AbortSignal | undefined,
		candidateAudit: CompetitionAuditResult,
	): Promise<Record<string, unknown>> {
		const payload = event.payload as Extract<
			CompetitionEventPayload,
			{ candidate: string; evidenceRefs: string[]; confidence: number; clientSubmissionId?: string }
		>;
		const candidate = payload.candidate;
		let formatted: { normalized: string; submitted: string };
		try {
			formatted = validateSubmissionFlag(candidate, {
				flagFormat: task.submission.flagFormat,
				submission: task.submission,
				maxEnvironmentSlots: 0,
				raw: {},
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const local = this.store.recordLocalSubmission({
				taskId: task.taskId,
				assignmentId: task.assignmentId,
				rawCandidateHash: sha256Text(candidate),
				normalizedCandidateHash: sha256Text(candidate.trim()),
				evidenceRefs: payload.evidenceRefs,
				requestPayload: { candidate },
				category: "format_mismatch",
				reason: message,
			});
			const audit = this.audit.onSubmissionResult(
				task.taskId,
				"format_mismatch",
				Date.now(),
				candidateAudit.newEvidence,
			);
			this.store.setTaskStatus(task.taskId, audit.paused ? "blocked" : "running", message);
			return { accepted: false, category: local.category, submission: local, audit, message };
		}
		const requestPayload = { exerciseId: task.challenge.exerciseId, flag: formatted.submitted };
		const clientSubmissionId =
			"clientSubmissionId" in payload && typeof payload.clientSubmissionId === "string"
				? payload.clientSubmissionId
				: undefined;
		const begun = this.store.beginSubmission({
			taskId: task.taskId,
			assignmentId: task.assignmentId,
			rawCandidateHash: sha256Text(candidate),
			normalizedCandidateHash: sha256Text(formatted.normalized),
			maxAttempts: task.attemptBudget ?? task.submission.maxAttempts,
			evidenceRefs: payload.evidenceRefs,
			...(clientSubmissionId ? { clientSubmissionId } : {}),
			requestPayload,
		});
		if (begun.kind === "attempt_limit") {
			this.store.setTaskStatus(
				task.taskId,
				"blocked",
				`Attempt budget exhausted after ${begun.attempts} submission(s)`,
			);
		}
		if (begun.kind !== "started") return { accepted: false, result: begun, audit: candidateAudit };
		try {
			const response = await this.adapter.submitFlag(
				task.challenge.exerciseId,
				formatted.submitted,
				{
					taskId: task.taskId,
					attemptNo: begun.submission.attemptNo,
					policy: {
						flagFormat: task.submission.flagFormat,
						submission: task.submission,
						maxEnvironmentSlots: 0,
						raw: {},
					},
				},
				signal,
			);
			const category: SubmissionRecord["category"] = response.isCorrect ? "accepted" : "incorrect";
			const submission = this.store.finishSubmission(begun.submission.recordId, {
				category,
				isCorrect: response.isCorrect,
				httpStatus: response.httpStatus,
				businessCode: response.businessCode,
				requestPayload: response.requestPayload,
				response: responseRecord(response.rawResponse),
			});
			const audit = this.audit.onSubmissionResult(task.taskId, category, Date.now(), candidateAudit.newEvidence);
			if (audit.paused) this.store.setTaskStatus(task.taskId, "blocked", audit.reason);
			if (!response.isCorrect && !audit.paused) {
				const current = this.store.getTask(task.taskId) ?? task;
				const exhausted = current.actualAttempts >= (current.attemptBudget ?? current.submission.maxAttempts);
				this.store.setTaskStatus(
					task.taskId,
					exhausted ? "blocked" : "running",
					exhausted ? "Submission attempt budget exhausted" : response.message,
				);
			}
			if (response.isCorrect) {
				this.store.setTaskStatus(task.taskId, "solved", "Platform accepted the submitted flag");
				try {
					await this.adapter.releaseEnvironment(task.challenge.exerciseId, signal);
					if (task.environmentLeaseId) this.store.releaseEnvironmentLease(task.environmentLeaseId, this.ownerId);
				} catch (error) {
					this.store.appendEvent({
						protocol: COMPETITION_PROTOCOL,
						version: COMPETITION_PROTOCOL_VERSION,
						eventId: randomUUID(),
						taskId: task.taskId,
						assignmentId: task.assignmentId,
						solverId: event.solverId,
						type: "blocked",
						occurredAt: Date.now(),
						payload: {
							category: "environment",
							reason: `accepted but environment release failed: ${error instanceof Error ? error.message : String(error)}`,
						},
					});
				}
			}
			return {
				accepted: response.isCorrect,
				submission,
				audit,
				response: responseRecord(response.rawResponse),
				...(response.message ? { message: response.message } : {}),
			};
		} catch (error) {
			const failure = platformError(error);
			const category: SubmissionRecord["category"] =
				failure.category === "rate_limited"
					? "rate_limited"
					: failure.category === "environment_error"
						? "environment_error"
						: failure.category === "platform_closed"
							? "platform_closed"
							: "request_error";
			const submission = this.store.finishSubmission(begun.submission.recordId, {
				category,
				httpStatus: failure.httpStatus,
				businessCode: failure.code,
				response: responseRecord(failure.rawResponse ?? { message: failure.message }),
			});
			const audit = this.audit.onSubmissionResult(task.taskId, category, Date.now(), candidateAudit.newEvidence);
			const nextStatus =
				category === "platform_closed"
					? "platform_closed"
					: category === "environment_error" || category === "rate_limited"
						? "environment_blocked"
						: audit.paused
							? "blocked"
							: "running";
			this.store.setTaskStatus(task.taskId, nextStatus, audit.paused ? audit.reason : failure.message);
			return {
				accepted: false,
				submission,
				audit,
				error: { category, message: failure.message, retryAfterMs: failure.retryAfterMs ?? null },
			};
		}
	}
}
