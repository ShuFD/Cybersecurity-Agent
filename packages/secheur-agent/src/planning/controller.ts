import { createHash } from "node:crypto";
import type { PlanningMode as ConfigPlanningMode } from "../config.ts";
import { type ExecutionMode, type ExecutionModeSpec, resolveExecutionMode } from "../execution-mode.ts";
import { compilePlanningProposal } from "./compiler.ts";
import { type PlanningSnapshot, type TrustedPlanningVerification, validatePlanningDependencies } from "./contracts.ts";
import type { PlanningCapacityControl } from "./execution-pool.ts";
import { ensurePlanningFailure, planningFailure } from "./failures.ts";
import { type PlanningExecutor, type PlanningSupervisor, runPlanningHarness } from "./harness.ts";
import type { PlanningStore } from "./store.ts";
import { trustedPlanningVerificationFromSnapshot } from "./terminal-verification.ts";

export interface ProgressivePlanningControllerOptions {
	executionMode?: ExecutionModeSpec;
	/** @deprecated Use executionMode; retained for callers using the legacy API. */
	mode?: ConfigPlanningMode;
	store: PlanningStore;
	supervisor: PlanningSupervisor;
	executor: PlanningExecutor;
	maximumSteps: number;
	maximumTasks: number;
	leaseTtlMs: number;
	maximumEvidenceBytes: number;
	maximumExecutorContextBytes?: number;
	allowedScope: string;
	capacityControl?: PlanningCapacityControl;
	requireTrustedCompletion?: boolean;
	recoverPlanningFailures?: boolean;
}

export interface ProgressivePlanningRequest {
	outerTaskId: string;
	goal: string;
	executeDirect(): Promise<void>;
	signal?: AbortSignal;
}

export interface ProgressivePlanningResult {
	mode: ConfigPlanningMode;
	executionMode: ExecutionMode;
	runId?: string;
	snapshot?: PlanningSnapshot;
	trustedVerification?: TrustedPlanningVerification;
	direct: boolean;
}

export function planningRunId(outerTaskId: string, goal: string, mode: ConfigPlanningMode): string {
	return `planning_${createHash("sha256").update(`${mode}\0${outerTaskId}\0${goal}`).digest("hex").slice(0, 32)}`;
}

export function planningRunIdForExecution(
	executionMode: ExecutionModeSpec,
	outerTaskId: string,
	goal: string,
): string | undefined {
	if (executionMode.mode === "plan_multi") return planningRunId(`plan_multi:${outerTaskId}`, goal, "active");
	if (executionMode.mode !== "plan_single") return undefined;
	const legacyMode = executionMode.legacyPlanningMode;
	return planningRunId(`${legacyMode}:${outerTaskId}`, goal, legacyMode);
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

export class ProgressivePlanningController {
	private readonly options: ProgressivePlanningControllerOptions;
	private readonly executionMode: ExecutionModeSpec;

	constructor(options: ProgressivePlanningControllerOptions) {
		this.options = options;
		this.executionMode = options.executionMode ?? resolveExecutionMode({ legacyPlanningMode: options.mode });
	}

	async execute(request: ProgressivePlanningRequest): Promise<ProgressivePlanningResult> {
		const startedAt = Date.now();
		throwIfAborted(request.signal);
		const executionMode = this.executionMode;
		if (executionMode.mode === "direct") {
			await request.executeDirect();
			throwIfAborted(request.signal);
			return { mode: "off", executionMode: "direct", direct: true };
		}

		const legacyMode = executionMode.legacyPlanningMode;
		const outerTaskId = `${legacyMode}:${request.outerTaskId}`;
		const runId = planningRunIdForExecution(executionMode, request.outerTaskId, request.goal);
		if (!runId) throw new Error("Planning run id is unavailable for the selected execution mode");
		const runMode = legacyMode === "active" ? "active" : "shadow";
		const existing = this.options.store.getRun(runId);
		this.options.store.createRun({ runId, outerTaskId, goal: request.goal, mode: runMode });
		this.options.store.recordLifecycleEvent(runId, "execution_mode_selected", {
			mode: executionMode.mode,
			planningEnabled: executionMode.planningEnabled,
			capacity: executionMode.capacity,
			legacyPlanningMode: executionMode.legacyPlanningMode,
		});
		try {
			if (legacyMode === "shadow") {
				let snapshot = this.options.store.snapshot(runId);
				if (snapshot.tasks.length === 0) {
					throwIfAborted(request.signal);
					const proposal = await this.options.supervisor.propose({ snapshot, signal: request.signal });
					throwIfAborted(request.signal);
					if (proposal.expectedRevision !== snapshot.run.revision) {
						throw planningFailure(
							"supervisor_validation",
							"supervisor_validation_error",
							"Supervisor returned a stale shadow planning revision",
						);
					}
					throwIfAborted(request.signal);
					validatePlanningDependencies(proposal, snapshot);
					const tasks = compilePlanningProposal(runId, proposal, snapshot.tasks, this.options.maximumTasks);
					throwIfAborted(request.signal);
					snapshot = this.options.store.commitPlan({
						artexUpdate: proposal.artexUpdate,
						runId,
						expectedRevision: proposal.expectedRevision,
						rationale: proposal.rationale,
						idempotencyKey: `shadow-plan:${runId}:${proposal.expectedRevision}`,
						tasks,
					});
				}
				throwIfAborted(request.signal);
				this.options.store.setRunStatus(runId, "paused", "shadow plan recorded; direct executor retained control");
				await request.executeDirect();
				throwIfAborted(request.signal);
				return {
					mode: "shadow",
					executionMode: "plan_single",
					runId,
					snapshot: this.options.store.snapshot(runId),
					direct: true,
				};
			}

			if (existing?.status === "running") {
				this.options.store.recoverActiveLease(
					runId,
					"controller resumed a run whose executor is no longer attached",
				);
			}
			throwIfAborted(request.signal);
			const snapshot = await runPlanningHarness(runId, {
				store: this.options.store,
				requireTrustedCompletion: this.options.requireTrustedCompletion,
				recoverPlanningFailures: this.options.recoverPlanningFailures,
				supervisor: this.options.supervisor,
				executor: this.options.executor,
				maximumSteps: this.options.maximumSteps,
				maximumTasks: this.options.maximumTasks,
				leaseTtlMs: this.options.leaseTtlMs,
				maximumEvidenceBytes: this.options.maximumEvidenceBytes,
				maximumExecutorContextBytes: this.options.maximumExecutorContextBytes,
				allowedScope: this.options.allowedScope,
				executionCapacity: executionMode.capacity,
				parallelPlanning: executionMode.mode === "plan_multi",
				capacityControl: this.options.capacityControl,
				signal: request.signal,
			});
			const trustedVerification =
				snapshot.run.status === "completed" ? trustedPlanningVerificationFromSnapshot(snapshot) : undefined;
			return {
				mode: "active",
				executionMode: executionMode.mode,
				runId,
				snapshot,
				...(trustedVerification ? { trustedVerification } : {}),
				direct: false,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (request.signal?.aborted) {
				this.options.store.cancelActiveLease(runId, message);
				this.options.store.setRunStatus(runId, "cancelled", message);
				throw error;
			}
			const failure = ensurePlanningFailure(error, {
				stage: "controller",
				code: "planning_internal_error",
				runId,
			});
			this.options.store.recoverActiveLease(runId, `planning execution interrupted: ${failure.message}`);
			this.options.store.setRunStatus(runId, "failed", failure.message);
			this.options.store.recordLifecycleEvent(runId, "planning_failure", {
				runId,
				failureSource: failure.source,
				failureStage: failure.stage,
				failureCode: failure.code,
				elapsedMs: Math.max(0, Date.now() - startedAt),
			});
			throw failure;
		}
	}
}
