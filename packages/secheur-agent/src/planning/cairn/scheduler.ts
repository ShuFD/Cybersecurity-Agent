/** Adapted from sxd-git1/cairnpilot b015733fa117aa35f2406b8b31fd1bbf84d3ec6e.
 * Apache-2.0; see vendor/cairnpilot/LICENSE and NOTICE.md. */
import { createHash } from "node:crypto";
import type { ChallengeGraphSnapshot, GraphIntent, IntentClaim } from "./types.ts";

export type SchedulerSolverStatus = "starting" | "running" | "stopping" | "stopped" | "error";

export interface SchedulerSolverProfile {
	id: string;
	capabilityTags: string[];
	tools: string[];
	skills: string[];
	mcps: string[];
	enabled?: boolean;
}

export interface SchedulerSolverSnapshot {
	id: string;
	challengeId?: string;
	profileId: string;
	status: SchedulerSolverStatus;
	activeIntentId?: string;
	profileFingerprint?: string;
	/** Host verified that the previous Intent concluded with a durable checkpoint. */
	reuseReady?: boolean;
}

export interface SchedulerCapacity {
	perChallengeSolverCap: number;
	globalRemainingSolverSlots: number;
}

export interface SchedulerPlanInput {
	challengeId: string;
	graph: ChallengeGraphSnapshot;
	activeClaims: IntentClaim[];
	solvers: SchedulerSolverSnapshot[];
	profiles: SchedulerSolverProfile[];
	capacity: SchedulerCapacity;
}

export interface SchedulerAssignment {
	intentId: string;
	profileId: string;
	reuseSolverId?: string;
}

export type SchedulerSkipReason =
	| "challenge_completed"
	| "active_claim"
	| "inactive_or_missing_fact"
	| "no_compatible_profile"
	| "capacity_exhausted";

export interface SchedulerSkippedIntent {
	intentId: string;
	reason: SchedulerSkipReason;
}

export interface SchedulerPlan {
	challengeId: string;
	runnableIntentIds: string[];
	desiredSolverCount: number;
	activeChallengeSolverCount: number;
	reusedSolverCount: number;
	newSolverCount: number;
	assignments: SchedulerAssignment[];
	skipped: SchedulerSkippedIntent[];
}

interface NormalizedProfile {
	profile: SchedulerSolverProfile;
	capabilityTags: Set<string>;
	fingerprint: string;
}

const CAPACITY_SOLVER_STATUSES = new Set<SchedulerSolverStatus>(["starting", "running", "stopping"]);

function requireText(value: string, fieldName: string): string {
	const text = value.trim();
	if (!text) throw new Error(`${fieldName} is required`);
	return text;
}

function requireCapacity(value: number, fieldName: string): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${fieldName} must be a non-negative safe integer`);
	return value;
}

function normalizedTags(values: string[]): Set<string> {
	const result = new Set<string>();
	for (const value of values) {
		const tag = value.trim().toLowerCase();
		if (tag) result.add(tag);
	}
	return result;
}

function normalizedList(values: string[]): string[] {
	return [...normalizedTags(values)].sort();
}

export function schedulerProfileFingerprint(profile: SchedulerSolverProfile): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				id: profile.id.trim(),
				capabilityTags: normalizedList(profile.capabilityTags),
				tools: normalizedList(profile.tools),
				skills: normalizedList(profile.skills),
				mcps: normalizedList(profile.mcps),
			}),
		)
		.digest("hex");
}

function compareIntents(left: GraphIntent, right: GraphIntent): number {
	return (
		right.priority - left.priority || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
	);
}

function supports(required: Set<string>, profile: NormalizedProfile): boolean {
	for (const tag of required) {
		if (!profile.capabilityTags.has(tag)) return false;
	}
	return true;
}

function profileSpecificity(required: Set<string>, profile: NormalizedProfile): number {
	return profile.capabilityTags.size - required.size;
}

function compatibleProfiles(required: Set<string>, profiles: NormalizedProfile[]): NormalizedProfile[] {
	return profiles
		.filter((profile) => supports(required, profile))
		.sort(
			(left, right) =>
				profileSpecificity(required, left) - profileSpecificity(required, right) ||
				left.profile.id.localeCompare(right.profile.id),
		);
}

function validateUniqueIds(items: Array<{ id: string }>, fieldName: string): void {
	const ids = new Set<string>();
	for (const [index, item] of items.entries()) {
		const id = requireText(item.id, `${fieldName}[${index}].id`);
		if (ids.has(id)) throw new Error(`${fieldName} contains duplicate id ${id}`);
		ids.add(id);
	}
}

function emptyPlan(
	challengeId: string,
	activeChallengeSolverCount: number,
	desiredSolverCount: number,
	skipped: SchedulerSkippedIntent[],
): SchedulerPlan {
	return {
		challengeId,
		runnableIntentIds: [],
		desiredSolverCount,
		activeChallengeSolverCount,
		reusedSolverCount: 0,
		newSolverCount: 0,
		assignments: [],
		skipped,
	};
}

export function buildSchedulerPlan(input: SchedulerPlanInput): SchedulerPlan {
	const challengeId = requireText(input.challengeId, "challengeId");
	if (input.graph.challengeId !== challengeId) throw new Error("graph challengeId must match scheduler challengeId");
	const perChallengeSolverCap = requireCapacity(input.capacity.perChallengeSolverCap, "perChallengeSolverCap");
	const globalRemainingSolverSlots = requireCapacity(
		input.capacity.globalRemainingSolverSlots,
		"globalRemainingSolverSlots",
	);
	validateUniqueIds(input.profiles, "profiles");
	validateUniqueIds(input.solvers, "solvers");

	const activeClaims = input.activeClaims.filter(
		(claim) => claim.challengeId === challengeId && claim.status === "active",
	);
	const claimedIntentIds = new Set(activeClaims.map((claim) => claim.intentId));
	const claimedSolverIds = new Set(activeClaims.map((claim) => claim.solverId));
	const activeChallengeSolvers = input.solvers.filter(
		(solver) => solver.challengeId === challengeId && CAPACITY_SOLVER_STATUSES.has(solver.status),
	);
	const activeChallengeSolverCount = activeChallengeSolvers.length;
	const sortedOpenIntents = input.graph.intents.filter((intent) => intent.status === "open").sort(compareIntents);

	if (input.graph.goalState?.completed === true) {
		return emptyPlan(
			challengeId,
			activeChallengeSolverCount,
			0,
			sortedOpenIntents.map((intent) => ({ intentId: intent.id, reason: "challenge_completed" })),
		);
	}

	const activeFactIds = new Set(input.graph.facts.filter((fact) => fact.status === "active").map((fact) => fact.id));
	const normalizedProfiles = input.profiles
		.filter((profile) => profile.enabled !== false)
		.map((profile) => ({
			profile,
			capabilityTags: normalizedTags(profile.capabilityTags),
			fingerprint: schedulerProfileFingerprint(profile),
		}))
		.sort((left, right) => left.profile.id.localeCompare(right.profile.id));
	const profileById = new Map(normalizedProfiles.map((profile) => [profile.profile.id, profile]));
	const reusableSolvers = activeChallengeSolvers
		.filter(
			(solver) =>
				solver.status === "running" &&
				solver.activeIntentId === undefined &&
				solver.reuseReady === true &&
				!claimedSolverIds.has(solver.id) &&
				profileById.get(solver.profileId)?.fingerprint === solver.profileFingerprint,
		)
		.sort((left, right) => left.id.localeCompare(right.id));
	const availableReusableSolverIds = new Set(reusableSolvers.map((solver) => solver.id));
	const committedSolverIds = new Set(
		activeChallengeSolvers
			.filter(
				(solver) =>
					solver.status === "starting" || solver.activeIntentId !== undefined || claimedSolverIds.has(solver.id),
			)
			.map((solver) => solver.id),
	);
	const skipped: SchedulerSkippedIntent[] = [];
	const schedulable: Array<{ intent: GraphIntent; profiles: NormalizedProfile[] }> = [];

	for (const intent of sortedOpenIntents) {
		if (claimedIntentIds.has(intent.id)) {
			skipped.push({ intentId: intent.id, reason: "active_claim" });
			continue;
		}
		if (intent.fromFactIds.some((factId) => !activeFactIds.has(factId))) {
			skipped.push({ intentId: intent.id, reason: "inactive_or_missing_fact" });
			continue;
		}
		const profiles = compatibleProfiles(normalizedTags(intent.capabilityTags), normalizedProfiles);
		if (profiles.length === 0) {
			skipped.push({ intentId: intent.id, reason: "no_compatible_profile" });
			continue;
		}
		schedulable.push({ intent, profiles });
	}

	const runnableIntentIds = schedulable.map(({ intent }) => intent.id);
	const assignments: SchedulerAssignment[] = [];
	const challengeRemainingSlots = Math.max(perChallengeSolverCap - activeChallengeSolverCount, 0);
	const reuseAllowed = perChallengeSolverCap > 0 && activeChallengeSolverCount <= perChallengeSolverCap;
	let newSolverSlots = Math.min(challengeRemainingSlots, globalRemainingSolverSlots);
	// Retained conversations release their execution slots, so reuse must reserve
	// from the same global budget as a newly launched Solver.
	let executionSlots = globalRemainingSolverSlots;
	let reusedSolverCount = 0;
	let newSolverCount = 0;

	for (const { intent, profiles } of schedulable) {
		const profileOrder = new Map(profiles.map((profile, index) => [profile.profile.id, index]));
		const reusable = reusableSolvers
			.filter(
				(solver) => reuseAllowed && availableReusableSolverIds.has(solver.id) && profileOrder.has(solver.profileId),
			)
			.sort(
				(left, right) =>
					(profileOrder.get(left.profileId) ?? Number.MAX_SAFE_INTEGER) -
						(profileOrder.get(right.profileId) ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id),
			)[0];
		if (reusable && executionSlots > 0) {
			availableReusableSolverIds.delete(reusable.id);
			assignments.push({ intentId: intent.id, profileId: reusable.profileId, reuseSolverId: reusable.id });
			reusedSolverCount += 1;
			executionSlots -= 1;
			newSolverSlots = Math.min(newSolverSlots, executionSlots);
			continue;
		}
		if (newSolverSlots > 0) {
			assignments.push({ intentId: intent.id, profileId: profiles[0].profile.id });
			newSolverSlots -= 1;
			executionSlots -= 1;
			newSolverCount += 1;
			continue;
		}
		skipped.push({ intentId: intent.id, reason: "capacity_exhausted" });
	}

	return {
		challengeId,
		runnableIntentIds,
		desiredSolverCount: committedSolverIds.size + reusedSolverCount + newSolverCount,
		activeChallengeSolverCount,
		reusedSolverCount,
		newSolverCount,
		assignments,
		skipped,
	};
}
