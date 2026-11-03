import type { PlanningCheckpointInput, PlanningEvidenceInput } from "./contracts.ts";

export type PlanningFailureStage =
	| "supervisor"
	| "supervisor_parse"
	| "supervisor_validation"
	| "proposal_validation"
	| "terminal_contract"
	| "executor"
	| "controller"
	| (string & {});

export type PlanningFailureCode =
	| "supervisor_parse_error"
	| "supervisor_validation_error"
	| "duplicate_task_identity"
	| "executor_timeout"
	| "executor_error"
	| "verifier_quota_exhausted"
	| "verifier_timeout"
	| "verifier_transport_error"
	| "verifier_protocol_error"
	| "verifier_invalid_request"
	| "verifier_aborted"
	| "verifier_unavailable"
	| "terminal_contract_error"
	| "proposal_validation_error"
	| "planning_persistence_error"
	| "planning_internal_error"
	| "duplicate_task_signature"
	| (string & {});

export interface PlanningFailureDetails {
	source: "planning";
	stage: PlanningFailureStage;
	code: PlanningFailureCode;
	message: string;
	cause?: unknown;
	runId?: string;
	evidence?: PlanningEvidenceInput[];
	progress?: PlanningCheckpointInput;
	retryAfterMs?: number;
}

/** A typed planning failure that can safely cross the controller/runtime boundary. */
export class PlanningFailureError extends Error {
	readonly source = "planning" as const;
	readonly stage: PlanningFailureStage;
	readonly code: PlanningFailureCode;
	readonly cause?: unknown;
	readonly runId?: string;
	readonly evidence: PlanningEvidenceInput[];
	readonly progress?: PlanningCheckpointInput;
	readonly retryAfterMs?: number;

	constructor(details: PlanningFailureDetails) {
		super(details.message);
		this.name = "PlanningFailureError";
		this.stage = details.stage;
		this.code = details.code;
		this.cause = details.cause;
		this.runId = details.runId;
		this.evidence = details.evidence ?? [];
		this.progress = details.progress;
		this.retryAfterMs = details.retryAfterMs;
	}
}

/** A rejected checkpoint is a model/input contract error, not a durable-store outage. */
export interface PlanningCheckpointDiagnostic {
	reason: string;
	fieldName: string;
	scopeDecision: "not_checked" | "accepted" | "rejected";
	evidenceRefs?: string[];
	artifactReferenceHashes?: string[];
}

function checkpointCorrectionGuidance(reason: string, fieldName: string): string {
	if (reason === "evidence_reference_not_persisted_or_wrong_run") {
		return "Use an exact persisted evidenceId visible in this run's rendered Planning context; do not use a toolCallId, taskId, contentRef, or artifact path. If no evidence is needed, omit evidenceRefs or use an empty array.";
	}
	if (reason === "checkpoint_evidence_refs_invalid") {
		if (fieldName.includes("inputEvidenceRefs")) {
			return "Each suggestedNextSteps[].inputEvidenceRefs entry must be one exact complete evidenceId visible in this run's rendered Planning context. Do not use toolCallId, taskId, contentRef, or artifact paths; omit inputEvidenceRefs or use [] when no prior evidence is needed.";
		}
		return "Each evidenceRefs entry must be one complete non-empty evidenceId string. Do not use toolCallId, taskId, contentRef, or artifact paths; omit the field or use [] when no evidence is needed.";
	}
	if (reason === "artifact_not_found") {
		return "Create or verify the artifact first, then reference its existing path inside the active lease workspace. Do not put an artifact path in evidenceRefs.";
	}
	if (reason === "artifact_outside_allowed_scope") {
		return "Only reference an existing artifact inside the active lease workspace. Keep the path within that scope; do not retry an out-of-scope path.";
	}
	if (reason.startsWith("artifact_")) {
		return "Use an existing artifact path that can be verified inside the active lease workspace. Do not broaden or bypass artifact scope.";
	}
	if (reason === "active_lease_required") {
		return "This lease is no longer active. Do not retry checkpoint writes for it; return control or commit only if the current task session still accepts the normal result.";
	}
	if (reason === "invalid_json_object") {
		return "Submit one JSON object matching planning_checkpoint's parameter schema, then retry once with corrected fields.";
	}
	return `Correct the checkpoint field ${fieldName} to match planning_checkpoint's bounded schema, then resubmit. Do not guess or substitute evidence IDs.`;
}

export class PlanningCheckpointValidationError extends Error {
	readonly code = "planning_checkpoint_validation_error" as const;
	readonly diagnostic: PlanningCheckpointDiagnostic;

	constructor(
		_message: string,
		diagnostic: PlanningCheckpointDiagnostic = {
			reason: "checkpoint_validation_failed",
			fieldName: "unknown",
			scopeDecision: "not_checked",
		},
	) {
		const safeReason = diagnostic.reason.slice(0, 96);
		const safeFieldName = diagnostic.fieldName.slice(0, 96);
		super(
			JSON.stringify({
				errorCode: "planning_checkpoint_validation_error",
				reason: safeReason,
				field: safeFieldName,
				scopeDecision: diagnostic.scopeDecision,
				correction: checkpointCorrectionGuidance(safeReason, safeFieldName),
			}),
		);
		this.name = "PlanningCheckpointValidationError";
		this.diagnostic = { ...diagnostic, reason: safeReason, fieldName: safeFieldName };
	}
}

/** Durable PlanningStore failures must stop the run instead of being replanned. */
export class PlanningPersistenceError extends Error {
	readonly code = "planning_persistence_error" as const;
	readonly cause?: unknown;

	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = "PlanningPersistenceError";
		this.cause = cause;
	}
}

/** A correctable evidence-catalog query input error, not a Store outage. */
export class PlanningEvidenceListInputError extends Error {
	readonly code = "planning_evidence_list_input_error" as const;
	readonly reason: "invalid_cursor" | "invalid_limit";

	constructor(reason: "invalid_cursor" | "invalid_limit") {
		super(
			reason === "invalid_cursor"
				? "Planning evidence cursor is invalid or belongs to a different query; restart from the first page"
				: "Planning evidence page limit must be a positive integer",
		);
		this.name = "PlanningEvidenceListInputError";
		this.reason = reason;
	}
}

/** An exact evidence ID is absent from the current run; the caller can select another ID. */
export class PlanningEvidenceNotFoundError extends Error {
	readonly code = "planning_evidence_not_found" as const;
	readonly evidenceId: string;

	constructor(evidenceId: string) {
		super(`Planning evidence not found: ${evidenceId}`);
		this.name = "PlanningEvidenceNotFoundError";
		this.evidenceId = evidenceId;
	}
}

/** A structured result was submitted, but it cannot satisfy the commit contract. */
export class PlanningResultValidationError extends Error {
	readonly code = "planning_result_validation_error" as const;

	constructor(message: string) {
		super(message);
		this.name = "PlanningResultValidationError";
	}
}

export function withPlanningFailureEvidence(
	error: PlanningFailureError,
	evidence: PlanningEvidenceInput[],
): PlanningFailureError {
	if (evidence.length === 0) return error;
	return new PlanningFailureError({
		source: "planning",
		stage: error.stage,
		code: error.code,
		message: error.message,
		cause: error.cause,
		runId: error.runId,
		evidence,
		progress: error.progress,
		retryAfterMs: error.retryAfterMs,
	});
}

export function isPlanningFailureError(error: unknown): error is PlanningFailureError {
	return error instanceof PlanningFailureError;
}

export function planningFailure(
	stage: PlanningFailureStage,
	code: PlanningFailureCode,
	message: string,
	cause?: unknown,
	runId?: string,
	progress?: PlanningCheckpointInput,
): PlanningFailureError {
	return new PlanningFailureError({ source: "planning", stage, code, message, cause, runId, progress });
}

export function ensurePlanningFailure(
	error: unknown,
	fallback: Pick<PlanningFailureDetails, "stage" | "code"> & { runId?: string },
): PlanningFailureError {
	if (isPlanningFailureError(error)) {
		if (fallback.runId && !error.runId) {
			return new PlanningFailureError({
				source: "planning",
				stage: error.stage,
				code: error.code,
				message: error.message,
				cause: error.cause,
				runId: fallback.runId,
				evidence: error.evidence,
				progress: error.progress,
				retryAfterMs: error.retryAfterMs,
			});
		}
		return error;
	}
	return planningFailure(
		fallback.stage,
		fallback.code,
		error instanceof Error ? error.message : String(error),
		error,
		fallback.runId,
	);
}
