/** Adapted from sxd-git1/cairnpilot b015733fa117aa35f2406b8b31fd1bbf84d3ec6e.
 * Apache-2.0; see vendor/cairnpilot/LICENSE and NOTICE.md. */
import type { ChallengeGraphSnapshot, FocusedGraphContext, GraphEvent } from "./types.ts";

export interface FocusedContextLimits {
	maxFacts?: number;
	maxHints?: number;
	maxIntents?: number;
	maxEvents?: number;
	maxTokens?: number;
	maxCharacters?: number;
}

export const FOCUSED_CONTEXT_MAX_LIMITS = {
	maxFacts: 24,
	maxHints: 8,
	maxIntents: 12,
	maxEvents: 32,
	maxTokens: 4_000,
	maxCharacters: 16_000,
} as const;

function takeWithinBudget<T>(items: T[], limit: number, budget: { remaining: number }): T[] {
	const result: T[] = [];
	for (const item of items.slice(0, limit)) {
		const size = JSON.stringify(item).length;
		if (size > budget.remaining) break;
		budget.remaining -= size;
		result.push(item);
	}
	return result;
}

export function buildFocusedContext(
	snapshot: ChallengeGraphSnapshot,
	events: GraphEvent[],
	limits: FocusedContextLimits = {},
): FocusedGraphContext {
	const maxFacts = Math.min(
		limits.maxFacts ?? FOCUSED_CONTEXT_MAX_LIMITS.maxFacts,
		FOCUSED_CONTEXT_MAX_LIMITS.maxFacts,
	);
	const maxHints = Math.min(
		limits.maxHints ?? FOCUSED_CONTEXT_MAX_LIMITS.maxHints,
		FOCUSED_CONTEXT_MAX_LIMITS.maxHints,
	);
	const maxIntents = Math.min(
		limits.maxIntents ?? FOCUSED_CONTEXT_MAX_LIMITS.maxIntents,
		FOCUSED_CONTEXT_MAX_LIMITS.maxIntents,
	);
	const maxEvents = Math.min(
		limits.maxEvents ?? FOCUSED_CONTEXT_MAX_LIMITS.maxEvents,
		FOCUSED_CONTEXT_MAX_LIMITS.maxEvents,
	);
	const maxTokens = Math.min(
		limits.maxTokens ?? FOCUSED_CONTEXT_MAX_LIMITS.maxTokens,
		FOCUSED_CONTEXT_MAX_LIMITS.maxTokens,
	);
	const maxCharacters = Math.min(
		limits.maxCharacters ?? FOCUSED_CONTEXT_MAX_LIMITS.maxCharacters,
		FOCUSED_CONTEXT_MAX_LIMITS.maxCharacters,
	);
	const tokenCharacterBudget = maxTokens * 4;
	const budget = { remaining: Math.min(maxCharacters, tokenCharacterBudget) };
	const facts = takeWithinBudget(
		snapshot.facts.filter((fact) => fact.status === "active").sort((left, right) => left.id.localeCompare(right.id)),
		maxFacts,
		budget,
	);
	const hints = takeWithinBudget(
		[...snapshot.hints].sort((left, right) => left.id.localeCompare(right.id)),
		maxHints,
		budget,
	);
	const intents = takeWithinBudget(
		[...snapshot.intents].sort((left, right) => left.id.localeCompare(right.id)),
		maxIntents,
		budget,
	);
	const delta = takeWithinBudget(
		[...events].sort((left, right) => left.sequence - right.sequence),
		maxEvents,
		budget,
	);
	return {
		challengeId: snapshot.challengeId,
		goalState: snapshot.goalState,
		facts,
		hints,
		intents,
		delta,
		truncated:
			facts.length < snapshot.facts.filter((fact) => fact.status === "active").length ||
			hints.length < snapshot.hints.length ||
			intents.length < snapshot.intents.length ||
			delta.length < events.length,
	};
}

const ACTIVE_INTENT_STATUSES = new Set(["open", "claimed", "running", "blocked"]);
const RELATED_FACT_KINDS = new Set(["origin", "goal", "credential", "asset", "constraint", "failure_boundary"]);

/** Build the smallest deterministic graph slice needed to switch one long-running Solver to an Intent. */
export function buildIntentFocusedContext(
	snapshot: ChallengeGraphSnapshot,
	intentId: string,
	events: GraphEvent[],
	limits: FocusedContextLimits = {},
): FocusedGraphContext {
	const currentIntent = snapshot.intents.find((intent) => intent.id === intentId);
	if (!currentIntent) throw new Error(`Intent ${intentId} was not found in Challenge ${snapshot.challengeId}`);

	const intentById = new Map(snapshot.intents.map((intent) => [intent.id, intent]));
	const factById = new Map(snapshot.facts.map((fact) => [fact.id, fact]));
	const relevantFactIds = new Set(currentIntent.fromFactIds);
	const pendingFactIds = [...currentIntent.fromFactIds];
	while (pendingFactIds.length > 0) {
		const fact = factById.get(pendingFactIds.pop()!);
		const producer = fact?.producedByIntentId ? intentById.get(fact.producedByIntentId) : undefined;
		for (const parentId of producer?.fromFactIds ?? []) {
			if (relevantFactIds.has(parentId)) continue;
			relevantFactIds.add(parentId);
			pendingFactIds.push(parentId);
		}
	}

	const facts = snapshot.facts
		.filter((fact) => fact.status === "active" && (relevantFactIds.has(fact.id) || RELATED_FACT_KINDS.has(fact.kind)))
		.sort((left, right) => {
			const leftDependency = relevantFactIds.has(left.id) ? 0 : 1;
			const rightDependency = relevantFactIds.has(right.id) ? 0 : 1;
			return leftDependency - rightDependency || left.id.localeCompare(right.id);
		});
	const sourceHintIds = new Set(currentIntent.sourceHintIds);
	const hints = snapshot.hints
		.filter((hint) => sourceHintIds.has(hint.id))
		.sort((left, right) => left.id.localeCompare(right.id));
	const intents = [
		currentIntent,
		...snapshot.intents
			.filter((intent) => intent.id !== intentId && ACTIVE_INTENT_STATUSES.has(intent.status))
			.sort((left, right) => left.id.localeCompare(right.id)),
	];
	const relevantEntityIds = new Set([
		currentIntent.id,
		...facts.map((fact) => fact.id),
		...hints.map((hint) => hint.id),
		...intents.map((intent) => intent.id),
	]);
	const delta = events
		.filter((event) => relevantEntityIds.has(event.entityId) || event.type.includes("flag"))
		.sort((left, right) => left.sequence - right.sequence);

	const maxFacts = Math.min(
		limits.maxFacts ?? FOCUSED_CONTEXT_MAX_LIMITS.maxFacts,
		FOCUSED_CONTEXT_MAX_LIMITS.maxFacts,
	);
	const maxHints = Math.min(
		limits.maxHints ?? FOCUSED_CONTEXT_MAX_LIMITS.maxHints,
		FOCUSED_CONTEXT_MAX_LIMITS.maxHints,
	);
	const maxIntents = Math.min(
		limits.maxIntents ?? FOCUSED_CONTEXT_MAX_LIMITS.maxIntents,
		FOCUSED_CONTEXT_MAX_LIMITS.maxIntents,
	);
	const maxEvents = Math.min(
		limits.maxEvents ?? FOCUSED_CONTEXT_MAX_LIMITS.maxEvents,
		FOCUSED_CONTEXT_MAX_LIMITS.maxEvents,
	);
	const maxTokens = Math.min(
		limits.maxTokens ?? FOCUSED_CONTEXT_MAX_LIMITS.maxTokens,
		FOCUSED_CONTEXT_MAX_LIMITS.maxTokens,
	);
	const maxCharacters = Math.min(
		limits.maxCharacters ?? FOCUSED_CONTEXT_MAX_LIMITS.maxCharacters,
		FOCUSED_CONTEXT_MAX_LIMITS.maxCharacters,
	);
	const budget = { remaining: Math.min(maxCharacters, maxTokens * 4) };
	const selectedCurrentIntent = takeWithinBudget([currentIntent], maxIntents > 0 ? 1 : 0, budget);
	const selectedFacts = takeWithinBudget(facts, maxFacts, budget);
	const selectedHints = takeWithinBudget(hints, maxHints, budget);
	const selectedSiblingIntents = takeWithinBudget(
		intents.slice(1),
		Math.max(maxIntents - selectedCurrentIntent.length, 0),
		budget,
	);
	const selectedIntents = [...selectedCurrentIntent, ...selectedSiblingIntents];
	const selectedDelta = takeWithinBudget(delta, maxEvents, budget);

	return {
		challengeId: snapshot.challengeId,
		goalState: snapshot.goalState,
		facts: selectedFacts,
		hints: selectedHints,
		intents: selectedIntents,
		delta: selectedDelta,
		truncated:
			selectedFacts.length < facts.length ||
			selectedHints.length < hints.length ||
			selectedIntents.length < intents.length ||
			selectedDelta.length < delta.length,
	};
}
