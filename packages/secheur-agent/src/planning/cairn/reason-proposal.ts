/** Adapted from sxd-git1/cairnpilot b015733fa117aa35f2406b8b31fd1bbf84d3ec6e.
 * Apache-2.0; see vendor/cairnpilot/LICENSE and NOTICE.md. */

import type { PlanningCoverage } from "../planner-memory.ts";
import { parseProposalJson } from "../proposal-json.ts";
import type { ChallengeGraphSnapshot, ReasonProposedIntent, ReasonSupersedeRecommendation } from "./types.ts";

export const REASON_PROPOSAL_LIMITS = {
	proposedIntents: 8,
	supersedeRecommendations: 16,
	objective: 500,
	rationale: 2_000,
	rationaleSummary: 2_000,
	successCriteria: 8,
	successCriterion: 300,
	capabilityTags: 12,
	references: 32,
} as const;

export interface ParsedReasonProposal {
	coverage?: PlanningCoverage;
	rationaleSummary: string;
	proposedIntents: ReasonProposedIntent[];
	supersedeRecommendations: ReasonSupersedeRecommendation[];
}

export class ReasonProposalParseError extends Error {}

function record(value: unknown, field: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ReasonProposalParseError(`${field} must be an object`);
	}
	return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: string[], field: string): void {
	const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
	if (unexpected) throw new ReasonProposalParseError(`${field} contains unexpected field ${unexpected}`);
}

function text(value: unknown, field: string): string {
	if (typeof value !== "string") throw new ReasonProposalParseError(`${field} must be a string`);
	return value.trim();
}

function strings(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new ReasonProposalParseError(`${field} must be a string array`);
	}
	return value.map((item) => item.trim());
}

export function parseReasonProposal(textOutput: string): ParsedReasonProposal {
	let value: unknown;
	try {
		value = parseProposalJson(textOutput);
	} catch {
		throw new ReasonProposalParseError("model output is not valid JSON");
	}
	const root = record(value, "proposal");
	exact(root, ["rationaleSummary", "proposedIntents", "supersedeRecommendations", "coverage"], "proposal");
	// Optional empty metadata is safe to normalize; executable work and
	// grounding remain required and unknown fields/references stay invalid.
	if (root.supersedeRecommendations === undefined) root.supersedeRecommendations = [];
	if (!Array.isArray(root.proposedIntents) || !Array.isArray(root.supersedeRecommendations)) {
		throw new ReasonProposalParseError("proposal arrays are required");
	}
	return {
		rationaleSummary: text(root.rationaleSummary, "rationaleSummary"),
		...(root.coverage ? { coverage: root.coverage as PlanningCoverage } : {}),
		proposedIntents: root.proposedIntents.map((item, index) => {
			const intent = record(item, `proposedIntents[${index}]`);
			exact(
				intent,
				[
					"clientId",
					"increment",
					"incrementEvidenceIds",
					"objective",
					"successCriteria",
					"rationale",
					"fromFactIds",
					"sourceHintIds",
					"capabilityTags",
					"priority",
					"supersedesIntentIds",
				],
				`proposedIntents[${index}]`,
			);
			if (!Number.isSafeInteger(intent.priority)) {
				throw new ReasonProposalParseError(`proposedIntents[${index}].priority must be an integer`);
			}
			return {
				clientId: text(intent.clientId, `proposedIntents[${index}].clientId`),
				objective: text(intent.objective, `proposedIntents[${index}].objective`),
				successCriteria: strings(intent.successCriteria, `proposedIntents[${index}].successCriteria`),
				rationale: text(intent.rationale, `proposedIntents[${index}].rationale`),
				fromFactIds: strings(intent.fromFactIds, `proposedIntents[${index}].fromFactIds`),
				sourceHintIds: strings(
					intent.sourceHintIds === undefined ? [] : intent.sourceHintIds,
					`proposedIntents[${index}].sourceHintIds`,
				),
				capabilityTags: strings(
					intent.capabilityTags === undefined ? [] : intent.capabilityTags,
					`proposedIntents[${index}].capabilityTags`,
				),
				priority: intent.priority as number,
				supersedesIntentIds: strings(
					intent.supersedesIntentIds === undefined ? [] : intent.supersedesIntentIds,
					`proposedIntents[${index}].supersedesIntentIds`,
				),
			};
		}),
		supersedeRecommendations: root.supersedeRecommendations.map((item, index) => {
			const recommendation = record(item, `supersedeRecommendations[${index}]`);
			exact(recommendation, ["intentId", "rationale", "replacementClientId"], `supersedeRecommendations[${index}]`);
			return {
				intentId: text(recommendation.intentId, `supersedeRecommendations[${index}].intentId`),
				rationale: text(recommendation.rationale, `supersedeRecommendations[${index}].rationale`),
				replacementClientId:
					recommendation.replacementClientId === undefined
						? undefined
						: text(recommendation.replacementClientId, `supersedeRecommendations[${index}].replacementClientId`),
			};
		}),
	};
}

function duplicates(values: string[]): boolean {
	return new Set(values).size !== values.length;
}

export function validateReasonProposal(proposal: ParsedReasonProposal, graph: ChallengeGraphSnapshot): string[] {
	const errors: string[] = [];
	const factIds = new Set(graph.facts.filter((fact) => fact.status === "active").map((fact) => fact.id));
	const hintIds = new Set(graph.hints.map((hint) => hint.id));
	const intentIds = new Set(graph.intents.map((intent) => intent.id));
	const clientIds = proposal.proposedIntents.map((intent) => intent.clientId);
	if (proposal.rationaleSummary.length > REASON_PROPOSAL_LIMITS.rationaleSummary)
		errors.push("rationaleSummary exceeds limit");
	if (proposal.proposedIntents.length > REASON_PROPOSAL_LIMITS.proposedIntents)
		errors.push("proposedIntents exceeds limit");
	if (proposal.supersedeRecommendations.length > REASON_PROPOSAL_LIMITS.supersedeRecommendations) {
		errors.push("supersedeRecommendations exceeds limit");
	}
	if (duplicates(clientIds)) errors.push("clientId must be unique");
	const clientIdSet = new Set(clientIds);
	proposal.proposedIntents.forEach((intent, index) => {
		const field = `proposedIntents[${index}]`;
		if (!intent.clientId) errors.push(`${field}.clientId is required`);
		if (!intent.objective) errors.push(`${field}.objective is required`);
		if (intent.objective.length > REASON_PROPOSAL_LIMITS.objective) errors.push(`${field}.objective exceeds limit`);
		if (intent.rationale.length > REASON_PROPOSAL_LIMITS.rationale) errors.push(`${field}.rationale exceeds limit`);
		if (intent.successCriteria.length > REASON_PROPOSAL_LIMITS.successCriteria)
			errors.push(`${field}.successCriteria exceeds limit`);
		if (intent.successCriteria.some((item) => !item || item.length > REASON_PROPOSAL_LIMITS.successCriterion)) {
			errors.push(`${field}.successCriteria contains invalid text`);
		}
		if (intent.capabilityTags.length > REASON_PROPOSAL_LIMITS.capabilityTags)
			errors.push(`${field}.capabilityTags exceeds limit`);
		for (const [name, refs] of [
			["fromFactIds", intent.fromFactIds],
			["sourceHintIds", intent.sourceHintIds],
			["supersedesIntentIds", intent.supersedesIntentIds],
		] as const) {
			if (refs.length > REASON_PROPOSAL_LIMITS.references) errors.push(`${field}.${name} exceeds limit`);
			if (duplicates(refs)) errors.push(`${field}.${name} contains duplicate references`);
		}
		for (const id of intent.fromFactIds) {
			if (!factIds.has(id)) errors.push(`${field}.fromFactIds references non-active or foreign Fact ${id}`);
			if (hintIds.has(id)) errors.push(`${field}.fromFactIds cannot contain Hint ${id}`);
		}
		for (const id of intent.sourceHintIds) {
			if (!hintIds.has(id)) errors.push(`${field}.sourceHintIds references foreign Hint ${id}`);
			if (factIds.has(id)) errors.push(`${field}.sourceHintIds cannot contain Fact ${id}`);
		}
		for (const id of intent.supersedesIntentIds) {
			if (!intentIds.has(id)) errors.push(`${field}.supersedesIntentIds references foreign Intent ${id}`);
		}
	});
	proposal.supersedeRecommendations.forEach((recommendation, index) => {
		const field = `supersedeRecommendations[${index}]`;
		if (!intentIds.has(recommendation.intentId))
			errors.push(`${field}.intentId references foreign Intent ${recommendation.intentId}`);
		if (recommendation.rationale.length > REASON_PROPOSAL_LIMITS.rationale)
			errors.push(`${field}.rationale exceeds limit`);
		if (recommendation.replacementClientId && !clientIdSet.has(recommendation.replacementClientId)) {
			errors.push(`${field}.replacementClientId is unknown`);
		}
	});
	return [...new Set(errors)].sort();
}
