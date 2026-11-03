import { createHash } from "node:crypto";
import type { AgentToolResult, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type PlanningCheckpoint,
	type PlanningCheckpointInput,
	type PlanningEvidenceInput,
	type PlanningEvidenceListOptions,
	type PlanningEvidenceListResult,
	type PlanningEvidenceReadResult,
	type PlanningTaskResult,
	parsePlanningCheckpoint,
	parsePlanningTaskResult,
} from "./contracts.ts";
import {
	isPlanningFailureError,
	type PlanningCheckpointDiagnostic,
	PlanningCheckpointValidationError,
	PlanningEvidenceListInputError,
	PlanningEvidenceNotFoundError,
	PlanningPersistenceError,
} from "./failures.ts";

const OUTCOME = Type.Union([
	Type.Literal("done"),
	Type.Literal("disproved"),
	Type.Literal("blocked"),
	Type.Literal("failed"),
]);
const EVIDENCE_REFS = Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 256 }));
const SUGGESTED_TASK = Type.Object(
	{
		objective: Type.String({ minLength: 1, maxLength: 40_000 }),
		doneWhen: Type.String({ minLength: 1, maxLength: 40_000 }),
		priority: Type.Optional(Type.Number()),
		dependsOnCurrent: Type.Optional(Type.Boolean()),
		inputEvidenceRefs: EVIDENCE_REFS,
	},
	{ additionalProperties: false },
);
const FLAG_CANDIDATE = Type.Object(
	{
		candidate: Type.String({ minLength: 1, maxLength: 8_192 }),
		confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
		rationale: Type.Optional(Type.String({ maxLength: 20_000 })),
	},
	{ additionalProperties: false },
);
const FACT = Type.Object(
	{
		key: Type.String({ minLength: 1, maxLength: 256 }),
		value: Type.Unknown(),
		evidenceRefs: EVIDENCE_REFS,
	},
	{ additionalProperties: false },
);
const REJECTED_DIRECTION = Type.Object(
	{
		direction: Type.String({ minLength: 1, maxLength: 2_000 }),
		reason: Type.String({ minLength: 1, maxLength: 20_000 }),
		evidenceRefs: EVIDENCE_REFS,
	},
	{ additionalProperties: false },
);
const OPEN_QUESTION = Type.Object(
	{
		questionId: Type.String({ minLength: 1, maxLength: 256 }),
		text: Type.String({ minLength: 1, maxLength: 20_000 }),
	},
	{ additionalProperties: false },
);
const ARTIFACT = Type.Object(
	{
		path: Type.String({ minLength: 1, maxLength: 4_096 }),
		type: Type.String({ minLength: 1, maxLength: 256 }),
		description: Type.String({ minLength: 1, maxLength: 20_000 }),
		sha256: Type.Optional(Type.String({ maxLength: 128 })),
	},
	{ additionalProperties: false },
);
const PARAMETERS = Type.Object(
	{
		outcome: OUTCOME,
		summary: Type.String({ minLength: 1, maxLength: 40_000 }),
		suggestedTasks: Type.Optional(Type.Array(SUGGESTED_TASK, { maxItems: 48 })),
		flagCandidates: Type.Optional(Type.Array(FLAG_CANDIDATE, { maxItems: 48 })),
		evidenceRefs: EVIDENCE_REFS,
		facts: Type.Optional(Type.Array(FACT, { maxItems: 128 })),
		rejectedDirections: Type.Optional(Type.Array(REJECTED_DIRECTION, { maxItems: 64 })),
		openQuestions: Type.Optional(Type.Array(OPEN_QUESTION, { maxItems: 64 })),
		resolvedQuestionIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64 })),
		artifacts: Type.Optional(Type.Array(ARTIFACT, { maxItems: 64 })),
	},
	{ additionalProperties: false },
);
const READ_EVIDENCE_PARAMETERS = Type.Object(
	{
		evidenceId: Type.String({ minLength: 1, maxLength: 256 }),
		offset: Type.Optional(Type.Number({ minimum: 0, maximum: 8 * 1024 * 1024 })),
		maxBytes: Type.Optional(Type.Number({ minimum: 256, maximum: 64 * 1024 })),
	},
	{ additionalProperties: false },
);
const LIST_EVIDENCE_PARAMETERS = Type.Object(
	{
		cursor: Type.Optional(Type.String({ maxLength: 512 })),
		limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
		taskId: Type.Optional(Type.String({ maxLength: 256 })),
		leaseId: Type.Optional(Type.String({ maxLength: 256 })),
		toolName: Type.Optional(Type.String({ maxLength: 128 })),
		outcome: Type.Optional(Type.Union([Type.Literal("success"), Type.Literal("error")])),
		keyword: Type.Optional(Type.String({ maxLength: 128 })),
	},
	{ additionalProperties: false },
);
const CHECKPOINT_ITEM = Type.String({ minLength: 1, maxLength: 2_000 });
const CHECKPOINT_REJECTED_DIRECTION = Type.Object(
	{
		direction: Type.String({ minLength: 1, maxLength: 2_000 }),
		reason: Type.String({ minLength: 1, maxLength: 20_000 }),
		evidenceRefs: EVIDENCE_REFS,
	},
	{ additionalProperties: false },
);
const CHECKPOINT_ARTIFACT = Type.Object(
	{
		path: Type.String({ minLength: 1, maxLength: 4_096 }),
		type: Type.String({ minLength: 1, maxLength: 256 }),
		description: Type.String({ minLength: 1, maxLength: 8_000 }),
		sha256: Type.Optional(Type.String({ maxLength: 128 })),
	},
	{ additionalProperties: false },
);
const CHECKPOINT_PARAMETERS = Type.Object(
	{
		summary: Type.String({ minLength: 1, maxLength: 8_000 }),
		evidenceRefs: EVIDENCE_REFS,
		completedItems: Type.Optional(Type.Array(CHECKPOINT_ITEM, { maxItems: 64 })),
		remainingItems: Type.Optional(Type.Array(CHECKPOINT_ITEM, { maxItems: 64 })),
		rejectedDirections: Type.Optional(Type.Array(CHECKPOINT_REJECTED_DIRECTION, { maxItems: 64 })),
		artifacts: Type.Optional(Type.Array(CHECKPOINT_ARTIFACT, { maxItems: 64 })),
		suggestedNextSteps: Type.Optional(Type.Array(SUGGESTED_TASK, { maxItems: 48 })),
	},
	{ additionalProperties: false },
);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectedEvidenceRefs(
	input: Record<string, unknown>,
	evidence: PlanningEvidenceInput[],
	available: string[] = [],
): string[] {
	const own = evidence.flatMap((item) => (item.evidenceId ? [item.evidenceId] : []));
	const known = new Set([...own, ...available]);
	const requested = Array.isArray(input.evidenceRefs)
		? input.evidenceRefs.filter((item): item is string => typeof item === "string" && known.has(item))
		: [];
	return [...new Set(requested.length > 0 ? requested : own)];
}

export interface PlanningCommitExtensionOptions {
	leaseId: string;
	evidence: PlanningEvidenceInput[];
	/** Persist the validated submission before acknowledging it; keep the lease owned until Pi settles. */
	recordSubmission?: (result: PlanningTaskResult) => void;
	canSubmit?: () => boolean;
	/** Host-provided same-run IDs; never inferred from a model's declaration. */
	availableEvidenceRefs?: () => string[];
	recordCheckpoint?: (
		checkpointId: string,
		checkpoint: PlanningCheckpointInput,
	) => PlanningCheckpoint | Promise<PlanningCheckpoint>;
	readEvidence?: (
		evidenceId: string,
		offset: number,
		maxBytes?: number,
		requestId?: string,
	) => PlanningEvidenceReadResult | Promise<PlanningEvidenceReadResult>;
	listEvidence?: (options: PlanningEvidenceListOptions) => PlanningEvidenceListResult;
	onCheckpointRejected?: (
		checkpointId: string,
		diagnostic: PlanningCheckpointDiagnostic & { diagnosticLayer: "extension_input" },
	) => void;
	/** Stop the owning Pi execution as soon as durable checkpoint storage fails. */
	onPersistenceFailure?: (error: unknown) => void;
}

export interface PlanningCommitExtension {
	extension: InlineExtension;
	getResult(): PlanningTaskResult | undefined;
	getCheckpointFailure?(): unknown;
}

function boundedReferences(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))]
		.slice(0, 16)
		.map((item) => item.slice(0, 256));
}

function checkpointInputDiagnostic(
	error: unknown,
	input: Record<string, unknown>,
): PlanningCheckpointDiagnostic & { diagnosticLayer: "extension_input" } {
	const message = error instanceof Error ? error.message : "";
	let reason = "checkpoint_input_parse_failed";
	let fieldName = "parameters";
	if (message === "Model response did not contain a valid JSON object") {
		reason = "invalid_json_object";
		fieldName = "$";
	} else if (message.toLowerCase().includes("evidencerefs")) {
		reason = "checkpoint_evidence_refs_invalid";
		const match =
			/^Checkpoint (evidenceRefs|rejectedDirections\[\d+\]\.evidenceRefs|suggestedNextSteps\[\d+\]\.inputEvidenceRefs)(?:\[(\d+)\])?/u.exec(
				message,
			);
		fieldName = match ? `${match[1]}${match[2] ? `[${match[2]}]` : ""}` : "evidenceRefs";
	} else if (message.startsWith("Checkpoint artifacts")) {
		reason = "checkpoint_artifacts_invalid";
		fieldName = "artifacts";
	} else if (message.startsWith("Checkpoint summary")) {
		reason = "checkpoint_summary_invalid";
		fieldName = "summary";
	} else if (message.startsWith("Checkpoint artifact ")) {
		const match = /^Checkpoint artifact (\d+) (path|type|description|sha256)/u.exec(message);
		reason = "checkpoint_artifact_field_invalid";
		fieldName = match ? `artifacts[${match[1]}].${match[2]}` : "artifacts";
	} else if (message.startsWith("Checkpoint rejected direction ")) {
		const match = /^Checkpoint rejected direction (\d+) (direction|reason)/u.exec(message);
		reason = "checkpoint_rejected_direction_invalid";
		fieldName = match ? `rejectedDirections[${match[1]}].${match[2]}` : "rejectedDirections";
	} else if (message.startsWith("Checkpoint suggested next step ")) {
		const match = /^Checkpoint suggested next step (\d+) (objective|doneWhen)/u.exec(message);
		reason = "checkpoint_suggested_task_invalid";
		fieldName = match ? `suggestedNextSteps[${match[1]}].${match[2]}` : "suggestedNextSteps";
	} else if (message.startsWith("Checkpoint rejectedDirections")) {
		reason = "checkpoint_rejected_directions_invalid";
		fieldName = "rejectedDirections";
	} else if (message.startsWith("Checkpoint suggestedNextSteps")) {
		reason = "checkpoint_suggested_task_invalid";
		fieldName = "suggestedNextSteps";
	} else if (message.startsWith("Checkpoint completedItems") || message.startsWith("Checkpoint remainingItems")) {
		reason = "checkpoint_items_invalid";
		fieldName = message.includes("completedItems") ? "completedItems" : "remainingItems";
	}
	const rejectedDirections = input.rejectedDirections ?? input.rejected_directions;
	const suggestedNextSteps = input.suggestedNextSteps ?? input.suggested_next_steps;
	const evidenceRefs = [
		...boundedReferences(input.evidenceRefs ?? input.evidence_refs),
		...(Array.isArray(rejectedDirections)
			? rejectedDirections.flatMap((entry) =>
					isRecord(entry) ? boundedReferences(entry.evidenceRefs ?? entry.evidence_refs) : [],
				)
			: []),
		...(Array.isArray(suggestedNextSteps)
			? suggestedNextSteps.flatMap((entry) =>
					isRecord(entry)
						? boundedReferences(
								entry.inputEvidenceRefs ??
									entry.input_evidence_refs ??
									entry.evidenceRefs ??
									entry.evidence_refs,
							)
						: [],
				)
			: []),
	]
		.filter((value, index, values) => values.indexOf(value) === index)
		.slice(0, 16);
	const artifacts = input.artifacts;
	const artifactReferenceHashes = Array.isArray(artifacts)
		? artifacts
				.flatMap((entry) => (isRecord(entry) && typeof entry.path === "string" ? [entry.path] : []))
				.slice(0, 16)
				.map((path) => createHash("sha256").update(path).digest("hex"))
		: [];
	return {
		diagnosticLayer: "extension_input",
		reason,
		fieldName,
		scopeDecision: "not_checked",
		...(evidenceRefs.length > 0 ? { evidenceRefs } : {}),
		...(artifactReferenceHashes.length > 0 ? { artifactReferenceHashes } : {}),
	};
}

export function createPlanningCommitExtension(options: PlanningCommitExtensionOptions): PlanningCommitExtension {
	let accepted: PlanningTaskResult | undefined;
	let checkpointPersistenceFailure: unknown;
	const extension: InlineExtension = {
		name: "planning-result-protocol",
		hidden: true,
		factory: (pi) => {
			if (typeof options.readEvidence === "function") {
				pi.on("tool_result", (event) => {
					if (
						event.toolName === "planning_read_evidence" &&
						isRecord(event.details) &&
						event.details.reasonCode === "planning_evidence_not_found"
					)
						return { isError: true };
					return undefined;
				});
			}
			if (typeof options.listEvidence === "function") {
				pi.registerTool({
					name: "planning_list_evidence",
					label: "List Planning Evidence",
					description:
						"Search this run's persisted evidence by task, tool, status, or searchable metadata/summary/excerpt. This is not a full-text search of stored original content. Use planning_read_evidence with an evidenceId to inspect original content.",
					parameters: LIST_EVIDENCE_PARAMETERS,
					executionMode: "sequential",
					async execute(_toolCallId, params) {
						const rawParams: unknown = params;
						const input = isRecord(rawParams) ? rawParams : {};
						const query: PlanningEvidenceListOptions = {
							...(typeof input.cursor === "string" ? { cursor: input.cursor } : {}),
							...(typeof input.limit === "number" ? { limit: input.limit } : {}),
							...(typeof input.taskId === "string" ? { taskId: input.taskId } : {}),
							...(typeof input.leaseId === "string" ? { leaseId: input.leaseId } : {}),
							...(typeof input.toolName === "string" ? { toolName: input.toolName } : {}),
							...(input.outcome === "success" || input.outcome === "error" ? { outcome: input.outcome } : {}),
							...(typeof input.keyword === "string" ? { keyword: input.keyword } : {}),
						};
						let result: PlanningEvidenceListResult | undefined;
						try {
							result = options.listEvidence?.(query);
						} catch (error) {
							if (error instanceof PlanningEvidenceListInputError) throw error;
							if (
								error instanceof PlanningPersistenceError ||
								(isPlanningFailureError(error) && error.code === "planning_persistence_error")
							) {
								try {
									options.onPersistenceFailure?.(error);
								} catch {
									// Keep the durable Store failure authoritative.
								}
							}
							throw error;
						}
						if (!result) throw new Error("Planning evidence catalog unavailable");
						const items = result.items.map((item) => {
							const excerpt = item.excerpt || item.summary;
							const briefExcerpt = excerpt.slice(0, 240);
							const outcome =
								item.kind === "observation"
									? "observation"
									: item.metadata.isError === true
										? "error"
										: item.metadata.isError === false
											? "success"
											: "unknown";
							return {
								evidenceId: item.evidenceId,
								taskId: item.taskId,
								leaseId: item.leaseId,
								source: item.source,
								toolName: item.toolName ?? item.source,
								createdAt: item.createdAt,
								outcome,
								attemptFailed: item.metadata.attemptFailed === true,
								description:
									item.kind === "tool"
										? `${outcome}: ${item.toolName ?? item.source}; excerpt: ${briefExcerpt}`
										: item.summary.slice(0, 240),
								contentComplete: item.contentComplete,
							};
						});
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify({
										items,
										totalCount: result.totalCount,
										hasMore: result.hasMore,
										nextCursor: result.nextCursor,
										keywordScope: ["metadata", "summary", "excerpt"],
										keywordSearchIsFullText: false,
									}),
								},
							],
							details: { totalCount: result.totalCount, hasMore: result.hasMore, nextCursor: result.nextCursor },
						};
					},
				});
			}
			pi.registerTool({
				name: "planning_read_evidence",
				label: "Read Planning Evidence",
				description:
					"Read the persisted full result for an evidenceId. Use this when the context excerpt is truncated or exact output is required.",
				parameters: READ_EVIDENCE_PARAMETERS,
				executionMode: "sequential",
				async execute(toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> {
					if (typeof options.readEvidence !== "function") throw new Error("evidence blob storage unavailable");
					const rawParams: unknown = params;
					const input = isRecord(rawParams) ? rawParams : {};
					const evidenceId = typeof input.evidenceId === "string" ? input.evidenceId : "";
					if (!evidenceId) throw new Error("evidenceId is required");
					const offset = typeof input.offset === "number" ? input.offset : 0;
					const maxBytes = typeof input.maxBytes === "number" ? input.maxBytes : undefined;
					const requestId = String(toolCallId).slice(0, 128);
					let result: PlanningEvidenceReadResult;
					try {
						result = await options.readEvidence(evidenceId, offset, maxBytes, requestId);
					} catch (error) {
						if (error instanceof PlanningPersistenceError) {
							try {
								options.onPersistenceFailure?.(error);
							} catch {
								// Keep the durable diagnostic persistence error authoritative.
							}
							throw error;
						}
						if (error instanceof PlanningEvidenceNotFoundError) {
							const diagnostic = {
								evidenceId,
								readState: "not_found",
								failureCategory: "evidence_not_found_in_run",
								scopeDecision: "rejected",
								guidance:
									"Copy a complete evidenceId from this run's catalog or supplied IDs, then read it again. Graph, task and tool-call IDs are different references. A readable record does not verify its interpretation.",
								recovery: options.listEvidence
									? { toolName: "planning_list_evidence", arguments: { limit: 10 } }
									: {
											availableEvidenceRefs: (
												options.availableEvidenceRefs?.() ??
												options.evidence.flatMap((item) => (item.evidenceId ? [item.evidenceId] : []))
											).slice(0, 10),
										},
							};
							return {
								content: [{ type: "text", text: JSON.stringify(diagnostic) }],
								details: {
									evidenceId,
									readState: diagnostic.readState,
									failureCategory: diagnostic.failureCategory,
									reasonCode: "planning_evidence_not_found",
									fieldPaths: ["evidenceId"],
									retryable: true,
								},
							};
						}
						throw error;
					}
					return {
						content: [{ type: "text", text: JSON.stringify(result) }],
						details: {
							evidenceId,
							offset: result.offset,
							nextOffset: result.nextOffset,
							hasMore: result.hasMore,
						},
					};
				},
			});
			pi.registerTool({
				name: "planning_checkpoint",
				label: "Save Planning Checkpoint",
				description:
					"Save bounded progress for the active lease without completing it. evidenceRefs must contain exact evidenceId values visible in this run's rendered Planning context (not toolCallId, taskId, contentRef, or paths); omit references or use [] when none are needed. Artifact paths must refer to existing files inside the active lease workspace.",
				parameters: CHECKPOINT_PARAMETERS,
				executionMode: "sequential",
				async execute(toolCallId, params) {
					if (typeof options.recordCheckpoint !== "function")
						throw new Error("planning checkpoint storage unavailable");
					// A durable failure is terminal for this execution. The signal owned by
					// PiPlanningExecutor is aborted by onPersistenceFailure, but this guard
					// also closes the race where a tool call is already queued.
					if (checkpointPersistenceFailure) throw checkpointPersistenceFailure;
					const checkpointId = `checkpoint-${options.leaseId}-${String(toolCallId).slice(0, 128)}`;
					let checkpoint: PlanningCheckpointInput;
					try {
						checkpoint = parsePlanningCheckpoint(JSON.stringify(isRecord(params) ? params : {}));
					} catch (error) {
						const diagnostic =
							error instanceof PlanningCheckpointValidationError
								? {
										diagnosticLayer: "extension_input" as const,
										...error.diagnostic,
									}
								: checkpointInputDiagnostic(error, isRecord(params) ? params : {});
						try {
							options.onCheckpointRejected?.(checkpointId, diagnostic);
						} catch {
							// A bounded diagnostic observer must not change model correction semantics.
						}
						if (error instanceof PlanningCheckpointValidationError) throw error;
						throw new PlanningCheckpointValidationError(
							error instanceof Error ? error.message : "Checkpoint input could not be parsed",
							diagnostic,
						);
					}
					let persisted: PlanningCheckpoint;
					try {
						persisted = await options.recordCheckpoint(checkpointId, checkpoint);
					} catch (error) {
						if (error instanceof PlanningCheckpointValidationError) throw error;
						// Do not let a prior model/input error mask a later database outage.
						checkpointPersistenceFailure ??= error;
						try {
							options.onPersistenceFailure?.(checkpointPersistenceFailure);
						} catch {
							// The original storage error remains the authoritative failure.
						}
						throw error;
					}
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									accepted: true,
									checkpointId: persisted.checkpointId,
									checkpointSequence: persisted.checkpointSequence,
								}),
							},
						],
						details: {
							accepted: true,
							checkpointId: persisted.checkpointId,
							checkpointSequence: persisted.checkpointSequence,
						},
					};
				},
			});
			pi.registerTool({
				name: "planning_commit_result",
				label: "Commit Planning Result",
				description:
					"Mandatory system-owned commit for the current leased task. The system binds lease and evidence IDs.",
				parameters: PARAMETERS,
				executionMode: "sequential",
				async execute(_toolCallId, params) {
					if (accepted)
						return {
							content: [{ type: "text", text: "planning_commit_result was already accepted for this lease." }],
							details: {
								accepted: true,
								duplicate: true,
								leaseId: options.leaseId,
								evidenceRefs: accepted.evidenceRefs,
							},
						};
					if (options.canSubmit?.() === false) {
						throw new Error(
							"Owned background work is still processing. Continue independent work and consume its completion before submitting this task result.",
						);
					}
					const input = isRecord(params) ? params : {};
					const evidenceRefs = selectedEvidenceRefs(input, options.evidence, options.availableEvidenceRefs?.());
					const parsed = parsePlanningTaskResult(JSON.stringify({ ...input, evidenceRefs }), options.leaseId);
					try {
						options.recordSubmission?.(parsed);
					} catch (error) {
						checkpointPersistenceFailure = error;
						options.onPersistenceFailure?.(error);
						throw error;
					}
					accepted = parsed;
					return {
						content: [
							{ type: "text", text: JSON.stringify({ accepted: true, leaseId: options.leaseId, evidenceRefs }) },
						],
						details: { accepted: true, duplicate: false, leaseId: options.leaseId, evidenceRefs },
					};
				},
			});
		},
	};
	return { extension, getResult: () => accepted, getCheckpointFailure: () => checkpointPersistenceFailure };
}
