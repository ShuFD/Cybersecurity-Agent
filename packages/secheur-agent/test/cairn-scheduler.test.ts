/** Regression tests ported from CairnPilot b015733 (Apache-2.0). */
import { describe, expect, test } from "vitest";
import {
	buildSchedulerPlan,
	type SchedulerPlanInput,
	type SchedulerSolverProfile,
	schedulerProfileFingerprint,
} from "../src/planning/cairn/scheduler.ts";
import type { GraphFact, GraphIntent, IntentClaim } from "../src/planning/cairn/types.ts";

const timestamp = "2026-08-12T00:00:00.000Z";

function intent(id: string, overrides: Partial<GraphIntent> = {}): GraphIntent {
	return {
		id,
		challengeId: "challenge-a",
		fromFactIds: [],
		sourceHintIds: [],
		objective: `objective ${id}`,
		scope: `scope ${id}`,
		capabilityTags: [],
		priority: 0,
		status: "open",
		resultFactIds: [],
		attemptCount: 0,
		version: 1,
		createdBy: "host",
		sourceIdeaIds: [],
		fingerprint: `fingerprint-${id}`,
		createdAt: timestamp,
		updatedAt: timestamp,
		...overrides,
	};
}

function fact(id: string, overrides: Partial<GraphFact> = {}): GraphFact {
	return {
		id,
		challengeId: "challenge-a",
		kind: "fact",
		statement: `fact ${id}`,
		evidenceRefs: [],
		sourceMemoryIds: [],
		fingerprint: `fingerprint-${id}`,
		status: "active",
		observedAt: timestamp,
		createdAt: timestamp,
		...overrides,
	};
}

function claim(intentId: string, solverId: string): IntentClaim {
	return {
		id: `claim-${intentId}`,
		challengeId: "challenge-a",
		intentId,
		solverId,
		tokenHash: "token-hash",
		generation: 1,
		leaseUntil: "2026-08-12T00:01:00.000Z",
		heartbeatAt: timestamp,
		status: "active",
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

const profiles: SchedulerSolverProfile[] = [
	{ id: "general", capabilityTags: [], tools: [], skills: [], mcps: [] },
	{ id: "web", capabilityTags: ["web"], tools: ["browser"], skills: ["web"], mcps: [] },
	{ id: "web-upload", capabilityTags: ["web", "upload"], tools: ["browser"], skills: ["web"], mcps: [] },
];

function input(overrides: Partial<SchedulerPlanInput> = {}): SchedulerPlanInput {
	return {
		challengeId: "challenge-a",
		graph: { challengeId: "challenge-a", facts: [], hints: [], intents: [] },
		activeClaims: [],
		solvers: [],
		profiles,
		capacity: { perChallengeSolverCap: 4, globalRemainingSolverSlots: 4 },
		...overrides,
	};
}

describe("buildSchedulerPlan", () => {
	test("returns no assignments without open work, global capacity, or a live Challenge", () => {
		expect(buildSchedulerPlan(input()).assignments).toEqual([]);
		expect(
			buildSchedulerPlan(
				input({
					graph: { challengeId: "challenge-a", facts: [], hints: [], intents: [intent("open")] },
					capacity: { perChallengeSolverCap: 4, globalRemainingSolverSlots: 0 },
				}),
			),
		).toMatchObject({ assignments: [], newSolverCount: 0 });
		expect(
			buildSchedulerPlan(
				input({
					graph: {
						challengeId: "challenge-a",
						facts: [],
						hints: [],
						intents: [intent("open")],
						goalState: { challengeId: "challenge-a", completed: true, solvedFlagCount: 1, updatedAt: timestamp },
					},
				}),
			),
		).toMatchObject({ assignments: [], skipped: [{ intentId: "open", reason: "challenge_completed" }] });
	});

	test("targets only committed work and does not keep idle or completed-Challenge Solvers desired", () => {
		const solvers: SchedulerPlanInput["solvers"] = [
			{ id: "busy", challengeId: "challenge-a", profileId: "general", status: "running", activeIntentId: "current" },
			{ id: "idle", challengeId: "challenge-a", profileId: "general", status: "running" },
			{ id: "stopping", challengeId: "challenge-a", profileId: "general", status: "stopping" },
		];
		expect(buildSchedulerPlan(input({ solvers }))).toMatchObject({
			activeChallengeSolverCount: 3,
			desiredSolverCount: 1,
		});
		expect(
			buildSchedulerPlan(
				input({
					solvers,
					graph: {
						challengeId: "challenge-a",
						facts: [],
						hints: [],
						intents: [],
						goalState: { challengeId: "challenge-a", completed: true, solvedFlagCount: 1, updatedAt: timestamp },
					},
				}),
			).desiredSolverCount,
		).toBe(0);
	});

	test("schedules only open, unclaimed Intents with active Fact dependencies", () => {
		const plan = buildSchedulerPlan(
			input({
				graph: {
					challengeId: "challenge-a",
					facts: [fact("active"), fact("invalid", { status: "invalidated", invalidatedByFactId: "active" })],
					hints: [],
					intents: [
						intent("valid", { fromFactIds: ["active"] }),
						intent("claimed"),
						intent("invalid-fact", { fromFactIds: ["invalid"] }),
						intent("missing-fact", { fromFactIds: ["missing"] }),
						intent("running", { status: "running" }),
					],
				},
				activeClaims: [claim("claimed", "solver-claimed")],
			}),
		);

		expect(plan.assignments.map((assignment) => assignment.intentId)).toEqual(["valid"]);
		expect(plan.skipped).toEqual([
			{ intentId: "claimed", reason: "active_claim" },
			{ intentId: "invalid-fact", reason: "inactive_or_missing_fact" },
			{ intentId: "missing-fact", reason: "inactive_or_missing_fact" },
		]);
	});

	test("uses normalized capability tags and the most specific compatible Profile", () => {
		const plan = buildSchedulerPlan(
			input({
				graph: {
					challengeId: "challenge-a",
					facts: [],
					hints: [],
					intents: [intent("upload", { capabilityTags: [" WEB ", "Upload"] })],
				},
			}),
		);

		expect(plan.assignments).toEqual([{ intentId: "upload", profileId: "web-upload" }]);
	});

	test("records an Intent when no enabled Profile satisfies every capability", () => {
		const plan = buildSchedulerPlan(
			input({
				graph: {
					challengeId: "challenge-a",
					facts: [],
					hints: [],
					intents: [intent("pwn", { capabilityTags: ["pwn"] })],
				},
				profiles: [
					...profiles,
					{ id: "pwn-disabled", capabilityTags: ["pwn"], tools: [], skills: [], mcps: [], enabled: false },
				],
			}),
		);

		expect(plan.assignments).toEqual([]);
		expect(plan.runnableIntentIds).toEqual([]);
		expect(plan.skipped).toEqual([{ intentId: "pwn", reason: "no_compatible_profile" }]);
	});

	test("reuses one compatible idle same-Challenge Solver at most once", () => {
		const plan = buildSchedulerPlan(
			input({
				graph: {
					challengeId: "challenge-a",
					facts: [],
					hints: [],
					intents: [intent("a", { capabilityTags: ["web"] }), intent("b", { capabilityTags: ["web"] })],
				},
				solvers: [
					{
						id: "idle",
						challengeId: "challenge-a",
						profileId: "web",
						status: "running",
						reuseReady: true,
						profileFingerprint: schedulerProfileFingerprint(profiles.find((profile) => profile.id === "web")!),
					},
					{ id: "busy", challengeId: "challenge-a", profileId: "web", status: "running", activeIntentId: "other" },
					{ id: "foreign", challengeId: "challenge-b", profileId: "web", status: "running" },
				],
				capacity: { perChallengeSolverCap: 3, globalRemainingSolverSlots: 1 },
			}),
		);

		expect(plan.assignments).toEqual([{ intentId: "a", profileId: "web", reuseSolverId: "idle" }]);
		expect(plan).toMatchObject({
			activeChallengeSolverCount: 2,
			reusedSolverCount: 1,
			newSolverCount: 0,
			desiredSolverCount: 2,
		});
		expect(plan.skipped).toContainEqual({ intentId: "b", reason: "capacity_exhausted" });
	});

	test("shares global execution capacity between reuse and new launches", () => {
		const idle = {
			id: "idle",
			challengeId: "challenge-a",
			profileId: "general",
			status: "running" as const,
			reuseReady: true,
			profileFingerprint: schedulerProfileFingerprint(profiles[0]),
		};
		const base = input({
			graph: { challengeId: "challenge-a", facts: [], hints: [], intents: [intent("a"), intent("b")] },
			solvers: [idle],
			capacity: { perChallengeSolverCap: 2, globalRemainingSolverSlots: 0 },
		});
		expect(buildSchedulerPlan(base).assignments).toEqual([]);
		const one = buildSchedulerPlan({
			...base,
			capacity: { perChallengeSolverCap: 2, globalRemainingSolverSlots: 1 },
		});
		expect(one.assignments).toEqual([{ intentId: "a", profileId: "general", reuseSolverId: "idle" }]);
		expect(one.newSolverCount).toBe(0);
		const two = buildSchedulerPlan({
			...base,
			capacity: { perChallengeSolverCap: 2, globalRemainingSolverSlots: 2 },
		});
		expect(two.assignments).toHaveLength(2);
		expect(two).toMatchObject({ reusedSolverCount: 1, newSolverCount: 1 });
	});

	test("does not reuse a Solver after its toolchain Profile changes", () => {
		const plan = buildSchedulerPlan(
			input({
				graph: { challengeId: "challenge-a", facts: [], hints: [], intents: [intent("next")] },
				solvers: [
					{
						id: "idle",
						challengeId: "challenge-a",
						profileId: "general",
						status: "running",
						reuseReady: true,
						profileFingerprint: "stale-profile",
					},
				],
				capacity: { perChallengeSolverCap: 2, globalRemainingSolverSlots: 1 },
			}),
		);
		expect(plan.assignments).toEqual([{ intentId: "next", profileId: "general" }]);
		expect(plan.reusedSolverCount).toBe(0);
	});

	test("does not reuse a Solver that owns an active Claim even when its snapshot omits activeIntentId", () => {
		const plan = buildSchedulerPlan(
			input({
				graph: { challengeId: "challenge-a", facts: [], hints: [], intents: [intent("next")] },
				activeClaims: [claim("other", "solver-a")],
				solvers: [{ id: "solver-a", challengeId: "challenge-a", profileId: "general", status: "running" }],
				capacity: { perChallengeSolverCap: 1, globalRemainingSolverSlots: 1 },
			}),
		);

		expect(plan.assignments).toEqual([]);
		expect(plan.skipped).toContainEqual({ intentId: "next", reason: "capacity_exhausted" });
	});

	test("isolates active Claims from other Challenges", () => {
		const foreignClaim = { ...claim("next", "foreign-solver"), id: "foreign-claim", challengeId: "challenge-b" };
		const plan = buildSchedulerPlan(
			input({
				graph: { challengeId: "challenge-a", facts: [], hints: [], intents: [intent("next")] },
				activeClaims: [foreignClaim],
			}),
		);

		expect(plan.assignments).toEqual([{ intentId: "next", profileId: "general" }]);
	});

	test("deducts active Challenge Solvers from the per-Challenge cap and respects global new slots", () => {
		const plan = buildSchedulerPlan(
			input({
				graph: {
					challengeId: "challenge-a",
					facts: [],
					hints: [],
					intents: [intent("a"), intent("b"), intent("c")],
				},
				solvers: [
					{
						id: "running",
						challengeId: "challenge-a",
						profileId: "general",
						status: "running",
						activeIntentId: "old",
					},
					{ id: "stopping", challengeId: "challenge-a", profileId: "general", status: "stopping" },
				],
				capacity: { perChallengeSolverCap: 3, globalRemainingSolverSlots: 2 },
			}),
		);

		expect(plan.assignments).toHaveLength(1);
		expect(plan).toMatchObject({ activeChallengeSolverCount: 2, newSolverCount: 1, desiredSolverCount: 2 });
		expect(plan.skipped.filter((item) => item.reason === "capacity_exhausted")).toHaveLength(2);
	});

	test("does not assign new work to an idle Solver while the Challenge is already over its cap", () => {
		const plan = buildSchedulerPlan(
			input({
				graph: { challengeId: "challenge-a", facts: [], hints: [], intents: [intent("next")] },
				solvers: [
					{ id: "idle", challengeId: "challenge-a", profileId: "general", status: "running" },
					{ id: "stopping", challengeId: "challenge-a", profileId: "general", status: "stopping" },
				],
				capacity: { perChallengeSolverCap: 1, globalRemainingSolverSlots: 2 },
			}),
		);

		expect(plan.assignments).toEqual([]);
		expect(plan.skipped).toContainEqual({ intentId: "next", reason: "capacity_exhausted" });
	});

	test("sorts by priority, creation time, and Intent ID independently of input order", () => {
		const intents = [
			intent("c", { priority: 1, createdAt: "2026-08-12T00:00:01.000Z" }),
			intent("b", { priority: 2, createdAt: timestamp }),
			intent("a", { priority: 2, createdAt: timestamp }),
		];
		const first = buildSchedulerPlan(input({ graph: { challengeId: "challenge-a", facts: [], hints: [], intents } }));
		const second = buildSchedulerPlan(
			input({
				graph: { challengeId: "challenge-a", facts: [], hints: [], intents: [...intents].reverse() },
				profiles: [...profiles].reverse(),
			}),
		);

		expect(first.assignments.map((assignment) => assignment.intentId)).toEqual(["a", "b", "c"]);
		expect(second).toEqual(first);
		expect(
			buildSchedulerPlan(input({ graph: { challengeId: "challenge-a", facts: [], hints: [], intents } })),
		).toEqual(first);
	});

	test("rejects invalid capacities, mismatched Challenges, and duplicate snapshot identities", () => {
		expect(() =>
			buildSchedulerPlan(input({ capacity: { perChallengeSolverCap: -1, globalRemainingSolverSlots: 1 } })),
		).toThrow("perChallengeSolverCap must be a non-negative safe integer");
		expect(() =>
			buildSchedulerPlan(input({ graph: { challengeId: "challenge-b", facts: [], hints: [], intents: [] } })),
		).toThrow("graph challengeId must match");
		expect(() => buildSchedulerPlan(input({ profiles: [profiles[0], profiles[0]] }))).toThrow(
			"profiles contains duplicate id",
		);
		expect(() =>
			buildSchedulerPlan(
				input({
					solvers: [
						{ id: "same", challengeId: "challenge-a", profileId: "general", status: "running" },
						{ id: "same", challengeId: "challenge-a", profileId: "general", status: "stopped" },
					],
				}),
			),
		).toThrow("solvers contains duplicate id");
	});
});
