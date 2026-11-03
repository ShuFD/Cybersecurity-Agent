import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import {
	PLANNING_SCHEMA_VERSION,
	type PlanningArtifact,
	type PlanningArtifactInput,
	type PlanningEvidence,
	type PlanningExecutionFrame,
	type PlanningFact,
	type PlanningOpenQuestion,
	type PlanningRejectedDirection,
	type PlanningTask,
	type PlanningTaskResult,
} from "./contracts.ts";

const LIMITS = { taskSummaries: 64, facts: 128, rejectedDirections: 64, openQuestions: 64, artifacts: 64 };

export function emptyExecutionFrame(): PlanningExecutionFrame {
	return {
		schemaVersion: PLANNING_SCHEMA_VERSION,
		taskSummaries: [],
		facts: [],
		rejectedDirections: [],
		openQuestions: [],
		artifacts: [],
	};
}

export function normalizeExecutionFrame(value: unknown): PlanningExecutionFrame {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return emptyExecutionFrame();
	const record = value as Record<string, unknown>;
	return {
		schemaVersion: PLANNING_SCHEMA_VERSION,
		taskSummaries: Array.isArray(record.taskSummaries)
			? (record.taskSummaries as PlanningExecutionFrame["taskSummaries"])
			: [],
		facts: Array.isArray(record.facts) ? (record.facts as PlanningFact[]) : [],
		rejectedDirections: Array.isArray(record.rejectedDirections)
			? (record.rejectedDirections as PlanningRejectedDirection[])
			: [],
		openQuestions: Array.isArray(record.openQuestions) ? (record.openQuestions as PlanningOpenQuestion[]) : [],
		artifacts: Array.isArray(record.artifacts) ? (record.artifacts as PlanningArtifact[]) : [],
	};
}

function upsertBy<T>(values: T[], incoming: T[], key: (value: T) => string, maximum: number): T[] {
	const merged = new Map(values.map((value) => [key(value), value]));
	for (const value of incoming) merged.set(key(value), value);
	return [...merged.values()].slice(-maximum);
}

function groundedRefs(requested: string[], fallback: string[], evidenceById: Map<string, PlanningEvidence>): string[] {
	const candidates = requested.length > 0 ? requested : fallback;
	return [
		...new Set(
			candidates.filter((id) => {
				const evidence = evidenceById.get(id);
				return evidence?.kind === "tool" && evidence.metadata.isError !== true;
			}),
		),
	];
}

export type ArtifactScopeRejectionReason =
	| "artifact_path_invalid"
	| "artifact_not_found"
	| "artifact_outside_allowed_scope"
	| "artifact_scope_unverifiable";

export type ArtifactScopeResolution =
	| { accepted: true; canonicalPath: string }
	| { accepted: false; reason: ArtifactScopeRejectionReason };

export function resolveArtifactScope(path: string, allowedScope: string): ArtifactScopeResolution {
	if (!isAbsolute(path)) return { accepted: false, reason: "artifact_path_invalid" };
	if (!existsSync(path)) return { accepted: false, reason: "artifact_not_found" };
	if (!isAbsolute(allowedScope)) return { accepted: false, reason: "artifact_scope_unverifiable" };
	try {
		const root = realpathSync(resolve(allowedScope));
		const candidate = realpathSync(resolve(path));
		const child = relative(root, candidate);
		if (child === "" || (!child.startsWith("..") && !isAbsolute(child))) {
			return { accepted: true, canonicalPath: candidate };
		}
		return { accepted: false, reason: "artifact_outside_allowed_scope" };
	} catch {
		return existsSync(path)
			? { accepted: false, reason: "artifact_scope_unverifiable" }
			: { accepted: false, reason: "artifact_not_found" };
	}
}

export function artifactWithinScope(path: string, allowedScope: string): string | undefined {
	const result = resolveArtifactScope(path, allowedScope);
	return result.accepted ? result.canonicalPath : undefined;
}

export function artifactLogicalPath(path: string): string | undefined {
	if (!path || path.includes("\0") || posix.isAbsolute(path) || win32.isAbsolute(path) || /^[a-z]:/i.test(path))
		return undefined;
	const parts = path.replaceAll("\\", "/").split("/");
	if (parts.includes("..")) return undefined;
	return parts.filter((part) => part && part !== ".").join("/") || undefined;
}

/** Register only validated artifacts, deriving aliases from a trusted host cwd. */
export function registerPlanningArtifact(
	artifact: PlanningArtifactInput,
	allowedScope: string,
	sourceTaskId: string,
	sourceLeaseId?: string,
	artifactWorkspace?: string,
): PlanningArtifact | undefined {
	const path = artifactWithinScope(artifact.path, allowedScope);
	if (!path) return undefined;
	const workspace = artifactWorkspace ? resolveArtifactScope(artifactWorkspace, allowedScope) : undefined;
	const logicalPath = workspace?.accepted
		? artifactLogicalPath(relative(workspace.canonicalPath, path).split(sep).join("/"))
		: undefined;
	return {
		path,
		type: artifact.type,
		description: artifact.description,
		...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
		sourceTaskId,
		...(sourceLeaseId && logicalPath ? { sourceLeaseId, logicalPath } : {}),
	};
}

export interface ReduceExecutionFrameInput {
	frame: PlanningExecutionFrame;
	task: PlanningTask;
	result: PlanningTaskResult;
	evidence: PlanningEvidence[];
	allowedScope: string;
	artifactWorkspace?: string;
	sourceLeaseId?: string;
	preserveTaskProvenance?: boolean;
}

export function reduceExecutionFrame(input: ReduceExecutionFrameInput): PlanningExecutionFrame {
	const frame = normalizeExecutionFrame(input.frame);
	const keyWithTask = (taskId: string, key: string): string =>
		input.preserveTaskProvenance ? JSON.stringify([taskId, key]) : key;
	const evidenceById = new Map(input.evidence.map((item) => [item.evidenceId, item]));
	const resultEvidenceRefs = input.result.evidenceRefs ?? [];
	const defaultRefs = groundedRefs(resultEvidenceRefs, [], evidenceById);
	const taskRefs = resultEvidenceRefs.filter((id) => evidenceById.has(id));
	const taskSummaries = upsertBy(
		frame.taskSummaries,
		[
			{
				taskId: input.task.taskId,
				objective: input.task.objective,
				outcome: input.result.outcome,
				summary: input.result.summary,
				evidenceRefs: taskRefs,
				suggestedTasks: input.result.suggestedTasks,
			},
		],
		(value) => value.taskId,
		LIMITS.taskSummaries,
	);
	const facts = (input.result.facts ?? []).flatMap((fact): PlanningFact[] => {
		const evidenceRefs = groundedRefs(fact.evidenceRefs, defaultRefs, evidenceById);
		return evidenceRefs.length > 0 ? [{ ...fact, sourceTaskId: input.task.taskId, evidenceRefs }] : [];
	});
	const rejected = (input.result.rejectedDirections ?? []).flatMap((direction): PlanningRejectedDirection[] => {
		const evidenceRefs = groundedRefs(direction.evidenceRefs, defaultRefs, evidenceById);
		return evidenceRefs.length > 0 ? [{ ...direction, sourceTaskId: input.task.taskId, evidenceRefs }] : [];
	});
	if (input.result.outcome === "disproved" && rejected.length === 0 && defaultRefs.length > 0) {
		rejected.push({
			direction: input.task.objective,
			reason: input.result.summary,
			sourceTaskId: input.task.taskId,
			evidenceRefs: defaultRefs,
		});
	}
	// Parallel tasks often reuse labels such as Q1. Expose stable task-owned
	// IDs in the Frame so resolving one branch cannot silently close another.
	const questionId = (id: string): string =>
		input.preserveTaskProvenance
			? "question_" +
				createHash("sha256")
					.update(JSON.stringify([input.task.taskId, id]))
					.digest("hex")
					.slice(0, 24)
			: id;
	const resolved = new Set((input.result.resolvedQuestionIds ?? []).flatMap((id) => [id, questionId(id)]));
	const retainedQuestions = frame.openQuestions.filter((question) => !resolved.has(question.questionId));
	const openQuestions = upsertBy(
		retainedQuestions,
		(input.result.openQuestions ?? []).map((question) => ({
			...question,
			questionId: frame.openQuestions.some(
				(existing) => existing.questionId === question.questionId && existing.sourceTaskId === input.task.taskId,
			)
				? question.questionId
				: questionId(question.questionId),
			sourceTaskId: input.task.taskId,
		})),
		(value) => keyWithTask(value.sourceTaskId, value.questionId),
		LIMITS.openQuestions,
	);
	const artifacts = (input.result.artifacts ?? []).flatMap((artifact): PlanningArtifact[] => {
		const registered = registerPlanningArtifact(
			artifact,
			input.allowedScope,
			input.task.taskId,
			input.sourceLeaseId,
			input.artifactWorkspace,
		);
		return registered ? [registered] : [];
	});
	return {
		schemaVersion: PLANNING_SCHEMA_VERSION,
		taskSummaries,
		facts: upsertBy(frame.facts, facts, (value) => keyWithTask(value.sourceTaskId, value.key), LIMITS.facts),
		rejectedDirections: upsertBy(
			frame.rejectedDirections,
			rejected,
			(value) => keyWithTask(value.sourceTaskId, value.direction),
			LIMITS.rejectedDirections,
		),
		openQuestions,
		artifacts: upsertBy(
			frame.artifacts,
			artifacts,
			(value) => keyWithTask(value.sourceTaskId, value.path),
			LIMITS.artifacts,
		),
	};
}
