/** Regression tests ported from CairnPilot b015733 (Apache-2.0). */
import { afterEach, describe, expect, test, vi } from "vitest";

const mock = vi.fn;

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync as Database } from "node:sqlite";
import { GraphReasoner } from "../src/planning/cairn/reasoner.ts";
import { GraphService, type PersistReasonProposalInput } from "../src/planning/cairn/service.ts";
import { GraphStore } from "../src/planning/cairn/store.ts";
import type {
	GraphActor,
	GraphFact,
	GraphIntent,
	ReasonModel,
	ReasonModelOutput,
	ReasonProposal,
} from "../src/planning/cairn/types.ts";

const timestamp = "2026-06-17T00:00:00.000Z";
const directories: string[] = [];

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "cairnpilot-proposal-apply-"));
	directories.push(directory);
	const path = join(directory, "graph.db");
	const store = new GraphStore(path);
	store.initialize();
	const service = new GraphService(store, {
		reasonerEnabled: true,
		leaseTokenSecret: "external-test-secret",
		clock: { now: () => new Date(timestamp) },
	});
	const actor: GraphActor = { id: "host", role: "host", challengeId: "challenge-a" };
	return { directory, path, store, service, actor };
}

function proposalOutput(
	overrides: Partial<
		Pick<PersistReasonProposalInput, "rationaleSummary" | "proposedIntents" | "supersedeRecommendations">
	> = {},
) {
	return {
		rationaleSummary: "Create one focused route.",
		proposedIntents: [
			{
				clientId: "route-a",
				objective: "Enumerate the upload endpoint",
				successCriteria: ["Identify upload validation behavior"],
				rationale: "Upload is the next narrow path.",
				fromFactIds: [],
				sourceHintIds: [],
				capabilityTags: ["web"],
				priority: 5,
				supersedesIntentIds: [],
			},
		],
		supersedeRecommendations: [],
		...overrides,
	};
}

function modelOutput(text = JSON.stringify(proposalOutput())): ReasonModelOutput {
	return { text, model: "fake-model", provider: "fake-provider" };
}

function activeFact(service: GraphService, actor: GraphActor, suffix: string): GraphFact {
	const candidate = service.proposeFact({
		actor,
		idempotencyKey: `fact-propose-${suffix}`,
		createdAt: timestamp,
		kind: "fact",
		statement: `fact ${suffix}`,
		confidence: 1,
	});
	return service.confirmFact({
		actor,
		idempotencyKey: `fact-confirm-${suffix}`,
		createdAt: timestamp,
		candidateId: candidate.id,
	});
}

function openIntent(service: GraphService, actor: GraphActor, suffix: string): GraphIntent {
	const candidate = service.proposeIntent({
		actor,
		idempotencyKey: `intent-propose-${suffix}`,
		createdAt: timestamp,
		objective: `existing route ${suffix}`,
		scope: "existing proof",
		confidence: 1,
	});
	return service.confirmIntent({
		actor,
		idempotencyKey: `intent-confirm-${suffix}`,
		createdAt: timestamp,
		candidateId: candidate.id,
	});
}

function createProposal(service: GraphService, actor: GraphActor, data = proposalOutput()): ReasonProposal {
	service.ensureReasonTriggerForChallenge(actor.challengeId);
	const lease = service.acquireReasonLease({
		actor,
		idempotencyKey: `proposal-lease-${data.rationaleSummary}`,
		createdAt: timestamp,
		ownerId: "host",
		leaseDurationMs: 120_000,
	});
	const triggers = service.claimReasonTriggers({
		actor,
		idempotencyKey: `proposal-claim-${data.rationaleSummary}`,
		createdAt: timestamp,
		ownerId: lease.ownerId,
		generation: lease.generation,
		token: lease.token,
	});
	const context = service.getReasonContext({
		actor,
		ownerId: lease.ownerId,
		generation: lease.generation,
		token: lease.token,
		triggerIds: triggers.map((trigger) => trigger.id),
	});
	const proposal = service.createReasonProposal({
		actor,
		idempotencyKey: `proposal-create-${data.rationaleSummary}`,
		createdAt: timestamp,
		ownerId: lease.ownerId,
		generation: lease.generation,
		token: lease.token,
		sourceTriggerIds: triggers.map((trigger) => trigger.id),
		baseEventSequence: context.context.baseEventSequence,
		contextFingerprint: context.fingerprint,
		model: "fake-model",
		provider: "fake-provider",
		promptVersion: "reason-v1",
		...data,
	});
	service.releaseReasonLease({
		actor,
		idempotencyKey: `proposal-release-${data.rationaleSummary}`,
		createdAt: timestamp,
		ownerId: lease.ownerId,
		generation: lease.generation,
		token: lease.token,
	});
	return proposal;
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })),
	);
});

describe("Reason Proposal Apply", () => {
	test("does not recreate successful work with identical inputs, but allows fresh supported inputs", async () => {
		const { store, service, actor } = await setup();
		try {
			const first = createProposal(service, actor);
			const applied = service.applyReasonProposal({
				actor,
				idempotencyKey: "initial",
				createdAt: timestamp,
				proposalId: first.id,
			});
			store.updateIntentLeaseState({
				challengeId: actor.challengeId,
				intentId: applied.createdIntentIds[0],
				expectedVersion: 1,
				status: "concluded",
				outcome: "success",
				updatedAt: timestamp,
			});
			const duplicate = createProposal(service, actor, proposalOutput({ rationaleSummary: "same work" }));
			const skipped = service.applyReasonProposal({
				actor,
				idempotencyKey: "duplicate",
				createdAt: timestamp,
				proposalId: duplicate.id,
			});
			expect(skipped.createdIntentIds).toHaveLength(0);
			expect(skipped.skippedIntents[0].reason).toBe("duplicate_completed_intent");
			const input = activeFact(service, actor, "fresh-input");
			const fresh = createProposal(
				service,
				actor,
				proposalOutput({
					rationaleSummary: "fresh supported input",
					proposedIntents: [{ ...proposalOutput().proposedIntents[0], fromFactIds: [input.id] }],
				}),
			);
			expect(
				service.applyReasonProposal({ actor, idempotencyKey: "fresh", createdAt: timestamp, proposalId: fresh.id })
					.createdIntentIds,
			).toHaveLength(1);
		} finally {
			store.close();
		}
	});
	test("applies a legal Proposal into an open Intent without Claims or Fact/Hint mutation and restores the result after reopen", async () => {
		const { path, store, service, actor } = await setup();
		const fact = activeFact(service, actor, "a");
		const hint = service.addHint({ actor, idempotencyKey: "hint-a", createdAt: timestamp, content: "Try uploads" });
		const proposal = createProposal(
			service,
			actor,
			proposalOutput({
				proposedIntents: [
					{ ...proposalOutput().proposedIntents[0], fromFactIds: [fact.id], sourceHintIds: [hint.id] },
				],
			}),
		);
		const result = service.applyReasonProposal({
			actor,
			idempotencyKey: "apply-a",
			createdAt: timestamp,
			proposalId: proposal.id,
		});

		expect(result.status).toBe("applied");
		expect(result.createdIntentIds).toHaveLength(1);
		expect(store.readClaims("challenge-a")).toEqual([]);
		expect(service.getFocusedContext("challenge-a", 0).facts.find((item) => item.id === fact.id)?.status).toBe(
			"active",
		);
		expect(service.readReasonProposal("challenge-a", proposal.id)?.status).toBe("applied");
		const intent = service
			.getFocusedContext("challenge-a", 0)
			.intents.find((item) => item.id === result.createdIntentIds[0]);
		expect(intent).toMatchObject({ status: "open", ownerSolverId: undefined, resultFactIds: [] });
		store.close();

		const reopened = new GraphStore(path);
		reopened.initialize();
		reopened.initialize();
		expect(reopened.readReasonProposalApplication("challenge-a", proposal.id)).toEqual(result);
		const reopenedService = new GraphService(reopened, {
			reasonerEnabled: true,
			leaseTokenSecret: "external-test-secret",
			clock: { now: () => new Date(timestamp) },
		});
		expect(
			reopenedService.applyReasonProposal({
				actor,
				idempotencyKey: "apply-a",
				createdAt: timestamp,
				proposalId: proposal.id,
			}),
		).toEqual(result);
		expect(
			reopened
				.readEventsAfter("challenge-a", 0)
				.filter((event) => event.type === "reason_proposal_applied" && event.entityId === proposal.id),
		).toHaveLength(1);
		reopened.close();

		const database = new Database(path);
		expect(
			database
				.prepare("SELECT COUNT(*) AS count FROM reason_proposal_applications WHERE proposal_id = ?")
				.get(proposal.id),
		).toEqual({ count: 1 });
		expect(
			database
				.prepare("SELECT COUNT(*) AS count FROM reason_proposal_intent_results WHERE proposal_id = ?")
				.get(proposal.id),
		).toEqual({ count: 1 });
		expect(() =>
			database
				.prepare("UPDATE reason_proposal_applications SET actor_id = 'other' WHERE proposal_id = ?")
				.run(proposal.id),
		).toThrow("application is immutable");
		expect(() =>
			database.prepare("DELETE FROM reason_proposal_intent_results WHERE proposal_id = ?").run(proposal.id),
		).toThrow("application is immutable");
		database.close();
	});

	test("replays Apply idempotently, conflicts on same key with another payload, and rejects rejected Proposals", async () => {
		const { service, actor, store } = await setup();
		const proposal = createProposal(service, actor);
		const first = service.applyReasonProposal({
			actor,
			idempotencyKey: "apply-replay",
			createdAt: timestamp,
			proposalId: proposal.id,
		});
		expect(
			service.applyReasonProposal({
				actor,
				idempotencyKey: "apply-replay",
				createdAt: timestamp,
				proposalId: proposal.id,
			}),
		).toEqual(first);
		expect(() =>
			service.applyReasonProposal({
				actor,
				idempotencyKey: "apply-replay",
				createdAt: timestamp,
				proposalId: "other-proposal",
			}),
		).toThrow("idempotency key conflict");
		store.close();

		const rejectedSetup = await setup();
		const rejected = createRejectedProposal(rejectedSetup.service, rejectedSetup.actor);
		expect(() =>
			rejectedSetup.service.applyReasonProposal({
				actor: rejectedSetup.actor,
				idempotencyKey: "apply-rejected",
				createdAt: timestamp,
				proposalId: rejected.id,
			}),
		).toThrow("rejected Reason Proposal cannot be applied");
		expect(
			rejectedSetup.store.readReasonProposalApplication(rejectedSetup.actor.challengeId, rejected.id),
		).toBeUndefined();
		expect(rejectedSetup.service.readReasonProposal(rejectedSetup.actor.challengeId, rejected.id)?.status).toBe(
			"rejected",
		);
		rejectedSetup.store.close();
	});

	test("allows only the Host to Apply and leaves no partial audit or graph writes on rejection", async () => {
		const { service, actor, store } = await setup();
		const proposal = createProposal(service, actor);
		const eventsBefore = store.readEventsAfter(actor.challengeId, 0);

		expect(() =>
			service.applyReasonProposal({
				actor: { id: "solver-a", role: "solver", challengeId: actor.challengeId },
				idempotencyKey: "apply-as-solver",
				createdAt: timestamp,
				proposalId: proposal.id,
			}),
		).toThrow("requires a host actor");
		expect(store.readReasonProposalApplication(actor.challengeId, proposal.id)).toBeUndefined();
		expect(service.readReasonProposal(actor.challengeId, proposal.id)?.status).toBe("proposed");
		expect(service.getFocusedContext(actor.challengeId, 0).intents).toEqual([]);
		expect(store.readEventsAfter(actor.challengeId, 0)).toEqual(eventsBefore);
		const hostResult = service.applyReasonProposal({
			actor,
			idempotencyKey: "apply-as-solver",
			createdAt: timestamp,
			proposalId: proposal.id,
		});
		expect(hostResult.status).toBe("applied");
		store.close();
	});

	test("records stale rejection for completed Challenges and invalidated Fact references", async () => {
		for (const mode of ["completed", "invalidated"] as const) {
			const { service, actor, store } = await setup();
			const fact = activeFact(service, actor, mode);
			const proposal = createProposal(
				service,
				actor,
				proposalOutput({
					rationaleSummary: `stale ${mode}`,
					proposedIntents: [{ ...proposalOutput().proposedIntents[0], fromFactIds: [fact.id] }],
				}),
			);
			if (mode === "completed") {
				service.cancelActiveIntents(actor.challengeId);
			} else {
				const replacement = activeFact(service, actor, `${mode}-replacement`);
				service.invalidateFact({
					actor,
					idempotencyKey: `invalidate-${mode}`,
					createdAt: timestamp,
					factId: fact.id,
					replacementFactId: replacement.id,
				});
			}
			const result = service.applyReasonProposal({
				actor,
				idempotencyKey: `apply-${mode}`,
				createdAt: timestamp,
				proposalId: proposal.id,
			});
			expect(result.status).toBe("rejected_stale");
			expect(result.createdIntentIds).toEqual([]);
			expect(service.readReasonProposal(actor.challengeId, proposal.id)?.status).toBe("proposed");
			expect(store.readReasonProposalApplication(actor.challengeId, proposal.id)).toEqual(result);
			expect(
				store
					.readEventsAfter(actor.challengeId, 0)
					.filter((event) => event.type === "reason_proposal_apply_rejected" && event.entityId === proposal.id),
			).toHaveLength(1);
			store.close();
		}
	});

	test("rejects Apply when a referenced Hint disappears and blocks manual applied status updates", async () => {
		const { path, service, actor, store } = await setup();
		const hint = service.addHint({
			actor,
			idempotencyKey: "hint-missing",
			createdAt: timestamp,
			content: "Try upload",
		});
		const proposal = createProposal(
			service,
			actor,
			proposalOutput({
				rationaleSummary: "missing hint",
				proposedIntents: [{ ...proposalOutput().proposedIntents[0], sourceHintIds: [hint.id] }],
			}),
		);
		store.close();

		const database = new Database(path);
		database.exec("PRAGMA foreign_keys = ON");
		expect(() =>
			database.prepare("UPDATE reason_proposals SET status = 'applied' WHERE id = ?").run(proposal.id),
		).toThrow("requires an apply record");
		database.prepare("DELETE FROM hints WHERE id = ?").run(hint.id);
		database.close();

		const reopened = new GraphStore(path);
		reopened.initialize();
		const reopenedService = new GraphService(reopened, {
			reasonerEnabled: true,
			leaseTokenSecret: "external-test-secret",
			clock: { now: () => new Date(timestamp) },
		});
		const result = reopenedService.applyReasonProposal({
			actor,
			idempotencyKey: "apply-missing-hint",
			createdAt: timestamp,
			proposalId: proposal.id,
		});
		expect(result.status).toBe("rejected_stale");
		expect(result.staleReasons).toContain(`hint ${hint.id} was not found`);
		reopened.close();
	});

	test("records rejected_stale when a persisted Fact reference resolves only in another Challenge", async () => {
		const { path, service, actor, store } = await setup();
		const localFact = activeFact(service, actor, "local-reference");
		const proposal = createProposal(
			service,
			actor,
			proposalOutput({
				rationaleSummary: "cross-challenge fact reference",
				proposedIntents: [{ ...proposalOutput().proposedIntents[0], fromFactIds: [localFact.id] }],
			}),
		);
		const foreignActor: GraphActor = { id: "host", role: "host", challengeId: "challenge-b" };
		const foreignFact = activeFact(service, foreignActor, "foreign-reference");
		store.close();

		const database = new Database(path);
		database.exec("DROP TRIGGER reason_proposal_fact_refs_immutable_update");
		database
			.prepare("UPDATE reason_proposal_fact_refs SET fact_id = ? WHERE challenge_id = ? AND proposal_id = ?")
			.run(foreignFact.id, actor.challengeId, proposal.id);
		database.close();

		const reopened = new GraphStore(path);
		reopened.initialize();
		const reopenedService = new GraphService(reopened, {
			reasonerEnabled: true,
			leaseTokenSecret: "external-test-secret",
			clock: { now: () => new Date(timestamp) },
		});
		const result = reopenedService.applyReasonProposal({
			actor,
			idempotencyKey: "apply-cross-challenge-reference",
			createdAt: timestamp,
			proposalId: proposal.id,
		});

		expect(result.status).toBe("rejected_stale");
		expect(result.staleReasons).toContain(`fact ${foreignFact.id} was not found`);
		expect(result.createdIntentIds).toEqual([]);
		expect(reopenedService.readReasonProposal(actor.challengeId, proposal.id)?.status).toBe("proposed");
		expect(reopenedService.getFocusedContext(foreignActor.challengeId, 0).facts).toContainEqual(foreignFact);
		reopened.close();
	});

	test("skips duplicate active Intent, returns explicit no-op when all are duplicates, and rejects replacement pointing to skipped duplicate", async () => {
		const { service, actor, store } = await setup();
		const duplicate = proposalOutput().proposedIntents[0];
		service.confirmIntent({
			actor,
			idempotencyKey: "existing-duplicate-confirm",
			createdAt: timestamp,
			candidateId: service.proposeIntent({
				actor,
				idempotencyKey: "existing-duplicate-propose",
				createdAt: timestamp,
				objective: duplicate.objective,
				scope: duplicate.successCriteria.join("\n"),
				confidence: 1,
				capabilityTags: duplicate.capabilityTags,
			}).id,
		});
		activeFact(service, actor, "duplicate-trigger");
		const proposal = createProposal(service, actor, proposalOutput({ rationaleSummary: "duplicate only" }));
		const result = service.applyReasonProposal({
			actor,
			idempotencyKey: "apply-duplicate",
			createdAt: timestamp,
			proposalId: proposal.id,
		});
		expect(result.status).toBe("no_op");
		expect(result.skippedIntents[0]).toMatchObject({ clientId: "route-a", reason: "duplicate_active_intent" });
		expect(store.readReasonProposalApplication(actor.challengeId, proposal.id)).toEqual(result);
		expect(service.readReasonProposal(actor.challengeId, proposal.id)?.status).toBe("applied");
		expect(
			store
				.readEventsAfter(actor.challengeId, 0)
				.filter((event) => event.type === "reason_proposal_applied" && event.entityId === proposal.id),
		).toHaveLength(1);

		const target = openIntent(service, actor, "replace-skipped");
		activeFact(service, actor, "replace-skipped-trigger");
		const stale = createProposal(
			service,
			actor,
			proposalOutput({
				rationaleSummary: "replacement skipped",
				supersedeRecommendations: [
					{ intentId: target.id, rationale: "replace duplicate", replacementClientId: "route-a" },
				],
			}),
		);
		const staleResult = service.applyReasonProposal({
			actor,
			idempotencyKey: "apply-skipped-replacement",
			createdAt: timestamp,
			proposalId: stale.id,
		});
		expect(staleResult.status).toBe("rejected_stale");
		expect(staleResult.staleReasons[0]).toContain("replacementClientId route-a was skipped");
		store.close();
	});

	test("supersedes only open and blocked Intents without mutating graph history, but rejects all other target states", async () => {
		const { path, service, actor, store } = await setup();
		const open = openIntent(service, actor, "open");
		const blocked = openIntent(service, actor, "blocked");
		store.updateIntentLeaseState({
			challengeId: actor.challengeId,
			intentId: blocked.id,
			expectedVersion: blocked.version,
			status: "blocked",
			updatedAt: timestamp,
		});
		const fact = activeFact(service, actor, "supersede-trigger");
		const hint = service.addHint({
			actor,
			idempotencyKey: "hint-supersede-isolation",
			createdAt: timestamp,
			content: "Preserve this hint",
		});
		const factCandidate = service.proposeFact({
			actor,
			idempotencyKey: "fact-candidate-supersede-isolation",
			createdAt: timestamp,
			kind: "fact",
			statement: "preserve this Fact candidate",
			confidence: 0.5,
		});
		const intentCandidate = service.proposeIntent({
			actor,
			idempotencyKey: "intent-candidate-supersede-isolation",
			createdAt: timestamp,
			objective: "preserve this Intent candidate",
			scope: "unrelated",
			confidence: 0.5,
		});
		const claimed = openIntent(service, actor, "unrelated-claimed");
		service.claimIntent({
			actor,
			idempotencyKey: "claim-unrelated-for-supersede-isolation",
			intentId: claimed.id,
			solverId: "solver-unrelated",
			expectedVersion: claimed.version,
			leaseDurationMs: 120_000,
		});
		const contextBefore = service.getFocusedContext(actor.challengeId, 0);
		const factCandidateBefore = store.readFactCandidate(actor.challengeId, factCandidate.id);
		const intentCandidateBefore = store.readIntentCandidate(actor.challengeId, intentCandidate.id);
		const claimsBefore = store.readClaims(actor.challengeId);
		const proposal = createProposal(
			service,
			actor,
			proposalOutput({
				rationaleSummary: "supersede open blocked",
				proposedIntents: [],
				supersedeRecommendations: [
					{ intentId: open.id, rationale: "covered" },
					{ intentId: blocked.id, rationale: "covered" },
				],
			}),
		);
		const result = service.applyReasonProposal({
			actor,
			idempotencyKey: "apply-supersede",
			createdAt: timestamp,
			proposalId: proposal.id,
		});
		expect(result.supersededIntentIds.sort()).toEqual([blocked.id, open.id].sort());
		const contextAfter = service.getFocusedContext(actor.challengeId, 0);
		expect(contextAfter.intents.find((intent) => intent.id === open.id)?.status).toBe("superseded");
		expect(contextAfter.intents.find((intent) => intent.id === blocked.id)?.status).toBe("superseded");
		expect(contextAfter.intents.find((intent) => intent.id === claimed.id)).toMatchObject({
			status: "claimed",
			ownerSolverId: "solver-unrelated",
		});
		expect(contextAfter.facts).toEqual(contextBefore.facts);
		expect(contextAfter.hints).toEqual(contextBefore.hints);
		expect(contextAfter.facts).toContainEqual(fact);
		expect(contextAfter.hints).toContainEqual(hint);
		expect(store.readFactCandidate(actor.challengeId, factCandidate.id)).toEqual(factCandidateBefore);
		expect(store.readIntentCandidate(actor.challengeId, intentCandidate.id)).toEqual(intentCandidateBefore);
		expect(store.readClaims(actor.challengeId)).toEqual(claimsBefore);

		for (const status of ["claimed", "running", "concluded", "cancelled", "superseded"] as const) {
			const { service: scopedService, actor: scopedActor, store: scopedStore } = await setup();
			const target = openIntent(scopedService, scopedActor, status);
			if (status === "claimed" || status === "running") {
				const lease = scopedService.claimIntent({
					actor: scopedActor,
					idempotencyKey: `claim-${status}`,
					intentId: target.id,
					solverId: `solver-${status}`,
					expectedVersion: target.version,
					leaseDurationMs: 120_000,
				});
				if (status === "running") {
					scopedService.acknowledgeIntent({
						actor: { id: lease.solverId, role: "solver", challengeId: scopedActor.challengeId },
						idempotencyKey: `ack-${status}`,
						intentId: target.id,
						token: lease.token,
						generation: lease.generation,
						expectedVersion: lease.version,
					});
				}
			} else {
				scopedStore.updateIntentLeaseState({
					challengeId: scopedActor.challengeId,
					intentId: target.id,
					expectedVersion: target.version,
					status,
					updatedAt: timestamp,
				});
			}
			activeFact(scopedService, scopedActor, `stale-${status}-trigger`);
			const stale = createProposal(
				scopedService,
				scopedActor,
				proposalOutput({
					rationaleSummary: `stale supersede ${status}`,
					proposedIntents: [],
					supersedeRecommendations: [{ intentId: target.id, rationale: "covered" }],
				}),
			);
			const staleResult = scopedService.applyReasonProposal({
				actor: scopedActor,
				idempotencyKey: `apply-stale-${status}`,
				createdAt: timestamp,
				proposalId: stale.id,
			});
			expect(staleResult.status).toBe("rejected_stale");
			scopedStore.close();
		}
		store.close();
		const database = new Database(path, { readOnly: true });
		expect(
			database.prepare("SELECT COUNT(*) AS count FROM graph_solvers WHERE solver_id = ?").get("solver-unrelated"),
		).toEqual({ count: 1 });
		database.close();
	});

	test("rolls back created Intents when application persistence fails", async () => {
		const { service, actor, store } = await setup();
		const proposal = createProposal(service, actor);
		const original = store.markReasonProposalApplied.bind(store);
		store.markReasonProposalApplied = () => {
			throw new Error("apply failed");
		};
		expect(() =>
			service.applyReasonProposal({
				actor,
				idempotencyKey: "apply-rollback",
				createdAt: timestamp,
				proposalId: proposal.id,
			}),
		).toThrow();
		store.markReasonProposalApplied = original;
		expect(service.getFocusedContext(actor.challengeId, 0).intents).toEqual([]);
		expect(service.readReasonProposal(actor.challengeId, proposal.id)?.status).toBe("proposed");
		expect(store.readReasonProposalApplication(actor.challengeId, proposal.id)).toBeUndefined();
		expect(
			store
				.readEventsAfter(actor.challengeId, 0)
				.filter((event) => event.type === "reason_proposal_applied" && event.entityId === proposal.id),
		).toHaveLength(0);
		const retried = service.applyReasonProposal({
			actor,
			idempotencyKey: "apply-rollback",
			createdAt: timestamp,
			proposalId: proposal.id,
		});
		expect(retried.status).toBe("applied");
		expect(retried.createdIntentIds).toHaveLength(1);
		expect(store.readReasonProposalApplication(actor.challengeId, proposal.id)).toEqual(retried);
		store.close();
	});

	test("Reasoner only auto-applies when reasonApplyEnabled is true and never creates Claims", async () => {
		for (const enabled of [false, true]) {
			const { service, actor, store } = await setup();
			service.ensureReasonTriggerForChallenge(actor.challengeId);
			const reasoner = new GraphReasoner({
				service,
				model: { generate: mock(async () => modelOutput()) } as ReasonModel,
				runIdFactory: () => `run-${enabled}`,
				clock: { now: () => new Date(timestamp) },
				reasonApplyEnabled: enabled,
			});
			const result = await reasoner.runOnce(actor.challengeId);
			expect(result.status).toBe("proposed");
			const proposal = service.listReasonProposals(actor.challengeId)[0];
			expect(proposal.status).toBe(enabled ? "applied" : "proposed");
			expect(store.readClaims(actor.challengeId)).toEqual([]);
			store.close();
		}
	});
});

function createRejectedProposal(service: GraphService, actor: GraphActor): ReasonProposal {
	service.ensureReasonTriggerForChallenge(actor.challengeId);
	const lease = service.acquireReasonLease({
		actor,
		idempotencyKey: "rejected-lease",
		createdAt: timestamp,
		ownerId: "host",
		leaseDurationMs: 120_000,
	});
	const triggers = service.claimReasonTriggers({
		actor,
		idempotencyKey: "rejected-claim",
		createdAt: timestamp,
		ownerId: lease.ownerId,
		generation: lease.generation,
		token: lease.token,
	});
	const invalid = proposalOutput({
		rationaleSummary: "rejected",
		proposedIntents: [{ ...proposalOutput().proposedIntents[0], objective: "" }],
	});
	const errors = service.validateReasonProposalDraft(actor.challengeId, invalid);
	const proposal = service.rejectReasonProposal({
		actor,
		idempotencyKey: "rejected-proposal",
		createdAt: timestamp,
		ownerId: lease.ownerId,
		generation: lease.generation,
		token: lease.token,
		sourceTriggerIds: triggers.map((trigger) => trigger.id),
		baseEventSequence: service.getReasonContext({
			actor,
			ownerId: lease.ownerId,
			generation: lease.generation,
			token: lease.token,
			triggerIds: triggers.map((trigger) => trigger.id),
		}).context.baseEventSequence,
		contextFingerprint: "rejected-context",
		model: "fake-model",
		provider: "fake-provider",
		promptVersion: "reason-v1",
		...invalid,
		validationErrors: errors,
	});
	service.releaseReasonLease({
		actor,
		idempotencyKey: "rejected-release",
		createdAt: timestamp,
		ownerId: lease.ownerId,
		generation: lease.generation,
		token: lease.token,
	});
	return proposal;
}
