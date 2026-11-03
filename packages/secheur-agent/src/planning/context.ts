import type { PlanningEvidence, PlanningSnapshot, PlanningTaskLease } from "./contracts.ts";
import { trustedPlanningVerificationFromSnapshot } from "./terminal-verification.ts";

const CONTEXT_TRUNCATION_MARKER = "\n[context truncated]";

function truncateUtf8(value: string, maximumBytes: number): string {
	const limit = Math.max(0, Math.trunc(maximumBytes));
	if (Buffer.byteLength(value, "utf8") <= limit) return value;
	if (limit === 0) return "";
	const markerBytes = Buffer.byteLength(CONTEXT_TRUNCATION_MARKER, "utf8");
	const contentLimit = markerBytes < limit ? limit - markerBytes : limit;
	let result = "";
	let used = 0;
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (used + characterBytes > contentLimit) break;
		result += character;
		used += characterBytes;
	}
	return markerBytes < limit ? `${result}${CONTEXT_TRUNCATION_MARKER}` : result;
}

function compactArtifacts(
	artifacts: Array<{ path: string; type: string; description: string; sha256?: string }>,
	metadata: { sourceTaskId: string; sourceLeaseId: string; sourceCheckpointId?: string },
): Record<string, unknown>[] {
	return artifacts.slice(0, 8).map((artifact) => ({
		path: artifact.path,
		type: artifact.type,
		description: artifact.description,
		...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
		...metadata,
	}));
}

function compactFailure(failure: NonNullable<PlanningSnapshot["latestFailure"]>): Record<string, unknown> {
	return {
		taskId: failure.taskId,
		leaseId: failure.leaseId,
		attempt: failure.attempt,
		source: failure.source,
		stage: failure.stage,
		code: failure.code,
		message: failure.message,
		...(failure.executorSummary ? { executorSummary: failure.executorSummary } : {}),
		objective: failure.objective,
		doneWhen: failure.doneWhen,
		evidenceRefs: failure.evidenceRefs.slice(0, 32),
		...(failure.checkpointId ? { checkpointId: failure.checkpointId } : {}),
		completedItems: failure.completedItems.slice(0, 16),
		remainingItems: failure.remainingItems.slice(0, 16),
		rejectedDirections: failure.rejectedDirections.slice(0, 8),
		suggestedNextSteps: failure.suggestedNextSteps.slice(0, 8),
		artifacts: failure.checkpoint
			? compactArtifacts(failure.checkpoint.artifacts, {
					sourceTaskId: failure.checkpoint.taskId,
					sourceLeaseId: failure.checkpoint.leaseId,
					sourceCheckpointId: failure.checkpoint.checkpointId,
				})
			: [],
	};
}

function compactCheckpoint(checkpoint: NonNullable<PlanningSnapshot["latestCheckpoint"]>): Record<string, unknown> {
	return {
		checkpointId: checkpoint.checkpointId,
		checkpointSequence: checkpoint.checkpointSequence,
		taskId: checkpoint.taskId,
		leaseId: checkpoint.leaseId,
		summary: checkpoint.summary,
		evidenceRefs: checkpoint.evidenceRefs.slice(0, 32),
		completedItems: checkpoint.completedItems.slice(0, 16),
		remainingItems: checkpoint.remainingItems.slice(0, 16),
		rejectedDirections: checkpoint.rejectedDirections.slice(0, 8),
		suggestedNextSteps: checkpoint.suggestedNextSteps.slice(0, 8),
		artifacts: compactArtifacts(checkpoint.artifacts, {
			sourceTaskId: checkpoint.taskId,
			sourceLeaseId: checkpoint.leaseId,
			sourceCheckpointId: checkpoint.checkpointId,
		}),
	};
}

type EvidenceContextRole = "executor" | "supervisor";
type EvidencePriority =
	| "explicit_task_input"
	| "dependency_result"
	| "failure_or_checkpoint"
	| "current_task_evidence"
	| "frame_reference"
	| "planned_task_input"
	| "observer_report"
	| "recent_history";

interface SelectedEvidence {
	evidence: PlanningEvidence;
	priority: EvidencePriority;
}

interface EvidenceSelection {
	items: SelectedEvidence[];
	candidateIds: Set<string>;
}

function newestEvidenceFirst(left: PlanningEvidence, right: PlanningEvidence): number {
	return (
		right.createdAt - left.createdAt ||
		compareText(left.taskId, right.taskId) ||
		compareText(left.leaseId, right.leaseId) ||
		compareText(left.evidenceId, right.evidenceId)
	);
}

function observerReportReferences(evidence: PlanningEvidence): string[] {
	try {
		const report: unknown = JSON.parse(evidence.summary);
		if (!isRecord(report)) return [];
		return ["observedResults", "observerJudgments", "supportedConclusions"].flatMap((key) => {
			const items = report[key];
			if (!Array.isArray(items)) return [];
			return items.flatMap((item) =>
				isRecord(item) && Array.isArray(item.evidenceIds)
					? item.evidenceIds.filter((reference): reference is string => typeof reference === "string")
					: [],
			);
		});
	} catch {
		return [];
	}
}

function observerSummaryForContext(summary: string): string {
	try {
		const report: unknown = JSON.parse(summary);
		if (!isRecord(report)) return summary;
		if (!Object.hasOwn(report, "observerJudgments") && Array.isArray(report.supportedConclusions)) {
			report.observerJudgments = report.supportedConclusions;
		}
		delete report.supportedConclusions;
		return JSON.stringify(report);
	} catch {
		return summary;
	}
}

function latestObserverNotes(snapshot: PlanningSnapshot): Record<string, unknown>[] {
	const orderedNotes = [...snapshot.evidence]
		.filter(
			(item) =>
				item.runId === snapshot.run.runId &&
				item.kind === "observation" &&
				item.source.startsWith("planning_observer_"),
		)
		.sort(newestEvidenceFirst);
	const latestByLease = new Map<string, PlanningEvidence>();
	for (const item of orderedNotes) {
		if (!latestByLease.has(item.leaseId)) latestByLease.set(item.leaseId, item);
	}
	return [...latestByLease.values()].slice(0, 2).map((item) => {
		const isObserverJudgment = item.source === "planning_observer_report";
		let payload: Record<string, unknown> = {};
		try {
			const parsed: unknown = JSON.parse(item.summary);
			if (isRecord(parsed)) payload = parsed;
		} catch {
			// Keep an explicit minimal handoff when an older or partial report cannot be parsed.
		}
		const task = snapshot.tasks.find((candidate) => candidate.taskId === item.taskId);
		const taskSummary = snapshot.executionFrame.frame.taskSummaries.find(
			(candidate) => candidate.taskId === item.taskId,
		);
		const sameAttemptResult = snapshot.evidence.find(
			(candidate) =>
				candidate.runId === item.runId &&
				candidate.taskId === item.taskId &&
				candidate.leaseId === item.leaseId &&
				candidate.kind === "observation" &&
				candidate.source === "planning-task-result" &&
				(candidate.metadata.outcome === "done" ||
					candidate.metadata.outcome === "disproved" ||
					candidate.metadata.outcome === "blocked" ||
					candidate.metadata.outcome === "failed") &&
				/^[a-f0-9]{64}$/iu.test(candidate.contentHash),
		);
		const sealedFailure =
			snapshot.latestFailure?.taskId === item.taskId && snapshot.latestFailure.leaseId === item.leaseId
				? snapshot.latestFailure
				: undefined;
		const taskLevelDurableResult = taskSummary
			? {
					source: "Planning Store snapshot",
					state: "task_level_durable_result_present_unattributed_to_attempt",
					taskStatus: task?.status ?? "unknown",
					outcome: taskSummary.outcome,
					summary: truncateUtf8(taskSummary.summary, 700),
				}
			: null;
		const durableSettlement = sameAttemptResult
			? {
					source: "Planning Store snapshot",
					state: "durable_task_result_present_for_same_attempt",
					taskStatus: task?.status ?? "unknown",
					outcome:
						typeof sameAttemptResult.metadata.outcome === "string" ? sameAttemptResult.metadata.outcome : null,
					summary: truncateUtf8(sameAttemptResult.summary, 700),
				}
			: sealedFailure
				? {
						source: "Planning Store snapshot",
						state: "attempt_sealed_without_durable_task_result",
						taskStatus: task?.status ?? "unknown",
						failureStage: sealedFailure.stage,
						failureCode: sealedFailure.code,
					}
				: {
						source: "Planning Store snapshot",
						state: (snapshot.activeLeases ?? (snapshot.activeLease ? [snapshot.activeLease] : [])).some(
							(lease) => lease.leaseId === item.leaseId,
						)
							? "lease_still_active"
							: "no_matching_settlement_found",
						taskStatus: task?.status ?? "unknown",
					};
		const observerJudgments = payload.observerJudgments ?? payload.supportedConclusions ?? [];
		const observerQuestions = payload.openQuestions ?? payload.observerOpenQuestions ?? [];
		const unverifiedItems = payload.unverifiedHypotheses ?? payload.observerUnverifiedHypotheses ?? [];
		const attemptClosureFailure = isRecord(payload.failure)
			? {
					source: "Observer runtime handoff from Executor attempt closure; not Store settlement",
					stage: typeof payload.failure.stage === "string" ? payload.failure.stage.slice(0, 128) : null,
					code: typeof payload.failure.code === "string" ? payload.failure.code.slice(0, 128) : null,
					message: typeof payload.failure.message === "string" ? truncateUtf8(payload.failure.message, 500) : null,
				}
			: null;
		const timeline = Array.isArray(payload.timeline)
			? payload.timeline.slice(-16).map((event) => {
					if (!isRecord(event)) return {};
					return Object.fromEntries(
						[
							"type",
							"elapsedMs",
							"toolCallId",
							"toolName",
							"toolElapsedMs",
							"isError",
							"accepted",
							"evidenceId",
							"checkpointId",
							"checkpointSequence",
							"failureCode",
						]
							.filter((key) => Object.hasOwn(event, key))
							.map((key) => [key, event[key]]),
					);
				})
			: [];
		const evidenceIds = Array.isArray(payload.toolEvidenceIds)
			? payload.toolEvidenceIds.filter((value): value is string => typeof value === "string").slice(-32)
			: [];
		return {
			evidenceId: item.evidenceId,
			taskId: item.taskId,
			leaseId: item.leaseId,
			noteType: isObserverJudgment
				? "observer_judgment"
				: payload.semanticReportGenerated === true
					? "runtime_attempt_handoff"
					: "runtime_progress_fallback",
			semanticReportGenerated: isObserverJudgment || payload.semanticReportGenerated === true,
			evidenceReferenceCheck:
				isObserverJudgment || payload.semanticReportGenerated === true ? "same_run_readable_only" : "not_performed",
			semanticVerification: "not_performed",
			completionOrVerifierAuthority: "none",
			observerJudgments: Array.isArray(observerJudgments) ? observerJudgments.slice(0, 4) : [],
			unverifiedItems: Array.isArray(unverifiedItems) ? unverifiedItems.slice(0, 8) : [],
			observerOpenQuestions: Array.isArray(observerQuestions) ? observerQuestions.slice(0, 8) : [],
			executorDeclaration: payload.executorDeclaration ?? null,
			commitTool: payload.commitTool ?? null,
			evidenceIds,
			evidenceIdsComplete: payload.evidenceIdsComplete === true,
			timelineEventCount: payload.timelineEventCount ?? timeline.length,
			timeline,
			timelineComplete: payload.timelineComplete === true,
			lastCheckpoint: payload.lastCheckpoint ?? null,
			storeSettlementAtHandoffWrite: payload.storeSettlementAtHandoffWrite ?? null,
			attemptClosureFailure,
			durableSettlement,
			taskLevelDurableResult: sameAttemptResult ? null : taskLevelDurableResult,
			runtimeFallbackReason: typeof payload.reason === "string" ? payload.reason : null,
		};
	});
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function relevantEvidence(
	snapshot: PlanningSnapshot,
	contextRole: EvidenceContextRole,
	taskId?: string,
	leaseId?: string,
): EvidenceSelection {
	const currentRunEvidence = snapshot.evidence.filter((item) => item.runId === snapshot.run.runId);
	const evidenceById = new Map(currentRunEvidence.map((item) => [item.evidenceId, item]));
	const taskById = new Map(snapshot.tasks.map((task) => [task.taskId, task]));
	const summariesByTask = new Map(snapshot.executionFrame.frame.taskSummaries.map((item) => [item.taskId, item]));
	const selected = new Map<string, SelectedEvidence>();
	const candidateIds = new Set<string>();

	const addReferences = (references: readonly string[] | undefined, priority: EvidencePriority): void => {
		for (const evidenceId of references ?? []) {
			if (typeof evidenceId !== "string" || evidenceId.length === 0) continue;
			candidateIds.add(evidenceId);
			const evidence = evidenceById.get(evidenceId);
			if (evidence && !selected.has(evidenceId)) selected.set(evidenceId, { evidence, priority });
		}
	};
	const addEvidenceForTask = (sourceTaskId: string | undefined, priority: EvidencePriority): void => {
		if (!sourceTaskId) return;
		const related = currentRunEvidence.filter((item) => item.taskId === sourceTaskId).sort(newestEvidenceFirst);
		for (const evidence of related) {
			candidateIds.add(evidence.evidenceId);
			if (!selected.has(evidence.evidenceId)) selected.set(evidence.evidenceId, { evidence, priority });
		}
	};
	const addEvidenceForLease = (
		sourceTaskId: string | undefined,
		sourceLeaseId: string | undefined,
		priority: EvidencePriority,
	): void => {
		if (!sourceTaskId || !sourceLeaseId) return;
		const related = currentRunEvidence
			.filter((item) => item.taskId === sourceTaskId && item.leaseId === sourceLeaseId)
			.sort(newestEvidenceFirst);
		for (const evidence of related) {
			candidateIds.add(evidence.evidenceId);
			if (!selected.has(evidence.evidenceId)) selected.set(evidence.evidenceId, { evidence, priority });
		}
	};
	const addTaskSummaryReferences = (sourceTaskId: string, priority: EvidencePriority): void => {
		const summary = summariesByTask.get(sourceTaskId);
		const refs = [...(summary?.evidenceRefs ?? [])].sort((left, right) => {
			const leftEvidence = evidenceById.get(left);
			const rightEvidence = evidenceById.get(right);
			if (leftEvidence && rightEvidence) return newestEvidenceFirst(leftEvidence, rightEvidence);
			if (leftEvidence) return -1;
			if (rightEvidence) return 1;
			return compareText(left, right);
		});
		addReferences(refs, priority);
	};
	const addFrameReferences = (sourceTaskIds: readonly string[], priority: EvidencePriority): void => {
		const sourceIds = new Set(sourceTaskIds);
		for (const sourceTaskId of sourceTaskIds) addTaskSummaryReferences(sourceTaskId, priority);
		for (const fact of [...snapshot.executionFrame.frame.facts]
			.filter((item) => sourceIds.has(item.sourceTaskId))
			.sort(
				(left, right) => compareText(left.sourceTaskId, right.sourceTaskId) || compareText(left.key, right.key),
			)) {
			addReferences(fact.evidenceRefs, priority);
		}
		for (const rejected of [...snapshot.executionFrame.frame.rejectedDirections]
			.filter((item) => sourceIds.has(item.sourceTaskId))
			.sort(
				(left, right) =>
					compareText(left.sourceTaskId, right.sourceTaskId) || compareText(left.direction, right.direction),
			)) {
			addReferences(rejected.evidenceRefs, priority);
		}
	};

	if (contextRole === "executor") {
		const task = taskId ? taskById.get(taskId) : undefined;
		addReferences(task?.inputEvidenceRefs, "explicit_task_input");

		const dependencies = [...(task?.dependsOnTaskIds ?? [])];
		for (const dependencyId of dependencies) addTaskSummaryReferences(dependencyId, "dependency_result");
		for (const dependencyId of dependencies) addFrameReferences([dependencyId], "dependency_result");
		for (const dependencyId of dependencies) addEvidenceForTask(dependencyId, "dependency_result");

		addReferences(snapshot.latestFailure?.evidenceRefs, "failure_or_checkpoint");
		addReferences(snapshot.latestCheckpoint?.evidenceRefs, "failure_or_checkpoint");
		addEvidenceForLease(snapshot.latestFailure?.taskId, snapshot.latestFailure?.leaseId, "failure_or_checkpoint");
		addEvidenceForLease(
			snapshot.latestCheckpoint?.taskId,
			snapshot.latestCheckpoint?.leaseId,
			"failure_or_checkpoint",
		);

		addEvidenceForLease(taskId, leaseId, "current_task_evidence");
		if (taskId) addFrameReferences([taskId], "current_task_evidence");
	} else {
		// Supervisor context is organized around the latest decision point, not a
		// hypothetical task's explicit inputs.
		for (const task of snapshot.tasks) {
			for (const evidenceId of task.inputEvidenceRefs ?? []) candidateIds.add(evidenceId);
		}
		addReferences(snapshot.latestFailure?.evidenceRefs, "failure_or_checkpoint");
		addReferences(snapshot.latestCheckpoint?.evidenceRefs, "failure_or_checkpoint");
		addEvidenceForLease(snapshot.latestFailure?.taskId, snapshot.latestFailure?.leaseId, "failure_or_checkpoint");
		addEvidenceForLease(
			snapshot.latestCheckpoint?.taskId,
			snapshot.latestCheckpoint?.leaseId,
			"failure_or_checkpoint",
		);
		const actionableTasks = [...snapshot.tasks]
			.filter((task) => ["proposed", "ready", "leased", "running"].includes(task.status))
			.sort((left, right) => left.sequence - right.sequence || compareText(left.taskId, right.taskId));
		for (const task of actionableTasks) addReferences(task.inputEvidenceRefs, "planned_task_input");
		const historyTasks = [...snapshot.tasks].sort(
			(left, right) => right.sequence - left.sequence || compareText(left.taskId, right.taskId),
		);
		addFrameReferences(
			historyTasks.map((item) => item.taskId),
			"frame_reference",
		);
		const observerReports = currentRunEvidence
			.filter((item) => item.kind === "observation" && item.source.startsWith("planning_observer_"))
			.sort(newestEvidenceFirst)
			.slice(0, 2);
		for (const report of observerReports) {
			addReferences([report.evidenceId], "observer_report");
			addReferences(observerReportReferences(report), "observer_report");
		}
	}

	const recentEvidence = [...currentRunEvidence].sort(newestEvidenceFirst).slice(0, 8);
	for (const evidence of recentEvidence) {
		candidateIds.add(evidence.evidenceId);
		if (!selected.has(evidence.evidenceId))
			selected.set(evidence.evidenceId, { evidence, priority: "recent_history" });
	}
	return { items: [...selected.values()], candidateIds };
}

const MAX_EVIDENCE_DESCRIPTION_BYTES = 144;
const MAX_EVIDENCE_EXCERPT_BYTES = 512;

function evidenceView(
	selection: EvidenceSelection,
	maximumJsonBytes: number,
	fitsResult?: (items: Record<string, unknown>[]) => boolean,
): Record<string, unknown>[] {
	const visible: Record<string, unknown>[] = [];
	const evidenceById = new Map(selection.items.map((item) => [item.evidence.evidenceId, item]));
	const fits = (items: Record<string, unknown>[]): boolean =>
		fitsResult?.(items) ?? jsonBytes({ items }) <= maximumJsonBytes;

	// First reserve the smallest complete reference for each evidence ID in
	// priority order. Optional metadata from an earlier item must never starve a
	// later readable ID. If one reference cannot fit, try subsequent (possibly
	// shorter) IDs; none are truncated.
	for (const selected of selection.items) {
		const item = selected.evidence;
		const minimalReference: Record<string, unknown> = {
			evidenceId: item.evidenceId,
			taskId: item.taskId,
			leaseId: item.leaseId,
			priority: selected.priority,
			kind: item.kind,
			sourceRole:
				item.kind === "tool"
					? "raw_tool_observation"
					: item.source === "planning_observer_report"
						? "observer_judgment"
						: item.source === "planning_observer_runtime"
							? "runtime_attempt_handoff"
							: "unclassified_observation",
			createdAt: item.createdAt,
			detailLevel: "reference_only",
		};
		if (fits([...visible, minimalReference])) visible.push(minimalReference);
	}

	// Enrich selected references only after all fitting IDs have been reserved.
	// Each enrichment is optional and may fail without removing the reference.
	for (let index = 0; index < visible.length; index += 1) {
		const reference = visible[index];
		if (!reference) continue;
		const selected = evidenceById.get(String(reference.evidenceId));
		if (!selected) continue;
		const item = selected.evidence;
		const isObserverNote = item.kind === "observation" && item.source.startsWith("planning_observer_");
		const description = isObserverNote
			? item.source === "planning_observer_report"
				? "Observer judgment; readable references do not verify meaning."
				: "Runtime handoff; not task settlement or proof."
			: item.kind === "tool"
				? `Raw tool observation (${item.metadata.isError === true ? "error" : item.metadata.isError === false ? "success" : "unknown"}); read the excerpt/original output. Not an Executor or Observer conclusion.`
				: item.summary || item.source || "Stored evidence; read it by evidenceId.";
		const compactReference: Record<string, unknown> = {
			...reference,
			source: truncateUtf8(item.source, 24),
			description: truncateUtf8(description, 64),
			outcome:
				item.kind === "tool"
					? item.metadata.isError === true
						? "error"
						: item.metadata.isError === false
							? "success"
							: "unknown"
					: "observation",
			contentComplete: item.contentComplete,
			excerptComplete:
				item.contentComplete && !item.isTruncated && Buffer.byteLength(item.excerpt, "utf8") >= item.contentBytes,
		};
		if (fits(visible.map((row, rowIndex) => (rowIndex === index ? compactReference : row)))) {
			visible[index] = compactReference;
		}
		const fullReference: Record<string, unknown> = {
			...visible[index],
			source: truncateUtf8(item.source, 64),
			description: truncateUtf8(description, MAX_EVIDENCE_DESCRIPTION_BYTES),
			contentHash: item.contentHash,
			contentBytes: item.contentBytes ?? 0,
			isTruncated: item.isTruncated === true,
		};
		if (fits(visible.map((row, rowIndex) => (rowIndex === index ? fullReference : row)))) {
			visible[index] = fullReference;
		}
	}

	// Spread the remaining excerpt budget across already-selected references.
	// This keeps one long or heavily escaped body from displacing other IDs.
	for (let index = 0; index < visible.length; index += 1) {
		const reference = visible[index];
		const evidenceId = String(reference?.evidenceId ?? "");
		const source = evidenceById.get(evidenceId)?.evidence;
		const rawExcerpt = source?.excerpt || source?.summary || "";
		const excerpt =
			source?.kind === "observation" && source.source.startsWith("planning_observer_")
				? observerSummaryForContext(rawExcerpt)
				: rawExcerpt;
		if (!reference || !excerpt) continue;
		const currentBytes = jsonBytes({ items: visible });
		const excerptBudget = Math.min(
			MAX_EVIDENCE_EXCERPT_BYTES,
			Math.floor(Math.max(0, maximumJsonBytes - currentBytes) / Math.max(1, visible.length - index)),
		);
		if (excerptBudget <= 0) continue;
		let low = 1;
		let high = excerptBudget;
		let best: Record<string, unknown> | undefined;
		while (low <= high) {
			const middle = Math.floor((low + high) / 2);
			const excerptText = truncateUtf8(excerpt, middle);
			const isTruncated = Buffer.byteLength(excerpt, "utf8") > middle;
			if (
				!excerptText ||
				(isTruncated &&
					(!excerptText.endsWith(CONTEXT_TRUNCATION_MARKER) ||
						excerptText.length <= CONTEXT_TRUNCATION_MARKER.length))
			) {
				low = middle + 1;
				continue;
			}
			const candidate = {
				...reference,
				detailLevel: "summary",
				excerpt: excerptText,
			};
			const updated = visible.map((item, itemIndex) => (itemIndex === index ? candidate : item));
			if (fits(updated)) {
				best = candidate;
				low = middle + 1;
			} else high = middle - 1;
		}
		if (best) visible[index] = best;
	}
	return visible;
}

function evidenceContextFields(selection: EvidenceSelection, maximumJsonBytes: number): ContextField[] {
	const makeStatus = (items: Record<string, unknown>[]): Record<string, unknown> => ({
		candidateCount: selection.candidateIds.size,
		knownCount: selection.items.length,
		presentedCount: items.length,
		omittedKnownCount: Math.max(0, selection.items.length - items.length),
		unresolvedCount: Math.max(0, selection.candidateIds.size - selection.items.length),
		complete: items.length === selection.items.length && selection.candidateIds.size === selection.items.length,
		note: "Priority subset only; omitted does not mean absent.",
	});
	const sourceRoles = {
		rawTool: "tool observation",
		executor: "Executor claim",
		observer: "Observer judgment; interpretation unverified",
		verifier: "host proof",
	};
	const fits = (items: Record<string, unknown>[]): boolean =>
		jsonBytes({ items, listStatus: makeStatus(items), sourceRoles }) <= Math.max(0, maximumJsonBytes);
	const rows = evidenceView(selection, Math.max(0, maximumJsonBytes), fits);
	while (rows.length > 0 && !fits(rows)) rows.pop();
	return [
		{ key: "items", value: rows },
		{ key: "listStatus", value: makeStatus(rows) },
		{ key: "sourceRoles", value: sourceRoles },
	];
}

type ContextField = { key: string; value: unknown; required?: boolean };

interface ContextBudgetShares {
	identity: number;
	failure: number;
	evidence: number;
	progress: number;
}

const EXECUTOR_CONTEXT_BUDGET: ContextBudgetShares = {
	identity: 0.27,
	failure: 0.21,
	evidence: 0.3,
	progress: 0.17,
};

const SUPERVISOR_CONTEXT_BUDGET: ContextBudgetShares = {
	identity: 0.22,
	failure: 0.2,
	evidence: 0.22,
	progress: 0.16,
};

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function fitsObject(fields: Record<string, unknown>, budget: number): boolean {
	return jsonBytes(fields) <= budget;
}

function fitStringField(
	fields: Record<string, unknown>,
	key: string,
	value: string,
	budget: number,
	reserveFields: Array<{ key: string; value: unknown }> = [],
): string | undefined {
	const emptyCandidate = { ...fields, [key]: "" } as Record<string, unknown>;
	for (const reserveField of reserveFields) {
		if (!(reserveField.key in emptyCandidate)) emptyCandidate[reserveField.key] = reserveField.value;
	}
	const emptyBytes = jsonBytes(emptyCandidate);
	if (emptyBytes > budget) return undefined;
	let low = 0;
	let high = Math.max(0, budget - emptyBytes);
	let best = "";
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = truncateUtf8(value, middle);
		const candidateObject = { ...fields, [key]: candidate } as Record<string, unknown>;
		for (const reserveField of reserveFields) {
			if (!(reserveField.key in candidateObject)) candidateObject[reserveField.key] = reserveField.value;
		}
		if (fitsObject(candidateObject, budget)) {
			best = candidate;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return best;
}

function fitArrayField(
	fields: Record<string, unknown>,
	key: string,
	value: unknown[],
	budget: number,
): unknown[] | undefined {
	for (let length = value.length; length >= 0; length -= 1) {
		const candidate = value.slice(0, length);
		if (fitsObject({ ...fields, [key]: candidate }, budget)) return candidate;
	}
	return undefined;
}

/**
 * Build a complete JSON object under a byte budget. Required identity fields
 * are considered first; optional history is omitted or shortened as a whole.
 * This prevents the old final-string truncation from producing invalid JSON or
 * dropping the current task after a large failure report.
 */
function boundedObject(fields: ContextField[], budget: number): string {
	const limit = Math.max(0, Math.trunc(budget));
	const result: Record<string, unknown> = {};
	const truncatedFields: string[] = [];
	const omittedFields: string[] = [];
	for (const [index, field] of fields.entries()) {
		const remainingRequiredFields = fields
			.slice(index + 1)
			.filter((candidate) => candidate.required)
			.map((candidate) => ({
				key: candidate.key,
				value: typeof candidate.value === "string" ? truncateUtf8(candidate.value, 64) : candidate.value,
			}));
		if (field.required && typeof field.value === "string") {
			const fitted = fitStringField(result, field.key, field.value, limit, remainingRequiredFields);
			if (fitted !== undefined) {
				result[field.key] = fitted;
				if (fitted !== field.value) truncatedFields.push(field.key);
				continue;
			}
		}
		if (fitsObject({ ...result, [field.key]: field.value }, limit)) {
			result[field.key] = field.value;
			continue;
		}
		if (typeof field.value === "string") {
			const fitted = fitStringField(result, field.key, field.value, limit);
			if (fitted !== undefined) {
				result[field.key] = fitted;
				if (fitted !== field.value) truncatedFields.push(field.key);
				continue;
			}
		}
		if (Array.isArray(field.value)) {
			const fitted = fitArrayField(result, field.key, field.value, limit);
			if (fitted !== undefined) {
				result[field.key] = fitted;
				if (fitted.length !== field.value.length) truncatedFields.push(field.key);
				continue;
			}
		}
		if (field.required) {
			// A normal Planning context is large enough for these fields. If a
			// caller supplies an exceptionally small budget, retain the key and
			// an explicit marker rather than silently changing task identity.
			const marker = `[${field.key} unavailable within context budget]`;
			if (fitsObject({ ...result, [field.key]: marker }, limit)) {
				result[field.key] = marker;
				truncatedFields.push(field.key);
			}
		}
		if (!(field.key in result)) omittedFields.push(field.key);
	}
	if (truncatedFields.length > 0) {
		const marker = [...new Set(truncatedFields)];
		if (fitsObject({ ...result, truncatedFields: marker }, limit)) result.truncatedFields = marker;
	}
	if (omittedFields.length > 0) {
		const marker = [...new Set(omittedFields)];
		if (fitsObject({ ...result, omittedFields: marker }, limit)) result.omittedFields = marker;
		else if (fitsObject({ ...result, omittedFields: marker.length }, limit)) result.omittedFields = marker.length;
	}
	// Budget checks and rendering must use the same serialization, including
	// escaping of multi-byte strings and nested structures.
	if (fitsObject(result, limit)) return JSON.stringify(result);
	return JSON.stringify({ contextTruncated: true });
}

function renderBlock(title: string, fields: ContextField[], budget: number): string {
	const prefix = `${title}\n`;
	const prefixBytes = Buffer.byteLength(prefix, "utf8");
	if (budget <= prefixBytes) return truncateUtf8(prefix, budget);
	return `${prefix}${boundedObject(fields, budget - prefixBytes)}`;
}

function appendBlock(chunks: string[], currentBytes: number, block: string, maximumBytes: number): number {
	const separator = chunks.length === 0 ? "" : "\n\n";
	const blockBytes = Buffer.byteLength(separator + block, "utf8");
	if (currentBytes + blockBytes > maximumBytes) return currentBytes;
	chunks.push(block);
	return currentBytes + blockBytes;
}

function identityFields(identity: Record<string, unknown>, header: string): ContextField[] {
	return [
		{ key: "runId", value: String(identity.runId ?? ""), required: true },
		{ key: "revision", value: identity.revision ?? null, required: true },
		{ key: "taskId", value: String(identity.taskId ?? ""), required: true },
		{ key: "leaseId", value: String(identity.leaseId ?? ""), required: true },
		{ key: "objective", value: String(identity.objective ?? ""), required: true },
		{ key: "doneWhen", value: String(identity.doneWhen ?? ""), required: true },
		...(typeof identity.allowedScope === "string" ? [{ key: "allowedScope", value: identity.allowedScope }] : []),
		...(Array.isArray(identity.dependsOnTaskIds)
			? [{ key: "dependsOnTaskIds", value: identity.dependsOnTaskIds }]
			: []),
		...(Array.isArray(identity.inputEvidenceRefs)
			? [{ key: "inputEvidenceRefs", value: identity.inputEvidenceRefs }]
			: []),
		...(typeof identity.taskStatus === "string" ? [{ key: "taskStatus", value: identity.taskStatus }] : []),
		{ key: "contextPurpose", value: header },
	];
}

function renderPriorityContext(
	header: string,
	identity: Record<string, unknown>,
	critical: Record<string, unknown>,
	evidenceSelection: EvidenceSelection,
	progress: Record<string, unknown>,
	supplemental: Record<string, unknown>,
	maximumBytes: number,
	budgetShares: ContextBudgetShares,
): string {
	const maximum = Math.max(0, Math.trunc(maximumBytes));
	if (maximum === 0) return "";
	const chunks: string[] = [];
	let used = 0;
	// Identity gets the first and largest budget. The remaining blocks are
	// complete structured JSON objects, so a Supervisor can parse each one.
	used = appendBlock(
		chunks,
		used,
		renderBlock(
			"# Current task identity",
			identityFields(identity, header),
			Math.trunc(maximum * budgetShares.identity),
		),
		maximum,
	);
	used = appendBlock(
		chunks,
		used,
		renderBlock(
			"# Failure and checkpoint state",
			Object.entries(critical).map(([key, value]) => ({ key, value })),
			Math.trunc(maximum * budgetShares.failure),
		),
		maximum,
	);
	used = appendBlock(
		chunks,
		used,
		renderBlock(
			"# Evidence map: raw observations and attributed claims",
			evidenceContextFields(
				evidenceSelection,
				Math.max(
					0,
					Math.trunc(maximum * budgetShares.evidence) -
						Buffer.byteLength("# Evidence map: raw observations and attributed claims\n", "utf8"),
				),
			),
			Math.trunc(maximum * budgetShares.evidence),
		),
		maximum,
	);
	used = appendBlock(
		chunks,
		used,
		renderBlock(
			"# Progress and proposed next steps",
			Object.entries(progress).map(([key, value]) => ({ key, value })),
			Math.trunc(maximum * budgetShares.progress),
		),
		maximum,
	);
	const supplementalSeparatorBytes = chunks.length > 0 ? Buffer.byteLength("\n\n", "utf8") : 0;
	const supplementalBudget = Math.max(0, maximum - used - supplementalSeparatorBytes);
	const supplementalBlock = renderBlock(
		"# Supplemental planning state",
		Object.entries(supplemental).map(([key, value]) => ({ key, value })),
		supplementalBudget,
	);
	used = appendBlock(chunks, used, supplementalBlock, maximum);
	return chunks.join("\n\n");
}

function failureCritical(snapshot: PlanningSnapshot): Record<string, unknown> {
	const failure = snapshot.latestFailure;
	const checkpoint = snapshot.latestCheckpoint;
	const artifactSource = checkpoint ?? failure?.checkpoint;
	const observerProgressNotes = latestObserverNotes(snapshot);
	return {
		failureCode: failure?.code ?? null,
		failureStage: failure?.stage ?? null,
		checkpointId: failure?.checkpointId ?? checkpoint?.checkpointId ?? null,
		checkpointSequence: checkpoint?.checkpointSequence ?? null,
		failureEvidenceRefs: (failure?.evidenceRefs ?? []).slice(0, 32),
		checkpointEvidenceRefs: (checkpoint?.evidenceRefs ?? []).slice(0, 32),
		artifactRefs: artifactSource
			? compactArtifacts(artifactSource.artifacts, {
					sourceTaskId: artifactSource.taskId,
					sourceLeaseId: artifactSource.leaseId,
					sourceCheckpointId: artifactSource.checkpointId,
				}).map((artifact) => ({
					...artifact,
					path: truncateUtf8(String(artifact.path), 384),
					type: truncateUtf8(String(artifact.type), 64),
					description: truncateUtf8(String(artifact.description), 96),
				}))
			: [],
		failureMessage: failure?.message ?? null,
		...(observerProgressNotes.length > 0 ? { observerProgressNotes } : {}),
	};
}

function progressView(snapshot: PlanningSnapshot): Record<string, unknown> {
	const latest = snapshot.latestFailure ?? snapshot.latestCheckpoint;
	return {
		progressSource: "Executor-authored checkpoint or runtime failure report; not Verifier proof",
		remainingItems: (latest?.remainingItems ?? []).slice(0, 3).map((item) => truncateUtf8(item, 128)),
		suggestedNextSteps: (latest?.suggestedNextSteps ?? []).slice(0, 2).map((item) => ({
			objective: truncateUtf8(item.objective, 128),
			doneWhen: truncateUtf8(item.doneWhen, 128),
			inputEvidenceRefs: item.inputEvidenceRefs?.slice(0, 4) ?? [],
		})),
		completedItems: (latest?.completedItems ?? []).slice(0, 3).map((item) => truncateUtf8(item, 128)),
		rejectedDirections: (latest?.rejectedDirections ?? []).slice(0, 2).map((item) => ({
			direction: truncateUtf8(item.direction, 96),
			reason: truncateUtf8(item.reason, 128),
			evidenceRefs: item.evidenceRefs?.slice(0, 4) ?? [],
		})),
	};
}

function explorationHandoff(
	snapshot: PlanningSnapshot,
	contextRole: EvidenceContextRole,
	taskId?: string,
): Record<string, unknown> {
	const task = taskId ? snapshot.tasks.find((item) => item.taskId === taskId) : undefined;
	const relevantTaskIds = new Set<string>();
	if (contextRole === "executor" && task) {
		relevantTaskIds.add(task.taskId);
		for (const dependencyId of task.dependsOnTaskIds) relevantTaskIds.add(dependencyId);
		if (snapshot.latestFailure?.taskId) relevantTaskIds.add(snapshot.latestFailure.taskId);
	} else {
		for (const taskItem of [...snapshot.tasks].sort((left, right) => right.sequence - left.sequence).slice(0, 12)) {
			relevantTaskIds.add(taskItem.taskId);
		}
		if (snapshot.latestFailure?.taskId) relevantTaskIds.add(snapshot.latestFailure.taskId);
	}
	const sourceTasks = new Map(snapshot.tasks.map((item) => [item.taskId, item]));
	const taskOrder = (left: string, right: string): number =>
		(sourceTasks.get(right)?.sequence ?? 0) - (sourceTasks.get(left)?.sequence ?? 0);
	const taskSummaries = [...snapshot.executionFrame.frame.taskSummaries]
		.filter((item) => relevantTaskIds.has(item.taskId))
		.sort((left, right) => taskOrder(left.taskId, right.taskId))
		.slice(0, 12)
		.map((item) => ({
			role: "Executor declaration stored by Planning Store; not a Verifier proof",
			taskId: item.taskId,
			objective: truncateUtf8(sourceTasks.get(item.taskId)?.objective ?? "", 240),
			doneWhen: truncateUtf8(sourceTasks.get(item.taskId)?.doneWhen ?? "", 240),
			outcome: item.outcome,
			summary: truncateUtf8(item.summary, 400),
			evidenceRefs: item.evidenceRefs.slice(0, 8),
		}));
	const facts = snapshot.executionFrame.frame.facts
		.filter((item) => relevantTaskIds.has(item.sourceTaskId))
		.slice(0, 16)
		.map((item) => ({
			role: "Executor-declared fact; structurally stored, semantic truth not independently verified",
			sourceTaskId: item.sourceTaskId,
			key: item.key,
			value: truncateUtf8(String(item.value), 320),
			evidenceRefs: item.evidenceRefs.slice(0, 8),
		}));
	const rejectedDirections = snapshot.executionFrame.frame.rejectedDirections
		.filter((item) => relevantTaskIds.has(item.sourceTaskId))
		.slice(0, 16)
		.map((item) => ({
			role: "Executor-declared rejected direction; check its cited raw tool evidence",
			sourceTaskId: item.sourceTaskId,
			direction: truncateUtf8(item.direction, 240),
			reason: truncateUtf8(item.reason, 320),
			evidenceRefs: item.evidenceRefs.slice(0, 8),
		}));
	const openQuestions = snapshot.executionFrame.frame.openQuestions
		.filter((item) => relevantTaskIds.has(item.sourceTaskId))
		.slice(0, 8)
		.map((item) => ({
			role: "Executor-declared open question",
			sourceTaskId: item.sourceTaskId,
			question: truncateUtf8(item.text, 320),
		}));
	const artifacts = snapshot.executionFrame.frame.artifacts
		.filter((item) => relevantTaskIds.has(item.sourceTaskId))
		.slice(0, 12)
		.map((item) => ({
			role: "Executor-declared artifact reference",
			sourceTaskId: item.sourceTaskId,
			path: truncateUtf8(item.path, 240),
			type: item.type,
			description: truncateUtf8(item.description, 240),
			sha256: item.sha256,
		}));
	const observerJudgments = latestObserverNotes(snapshot).map((note) => ({
		role: "Observer judgment; readable references do not verify meaning and have no completion or Verifier authority",
		evidenceId: note.evidenceId,
		taskId: note.taskId,
		leaseId: note.leaseId,
		noteType: note.noteType,
		semanticReportGenerated: note.semanticReportGenerated,
		evidenceReferenceCheck: note.evidenceReferenceCheck,
		semanticVerification: note.semanticVerification,
		observerJudgments: Array.isArray(note.observerJudgments)
			? note.observerJudgments.slice(0, 3).map((item) =>
					isRecord(item)
						? {
								text: truncateUtf8(String(item.text ?? ""), 240),
								evidenceIds: Array.isArray(item.evidenceIds) ? item.evidenceIds.slice(0, 4) : [],
							}
						: {},
				)
			: [],
		unverifiedItems: Array.isArray(note.unverifiedItems)
			? note.unverifiedItems.slice(0, 3).map((item) => truncateUtf8(String(item), 240))
			: [],
		observerOpenQuestions: Array.isArray(note.observerOpenQuestions)
			? note.observerOpenQuestions.slice(0, 3).map((item) => truncateUtf8(String(item), 200))
			: [],
		evidenceIds: Array.isArray(note.evidenceIds) ? note.evidenceIds.slice(0, 8) : [],
		durableSettlement: isRecord(note.durableSettlement)
			? {
					state: note.durableSettlement.state,
					taskStatus: note.durableSettlement.taskStatus,
					outcome: note.durableSettlement.outcome,
					summary: note.durableSettlement.summary,
					failureStage: note.durableSettlement.failureStage,
					failureCode: note.durableSettlement.failureCode,
				}
			: null,
		attemptClosureFailure: isRecord(note.attemptClosureFailure)
			? {
					source: note.attemptClosureFailure.source,
					stage: note.attemptClosureFailure.stage,
					code: note.attemptClosureFailure.code,
					message: note.attemptClosureFailure.message,
				}
			: null,
		taskLevelDurableResult: isRecord(note.taskLevelDurableResult)
			? {
					state: note.taskLevelDurableResult.state,
					outcome: note.taskLevelDurableResult.outcome,
					summary: note.taskLevelDurableResult.summary,
				}
			: null,
	}));
	return {
		scope: [...relevantTaskIds],
		scopeComplete: relevantTaskIds.size >= snapshot.tasks.length,
		storedExecutorResults: taskSummaries,
		storedExecutorResultsComplete:
			taskSummaries.length ===
			snapshot.executionFrame.frame.taskSummaries.filter((item) => relevantTaskIds.has(item.taskId)).length,
		executorFacts: facts,
		executorFactsComplete:
			facts.length ===
			snapshot.executionFrame.frame.facts.filter((item) => relevantTaskIds.has(item.sourceTaskId)).length,
		executorRejectedDirections: rejectedDirections,
		executorRejectedDirectionsComplete:
			rejectedDirections.length ===
			snapshot.executionFrame.frame.rejectedDirections.filter((item) => relevantTaskIds.has(item.sourceTaskId))
				.length,
		executorOpenQuestions: openQuestions,
		executorOpenQuestionsComplete:
			openQuestions.length ===
			snapshot.executionFrame.frame.openQuestions.filter((item) => relevantTaskIds.has(item.sourceTaskId)).length,
		executorArtifacts: artifacts,
		observerJudgments,
		trustedVerifierProof: trustedPlanningVerificationFromSnapshot(snapshot) ?? null,
		verifierProofMeaning:
			"Only trustedVerifierProof from the host canonical gate is proof; raw evidence readability and Executor/Observer reports are not.",
	};
}

function currentIdentity(snapshot: PlanningSnapshot, lease?: PlanningTaskLease): Record<string, unknown> {
	const failure = snapshot.latestFailure;
	const task =
		lease ??
		(failure
			? {
					taskId: failure.taskId,
					leaseId: failure.leaseId,
					objective: failure.objective,
					doneWhen: failure.doneWhen,
				}
			: snapshot.activeLease);
	return {
		runId: snapshot.run.runId,
		revision: snapshot.run.revision,
		taskId: task?.taskId ?? "(no current task)",
		leaseId: task?.leaseId ?? "(none)",
		objective: task?.objective ?? snapshot.run.goal,
		doneWhen: task?.doneWhen ?? "(Supervisor must choose the next task)",
	};
}

export function renderPlanningContext(
	snapshot: PlanningSnapshot,
	lease: PlanningTaskLease,
	maximumBytes: number,
): string {
	const taskState = snapshot.tasks.find((task) => task.taskId === lease.taskId);
	return renderPriorityContext(
		[
			"You are executing exactly one leased task in a progressive plan.",
			"Keep the overall goal in view: local progress is not overall success. Continue coupled steps in this attempt; use checkpoints for live feedback rather than handing every observation back as a new task.",
			"The evidence map is a prioritized subset, not a complete list or reading allowlist; missing references do not mean same-run evidence is absent.",
			"Do not broaden the scope or rewrite the global plan. Commit a structured grounded report when finished.",
		].join("\n"),
		{
			...currentIdentity(snapshot, lease),
			allowedScope: lease.allowedScope,
			taskStatus: taskState?.status ?? "running",
			dependsOnTaskIds: taskState?.dependsOnTaskIds ?? [],
			inputEvidenceRefs: taskState?.inputEvidenceRefs ?? [],
		},
		{
			...failureCritical(snapshot),
			previousAttemptError: taskState?.lastError ?? null,
		},
		relevantEvidence(snapshot, "executor", lease.taskId, lease.leaseId),
		progressView(snapshot),
		{
			latestFailure: snapshot.latestFailure ? compactFailure(snapshot.latestFailure) : null,
			latestCheckpoint: snapshot.latestCheckpoint ? compactCheckpoint(snapshot.latestCheckpoint) : null,
			...explorationHandoff(snapshot, "executor", lease.taskId),
		},
		maximumBytes,
		EXECUTOR_CONTEXT_BUDGET,
	);
}

export interface PlanningContextRenderSummary {
	contextRole: "executor" | "supervisor";
	contextBytes: number;
	contextLimitBytes: number;
	identityBlockBytes: number;
	failureBlockBytes: number;
	evidenceBlockBytes: number;
	progressBlockBytes: number;
	supplementalBlockBytes: number;
	evidenceRefsCandidateCount: number;
	evidenceRefsPresentedCount: number;
	evidenceRefsPresented: string[];
	evidenceRefsSummaryPresentedCount: number;
	evidenceRefsSummaryPresented: string[];
	evidenceRefsReferenceOnlyCount: number;
	evidenceRefsReferenceOnly: string[];
	evidenceRefsOmitted: string[];
	evidenceRefsOmittedCount: number;
	checkpointRefsCandidateCount: number;
	checkpointRefsPresentedCount: number;
	checkpointRefsPresented: string[];
	checkpointRefsOmitted: string[];
	checkpointRefsOmittedCount: number;
	referenceListsTruncated: boolean;
}

function collectContextReferences(
	value: unknown,
	evidenceRefs: Set<string>,
	checkpointRefs: Set<string>,
	depth = 0,
): void {
	if (depth >= 16) return;
	if (Array.isArray(value)) {
		for (const item of value.slice(0, 2_000)) collectContextReferences(item, evidenceRefs, checkpointRefs, depth + 1);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 2_000)) {
		if (typeof child === "string" && (key === "checkpointId" || key === "sourceCheckpointId")) {
			checkpointRefs.add(child);
		}
		if (Array.isArray(child) && (key === "evidenceRefs" || key === "inputEvidenceRefs")) {
			for (const item of child) if (typeof item === "string") evidenceRefs.add(item);
		}
		if (typeof child === "string" && key === "evidenceId") evidenceRefs.add(child);
		collectContextReferences(child, evidenceRefs, checkpointRefs, depth + 1);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkpointReferenceCandidates(snapshot: PlanningSnapshot): Set<string> {
	const refs = new Set<string>();
	if (snapshot.latestCheckpoint?.checkpointId) refs.add(snapshot.latestCheckpoint.checkpointId);
	if (snapshot.latestFailure?.checkpointId) refs.add(snapshot.latestFailure.checkpointId);
	if (snapshot.latestFailure?.checkpoint?.checkpointId) refs.add(snapshot.latestFailure.checkpoint.checkpointId);
	return refs;
}

function renderedContextSummary(
	snapshot: PlanningSnapshot,
	context: string,
	maximumBytes: number,
	contextRole: PlanningContextRenderSummary["contextRole"],
	taskId?: string,
	leaseId?: string,
): PlanningContextRenderSummary {
	const renderedEvidenceRefs = new Set<string>();
	const renderedSummaryEvidenceRefs = new Set<string>();
	const renderedCheckpointRefs = new Set<string>();
	const blockBytes: Record<string, number> = {
		identity: 0,
		failure: 0,
		evidence: 0,
		progress: 0,
		supplemental: 0,
	};
	const blocks = context.split(/\n\n(?=# )/u).filter(Boolean);
	for (const block of blocks) {
		const newline = block.indexOf("\n");
		const heading = newline < 0 ? "" : block.slice(0, newline);
		const bytes = Buffer.byteLength(block, "utf8");
		if (heading.includes("Current task identity")) blockBytes.identity += bytes;
		else if (heading.includes("Failure and checkpoint state")) blockBytes.failure += bytes;
		else if (heading.includes("Evidence map:")) blockBytes.evidence += bytes;
		else if (heading.includes("Progress and proposed next steps")) blockBytes.progress += bytes;
		else if (heading.includes("Supplemental planning state")) blockBytes.supplemental += bytes;
		if (newline < 0) continue;
		try {
			const parsed = JSON.parse(block.slice(newline + 1)) as unknown;
			collectContextReferences(
				parsed,
				heading.includes("Evidence map:") ? renderedEvidenceRefs : new Set<string>(),
				renderedCheckpointRefs,
			);
			if (heading.includes("Evidence map:") && isRecord(parsed) && Array.isArray(parsed.items)) {
				for (const item of parsed.items) {
					if (isRecord(item) && typeof item.evidenceId === "string" && item.detailLevel === "summary") {
						renderedSummaryEvidenceRefs.add(item.evidenceId);
					}
				}
			}
		} catch {
			// The renderer emits complete JSON blocks; malformed/truncated blocks contribute no refs.
		}
	}
	const selection = relevantEvidence(snapshot, contextRole, taskId, leaseId);
	const evidenceCandidates = selection.candidateIds;
	const checkpointCandidates = checkpointReferenceCandidates(snapshot);
	const evidencePresented = [...renderedEvidenceRefs].filter((value) => evidenceCandidates.has(value)).sort();
	const evidenceSummaryPresented = [...renderedSummaryEvidenceRefs]
		.filter((value) => evidenceCandidates.has(value))
		.sort();
	const evidenceReferenceOnly = evidencePresented.filter((value) => !renderedSummaryEvidenceRefs.has(value));
	const evidenceOmitted = [...evidenceCandidates].filter((value) => !renderedEvidenceRefs.has(value)).sort();
	const checkpointPresented = [...renderedCheckpointRefs].filter((value) => checkpointCandidates.has(value)).sort();
	const checkpointOmitted = [...checkpointCandidates].filter((value) => !renderedCheckpointRefs.has(value)).sort();
	const referenceListsTruncated =
		evidencePresented.length > 32 ||
		evidenceOmitted.length > 32 ||
		checkpointPresented.length > 32 ||
		checkpointOmitted.length > 32;
	return {
		contextRole,
		contextBytes: Buffer.byteLength(context, "utf8"),
		contextLimitBytes: Math.max(0, Math.trunc(maximumBytes)),
		identityBlockBytes: blockBytes.identity,
		failureBlockBytes: blockBytes.failure,
		evidenceBlockBytes: blockBytes.evidence,
		progressBlockBytes: blockBytes.progress,
		supplementalBlockBytes: blockBytes.supplemental,
		evidenceRefsCandidateCount: evidenceCandidates.size,
		evidenceRefsPresentedCount: evidencePresented.length,
		evidenceRefsPresented: evidencePresented.slice(0, 32),
		evidenceRefsSummaryPresentedCount: evidenceSummaryPresented.length,
		evidenceRefsSummaryPresented: evidenceSummaryPresented.slice(0, 32),
		evidenceRefsReferenceOnlyCount: evidenceReferenceOnly.length,
		evidenceRefsReferenceOnly: evidenceReferenceOnly.slice(0, 32),
		evidenceRefsOmitted: evidenceOmitted.slice(0, 32),
		evidenceRefsOmittedCount: evidenceOmitted.length,
		checkpointRefsCandidateCount: checkpointCandidates.size,
		checkpointRefsPresentedCount: checkpointPresented.length,
		checkpointRefsPresented: checkpointPresented.slice(0, 32),
		checkpointRefsOmitted: checkpointOmitted.slice(0, 32),
		checkpointRefsOmittedCount: checkpointOmitted.length,
		referenceListsTruncated,
	};
}

export function renderPlanningContextWithSummary(
	snapshot: PlanningSnapshot,
	lease: PlanningTaskLease,
	maximumBytes: number,
): { text: string; summary: PlanningContextRenderSummary } {
	const text = renderPlanningContext(snapshot, lease, maximumBytes);
	return {
		text,
		summary: renderedContextSummary(snapshot, text, maximumBytes, "executor", lease.taskId, lease.leaseId),
	};
}

export function renderSupervisorContext(snapshot: PlanningSnapshot, maximumBytes: number): string {
	return renderPriorityContext(
		"Choose the next action from durable Planning state.",
		currentIdentity(snapshot),
		failureCritical(snapshot),
		relevantEvidence(snapshot, "supervisor"),
		progressView(snapshot),
		{
			...explorationHandoff(snapshot, "supervisor"),
			latestFailure: snapshot.latestFailure ? compactFailure(snapshot.latestFailure) : null,
			latestCheckpoint: snapshot.latestCheckpoint ? compactCheckpoint(snapshot.latestCheckpoint) : null,
			...(snapshot.recentFailures ? { recentFailedAttempts: snapshot.recentFailures.map(compactFailure) } : {}),
			allowedDependencyTaskIds: snapshot.tasks.map((task) => task.taskId),
			tasks: snapshot.tasks.map((task) => ({
				taskId: task.taskId,
				objective: task.objective,
				doneWhen: task.doneWhen,
				status: task.status,
				lastError: task.lastError ?? null,
				inputEvidenceRefs: task.inputEvidenceRefs ?? [],
			})),
			run: { goal: snapshot.run.goal, status: snapshot.run.status },
		},
		maximumBytes,
		SUPERVISOR_CONTEXT_BUDGET,
	);
}

export function renderSupervisorContextWithSummary(
	snapshot: PlanningSnapshot,
	maximumBytes: number,
): { text: string; summary: PlanningContextRenderSummary } {
	const text = renderSupervisorContext(snapshot, maximumBytes);
	return {
		text,
		summary: renderedContextSummary(snapshot, text, maximumBytes, "supervisor"),
	};
}
