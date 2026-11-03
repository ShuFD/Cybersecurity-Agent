import type { FocusedGraphContext, GraphIntent } from "./cairn/types.ts";
import type { PlanningSnapshot, PlanningTaskLease } from "./contracts.ts";
import { trustedPlanningVerificationFromSnapshot } from "./terminal-verification.ts";

export interface PlanningHandoff {
	schemaVersion: 1;
	runId: string;
	overallGoal: string;
	localQuestion: string;
	completionCriteria: string[];
	verifiedOutcomes: unknown[];
	claims: unknown[];
	failureBoundaries: unknown[];
	artifacts: unknown[];
	pendingTools: unknown[];
	remainingGaps: unknown[];
	queryHelp: string;
}

export function progressiveHandoff(snapshot: PlanningSnapshot, lease: PlanningTaskLease): PlanningHandoff {
	const frame = snapshot.executionFrame.frame;
	const sourceIds = new Set([lease.taskId]);
	const pending = [lease.taskId];
	while (pending.length) {
		const task = snapshot.tasks.find((item) => item.taskId === pending.pop());
		for (const id of task?.dependsOnTaskIds ?? [])
			if (!sourceIds.has(id)) {
				sourceIds.add(id);
				pending.push(id);
			}
	}
	return {
		schemaVersion: 1,
		runId: snapshot.run.runId,
		overallGoal: snapshot.run.goal,
		localQuestion: lease.objective,
		completionCriteria: [lease.doneWhen],
		verifiedOutcomes: trustedPlanningVerificationFromSnapshot(snapshot)
			? [trustedPlanningVerificationFromSnapshot(snapshot)]
			: [],
		claims: frame.facts
			.filter((item) => sourceIds.has(item.sourceTaskId))
			.map((item) => ({ ...item, authority: "executor_claim" })),
		failureBoundaries: frame.rejectedDirections.filter((item) => sourceIds.has(item.sourceTaskId)),
		artifacts: frame.artifacts
			.filter((item) => sourceIds.has(item.sourceTaskId))
			.map((item) => ({ ...item, runId: snapshot.run.runId })),
		pendingTools: [],
		remainingGaps: frame.openQuestions,
		queryHelp:
			"Read original same-run evidence with planning_list_evidence/planning_read_evidence. Pending tool status is supplied by the native background-tool mechanism; an empty snapshot is not evidence that tools finished. Parameters and versions must retain original evidence IDs. A local report is not overall success.",
	};
}

export function cairnHandoff(context: FocusedGraphContext, intent: GraphIntent, overallGoal?: string): PlanningHandoff {
	return {
		schemaVersion: 1,
		runId: context.challengeId,
		overallGoal:
			overallGoal ??
			context.facts
				.filter((fact) => fact.kind === "goal")
				.map((fact) => fact.statement)
				.join("\n"),
		localQuestion: intent.objective,
		completionCriteria: [intent.scope],
		verifiedOutcomes: [],
		claims: context.facts
			.filter((fact) => fact.kind !== "goal")
			.map((fact) => ({ ...fact, authority: "executor_claim" })),
		failureBoundaries: context.facts.filter((fact) => fact.kind === "failure_boundary"),
		artifacts: context.delta
			.filter((event) => event.type.includes("artifact"))
			.map((event) => ({ runId: context.challengeId, sourceEvent: event.sequence, value: event.payload })),
		pendingTools: [],
		remainingGaps: context.intents
			.filter((item) => item.status === "blocked")
			.map((item) => ({ intentId: item.id, objective: item.objective })),
		queryHelp:
			"Use graph_query_record for full facts/intents, graph_list_evidence/graph_read_evidence for original observations. Graph active status means durable ownership, not semantic proof. Overall success requires the native verifier. Pending native background tools remain processing until their completion event.",
	};
}

export function renderPlanningHandoff(handoff: PlanningHandoff): string {
	// This is an overview, not the authoritative task or source record. Keep
	// identifiers intact and shorten prose; omitted records remain queryable.
	const compact = (value: unknown, key = ""): unknown => {
		if (typeof value === "string")
			return /(?:Id|Ids|Hash|Path|Refs)$/i.test(key)
				? value
				: value.length > 256
					? `${value.slice(0, 256)} [overview shortened]`
					: value;
		if (Array.isArray(value)) return value.slice(0, 8).map((item) => compact(item, key));
		if (value && typeof value === "object")
			return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, compact(item, name)]));
		return value;
	};
	const overview: Record<string, unknown> = {
		...handoff,
		overallGoal: compact(handoff.overallGoal),
		localQuestion: compact(handoff.localQuestion),
		completionCriteria: compact(handoff.completionCriteria),
		queryHelp: handoff.queryHelp,
		overviewOnly: true,
	};
	const heading = "[Shared PLAN handoff overview; full records remain queryable; claims retain their sources]\n";
	const counts: Record<string, { total: number; presented: number }> = {};
	for (const name of [
		"verifiedOutcomes",
		"claims",
		"failureBoundaries",
		"artifacts",
		"pendingTools",
		"remainingGaps",
	] as const) {
		overview[name] = [];
		counts[name] = { total: handoff[name].length, presented: 0 };
	}
	overview.recordCounts = counts;
	for (const name of [
		"verifiedOutcomes",
		"pendingTools",
		"failureBoundaries",
		"artifacts",
		"claims",
		"remainingGaps",
	] as const) {
		const entries = overview[name] as unknown[];
		for (const value of handoff[name].slice(0, 8)) {
			entries.push(compact(value));
			if (Buffer.byteLength(heading + JSON.stringify(overview), "utf8") > 16_384) {
				entries.pop();
				continue;
			}
			counts[name]!.presented++;
		}
	}
	return heading + JSON.stringify(overview);
}
