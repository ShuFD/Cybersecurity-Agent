import type { ParsedReasonProposal } from "./reason-proposal.ts";
import type { ReasonContextEnvelope } from "./types.ts";

/** Capacity admits independently planned work; it is not evidence for a
 * host-generated review of an unspecified assumption. Preserve valid plans. */
export function prepareManagedProposal(
	draft: ParsedReasonProposal,
	_context: ReasonContextEnvelope,
	_capacity: number,
): ParsedReasonProposal {
	return draft;
}

/** Keep executors working when the planner cannot serialize a plan. Not task success. */
export function recoverManagedProposal(
	context: ReasonContextEnvelope,
	_capacity: number,
): ParsedReasonProposal | undefined {
	if (context.context.activeIntents.some((intent) => ["open", "claimed", "running"].includes(intent.status))) {
		return {
			rationaleSummary: "Preserve active work; reconsider on fresh checkpoint or completion",
			coverage: {
				remaining: context.context.activeIntents
					.filter((intent) => ["claimed", "running"].includes(intent.status))
					.map((intent) => ({ question: intent.objective.slice(0, 500), ownerId: intent.id })),
				recheckOn: "fresh checkpoint, owner completion, or run-local opportunity review",
			},
			proposedIntents: [],
			supersedeRecommendations: [],
		};
	}
	// A serialization failure supplies no evidence for a new executable question.
	// Keep the graph and trigger retry state; do not manufacture whole-goal work.
	return undefined;
}

/** Consume routine checkpoint triggers without model work when both owners
 * already cover the task. Fresh failure boundaries still warrant planning. */
export function preserveManagedWork(
	context: ReasonContextEnvelope,
	capacity: number,
): ParsedReasonProposal | undefined {
	const live = context.context.activeIntents.filter((intent) => ["claimed", "running"].includes(intent.status));
	if (live.length < capacity || !context.context.triggers.length) return;
	if (context.context.triggers.some((trigger) => trigger.reason !== "fact_confirmed")) return;
	const since = Math.min(...context.context.triggers.map((trigger) => Date.parse(trigger.createdAt)));
	if (
		!Number.isFinite(since) ||
		context.context.failureBoundaries.some((fact) => Date.parse(fact.observedAt) >= since)
	)
		return;
	return {
		rationaleSummary: "Share checkpoints with current owners; no route revision or new slot is needed",
		coverage: {
			remaining: live.map((intent) => ({ question: intent.objective.slice(0, 500), ownerId: intent.id })),
			recheckOn: "new failure boundary, owner completion, or vacancy review",
		},
		proposedIntents: [],
		supersedeRecommendations: [],
	};
}
