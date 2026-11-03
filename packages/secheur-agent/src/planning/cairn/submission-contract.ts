import { Type } from "typebox";
import { validatePlanningCoverage } from "../planner-memory.ts";
import { fillHostPlanningFields } from "../proposal-session.ts";
import type { ObserverNote } from "../run-observer.ts";
import type { SourceBinding } from "../source-bindings.ts";
import type { CairnEvidence } from "./host-evidence.ts";
import { parseReasonProposal, REASON_PROPOSAL_LIMITS, validateReasonProposal } from "./reason-proposal.ts";
import type { ChallengeGraphSnapshot } from "./types.ts";

const limits = REASON_PROPOSAL_LIMITS;
const references = () => Type.Array(Type.String(), { maxItems: limits.references, uniqueItems: true });
/** The published tool contract shares the host's existing limits; it does not relax validation. */
export const cairnProposalSchema = Type.Object(
	{
		rationaleSummary: Type.String({ maxLength: limits.rationaleSummary }),
		coverage: Type.Optional(
			Type.Object({
				remaining: Type.Array(
					Type.Object({
						question: Type.String({ minLength: 1, maxLength: 500 }),
						ownerId: Type.Optional(Type.String()),
						dependsOn: Type.Optional(Type.Array(Type.String())),
						evidenceIds: Type.Optional(Type.Array(Type.String())),
					}),
					{ minItems: 1, maxItems: 16 },
				),
				recheckOn: Type.String({ minLength: 1, maxLength: 500 }),
			}),
		),
		proposedIntents: Type.Array(
			Type.Object(
				{
					clientId: Type.Optional(Type.String()),
					increment: Type.Optional(Type.String({ maxLength: limits.rationale })),
					incrementEvidenceIds: Type.Optional(Type.Array(Type.String())),
					objective: Type.String({ minLength: 1, maxLength: limits.objective }),
					successCriteria: Type.Array(Type.String({ minLength: 1, maxLength: limits.successCriterion }), {
						maxItems: limits.successCriteria,
					}),
					rationale: Type.String({ maxLength: limits.rationale }),
					fromFactIds: references(),
					sourceHintIds: Type.Optional(references()),
					capabilityTags: Type.Optional(Type.Array(Type.String(), { maxItems: limits.capabilityTags })),
					priority: Type.Optional(Type.Integer()),
					supersedesIntentIds: Type.Optional(references()),
				},
				{ additionalProperties: false },
			),
			{ maxItems: limits.proposedIntents },
		),
		supersedeRecommendations: Type.Array(
			Type.Object(
				{
					intentId: Type.String(),
					rationale: Type.String({ maxLength: limits.rationale }),
					replacementClientId: Type.Optional(Type.String()),
				},
				{ additionalProperties: false },
			),
			{ maxItems: limits.supersedeRecommendations },
		),
	},
	{ additionalProperties: false },
);

/** IDs are separated by namespace. Tool call IDs, Fact IDs and Evidence IDs are not interchangeable. */
export function cairnSelectionCatalog(
	graph: ChallengeGraphSnapshot,
	evidenceIds: string[],
	preferredEvidenceIds: string[] = [],
) {
	const available = (ids: string[], preferred: string[] = []) => {
		const known = new Set(ids);
		const relevant = [...new Set(preferred)].filter((id) => known.has(id));
		const selected = [...new Set([...relevant, ...[...known].reverse()])].slice(0, 32);
		return {
			ids: selected,
			omittedCount: known.size - selected.length,
			omittedRelevantCount: relevant.filter((id) => !selected.includes(id)).length,
		};
	};
	const owners = graph.intents.filter((intent) => ["claimed", "running"].includes(intent.status));
	const activeFacts = graph.facts.filter((fact) => fact.status === "active");
	const ownerFacts = new Set(owners.flatMap((intent) => [...intent.fromFactIds, ...intent.resultFactIds]));
	const activeReferences = [...activeFacts.filter((fact) => ownerFacts.has(fact.id)), ...activeFacts].flatMap(
		(fact) => fact.evidenceRefs,
	);
	return {
		runId: graph.challengeId,
		fromFactIds: available(
			activeFacts.map((fact) => fact.id),
			[...ownerFacts],
		),
		sourceHintIds: available(
			graph.hints.map((hint) => hint.id),
			owners.flatMap((intent) => intent.sourceHintIds),
		),
		incrementEvidenceIdsOrCoverageEvidenceIds: available(evidenceIds, [...activeReferences, ...preferredEvidenceIds]),
		coverageOwnerIdOrDependsOn: available(owners.map((intent) => intent.id)),
		supersedesIntentIds: available(graph.intents.map((intent) => intent.id)),
		waitingAllowed: owners.length > 0,
	};
}

/** Bounded supplemental board; the budgeted graph is already in buildReasonPrompt. */
export function buildCairnSubmissionBoard(
	graph: ChallengeGraphSnapshot,
	observations: Array<Pick<CairnEvidence, "evidenceId" | "intentId" | "isError">>,
	observerNotes: ObserverNote[],
	sourceBindings: SourceBinding[],
) {
	const originalIds = observations.map((item) => item.evidenceId);
	const bindings = sourceBindings.filter(
		(binding) => binding.runId === graph.challengeId && originalIds.includes(binding.evidenceId),
	);
	const selectionCatalog = cairnSelectionCatalog(graph, originalIds, [
		...observerNotes.flatMap((note) => note.evidenceIds),
		...bindings.map((binding) => binding.evidenceId),
	]);
	const selectedIds = selectionCatalog.incrementEvidenceIdsOrCoverageEvidenceIds.ids;
	const cards = selectedIds.slice(0, 8).flatMap((id) => {
		const item = observations.find((observation) => observation.evidenceId === id);
		if (!item) return [];
		const facts = graph.facts.filter((fact) => fact.status === "active" && fact.evidenceRefs.includes(id));
		return [
			{
				evidenceId: id,
				intentId: item.intentId,
				isError: item.isError,
				factIds: facts.map((fact) => fact.id).slice(-4),
				summary: Array.from(
					facts[0]?.statement ?? "No executor summary yet; ask its owner for the specific missing observation.",
				)
					.slice(0, 50)
					.join(""),
				summaryOrigin: "executor_claim_or_missing",
			},
		];
	});
	const selectedBindings = bindings.filter((binding) => selectedIds.includes(binding.evidenceId)).slice(-8);
	return {
		selectionCatalog,
		evidenceCards: cards,
		observerNotes,
		sourceBindings: {
			records: selectedBindings.map((binding) => ({
				bindingId: binding.bindingId,
				evidenceId: binding.evidenceId,
				jsonPointer: binding.jsonPointer,
				sourceHash: binding.sourceHash,
				authority: binding.authority,
				outcome: binding.outcome,
				...(binding.value === null ||
				["number", "boolean"].includes(typeof binding.value) ||
				(typeof binding.value === "string" && binding.value.length <= 240)
					? { value: binding.value }
					: { valueOmitted: true }),
			})),
			omittedCount: bindings.length - selectedBindings.length,
		},
	};
}

/** Preserve the draft and current owners; feedback never stages partial or invalid work. */
export function cairnSubmissionRepairError(
	error: unknown,
	graph: ChallengeGraphSnapshot,
	evidenceIds: string[],
): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(
		`${message}\nCorrect only the invalid fields in the existing proposal; keep valid objectives and active owners. Do not invent references or substitute Fact/Intent/tool-call IDs for evidence IDs. Optional evidence arrays may be omitted when no original observation supports the claim. Current selectable IDs: ${JSON.stringify(cairnSelectionCatalog(graph, evidenceIds))}`,
	);
}

export function normalizeCairnSubmission(
	value: unknown,
	graph: ChallengeGraphSnapshot,
	evidenceIds: string[],
): unknown {
	try {
		const result = fillHostPlanningFields(value) as Record<string, unknown>;
		if (!Array.isArray(result.proposedIntents)) return result;
		// Coverage is explanatory metadata. The host already knows the live owners;
		// do not require the model to repeat them in order to preserve their work.
		const owners = graph.intents.filter((intent) => ["claimed", "running"].includes(intent.status));
		if (!result.proposedIntents.length && owners.length) {
			const coverage = result.coverage as { remaining?: unknown; recheckOn?: unknown } | undefined;
			const remaining =
				Array.isArray(coverage?.remaining) && coverage.remaining.length
					? coverage.remaining
					: [{ question: "Await the current execution checkpoint" }];
			result.coverage = {
				...coverage,
				remaining: remaining.map((entry: Record<string, unknown>) => {
					const liveIds = owners.map((owner) => owner.id);
					if (
						liveIds.includes(String(entry.ownerId)) ||
						(Array.isArray(entry.dependsOn) &&
							entry.dependsOn.length &&
							entry.dependsOn.every((id) => liveIds.includes(id)))
					)
						return entry;
					const { ownerId: _ownerId, dependsOn: _dependsOn, ...question } = entry;
					// This is a recheck condition, not a claim that an executor has
					// proved coverage of every question. Never change actual ownership.
					return { ...question, dependsOn: liveIds };
				}),
				recheckOn: coverage?.recheckOn || "Current owner checkpoint or completion",
			};
		}
		for (const item of result.proposedIntents) {
			if (!item || typeof item !== "object") continue;
			const intent = item as Record<string, unknown>;
			// Increment is an optional explanation, not a scheduling dependency.
			if (
				intent.increment !== undefined &&
				(typeof intent.increment !== "string" || intent.increment.length > limits.rationale)
			)
				throw new Error("Keep the increment explanation within 2000 characters");
			if (
				intent.incrementEvidenceIds !== undefined &&
				(!Array.isArray(intent.incrementEvidenceIds) ||
					intent.incrementEvidenceIds.some((id) => typeof id !== "string" || !evidenceIds.includes(id)))
			)
				throw new Error("Increment evidence must cite exact original observations in this run");
			// Metadata remains in the durably staged proposal. Appending it to rationale
			// made two individually valid fields exceed the host's rationale limit.
		}
		return result;
	} catch (error) {
		throw cairnSubmissionRepairError(error, graph, evidenceIds);
	}
}

export function validateCairnSubmission(value: unknown, graph: ChallengeGraphSnapshot, evidenceIds: string[]): void {
	try {
		const draft = parseReasonProposal(JSON.stringify(value));
		if (!draft.proposedIntents.length) {
			const owners = graph.intents
				.filter((intent) => ["claimed", "running"].includes(intent.status))
				.map((intent) => intent.id);
			validatePlanningCoverage(draft.coverage, owners, owners, evidenceIds);
		}
		const errors = graph.goalState?.completed ? ["challenge is completed"] : validateReasonProposal(draft, graph);
		if (errors.length) throw new Error(errors.join("; "));
	} catch (error) {
		throw cairnSubmissionRepairError(error, graph, evidenceIds);
	}
}
