/** Regression tests ported from CairnPilot b015733 (Apache-2.0). */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { GraphService } from "../src/planning/cairn/service.ts";
import { GraphStore } from "../src/planning/cairn/store.ts";
import type { GraphActor, ReasonLease } from "../src/planning/cairn/types.ts";
import { cairnTestIO } from "./fixtures/cairn-test-io.ts";

const directories: string[] = [];
const baseTime = "2026-06-15T00:00:00.000Z";

async function setup(options: { reasonerEnabled?: boolean; clock?: { now(): Date }; maxReasonAttempts?: number } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "cairnpilot-reason-"));
	directories.push(directory);
	const store = new GraphStore(join(directory, "graph.db"));
	store.initialize();
	const service = new GraphService(store, {
		reasonerEnabled: options.reasonerEnabled ?? true,
		leaseTokenSecret: "external-reason-secret",
		clock: options.clock,
		maxReasonAttempts: options.maxReasonAttempts,
	});
	return { directory, store, service };
}

function host(challengeId = "challenge-a"): GraphActor {
	return { id: "host", role: "host", challengeId };
}

function proposeAndConfirmFact(service: GraphService, suffix: string, challengeId = "challenge-a") {
	const candidate = service.proposeFact({
		actor: { id: "solver-a", role: "solver", challengeId },
		idempotencyKey: `propose-${suffix}`,
		createdAt: baseTime,
		kind: "fact",
		statement: `fact ${suffix}`,
		confidence: 1,
	});
	return service.confirmFact({
		actor: host(challengeId),
		idempotencyKey: `confirm-${suffix}`,
		createdAt: baseTime,
		candidateId: candidate.id,
	});
}

function lease(service: GraphService, suffix = "a", challengeId = "challenge-a"): ReasonLease {
	return service.acquireReasonLease({
		actor: host(challengeId),
		idempotencyKey: `reason-lease-${suffix}`,
		createdAt: baseTime,
		ownerId: `reason-owner-${suffix}`,
		leaseDurationMs: 30_000,
	});
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })),
	);
});

describe("Reason control plane", () => {
	test("production recovery keeps a malformed proposal pending after five trigger attempts", async () => {
		let now = Date.parse(baseTime);
		const { store, service } = await setup({
			clock: { now: () => new Date(now) },
			maxReasonAttempts: Number.MAX_SAFE_INTEGER,
		});
		proposeAndConfirmFact(service, "recover");
		for (let attempt = 1; attempt <= 6; attempt++) {
			const acquired = service.acquireReasonLease({
				actor: host(),
				idempotencyKey: `lease-${attempt}`,
				createdAt: new Date(now).toISOString(),
				ownerId: "owner",
				leaseDurationMs: 120_000,
			});
			const [claimed] = service.claimReasonTriggers({
				actor: host(),
				idempotencyKey: `claim-${attempt}`,
				createdAt: new Date(now).toISOString(),
				ownerId: acquired.ownerId,
				generation: acquired.generation,
				token: acquired.token,
			});
			const result = service.failReasonTriggers({
				actor: host(),
				idempotencyKey: `fail-${attempt}`,
				createdAt: new Date(now).toISOString(),
				ownerId: acquired.ownerId,
				generation: acquired.generation,
				token: acquired.token,
				triggerIds: [claimed.id],
				error: "model output is not valid JSON",
			});
			expect(result.deadLettered).toBe(0);
			service.releaseReasonLease({
				actor: host(),
				idempotencyKey: `release-${attempt}`,
				createdAt: new Date(now).toISOString(),
				ownerId: acquired.ownerId,
				generation: acquired.generation,
				token: acquired.token,
			});
			const trigger = service.readReasonTriggers("challenge-a")[0];
			expect(trigger.status).toBe("pending");
			now = Date.parse(trigger.notBefore) + 1;
		}
		expect(service.readReasonTriggers("challenge-a")[0].attemptCount).toBe(6);
		store.close();
	});
	test("creates deduplicated triggers atomically for formal Fact, invalidation, and Hint writes", async () => {
		const { store, service } = await setup();
		const first = proposeAndConfirmFact(service, "first");
		const replacement = proposeAndConfirmFact(service, "replacement");
		service.invalidateFact({
			actor: host(),
			idempotencyKey: "invalidate",
			createdAt: baseTime,
			factId: first.id,
			replacementFactId: replacement.id,
		});
		service.addHint({
			actor: host(),
			idempotencyKey: "hint",
			createdAt: baseTime,
			content: "inspect the alternate endpoint",
		});
		const reasons = service.readReasonTriggers("challenge-a").map((trigger) => trigger.reason);
		expect(reasons.filter((reason) => reason === "fact_confirmed")).toHaveLength(2);
		expect(reasons).toContain("fact_invalidated");
		expect(reasons).toContain("hint_added");
		expect(
			service.addHint({
				actor: host(),
				idempotencyKey: "hint",
				createdAt: baseTime,
				content: "inspect the alternate endpoint",
			}),
		).toBeDefined();
		expect(
			service.readReasonTriggers("challenge-a").filter((trigger) => trigger.reason === "hint_added"),
		).toHaveLength(1);
		store.close();
	});

	test("rolls back the business transaction when Trigger insertion fails", async () => {
		const { store, service } = await setup();
		const candidate = service.proposeFact({
			actor: { id: "solver-a", role: "solver", challengeId: "challenge-a" },
			idempotencyKey: "rollback-propose",
			createdAt: baseTime,
			kind: "fact",
			statement: "must roll back",
			confidence: 1,
		});
		const original = store.insertReasonTrigger.bind(store);
		store.insertReasonTrigger = () => {
			throw new Error("trigger write failed");
		};
		expect(() =>
			service.confirmFact({
				actor: host(),
				idempotencyKey: "rollback-confirm",
				createdAt: baseTime,
				candidateId: candidate.id,
			}),
		).toThrow("trigger write failed");
		store.insertReasonTrigger = original;
		expect(store.readServiceGraph("challenge-a").facts).toEqual([]);
		expect(store.readFactCandidate("challenge-a", candidate.id)?.status).toBe("proposed");
		store.close();
	});

	test("keeps Reasoner disabled without triggers or control-plane access", async () => {
		const { store, service } = await setup({ reasonerEnabled: false });
		proposeAndConfirmFact(service, "disabled");
		expect(store.readReasonTriggers("challenge-a", 10)).toEqual([]);
		expect(() => lease(service)).toThrow("disabled");
		store.close();
	});

	test("enforces one active Reason Lease, safe replay, heartbeat, expiry, and generation isolation", async () => {
		let now = Date.parse(baseTime);
		const { directory, store, service } = await setup({ clock: { now: () => new Date(now) } });
		proposeAndConfirmFact(service, "lease-recovery");
		const acquired = lease(service);
		expect(
			service.claimReasonTriggers({
				actor: host(),
				idempotencyKey: "lease-recovery-claim",
				createdAt: baseTime,
				ownerId: acquired.ownerId,
				generation: acquired.generation,
				token: acquired.token,
			}),
		).toHaveLength(1);
		expect(lease(service)).toEqual(acquired);
		expect(() => lease(service, "other")).toThrow("active Reason Lease");
		const other = lease(service, "b", "challenge-b");
		expect(other.challengeId).toBe("challenge-b");
		now += 1_000;
		const heartbeat = service.heartbeatReasonLease({
			actor: host(),
			idempotencyKey: "reason-heartbeat",
			createdAt: baseTime,
			ownerId: acquired.ownerId,
			generation: acquired.generation,
			token: acquired.token,
			leaseDurationMs: 30_000,
		});
		expect(Date.parse(heartbeat.leaseUntil)).toBeGreaterThan(Date.parse(acquired.leaseUntil));
		now = Date.parse(heartbeat.leaseUntil) + 1;
		expect(() =>
			service.heartbeatReasonLease({
				actor: host(),
				idempotencyKey: "late-heartbeat",
				createdAt: baseTime,
				ownerId: acquired.ownerId,
				generation: acquired.generation,
				token: acquired.token,
				leaseDurationMs: 30_000,
			}),
		).toThrow("expired");
		expect(service.expireReasonLeases()).toEqual({ expired: 2, recovered: 1 });
		expect(service.readReasonTriggers("challenge-a")[0].status).toBe("pending");
		const renewed = lease(service, "renewed");
		expect(renewed.generation).toBe(acquired.generation + 1);
		expect(() =>
			service.releaseReasonLease({
				actor: host(),
				idempotencyKey: "stale-release",
				createdAt: baseTime,
				ownerId: acquired.ownerId,
				generation: acquired.generation,
				token: acquired.token,
			}),
		).toThrow();
		store.close();
		const bytes = Buffer.from(await cairnTestIO.file(join(directory, "graph.db")).arrayBuffer());
		expect(bytes.includes(Buffer.from(acquired.token))).toBe(false);
	});

	test("restores pending Triggers and the active Reason Lease after reopening", async () => {
		const { directory, store, service } = await setup();
		proposeAndConfirmFact(service, "reopen");
		const acquired = lease(service, "reopen");
		store.close();

		const reopened = new GraphStore(join(directory, "graph.db"));
		reopened.initialize();
		expect(reopened.readReasonTriggers("challenge-a", 10)).toHaveLength(1);
		expect(reopened.readActiveReasonLease("challenge-a")).toMatchObject({
			ownerId: acquired.ownerId,
			generation: acquired.generation,
			status: "active",
		});
		reopened.close();
	});

	test("releases claimed work atomically and lets the next generation reclaim it", async () => {
		const { store, service } = await setup();
		proposeAndConfirmFact(service, "release");
		const acquired = lease(service, "release");
		const [claimed] = service.claimReasonTriggers({
			actor: host(),
			idempotencyKey: "release-claim",
			createdAt: baseTime,
			ownerId: acquired.ownerId,
			generation: acquired.generation,
			token: acquired.token,
		});
		const sourceSequence = store.readReasonTrigger("challenge-a", claimed.id)!.sourceEventSequence;
		store.executeServiceTransaction(() => {
			store.insertReasonTrigger({
				id: "other-generation-processing",
				challengeId: "challenge-a",
				reason: "hint_added",
				sourceEventSequence: sourceSequence,
				sourceEntityId: "other-generation",
				payloadFingerprint: "other-generation",
				status: "processing",
				attemptCount: 2,
				notBefore: baseTime,
				leaseGeneration: acquired.generation + 100,
				createdAt: baseTime,
				updatedAt: baseTime,
			});
		});
		const releaseInput = {
			actor: host(),
			idempotencyKey: "release-active",
			createdAt: baseTime,
			ownerId: acquired.ownerId,
			generation: acquired.generation,
			token: acquired.token,
		};
		const expected = { released: true as const, generation: acquired.generation, recovered: 1 };
		expect(service.releaseReasonLease(releaseInput)).toEqual(expected);
		expect(service.releaseReasonLease(releaseInput)).toEqual(expected);
		expect(store.readReasonTrigger("challenge-a", claimed.id)).toMatchObject({
			status: "pending",
			attemptCount: 0,
			leaseGeneration: undefined,
		});
		expect(store.readReasonTrigger("challenge-a", "other-generation-processing")).toMatchObject({
			status: "processing",
			attemptCount: 2,
			leaseGeneration: acquired.generation + 100,
		});
		const renewed = lease(service, "release-renewed");
		expect(renewed.generation).toBe(acquired.generation + 1);
		expect(
			service
				.claimReasonTriggers({
					actor: host(),
					idempotencyKey: "release-reclaim",
					createdAt: baseTime,
					ownerId: renewed.ownerId,
					generation: renewed.generation,
					token: renewed.token,
				})
				.map((trigger) => trigger.id),
		).toEqual([claimed.id]);
		store.close();
	});

	test("release isolation and rollback preserve other Challenges and processing work", async () => {
		const { store, service } = await setup();
		proposeAndConfirmFact(service, "release-a", "challenge-a");
		proposeAndConfirmFact(service, "release-b", "challenge-b");
		const leaseA = lease(service, "release-a", "challenge-a");
		const leaseB = lease(service, "release-b", "challenge-b");
		const [triggerA] = service.claimReasonTriggers({
			actor: host("challenge-a"),
			idempotencyKey: "claim-release-a",
			createdAt: baseTime,
			ownerId: leaseA.ownerId,
			generation: leaseA.generation,
			token: leaseA.token,
		});
		const [triggerB] = service.claimReasonTriggers({
			actor: host("challenge-b"),
			idempotencyKey: "claim-release-b",
			createdAt: baseTime,
			ownerId: leaseB.ownerId,
			generation: leaseB.generation,
			token: leaseB.token,
		});
		const original = store.updateActiveReasonLease.bind(store);
		store.updateActiveReasonLease = () => {
			throw new Error("release write failed");
		};
		expect(() =>
			service.releaseReasonLease({
				actor: host("challenge-a"),
				idempotencyKey: "release-rollback",
				createdAt: baseTime,
				ownerId: leaseA.ownerId,
				generation: leaseA.generation,
				token: leaseA.token,
			}),
		).toThrow("release write failed");
		store.updateActiveReasonLease = original;
		expect(store.readReasonTrigger("challenge-a", triggerA.id)).toMatchObject({
			status: "processing",
			leaseGeneration: leaseA.generation,
		});
		expect(store.readActiveReasonLease("challenge-a")?.generation).toBe(leaseA.generation);
		expect(store.readReasonTrigger("challenge-b", triggerB.id)).toMatchObject({
			status: "processing",
			leaseGeneration: leaseB.generation,
		});
		store.close();
	});

	test("claims in deterministic bounded order and completes only with the current generation", async () => {
		const { store, service } = await setup();
		proposeAndConfirmFact(service, "one");
		service.addHint({ actor: host(), idempotencyKey: "ordered-hint", createdAt: baseTime, content: "ordered" });
		const acquired = lease(service);
		const input = {
			actor: host(),
			idempotencyKey: "claim-triggers",
			createdAt: baseTime,
			ownerId: acquired.ownerId,
			generation: acquired.generation,
			token: acquired.token,
			limit: 1,
		};
		const claimed = service.claimReasonTriggers(input);
		expect(claimed).toHaveLength(1);
		expect(claimed[0].reason).toBe("fact_confirmed");
		expect(service.claimReasonTriggers(input)).toEqual(claimed);
		expect(claimed[0].status).toBe("processing");
		expect(
			service.completeReasonTriggers({
				...input,
				idempotencyKey: "complete-triggers",
				triggerIds: [claimed[0].id],
			}),
		).toEqual({ completed: 1 });
		expect(service.claimReasonTriggers({ ...input, idempotencyKey: "claim-next" })).toHaveLength(1);
		expect(() =>
			service.completeReasonTriggers({
				...input,
				idempotencyKey: "old-generation",
				generation: acquired.generation + 1,
				triggerIds: [claimed[0].id],
			}),
		).toThrow();
		store.close();
	});

	test("rejects cross-Challenge Trigger source events and concurrent duplicate Lease acquisition", async () => {
		const { store, service } = await setup();
		const fact = proposeAndConfirmFact(service, "cross", "challenge-a");
		const source = store.readEventsAfter("challenge-a", 0).find((event) => event.type === "fact_confirmed")!;
		expect(() =>
			store.executeServiceTransaction(() =>
				store.insertReasonTrigger({
					id: "foreign-trigger",
					challengeId: "challenge-b",
					reason: "fact_confirmed",
					sourceEventSequence: source.sequence,
					sourceEntityId: fact.id,
					payloadFingerprint: "foreign",
					status: "pending",
					attemptCount: 0,
					notBefore: baseTime,
					createdAt: baseTime,
					updatedAt: baseTime,
				}),
			),
		).toThrow("another challenge");

		const results = await Promise.allSettled([
			Promise.resolve().then(() => lease(service, "concurrent-a", "challenge-c")),
			Promise.resolve().then(() => lease(service, "concurrent-b", "challenge-c")),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		store.close();
	});

	test("completes and fails exact processing Triggers beyond 256 historical rows", async () => {
		const { store, service } = await setup();
		store.executeServiceTransaction(() => {
			store.ensureServiceChallenge("challenge-a");
			const sequence = store.appendServiceEvent({
				challengeId: "challenge-a",
				type: "reason-history-fixture",
				entityId: "challenge-a",
				actorId: "host",
				idempotencyKey: "reason-history-fixture",
				payload: {},
				createdAt: baseTime,
			});
			for (let index = 0; index < 256; index += 1) {
				store.insertReasonTrigger({
					id: `completed-${index.toString().padStart(3, "0")}`,
					challengeId: "challenge-a",
					reason: "fact_confirmed",
					sourceEventSequence: sequence,
					sourceEntityId: `completed-entity-${index}`,
					payloadFingerprint: `completed-payload-${index}`,
					status: "completed",
					attemptCount: 0,
					notBefore: baseTime,
					leaseGeneration: 1,
					createdAt: baseTime,
					updatedAt: baseTime,
					completedAt: baseTime,
				});
			}
		});
		const acquired = lease(service, "history");
		store.executeServiceTransaction(() => {
			const sequence = store.appendServiceEvent({
				challengeId: "challenge-a",
				type: "reason-current-fixture",
				entityId: "challenge-a",
				actorId: "host",
				idempotencyKey: "reason-current-fixture",
				payload: {},
				createdAt: baseTime,
			});
			for (const id of ["processing-fail", "processing-complete"]) {
				store.insertReasonTrigger({
					id,
					challengeId: "challenge-a",
					reason: "hint_added",
					sourceEventSequence: sequence,
					sourceEntityId: id,
					payloadFingerprint: `${id}-payload`,
					status: "processing",
					attemptCount: 0,
					notBefore: baseTime,
					leaseGeneration: acquired.generation,
					createdAt: baseTime,
					updatedAt: baseTime,
				});
			}
		});
		expect(
			service.failReasonTriggers({
				actor: host(),
				idempotencyKey: "fail-after-256",
				createdAt: baseTime,
				ownerId: acquired.ownerId,
				generation: acquired.generation,
				token: acquired.token,
				triggerIds: ["processing-fail"],
				error: "retry",
			}),
		).toEqual({ retried: 1, deadLettered: 0 });
		expect(
			service.completeReasonTriggers({
				actor: host(),
				idempotencyKey: "complete-after-256",
				createdAt: baseTime,
				ownerId: acquired.ownerId,
				generation: acquired.generation,
				token: acquired.token,
				triggerIds: ["processing-complete"],
			}),
		).toEqual({ completed: 1 });
		store.close();
	});

	test("prevalidates complete and fail batches before any Trigger update", async () => {
		const { store, service } = await setup();
		proposeAndConfirmFact(service, "batch-a", "challenge-a");
		proposeAndConfirmFact(service, "batch-b", "challenge-b");
		const acquired = lease(service, "batch", "challenge-a");
		const [processing] = service.claimReasonTriggers({
			actor: host(),
			idempotencyKey: "batch-claim",
			createdAt: baseTime,
			ownerId: acquired.ownerId,
			generation: acquired.generation,
			token: acquired.token,
		});
		const foreign = store.readReasonTriggers("challenge-b", 1)[0];
		const common = {
			actor: host(),
			createdAt: baseTime,
			ownerId: acquired.ownerId,
			generation: acquired.generation,
			token: acquired.token,
		};
		expect(() =>
			service.completeReasonTriggers({
				...common,
				idempotencyKey: "batch-invalid-complete",
				triggerIds: [processing.id, "missing-trigger"],
			}),
		).toThrow("generation or status conflict");
		expect(store.readReasonTrigger("challenge-a", processing.id)?.status).toBe("processing");
		expect(() =>
			service.failReasonTriggers({
				...common,
				idempotencyKey: "batch-cross-challenge",
				triggerIds: [processing.id, foreign.id],
				error: "retry",
			}),
		).toThrow("generation or status conflict");
		expect(store.readReasonTrigger("challenge-a", processing.id)?.status).toBe("processing");
		expect(() =>
			service.failReasonTriggers({
				...common,
				idempotencyKey: "batch-wrong-generation",
				generation: acquired.generation + 1,
				triggerIds: [processing.id],
				error: "retry",
			}),
		).toThrow();
		expect(store.readReasonTrigger("challenge-a", processing.id)?.status).toBe("processing");
		store.close();
	});

	test("creates one no_active_intents trigger for the final atomic Conclude transaction", async () => {
		const { store, service } = await setup();
		const candidate = service.proposeIntent({
			actor: { id: "solver-a", role: "solver", challengeId: "challenge-a" },
			idempotencyKey: "conclude-candidate",
			createdAt: baseTime,
			objective: "finish route",
			scope: "web",
			confidence: 1,
		});
		const intent = service.confirmIntent({
			actor: host(),
			idempotencyKey: "conclude-confirm",
			createdAt: baseTime,
			candidateId: candidate.id,
		});
		const intentLease = service.claimIntent({
			actor: host(),
			idempotencyKey: "conclude-claim",
			intentId: intent.id,
			solverId: "solver-a",
			expectedVersion: intent.version,
			leaseDurationMs: 30_000,
		});
		const running = service.acknowledgeIntent({
			actor: { id: "solver-a", role: "solver", challengeId: "challenge-a" },
			idempotencyKey: "conclude-ack",
			intentId: intent.id,
			token: intentLease.token,
			generation: intentLease.generation,
			expectedVersion: intentLease.version,
		});
		const checkpoint = service.checkpointIntent({
			actor: { id: "solver-a", role: "solver", challengeId: "challenge-a" },
			idempotencyKey: "live-checkpoint",
			intentId: intent.id,
			token: intentLease.token,
			generation: intentLease.generation,
			expectedVersion: running.version,
			facts: [{ kind: "evidence", statement: "Synthetic live observation", evidenceRefs: ["local-evidence"] }],
		});
		const liveTriggers = service
			.readReasonTriggers("challenge-a")
			.filter((trigger) => trigger.reason === "fact_confirmed");
		expect(liveTriggers).toHaveLength(1);
		expect(store.readServiceGraph("challenge-a").intents[0].status).toBe("running");
		const duplicate = service.checkpointIntent({
			actor: { id: "solver-a", role: "solver", challengeId: "challenge-a" },
			idempotencyKey: "repeat-live-checkpoint",
			intentId: intent.id,
			token: intentLease.token,
			generation: intentLease.generation,
			expectedVersion: checkpoint.version,
			factIds: checkpoint.resultFactIds,
		});
		expect(
			service.readReasonTriggers("challenge-a").filter((trigger) => trigger.reason === "fact_confirmed"),
		).toHaveLength(1);
		service.concludeIntent({
			actor: { id: "solver-a", role: "solver", challengeId: "challenge-a" },
			idempotencyKey: "conclude",
			intentId: intent.id,
			token: intentLease.token,
			generation: intentLease.generation,
			expectedVersion: duplicate.version,
			outcome: "success",
		});
		const reasons = service.readReasonTriggers("challenge-a").map((trigger) => trigger.reason);
		expect(reasons).not.toContain("intent_concluded");
		expect(reasons).toContain("no_active_intents");
		store.close();
	});

	test("retries with deterministic backoff and dead-letters at the fixed attempt limit", async () => {
		let now = Date.parse(baseTime);
		const { store, service } = await setup({ clock: { now: () => new Date(now) } });
		proposeAndConfirmFact(service, "retry");
		const acquired = lease(service);
		for (let attempt = 1; attempt <= 5; attempt += 1) {
			const [claimed] = service.claimReasonTriggers({
				actor: host(),
				idempotencyKey: `claim-${attempt}`,
				createdAt: baseTime,
				ownerId: acquired.ownerId,
				generation: acquired.generation,
				token: acquired.token,
			});
			const result = service.failReasonTriggers({
				actor: host(),
				idempotencyKey: `fail-${attempt}`,
				createdAt: baseTime,
				ownerId: acquired.ownerId,
				generation: acquired.generation,
				token: acquired.token,
				triggerIds: [claimed.id],
				error: `authorization=secret-${"x".repeat(40)}`,
			});
			expect(result.deadLettered).toBe(attempt === 5 ? 1 : 0);
			const current = service.readReasonTriggers("challenge-a")[0];
			expect(current.lastError).not.toContain("secret");
			now = Date.parse(current.notBefore) + 1;
		}
		expect(service.readReasonTriggers("challenge-a")[0]).toMatchObject({ status: "dead_letter", attemptCount: 5 });
		store.close();
	});

	test("creates initial_reason once and no_active_intents after Intent history, but never for completed Challenges", async () => {
		const { store, service } = await setup();
		expect(service.ensureReasonTriggerForChallenge("challenge-empty")?.reason).toBe("initial_reason");
		expect(service.ensureReasonTriggerForChallenge("challenge-empty")?.reason).toBe("initial_reason");
		expect(service.readReasonTriggers("challenge-empty")).toHaveLength(1);

		const candidate = service.proposeIntent({
			actor: { id: "solver-a", role: "solver", challengeId: "challenge-active" },
			idempotencyKey: "active-candidate",
			createdAt: baseTime,
			objective: "test active",
			scope: "web",
			confidence: 1,
		});
		service.confirmIntent({
			actor: host("challenge-active"),
			idempotencyKey: "active-confirm",
			createdAt: baseTime,
			candidateId: candidate.id,
		});
		expect(service.ensureReasonTriggerForChallenge("challenge-active")).toBeUndefined();

		store.executeServiceTransaction(() => store.markChallengeCompleted("challenge-complete", baseTime));
		expect(service.ensureReasonTriggerForChallenge("challenge-complete")).toBeUndefined();

		const historyCandidate = service.proposeIntent({
			actor: { id: "solver-a", role: "solver", challengeId: "challenge-history" },
			idempotencyKey: "history-candidate",
			createdAt: baseTime,
			objective: "historical",
			scope: "web",
			confidence: 1,
		});
		const historical = service.confirmIntent({
			actor: host("challenge-history"),
			idempotencyKey: "history-confirm",
			createdAt: baseTime,
			candidateId: historyCandidate.id,
		});
		store.executeServiceTransaction(() =>
			store.updateIntentLeaseState({
				challengeId: "challenge-history",
				intentId: historical.id,
				expectedVersion: historical.version,
				status: "superseded",
				updatedAt: baseTime,
			}),
		);
		expect(service.ensureReasonTriggerForChallenge("challenge-history")?.reason).toBe("no_active_intents");
		store.close();
	});

	test("does not present completed Trigger history as newly pending work", async () => {
		const { store, service } = await setup();
		const initial = service.ensureReasonTriggerForChallenge("challenge-empty")!;
		const acquired = lease(service, "ensure-initial", "challenge-empty");
		service.claimReasonTriggers({
			actor: host("challenge-empty"),
			idempotencyKey: "ensure-initial-claim",
			createdAt: baseTime,
			ownerId: acquired.ownerId,
			generation: acquired.generation,
			token: acquired.token,
		});
		service.completeReasonTriggers({
			actor: host("challenge-empty"),
			idempotencyKey: "ensure-initial-complete",
			createdAt: baseTime,
			ownerId: acquired.ownerId,
			generation: acquired.generation,
			token: acquired.token,
			triggerIds: [initial.id],
		});
		service.releaseReasonLease({
			actor: host("challenge-empty"),
			idempotencyKey: "ensure-initial-release",
			createdAt: baseTime,
			ownerId: acquired.ownerId,
			generation: acquired.generation,
			token: acquired.token,
		});

		const noActive = service.ensureReasonTriggerForChallenge("challenge-empty")!;
		const renewed = lease(service, "ensure-history", "challenge-empty");
		service.claimReasonTriggers({
			actor: host("challenge-empty"),
			idempotencyKey: "ensure-history-claim",
			createdAt: baseTime,
			ownerId: renewed.ownerId,
			generation: renewed.generation,
			token: renewed.token,
		});
		service.completeReasonTriggers({
			actor: host("challenge-empty"),
			idempotencyKey: "ensure-history-complete",
			createdAt: baseTime,
			ownerId: renewed.ownerId,
			generation: renewed.generation,
			token: renewed.token,
			triggerIds: [noActive.id],
		});
		service.releaseReasonLease({
			actor: host("challenge-empty"),
			idempotencyKey: "ensure-history-release",
			createdAt: baseTime,
			ownerId: renewed.ownerId,
			generation: renewed.generation,
			token: renewed.token,
		});

		expect(service.ensureReasonTriggerForChallenge("challenge-empty")).toBeUndefined();
		expect(store.readReasonTrigger("challenge-empty", noActive.id)?.status).toBe("completed");
		store.close();
	});
});
