import type { PlanningObserverMode } from "../config.ts";
import type {
	PlanningCheckpoint,
	PlanningEvidence,
	PlanningEvidenceListOptions,
	PlanningEvidenceListResult,
	PlanningEvidenceReadResult,
	PlanningObserverReport,
	PlanningTaskLease,
	PlanningTaskOutcome,
} from "./contracts.ts";
import { parsePlanningObserverReport } from "./contracts.ts";
import { isPlanningFailureError, PlanningPersistenceError } from "./failures.ts";

export const PLANNING_OBSERVER_CHECKPOINTS_MS = [180_000, 420_000] as const;
export const PLANNING_OBSERVER_FINALIZE_REMINDER_MS = 540_000;
export const MAX_PLANNING_OBSERVER_REMINDERS = 2;
export const PLANNING_OBSERVER_MIN_INTERVAL_MS = 120_000;
export const PLANNING_OBSERVER_EVIDENCE_TRIGGER_COUNT = 6;
export const PLANNING_OBSERVER_DEADLINE_GUARD_MS = 120_000;
export const PLANNING_OBSERVER_MAX_MODEL_CALLS = 2;
export const PLANNING_OBSERVER_MAX_PROMPT_EVIDENCE = 12;
export const PLANNING_OBSERVER_MAX_READ_BYTES = 1_024;
export const PLANNING_OBSERVER_MAX_READ_ITEMS = 6;
const DEFAULT_EXECUTOR_HARD_TIMEOUT_MS = 600_000;
const MAX_COUNTED_EVIDENCE_IDS = 4_096;

export interface PlanningObserverPromptEvidence {
	evidenceId: string;
	taskId: string;
	leaseId: string;
	toolName: string;
	createdAt: number;
	outcome: "success" | "error" | "unknown";
	description: string;
	excerpt: string;
	contentComplete: boolean;
	excerptComplete: boolean;
	originalContentBytes: number;
	readError?: string;
}

export interface PlanningObserverPromptInput {
	checkpointMs: number;
	triggerReason: string;
	newEvidenceCount: number;
	blockedForMs: number;
	lease: PlanningTaskLease;
	context: string;
	timeline: Array<Record<string, unknown>>;
	evidence: PlanningObserverPromptEvidence[];
	totalEvidenceCount: number;
	evidenceListComplete: boolean;
	lastCheckpoint?: PlanningCheckpoint;
}

export interface PlanningObserverAttemptClosure {
	executorOutcome?: PlanningTaskOutcome;
	executorSummary?: string;
	executorOpenQuestions?: string[];
	executorRejectedDirections?: Array<{ direction: string; reason: string; evidenceRefs: string[] }>;
	commitToolSubmissionAvailable: boolean;
	failure?: { stage: string; code?: string; message: string };
}

export interface PlanningObserverRuntimeOptions {
	mode: PlanningObserverMode;
	startedAt: number;
	hardTimeoutMs?: number;
	lease: PlanningTaskLease;
	context: string;
	signal?: AbortSignal;
	listEvidence?: (options: PlanningEvidenceListOptions) => PlanningEvidenceListResult;
	readEvidence?: (
		evidenceId: string,
		offset: number,
		maxBytes?: number,
		requestId?: string,
	) => PlanningEvidenceReadResult | Promise<PlanningEvidenceReadResult>;
	recordObservation?: (
		source: "planning_observer_report" | "planning_observer_runtime",
		summary: string,
		metadata: Record<string, unknown>,
	) => PlanningEvidence;
	observe(input: PlanningObserverPromptInput, signal: AbortSignal): Promise<string>;
	onLifecycleEvent(type: string, payload: Record<string, unknown>): void;
	onPersistenceFailure(error: unknown): void;
}

function uniqueEvidenceReferences(report: PlanningObserverReport): string[] {
	return [
		...new Set([
			...report.observedResults.flatMap((item) => item.evidenceIds),
			...report.observerJudgments.flatMap((item) => item.evidenceIds),
		]),
	];
}

function compactReport(report: PlanningObserverReport): PlanningObserverReport {
	return {
		attempted: report.attempted.slice(0, 4).map((item) => item.slice(0, 400)),
		observedResults: report.observedResults.slice(0, 4).map((item) => ({
			text: item.text.slice(0, 400),
			evidenceIds: item.evidenceIds.slice(0, 8),
		})),
		observerJudgments: report.observerJudgments.slice(0, 4).map((item) => ({
			text: item.text.slice(0, 400),
			evidenceIds: item.evidenceIds.slice(0, 8),
		})),
		unverifiedHypotheses: report.unverifiedHypotheses.slice(0, 4).map((item) => item.slice(0, 400)),
		failuresOrStalls: report.failuresOrStalls.slice(0, 4).map((item) => item.slice(0, 400)),
		avoidRepeating: report.avoidRepeating.slice(0, 4).map((item) => item.slice(0, 400)),
		openQuestions: report.openQuestions.slice(0, 4).map((item) => item.slice(0, 400)),
		...(report.guidance ? { guidance: report.guidance.slice(0, 600) } : {}),
	};
}

function persistenceFailure(error: unknown): boolean {
	return (
		error instanceof PlanningPersistenceError ||
		(isPlanningFailureError(error) && error.code === "planning_persistence_error")
	);
}

function combinedSignal(signals: Array<AbortSignal | undefined>): AbortSignal {
	const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
	if (active.length === 0) return new AbortController().signal;
	const first = active[0];
	if (active.length === 1 && first) return first;
	if (typeof AbortSignal.any === "function") return AbortSignal.any(active);
	const controller = new AbortController();
	const abort = (signal: AbortSignal): void => {
		if (!controller.signal.aborted) controller.abort(signal.reason);
	};
	for (const signal of active) {
		if (signal.aborted) abort(signal);
		else signal.addEventListener("abort", () => abort(signal), { once: true });
	}
	return controller.signal;
}

function reportItemsWithReadableEvidence(
	items: PlanningObserverReport["observedResults"],
	readable: ReadonlySet<string>,
	unverified: string[],
): PlanningObserverReport["observedResults"] {
	return items.flatMap((item) => {
		const unreadable = item.evidenceIds.filter((evidenceId) => !readable.has(evidenceId));
		if (item.evidenceIds.length === 0 || unreadable.length > 0) {
			unverified.push(
				`${item.text} (unverified: evidence reference absent or unreadable${unreadable.length > 0 ? `: ${unreadable.join(", ")}` : ""})`,
			);
			return [];
		}
		return [{ ...item, evidenceIds: [...new Set(item.evidenceIds)] }];
	});
}

export class PlanningObserverRuntime {
	private readonly options: PlanningObserverRuntimeOptions;
	private readonly timers: Array<ReturnType<typeof setTimeout>> = [];
	private readonly timeline: Array<Record<string, unknown>> = [];
	private readonly countedEvidenceIds = new Set<string>();
	private readonly seenEvidenceIds = new Set<string>();
	private readonly inFlightTools = new Map<string, { toolName: string; startedAt: number }>();
	private lastCheckpoint: PlanningCheckpoint | undefined;
	private latestEvidenceIds: string[] = [];
	private evidenceCountTruncated = false;
	private inFlight: Promise<void> | undefined;
	private cancellation: AbortController | undefined;
	private pendingTrigger: { triggerMs: number; reason: string; blockageTrigger: boolean } | undefined;
	private blockageTimer: ReturnType<typeof setTimeout> | undefined;
	private eventObservationTimer: ReturnType<typeof setTimeout> | undefined;
	private executorSteer: ((message: string) => void | Promise<void>) | undefined;
	private guidanceRequestsInFlight = 0;
	private observerClosed = false;
	private semanticReportSaved = false;
	private semanticReportEvidenceId: string | undefined;
	private semanticReport: PlanningObserverReport | undefined;
	private observerFailure: string | undefined;
	private persistenceError: unknown;
	private reminderCount = 0;
	private modelObservationCount = 0;
	private lastModelObservationAt: number | undefined;
	private evidenceCount = 0;
	private lastObservedEvidenceCount = 0;
	private timelineEventCount = 0;
	private repeatedFailurePath: { signature: string; since: number; count: number } | undefined;

	constructor(options: PlanningObserverRuntimeOptions) {
		this.options = options;
	}

	start(): void {
		if (this.options.mode === "off") return;
		for (const checkpointMs of PLANNING_OBSERVER_CHECKPOINTS_MS) {
			const delay = Math.max(0, checkpointMs - (Date.now() - this.options.startedAt));
			this.timers.push(
				setTimeout(() => this.requestObservation(checkpointMs, `scheduled_${checkpointMs}_ms`, false), delay),
			);
		}
		if (this.options.mode === "guidance") {
			const delay = Math.max(0, PLANNING_OBSERVER_FINALIZE_REMINDER_MS - (Date.now() - this.options.startedAt));
			this.timers.push(
				setTimeout(() => {
					void this.sendFinalizeReminder().catch((error: unknown) =>
						this.failObserver(PLANNING_OBSERVER_FINALIZE_REMINDER_MS, error),
					);
				}, delay),
			);
		}
	}

	setExecutorSteer(steer: (message: string) => void | Promise<void>): void {
		this.executorSteer = steer;
	}

	recordToolEvidence(evidenceIds: string[], toolCallId?: string): void {
		const uniqueIds = evidenceIds.filter((evidenceId): evidenceId is string => Boolean(evidenceId));
		const previousCount = this.evidenceCount;
		const newlySeenIds = uniqueIds.filter(
			(evidenceId) => !this.countedEvidenceIds.has(evidenceId) && !this.latestEvidenceIds.includes(evidenceId),
		);
		for (const evidenceId of uniqueIds) {
			if (this.countedEvidenceIds.has(evidenceId)) continue;
			if (this.countedEvidenceIds.size >= MAX_COUNTED_EVIDENCE_IDS) {
				this.evidenceCountTruncated = true;
				break;
			}
			this.countedEvidenceIds.add(evidenceId);
		}
		this.evidenceCount = this.countedEvidenceIds.size;
		const newEvidenceCount = Math.max(0, this.evidenceCount - previousCount);
		// Tool callbacks list IDs in write order; the final ID is the newest one.
		this.rememberLatestEvidenceIds([...newlySeenIds].reverse());
		if (toolCallId) {
			for (let index = this.timeline.length - 1; index >= 0; index -= 1) {
				const event = this.timeline[index];
				if (event?.type === "executor_tool_execution_end" && event.toolCallId === toolCallId) {
					event.evidenceId = uniqueIds.at(-1);
					break;
				}
			}
		}
		if (newEvidenceCount > 0) this.requestObservationWhenEvidenceReady();
	}

	recordTimeline(type: string, payload: Record<string, unknown>): void {
		const allowedTypes = new Set([
			"executor_tool_execution_start",
			"executor_tool_execution_end",
			"planning_checkpoint_saved",
			"planning_commit_observed",
			"executor_failure_progress",
			"executor_error",
			"required_tool_recovery_start",
			"required_tool_recovery_attempt_start",
			"required_tool_recovery_attempt_end",
			"required_tool_recovery_end",
		]);
		if (!allowedTypes.has(type)) return;
		const event: Record<string, unknown> = { type };
		for (const key of [
			"elapsedMs",
			"toolCallId",
			"toolName",
			"toolElapsedMs",
			"isError",
			"accepted",
			"checkpointId",
			"checkpointSequence",
			"failureCode",
			"completedToolEvidenceCount",
			"inFlightToolCount",
			"attempt",
		]) {
			if (Object.hasOwn(payload, key)) event[key] = payload[key];
		}
		this.timelineEventCount += 1;
		this.timeline.push(event);
		if (this.timeline.length > 96) this.timeline.shift();
		if (type === "executor_tool_execution_start" && typeof payload.toolCallId === "string") {
			if (this.inFlightTools.size < 16) {
				this.inFlightTools.set(payload.toolCallId, {
					toolName: typeof payload.toolName === "string" ? payload.toolName : "unknown_tool",
					startedAt: Date.now(),
				});
			}
			this.scheduleBlockageCheck();
		}
		if (type === "executor_tool_execution_end" && typeof payload.toolCallId === "string") {
			this.inFlightTools.delete(payload.toolCallId);
			if (payload.isError === true) {
				const toolName = typeof payload.toolName === "string" ? payload.toolName : "unknown_tool";
				const signature = `${toolName}:${typeof payload.failureCode === "string" ? payload.failureCode : "tool_error"}`;
				if (this.repeatedFailurePath?.signature === signature) this.repeatedFailurePath.count += 1;
				else this.repeatedFailurePath = { signature, since: Date.now(), count: 1 };
				this.scheduleBlockageCheck();
			} else if (payload.isError === false) {
				this.repeatedFailurePath = undefined;
			}
		}
	}

	recordCheckpoint(checkpoint: PlanningCheckpoint): void {
		this.lastCheckpoint = checkpoint;
		this.recordTimeline("planning_checkpoint_saved", {
			checkpointId: checkpoint.checkpointId,
			checkpointSequence: checkpoint.checkpointSequence,
			elapsedMs: Math.max(0, checkpoint.createdAt - this.options.startedAt),
		});
	}

	close(closure: PlanningObserverAttemptClosure = { commitToolSubmissionAvailable: false }): void {
		if (this.observerClosed) return;
		this.observerClosed = true;
		for (const timer of this.timers) clearTimeout(timer);
		if (this.blockageTimer) clearTimeout(this.blockageTimer);
		if (this.eventObservationTimer) clearTimeout(this.eventObservationTimer);
		const pending = this.inFlight !== undefined;
		if (pending) {
			this.cancellation?.abort(new Error("Executor finished before the Observer report completed"));
			this.observerFailure ??= "Observer report did not finish before the Executor attempt ended";
		}
		if (this.options.mode === "off" || this.persistenceError || typeof this.options.recordObservation !== "function")
			return;

		let persisted: { items: PlanningEvidence[]; totalCount: number; hasMore: boolean } = {
			items: [],
			totalCount: 0,
			hasMore: false,
		};
		let evidenceListingSucceeded = typeof this.options.listEvidence === "function";
		try {
			persisted = this.listCurrentLeaseEvidence();
		} catch (error) {
			this.observerFailure ??= error instanceof Error ? error.message : String(error);
			this.options.onLifecycleEvent("planning_observer_error", {
				failureCode: persistenceFailure(error) ? "planning_persistence_error" : "observer_evidence_list_failed",
				error: this.observerFailure.slice(0, 1_000),
			});
			evidenceListingSucceeded = false;
			if (persistenceFailure(error)) {
				this.persistenceError = error;
				this.options.onPersistenceFailure(error);
				return;
			}
		}
		const durableToolEvidenceIds = persisted.items
			.filter((item) => item.kind === "tool")
			.map((item) => item.evidenceId);
		for (const evidenceId of durableToolEvidenceIds) {
			if (this.countedEvidenceIds.has(evidenceId)) continue;
			if (this.countedEvidenceIds.size >= MAX_COUNTED_EVIDENCE_IDS) {
				this.evidenceCountTruncated = true;
				break;
			}
			this.countedEvidenceIds.add(evidenceId);
		}
		this.evidenceCount = this.countedEvidenceIds.size;
		this.rememberLatestEvidenceIds(durableToolEvidenceIds);
		const commitToolEvent = [...this.timeline].reverse().find((event) => event.type === "planning_commit_observed");
		if (
			persisted.totalCount === 0 &&
			this.latestEvidenceIds.length === 0 &&
			!this.lastCheckpoint &&
			!commitToolEvent &&
			!closure.commitToolSubmissionAvailable
		)
			return;

		const persistedToolEvidenceCount = persisted.items.filter((item) => item.kind === "tool").length;
		const toolEvidenceCount = Math.max(this.evidenceCount, persistedToolEvidenceCount);
		const evidenceIdsComplete =
			evidenceListingSucceeded &&
			!persisted.hasMore &&
			!this.evidenceCountTruncated &&
			persistedToolEvidenceCount === this.evidenceCount &&
			this.latestEvidenceIds.length >= toolEvidenceCount;
		this.persistRuntimeHandoff(closure, toolEvidenceCount, evidenceIdsComplete);
	}

	/** Evidence pages are newest-first; keep that same order in every handoff update. */
	private rememberLatestEvidenceIds(newestFirstIds: readonly string[]): void {
		const incoming = [...new Set(newestFirstIds.filter((evidenceId): evidenceId is string => Boolean(evidenceId)))];
		if (incoming.length === 0) return;
		const incomingSet = new Set(incoming);
		this.latestEvidenceIds = [
			...incoming,
			...this.latestEvidenceIds.filter((evidenceId) => !incomingSet.has(evidenceId)),
		].slice(0, 32);
	}

	private listCurrentLeaseEvidence(limit = 50): { items: PlanningEvidence[]; totalCount: number; hasMore: boolean } {
		if (typeof this.options.listEvidence !== "function") return { items: [], totalCount: 0, hasMore: false };
		const page = this.options.listEvidence({ leaseId: this.options.lease.leaseId, limit });
		return { items: page.items, totalCount: page.totalCount, hasMore: page.hasMore };
	}

	private remainingHardDeadlineMs(now = Date.now()): number {
		return this.options.startedAt + (this.options.hardTimeoutMs ?? DEFAULT_EXECUTOR_HARD_TIMEOUT_MS) - now;
	}

	private blockedForMs(now = Date.now()): number {
		const longRunning = [...this.inFlightTools.values()].reduce(
			(longest, tool) => Math.max(longest, now - tool.startedAt),
			0,
		);
		const repeatedFailure =
			this.repeatedFailurePath && this.repeatedFailurePath.count >= 2 ? now - this.repeatedFailurePath.since : 0;
		return Math.max(longRunning, repeatedFailure);
	}

	private hasSustainedBlockage(now = Date.now()): boolean {
		return this.blockedForMs(now) >= PLANNING_OBSERVER_MIN_INTERVAL_MS;
	}

	private requestObservationWhenEvidenceReady(): void {
		if (this.evidenceCount - this.lastObservedEvidenceCount < PLANNING_OBSERVER_EVIDENCE_TRIGGER_COUNT) return;
		this.requestObservation(Math.max(0, Date.now() - this.options.startedAt), "durable_evidence_growth", false);
	}

	private scheduleBlockageCheck(): void {
		if (this.blockageTimer) clearTimeout(this.blockageTimer);
		const activeSince = [...this.inFlightTools.values()].reduce(
			(earliest, tool) => Math.min(earliest, tool.startedAt),
			Number.POSITIVE_INFINITY,
		);
		const repeatedSince =
			this.repeatedFailurePath && this.repeatedFailurePath.count >= 2
				? this.repeatedFailurePath.since
				: Number.POSITIVE_INFINITY;
		const blockedSince = Math.min(activeSince, repeatedSince);
		if (!Number.isFinite(blockedSince)) return;
		const delay = Math.max(0, blockedSince + PLANNING_OBSERVER_MIN_INTERVAL_MS - Date.now());
		this.blockageTimer = setTimeout(() => {
			if (this.hasSustainedBlockage()) {
				this.requestObservation(Math.max(0, Date.now() - this.options.startedAt), "sustained_blockage", true);
			}
		}, delay);
	}

	private requestObservation(triggerMs: number, reason: string, blockageTrigger: boolean): void {
		if (this.observerClosed || this.options.mode === "off" || this.options.signal?.aborted) return;
		if (this.modelObservationCount >= PLANNING_OBSERVER_MAX_MODEL_CALLS) {
			this.options.onLifecycleEvent("planning_observer_skipped", {
				triggerMs,
				reason: "observer_model_call_limit",
				triggerReason: reason,
				modelObservationCount: this.modelObservationCount,
			});
			return;
		}
		const remainingHardDeadlineMs = this.remainingHardDeadlineMs();
		if (remainingHardDeadlineMs < PLANNING_OBSERVER_DEADLINE_GUARD_MS) {
			this.options.onLifecycleEvent("planning_observer_skipped", {
				triggerMs,
				reason: "within_hard_deadline_guard",
				triggerReason: reason,
				remainingHardDeadlineMs,
			});
			return;
		}
		const isScheduledFallback = reason.startsWith("scheduled_");
		const newEvidenceCount = Math.max(0, this.evidenceCount - this.lastObservedEvidenceCount);
		if (!isScheduledFallback && !blockageTrigger && newEvidenceCount < PLANNING_OBSERVER_EVIDENCE_TRIGGER_COUNT)
			return;
		if (blockageTrigger && !this.hasSustainedBlockage()) return;
		if (this.inFlight) {
			this.pendingTrigger = { triggerMs, reason, blockageTrigger };
			return;
		}
		const cooldownBase = this.lastModelObservationAt ?? this.options.startedAt;
		const cooldownMs = cooldownBase + PLANNING_OBSERVER_MIN_INTERVAL_MS - Date.now();
		if (cooldownMs > 0) {
			this.pendingTrigger = { triggerMs, reason, blockageTrigger };
			if (this.eventObservationTimer) clearTimeout(this.eventObservationTimer);
			this.eventObservationTimer = setTimeout(() => {
				this.eventObservationTimer = undefined;
				const pending = this.pendingTrigger;
				this.pendingTrigger = undefined;
				if (pending) this.requestObservation(pending.triggerMs, pending.reason, pending.blockageTrigger);
			}, cooldownMs);
			return;
		}
		if (this.eventObservationTimer) clearTimeout(this.eventObservationTimer);
		this.eventObservationTimer = undefined;
		this.pendingTrigger = undefined;
		void this.observeAt(triggerMs, reason, blockageTrigger);
	}

	private async observeAt(triggerMs: number, triggerReason: string, blockageTrigger: boolean): Promise<void> {
		if (this.observerClosed || this.options.signal?.aborted) return;
		if (this.inFlight) {
			this.pendingTrigger = { triggerMs, reason: triggerReason, blockageTrigger };
			this.options.onLifecycleEvent("planning_observer_deferred", {
				triggerMs,
				triggerReason,
				reason: "observer_call_in_flight",
			});
			return;
		}
		let persisted: { items: PlanningEvidence[]; totalCount: number; hasMore: boolean };
		try {
			persisted = this.listCurrentLeaseEvidence(50);
		} catch (error) {
			this.failObserver(triggerMs, error);
			return;
		}
		if (this.observerClosed || this.options.signal?.aborted) return;
		const toolEvidence = persisted.items.filter((item) => item.kind === "tool");
		const currentToolEvidenceCount = Math.max(this.evidenceCount, toolEvidence.length);
		const newEvidenceCount = Math.max(0, currentToolEvidenceCount - this.lastObservedEvidenceCount);
		const canObserveWithoutNewEvidence = blockageTrigger && this.hasSustainedBlockage() && toolEvidence.length > 0;
		const isScheduledFallback = triggerReason.startsWith("scheduled_");
		if (
			toolEvidence.length === 0 ||
			(!canObserveWithoutNewEvidence && newEvidenceCount === 0) ||
			(isScheduledFallback && newEvidenceCount === 0) ||
			(!isScheduledFallback && !blockageTrigger && newEvidenceCount < PLANNING_OBSERVER_EVIDENCE_TRIGGER_COUNT)
		) {
			this.options.onLifecycleEvent("planning_observer_skipped", {
				triggerMs,
				triggerReason,
				reason: toolEvidence.length === 0 ? "no_durable_tool_evidence" : "trigger_condition_no_longer_met",
				persistedToolEvidenceCount: currentToolEvidenceCount,
				newEvidenceCount,
			});
			return;
		}
		if (this.modelObservationCount >= PLANNING_OBSERVER_MAX_MODEL_CALLS) return;
		if (this.remainingHardDeadlineMs() < PLANNING_OBSERVER_DEADLINE_GUARD_MS) {
			this.options.onLifecycleEvent("planning_observer_skipped", {
				triggerMs,
				triggerReason,
				reason: "within_hard_deadline_guard",
				remainingHardDeadlineMs: this.remainingHardDeadlineMs(),
			});
			return;
		}
		const selectedEvidence = toolEvidence.slice(0, PLANNING_OBSERVER_MAX_PROMPT_EVIDENCE).reverse();
		for (const item of selectedEvidence) this.seenEvidenceIds.add(item.evidenceId);
		while (this.seenEvidenceIds.size > PLANNING_OBSERVER_MAX_PROMPT_EVIDENCE * PLANNING_OBSERVER_MAX_MODEL_CALLS) {
			const oldest = this.seenEvidenceIds.values().next().value as string | undefined;
			if (!oldest) break;
			this.seenEvidenceIds.delete(oldest);
		}
		this.rememberLatestEvidenceIds(toolEvidence.slice(0, 32).map((item) => item.evidenceId));
		const evidence = selectedEvidence.map((item) => {
			const outcome: PlanningObserverPromptEvidence["outcome"] =
				item.metadata.isError === true ? "error" : item.metadata.isError === false ? "success" : "unknown";
			const excerpt = item.excerpt.slice(0, 240);
			return {
				evidenceId: item.evidenceId,
				taskId: item.taskId,
				leaseId: item.leaseId,
				toolName: item.toolName ?? item.source,
				createdAt: item.createdAt,
				outcome,
				description: item.summary,
				excerpt,
				contentComplete: item.contentComplete,
				excerptComplete:
					item.contentComplete && !item.isTruncated && Buffer.byteLength(excerpt, "utf8") >= item.contentBytes,
				originalContentBytes: item.contentBytes,
			};
		});
		const cancellation = new AbortController();
		this.cancellation = cancellation;
		const signal = combinedSignal([this.options.signal, cancellation.signal]);
		this.modelObservationCount += 1;
		this.lastModelObservationAt = Date.now();
		this.lastObservedEvidenceCount = currentToolEvidenceCount;
		this.options.onLifecycleEvent("planning_observer_started", {
			triggerMs,
			triggerReason,
			modelObservationNumber: this.modelObservationCount,
			newEvidenceCount,
			persistedToolEvidenceCount: currentToolEvidenceCount,
			blockedForMs: this.blockedForMs(),
			remainingHardDeadlineMs: this.remainingHardDeadlineMs(),
		});
		const operation = this.runObserver(
			{
				checkpointMs: triggerMs,
				triggerReason,
				newEvidenceCount,
				blockedForMs: this.blockedForMs(),
				lease: this.options.lease,
				context: this.options.context,
				timeline: this.timeline.slice(-64),
				evidence,
				totalEvidenceCount: currentToolEvidenceCount,
				evidenceListComplete: !persisted.hasMore && currentToolEvidenceCount <= evidence.length,
				...(this.lastCheckpoint ? { lastCheckpoint: this.lastCheckpoint } : {}),
			},
			signal,
		);
		this.inFlight = operation;
		const finish = (): void => {
			if (this.inFlight === operation) this.inFlight = undefined;
			if (this.cancellation === cancellation) this.cancellation = undefined;
			const pending = this.pendingTrigger;
			this.pendingTrigger = undefined;
			if (pending && !this.observerClosed && !this.options.signal?.aborted) {
				this.requestObservation(pending.triggerMs, pending.reason, pending.blockageTrigger);
			}
		};
		void operation.then(finish, (error: unknown) => {
			this.failObserver(triggerMs, error);
			finish();
		});
	}

	private async runObserver(input: PlanningObserverPromptInput, signal: AbortSignal): Promise<void> {
		const startedAt = Date.now();
		try {
			const enrichedInput = await this.enrichPromptEvidence(input, signal);
			if (this.observerClosed || signal.aborted || this.options.signal?.aborted) return;
			const rawReport = await this.options.observe(enrichedInput, signal);
			if (this.observerClosed || signal.aborted || this.options.signal?.aborted) return;
			const report = compactReport(parsePlanningObserverReport(rawReport));
			const references = uniqueEvidenceReferences(report);
			const referencesToValidate = references.slice(0, 32);
			const readable = new Set<string>();
			const unreadable = new Set<string>();
			for (const [index, evidenceId] of referencesToValidate.entries()) {
				if (typeof this.options.readEvidence !== "function") {
					unreadable.add(evidenceId);
					continue;
				}
				try {
					await this.options.readEvidence(evidenceId, 0, 256, `observer-${input.checkpointMs}-${index}`);
					readable.add(evidenceId);
				} catch (error) {
					if (persistenceFailure(error)) throw error;
					unreadable.add(evidenceId);
				}
			}
			const unverifiedHypotheses = [...report.unverifiedHypotheses];
			const observedResults = reportItemsWithReadableEvidence(
				report.observedResults,
				readable,
				unverifiedHypotheses,
			);
			const observerJudgments = reportItemsWithReadableEvidence(
				report.observerJudgments,
				readable,
				unverifiedHypotheses,
			);
			const validated: PlanningObserverReport = {
				...report,
				observedResults,
				observerJudgments,
				unverifiedHypotheses: unverifiedHypotheses.slice(0, 8).map((item) => item.slice(0, 500)),
			};
			const validatedReferences = uniqueEvidenceReferences(validated);
			if (this.observerClosed || signal.aborted || this.options.signal?.aborted) return;
			if (typeof this.options.recordObservation !== "function") {
				throw new Error("Planning observer report storage is unavailable");
			}
			const savedReport = this.options.recordObservation("planning_observer_report", JSON.stringify(validated), {
				semanticReportGenerated: true,
				observerMode: this.options.mode,
				triggerMs: input.checkpointMs,
				triggerReason: input.triggerReason,
				interpretationOnly: true,
				evidenceReferenceCheck: "same_run_readable_only",
				semanticVerification: "not_performed",
				evidenceRefs: validatedReferences,
				invalidEvidenceReferenceCount: unreadable.size + references.length - referencesToValidate.length,
			});
			this.semanticReportSaved = true;
			this.semanticReportEvidenceId = savedReport.evidenceId;
			this.semanticReport = validated;
			this.options.onLifecycleEvent("planning_observer_completed", {
				triggerMs: input.checkpointMs,
				triggerReason: input.triggerReason,
				modelObservationNumber: this.modelObservationCount,
				elapsedMs: Math.max(0, Date.now() - startedAt),
				blockedForMs: input.blockedForMs,
				semanticReportGenerated: true,
				evidenceRefCount: validatedReferences.length,
				invalidEvidenceReferenceCount: unreadable.size + references.length - referencesToValidate.length,
			});
			if (unreadable.size > 0 || references.length > referencesToValidate.length) {
				this.options.onLifecycleEvent("planning_observer_error", {
					triggerMs: input.checkpointMs,
					failureCode: "observer_invalid_evidence_reference",
					invalidEvidenceReferenceCount: unreadable.size + references.length - referencesToValidate.length,
				});
			}
			if (this.options.mode === "guidance" && validated.guidance && validatedReferences.length > 0) {
				const basis = this.guidanceBasis(validatedReferences, enrichedInput.evidence);
				if (basis) {
					await this.sendGuidance(validated.guidance, input.checkpointMs, validatedReferences, basis);
				} else {
					this.options.onLifecycleEvent("planning_observer_guidance_skipped", {
						triggerMs: input.checkpointMs,
						reason: "no_locatable_deviation_or_blockage",
						evidenceRefs: validatedReferences.slice(0, 8),
					});
				}
			}
		} catch (error) {
			if (this.options.signal?.aborted || (this.observerClosed && signal.aborted)) {
				this.options.onLifecycleEvent("planning_observer_cancelled", {
					triggerMs: input.checkpointMs,
					reason: "executor_ended",
				});
				return;
			}
			this.failObserver(input.checkpointMs, error);
		}
	}

	private async enrichPromptEvidence(
		input: PlanningObserverPromptInput,
		signal: AbortSignal,
	): Promise<PlanningObserverPromptInput> {
		let readCount = 0;
		const evidence: PlanningObserverPromptEvidence[] = [];
		for (const item of input.evidence) {
			const enriched = { ...item };
			const excerptBytes = Buffer.byteLength(item.excerpt, "utf8");
			const originalMayContinue = !item.excerptComplete || item.originalContentBytes > excerptBytes;
			if (originalMayContinue && readCount < PLANNING_OBSERVER_MAX_READ_ITEMS && this.options.readEvidence) {
				readCount += 1;
				try {
					const result = await this.options.readEvidence(
						item.evidenceId,
						0,
						PLANNING_OBSERVER_MAX_READ_BYTES,
						`observer-context-${input.checkpointMs}-${readCount}`,
					);
					enriched.excerpt = result.content;
					enriched.excerptComplete = result.contentComplete && !result.hasMore;
					enriched.originalContentBytes = result.totalBytes;
				} catch (error) {
					if (persistenceFailure(error)) throw error;
					enriched.excerptComplete = false;
					enriched.readError = (error instanceof Error ? error.message : String(error)).slice(0, 240);
				}
			}
			evidence.push(enriched);
			if (signal.aborted || this.observerClosed) break;
		}
		return { ...input, evidence };
	}

	private guidanceBasis(evidenceRefs: string[], evidence: PlanningObserverPromptEvidence[]): string | undefined {
		const failedEvidence = evidence.find(
			(item) => item.outcome === "error" && evidenceRefs.includes(item.evidenceId),
		);
		if (failedEvidence)
			return `tool ${failedEvidence.toolName} returned an error for evidence ${failedEvidence.evidenceId}`;
		if (!this.hasSustainedBlockage()) return undefined;
		const activeTool = [...this.inFlightTools.entries()].sort(
			(left, right) => left[1].startedAt - right[1].startedAt,
		)[0];
		const repeated =
			this.repeatedFailurePath && this.repeatedFailurePath.count >= 2 ? this.repeatedFailurePath : undefined;
		const description = activeTool
			? `tool ${activeTool[1].toolName} has remained in flight for ${this.blockedForMs()}ms`
			: repeated
				? `the ${repeated.signature} failure path repeated ${repeated.count} times over ${this.blockedForMs()}ms`
				: "the current tool path has remained blocked";
		const evidenceId = evidenceRefs.find((reference) => evidence.some((item) => item.evidenceId === reference));
		return evidenceId ? `${description}; related readable evidence ${evidenceId}` : undefined;
	}

	private failObserver(checkpointMs: number, error: unknown): void {
		this.observerFailure = error instanceof Error ? error.message : String(error);
		this.options.onLifecycleEvent("planning_observer_error", {
			triggerMs: checkpointMs,
			failureCode: persistenceFailure(error) ? "planning_persistence_error" : "observer_report_failed",
			error: this.observerFailure.slice(0, 1_000),
		});
		if (persistenceFailure(error)) {
			this.persistenceError = error;
			this.options.onPersistenceFailure(error);
		}
	}

	private async sendGuidance(
		message: string,
		triggerMs: number,
		evidenceRefs: string[],
		observedBasis: string,
	): Promise<boolean> {
		if (
			this.options.mode !== "guidance" ||
			this.reminderCount + this.guidanceRequestsInFlight >= MAX_PLANNING_OBSERVER_REMINDERS ||
			!this.executorSteer ||
			!observedBasis
		) {
			return false;
		}
		this.guidanceRequestsInFlight += 1;
		try {
			await this.executorSteer(
				`Observed: ${observedBasis.slice(0, 300)}. Observer suggestion (advisory only; continue the leased task; this is not an approval or proof): ${message.slice(0, 500)} Evidence IDs readable in this run (readability does not prove the interpretation): ${evidenceRefs.slice(0, 8).join(", ")}.`,
			);
			this.reminderCount += 1;
			this.options.onLifecycleEvent("planning_observer_guidance_sent", {
				triggerMs,
				reminderNumber: this.reminderCount,
				evidenceRefs: evidenceRefs.slice(0, 16),
			});
			return true;
		} catch (error) {
			this.options.onLifecycleEvent("planning_observer_error", {
				triggerMs,
				failureCode: "observer_guidance_queue_failed",
				error: String(error).slice(0, 1_000),
			});
			return false;
		} finally {
			this.guidanceRequestsInFlight -= 1;
		}
	}

	private async sendFinalizeReminder(): Promise<void> {
		if (this.observerClosed || this.options.signal?.aborted) return;
		if (!this.hasSustainedBlockage()) {
			this.options.onLifecycleEvent("planning_observer_guidance_skipped", {
				triggerMs: PLANNING_OBSERVER_FINALIZE_REMINDER_MS,
				reason: "no_locatable_deviation_or_blockage",
			});
			return;
		}
		const references = [...new Set([...this.latestEvidenceIds, ...(this.lastCheckpoint?.evidenceRefs ?? [])])].slice(
			0,
			8,
		);
		if (references.length === 0) {
			this.options.onLifecycleEvent("planning_observer_guidance_skipped", {
				triggerMs: PLANNING_OBSERVER_FINALIZE_REMINDER_MS,
				reason: "no_saved_evidence_references",
			});
			return;
		}
		const message =
			"Check whether the blocked tool path has a safe alternate input or whether the result should be reported as unresolved. Save a useful checkpoint and commit an honest result within the existing deadline.";
		const activeTool = [...this.inFlightTools.values()][0];
		const repeated =
			this.repeatedFailurePath && this.repeatedFailurePath.count >= 2 ? this.repeatedFailurePath : undefined;
		const observedBasis = activeTool
			? `tool ${activeTool.toolName} has remained in flight for ${this.blockedForMs()}ms`
			: repeated
				? `the ${repeated.signature} failure path repeated ${repeated.count} times over ${this.blockedForMs()}ms`
				: "the current tool path remains blocked";
		if (!(await this.sendGuidance(message, PLANNING_OBSERVER_FINALIZE_REMINDER_MS, references, observedBasis))) {
			this.options.onLifecycleEvent("planning_observer_guidance_skipped", {
				triggerMs: PLANNING_OBSERVER_FINALIZE_REMINDER_MS,
				reason: "reminder_limit_or_executor_session_unavailable",
			});
		}
	}

	private persistRuntimeHandoff(
		closure: PlanningObserverAttemptClosure,
		persistedEvidenceCount: number,
		evidenceIdsComplete: boolean,
	): void {
		if (this.options.mode === "off" || typeof this.options.recordObservation !== "function") return;
		const toolEvidenceIds = this.latestEvidenceIds.slice(0, 32);
		const commitEvent = [...this.timeline].reverse().find((event) => event.type === "planning_commit_observed");
		const executorOpenQuestions = (closure.executorOpenQuestions ?? []).slice(0, 8).map((item) => item.slice(0, 500));
		const checkpointRemaining =
			this.lastCheckpoint?.remainingItems.slice(0, 8).map((item) => item.slice(0, 500)) ?? [];
		const handoff = {
			semanticReportGenerated: this.semanticReportSaved,
			status: this.semanticReportSaved
				? "Observer report plus attempt closure"
				: "Observer semantic report not generated",
			reason: this.observerFailure?.slice(0, 500) ?? null,
			runId: this.options.lease.runId,
			taskId: this.options.lease.taskId,
			leaseId: this.options.lease.leaseId,
			objective: this.options.lease.objective.slice(0, 1_000),
			doneWhen: this.options.lease.doneWhen.slice(0, 1_000),
			executorDeclaration: {
				outcome: closure.executorOutcome ?? null,
				summary: closure.executorSummary?.slice(0, 1_200) ?? null,
				openQuestions: executorOpenQuestions,
				rejectedDirections: (closure.executorRejectedDirections ?? []).slice(0, 8).map((item) => ({
					direction: item.direction.slice(0, 240),
					reason: item.reason.slice(0, 400),
					evidenceRefs: item.evidenceRefs.slice(0, 8),
				})),
			},
			commitTool: {
				observed: Boolean(commitEvent),
				executionReportedError: typeof commitEvent?.isError === "boolean" ? commitEvent.isError : null,
				structuredSubmissionAvailable: closure.commitToolSubmissionAvailable,
			},
			storeSettlementAtHandoffWrite: {
				state: closure.failure ? "awaiting_harness_seal" : "awaiting_harness_commit",
				durableTaskResultPresent: false,
				note: "This observation is written before Harness commitResult or sealActiveLease; consult the next durable snapshot for settlement.",
			},
			failure: closure.failure
				? {
						stage: closure.failure.stage.slice(0, 128),
						code: closure.failure.code?.slice(0, 128) ?? null,
						message: closure.failure.message.slice(0, 500),
					}
				: null,
			semanticReportEvidenceId: this.semanticReportEvidenceId ?? null,
			observerJudgments: this.semanticReport?.observerJudgments.slice(0, 4) ?? [],
			observerUnverifiedHypotheses: this.semanticReport?.unverifiedHypotheses.slice(0, 8) ?? [],
			observerOpenQuestions: this.semanticReport?.openQuestions.slice(0, 8) ?? [],
			avoidRepeating: this.semanticReport?.avoidRepeating.slice(0, 8) ?? [],
			unresolvedItems: [...new Set([...executorOpenQuestions, ...checkpointRemaining])].slice(0, 12),
			toolEvidenceCount: Math.max(this.evidenceCount, persistedEvidenceCount),
			evidenceIdCount: toolEvidenceIds.length,
			evidenceIdsComplete,
			timelineEventCount: this.timelineEventCount,
			timelineComplete: this.timelineEventCount <= this.timeline.length,
			timeline: this.timeline.slice(-48),
			toolEvidenceIds,
			lastCheckpoint: this.lastCheckpoint
				? {
						checkpointId: this.lastCheckpoint.checkpointId,
						checkpointSequence: this.lastCheckpoint.checkpointSequence,
						summary: this.lastCheckpoint.summary,
						evidenceRefs: this.lastCheckpoint.evidenceRefs.slice(0, 32),
						completedItems: this.lastCheckpoint.completedItems.slice(0, 16),
						remainingItems: this.lastCheckpoint.remainingItems.slice(0, 16),
					}
				: null,
		};
		try {
			const saved = this.options.recordObservation("planning_observer_runtime", JSON.stringify(handoff), {
				semanticReportGenerated: this.semanticReportSaved,
				observerMode: this.options.mode,
				evidenceRefs: [
					...new Set([
						...toolEvidenceIds,
						...(this.lastCheckpoint?.evidenceRefs ?? []),
						...(this.semanticReportEvidenceId ? [this.semanticReportEvidenceId] : []),
					]),
				].slice(0, 32),
			});
			this.options.onLifecycleEvent("planning_observer_attempt_handoff_saved", {
				evidenceId: saved.evidenceId,
				taskId: this.options.lease.taskId,
				leaseId: this.options.lease.leaseId,
				recordedWhileLeaseActive: true,
				storeSettlementAtWrite: closure.failure ? "pending_harness_seal" : "pending_harness_commit",
				commitToolSubmissionAvailable: closure.commitToolSubmissionAvailable,
			});
		} catch (error) {
			this.persistenceError = error;
			this.options.onLifecycleEvent("planning_observer_error", {
				failureCode: "planning_persistence_error",
				stage: "runtime_fallback_persistence",
				error: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
			});
			this.options.onPersistenceFailure(error);
		}
	}
}
