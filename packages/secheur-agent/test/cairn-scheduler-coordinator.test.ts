/** Regression tests ported from CairnPilot b015733 (Apache-2.0). */
import { describe, expect, test, vi } from "vitest";

const mock = vi.fn;

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type SchedulerSolverProfile,
	type SchedulerSolverSnapshot,
	schedulerProfileFingerprint,
} from "../src/planning/cairn/scheduler.ts";
import { SchedulerCoordinator, schedulerSolverId } from "../src/planning/cairn/scheduler-coordinator.ts";
import { GraphService } from "../src/planning/cairn/service.ts";
import { GraphStore } from "../src/planning/cairn/store.ts";
import type { GraphIntent, IntentClaim, IntentLease } from "../src/planning/cairn/types.ts";

const createdAt = "2026-08-12T00:00:00.000Z";

function intent(overrides: Partial<GraphIntent> = {}): GraphIntent {
	return {
		id: "intent-a",
		challengeId: "challenge-a",
		fromFactIds: [],
		sourceHintIds: [],
		objective: "test the upload path",
		scope: "confirm executable upload",
		capabilityTags: ["web"],
		priority: 10,
		status: "open",
		resultFactIds: [],
		attemptCount: 0,
		version: 0,
		createdBy: "host",
		sourceIdeaIds: [],
		fingerprint: "intent-fingerprint",
		createdAt,
		updatedAt: createdAt,
		...overrides,
	};
}

const profiles: SchedulerSolverProfile[] = [
	{ id: "web-profile", capabilityTags: ["web"], tools: ["bash"], skills: [], mcps: [] },
];

function harness(
	options: {
		launchError?: Error;
		reuseError?: Error;
		solvers?: SchedulerSolverSnapshot[];
		initialIntent?: GraphIntent;
	} = {},
) {
	let currentIntent = options.initialIntent ?? intent();
	let claims: IntentClaim[] = [];
	const leases = new Map<string, IntentLease>();
	const launchSolver = mock(
		async (input: {
			challengeId: string;
			profileId: string;
			profileFingerprint: string;
			solverId: string;
			lease: IntentLease;
			handoff: string;
		}) => {
			if (options.launchError) throw options.launchError;
			currentIntent = { ...currentIntent, status: "running", version: input.lease.version + 1 };
		},
	);
	const bindSolverLease = mock(async (solverId: string, lease: IntentLease) => {
		expect(solverId).toBe(lease.solverId);
		currentIntent = { ...currentIntent, status: "running", version: lease.version + 1 };
	});
	const stopSolver = mock(async () => {});
	const reuseSolver = mock(async (input: { lease: IntentLease; context: string; profileFingerprint: string }) => {
		if (options.reuseError) throw options.reuseError;
		expect(input.context).toContain("Host-validated");
		expect(input.profileFingerprint).toBe(schedulerProfileFingerprint(profiles[0]));
		currentIntent = { ...currentIntent, status: "running", version: input.lease.version + 1 };
	});
	const claimIntent = mock(
		(input: {
			actor: { id: string; role: "host"; challengeId: string };
			idempotencyKey: string;
			intentId: string;
			solverId: string;
			expectedVersion: number;
			leaseDurationMs: number;
		}) => {
			const replay = leases.get(input.idempotencyKey);
			if (replay) return replay;
			if (currentIntent.status !== "open") throw new Error("intent is not open");
			const lease: IntentLease = {
				challengeId: currentIntent.challengeId,
				intentId: currentIntent.id,
				solverId: input.solverId,
				token: "lease-token",
				generation: 1,
				leaseUntil: "2026-08-12T00:00:30.000Z",
				version: currentIntent.version + 1,
			};
			leases.set(input.idempotencyKey, lease);
			currentIntent = { ...currentIntent, status: "claimed", ownerSolverId: input.solverId, version: lease.version };
			claims = [
				{
					id: "claim-a",
					challengeId: currentIntent.challengeId,
					intentId: currentIntent.id,
					solverId: input.solverId,
					tokenHash: "hash",
					generation: 1,
					leaseUntil: lease.leaseUntil,
					heartbeatAt: createdAt,
					status: "active",
					createdAt,
					updatedAt: createdAt,
				},
			];
			return lease;
		},
	);
	const releaseClaimForRuntimeFailure = mock((input: { solverId: string; generation: number }) => {
		const active = claims[0];
		if (!active || active.solverId !== input.solverId || active.generation !== input.generation) {
			throw new Error("active Claim was not found");
		}
		claims = [];
		currentIntent = {
			...currentIntent,
			status: "open",
			ownerSolverId: undefined,
			version: currentIntent.version + 1,
		};
		return { intentId: currentIntent.id, version: currentIntent.version, released: true as const };
	});
	const service = {
		readSchedulerState: () => ({
			graph: { challengeId: "challenge-a", facts: [], hints: [], intents: [currentIntent] },
			activeClaims: claims,
		}),
		claimIntent,
		releaseClaimForRuntimeFailure,
		getIntentFocusedContext: () => ({
			challengeId: "challenge-a",
			facts: [],
			hints: [],
			intents: [currentIntent],
			delta: [],
			truncated: false,
		}),
	};
	const coordinator = new SchedulerCoordinator({
		hostId: "host-scheduler",
		leaseDurationMs: 30_000,
		service: service as never,
		listSolvers: () => options.solvers ?? [],
		listProfiles: async () => profiles,
		readCapacity: async () => ({ perChallengeSolverCap: 2, globalRemainingSolverSlots: 2 }),
		launchSolver: launchSolver as never,
		bindSolverLease,
		reuseSolver,
		stopSolver,
	});
	return {
		coordinator,
		service,
		launchSolver,
		bindSolverLease,
		reuseSolver,
		stopSolver,
		getIntent: () => currentIntent,
	};
}

describe("SchedulerCoordinator", () => {
	test("claims as Host and starts one deterministic Solver before repeated ticks become idle", async () => {
		const h = harness();
		const first = await h.coordinator.runChallengeOnce("challenge-a");
		const solverId = schedulerSolverId("challenge-a", "intent-a", 0, "web-profile");
		expect(first.assignments).toEqual([
			{ intentId: "intent-a", profileId: "web-profile", solverId, status: "started" },
		]);
		expect(h.service.claimIntent).toHaveBeenCalledTimes(1);
		expect(h.service.claimIntent.mock.calls[0][0].actor.role).toBe("host");
		expect(h.launchSolver.mock.calls[0][0]).toMatchObject({
			challengeId: "challenge-a",
			profileId: "web-profile",
			solverId,
		});
		expect(h.launchSolver.mock.calls[0][0].handoff).toContain("Primary Graph Intent");

		const second = await h.coordinator.runChallengeOnce("challenge-a");
		expect(second.plan.assignments).toEqual([]);
		expect(h.launchSolver).toHaveBeenCalledTimes(1);
	});

	test("compensates a claimed Intent when Runtime launch fails", async () => {
		const h = harness({ launchError: new Error("container failed") });
		const result = await h.coordinator.runChallengeOnce("challenge-a");
		expect(result.assignments[0]).toMatchObject({ status: "failed", error: "container failed" });
		expect(h.stopSolver).toHaveBeenCalledTimes(1);
		expect(h.service.releaseClaimForRuntimeFailure).toHaveBeenCalledTimes(1);
		expect(h.getIntent().status).toBe("open");
	});

	test("does not launch a Runtime when Claim creation fails", async () => {
		const h = harness();
		h.service.claimIntent.mockImplementationOnce(() => {
			throw new Error("intent already has an active claim");
		});
		const result = await h.coordinator.runChallengeOnce("challenge-a");
		expect(result.assignments[0]).toMatchObject({ status: "failed" });
		expect(h.launchSolver).not.toHaveBeenCalled();
		expect(h.service.releaseClaimForRuntimeFailure).not.toHaveBeenCalled();
	});

	test("recovers a persisted claimed assignment by launching its deterministic Solver", async () => {
		const claimedIntent = intent({ status: "claimed", version: 1 });
		const solverId = schedulerSolverId("challenge-a", "intent-a", 0, "web-profile");
		const h = harness({ initialIntent: claimedIntent });
		const replayLease: IntentLease = {
			challengeId: "challenge-a",
			intentId: "intent-a",
			solverId,
			token: "restored-token",
			generation: 1,
			leaseUntil: "2026-08-12T00:00:30.000Z",
			version: 1,
		};
		h.service.readSchedulerState = () => ({
			graph: { challengeId: "challenge-a", facts: [], hints: [], intents: [claimedIntent] },
			activeClaims: [
				{
					id: "claim-a",
					challengeId: "challenge-a",
					intentId: "intent-a",
					solverId,
					tokenHash: "hash",
					generation: 1,
					leaseUntil: replayLease.leaseUntil,
					heartbeatAt: createdAt,
					status: "active",
					createdAt,
					updatedAt: createdAt,
				},
			],
		});
		h.service.claimIntent.mockImplementation(() => replayLease);
		const result = await h.coordinator.runChallengeOnce("challenge-a");
		expect(result.assignments[0]).toMatchObject({ status: "recovered", solverId });
		expect(h.launchSolver).toHaveBeenCalledTimes(1);
	});

	test("binds a recovered Claim to an already running deterministic Solver", async () => {
		const solverId = schedulerSolverId("challenge-a", "intent-a", 0, "web-profile");
		const claimedIntent = intent({ status: "claimed", version: 1 });
		const h = harness({
			initialIntent: claimedIntent,
			solvers: [{ id: solverId, challengeId: "challenge-a", profileId: "web-profile", status: "running" }],
		});
		const lease: IntentLease = {
			challengeId: "challenge-a",
			intentId: "intent-a",
			solverId,
			token: "restored-token",
			generation: 1,
			leaseUntil: "2026-08-12T00:00:30.000Z",
			version: 1,
		};
		h.service.readSchedulerState = () => ({
			graph: { challengeId: "challenge-a", facts: [], hints: [], intents: [claimedIntent] },
			activeClaims: [
				{
					id: "claim-a",
					challengeId: "challenge-a",
					intentId: "intent-a",
					solverId,
					tokenHash: "hash",
					generation: 1,
					leaseUntil: lease.leaseUntil,
					heartbeatAt: createdAt,
					status: "active",
					createdAt,
					updatedAt: createdAt,
				},
			],
		});
		h.service.claimIntent.mockImplementation(() => lease);
		const result = await h.coordinator.runChallengeOnce("challenge-a");
		expect(result.assignments[0]?.status).toBe("recovered");
		expect(h.bindSolverLease).toHaveBeenCalledTimes(1);
		expect(h.launchSolver).not.toHaveBeenCalled();
	});

	test("reuses a checkpointed same-Challenge Solver", async () => {
		const h = harness({
			solvers: [
				{
					id: "idle",
					challengeId: "challenge-a",
					profileId: "web-profile",
					status: "running",
					reuseReady: true,
					profileFingerprint: schedulerProfileFingerprint(profiles[0]),
				},
			],
		});
		const result = await h.coordinator.runChallengeOnce("challenge-a");
		expect(result.assignments).toEqual([
			{ intentId: "intent-a", profileId: "web-profile", solverId: "idle", status: "reused" },
		]);
		expect(h.service.claimIntent).toHaveBeenCalledTimes(1);
		expect(h.reuseSolver).toHaveBeenCalledTimes(1);
		expect(h.launchSolver).not.toHaveBeenCalled();
	});

	test("stops a failed reuse, rereads the reopened Intent, and starts a fresh fallback Runtime", async () => {
		const h = harness({
			reuseError: new Error("compaction failed"),
			solvers: [
				{
					id: "idle",
					challengeId: "challenge-a",
					profileId: "web-profile",
					status: "running",
					reuseReady: true,
					profileFingerprint: schedulerProfileFingerprint(profiles[0]),
				},
			],
		});
		const result = await h.coordinator.runChallengeOnce("challenge-a");
		expect(result.assignments[0]).toMatchObject({ status: "fallback_started", error: "compaction failed" });
		expect(h.stopSolver).toHaveBeenCalledWith("idle");
		expect(h.service.releaseClaimForRuntimeFailure).toHaveBeenCalledTimes(1);
		expect(h.launchSolver).toHaveBeenCalledTimes(1);
		expect(h.launchSolver.mock.calls[0][0].solverId).not.toBe("idle");
	});

	test("recovers the same claimed Solver and token after GraphStore reopen", async () => {
		const directory = await mkdtemp(join(tmpdir(), "scheduler-reopen-"));
		const databasePath = join(directory, "graph.db");
		const secret = "scheduler-reopen-secret";
		try {
			const firstStore = new GraphStore(databasePath);
			firstStore.initialize();
			const firstService = new GraphService(firstStore, { leaseTokenSecret: secret });
			const candidate = firstService.proposeIntent({
				actor: { id: "solver-source", role: "solver", challengeId: "challenge-a" },
				idempotencyKey: "candidate",
				createdAt,
				objective: "recover upload testing",
				scope: "upload only",
				confidence: 0.9,
				capabilityTags: ["web"],
			});
			const confirmed = firstService.confirmIntent({
				actor: { id: "host", role: "host", challengeId: "challenge-a" },
				idempotencyKey: "confirm",
				createdAt,
				candidateId: candidate.id,
			});
			const solverId = schedulerSolverId("challenge-a", confirmed.id, confirmed.version, "web-profile");
			const firstLease = firstService.claimIntent({
				actor: { id: "host-scheduler", role: "host", challengeId: "challenge-a" },
				idempotencyKey: `scheduler-claim:${confirmed.id}:${confirmed.version}:${solverId}`,
				intentId: confirmed.id,
				solverId,
				expectedVersion: confirmed.version,
				leaseDurationMs: 30_000,
			});
			firstStore.close();

			const reopenedStore = new GraphStore(databasePath);
			reopenedStore.initialize();
			const reopenedService = new GraphService(reopenedStore, { leaseTokenSecret: secret });
			const launchSolver = mock(async (input: { lease: IntentLease }) => {
				expect(input.lease).toEqual(firstLease);
			});
			const coordinator = new SchedulerCoordinator({
				hostId: "host-scheduler",
				leaseDurationMs: 30_000,
				service: reopenedService,
				listSolvers: () => [],
				listProfiles: async () => profiles,
				readCapacity: async () => ({ perChallengeSolverCap: 1, globalRemainingSolverSlots: 1 }),
				launchSolver: launchSolver as never,
				bindSolverLease: async () => {},
				reuseSolver: async () => {},
				stopSolver: async () => {},
			});
			const result = await coordinator.runChallengeOnce("challenge-a");
			expect(result.assignments).toEqual([
				{ intentId: confirmed.id, profileId: "web-profile", solverId, status: "recovered" },
			]);
			expect(reopenedStore.readClaims("challenge-a")).toHaveLength(1);
			reopenedStore.close();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
