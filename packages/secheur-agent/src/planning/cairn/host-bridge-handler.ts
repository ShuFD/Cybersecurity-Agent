const CHALLENGE_ENV_CHALLENGE_ID = "CAIRN_CHALLENGE_ID";

import { FOCUSED_CONTEXT_MAX_LIMITS } from "./context-builder.ts";
import type { HostBridgeHandleContext, HostBridgeHandler } from "./host-types.ts";
import { type GraphService, GraphServiceError } from "./service.ts";
import type { GraphActor, IntentResultFactInput } from "./types.ts";

const GRAPH_ACTIONS = new Set([
	"graph_get_context",
	"graph_get_delta",
	"fact_propose",
	"fact_append_evidence",
	"intent_propose",
	"artifact_register",
	"intent_acknowledge",
	"intent_checkpoint",
	"intent_conclude",
	"intent_release",
]);
const LEASE_ACTIONS = new Set(["intent_acknowledge", "intent_checkpoint", "intent_conclude", "intent_release"]);

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new GraphServiceError("validation", "params must be an object");
	}
	return value as Record<string, unknown>;
}

function exact(data: Record<string, unknown>, allowed: string[]): void {
	const unexpected = Object.keys(data).find((key) => !allowed.includes(key));
	if (unexpected) throw new GraphServiceError("validation", `unexpected parameter: ${unexpected}`);
}

function text(data: Record<string, unknown>, key: string, optional = false): string | undefined {
	const value = data[key];
	if (value === undefined && optional) return;
	if (typeof value !== "string" || !value.trim()) throw new GraphServiceError("validation", `${key} is required`);
	return value.trim();
}

function number(data: Record<string, unknown>, key: string, fallback?: number): number {
	const value = data[key] ?? fallback;
	if (typeof value !== "number" || !Number.isFinite(value))
		throw new GraphServiceError("validation", `${key} must be a number`);
	return value;
}

function safeInteger(data: Record<string, unknown>, key: string, fallback: number): number {
	const value = data[key] ?? fallback;
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new GraphServiceError("validation", `${key} must be a non-negative safe integer`);
	}
	return value as number;
}

function strings(data: Record<string, unknown>, key: string): string[] {
	const value = data[key];
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new GraphServiceError("validation", `${key} must be a string array`);
	}
	return value as string[];
}

function challengeId(context: HostBridgeHandleContext): string {
	const solver = context.getSolver?.();
	if (solver && solver.id !== context.solverId) {
		throw new GraphServiceError("forbidden", "solver identity does not match Host binding");
	}
	const id = solver?.challengeId ?? context.getSolverEnvValue(CHALLENGE_ENV_CHALLENGE_ID);
	if (!id) throw new GraphServiceError("forbidden", "solver is not bound to a challenge");
	const requested = object(context.params).challengeId;
	if (requested !== undefined && requested !== id) {
		throw new GraphServiceError("forbidden", "request challengeId does not match solver challenge");
	}
	return id;
}

function actor(context: HostBridgeHandleContext): GraphActor {
	return { id: context.solverId, role: "solver", challengeId: challengeId(context) };
}

function requestIdentity(context: HostBridgeHandleContext): string {
	const tag = context.intentSession;
	const lease = tag ? undefined : context.getIntentLeaseBinding?.();
	return JSON.stringify([
		context.action,
		context.solverId,
		tag?.intentId ?? lease?.intentId ?? null,
		tag?.generation ?? lease?.generation ?? null,
		tag?.sessionEpoch ?? null,
		context.toolCallId ?? context.requestId,
	]);
}

function commandBase(context: HostBridgeHandleContext) {
	return {
		actor: actor(context),
		idempotencyKey: requestIdentity(context),
		createdAt: text(object(context.params), "createdAt") as string,
	};
}

function leaseInput(context: HostBridgeHandleContext) {
	const lease = context.getIntentLeaseBinding?.();
	if (!lease) throw new GraphServiceError("forbidden", "Solver has no active Intent Lease binding");
	if (lease.solverId !== context.solverId || lease.challengeId !== challengeId(context)) {
		throw new GraphServiceError("forbidden", "Intent Lease binding does not match Solver");
	}
	return {
		actor: { id: context.solverId, role: "solver" as const, challengeId: lease.challengeId },
		idempotencyKey: requestIdentity(context),
		intentId: lease.intentId,
		token: lease.token,
		generation: lease.generation,
		expectedVersion: lease.version,
	};
}

function resultFacts(data: Record<string, unknown>) {
	const value = data.facts;
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new GraphServiceError("validation", "facts must be an array");
	return value.map((item) => {
		const fact = object(item);
		exact(fact, ["kind", "statement", "evidenceRefs"]);
		return {
			kind: text(fact, "kind") as IntentResultFactInput["kind"],
			statement: text(fact, "statement") as string,
			evidenceRefs: strings(fact, "evidenceRefs"),
		};
	});
}

export function createGraphHostBridgeHandler(
	service: GraphService,
	options: { leaseEnabled?: boolean; intentSessionEnabled?: boolean } = {},
): HostBridgeHandler {
	return {
		async handle(context) {
			if (!GRAPH_ACTIONS.has(context.action)) return { handled: false };
			if (LEASE_ACTIONS.has(context.action) && options.leaseEnabled !== true) return { handled: false };
			if (options.intentSessionEnabled === true && !context.isCurrentIntentSession?.(context.intentSession)) {
				throw new GraphServiceError("forbidden", "Intent session is missing or stale");
			}
			const data = object(context.params);
			const resolvedChallengeId = challengeId(context);
			switch (context.action) {
				case "graph_get_context":
					exact(data, [
						"challengeId",
						"afterSequence",
						"maxFacts",
						"maxHints",
						"maxIntents",
						"maxEvents",
						"maxTokens",
						"maxCharacters",
					]);
					return {
						handled: true,
						data: context.intentSession
							? service.getIntentFocusedContext(
									resolvedChallengeId,
									context.intentSession.intentId,
									safeInteger(data, "afterSequence", 0),
									{
										maxFacts: safeInteger(data, "maxFacts", FOCUSED_CONTEXT_MAX_LIMITS.maxFacts),
										maxHints: safeInteger(data, "maxHints", FOCUSED_CONTEXT_MAX_LIMITS.maxHints),
										maxIntents: safeInteger(data, "maxIntents", FOCUSED_CONTEXT_MAX_LIMITS.maxIntents),
										maxEvents: safeInteger(data, "maxEvents", FOCUSED_CONTEXT_MAX_LIMITS.maxEvents),
										maxTokens: safeInteger(data, "maxTokens", FOCUSED_CONTEXT_MAX_LIMITS.maxTokens),
										maxCharacters: safeInteger(
											data,
											"maxCharacters",
											FOCUSED_CONTEXT_MAX_LIMITS.maxCharacters,
										),
									},
								)
							: service.getFocusedContext(resolvedChallengeId, safeInteger(data, "afterSequence", 0), {
									maxFacts: safeInteger(data, "maxFacts", FOCUSED_CONTEXT_MAX_LIMITS.maxFacts),
									maxHints: safeInteger(data, "maxHints", FOCUSED_CONTEXT_MAX_LIMITS.maxHints),
									maxIntents: safeInteger(data, "maxIntents", FOCUSED_CONTEXT_MAX_LIMITS.maxIntents),
									maxEvents: safeInteger(data, "maxEvents", FOCUSED_CONTEXT_MAX_LIMITS.maxEvents),
									maxTokens: safeInteger(data, "maxTokens", FOCUSED_CONTEXT_MAX_LIMITS.maxTokens),
									maxCharacters: safeInteger(data, "maxCharacters", FOCUSED_CONTEXT_MAX_LIMITS.maxCharacters),
								}),
					};
				case "graph_get_delta":
					exact(data, ["challengeId", "afterSequence"]);
					return {
						handled: true,
						data: service.getGraphDelta(resolvedChallengeId, safeInteger(data, "afterSequence", 0)),
					};
				case "fact_propose":
					exact(data, [
						"challengeId",
						"createdAt",
						"kind",
						"statement",
						"confidence",
						"evidenceRefs",
						"sourceEventIds",
					]);
					return {
						handled: true,
						data: service.proposeFact({
							...commandBase(context),
							kind: text(data, "kind") as Parameters<GraphService["proposeFact"]>[0]["kind"],
							statement: text(data, "statement") as string,
							confidence: number(data, "confidence"),
							evidenceRefs: strings(data, "evidenceRefs"),
							sourceEventIds: strings(data, "sourceEventIds"),
						}),
					};
				case "fact_append_evidence":
					exact(data, ["challengeId", "createdAt", "factId", "evidenceRef"]);
					return {
						handled: true,
						data: service.appendFactEvidence({
							...commandBase(context),
							factId: text(data, "factId") as string,
							evidenceRef: text(data, "evidenceRef") as string,
						}),
					};
				case "intent_propose":
					exact(data, [
						"challengeId",
						"createdAt",
						"objective",
						"scope",
						"confidence",
						"fromFactIds",
						"sourceHintIds",
						"capabilityTags",
						"sourceEventIds",
					]);
					return {
						handled: true,
						data: service.proposeIntent({
							...commandBase(context),
							objective: text(data, "objective") as string,
							scope: text(data, "scope") as string,
							confidence: number(data, "confidence"),
							fromFactIds: strings(data, "fromFactIds"),
							sourceHintIds: strings(data, "sourceHintIds"),
							capabilityTags: strings(data, "capabilityTags"),
							sourceEventIds: strings(data, "sourceEventIds"),
						}),
					};
				case "artifact_register":
					exact(data, ["challengeId", "createdAt", "relativePath", "sha256", "size", "mimeType", "intentId"]);
					if (!context.getSolverWorkspacePath) {
						throw new GraphServiceError("internal", "Host did not provide a Solver workspace");
					}
					if (
						context.intentSession &&
						data.intentId !== undefined &&
						data.intentId !== context.intentSession.intentId
					) {
						throw new GraphServiceError("forbidden", "artifact intentId does not match current Intent session");
					}
					return {
						handled: true,
						data: await service.registerArtifact({
							...commandBase(context),
							relativePath: text(data, "relativePath") as string,
							solverWorkspacePath: context.getSolverWorkspacePath(),
							sha256: text(data, "sha256") as string,
							size: safeInteger(data, "size", -1),
							mimeType: text(data, "mimeType") as string,
							intentId: context.intentSession?.intentId ?? text(data, "intentId", true),
						}),
					};
				case "intent_acknowledge": {
					exact(data, []);
					const current = context.getIntentLeaseBinding?.();
					const result = service.acknowledgeIntent(leaseInput(context));
					context.updateIntentLeaseBinding?.({ ...current!, ...result });
					return { handled: true, data: result };
				}
				case "intent_checkpoint": {
					exact(data, ["facts", "factIds", "artifactIds"]);
					const current = context.getIntentLeaseBinding?.();
					const result = service.checkpointIntent({
						...leaseInput(context),
						facts: resultFacts(data),
						factIds: strings(data, "factIds"),
						artifactIds: strings(data, "artifactIds"),
					});
					context.updateIntentLeaseBinding?.({ ...current!, version: result.version });
					return { handled: true, data: result };
				}
				case "intent_conclude": {
					exact(data, ["outcome", "facts", "factIds", "artifactIds"]);
					const result = service.concludeIntent({
						...leaseInput(context),
						outcome: text(data, "outcome") as Parameters<GraphService["concludeIntent"]>[0]["outcome"],
						facts: resultFacts(data),
						factIds: strings(data, "factIds"),
						artifactIds: strings(data, "artifactIds"),
					});
					context.stopIntentLease?.();
					context.finishIntentSession?.(true);
					return { handled: true, data: result };
				}
				case "intent_release": {
					exact(data, []);
					const result = service.releaseIntent(leaseInput(context));
					context.stopIntentLease?.();
					context.finishIntentSession?.(false);
					return { handled: true, data: result };
				}
			}
			return { handled: false };
		},
	};
}
