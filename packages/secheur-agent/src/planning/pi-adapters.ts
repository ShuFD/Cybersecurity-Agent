import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { InlineExtension, ModelRuntime, PromptOptions } from "@earendil-works/pi-coding-agent";
import type { SecHeurConfig } from "../config.ts";
import type { KnowledgeTaskInput } from "../knowledge-retrieval.ts";
import { type RunPiCodingTaskOptions, runPiCodingTask, type VerifierInfrastructureError } from "../subagent.ts";
import { artexExecutorContext, artexObservationSchema } from "./artex-adapters.ts";
import { renderSupervisorContextWithSummary } from "./context.ts";
import {
	type PlanningEvidenceInput,
	type PlanningExecutionReport,
	parsePlanningPlanProposal,
	planningTaskSignature,
	type SuggestedPlanningTask,
	validatePlanningDependencies,
	validatePlanningTaskIdentities,
} from "./contracts.ts";
import { evidenceBoardView } from "./evidence-cards.ts";
import { readEvidenceBlob } from "./evidence-store.ts";
import { evidenceCardExtension } from "./evidence-tools.ts";
import {
	ensurePlanningFailure,
	isPlanningFailureError,
	type PlanningFailureError,
	PlanningPersistenceError,
	planningFailure,
	withPlanningFailureEvidence,
} from "./failures.ts";
import { progressiveHandoff, renderPlanningHandoff } from "./handoff-contract.ts";
import type { PlanningExecutor, PlanningSupervisor } from "./harness.ts";
import { hypothesisExecutorContext, hypothesisObservationSchema } from "./hypothesis-adapters.ts";
import { PlanningObserverRuntime } from "./observer.ts";
import { validatePlanningCoverage } from "./planner-memory.ts";
import { PlanningProgressFeedback } from "./progress-feedback.ts";
import { normalizePlanningIncrement } from "./proposal-increment.ts";
import { ProposalOutputError } from "./proposal-json.ts";
import { generatePlanningProposal } from "./proposal-model.ts";
import { planningProposalSchema } from "./proposal-schema.ts";
import { planningToolFailureMetadata } from "./proposal-session.ts";
import { createPlanningCommitExtension } from "./result-tool.ts";
import { planningChangesOverview } from "./review-changes.ts";
import type { PlanRunObserver } from "./run-observer.ts";
import { renderSharedTaskProgress, renderSharedVerificationHistory } from "./shared-feedback.ts";
import type { PlanningSourceBindings } from "./source-bindings.ts";
import { captureToolEvidence } from "./tool-evidence.ts";

export const PLANNING_TOOL_EXCLUSIONS = ["plan_expand", "plan_revise", "plan_status", "competition_set_plan"];
export const MAX_SUPERVISOR_CORRECTIONS = 2;
// A length-truncated answer is not useful as another full prompt. Keep the
// correction focused on producing one short proposal.
export const MAX_CORRECTION_OUTPUT_CHARS = 8_000;

type SupervisorAttemptType = "primary" | "format_correction" | "validation_correction";

function supervisorAttemptLabel(attemptType: SupervisorAttemptType): "primary" | "correction" {
	return attemptType === "primary" ? "primary" : "correction";
}

function planningFailureCode(error: unknown): string | undefined {
	return isPlanningFailureError(error) ? error.code : undefined;
}

function boundedCorrectionOutput(output: string): {
	text: string;
	originalOutputChars: number;
	correctionInputChars: number;
	truncated: boolean;
} {
	const text = output.slice(0, MAX_CORRECTION_OUTPUT_CHARS);
	return {
		text,
		originalOutputChars: output.length,
		correctionInputChars: text.length,
		truncated: text.length < output.length,
	};
}

export interface PiPlanningExtensionBundle {
	extensionFactories: InlineExtension[];
	close(): void;
	backgroundTasks?: RunPiCodingTaskOptions["backgroundTasks"];
}

export interface PlanningChildScope {
	leaseId: string;
	taskId: string;
	cwd: string;
	onProgress?: () => void;
}

export interface PiPlanningAdapterOptions {
	runObserver?: PlanRunObserver;
	sourceBindings?: PlanningSourceBindings;
	beforeDispatch?: (signal?: AbortSignal) => Promise<void>;
	config: SecHeurConfig;
	cwd: string;
	model?: Model<Api>;
	modelRuntime?: ModelRuntime;
	thinkingLevel?: ThinkingLevel;
	extensionFactories?: InlineExtension[];
	createExtensionBundle?: (scope?: PlanningChildScope) => PiPlanningExtensionBundle;
	allowedTools?: string[];
	images?: PromptOptions["images"];
	taskTimeoutMs?: number;
	onModelTurn?: (cost: number) => void;
	onLifecycleEvent?: (type: string, payload: Record<string, unknown>) => void;
}

function timeoutSignal(timeoutMs: number | undefined): AbortSignal | undefined {
	return timeoutMs === undefined ? undefined : AbortSignal.timeout(Math.max(1, Math.trunc(timeoutMs)));
}

function combinedSignal(parent: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
	return mergeSignals([parent, timeoutSignal(timeoutMs)]);
}

function mergeSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
	if (active.length === 0) return undefined;
	if (active.length === 1) return active[0];
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

function throwIfAborted(signal: AbortSignal | undefined, fallback: string): void {
	if (!signal?.aborted) return;
	const reason = signal.reason;
	if (reason instanceof Error) throw reason;
	const error = new Error(typeof reason === "string" && reason.trim() ? reason : fallback);
	error.name = "AbortError";
	throw error;
}

function lifecycleError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function executorFailureDiagnostics(error: unknown): {
	failureSource: string;
	failureStage: string;
	failureCode: string;
} {
	if (isPlanningFailureError(error)) {
		return {
			failureSource: error.source,
			failureStage: error.stage,
			failureCode: error.code,
		};
	}
	return {
		failureSource: "unknown",
		failureStage: "unknown",
		failureCode: "unclassified",
	};
}

export function verifierPlanningFailure(error: VerifierInfrastructureError, runId: string): PlanningFailureError {
	const knownCategories = new Set([
		"quota_exhausted",
		"timeout",
		"transport_error",
		"protocol_error",
		"invalid_request",
		"identity_conflict",
		"identity_missing",
		"aborted",
	]);
	const code = knownCategories.has(error.failureCategory)
		? `verifier_${error.failureCategory}`
		: "verifier_unavailable";
	return planningFailure("executor", code, error.message, error, runId);
}

/**
 * Turn one knowledge suggestion into a schedulable planning task.
 *
 * The acceptance check stays deterministic: a verified method is applied and
 * must record its outcome, while an unverified candidate may only buy a
 * read-only verification and must be dropped (not retried) once contradicted.
 * The card id travels in the objective so the decision trace can join the
 * resulting evidence back to the knowledge that motivated it.
 */
export function knowledgeTaskInputToSuggestedTask(input: KnowledgeTaskInput): SuggestedPlanningTask {
	const acceptance =
		input.missing_preconditions.length > 0
			? input.missing_preconditions.join("; ")
			: "one new observation confirms the technique applies";
	const verified = input.applicability === "verified_applicable";
	return {
		objective: `${input.suggested_action.goal} [knowledge:${input.knowledge_id} technique:${input.technique}]`,
		doneWhen: verified
			? `The technique runs once and the result is recorded as evidence; acceptance: ${acceptance}`
			: `Evidence records whether ${acceptance} holds; if it is contradicted, report the direction as rejected instead of retrying it`,
		priority: verified ? 1 : 0,
		...(verified ? { dependsOnCurrent: true } : {}),
	};
}

export function isVerifierInfrastructureFailure(error: unknown): error is VerifierInfrastructureError {
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as Record<string, unknown>;
	return (
		candidate.source === "verifier" &&
		candidate.code === "verifier_infrastructure_error" &&
		typeof candidate.failureCategory === "string"
	);
}

function persistencePlanningFailure(error: unknown, runId: string): PlanningFailureError {
	if (isPlanningFailureError(error) && error.code === "planning_persistence_error") return error;
	return planningFailure(
		"executor",
		"planning_persistence_error",
		`Planning evidence/checkpoint persistence failed: ${lifecycleError(error)}`,
		error instanceof PlanningPersistenceError ? error.cause : error,
		runId,
	);
}

function assistantStopReason(messages: readonly unknown[] | undefined): string | undefined {
	if (!messages) return undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "assistant")
			continue;
		return "stopReason" in message && typeof message.stopReason === "string" ? message.stopReason : undefined;
	}
	return undefined;
}

export class PiPlanningSupervisor implements PlanningSupervisor {
	private readonly options: PiPlanningAdapterOptions;

	constructor(options: PiPlanningAdapterOptions) {
		this.options = options;
	}

	async propose(input: Parameters<PlanningSupervisor["propose"]>[0]) {
		const runId = input.snapshot.run.runId;
		const revision = input.snapshot.run.revision;
		const cardSummaries = new Map(
			(input.snapshot.evidenceCards ?? []).flatMap((card) =>
				card.evidenceRefs.map((id) => [id, card.summary] as const),
			),
		);
		const startedAt = Date.now();
		let phase = "start";
		const emitLifecycle = (type: string, payload: Record<string, unknown> = {}): void => {
			try {
				this.options.onLifecycleEvent?.(type, {
					...payload,
					runId,
					revision,
					elapsedMs: Math.max(0, Date.now() - startedAt),
				});
			} catch {
				// Diagnostic observers must never change planning semantics.
			}
		};
		throwIfAborted(input.signal, "Supervisor planning operation aborted");
		emitLifecycle("supervisor_propose_start");
		const allowedDependencyTaskIds = input.snapshot.tasks.map((task) => task.taskId);
		let correctionsUsed = 0;
		const consumeCorrection = (): boolean => {
			if (correctionsUsed >= MAX_SUPERVISOR_CORRECTIONS) return false;
			correctionsUsed += 1;
			return true;
		};
		const runSupervisor = async (
			task: string,
			attemptType: SupervisorAttemptType,
			metadata: Record<string, unknown> = {},
		) => {
			if (input.changes)
				task = `Changes since the last accepted review (exact current-run IDs): ${JSON.stringify(planningChangesOverview(input.changes))}\n\n${task}`;
			if (input.recovery)
				task += `\nPrevious proposal rejected: ${JSON.stringify(input.recovery)}. Correct that error against the current snapshot. Do not recreate completed or running tasks.`;
			if (input.scheduling)
				task += `\nScheduling: ${JSON.stringify(input.scheduling)}. Running tasks continue while you plan. Append useful next tasks; do not recreate running tasks or fill slots with unnecessary work. blocked is only a wait with coverage.remaining (question, current ownerId or live dependsOn, evidenceIds) and coverage.recheckOn. If nobody can advance the remaining work, submit a concrete next task, not blocked.`;
			task =
				"Minimize critical-path latency. Identify the immediate blocking work and independently executable side work before choosing tasks. With two available slots, check whether two distinct bounded investigations can start immediately; use both when they produce different useful outputs without waiting on each other. Each task must state its question and concrete deliverable, rather than assigning the entire unresolved goal to one worker. Keep tightly dependent local steps in one worker; do not split individual reads or tool calls. Reuse persisted evidence and preserve running owners. If no independent work exists, explain that in rationale instead of inventing filler or duplicate work.\n\n" +
				task;
			const attempt = supervisorAttemptLabel(attemptType);
			phase = attempt;
			throwIfAborted(input.signal, "Supervisor planning operation aborted");
			emitLifecycle("supervisor_attempt_start", { attempt, attemptType, ...metadata });
			try {
				const result = await generatePlanningProposal({
					nativeSession: {
						queryPolicy: "board_only",
						compactBoardContext: {
							changes: input.changes ? planningChangesOverview(input.changes) : undefined,
							evidenceBoard: evidenceBoardView(input.snapshot.evidenceCards ?? []),
						},
						readonlyContext: {
							run: input.snapshot.run,
							changes: {
								delta: input.changes ? planningChangesOverview(input.changes) : undefined,
								checkpoint: input.snapshot.latestCheckpoint,
								failure: input.snapshot.latestFailure,
								scheduling: input.scheduling,
								currentOwners: input.snapshot.tasks
									.filter((t) => ["leased", "running"].includes(t.status))
									.map((t) => ({ taskId: t.taskId, objective: t.objective })),
							},
							tasks: input.snapshot.tasks,
							evidence: input.snapshot.evidence.map((item) => ({
								evidenceId: item.evidenceId,
								taskId: item.taskId,
								toolName: item.toolName,
								isError: item.metadata.isError,
							})),
							evidenceBoard: evidenceBoardView(input.snapshot.evidenceCards ?? []),
							executionFrame: input.snapshot.executionFrame,
							sourceBindings: this.options.sourceBindings?.list() ?? [],
							observerNotes: this.options.runObserver?.overview() ?? [],
						},
						readEvidence: (id, offset, limit) => {
							const evidence = input.snapshot.evidence.find(
								(item) => item.evidenceId === id && item.runId === runId,
							);
							if (!evidence?.contentRef) throw new Error("Original evidence not available in this run");
							return readEvidenceBlob({
								stateDir: this.options.config.stateDir,
								contentRef: evidence.contentRef,
								contentHash: evidence.contentHash ?? undefined,
								offset,
								maxBytes: limit,
							});
						},
						normalizeSubmission: (value) =>
							normalizePlanningIncrement(value, {
								engine: "progressive",
								revision: input.snapshot.run.revision,
								priorWork: input.snapshot.tasks.length > 0,
								evidenceIds: input.snapshot.evidence.map((item) => item.evidenceId),
							}),
						validateSubmission: (value) => {
							const proposal = parsePlanningPlanProposal(JSON.stringify(value), input.snapshot.run.revision);
							if (proposal.decision === "blocked") {
								const owners = input.snapshot.tasks
									.filter((t) => ["leased", "running"].includes(t.status))
									.map((t) => t.taskId);
								validatePlanningCoverage(
									proposal.coverage,
									owners,
									owners,
									input.snapshot.evidence.map((e) => e.evidenceId),
								);
							}
							const error = validateProposal(proposal, attemptType);
							if (error) throw error;
						},
					},
					beforeDispatch: this.options.beforeDispatch,
					outputSchema: planningProposalSchema,
					onModelTurn: this.options.onModelTurn,
					config: this.options.config,
					cwd: this.options.cwd,
					model: this.options.model,
					modelRuntime: this.options.modelRuntime,
					thinkingLevel: this.options.thinkingLevel,
					task,
					signal: combinedSignal(input.signal, this.options.taskTimeoutMs),
					onLifecycleEvent: (type, payload = {}) => emitLifecycle(type, { ...payload, attempt, attemptType }),
				});
				throwIfAborted(input.signal, "Supervisor planning operation aborted");
				emitLifecycle("supervisor_attempt_end", {
					attempt,
					attemptType,
					outputChars: result.finalText.length,
					stopReason: assistantStopReason(result.messages),
				});
				return result;
			} catch (error) {
				emitLifecycle("supervisor_attempt_end", {
					attempt,
					attemptType,
					error: lifecycleError(error),
					...(planningFailureCode(error) ? { failureCode: planningFailureCode(error) } : {}),
				});
				if (input.signal?.aborted || isPlanningFailureError(error)) throw error;
				if (error instanceof ProposalOutputError)
					throw planningFailure("supervisor_parse", "supervisor_parse_error", error.message, error, runId);
				throw planningFailure("supervisor", "planning_internal_error", lifecycleError(error), error, runId);
			}
		};
		const parseProposal = (
			result: Awaited<ReturnType<typeof generatePlanningProposal>>,
			attemptType: SupervisorAttemptType,
		): ReturnType<typeof parsePlanningPlanProposal> => {
			const attempt = supervisorAttemptLabel(attemptType);
			phase = attemptType === "primary" ? "parse" : `${attemptType}_parse`;
			const outputChars = result.finalText.length;
			const stopReason = assistantStopReason(result.messages);
			emitLifecycle("supervisor_parse_start", { attempt, attemptType, outputChars, stopReason });
			try {
				const parsed = parsePlanningPlanProposal(result.finalText, input.snapshot.run.revision);
				emitLifecycle("supervisor_parse_end", {
					attempt,
					attemptType,
					outputChars,
					stopReason,
					parseSucceeded: true,
				});
				return parsed;
			} catch (error) {
				const parseError = ensurePlanningFailure(error, {
					stage: "supervisor_parse",
					code: "supervisor_parse_error",
					runId,
				});
				const parseSucceeded = parseError.code !== "supervisor_parse_error";
				emitLifecycle("supervisor_parse_end", {
					attempt,
					attemptType,
					outputChars,
					stopReason,
					parseSucceeded,
					...(parseSucceeded ? { validationSucceeded: false } : {}),
					failureCode: parseError.code,
					error: lifecycleError(parseError),
				});
				throw parseError;
			}
		};
		const validateProposal = (
			proposal: ReturnType<typeof parsePlanningPlanProposal>,
			attemptType: SupervisorAttemptType,
		): PlanningFailureError | undefined => {
			const attempt = supervisorAttemptLabel(attemptType);
			try {
				if (proposal.decision === "create_tasks" && proposal.tasks.length === 0) {
					throw planningFailure(
						"proposal_validation",
						"proposal_validation_error",
						"create_tasks requires at least one independently runnable task. If existing owners are still working, report blocked to wait; otherwise propose a concrete recovery task using saved evidence.",
					);
				}
				if (proposal.decision === "finish_run") {
					const knownEvidenceIds = new Set(input.snapshot.evidence.map((item) => item.evidenceId));
					const answerEvidenceRefs = proposal.answerEvidenceRefs ?? [];
					if (answerEvidenceRefs.length === 0) {
						throw planningFailure(
							"proposal_validation",
							"proposal_validation_error",
							"Supervisor cannot finish the run without persisted answer evidence",
						);
					}
					const unknownEvidenceIds = answerEvidenceRefs.filter((id) => !knownEvidenceIds.has(id));
					if (unknownEvidenceIds.length > 0) {
						throw planningFailure(
							"proposal_validation",
							"proposal_validation_error",
							`Supervisor finish_run references unknown evidence: ${unknownEvidenceIds.join(", ")}`,
						);
					}
				}
				validatePlanningTaskIdentities(runId, proposal, input.snapshot.tasks);
				const knownSignatures = new Map(
					input.snapshot.tasks.map((task) => [planningTaskSignature(task), task.taskId]),
				);
				for (const task of proposal.tasks) {
					const duplicateTaskId = knownSignatures.get(planningTaskSignature(task));
					if (duplicateTaskId) {
						throw planningFailure(
							"supervisor_validation",
							"duplicate_task_signature",
							`Planning task repeats the same objective, doneWhen, and input evidence as ${duplicateTaskId}`,
						);
					}
				}
				validatePlanningDependencies(proposal, input.snapshot);
				return undefined;
			} catch (error) {
				const validationError = isPlanningFailureError(error)
					? error
					: planningFailure(
							"supervisor_validation",
							"supervisor_validation_error",
							error instanceof Error ? error.message : String(error),
							error,
							runId,
						);
				const identityConflict =
					validationError.code === "duplicate_task_identity" ||
					validationError.code === "duplicate_task_signature";
				emitLifecycle(
					identityConflict
						? "supervisor_task_identity_validation_failed"
						: "supervisor_dependency_validation_failed",
					{
						attempt,
						attemptType,
						parseSucceeded: true,
						validationSucceeded: false,
						failureCode: validationError.code,
						...(identityConflict
							? { validationError: validationError.message }
							: { dependencyError: validationError.message }),
					},
				);
				return validationError;
			}
		};
		const completionPayload = (
			proposal: ReturnType<typeof parsePlanningPlanProposal>,
			result: Awaited<ReturnType<typeof generatePlanningProposal>>,
			attemptType: SupervisorAttemptType,
		): Record<string, unknown> => ({
			decision: proposal.decision,
			taskCount: proposal.tasks.length,
			attempt: supervisorAttemptLabel(attemptType),
			attemptType,
			outputChars: result.finalText.length,
			stopReason: assistantStopReason(result.messages),
			parseSucceeded: true,
			validationSucceeded: true,
		});
		const formatCorrectionPrompt = (
			parseError: PlanningFailureError,
			bounded: ReturnType<typeof boundedCorrectionOutput>,
		): string =>
			[
				"The previous response was not a valid Planning proposal.",
				"Convert it into exactly one valid Planning JSON object.",
				"Preserve the intended next action when recoverable.",
				"Do not investigate the challenge, call tools, or add explanation or Markdown.",
				`Current revision: ${input.snapshot.run.revision}`,
				`allowedDependencyTaskIds:\n${JSON.stringify(allowedDependencyTaskIds, null, 2)}`,
				'Proposal contract:\n{\n  "decision": "create_tasks | finish_run | blocked",\n  "rationale": "...",\n  "tasks": [{"key": "...", "objective": "...", "doneWhen": "...", "priority": 0, "dependsOn": [], "inputEvidenceRefs": []}],\n  "answerEvidenceRefs": []\n}',
				"For create_tasks, inputEvidenceRefs is optional. When useful, copy complete persisted evidenceId values exactly from this run's rendered Planning context; do not use toolCallId, taskId, contentRef, or artifact paths. An empty or omitted list is valid for a new exploration task.",
				`Parser error: ${parseError.message}`,
				`Previous malformed output (bounded; ${bounded.correctionInputChars}/${bounded.originalOutputChars} characters):`,
				bounded.text,
				"Return the corrected JSON proposal only.",
			].join("\n\n");
		const validationCorrectionPrompt = (
			validationError: PlanningFailureError,
			previousProposal: ReturnType<typeof parsePlanningPlanProposal> | undefined,
			previousOutput: string | undefined,
		): string => {
			const referencedTaskIds = new Set(previousProposal?.answerEvidenceRefs ?? []);
			const eligibleEvidence = [
				...input.snapshot.evidence.filter((item) => referencedTaskIds.has(item.taskId)),
				...input.snapshot.evidence.filter((item) => !referencedTaskIds.has(item.taskId)).reverse(),
			].slice(0, 64);
			const previous = previousProposal
				? `Previous proposal:\n${JSON.stringify(previousProposal, null, 2)}`
				: (() => {
						const bounded = boundedCorrectionOutput(previousOutput ?? "");
						return [
							`Previous JSON output (bounded; ${bounded.correctionInputChars}/${bounded.originalOutputChars} characters):`,
							bounded.text,
						].join("\n");
					})();
			return [
				"The previous response was valid JSON but did not satisfy the Planning proposal contract.",
				"Return exactly one corrected Planning JSON proposal.",
				"Preserve the intended next action when recoverable.",
				"Do not investigate the challenge, call tools, or add explanation or Markdown.",
				`Current revision: ${input.snapshot.run.revision}`,
				`Allowed existing taskIds:\n${allowedDependencyTaskIds.length > 0 ? allowedDependencyTaskIds.join("\n") : "(none)"}`,
				this.options.config.executionMode?.mode === "plan_multi"
					? "For create_tasks return a small set of tasks with key, objective, doneWhen, priority, and dependsOn; dependencies may reference keys in this proposal."
					: "For create_tasks return exactly one task with key, objective, doneWhen, priority, and dependsOn.",
				"Do not invent evidence IDs or bypass task identity and dependency validation.",
				"Do not recreate any terminal task (done, disproved, blocked, failed, or pruned). Do not append a revision or random suffix to an existing key. Choose a genuinely new next action/key and new evidence or a materially different method.",
				"Do not depend on failed, blocked or pruned tasks. Their evidence remains readable through inputEvidenceRefs without waiting for their completion.",
				"inputEvidenceRefs is optional; if present, each entry must be a complete persisted evidenceId visible in this run's rendered Planning context. Never substitute a toolCallId, taskId, contentRef, or artifact path. Omit the field or use [] when the next task needs no persisted evidence.",
				"For finish_run, answerEvidenceRefs must contain persisted evidenceId values from this run, not taskId values (including plan_* IDs), toolCallId, contentRef, or artifact paths. A taskId does not itself prove completion. Select evidence that actually supports the goal; if none does, do not finish_run.",
				`Persisted evidence IDs available for finish_run (taskId -> evidenceId; bounded):\n${eligibleEvidence.length > 0 ? eligibleEvidence.map((item) => `${item.taskId} -> ${item.evidenceId}`).join("\n") : "(none)"}`,
				`Validation error: ${validationError.message}`,
				previous,
				"Return the corrected JSON proposal only.",
			].join("\n\n");
		};

		try {
			throwIfAborted(input.signal, "Supervisor planning operation aborted");
			const renderedContext = renderSupervisorContextWithSummary(
				{
					...input.snapshot,
					evidence: input.snapshot.evidence.map((item) => ({
						...item,
						summary: cardSummaries.get(item.evidenceId) ?? item.summary,
						excerpt: "",
						locator: {},
					})),
				},
				this.options.config.planning.maxEvidenceBytes,
			);
			emitLifecycle("planning_context_rendered", { ...renderedContext.summary });
			const primaryResult = await runSupervisor(
				[
					"Decide internally whether persisted evidence finishes this run; otherwise select the next smallest useful action. Do not output drafts or analysis.",
					"Use the supplied board; delegate a specific missing observation when needed. Submit exactly one structured proposal using submit_planning_proposal with decision, rationale, tasks, and answerEvidenceRefs.",
					"decision must be create_tasks, finish_run, or blocked.",
					this.options.config.executionMode?.mode === "plan_multi"
						? "For create_tasks identify up to two independently executable bounded tasks when parallel execution helps. Respect available slots. State concrete distinct deliverables; keep dependent local steps together. Use completion dependencies only for real prerequisites, never to read an already failed task's evidence. Serialize conflicting writes, not independent investigations."
						: "For create_tasks return exactly one bounded task with key, objective, doneWhen, priority, and dependsOn.",
					"inputEvidenceRefs is optional. When useful, use complete persisted evidenceId values shown in this run's rendered Planning context; do not use toolCallId, taskId, contentRef, or artifact paths. Omit the field or use [] when a new exploration task has no evidence input.",
					this.options.config.executionMode?.mode === "plan_multi"
						? "dependsOn may reference an existing persisted taskId or a key in this same proposal. Use dependencies only for real prerequisites or shared mutable work."
						: "dependsOn may only reference a taskId that exists in the current persisted tasks.",
					"Do not use an old task key, objective, or natural-language name as a dependency. Use [] when there is no dependency.",
					`allowedDependencyTaskIds:\n${JSON.stringify(allowedDependencyTaskIds, null, 2)}`,
					"Use finish_run only when persisted evidence proves the goal; cite its evidence IDs in answerEvidenceRefs.",
					"A done task report proves only its local objective. Until host verification succeeds, preserve an end-to-end owner for the overall goal and validation. Prefer one complete task for short or tightly coupled work; create another task only for a distinct useful objective, prerequisite, or independent branch.",
					"Do not execute or solve the task. Use only the supplied board and the submission tool. Do not recreate terminal tasks; choose a substantively new next action.",
					"Ordinary text is not a submission. The host fills revision and bookkeeping defaults.",
					"When prior work exists, each new task must explain its substantive increment in increment and optionally cite original observations in incrementEvidenceIds. A new wording, suffix or artifact packaging alone is not new work.",
					...(this.options.config.planning?.taskGranularityPromptEnabled === true
						? [
								"Task granularity guidance: frame one task as a question or key unknown, the decision-changing observation or artifact to hand back, and what may remain unknown. It is not one tool call and need not solve the whole challenge.",
								"Too small: run one script or read one file without saying what question it answers. Suitable: determine whether a nonce is reused; hand back the reproduction input, raw observation/evidence IDs, and cases still not excluded. Too large: reverse engineer the whole binary, build an exploit, submit a Flag, and verify the entire challenge in one task.",
								"Describe doneWhen as the expected observation or artifact, and allow an honest disproved hypothesis or unresolved result. Let the Executor choose its tools and path; one new evidence item alone does not require a new task. Consider a new task when evidence materially changes direction, the current hypothesis is rejected, a new prerequisite appears, or the attempt ends. This is guidance only, with no tool-call or fixed-minute requirement.",
							]
						: []),
					renderedContext.text,
				].join("\n\n"),
				"primary",
			);
			throwIfAborted(input.signal, "Supervisor planning operation aborted");
			let proposalResult = primaryResult;
			let proposalAttemptType: SupervisorAttemptType = "primary";
			while (true) {
				throwIfAborted(input.signal, "Supervisor planning operation aborted");
				let proposal: ReturnType<typeof parsePlanningPlanProposal> | undefined;
				let failure: PlanningFailureError | undefined;
				try {
					proposal = parseProposal(proposalResult, proposalAttemptType);
					failure = validateProposal(proposal, proposalAttemptType);
				} catch (error) {
					failure = ensurePlanningFailure(error, {
						stage: "supervisor_parse",
						code: "supervisor_parse_error",
						runId,
					});
				}
				if (!failure && proposal) {
					emitLifecycle(
						"supervisor_propose_end",
						completionPayload(proposal, proposalResult, proposalAttemptType),
					);
					return proposal;
				}
				if (!failure) throw new Error("Supervisor proposal was not available after validation");
				if (!consumeCorrection()) throw failure;
				const malformed = failure.code === "supervisor_parse_error";
				const bounded = boundedCorrectionOutput(proposalResult.finalText);
				proposalAttemptType = malformed ? "format_correction" : "validation_correction";
				proposalResult = await runSupervisor(
					malformed
						? formatCorrectionPrompt(failure, bounded)
						: validationCorrectionPrompt(failure, proposal, proposalResult.finalText),
					proposalAttemptType,
					malformed
						? {
								originalOutputChars: bounded.originalOutputChars,
								correctionInputChars: bounded.correctionInputChars,
								truncated: bounded.truncated,
							}
						: {},
				);
			}
		} catch (error) {
			emitLifecycle("supervisor_propose_error", {
				phase,
				error: lifecycleError(error),
				...(planningFailureCode(error) ? { failureCode: planningFailureCode(error) } : {}),
			});
			throw error;
		}
	}
}

export class PiPlanningExecutor implements PlanningExecutor {
	private readonly options: PiPlanningAdapterOptions;

	constructor(options: PiPlanningAdapterOptions) {
		this.options = options;
	}

	async execute(input: Parameters<PlanningExecutor["execute"]>[0]): Promise<PlanningExecutionReport> {
		await this.options.beforeDispatch?.(input.signal);
		throwIfAborted(input.signal, "Executor planning operation aborted");
		const multi = this.options.config.executionMode?.mode === "plan_multi";
		const cwd = multi
			? join(
					this.options.cwd,
					".planning-attempts",
					createHash("sha256").update(input.lease.leaseId).digest("hex").slice(0, 32),
				)
			: this.options.cwd;
		if (multi) mkdirSync(cwd, { recursive: true });
		const startedAt = Date.now();
		let pendingSettlement: Promise<void> | undefined;
		const progress = new PlanningProgressFeedback();
		const { runId, planRevision: revision, taskId, leaseId } = input.lease;
		let observer: PlanningObserverRuntime | undefined;
		const emitLifecycle = (type: string, payload: Record<string, unknown> = {}): void => {
			const eventPayload = {
				...payload,
				runId,
				revision,
				taskId,
				leaseId,
				elapsedMs: Math.max(0, Date.now() - startedAt),
			};
			observer?.recordTimeline(type, eventPayload);
			try {
				this.options.onLifecycleEvent?.(type, eventPayload);
			} catch {
				// Diagnostic observers must never change executor semantics.
			}
		};
		let secondaryFailureCodes: string[] = [];
		const emitExecutorError = (error: unknown, executorPhase: string): void => {
			emitLifecycle(
				input.signal?.aborted && !isPlanningFailureError(error) ? "executor_cancelled" : "executor_error",
				{
					phase: executorPhase,
					executorPhase,
					timeoutObserved: taskTimeoutSignal?.aborted === true,
					secondaryFailureCodes,
					...executorFailureDiagnostics(error),
					error: lifecycleError(error),
				},
			);
		};
		throwIfAborted(input.signal, "Executor planning operation aborted");
		emitLifecycle("executor_start");
		let bundle: PiPlanningExtensionBundle | undefined;
		let executorFailed = false;
		let commit: ReturnType<typeof createPlanningCommitExtension> | undefined;
		let phase = "extension_bundle_create";
		const evidence: PlanningEvidenceInput[] = [];
		const savedToolCalls = new Map<string, { toolName: string; contentHash: string }>();
		const toolStarts = new Map<string, { toolName: string; startedAt: number }>();
		const taskTimeoutSignal = timeoutSignal(this.options.taskTimeoutMs);
		const persistenceAbortController = new AbortController();
		const effectiveSignal = mergeSignals([input.signal, taskTimeoutSignal, persistenceAbortController.signal]);
		const observerMode = this.options.config.planning?.observerMode ?? "off";
		if (observerMode !== "off" && !this.options.runObserver) {
			observer = new PlanningObserverRuntime({
				mode: observerMode,
				startedAt,
				hardTimeoutMs: this.options.taskTimeoutMs,
				lease: input.lease,
				context: input.context,
				signal: effectiveSignal,
				...(input.listEvidence ? { listEvidence: input.listEvidence } : {}),
				...(input.readEvidence ? { readEvidence: input.readEvidence } : {}),
				...(input.recordObservation ? { recordObservation: input.recordObservation } : {}),
				observe: async (observerInput, signal) => {
					const reportShape = {
						attempted: ["..."],
						observedResults: [{ text: "...", evidenceIds: ["..."] }],
						observerJudgments: [{ text: "...", evidenceIds: ["..."] }],
						unverifiedHypotheses: ["..."],
						failuresOrStalls: ["..."],
						avoidRepeating: ["..."],
						openQuestions: ["..."],
						guidance: "... (optional)",
					};
					const observerResult = await runPiCodingTask({
						beforeModelRequest: this.options.beforeDispatch,
						config: this.options.config,
						cwd,
						model: this.options.model,
						modelRuntime: this.options.modelRuntime,
						thinkingLevel: this.options.thinkingLevel,
						task: [
							"Observe this single active Planning attempt. Do not execute tools or decide task completion.",
							"Treat the leased objective and doneWhen as the question and expected handoff. Preserve them; do not create a replacement task.",
							"Use only the supplied task, timeline, and persisted evidence. Do not call a Verifier, claim a Flag is correct, or turn an interpretation into a tool fact.",
							"Describe conclusions as Observer judgments. Cite only complete evidenceId values supplied in the same-run context; leave evidenceIds empty when no reference applies. A readable ID only confirms that the same-run record can be read; it does not establish that your interpretation is accurate or supported. When excerptComplete is false or the supplied excerpt is insufficient, state uncertainty in unverifiedHypotheses; do not infer that absent excerpt text is absent from original output.",
							"Only provide guidance when a concise advisory suggestion could change the next action. Otherwise omit guidance. The report cannot approve or reject the Executor result, establish task completion, or serve as Verifier proof.",
							`Required JSON shape: ${JSON.stringify(reportShape)}`,
							`Progress packet: ${JSON.stringify(observerInput)}`,
							"Return exactly one JSON object, without Markdown or surrounding text.",
						].join("\n\n"),
						systemPrompt:
							"You are a read-only Planning progress observer. You have no tools. Preserve uncertainty, distinguish observations from judgments, and never describe readable references as semantic verification.",
						allowedTools: [],
						signal,
						onLifecycleEvent: (type, payload = {}) => {
							if (
								[
									"session_create_end",
									"prompt_start",
									"prompt_end",
									"coding_task_error",
									"coding_task_end",
								].includes(type)
							) {
								emitLifecycle(`planning_observer_session_${type}`, {
									triggerMs: observerInput.checkpointMs,
									...(typeof payload.error === "string" ? { error: payload.error.slice(0, 500) } : {}),
								});
							}
						},
					});
					return observerResult.finalText;
				},
				onLifecycleEvent: emitLifecycle,
				onPersistenceFailure: (error) => {
					if (!persistenceAbortController.signal.aborted) {
						persistenceAbortController.abort(error instanceof Error ? error : new Error(String(error)));
					}
				},
			});
		}
		let result: PlanningExecutionReport | undefined;
		let failure: unknown;
		try {
			emitLifecycle("extension_bundle_create_start", {
				provided: typeof this.options.createExtensionBundle === "function",
			});
			try {
				bundle = this.options.createExtensionBundle?.({
					leaseId: input.lease.leaseId,
					taskId: input.lease.taskId,
					onProgress: input.onProgress,
					cwd,
				});
				throwIfAborted(input.signal, "Executor planning operation aborted");
				emitLifecycle("extension_bundle_create_end", { created: Boolean(bundle) });
			} catch (error) {
				emitLifecycle("extension_bundle_create_end", { error: lifecycleError(error) });
				throw error;
			}
			phase = "commit_extension_create";
			const recordCheckpoint = input.recordCheckpoint;
			const persistCheckpoint = recordCheckpoint
				? (checkpointId: string, checkpointInput: Parameters<typeof recordCheckpoint>[1]) => {
						const persisted = recordCheckpoint(
							checkpointId,
							checkpointInput,
							Math.max(0, Date.now() - startedAt),
							["hypothesis", "artex"].includes(this.options.config.planning.engine ?? "") ? cwd : undefined,
						);
						observer?.recordCheckpoint(persisted);
						return persisted;
					}
				: undefined;
			commit = createPlanningCommitExtension({
				leaseId: input.lease.leaseId,
				evidence,
				recordSubmission: input.recordSubmission,
				canSubmit: () => !bundle?.backgroundTasks?.hasPending(),
				...(persistCheckpoint ? { recordCheckpoint: persistCheckpoint } : {}),
				readEvidence: input.readEvidence,
				...(multi && input.availableEvidenceRefs ? { availableEvidenceRefs: input.availableEvidenceRefs } : {}),
				...(this.options.config.planning?.evidenceCatalogEnabled !== false && input.listEvidence
					? { listEvidence: input.listEvidence }
					: {}),
				onCheckpointRejected: (checkpointId, diagnostic) => {
					const { reason, ...details } = diagnostic;
					emitLifecycle("planning_checkpoint_rejected", {
						checkpointId,
						failureCode: "planning_checkpoint_validation_error",
						...details,
						diagnosticReason: reason,
					});
				},
				onPersistenceFailure: (error) => {
					if (!persistenceAbortController.signal.aborted) {
						persistenceAbortController.abort(error instanceof Error ? error : new Error(String(error)));
					}
				},
			});
			phase = "coding_task";
			observer?.start();
			const progressExtension: InlineExtension = (pi) => {
				pi.on("context", (event) => {
					const history = input.verificationHistory?.() ?? [];
					const progressFeedback = progress.context();
					const taskProgress = renderSharedTaskProgress(
						input.taskProgress?.() ?? [],
						taskId,
						this.options.config.planning?.maxEvidenceBytes,
					);
					if (progressFeedback || taskProgress || history.length)
						emitLifecycle("planning_feedback_presented", {
							feedbackActive: Boolean(progressFeedback || taskProgress),
							verificationHistoryCount: history.length,
						});
					const feedback = [
						progressFeedback,
						taskProgress,
						...(this.options.runObserver?.takeReminders(leaseId) ?? []),
						renderSharedVerificationHistory(history),
					]
						.filter(Boolean)
						.join("\n");
					return feedback
						? {
								messages: [
									{ role: "user" as const, content: feedback, timestamp: Date.now() },
									...event.messages,
								],
							}
						: undefined;
				});
			};
			await runPiCodingTask({
				beforeModelRequest: this.options.beforeDispatch,
				executionIdentity: { runId, taskId, leaseId },
				onPendingSettlement: (settlement) => {
					pendingSettlement = settlement;
				},
				config: this.options.config,
				cwd,
				model: this.options.model,
				modelRuntime: this.options.modelRuntime,
				thinkingLevel: this.options.thinkingLevel,
				task: [
					...(input.handoffSnapshot
						? [renderPlanningHandoff(progressiveHandoff(input.handoffSnapshot, input.lease))]
						: []),
					...(input.goal
						? [
								`Overall task goal: ${input.goal}. The leased objective contributes to this goal; a local done report alone is not proof that the overall goal is verified.`,
							]
						: []),
					...(this.options.config.planning.engine === "hypothesis" && input.handoffSnapshot
						? [hypothesisExecutorContext(input.handoffSnapshot, taskId)]
						: []),
					...(this.options.config.planning.engine === "artex" && input.handoffSnapshot
						? [artexExecutorContext(input.handoffSnapshot, taskId)]
						: []),
					input.context,
					...(multi
						? [
								`Attempt workspace: ${cwd}. Shared challenge/artifact root: ${input.lease.allowedScope}. Use absolute paths to shared inputs; write scratch files in this attempt workspace. Other tasks may still be running. Treat conflicting conclusions as hypotheses with provenance, not as approval.`,
							]
						: []),
					"Execute the leased objective end to end. Continue through dependent local steps without handing each tool call back to the Supervisor. Verify any grounded candidate with the available native verifier before finishing. Before finishing, call planning_commit_result exactly once.",
					...(input.evidenceCards
						? [
								"Use planning_publish_evidence_card for useful supported findings (30–50 character summary target, exact keyValues, scope, limitations and original evidenceRefs); use planning_list_evidence_cards before repeating another executor’s work. Mark observed versus inferred honestly; publication is not verification.",
							]
						: []),
					input.recordCheckpoint
						? "When a usable partial artifact is available, publish it immediately with planning_checkpoint before preparing the final report. Include its existing absolute path in artifacts, original evidenceRefs, completedItems and remainingItems so another worker can use it while you continue. Also checkpoint meaningful findings or changed direction. A checkpoint does not complete the task; continue the leased scope through its remaining steps."
						: "Use planning_checkpoint at meaningful milestones to save a bounded progress summary. It does not complete the task.",
					"Do not commit the task merely because a command moved to background. Keep its task ID, continue independent work, and consume completion evidence before the final task report.",
					"If an evidence excerpt is truncated or you need exact output, call planning_read_evidence with its evidenceId and use offset/nextOffset for large content.",
					...(this.options.sourceBindings
						? [
								"For exact parameters, versions or dynamic values inherited by another task, use planning_bind_observation on the original evidence JSON pointer. Preserve its bindingId, literal value and evidenceId in the report; distinguish a tool execution error from a disproved hypothesis.",
							]
						: []),
					"Reuse evidence already read in this session and committed artifacts; do not repeatedly read the same unchanged page. If a tool remains processing, continue independent work and consume its completion notification instead of repeatedly polling.",
					"If repeated tool errors or a disproved direction materially change the approach, save planning_checkpoint with rejectedDirections and suggestedNextSteps while continuing useful work. A checkpoint can inform the Supervisor before this attempt ends; it never requires abandoning the attempt.",
					...(this.options.config.planning?.evidenceCatalogEnabled !== false && input.listEvidence
						? [
								"Use planning_list_evidence to discover persisted evidence from any task or failed attempt in this run when a needed result is not shown in the context or planning_read_evidence returns not_found. Copy its complete evidenceId into planning_read_evidence; graph, task and tool-call IDs are different references. The keyword filter searches metadata, summary, and excerpt only; no excerpt match does not mean the original content lacks that text. A readable record does not verify its interpretation.",
							]
						: []),
					"Report outcome and summary, plus grounded facts, rejectedDirections, openQuestions, resolvedQuestionIds, and artifacts.",
					"Facts and rejected directions must be based on successful tool evidence. Omit evidenceRefs to bind all current tool evidence.",
					"suggestedTasks are hints only; the Supervisor decides all future tasks.",
					"Set outcome to exactly one of done, disproved, blocked, failed.",
				].join("\n\n"),
				systemPrompt:
					"You are a stateless scoped executor. Use durable context, gather tool evidence, and commit one structured report.",
				excludedTools: multi
					? [...PLANNING_TOOL_EXCLUSIONS, "sub_agent", "competition_dispatch_solver"]
					: PLANNING_TOOL_EXCLUSIONS,
				extensionFactories: [
					...(this.options.sourceBindings ? [this.options.sourceBindings.extension()] : []),
					...(bundle?.extensionFactories ?? this.options.extensionFactories ?? []),
					...(input.recordCheckpoint || input.verificationHistory || input.taskProgress || this.options.runObserver
						? [progressExtension]
						: []),
					commit.extension,
					...(input.evidenceCards ? [evidenceCardExtension(input.evidenceCards)] : []),
				],
				images: this.options.images,
				signal: effectiveSignal,
				requiredToolName: "planning_commit_result",
				isRequiredToolComplete: () => Boolean(commit?.getResult()),
				handoffOnRequiredTool: multi,
				continueUntilRequiredTool: multi,
				onModelTurn: (cost, message) => {
					this.options.onModelTurn?.(cost);
					this.options.runObserver?.recordTurn(leaseId, {
						taskId,
						leaseId,
						at: Date.now(),
						message,
						pendingTools: [...toolStarts.values()],
					});
				},
				requiredToolRecoveryAttempts: 2,
				backgroundTasks: bundle?.backgroundTasks,
				propagateToolExecutionObserverErrors: true,
				...(observer && observerMode === "guidance"
					? { onSteerReady: (steer: (message: string) => Promise<void>) => observer?.setExecutorSteer(steer) }
					: {}),
				onLifecycleEvent: (type, payload = {}) => {
					if (type === "tool_execution_start") {
						const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
						const toolName = typeof payload.toolName === "string" ? payload.toolName : undefined;
						if (toolCallId && toolName) {
							toolStarts.set(toolCallId, { toolName, startedAt: Date.now() });
							emitLifecycle("executor_tool_execution_start", { toolCallId, toolName });
							return;
						}
					}
					emitLifecycle(type, payload);
				},
				onToolExecution: (execution) => {
					const start = toolStarts.get(execution.toolCallId);
					toolStarts.delete(execution.toolCallId);
					emitLifecycle(
						execution.backgroundCompletion ? "executor_background_completion" : "executor_tool_execution_end",
						{
							toolCallId: execution.toolCallId,
							toolName: execution.toolName,
							isError: execution.isError,
							...planningToolFailureMetadata(
								execution.toolName,
								execution.result,
								execution.toolName === "artex_publish_observation"
									? artexObservationSchema
									: execution.toolName === "hypothesis_publish_observation"
										? hypothesisObservationSchema
										: undefined,
							),
							...(start && start.toolName === execution.toolName
								? { toolElapsedMs: Math.max(0, Date.now() - start.startedAt) }
								: {}),
						},
					);
					if (execution.toolName === "planning_commit_result") {
						const details =
							execution.result && typeof execution.result === "object" && "details" in execution.result
								? execution.result.details
								: undefined;
						const duplicate = Boolean(
							details && typeof details === "object" && "duplicate" in details && details.duplicate === true,
						);
						emitLifecycle("planning_commit_observed", {
							toolCallId: execution.toolCallId,
							isError: execution.isError,
							accepted: !execution.isError,
							duplicate,
						});
					}
					if (
						execution.toolName !== "planning_publish_evidence_card" &&
						execution.toolName !== "planning_list_evidence_cards" &&
						execution.toolName !== "hypothesis_publish_observation" &&
						execution.toolName !== "hypothesis_read_board" &&
						execution.toolName !== "artex_read_graph" &&
						execution.toolName !== "artex_publish_observation" &&
						execution.toolName !== "planning_commit_result" &&
						execution.toolName !== "planning_read_evidence" &&
						execution.toolName !== "planning_list_evidence" &&
						execution.toolName !== "planning_checkpoint"
					) {
						try {
							const completionKey = execution.backgroundCompletion
								? `${execution.toolCallId}:background`
								: execution.toolCallId;
							const captured = captureToolEvidence(
								{ ...execution, toolCallId: completionKey },
								{
									stateDir: this.options.config.stateDir,
									runId: input.lease.runId,
									leaseId: input.lease.leaseId,
								},
							);
							const previous = savedToolCalls.get(completionKey);
							if (previous) {
								if (previous.toolName !== execution.toolName || previous.contentHash !== captured.contentHash) {
									throw new PlanningPersistenceError(
										`Conflicting completion for tool call ${execution.toolCallId} in lease ${leaseId}`,
									);
								}
								return;
							}
							input.recordEvidence?.(captured);
							// Do not cache a failed write: a later identical callback may retry it.
							if (input.recordEvidence)
								savedToolCalls.set(completionKey, {
									toolName: execution.toolName,
									contentHash: captured.contentHash,
								});
							evidence.push(captured);
							if (
								input.recordEvidence &&
								input.recordCheckpoint &&
								!effectiveSignal?.aborted &&
								captured.evidenceId
							) {
								const checkpoint = progress.observe({
									...execution,
									evidenceId: captured.evidenceId,
									...(typeof captured.metadata?.verifierStatus === "string"
										? { verifierStatus: captured.metadata.verifierStatus }
										: {}),
								});
								if (checkpoint) {
									persistCheckpoint?.(`host-progress-${captured.evidenceId}`, checkpoint);
									emitLifecycle("planning_host_checkpoint", {
										evidenceId: captured.evidenceId,
										backgroundCompletion: execution.backgroundCompletion === true,
										feedbackActive: checkpoint.rejectedDirections.length > 0,
									});
								}
							}
							if (input.recordEvidence) {
								observer?.recordToolEvidence(
									typeof captured.evidenceId === "string" ? [captured.evidenceId] : [],
									execution.toolCallId,
								);
							}
						} catch (error) {
							if (!persistenceAbortController.signal.aborted) {
								persistenceAbortController.abort(error instanceof Error ? error : new Error(String(error)));
							}
							throw error;
						}
					}
				},
			});
			if (persistenceAbortController.signal.aborted) {
				throw persistenceAbortController.signal.reason;
			}
			const checkpointFailure = commit.getCheckpointFailure?.();
			if (checkpointFailure) {
				throw checkpointFailure;
			}
			throwIfAborted(input.signal, "Executor planning operation aborted");
			phase = "commit_validation";
			const committed = commit.getResult();
			if (!committed) {
				throw planningFailure(
					"executor",
					"executor_error",
					`Planning task ${input.lease.taskId} did not submit planning_commit_result`,
				);
			}
			throwIfAborted(input.signal, "Executor planning operation aborted");
			result = {
				result: committed,
				evidence,
				commitSource: "planning_commit_result",
				...(["hypothesis", "artex"].includes(this.options.config.planning.engine ?? "")
					? { artifactWorkspace: cwd }
					: {}),
			};
		} catch (error) {
			executorFailed = true;
			const checkpointFailure = commit?.getCheckpointFailure?.();
			const persistenceAbortFailure = persistenceAbortController.signal.aborted
				? persistenceAbortController.signal.reason
				: undefined;
			const candidates = [error, checkpointFailure, persistenceAbortFailure].filter(
				(candidate) => candidate !== undefined,
			);
			const verifierFailure = candidates.find(isVerifierInfrastructureFailure);
			const structuredVerifierFailure = candidates.find(
				(candidate) => isPlanningFailureError(candidate) && candidate.code.startsWith("verifier_"),
			);
			const persistenceFailure =
				checkpointFailure ??
				persistenceAbortFailure ??
				candidates.find(
					(candidate) =>
						candidate instanceof PlanningPersistenceError ||
						(isPlanningFailureError(candidate) && candidate.code === "planning_persistence_error"),
				);
			const rawFailure = candidates[0] ?? error;
			// Error precedence is deliberate: caller cancellation wins, then an
			// already-confirmed Verifier or durable-store failure, and only then a
			// bare child deadline becomes executor_timeout.
			failure = input.signal?.aborted
				? (input.signal.reason ?? rawFailure)
				: verifierFailure
					? verifierPlanningFailure(verifierFailure, runId)
					: structuredVerifierFailure
						? structuredVerifierFailure
						: persistenceFailure
							? persistencePlanningFailure(persistenceFailure, runId)
							: taskTimeoutSignal?.aborted &&
									(!isPlanningFailureError(rawFailure) || rawFailure.code === "executor_error")
								? planningFailure("executor", "executor_timeout", lifecycleError(rawFailure), rawFailure, runId)
								: isPlanningFailureError(rawFailure)
									? rawFailure
									: planningFailure(
											"executor",
											"executor_error",
											lifecycleError(rawFailure),
											rawFailure,
											runId,
										);
			secondaryFailureCodes = [
				...(persistenceFailure &&
				(!isPlanningFailureError(failure) || failure.code !== "planning_persistence_error")
					? ["planning_persistence_error"]
					: []),
				...(verifierFailure && (!isPlanningFailureError(failure) || !failure.code.startsWith("verifier_"))
					? [verifierPlanningFailure(verifierFailure, runId).code]
					: []),
				...(structuredVerifierFailure && (!isPlanningFailureError(failure) || !failure.code.startsWith("verifier_"))
					? [(structuredVerifierFailure as PlanningFailureError).code]
					: []),
			];
			if (isPlanningFailureError(failure)) failure = withPlanningFailureEvidence(failure, evidence);
			emitLifecycle("executor_failure_progress", {
				completedToolEvidenceCount: evidence.length,
				inFlightToolCount: toolStarts.size,
				inFlightToolNames: [...new Set([...toolStarts.values()].map((item) => item.toolName))].slice(0, 16),
			});
			emitExecutorError(failure, phase);
		}
		if (bundle) {
			phase = "extension_bundle_close";
			emitLifecycle("extension_bundle_close_start");
			try {
				if (pendingSettlement) {
					const pendingBundle = bundle;
					pendingSettlement = pendingSettlement.finally(() => pendingBundle.close());
					void pendingSettlement.catch(() => undefined);
				} else bundle.close();
				emitLifecycle("extension_bundle_close_end", { pending: pendingSettlement !== undefined });
			} catch (error) {
				executorFailed = true;
				const closeFailure = input.signal?.aborted
					? error
					: planningFailure("executor", "executor_error", lifecycleError(error), error, runId);
				emitLifecycle("extension_bundle_close_end", { error: lifecycleError(error) });
				emitExecutorError(closeFailure, "extension_bundle_close");
				failure ??= closeFailure;
			}
		}
		if (pendingSettlement) input.onPendingSettlement?.(pendingSettlement);
		if (observer) {
			const submission = commit?.getResult();
			const closureFailure = failure;
			observer.close({
				...(result ? { executorOutcome: result.result.outcome } : {}),
				...(result ? { executorSummary: result.result.summary } : {}),
				...(result?.result.openQuestions
					? { executorOpenQuestions: result.result.openQuestions.map((item) => item.text) }
					: {}),
				...(result?.result.rejectedDirections
					? {
							executorRejectedDirections: result.result.rejectedDirections.map((item) => ({
								direction: item.direction,
								reason: item.reason,
								evidenceRefs: item.evidenceRefs,
							})),
						}
					: {}),
				commitToolSubmissionAvailable: submission !== undefined,
				...(closureFailure
					? {
							failure: {
								stage: isPlanningFailureError(closureFailure) ? closureFailure.stage : phase,
								...(planningFailureCode(closureFailure) ? { code: planningFailureCode(closureFailure) } : {}),
								message: lifecycleError(closureFailure),
							},
						}
					: {}),
			});
			if (persistenceAbortController.signal.aborted && !input.signal?.aborted) {
				const closePersistenceFailure = persistencePlanningFailure(persistenceAbortController.signal.reason, runId);
				const priorVerifierFailure =
					isVerifierInfrastructureFailure(failure) ||
					(isPlanningFailureError(failure) && failure.code.startsWith("verifier_"));
				if (!priorVerifierFailure) {
					failure = closePersistenceFailure;
					executorFailed = true;
				}
			}
		}
		if (failure) throw failure;
		if (!result)
			throw planningFailure(
				"executor",
				"executor_error",
				"Planning executor ended without a result",
				undefined,
				runId,
			);
		if (!executorFailed) emitLifecycle("executor_end");
		return result;
	}
}
