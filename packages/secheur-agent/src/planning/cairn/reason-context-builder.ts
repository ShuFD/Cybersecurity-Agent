/** Adapted from sxd-git1/cairnpilot b015733fa117aa35f2406b8b31fd1bbf84d3ec6e.
 * Apache-2.0; see vendor/cairnpilot/LICENSE and NOTICE.md. */
import { createHash } from "node:crypto";
import type {
	ChallengeGraphSnapshot,
	GraphIntent,
	ReasonContext,
	ReasonContextEnvelope,
	ReasonTrigger,
} from "./types.ts";

export const REASON_CONTEXT_LIMITS = {
	activeFacts: 32,
	failureBoundaries: 16,
	hints: 16,
	activeIntents: 24,
	terminalIntents: 16,
	characters: 24_000,
} as const;

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => [key, stableValue(item)]),
	);
}

function fingerprint(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(stableValue(value)))
		.digest("hex");
}

function byId<T extends { id: string }>(left: T, right: T): number {
	return left.id.localeCompare(right.id);
}

function terminalOrder(left: GraphIntent, right: GraphIntent): number {
	return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
}

function serializedSize(context: ReasonContext): number {
	return JSON.stringify(stableValue(context)).length;
}

function shortenOverview(text: string, limit: number): string {
	const marker = " [overview shortened]";
	return text.length <= limit ? text : text.slice(0, limit - marker.length) + marker;
}

export function buildReasonContext(
	snapshot: ChallengeGraphSnapshot,
	triggers: ReasonTrigger[],
	baseEventSequence: number,
): ReasonContextEnvelope {
	const allActiveFacts = snapshot.facts.filter((fact) => fact.status === "active").sort(byId);
	const allFailureBoundaries = allActiveFacts.filter((fact) => fact.kind === "failure_boundary");
	const allHints = [...snapshot.hints].sort(byId);
	const allActiveIntents = snapshot.intents
		.filter((intent) => ["open", "claimed", "running", "blocked"].includes(intent.status))
		.sort(byId);
	const allTerminalIntents = snapshot.intents
		.filter((intent) => ["concluded", "superseded"].includes(intent.status))
		.sort(terminalOrder);
	// Keep the causal prerequisites of live work, including facts from concluded parents.
	const pinnedFacts = new Set(allActiveFacts.filter((fact) => fact.kind === "goal").map((fact) => fact.id));
	const pinnedIntents = new Set(allActiveIntents.map((intent) => intent.id));
	const pending = allActiveIntents.flatMap((intent) => intent.fromFactIds);
	while (pending.length) {
		const id = pending.pop()!;
		if (pinnedFacts.has(id)) continue;
		pinnedFacts.add(id);
		const fact = allActiveFacts.find((item) => item.id === id);
		const parent =
			fact?.producedByIntentId && snapshot.intents.find((intent) => intent.id === fact.producedByIntentId);
		if (parent && !pinnedIntents.has(parent.id)) {
			pinnedIntents.add(parent.id);
			pending.push(...parent.fromFactIds);
		}
	}
	const priorityFacts = [
		...allActiveFacts.filter((fact) => pinnedFacts.has(fact.id)),
		...allActiveFacts.filter((fact) => !pinnedFacts.has(fact.id)),
	];

	const context: ReasonContext = {
		challengeId: snapshot.challengeId,
		goalState: snapshot.goalState,
		activeFacts: priorityFacts.slice(0, Math.max(REASON_CONTEXT_LIMITS.activeFacts, pinnedFacts.size)),
		failureBoundaries: allFailureBoundaries.slice(0, REASON_CONTEXT_LIMITS.failureBoundaries),
		hints: allHints.slice(0, REASON_CONTEXT_LIMITS.hints),
		activeIntents: allActiveIntents,
		recentTerminalIntents: [
			...allTerminalIntents.filter((intent) => pinnedIntents.has(intent.id)),
			...allTerminalIntents
				.filter((intent) => !pinnedIntents.has(intent.id))
				.slice(0, REASON_CONTEXT_LIMITS.terminalIntents),
		].map((intent) => ({
			id: intent.id,
			objective: intent.objective,
			status: intent.status,
			outcome: intent.outcome,
			resultFactIds: [...intent.resultFactIds].sort(),
			updatedAt: intent.updatedAt,
		})),
		triggers: [...triggers].sort(
			(left, right) => left.sourceEventSequence - right.sourceEventSequence || left.id.localeCompare(right.id),
		),
		baseEventSequence,
		truncated:
			allActiveFacts.length > REASON_CONTEXT_LIMITS.activeFacts ||
			allFailureBoundaries.length > REASON_CONTEXT_LIMITS.failureBoundaries ||
			allHints.length > REASON_CONTEXT_LIMITS.hints ||
			allActiveIntents.length > REASON_CONTEXT_LIMITS.activeIntents ||
			allTerminalIntents.length > REASON_CONTEXT_LIMITS.terminalIntents,
	};

	// Removals consume a record; prose passes consume a fixed tier, even when nothing changes.
	// Never select a shortened record repeatedly based on its resulting length.
	const proseLimits = [192, 128, 64];
	let prosePass = 0;
	while (serializedSize(context) > REASON_CONTEXT_LIMITS.characters) {
		if (context.recentTerminalIntents.some((intent) => !pinnedIntents.has(intent.id))) {
			const index = context.recentTerminalIntents.findIndex((intent) => !pinnedIntents.has(intent.id));
			context.recentTerminalIntents.splice(index, 1);
		} else if (context.hints.length) context.hints.pop();
		else if (context.activeFacts.some((fact) => !pinnedFacts.has(fact.id))) {
			const index = context.activeFacts.findIndex((fact) => !pinnedFacts.has(fact.id));
			context.activeFacts.splice(index, 1);
		} else {
			// Only shorten prose in the overview. IDs, source links and raw graph stay available to queries.
			const limit = proseLimits[prosePass++];
			if (limit === undefined) {
				throw new Error("Reason Context causal identifiers exceed overview budget; raw records remain available");
			}
			context.activeFacts = context.activeFacts.map((fact) => ({
				...fact,
				statement: shortenOverview(fact.statement, limit),
			}));
			context.failureBoundaries = context.failureBoundaries.map((fact) => ({
				...fact,
				statement: shortenOverview(fact.statement, limit),
			}));
			context.activeIntents = context.activeIntents.map((intent) => ({
				...intent,
				objective: shortenOverview(intent.objective, limit),
				scope: shortenOverview(intent.scope, limit),
			}));
			context.recentTerminalIntents = context.recentTerminalIntents.map((intent) => ({
				...intent,
				objective: shortenOverview(intent.objective, limit),
			}));
		}
		context.truncated = true;
	}

	return { context, fingerprint: fingerprint(context) };
}
