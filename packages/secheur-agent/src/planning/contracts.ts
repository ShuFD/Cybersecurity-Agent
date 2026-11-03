import { createHash } from "node:crypto";
import type { ArtexGraph, ArtexPlanUpdate } from "./artex-types.ts";
import type { EvidenceCard } from "./evidence-cards.ts";
import { isPlanningFailureError, planningFailure } from "./failures.ts";
import type { HypothesisGraph, HypothesisGraphUpdate } from "./hypothesis-types.ts";
import type { PlanningCoverage } from "./planner-memory.ts";

export const PLANNING_SCHEMA_VERSION = 1;

export type PlanningMode = "shadow" | "active";
export type PlanningRunStatus = "created" | "running" | "paused" | "blocked" | "completed" | "failed" | "cancelled";
export type PlanningTaskStatus =
	| "proposed"
	| "ready"
	| "leased"
	| "running"
	| "done"
	| "disproved"
	| "blocked"
	| "failed"
	| "pruned";
export type PlanningLeaseStatus = "active" | "committed" | "expired" | "cancelled" | "failed";
export type PlanningTaskOutcome = "done" | "disproved" | "blocked" | "failed";
export type PlanningDecision = "create_tasks" | "finish_run" | "blocked";

export interface PlanningRun {
	runId: string;
	outerTaskId: string;
	goal: string;
	mode: PlanningMode;
	status: PlanningRunStatus;
	revision: number;
	createdAt: number;
	updatedAt: number;
	lastError?: string;
}

export interface PlanningTask {
	taskId: string;
	runId: string;
	objective: string;
	doneWhen: string;
	status: PlanningTaskStatus;
	priority: number;
	sequence: number;
	dependsOnTaskIds: string[];
	inputEvidenceRefs?: string[];
	parentTaskId?: string;
	createdAt: number;
	updatedAt: number;
	lastError?: string;
}

export interface PlanningEvidence {
	evidenceId: string;
	runId: string;
	taskId: string;
	leaseId: string;
	kind: "tool" | "observation";
	source: string;
	toolName?: string;
	summary: string;
	excerpt: string;
	contentRef: string | null;
	contentHash: string;
	excerptHash?: string | null;
	locator: Record<string, unknown>;
	contentBytes: number;
	contentComplete: boolean;
	isTruncated: boolean;
	metadata: Record<string, unknown>;
	createdAt: number;
}

export interface PlanningTaskLease {
	schemaVersion: typeof PLANNING_SCHEMA_VERSION;
	leaseId: string;
	runId: string;
	taskId: string;
	planRevision: number;
	objective: string;
	doneWhen: string;
	allowedScope: string;
	issuedAt: number;
	expiresAt: number;
	attempt?: number;
}

export interface PlanningTaskSummary {
	taskId: string;
	objective: string;
	outcome: PlanningTaskOutcome;
	summary: string;
	evidenceRefs: string[];
	suggestedTasks?: SuggestedPlanningTask[];
}

export interface PlanningFactInput {
	key: string;
	value: unknown;
	evidenceRefs: string[];
}

export interface PlanningFact extends PlanningFactInput {
	sourceTaskId: string;
}

export interface PlanningRejectedDirectionInput {
	direction: string;
	reason: string;
	evidenceRefs: string[];
}

export interface PlanningRejectedDirection extends PlanningRejectedDirectionInput {
	sourceTaskId: string;
}

export interface PlanningOpenQuestionInput {
	questionId: string;
	text: string;
}

export interface PlanningOpenQuestion extends PlanningOpenQuestionInput {
	sourceTaskId: string;
}

export interface PlanningArtifactInput {
	path: string;
	type: string;
	description: string;
	sha256?: string;
}

export interface PlanningArtifact extends PlanningArtifactInput {
	sourceTaskId: string;
	/** Host-derived producer workspace alias; never accepted from a tool submission. */
	logicalPath?: string;
	sourceLeaseId?: string;
}

export interface PlanningExecutionFrame {
	schemaVersion: typeof PLANNING_SCHEMA_VERSION;
	taskSummaries: PlanningTaskSummary[];
	facts: PlanningFact[];
	rejectedDirections: PlanningRejectedDirection[];
	openQuestions: PlanningOpenQuestion[];
	artifacts: PlanningArtifact[];
}

export interface PlanningExecutionFrameRecord {
	runId: string;
	revision: number;
	frame: PlanningExecutionFrame;
	updatedAt: number;
}

export interface PlanningSnapshot {
	artexGraph?: ArtexGraph;
	evidenceCards?: EvidenceCard[];
	hypothesisGraph?: HypothesisGraph;
	run: PlanningRun;
	tasks: PlanningTask[];
	evidence: PlanningEvidence[];
	executionFrame: PlanningExecutionFrameRecord;
	latestCheckpoint?: PlanningCheckpoint;
	latestFailure?: PlanningAttemptReport;
	/** Optional bounded attempt history for a parallel Planner handoff. */
	recentFailures?: PlanningAttemptReport[];
	/** All active attempts; activeLease remains a compatibility projection. */
	activeLeases?: PlanningTaskLease[];
	activeLease?: PlanningTaskLease;
}

/** Host-derived proof that a persisted verifier tool result passed the canonical gate. */
export interface TrustedPlanningVerification {
	source: "planning_verifier_evidence";
	verificationOutcome: "correct";
	planningRunId: string;
	taskId: string;
	leaseId: string;
	evidenceId: string;
	evidenceCreatedAt: number;
	challengeId?: string;
}

/** Prompt-scoped cancellation and Bridge generation for a trusted proof handoff. */
export interface TrustedPlanningVerificationContext {
	signal: AbortSignal;
	bridgeRunGeneration?: number;
}

export interface ProposedPlanningTask {
	key: string;
	objective: string;
	doneWhen: string;
	priority?: number;
	dependsOn?: string[];
	inputEvidenceRefs?: string[];
	parent?: string;
}

export interface PlanningPlanProposal {
	artexUpdate?: ArtexPlanUpdate;
	artexWaitingTaskIds?: string[];
	hypothesisUpdate?: HypothesisGraphUpdate;
	hypothesisWaitingTaskIds?: string[];
	schemaVersion: typeof PLANNING_SCHEMA_VERSION;
	expectedRevision: number;
	decision?: PlanningDecision;
	rationale: string;
	tasks: ProposedPlanningTask[];
	answerEvidenceRefs?: string[];
	coverage?: PlanningCoverage;
}

export function stablePlanningTaskId(runId: string, key: string): string {
	return `plan_${createHash("sha256").update(`${runId}\0${key}`).digest("hex").slice(0, 24)}`;
}

export interface SuggestedPlanningTask {
	objective: string;
	doneWhen: string;
	priority?: number;
	dependsOnCurrent?: boolean;
	inputEvidenceRefs?: string[];
}

export interface PlanningCheckpointInput {
	summary: string;
	evidenceRefs: string[];
	completedItems: string[];
	remainingItems: string[];
	rejectedDirections: PlanningRejectedDirectionInput[];
	artifacts: PlanningArtifactInput[];
	suggestedNextSteps: SuggestedPlanningTask[];
}

export interface PlanningCheckpoint extends PlanningCheckpointInput {
	schemaVersion: typeof PLANNING_SCHEMA_VERSION;
	checkpointId: string;
	runId: string;
	taskId: string;
	leaseId: string;
	checkpointSequence: number;
	source: "executor";
	createdAt: number;
}

export interface PlanningAttemptReport {
	runId: string;
	taskId: string;
	leaseId: string;
	attempt: number;
	objective: string;
	doneWhen: string;
	source: "runtime_failure";
	stage: string;
	code: string;
	message: string;
	executorSummary?: string;
	evidenceRefs: string[];
	checkpointId?: string;
	checkpoint?: PlanningCheckpoint;
	completedItems: string[];
	remainingItems: string[];
	rejectedDirections: PlanningRejectedDirectionInput[];
	suggestedNextSteps: SuggestedPlanningTask[];
	createdAt: number;
}

export interface PlanningFlagCandidate {
	candidate: string;
	confidence: number;
	rationale: string;
}

export function planningFlagCandidateHash(candidate: string): string {
	return createHash("sha256").update(candidate.trim()).digest("hex");
}

export interface PlanningTaskResult {
	schemaVersion: typeof PLANNING_SCHEMA_VERSION;
	leaseId: string;
	outcome: PlanningTaskOutcome;
	summary: string;
	suggestedTasks: SuggestedPlanningTask[];
	flagCandidates: PlanningFlagCandidate[];
	evidenceRefs?: string[];
	facts?: PlanningFactInput[];
	rejectedDirections?: PlanningRejectedDirectionInput[];
	openQuestions?: PlanningOpenQuestionInput[];
	resolvedQuestionIds?: string[];
	artifacts?: PlanningArtifactInput[];
}

export interface PlanningEvidenceInput {
	evidenceId?: string;
	kind: PlanningEvidence["kind"];
	source: string;
	toolName?: string;
	summary: string;
	excerpt?: string;
	contentRef?: string | null;
	contentHash: string;
	excerptHash?: string | null;
	locator?: Record<string, unknown>;
	contentBytes?: number;
	contentComplete?: boolean;
	isTruncated?: boolean;
	metadata?: Record<string, unknown>;
}

export interface PlanningEvidenceReadResult {
	contentRef: string;
	contentHash: string;
	offset: number;
	nextOffset: number;
	totalBytes: number;
	hasMore: boolean;
	content: string;
	contentComplete: boolean;
}

export interface PlanningEvidenceListOptions {
	cursor?: string;
	limit?: number;
	taskId?: string;
	leaseId?: string;
	toolName?: string;
	outcome?: "success" | "error";
	keyword?: string;
}

export interface PlanningEvidenceListResult {
	items: PlanningEvidence[];
	totalCount: number;
	hasMore: boolean;
	nextCursor: string | null;
}

export interface PlanningObserverReportItem {
	text: string;
	evidenceIds: string[];
}

/** A progress report only; it is not a trusted verification or task submission. */
export interface PlanningObserverReport {
	attempted: string[];
	observedResults: PlanningObserverReportItem[];
	observerJudgments: PlanningObserverReportItem[];
	unverifiedHypotheses: string[];
	failuresOrStalls: string[];
	avoidRepeating: string[];
	openQuestions: string[];
	guidance?: string;
}

export interface PlanningExecutionReport {
	result: PlanningTaskResult;
	evidence: PlanningEvidenceInput[];
	commitSource: "planning_commit_result";
	/** Actual executor cwd, supplied by the host adapter rather than the model. */
	artifactWorkspace?: string;
}

function observerStringList(value: unknown, label: string, maximumItems = 16): string[] {
	if (!Array.isArray(value) || value.length > maximumItems)
		throw new Error(`${label} must be an array of at most ${maximumItems} items`);
	return value.map((item, index) => text(item, `${label}[${index}]`, 2_000));
}

function observerReportItems(value: unknown, label: string): PlanningObserverReportItem[] {
	if (!Array.isArray(value) || value.length > 16) throw new Error(`${label} must be an array of at most 16 items`);
	return value.map((item, index) => {
		if (!isRecord(item)) throw new Error(`${label}[${index}] must be an object`);
		const rawRefs = item.evidenceIds;
		if (!Array.isArray(rawRefs) || rawRefs.length > 32) {
			throw new Error(`${label}[${index}].evidenceIds must be an array of at most 32 IDs`);
		}
		const evidenceIds = [
			...new Set(
				rawRefs.map((reference, referenceIndex) =>
					text(reference, `${label}[${index}].evidenceIds[${referenceIndex}]`, 256),
				),
			),
		];
		return { text: text(item.text, `${label}[${index}].text`, 2_000), evidenceIds };
	});
}

export function parsePlanningObserverReport(source: string): PlanningObserverReport {
	const raw: unknown = JSON.parse(source);
	if (!isRecord(raw)) throw new Error("Planning observer report must be a JSON object");
	const report: PlanningObserverReport = {
		attempted: observerStringList(raw.attempted, "attempted"),
		observedResults: observerReportItems(raw.observedResults, "observedResults"),
		observerJudgments: observerReportItems(raw.observerJudgments ?? raw.supportedConclusions, "observerJudgments"),
		unverifiedHypotheses: observerStringList(raw.unverifiedHypotheses, "unverifiedHypotheses"),
		failuresOrStalls: observerStringList(raw.failuresOrStalls, "failuresOrStalls"),
		avoidRepeating: observerStringList(raw.avoidRepeating, "avoidRepeating"),
		openQuestions: observerStringList(raw.openQuestions, "openQuestions"),
		...(typeof raw.guidance === "string" && raw.guidance.trim()
			? { guidance: text(raw.guidance, "guidance", 1_000) }
			: {}),
	};
	return report;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstPresent(record: Record<string, unknown>, keys: readonly string[]): unknown {
	for (const key of keys) if (Object.hasOwn(record, key)) return record[key];
	return undefined;
}

function text(value: unknown, label: string, maximum = 40_000): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
	return value.trim().slice(0, maximum);
}

function number(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringArray(value: unknown, maximumItems = 256, maximumLength = 256): string[] {
	if (!Array.isArray(value)) return [];
	return [
		...new Set(
			value
				.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
				.map((item) => item.trim().slice(0, maximumLength)),
		),
	].slice(0, maximumItems);
}

function boundedStringArray(value: unknown, maximumItems: number, maximumLength: number): string[] {
	return stringArray(value, maximumItems, maximumLength);
}

function planningEvidenceReferenceArray(value: unknown, maximumItems = 256, maximumLength = 256): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("inputEvidenceRefs must be an array");
	if (value.length > maximumItems) throw new Error(`inputEvidenceRefs exceeds ${maximumItems} items`);
	const result: string[] = [];
	for (const [index, reference] of value.entries()) {
		if (typeof reference !== "string" || reference.length === 0 || reference.trim() !== reference) {
			throw new Error(`inputEvidenceRefs[${index}] must be an exact non-empty evidenceId`);
		}
		if (reference.length > maximumLength) {
			throw new Error(`inputEvidenceRefs[${index}] exceeds ${maximumLength} characters`);
		}
		if (!result.includes(reference)) result.push(reference);
	}
	return result;
}

function parseRejectedDirections(value: unknown): PlanningRejectedDirectionInput[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry, index): PlanningRejectedDirectionInput[] => {
		if (!isRecord(entry)) return [];
		try {
			return [
				{
					direction: text(entry.direction, `Rejected direction ${index}`, 2_000),
					reason: text(entry.reason, `Rejected direction ${index} reason`, 20_000),
					evidenceRefs: boundedStringArray(entry.evidenceRefs ?? entry.evidence_refs, 256, 256),
				},
			];
		} catch {
			return [];
		}
	});
}

function parseSuggestedTasks(value: unknown): SuggestedPlanningTask[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry): SuggestedPlanningTask[] => {
		if (!isRecord(entry)) return [];
		try {
			const inputEvidenceRefs = boundedStringArray(
				entry.inputEvidenceRefs ?? entry.input_evidence_refs ?? entry.evidenceRefs ?? entry.evidence_refs,
				256,
				256,
			);
			return [
				{
					objective: text(entry.objective, "Suggested task objective"),
					doneWhen: text(entry.doneWhen ?? entry.done_when, "Suggested task doneWhen"),
					priority: Math.max(-100, Math.min(100, number(entry.priority, 0))),
					dependsOnCurrent: entry.dependsOnCurrent === true || entry.depends_on_current === true,
					...(inputEvidenceRefs.length > 0 ? { inputEvidenceRefs } : {}),
				},
			];
		} catch {
			return [];
		}
	});
}

function boundedJsonValue(value: unknown, label: string): unknown {
	if (value === undefined) throw new Error(`${label} is required`);
	const serialized = JSON.stringify(value);
	if (serialized === undefined || serialized.length > 20_000) throw new Error(`${label} must be bounded JSON`);
	return JSON.parse(serialized) as unknown;
}

function jsonObjectFromText(value: string): Record<string, unknown> {
	const candidates = [value.trim()];
	for (const match of value.matchAll(/[\x60]{3}(?:json)?\s*([\s\S]*?)[\x60]{3}/giu)) candidates.push(match[1].trim());
	const start = value.indexOf("{");
	const end = value.lastIndexOf("}");
	if (start >= 0 && end > start) candidates.push(value.slice(start, end + 1));
	for (const candidate of candidates) {
		try {
			const parsed: unknown = JSON.parse(candidate);
			if (isRecord(parsed)) return parsed;
		} catch {
			// Try the next bounded JSON candidate.
		}
	}
	throw new Error("Model response did not contain a valid JSON object");
}

export function parsePlanningCheckpoint(value: string): PlanningCheckpointInput {
	const raw = jsonObjectFromText(value);
	const summary = checkpointText(raw.summary, "Checkpoint summary", 8_000);
	const evidenceRefs = checkpointStringArray(
		firstPresent(raw, ["evidenceRefs", "evidence_refs"]),
		"evidenceRefs",
		256,
		256,
		true,
	);
	const completedItems = checkpointStringArray(
		firstPresent(raw, ["completedItems", "completed_items"]),
		"completedItems",
		64,
		2_000,
	);
	const remainingItems = checkpointStringArray(
		firstPresent(raw, ["remainingItems", "remaining_items"]),
		"remainingItems",
		64,
		2_000,
	);
	const artifacts = checkpointArray(raw.artifacts, "artifacts", 64).map((entry, index): PlanningArtifactInput => {
		if (!isRecord(entry)) throw new Error(`Checkpoint artifact ${index} must be an object`);
		const sha256 = entry.sha256;
		if (sha256 !== undefined && (typeof sha256 !== "string" || sha256.length > 128)) {
			throw new Error(`Checkpoint artifact ${index} sha256 is invalid`);
		}
		return {
			path: checkpointText(entry.path, `Checkpoint artifact ${index} path`, 4_096),
			type: checkpointText(entry.type, `Checkpoint artifact ${index} type`, 256),
			description: checkpointText(entry.description, `Checkpoint artifact ${index} description`, 8_000),
			...(typeof sha256 === "string" && sha256.trim() ? { sha256: sha256.trim() } : {}),
		};
	});
	const rejectedDirections = checkpointArray(
		firstPresent(raw, ["rejectedDirections", "rejected_directions"]),
		"rejectedDirections",
		64,
	).map((entry, index): PlanningRejectedDirectionInput => {
		if (!isRecord(entry)) throw new Error(`Checkpoint rejected direction ${index} must be an object`);
		return {
			direction: checkpointText(entry.direction, `Checkpoint rejected direction ${index} direction`, 2_000),
			reason: checkpointText(entry.reason, `Checkpoint rejected direction ${index} reason`, 20_000),
			evidenceRefs: checkpointStringArray(
				firstPresent(entry, ["evidenceRefs", "evidence_refs"]),
				`rejectedDirections[${index}].evidenceRefs`,
				256,
				256,
				true,
			),
		};
	});
	const suggestedNextSteps = checkpointArray(
		firstPresent(raw, ["suggestedNextSteps", "suggested_next_steps"]),
		"suggestedNextSteps",
		48,
	).map((entry, index): SuggestedPlanningTask => {
		if (!isRecord(entry)) throw new Error(`Checkpoint suggested next step ${index} must be an object`);
		const inputEvidenceRefs = checkpointStringArray(
			firstPresent(entry, ["inputEvidenceRefs", "input_evidence_refs", "evidenceRefs", "evidence_refs"]),
			`suggestedNextSteps[${index}].inputEvidenceRefs`,
			256,
			256,
			true,
		);
		return {
			objective: checkpointText(entry.objective, `Checkpoint suggested next step ${index} objective`),
			doneWhen: checkpointText(
				entry.doneWhen ?? entry.done_when,
				`Checkpoint suggested next step ${index} doneWhen`,
			),
			priority: Math.max(-100, Math.min(100, number(entry.priority, 0))),
			dependsOnCurrent: entry.dependsOnCurrent === true || entry.depends_on_current === true,
			...(inputEvidenceRefs.length > 0 ? { inputEvidenceRefs } : {}),
		};
	});
	return {
		summary,
		evidenceRefs,
		completedItems,
		remainingItems,
		rejectedDirections,
		artifacts,
		suggestedNextSteps,
	};
}

function checkpointArray(value: unknown, label: string, maximumItems: number): unknown[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`Checkpoint ${label} must be an array`);
	if (value.length > maximumItems) throw new Error(`Checkpoint ${label} exceeds ${maximumItems} items`);
	return value;
}

function checkpointText(value: unknown, label: string, maximumLength = 40_000): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
	const normalized = value.trim();
	if (normalized.length > maximumLength) throw new Error(`${label} exceeds ${maximumLength} characters`);
	return normalized;
}

function checkpointStringArray(
	value: unknown,
	label: string,
	maximumItems: number,
	maximumLength = 256,
	exactValues = false,
): string[] {
	const items = checkpointArray(value, label, maximumItems);
	const result: string[] = [];
	for (const [index, item] of items.entries()) {
		if (typeof item !== "string" || !item.trim())
			throw new Error(`Checkpoint ${label}[${index}] must be a non-empty string`);
		const normalized = item.trim();
		if (exactValues && normalized !== item)
			throw new Error(`Checkpoint ${label}[${index}] must be an exact evidenceId without surrounding whitespace`);
		if (normalized.length > maximumLength)
			throw new Error(`Checkpoint ${label}[${index}] exceeds ${maximumLength} characters`);
		if (!result.includes(normalized)) result.push(normalized);
	}
	return result;
}

export function planningTaskInputEvidenceRefs(task: { inputEvidenceRefs?: string[] }): string[] {
	return [
		...new Set((task.inputEvidenceRefs ?? []).filter((value) => typeof value === "string" && value.trim())),
	].sort();
}

export function planningTaskSignature(task: {
	objective: string;
	doneWhen: string;
	inputEvidenceRefs?: string[];
}): string {
	return JSON.stringify([task.objective.trim(), task.doneWhen.trim(), planningTaskInputEvidenceRefs(task)]);
}

export function parsePlanningPlanProposal(value: string, expectedRevision: number): PlanningPlanProposal {
	let raw: Record<string, unknown>;
	try {
		raw = jsonObjectFromText(value);
	} catch (error) {
		if (isPlanningFailureError(error)) throw error;
		throw planningFailure(
			"supervisor_parse",
			"supervisor_parse_error",
			error instanceof Error ? error.message : String(error),
			error,
		);
	}
	const taskValues = raw.tasks ?? [];
	if (!Array.isArray(taskValues)) {
		throw planningFailure("proposal_validation", "proposal_validation_error", "Plan proposal tasks must be an array");
	}
	const tasks = taskValues.map((entry, index): ProposedPlanningTask => {
		try {
			if (!isRecord(entry)) throw new Error(`Plan task ${index} must be an object`);
			const dependencyValues = entry.dependsOn ?? entry.depends_on;
			const inputEvidenceRefs = planningEvidenceReferenceArray(
				firstPresent(entry, ["inputEvidenceRefs", "input_evidence_refs", "evidenceRefs", "evidence_refs"]),
			);
			return {
				key: text(entry.key ?? `task-${index + 1}`, `Plan task ${index} key`, 120),
				objective: text(entry.objective, `Plan task ${index} objective`),
				doneWhen: text(entry.doneWhen ?? entry.done_when, `Plan task ${index} doneWhen`),
				priority: Math.max(-100, Math.min(100, number(entry.priority, 0))),
				dependsOn: stringArray(dependencyValues, 48, 256),
				...(inputEvidenceRefs.length > 0 ? { inputEvidenceRefs } : {}),
				...(typeof entry.parent === "string" && entry.parent.trim() ? { parent: entry.parent.trim() } : {}),
			};
		} catch (error) {
			if (isPlanningFailureError(error)) throw error;
			throw planningFailure(
				"proposal_validation",
				"proposal_validation_error",
				error instanceof Error ? error.message : String(error),
				error,
			);
		}
	});
	const rawDecision = typeof raw.decision === "string" ? raw.decision.trim().toLowerCase() : "";
	const aliases: Record<string, PlanningDecision> = {
		create_tasks: "create_tasks",
		continue: "create_tasks",
		plan: "create_tasks",
		finish_run: "finish_run",
		finish: "finish_run",
		complete: "finish_run",
		blocked: "blocked",
	};
	return {
		schemaVersion: PLANNING_SCHEMA_VERSION,
		expectedRevision,
		decision: aliases[rawDecision] ?? (tasks.length > 0 ? "create_tasks" : "finish_run"),
		rationale: typeof raw.rationale === "string" ? raw.rationale.trim().slice(0, 20_000) : "",
		tasks,
		answerEvidenceRefs: stringArray(raw.answerEvidenceRefs ?? raw.answer_evidence_refs),
		...(raw.coverage ? { coverage: raw.coverage as PlanningCoverage } : {}),
	};
}

export function validatePlanningDependencies(proposal: PlanningPlanProposal, snapshot: PlanningSnapshot): void {
	const proposalKeys = new Set(proposal.tasks.map((task) => task.key));
	const existingTaskIds = snapshot.tasks.map((task) => task.taskId);
	const allowedDependencies = new Set([...proposalKeys, ...existingTaskIds]);
	const existingById = new Map(snapshot.tasks.map((task) => [task.taskId, task]));
	const knownEvidenceIds = new Set(
		(snapshot.evidence ?? []).filter((item) => item.runId === snapshot.run.runId).map((item) => item.evidenceId),
	);
	for (const task of proposal.tasks) {
		for (const dependency of task.dependsOn ?? []) {
			const existing = existingById.get(dependency);
			if (existing && ["failed", "blocked", "pruned"].includes(existing.status)) {
				throw new Error(
					`unrunnable dependency: ${dependency} is ${existing.status}. Reuse its persisted inputEvidenceRefs without a completion dependency, or plan an independent recovery task. Do not recreate or wait for this terminal task.`,
				);
			}
			if (allowedDependencies.has(dependency)) continue;
			throw new Error(
				[
					`unknown dependency: ${dependency}`,
					"allowed existing taskIds:",
					...(existingTaskIds.length > 0 ? existingTaskIds.map((taskId) => `- ${taskId}`) : ["- (none)"]),
				].join("\n"),
			);
		}
		const unknownEvidenceIds = (task.inputEvidenceRefs ?? []).filter((id) => !knownEvidenceIds.has(id));
		if (unknownEvidenceIds.length > 0) {
			throw new Error(`unknown input evidence: ${unknownEvidenceIds.join(", ")}`);
		}
	}
}

export function validatePlanningTaskIdentities(
	runId: string,
	proposal: PlanningPlanProposal,
	existingTasks: readonly Pick<PlanningTask, "taskId">[],
): void {
	const existingTaskIds = new Set(existingTasks.map((task) => task.taskId));
	for (const task of proposal.tasks) {
		const taskId = stablePlanningTaskId(runId, task.key);
		if (existingTaskIds.has(taskId)) {
			throw planningFailure(
				"supervisor_validation",
				"duplicate_task_identity",
				`task key already exists in this run: ${task.key} (${taskId})`,
			);
		}
	}
}

export function parsePlanningTaskResult(value: string, leaseId: string): PlanningTaskResult {
	const raw = jsonObjectFromText(value);
	const rawOutcome = typeof raw.outcome === "string" ? raw.outcome.trim().toLowerCase() : raw.outcome;
	const outcomeAliases: Record<string, PlanningTaskOutcome> = {
		done: "done",
		completed: "done",
		complete: "done",
		success: "done",
		disproved: "disproved",
		blocked: "blocked",
		failed: "failed",
	};
	const outcome = typeof rawOutcome === "string" ? outcomeAliases[rawOutcome] : undefined;
	if (!outcome) throw new Error("Task result outcome must be done, disproved, blocked, or failed");
	const suggestedTaskValues = raw.suggestedTasks ?? raw.suggested_tasks;
	const suggestedTasks = parseSuggestedTasks(suggestedTaskValues);
	const flagCandidateValues = raw.flagCandidates ?? raw.flag_candidates;
	const flagCandidates = Array.isArray(flagCandidateValues)
		? flagCandidateValues.flatMap((entry): PlanningFlagCandidate[] => {
				if (!isRecord(entry) || typeof entry.candidate !== "string" || !entry.candidate.trim()) return [];
				return [
					{
						candidate: entry.candidate.trim().slice(0, 8_192),
						confidence: Math.max(0, Math.min(1, number(entry.confidence, 0))),
						rationale: typeof entry.rationale === "string" ? entry.rationale.trim().slice(0, 20_000) : "",
					},
				];
			})
		: [];
	const facts = Array.isArray(raw.facts)
		? raw.facts.flatMap((entry, index): PlanningFactInput[] => {
				if (!isRecord(entry)) return [];
				try {
					return [
						{
							key: text(entry.key, `Fact ${index} key`, 256),
							value: boundedJsonValue(entry.value, `Fact ${index} value`),
							evidenceRefs: stringArray(entry.evidenceRefs ?? entry.evidence_refs),
						},
					];
				} catch {
					return [];
				}
			})
		: [];
	const rejectedDirections = parseRejectedDirections(raw.rejectedDirections ?? raw.rejected_directions);
	const questionValues = raw.openQuestions ?? raw.open_questions;
	const openQuestions = Array.isArray(questionValues)
		? questionValues.flatMap((entry, index): PlanningOpenQuestionInput[] => {
				if (!isRecord(entry)) return [];
				try {
					return [
						{
							questionId: text(entry.questionId ?? entry.question_id, `Open question ${index} id`, 256),
							text: text(entry.text, `Open question ${index} text`, 20_000),
						},
					];
				} catch {
					return [];
				}
			})
		: [];
	const artifacts = Array.isArray(raw.artifacts)
		? raw.artifacts.flatMap((entry, index): PlanningArtifactInput[] => {
				if (!isRecord(entry)) return [];
				try {
					return [
						{
							path: text(entry.path, `Artifact ${index} path`, 4_096),
							type: text(entry.type, `Artifact ${index} type`, 256),
							description: text(entry.description, `Artifact ${index} description`, 20_000),
							...(typeof entry.sha256 === "string" && entry.sha256.trim()
								? { sha256: entry.sha256.trim().slice(0, 128) }
								: {}),
						},
					];
				} catch {
					return [];
				}
			})
		: [];
	return {
		schemaVersion: PLANNING_SCHEMA_VERSION,
		leaseId,
		outcome: outcome as PlanningTaskOutcome,
		summary: text(raw.summary, "Task result summary"),
		suggestedTasks,
		flagCandidates,
		evidenceRefs: stringArray(raw.evidenceRefs ?? raw.evidence_refs),
		facts,
		rejectedDirections,
		openQuestions,
		resolvedQuestionIds: stringArray(raw.resolvedQuestionIds ?? raw.resolved_question_ids),
		artifacts,
	};
}
