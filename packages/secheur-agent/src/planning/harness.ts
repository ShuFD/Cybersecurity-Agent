import { createHash } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { ArtexInputError } from "./artex-graph.ts";
import { ArtexWake } from "./artex-wake.ts";
import { compilePlanningProposal } from "./compiler.ts";
import { renderPlanningContextWithSummary } from "./context.ts";
import type {
	PlanningCheckpoint,
	PlanningCheckpointInput,
	PlanningEvidence,
	PlanningEvidenceInput,
	PlanningEvidenceListOptions,
	PlanningEvidenceListResult,
	PlanningEvidenceReadResult,
	PlanningExecutionReport,
	PlanningPlanProposal,
	PlanningSnapshot,
	PlanningTaskLease,
	PlanningTaskResult,
} from "./contracts.ts";
import { planningFlagCandidateHash, validatePlanningDependencies } from "./contracts.ts";
import type { EvidenceCard } from "./evidence-cards.ts";
import type { EvidenceCardAccess } from "./evidence-tools.ts";
import { type PlanningCapacityControl, PlanningExecutorPool } from "./execution-pool.ts";
import {
	isPlanningFailureError,
	PlanningCheckpointValidationError,
	PlanningEvidenceListInputError,
	type PlanningFailureError,
	PlanningPersistenceError,
	PlanningResultValidationError,
	planningFailure,
} from "./failures.ts";
import { OpportunityReview } from "./opportunity-review.ts";
import { HypothesisInputError } from "./hypothesis-graph.ts";
import {
	capturePlanningReview,
	type PlanningChanges,
	planningChangesOverview,
	PlanningReviewChanges,
	type PlanningReviewState,
} from "./review-changes.ts";
import { readyPlanningTasks, schedulePlanningTask } from "./scheduler.ts";
import { type SharedVerificationEntry, sharedVerificationHistory } from "./shared-feedback.ts";
import type { CompiledPlanningTask, PlanningAttemptRoutingInput, PlanningStore } from "./store.ts";
import { trustedPlanningVerificationFromSnapshot } from "./terminal-verification.ts";

export interface PlanningSupervisor {
	eventPolicy?: { debounceMs: number; heartbeatMs: number };
	propose(input: {
		snapshot: PlanningSnapshot;
		changes?: PlanningChanges;
		signal?: AbortSignal;
		scheduling?: { capacity: number; occupied: number; available: number };
		recovery?: { code: string; message: string; attempt: number };
	}): Promise<PlanningPlanProposal>;
}

export interface PlanningExecutor {
	execute(input: {
		onProgress?: () => void;
		lease: PlanningTaskLease;
		goal?: string;
		context: string;
		handoffSnapshot?: PlanningSnapshot;
		availableEvidenceRefs?: () => string[];
		verificationHistory?: () => SharedVerificationEntry[];
		taskProgress?: () => EvidenceCard[];
		readEvidence?: (
			evidenceId: string,
			offset: number,
			maxBytes?: number,
			requestId?: string,
		) => PlanningEvidenceReadResult | Promise<PlanningEvidenceReadResult>;
		recordEvidence?: (evidence: PlanningEvidenceInput) => void;
		recordSubmission?: (result: PlanningTaskResult) => void;
		recordCheckpoint?: (
			checkpointId: string,
			checkpoint: PlanningCheckpointInput,
			elapsedMs?: number,
			artifactWorkspace?: string,
		) => PlanningCheckpoint;
		evidenceCards?: EvidenceCardAccess;
		listEvidence?: (options: PlanningEvidenceListOptions) => PlanningEvidenceListResult;
		recordObservation?: (
			source: "planning_observer_report" | "planning_observer_runtime",
			summary: string,
			metadata: Record<string, unknown>,
		) => PlanningEvidence;
		signal?: AbortSignal;
		onPendingSettlement?: (settlement: Promise<void>) => void;
	}): Promise<PlanningExecutionReport>;
}

export interface PlanningHarnessOptions {
	store: PlanningStore;
	supervisor: PlanningSupervisor;
	executor: PlanningExecutor;
	maximumSteps: number;
	maximumTasks: number;
	leaseTtlMs: number;
	maximumEvidenceBytes: number;
	maximumExecutorContextBytes?: number;
	allowedScope: string;
	executionCapacity?: number;
	parallelPlanning?: boolean;
	requireTrustedCompletion?: boolean;
	recoverPlanningFailures?: boolean;
	capacityControl?: PlanningCapacityControl;
	executorPool?: PlanningExecutorPool;
	onPendingSettlement?: (settlement: Promise<void>) => void;
	onProgress?: () => void;
	signal?: AbortSignal;
}

const MAX_NEW_TASKS_PER_DECISION = 1;

function recoverablePlannerFailure(error: unknown, options: PlanningHarnessOptions): error is PlanningFailureError {
	return (
		options.recoverPlanningFailures === true &&
		isPlanningFailureError(error) &&
		(error instanceof ArtexInputError ||
			error instanceof HypothesisInputError ||
			(error.code === "planning_internal_error" && error.stage === "supervisor") ||
			[
				"supervisor_parse_error",
				"supervisor_validation_error",
				"proposal_validation_error",
				"duplicate_task_identity",
				"duplicate_task_signature",
				"terminal_contract_error",
				"model_rate_limited",
				"model_transport_error",
				"model_quota_unavailable",
			].includes(error.code))
	);
}

function plannerRetry(runId: string, error: PlanningFailureError, attempt: number, options: PlanningHarnessOptions) {
	const delayMs = Math.max(error.retryAfterMs ?? 0, Math.min(60_000, 2_000 * 2 ** Math.min(5, attempt - 1)));
	options.store.recordLifecycleEvent(runId, "planning_recovery_pending", { code: error.code, attempt, delayMs });
	return { code: error.code, message: error.message.slice(0, 2_000), attempt, delayMs };
}

function multiPlanning(options: PlanningHarnessOptions): boolean {
	return !!options.supervisor.eventPolicy || options.parallelPlanning === true || (options.executionCapacity ?? 1) > 1;
}

function isTerminalVerifierFailure(failure: PlanningFailureError): boolean {
	return failure.code === "verifier_quota_exhausted";
}

function boundedEvidenceItems(
	evidence: PlanningExecutionReport["evidence"],
	maximumBytes: number,
): PlanningExecutionReport["evidence"] {
	const count = Math.max(1, evidence.length);
	const perItemBytes = Math.max(256, Math.floor(Math.max(1, Math.trunc(maximumBytes)) / count));
	const trim = (value: unknown, limit: number): string =>
		Buffer.from(String(value ?? ""), "utf8")
			.subarray(0, limit)
			.toString("utf8");
	return evidence.map((item) => {
		const summary = trim(item.summary, Math.min(1_024, perItemBytes));
		const excerpt = trim(item.excerpt ?? item.summary, Math.min(4_096, perItemBytes));
		return { ...item, summary, excerpt };
	});
}

function boundedEvidence(report: PlanningExecutionReport, maximumBytes: number): PlanningExecutionReport["evidence"] {
	return boundedEvidenceItems(report.evidence, maximumBytes);
}

function reportEvidence(report: PlanningExecutionReport): PlanningExecutionReport["evidence"] {
	const resultSummary = report.result.summary;
	const resultEvidence = {
		kind: "observation" as const,
		source: "planning-task-result",
		summary: resultSummary,
		contentHash: createHash("sha256").update(resultSummary).digest("hex"),
		metadata: { outcome: report.result.outcome },
	};
	const flagEvidence = report.result.flagCandidates.map((candidate) => {
		const summary = JSON.stringify(candidate);
		return {
			kind: "observation" as const,
			source: "planning-flag-candidate",
			summary,
			contentHash: createHash("sha256").update(summary).digest("hex"),
			metadata: { confidence: candidate.confidence, candidateHash: planningFlagCandidateHash(candidate.candidate) },
		};
	});
	return [...report.evidence, resultEvidence, ...flagEvidence];
}

function abortError(signal?: AbortSignal): Error {
	const reason = signal?.reason;
	if (reason instanceof Error) return reason;
	const error = new Error(typeof reason === "string" && reason.trim() ? reason : "Planning operation aborted");
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError(signal);
}

async function waitForPlanningRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
	try {
		await wait(delayMs, undefined, { signal });
	} catch (error) {
		throwIfAborted(signal);
		throw error;
	}
}

function planningPersistenceFailure(error: unknown, runId: string, operation: string): PlanningFailureError {
	if (isPlanningFailureError(error) && error.code === "planning_persistence_error") return error;
	return planningFailure(
		"controller",
		"planning_persistence_error",
		`Planning ${operation} could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
		error instanceof PlanningPersistenceError ? error.cause : error,
		runId,
	);
}

function recordAttemptRouting(
	runId: string,
	input: Omit<PlanningAttemptRoutingInput, "leaseId"> & { leaseId?: string },
	options: PlanningHarnessOptions,
): void {
	if (!input.leaseId) return;
	try {
		options.store.recordAttemptRouting({ leaseId: input.leaseId, ...input });
	} catch (error) {
		throw planningPersistenceFailure(error, runId, "attempt routing");
	}
}

function completeAfterVerifiedEvidence(
	runId: string,
	snapshot: PlanningSnapshot,
	options: PlanningHarnessOptions,
): PlanningSnapshot | undefined {
	const verification = trustedPlanningVerificationFromSnapshot(snapshot);
	if (!verification || verification.planningRunId !== runId) return undefined;
	throwIfAborted(options.signal);
	try {
		options.store.setRunStatus(runId, "completed", "trusted verifier evidence persisted");
	} catch (error) {
		throw planningPersistenceFailure(error, runId, "terminal status");
	}
	// setRunStatus(completed) is the point of no return.  A cancellation that
	// races after this durable transition must not make the caller observe an
	// abort while the Planning run remains completed.
	try {
		options.store.recordLifecycleEvent(runId, "planning_terminal_evidence_observed", {
			taskId: verification.taskId,
			leaseId: verification.leaseId,
			evidenceId: verification.evidenceId,
			evidenceRefs: [verification.evidenceId],
			verificationOutcome: verification.verificationOutcome,
		});
	} catch {
		// The terminal status is durable already; a diagnostic event failure
		// must not turn a completed run into a caller-visible failure.
	}
	return options.store.snapshot(runId, multiPlanning(options));
}

function commitSupervisorDecision(
	runId: string,
	snapshot: PlanningSnapshot,
	proposal: PlanningPlanProposal,
	options: PlanningHarnessOptions,
): PlanningSnapshot {
	throwIfAborted(options.signal);
	if (proposal.expectedRevision !== snapshot.run.revision) {
		throw planningFailure(
			"supervisor_validation",
			"supervisor_validation_error",
			"Supervisor returned a stale planning revision",
		);
	}
	if (
		proposal.hypothesisUpdate &&
		proposal.decision === "blocked" &&
		(snapshot.activeLeases?.length || snapshot.activeLease)
	) {
		options.store.recordLifecycleEvent(runId, "hypothesis_wait_preserved", {
			owners: snapshot.activeLeases?.map((lease) => lease.taskId),
			rationale: proposal.rationale,
		});
		return snapshot;
	}
	if (proposal.artexUpdate && proposal.decision === "blocked") {
		const owners = new Set((snapshot.activeLeases ?? []).map((lease) => lease.taskId));
		if (!proposal.artexWaitingTaskIds?.length || proposal.artexWaitingTaskIds.some((id) => !owners.has(id)))
			throw planningFailure(
				"proposal_validation",
				"proposal_validation_error",
				"Artex waiting owner is no longer live; plan runnable work",
			);
		return options.store.commitPlan({
			runId,
			expectedRevision: proposal.expectedRevision,
			rationale: proposal.rationale,
			artexUpdate: proposal.artexUpdate,
			tasks: [],
			allowActiveLeases: true,
			idempotencyKey: `artex-wait:${runId}:${proposal.artexUpdate.expectedRound}`,
		});
	}
	if (options.requireTrustedCompletion && (proposal.decision === "finish_run" || proposal.decision === "blocked")) {
		const completed = completeAfterVerifiedEvidence(runId, snapshot, options);
		if (completed) return completed;
		throw planningFailure(
			"terminal_contract",
			"terminal_contract_error",
			"Completion is not verified. Preserve running tasks and evidence; create a next investigation or verification task instead of stopping.",
		);
	}
	if (proposal.decision === "finish_run") {
		const known = new Set(snapshot.evidence.map((item) => item.evidenceId));
		const answerEvidenceRefs = proposal.answerEvidenceRefs ?? [];
		if (answerEvidenceRefs.length === 0 || answerEvidenceRefs.some((id) => !known.has(id))) {
			throw planningFailure(
				"terminal_contract",
				"terminal_contract_error",
				"Supervisor cannot finish the run without valid persisted answer evidence",
			);
		}
		throwIfAborted(options.signal);
		options.store.setRunStatus(runId, "completed", proposal.rationale);
		return options.store.snapshot(runId, multiPlanning(options));
	}
	if (proposal.decision === "blocked") {
		throwIfAborted(options.signal);
		options.store.setRunStatus(runId, "blocked", proposal.rationale || "Supervisor reported no viable next step");
		return options.store.snapshot(runId, multiPlanning(options));
	}
	if (proposal.tasks.length < 1 || (!multiPlanning(options) && proposal.tasks.length > MAX_NEW_TASKS_PER_DECISION)) {
		throw planningFailure(
			"proposal_validation",
			"proposal_validation_error",
			`Supervisor must create exactly one next task, received ${proposal.tasks.length}`,
		);
	}
	throwIfAborted(options.signal);
	let tasks: CompiledPlanningTask[];
	try {
		validatePlanningDependencies(proposal, snapshot);
		tasks = compilePlanningProposal(runId, proposal, snapshot.tasks, options.maximumTasks);
	} catch (error) {
		if (isPlanningFailureError(error)) throw error;
		throw planningFailure(
			"proposal_validation",
			"proposal_validation_error",
			error instanceof Error ? error.message : String(error),
			error,
		);
	}
	throwIfAborted(options.signal);
	return options.store.commitPlan({
		allowActiveLeases: multiPlanning(options),
		hypothesisUpdate: proposal.hypothesisUpdate,
		artexUpdate: proposal.artexUpdate,
		runId,
		expectedRevision: proposal.expectedRevision,
		rationale: proposal.rationale,
		idempotencyKey: `supervisor-plan:${runId}:${proposal.expectedRevision}${proposal.artexUpdate ? `:artex:${proposal.artexUpdate.expectedRound}` : ""}`,
		tasks,
	});
}

export async function runPlanningHarness(runId: string, options: PlanningHarnessOptions): Promise<PlanningSnapshot> {
	// Managed goals have one outer budget. Legacy step/task caps must not terminate them.
	if (options.requireTrustedCompletion)
		options = {
			...options,
			maximumSteps: Number.MAX_SAFE_INTEGER,
			maximumTasks: Number.MAX_SAFE_INTEGER,
			recoverPlanningFailures: true,
		};
	if (multiPlanning(options)) return runParallelPlanningHarness(runId, options);
	let snapshot = options.store.snapshot(runId, multiPlanning(options));
	if (["completed", "blocked", "failed", "cancelled"].includes(snapshot.run.status)) return snapshot;
	let recovery: ReturnType<typeof plannerRetry> | undefined;
	const reviewChanges = new PlanningReviewChanges();
	let executedSteps = options.store.getAttemptCount(runId);
	const maximumSteps = Math.max(1, Math.trunc(options.maximumSteps));
	while (executedSteps < maximumSteps) {
		throwIfAborted(options.signal);
		const decision = schedulePlanningTask(snapshot);
		if (options.requireTrustedCompletion && decision.kind === "blocked") decision.kind = "replan";
		if (decision.kind === "replan") {
			const failedLeaseId = snapshot.latestFailure?.leaseId;
			if (options.signal?.aborted) {
				recordAttemptRouting(
					runId,
					{
						leaseId: failedLeaseId,
						routingState: "terminal",
						replanAllowed: false,
						replanStarted: false,
						replanReason: "parent or user cancellation before Supervisor start",
					},
					options,
				);
				throw abortError(options.signal);
			}
			throwIfAborted(options.signal);
			if (snapshot.tasks.length >= options.maximumTasks) {
				throwIfAborted(options.signal);
				recordAttemptRouting(
					runId,
					{
						leaseId: failedLeaseId,
						routingState: "terminal",
						replanAllowed: false,
						replanStarted: false,
						replanReason: "maximum planning tasks reached before Supervisor start",
					},
					options,
				);
				options.store.setRunStatus(runId, "paused", "maximum planning tasks reached before the goal was verified");
				return options.store.snapshot(runId, multiPlanning(options));
			}
			let proposal: PlanningPlanProposal;
			const review = capturePlanningReview(snapshot);
			const changes = reviewChanges.changes(review);
			try {
				options.store.recordLifecycleEvent(runId, "planning_changes_presented", planningChangesOverview(changes));
				proposal = await options.supervisor.propose({ snapshot, changes, signal: options.signal, recovery });
			} catch (error) {
				if (failedLeaseId) {
					recordAttemptRouting(
						runId,
						{
							leaseId: failedLeaseId,
							routingState: "supervisor_started",
							replanAllowed: true,
							replanStarted: true,
							replanReason: "Supervisor proposal was invoked for the sealed failed attempt",
						},
						options,
					);
				}
				if (recoverablePlannerFailure(error, options)) {
					recovery = plannerRetry(runId, error, (recovery?.attempt ?? 0) + 1, options);
					await waitForPlanningRetry(recovery.delayMs, options.signal);
					snapshot = options.store.snapshot(runId, multiPlanning(options));
					continue;
				}
				throw error;
			}
			if (failedLeaseId) {
				recordAttemptRouting(
					runId,
					{
						leaseId: failedLeaseId,
						routingState: "supervisor_started",
						replanAllowed: true,
						replanStarted: true,
						replanReason: "Supervisor proposal completed for the sealed failed attempt",
					},
					options,
				);
			}
			throwIfAborted(options.signal);
			try {
				const before = capturePlanningReview(snapshot);
				snapshot = commitSupervisorDecision(runId, snapshot, proposal, options);
				reviewChanges.acknowledge(review, before, capturePlanningReview(snapshot));
				options.store.recordLifecycleEvent(runId, "planning_changes_reviewed", { ...changes });
				recovery = undefined;
			} catch (error) {
				if (!recoverablePlannerFailure(error, options)) throw error;
				recovery = plannerRetry(runId, error, (recovery?.attempt ?? 0) + 1, options);
				await waitForPlanningRetry(recovery.delayMs, options.signal);
				snapshot = options.store.snapshot(runId, multiPlanning(options));
				continue;
			}
			if (snapshot.run.status === "completed" || snapshot.run.status === "blocked") return snapshot;
			continue;
		}
		if (decision.kind === "blocked") {
			throwIfAborted(options.signal);
			options.store.setRunStatus(runId, "blocked", decision.reason);
			return options.store.snapshot(runId, multiPlanning(options));
		}
		if (decision.kind !== "execute" || !decision.task) {
			throw new Error(`Planner cannot progress: ${decision.reason}`);
		}
		throwIfAborted(options.signal);
		const lease = options.store.leaseTask(runId, decision.task.taskId, options.allowedScope, options.leaseTtlMs);
		executedSteps += 1;
		snapshot = await executePlanningAttempt(runId, lease, options);
		if (["completed", "blocked", "paused"].includes(snapshot.run.status)) return snapshot;
	}
	throwIfAborted(options.signal);
	options.store.setRunStatus(runId, "paused", "maximum planning steps reached");
	return options.store.snapshot(runId, multiPlanning(options));
}

async function executePlanningAttempt(
	runId: string,
	lease: PlanningTaskLease,
	options: PlanningHarnessOptions,
): Promise<PlanningSnapshot> {
	let snapshot = options.store.snapshot(runId, multiPlanning(options));
	let attemptStarted = false;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	const owned = new AbortController();
	if (options.requireTrustedCompletion)
		options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, owned.signal]) : owned.signal };
	try {
		throwIfAborted(options.signal);
		options.store.startLease(lease.leaseId);
		attemptStarted = true;
		if (options.requireTrustedCompletion) {
			heartbeat = setInterval(
				() => {
					if (options.signal?.aborted) return;
					try {
						options.store.renewLease(lease.leaseId, options.leaseTtlMs);
					} catch (error) {
						owned.abort(planningPersistenceFailure(error, runId, "lease renewal"));
					}
				},
				Math.max(1, Math.trunc(options.leaseTtlMs / 3)),
			);
		}
		throwIfAborted(options.signal);
		const executionSnapshot = options.store.snapshot(runId, multiPlanning(options));
		const renderedContext = renderPlanningContextWithSummary(
			executionSnapshot,
			lease,
			options.maximumExecutorContextBytes ?? options.maximumEvidenceBytes,
		);
		try {
			options.store.recordLifecycleEvent(
				runId,
				"planning_context_rendered",
				{ taskId: lease.taskId, leaseId: lease.leaseId, ...renderedContext.summary },
				Date.now(),
				`planning-context:${lease.leaseId}:executor`,
			);
		} catch (error) {
			throw planningPersistenceFailure(error, runId, "executor context diagnostics");
		}
		const persistEvidence = (item: PlanningEvidenceInput): void => {
			try {
				options.store.recordEvidence(lease.leaseId, boundedEvidenceItems([item], options.maximumEvidenceBytes));
				if (item.metadata?.verificationOutcome === "correct") options.onProgress?.();
			} catch (error) {
				throw planningPersistenceFailure(error, runId, "tool evidence");
			}
		};
		const attemptStartedAt = Date.now();
		const persistCheckpoint = (
			checkpointId: string,
			checkpoint: PlanningCheckpointInput,
			elapsedMs?: number,
			artifactWorkspace?: string,
		): PlanningCheckpoint => {
			try {
				const persistedCheckpoint = options.store.recordCheckpoint(
					lease.leaseId,
					checkpointId,
					checkpoint,
					Date.now(),
					elapsedMs ?? Math.max(0, Date.now() - attemptStartedAt),
					artifactWorkspace,
				);
				options.onProgress?.();
				return persistedCheckpoint;
			} catch (error) {
				if (error instanceof PlanningCheckpointValidationError) throw error;
				throw planningPersistenceFailure(error, runId, "planning checkpoint");
			}
		};
		const report = await options.executor.execute({
			onProgress: options.onProgress,
			handoffSnapshot: executionSnapshot,
			goal: executionSnapshot.run.goal,
			onPendingSettlement: (settlement) => {
				options.onPendingSettlement?.(settlement);
			},
			lease,
			context: renderedContext.text,
			availableEvidenceRefs: () =>
				options.store.snapshot(runId, multiPlanning(options)).evidence.map((item) => item.evidenceId),
			verificationHistory: () =>
				sharedVerificationHistory(options.store.snapshot(runId, multiPlanning(options)).evidence),
			taskProgress: () => options.store.snapshot(runId, multiPlanning(options)).evidenceCards ?? [],
			readEvidence: (evidenceId, offset, maxBytes, requestId) =>
				options.store.readEvidence(runId, evidenceId, {
					offset,
					maxBytes,
					requestId,
					taskId: lease.taskId,
					leaseId: lease.leaseId,
				}),
			recordEvidence: persistEvidence,
			recordSubmission: (result) => options.store.recordResultSubmission(lease.leaseId, result),
			recordCheckpoint: persistCheckpoint,
			evidenceCards: {
				publish: (card) => options.store.publishEvidenceCard(lease.leaseId, card),
				list: (after, limit) => options.store.listEvidenceCards(runId, after, limit),
			},
			listEvidence: (query) => {
				try {
					return options.store.listEvidence(runId, query);
				} catch (error) {
					if (error instanceof PlanningEvidenceListInputError) throw error;
					throw planningPersistenceFailure(error, runId, "observer evidence catalog");
				}
			},
			recordObservation: (source, summary, metadata) => {
				try {
					return options.store.recordObservation(lease.leaseId, source, summary, metadata);
				} catch (error) {
					throw planningPersistenceFailure(error, runId, "observer report");
				}
			},
			signal: options.signal,
		});
		for (const item of report?.evidence ?? []) persistEvidence(item);
		throwIfAborted(options.signal);
		if (!report?.result)
			throw planningFailure("executor", "executor_error", "Planning executor returned no task result");
		if (report.commitSource !== "planning_commit_result") {
			throw planningFailure(
				"executor",
				"executor_error",
				"Planning executor returned a result without planning_commit_result",
			);
		}
		if (report.result.leaseId !== lease.leaseId) {
			throw planningFailure("executor", "executor_error", "Executor returned a result for a different lease");
		}
		throwIfAborted(options.signal);
		try {
			// Store settlement returns the durable snapshot consumed by the next Supervisor.
			snapshot = options.store.commitResult({
				leaseId: lease.leaseId,
				planRevision: lease.planRevision,
				result: report.result,
				preserveTaskProvenance: multiPlanning(options),
				artifactWorkspace: report.artifactWorkspace,
				evidence: boundedEvidence({ ...report, evidence: reportEvidence(report) }, options.maximumEvidenceBytes),
			});
		} catch (error) {
			if (error instanceof PlanningResultValidationError) throw error;
			throw planningPersistenceFailure(error, runId, "task result");
		}
		const terminalSnapshot = completeAfterVerifiedEvidence(runId, snapshot, options);
		if (terminalSnapshot) return terminalSnapshot;
	} catch (error) {
		if (options.signal?.aborted) {
			// A sibling Store fault can arrive during trusted-terminal drain.
			// Preserve it for the parallel owner, which still gives the original
			// parent cancellation precedence over internal sibling cancellation.
			if (multiPlanning(options) && isPlanningFailureError(error) && error.code === "planning_persistence_error")
				throw error;
			throw abortError(options.signal);
		}
		const failure = isPlanningFailureError(error)
			? error
			: planningFailure(
					"executor",
					"executor_error",
					error instanceof Error ? error.message : String(error),
					error,
					runId,
				);
		if (failure.evidence.length > 0) {
			try {
				options.store.recordAttemptEvidence(
					lease.leaseId,
					boundedEvidenceItems(failure.evidence, options.maximumEvidenceBytes),
				);
			} catch (persistenceError) {
				throw planningPersistenceFailure(persistenceError, runId, "failed-attempt evidence");
			}
		}
		try {
			// A failed attempt is likewise handed forward from the sealed Store snapshot.
			snapshot = options.store.sealActiveLease({
				leaseId: lease.leaseId,
				source: "runtime_failure",
				stage: failure.stage,
				code: failure.code,
				message: failure.message,
				...(failure.progress ? { progress: failure.progress } : {}),
			});
		} catch (persistenceError) {
			throw planningPersistenceFailure(persistenceError, runId, "failed attempt");
		}
		// A later verifier call can exhaust the quota after this lease has already
		// persisted a trusted success. Settle that earlier result before reporting
		// quota exhaustion. In multi mode the trusted proof belongs to the run,
		// not necessarily to the sibling that exhausted the shared quota.
		if (failure.code === "verifier_quota_exhausted") {
			const verification = trustedPlanningVerificationFromSnapshot(snapshot);
			if (
				verification?.planningRunId === runId &&
				(multiPlanning(options) || (verification.taskId === lease.taskId && verification.leaseId === lease.leaseId))
			) {
				throwIfAborted(options.signal);
				recordAttemptRouting(
					runId,
					{
						leaseId: lease.leaseId,
						routingState: "terminal",
						replanAllowed: false,
						replanStarted: false,
						replanReason: "trusted verifier evidence persisted before quota exhaustion",
					},
					options,
				);
				const terminalSnapshot = completeAfterVerifiedEvidence(runId, snapshot, options);
				if (terminalSnapshot) return terminalSnapshot;
			}
		}
		if (isTerminalVerifierFailure(failure) || failure.code === "planning_persistence_error") {
			recordAttemptRouting(
				runId,
				{
					leaseId: lease.leaseId,
					routingState: "terminal",
					replanAllowed: false,
					replanStarted: false,
					replanReason: `non-recoverable failure: ${failure.code}`,
				},
				options,
			);
			throw failure;
		}
		if (!attemptStarted) {
			recordAttemptRouting(
				runId,
				{
					leaseId: lease.leaseId,
					routingState: "terminal",
					replanAllowed: false,
					replanStarted: false,
					replanReason: "attempt never started",
				},
				options,
			);
			throw failure;
		}
		if (options.signal?.aborted) {
			recordAttemptRouting(
				runId,
				{
					leaseId: lease.leaseId,
					routingState: "terminal",
					replanAllowed: false,
					replanStarted: false,
					replanReason: "parent or user cancellation after attempt sealing",
				},
				options,
			);
			throw abortError(options.signal);
		}
		let failedAttemptSnapshot: PlanningSnapshot;
		try {
			failedAttemptSnapshot = options.store.snapshot(runId, multiPlanning(options));
		} catch (persistenceError) {
			throw planningPersistenceFailure(persistenceError, runId, "terminal verifier evidence lookup");
		}
		const terminalSnapshot = completeAfterVerifiedEvidence(runId, failedAttemptSnapshot, options);
		if (terminalSnapshot) return terminalSnapshot;
		if (!multiPlanning(options) && options.store.getAttemptCount(runId) >= Math.max(1, options.maximumSteps)) {
			throwIfAborted(options.signal);
			recordAttemptRouting(
				runId,
				{
					leaseId: lease.leaseId,
					routingState: "terminal",
					replanAllowed: false,
					replanStarted: false,
					replanReason: "maximum planning steps reached after failed attempt",
				},
				options,
			);
			options.store.setRunStatus(runId, "paused", "maximum planning steps reached after a failed attempt");
			return options.store.snapshot(runId, multiPlanning(options));
		}
		recordAttemptRouting(
			runId,
			{
				leaseId: lease.leaseId,
				routingState: "replan_queued",
				replanAllowed: true,
				replanStarted: false,
				replanReason: "recoverable failed attempt queued for Supervisor",
			},
			options,
		);
	} finally {
		if (heartbeat) clearInterval(heartbeat);
	}
	return options.store.snapshot(runId, multiPlanning(options));
}

/**
 * Rolling PLAN_MULTI: consume ready work first; append work while siblings run.
 * One Supervisor call at a time, with Executor completions still being processed.
 */
async function runParallelPlanningHarness(runId: string, options: PlanningHarnessOptions): Promise<PlanningSnapshot> {
	const capacity = () => options.capacityControl?.getCapacity() ?? options.executionCapacity ?? 2;
	const pool = options.executorPool ?? new PlanningExecutorPool(capacity());
	const maximumSteps = Math.max(1, Math.trunc(options.maximumSteps));
	const stop = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
	const capacityReduced = new Error("Executor queue resized");
	const children = new Map<
		string,
		{ waiting: boolean; cancelWait: AbortController; settled: Promise<{ taskId: string; error?: unknown }> }
	>();
	let planner: Promise<{ proposal?: PlanningPlanProposal; error?: unknown; review: PlanningReviewState }> | undefined;
	let deferredPlannerFailure: PlanningFailureError | undefined;
	let recovery: ReturnType<typeof plannerRetry> | undefined;
	let retryAt = 0;
	let fatalChildFailure: PlanningFailureError | undefined;
	const deferPlannerFailure = (error: unknown): boolean => {
		if (recoverablePlannerFailure(error, options)) {
			recovery = plannerRetry(runId, error, (recovery?.attempt ?? 0) + 1, options);
			retryAt = Date.now() + recovery.delayMs;
			plannedState = "";
			return true;
		}
		if (
			children.size === 0 ||
			!isPlanningFailureError(error) ||
			![
				"supervisor_parse_error",
				"supervisor_validation_error",
				"proposal_validation_error",
				"duplicate_task_identity",
				"duplicate_task_signature",
			].includes(error.code)
		)
			return false;
		deferredPlannerFailure = error;
		return true;
	};
	let plannedState = "";
	const opportunityReview = new OpportunityReview();
	const artexWake = options.supervisor.eventPolicy ? new ArtexWake(options.supervisor.eventPolicy) : undefined;
	const reviewChanges = new PlanningReviewChanges();
	let plannedCheckpointId: string | undefined;
	const schedulingState = (snapshot: PlanningSnapshot) =>
		artexWake
			? JSON.stringify([capacity(), reviewChanges.wakeState(capturePlanningReview(snapshot))])
			: JSON.stringify([
					snapshot.run.revision,
					snapshot.hypothesisGraph?.version,
					snapshot.artexGraph?.version,
					snapshot.artexGraph?.nodes.length,
					capacity(),
					snapshot.latestCheckpoint?.checkpointId,
					snapshot.tasks.map((task) => [task.taskId, task.status]),
				]);
	let wakeResolve = () => {};
	const makeWake = () =>
		new Promise<void>((resolve) => {
			wakeResolve = resolve;
		});
	let wake = makeWake();
	const notify = () => wakeResolve();
	const unsubscribeCapacity = options.capacityControl?.subscribe(() => {
		if (!options.executorPool) pool.setCapacity(capacity());
		notify();
	});
	const unsubscribePool = pool.subscribe(notify);
	options.signal?.addEventListener("abort", notify, { once: true });
	let failed = false;
	let failure: unknown;
	const drainChildren = async (): Promise<void> => {
		await Promise.all([...[...children.values()].map((child) => child.settled), ...(planner ? [planner] : [])]);
		// Proof remains durable, but a Store fault is not a healthy completion.
		// Check after all callbacks settle; original parent cancellation wins.
		if (fatalChildFailure && !options.signal?.aborted) throw fatalChildFailure;
	};
	try {
		while (true) {
			if (fatalChildFailure) {
				throwIfAborted(options.signal);
				throw fatalChildFailure;
			}
			let snapshot = options.store.snapshot(runId, true);
			if (!["completed", "blocked", "failed", "cancelled"].includes(snapshot.run.status)) {
				snapshot = completeAfterVerifiedEvidence(runId, snapshot, options) ?? snapshot;
			}
			if (["completed", "blocked", "failed", "cancelled"].includes(snapshot.run.status)) {
				stop.abort(new Error("Planning run settled"));
				await drainChildren();
				children.clear();
				if (snapshot.run.status === "completed")
					options.store.cancelActiveLease(runId, "trusted result completed; remaining attempts stopped");
				return options.store.snapshot(runId, true);
			}
			throwIfAborted(options.signal);
			// Shrinking does not abort workers. Cancel only surplus host-slot waiters.
			let excess = children.size - capacity();
			for (const child of [...children.values()].reverse()) {
				if (excess <= 0) break;
				if (child.waiting && !child.cancelWait.signal.aborted) {
					child.cancelWait.abort(capacityReduced);
					excess--;
				}
			}
			const ready = readyPlanningTasks(snapshot).filter((task) => !children.has(task.taskId));
			for (const task of ready) {
				const waiting = [...children.values()].filter((child) => child.waiting).length;
				if (children.size >= capacity() || options.store.getAttemptCount(runId) + waiting >= maximumSteps) break;
				const child = {
					waiting: true,
					cancelWait: new AbortController(),
					settled: Promise.resolve({ taskId: task.taskId }) as Promise<{ taskId: string; error?: unknown }>,
				};
				children.set(task.taskId, child);
				child.settled = (async () => {
					const waitSignal = AbortSignal.any([signal, child.cancelWait.signal]);
					const queuedAt = Date.now();
					options.store.recordLifecycleEvent(runId, "executor_queue_start", {
						taskId: task.taskId,
						...pool.getStatus(),
					});
					const release = await pool.acquire(waitSignal);

					let pendingSettlement: Promise<void> | undefined;
					try {
						options.store.recordLifecycleEvent(runId, "executor_queue_end", {
							taskId: task.taskId,
							queueWaitMs: Date.now() - queuedAt,
						});
						throwIfAborted(waitSignal);
						const current = options.store.snapshot(runId, true);
						if (current.run.status === "completed") return;
						if ((current.activeLeases?.length ?? 0) >= capacity()) throw capacityReduced;
						const lease = options.store.leaseTask(
							runId,
							task.taskId,
							options.allowedScope,
							options.leaseTtlMs,
							Date.now(),
							capacity(),
						);
						child.waiting = false;
						notify();
						await executePlanningAttempt(runId, lease, {
							...options,
							signal,
							onProgress: () => {
								options.onProgress?.();
								notify();
							},
							onPendingSettlement: (settlement) => {
								pendingSettlement = settlement;
								options.onPendingSettlement?.(settlement);
							},
						});
					} finally {
						// Pi's pending settlement retains ownership until idle, even
						// when abort or later disposal reports an error.
						if (pendingSettlement) void pendingSettlement.then(release, release);
						else release();
					}
				})().then(
					() => ({ taskId: task.taskId }),
					(error: unknown) => {
						// Do not lose a hard Store fault when trusted completion wins
						// the event race or when siblings are being drained.
						if (isPlanningFailureError(error) && error.code === "planning_persistence_error")
							fatalChildFailure ??= error;
						return { taskId: task.taskId, error };
					},
				);
			}
			snapshot = options.store.snapshot(runId, true);
			const waiting = [...children.values()].filter((child) => child.waiting).length;
			const budgetAvailable =
				options.store.getAttemptCount(runId) + waiting < maximumSteps &&
				snapshot.tasks.length < options.maximumTasks;
			const vacancies = Math.max(0, capacity() - children.size);
			const checkpoint = snapshot.latestCheckpoint;
			const actionableCheckpoint =
				checkpoint &&
				checkpoint.checkpointId !== plannedCheckpointId &&
				(checkpoint.suggestedNextSteps.length > 0 || checkpoint.rejectedDirections.length > 0);
			// Artex can review new knowledge while slots are full. Ownership bookkeeping
			// and the planner's own TODO/hints do not themselves create new knowledge.
			const state = schedulingState(snapshot);
			opportunityReview.update(state, children.size, capacity());
			artexWake?.observe(state);
			const timedReview = children.size === 1 && opportunityReview.due();
			if (
				!planner &&
				Date.now() >= retryAt &&
				budgetAvailable &&
				(artexWake
					? artexWake.delay() === 0
					: vacancies > 0 &&
						readyPlanningTasks(snapshot).every((task) => children.has(task.taskId)) &&
						(state !== plannedState || timedReview))
			) {
				const decision = schedulePlanningTask(snapshot, vacancies);
				if (artexWake) decision.kind = "replan";
				if (actionableCheckpoint && decision.kind === "waiting") decision.kind = "replan";
				if (options.requireTrustedCompletion && decision.kind === "blocked") decision.kind = "replan";
				if (decision.kind === "blocked") {
					options.store.setRunStatus(runId, "blocked", decision.reason);
					return options.store.snapshot(runId, true);
				}
				if (decision.kind === "replan") {
					const review = capturePlanningReview(snapshot);
					const changes = reviewChanges.changes(review);
					if (artexWake)
						options.store.recordLifecycleEvent(runId, "artex_planner_wake", {
							graphVersion: snapshot.artexGraph?.version ?? 0,
							activeCount: children.size,
							reason: recovery ? "recovery" : changes.initial ? "initial" : artexWake.reason(),
						});
					options.store.recordLifecycleEvent(
						runId,
						"planning_changes_presented",
						planningChangesOverview(changes),
					);
					if (timedReview && !artexWake)
						options.store.recordLifecycleEvent(runId, "planning_opportunity_review", {
							origin: "host_timer",
							activeCount: children.size,
							capacity: capacity(),
						});
					opportunityReview.reviewed(Date.now(), timedReview);
					plannedState = state;
					plannedCheckpointId = checkpoint?.checkpointId;
					deferredPlannerFailure = undefined;
					planner = options.supervisor
						.propose({
							snapshot,
							changes,
							recovery,
							signal,
							scheduling: { capacity: capacity(), occupied: children.size, available: vacancies },
						})
						.then(
							(proposal) => ({ proposal, review }),
							(error: unknown) => ({ error, review }),
						);
				}
			}
			if (children.size === 0 && !planner) {
				if (budgetAvailable && recovery && Date.now() < retryAt) {
					await waitForPlanningRetry(retryAt - Date.now(), signal);
					plannedState = "";
					continue;
				}
				if (deferredPlannerFailure) throw deferredPlannerFailure;
				if (artexWake && budgetAvailable) {
					await waitForPlanningRetry(Math.max(1, artexWake.delay()), signal);
					continue;
				}
				if (budgetAvailable && pool.getStatus().active >= pool.getStatus().capacity) {
					await wake;
					wake = makeWake();
					throwIfAborted(options.signal);
					continue;
				}
				if (options.requireTrustedCompletion && budgetAvailable) {
					// A valid proposal can become unrunnable after an earlier dependency fails.
					// This is planning feedback, never a terminal state for the managed outer task.
					deferPlannerFailure(
						planningFailure(
							"proposal_validation",
							"proposal_validation_error",
							"No runnable task remains, but the goal is unverified. Append an independently runnable recovery task using existing evidence. Do not depend on failed, blocked or pruned tasks. Preserve completed work and continue within the outer budget.",
						),
					);
					continue;
				}
				options.store.setRunStatus(
					runId,
					budgetAvailable ? "blocked" : "paused",
					budgetAvailable ? "Supervisor has no further task" : "maximum planning attempt or task budget reached",
				);
				return options.store.snapshot(runId, true);
			}
			const reviewTimer = new AbortController();
			const event = await Promise.race([
				...Array.from(children.values(), (child) =>
					child.settled.then((result) => ({ kind: "executor" as const, result })),
				),
				...(planner ? [planner.then((result) => ({ kind: "planner" as const, result }))] : []),
				wake.then(() => ({ kind: "capacity" as const })),
				...(!planner && artexWake && budgetAvailable
					? [
							wait(Math.max(1, artexWake.delay(), retryAt - Date.now()), undefined, {
								signal: AbortSignal.any([signal, reviewTimer.signal]),
							}).then(() => ({ kind: "capacity" as const })),
						]
					: []),
				...(!planner && !artexWake && children.size === 1 && vacancies > 0 && budgetAvailable
					? [
							opportunityReview
								.wait(AbortSignal.any([signal, reviewTimer.signal]))
								.then(() => ({ kind: "capacity" as const })),
						]
					: []),
				...(!planner && recovery && budgetAvailable && vacancies > 0
					? [
							waitForPlanningRetry(Math.max(1, retryAt - Date.now()), signal).then(() => ({
								kind: "capacity" as const,
							})),
						]
					: []),
			]);
			reviewTimer.abort();
			if (event.kind === "capacity") {
				wake = makeWake();
				continue;
			}
			if (event.kind === "executor") {
				children.delete(event.result.taskId);
				if (
					"error" in event.result &&
					event.result.error !== capacityReduced &&
					options.store.snapshot(runId).run.status !== "completed"
				) {
					throw event.result.error;
				}
				continue;
			}
			planner = undefined;
			snapshot = options.store.snapshot(runId, true);
			throwIfAborted(options.signal);
			if (snapshot.run.status === "completed") continue;
			if ("error" in event.result) {
				if (deferPlannerFailure(event.result.error)) continue;
				throw event.result.error;
			}
			const proposal = event.result.proposal;
			if (!proposal) throw new Error("Supervisor returned no proposal");
			if (proposal.hypothesisUpdate && proposal.decision === "blocked") {
				const owners = new Set((snapshot.activeLeases ?? []).map((lease) => lease.taskId));
				if (
					!proposal.hypothesisWaitingTaskIds?.length ||
					proposal.hypothesisWaitingTaskIds.some((id) => !owners.has(id))
				) {
					deferPlannerFailure(
						planningFailure(
							"proposal_validation",
							"proposal_validation_error",
							"A named waiting owner finished during planning; reconsider the current gaps without stopping live siblings",
						),
					);
					continue;
				}
			}
			if (
				!proposal.artexUpdate &&
				proposal.decision === "blocked" &&
				(children.size > 0 || schedulingState(snapshot) !== plannedState)
			) {
				const reviewedChanges = reviewChanges.changes(event.result.review);
				reviewChanges.acknowledge(event.result.review);
				options.store.recordLifecycleEvent(runId, "planning_changes_reviewed", { ...reviewedChanges });
				continue;
			}
			// Executions may finish during planning. Validate against fresh durable
			// state; only this Supervisor appends plans, so no evidence-only revision.
			try {
				const appended = commitSupervisorDecision(runId, snapshot, proposal, options);
				const reviewedChanges = reviewChanges.changes(event.result.review);
				reviewChanges.acknowledge(
					event.result.review,
					capturePlanningReview(snapshot),
					capturePlanningReview(appended),
				);
				options.store.recordLifecycleEvent(runId, "planning_changes_reviewed", {
					...reviewedChanges,
				});
				recovery = undefined;
				retryAt = 0;
				if (proposal.decision === "create_tasks") plannedState = schedulingState(appended);
				artexWake?.reviewed(JSON.stringify([capacity(), reviewChanges.wakeState()]));
				artexWake?.observe(schedulingState(appended));
			} catch (error) {
				if (!deferPlannerFailure(error)) throw error;
			}
		}
	} catch (error) {
		failed = true;
		failure = error;
		throw error;
	} finally {
		unsubscribeCapacity?.();
		unsubscribePool();
		options.signal?.removeEventListener("abort", notify);
		stop.abort(failed ? failure : new Error("Planning parallel execution settled"));
		await drainChildren();
		if (!failed && options.store.snapshot(runId, true).run.status === "completed")
			options.store.cancelActiveLease(runId, "trusted result completed; remaining attempts stopped");
	}
}
