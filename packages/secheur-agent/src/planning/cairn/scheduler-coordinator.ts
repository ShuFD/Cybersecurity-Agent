/** Adapted from sxd-git1/cairnpilot b015733fa117aa35f2406b8b31fd1bbf84d3ec6e.
 * Apache-2.0; see vendor/cairnpilot/LICENSE and NOTICE.md. */
import { createHash } from "node:crypto";
import {
	buildSchedulerPlan,
	type SchedulerCapacity,
	type SchedulerPlan,
	type SchedulerSolverProfile,
	type SchedulerSolverSnapshot,
	schedulerProfileFingerprint,
} from "./scheduler.ts";
import type { GraphService } from "./service.ts";
import type { FocusedGraphContext, GraphIntent, IntentLease } from "./types.ts";

export interface SchedulerCoordinatorOptions {
	hostId: string;
	leaseDurationMs: number;
	service: Pick<
		GraphService,
		"readSchedulerState" | "claimIntent" | "releaseClaimForRuntimeFailure" | "getIntentFocusedContext"
	>;
	listSolvers: () => SchedulerSolverSnapshot[];
	listProfiles: () => Promise<SchedulerSolverProfile[]>;
	readCapacity: (challengeId: string) => Promise<SchedulerCapacity>;
	launchSolver: (input: {
		challengeId: string;
		profileId: string;
		profileFingerprint: string;
		solverId: string;
		lease: IntentLease;
		handoff: string;
	}) => Promise<void>;
	bindSolverLease: (solverId: string, lease: IntentLease) => Promise<void>;
	reuseSolver: (input: {
		solverId: string;
		profileId: string;
		profileFingerprint: string;
		lease: IntentLease;
		context: string;
	}) => Promise<void>;
	stopSolver: (solverId: string) => Promise<void>;
}

export type SchedulerAssignmentStatus = "started" | "recovered" | "reused" | "fallback_started" | "failed";

export interface SchedulerAssignmentResult {
	intentId: string;
	profileId: string;
	solverId?: string;
	status: SchedulerAssignmentStatus;
	error?: string;
}

export interface SchedulerRunResult {
	challengeId: string;
	plan: SchedulerPlan;
	assignments: SchedulerAssignmentResult[];
}

function requirePositiveInteger(value: number, fieldName: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${fieldName} must be a positive integer`);
	return value;
}

function safeError(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.replace(/(token|secret|password|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]").slice(0, 240);
}

export function schedulerSolverId(
	challengeId: string,
	intentId: string,
	intentVersion: number,
	profileId: string,
): string {
	const digest = createHash("sha256")
		.update(JSON.stringify([challengeId, intentId, intentVersion, profileId]))
		.digest("hex");
	return `sch-${digest.slice(0, 12)}`;
}

function claimIdempotencyKey(intent: GraphIntent, solverId: string): string {
	return `scheduler-claim:${intent.id}:${intent.version}:${solverId}`;
}

function recoveryClaimIdempotencyKey(intent: GraphIntent, solverId: string): string {
	return `scheduler-claim:${intent.id}:${intent.version - 1}:${solverId}`;
}

function intentHandoff(intent: GraphIntent): string {
	return [
		`Primary Graph Intent: ${intent.objective}`,
		intent.scope.trim() ? `Scope and success boundary: ${intent.scope.trim()}` : undefined,
		`Intent ID: ${intent.id}`,
		"Work only on this primary Intent and use Graph tools for durable findings.",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function intentSwitchContext(intent: GraphIntent, context: FocusedGraphContext): string {
	return [
		intentHandoff(intent),
		"The following Graph Context is Host-validated and replaces the previous primary Intent context:",
		JSON.stringify(context),
	].join("\n\n");
}

export class SchedulerCoordinator {
	private readonly leaseDurationMs: number;

	private readonly options: SchedulerCoordinatorOptions;
	constructor(options: SchedulerCoordinatorOptions) {
		this.options = options;
		if (!options.hostId.trim()) throw new Error("hostId is required");
		this.leaseDurationMs = requirePositiveInteger(options.leaseDurationMs, "leaseDurationMs");
	}

	async runChallengeOnce(challengeId: string): Promise<SchedulerRunResult> {
		const profiles = await this.options.listProfiles();
		const state = this.options.service.readSchedulerState(challengeId);
		const recovered = await this.reconcileClaimedIntents(state.graph.intents, state.activeClaims, profiles);
		const refreshed = recovered.length > 0 ? this.options.service.readSchedulerState(challengeId) : state;
		const solvers = this.options.listSolvers();
		const plan = buildSchedulerPlan({
			challengeId,
			graph: refreshed.graph,
			activeClaims: refreshed.activeClaims,
			solvers,
			profiles,
			capacity: await this.options.readCapacity(challengeId),
		});
		const assignments = [...recovered];

		for (const assignment of plan.assignments) {
			if (assignment.reuseSolverId) {
				const intent = refreshed.graph.intents.find((item) => item.id === assignment.intentId);
				const profile = profiles.find((item) => item.id === assignment.profileId);
				if (intent && profile)
					assignments.push(await this.reuseAssignment(intent, profile, assignment.reuseSolverId));
				continue;
			}
			const intent = refreshed.graph.intents.find((item) => item.id === assignment.intentId);
			const profile = profiles.find((item) => item.id === assignment.profileId);
			if (!intent || !profile) continue;
			assignments.push(await this.startAssignment(intent, profile));
		}

		return { challengeId, plan, assignments };
	}

	private async reconcileClaimedIntents(
		intents: GraphIntent[],
		activeClaims: ReturnType<GraphService["readSchedulerState"]>["activeClaims"],
		profiles: SchedulerSolverProfile[],
	): Promise<SchedulerAssignmentResult[]> {
		const results: SchedulerAssignmentResult[] = [];
		const solvers = new Map(this.options.listSolvers().map((solver) => [solver.id, solver]));
		for (const claim of activeClaims) {
			const intent = intents.find((item) => item.id === claim.intentId);
			if (!intent || intent.status !== "claimed" || intent.version < 1) continue;
			const profile = profiles.find(
				(item) => schedulerSolverId(intent.challengeId, intent.id, intent.version - 1, item.id) === claim.solverId,
			);
			if (!profile) continue;
			const solver = solvers.get(claim.solverId);
			const lease = this.options.service.claimIntent({
				actor: { id: this.options.hostId, role: "host", challengeId: intent.challengeId },
				idempotencyKey: recoveryClaimIdempotencyKey(intent, claim.solverId),
				intentId: intent.id,
				solverId: claim.solverId,
				expectedVersion: intent.version - 1,
				leaseDurationMs: this.leaseDurationMs,
			});
			try {
				if (solver?.status === "running") {
					await this.options.bindSolverLease(solver.id, lease);
				} else if (!solver || solver.status === "stopped" || solver.status === "error") {
					await this.options.launchSolver({
						challengeId: intent.challengeId,
						profileId: profile.id,
						profileFingerprint: schedulerProfileFingerprint(profile),
						solverId: claim.solverId,
						lease,
						handoff: intentHandoff(intent),
					});
				} else {
					continue;
				}
				results.push({ intentId: intent.id, profileId: profile.id, solverId: claim.solverId, status: "recovered" });
			} catch (error) {
				await this.compensate(intent, lease);
				results.push({
					intentId: intent.id,
					profileId: profile.id,
					solverId: claim.solverId,
					status: "failed",
					error: safeError(error),
				});
			}
		}
		return results;
	}

	private async startAssignment(
		intent: GraphIntent,
		profile: SchedulerSolverProfile,
	): Promise<SchedulerAssignmentResult> {
		const profileId = profile.id;
		const solverId = schedulerSolverId(intent.challengeId, intent.id, intent.version, profileId);
		let lease: IntentLease | undefined;
		try {
			lease = this.options.service.claimIntent({
				actor: { id: this.options.hostId, role: "host", challengeId: intent.challengeId },
				idempotencyKey: claimIdempotencyKey(intent, solverId),
				intentId: intent.id,
				solverId,
				expectedVersion: intent.version,
				leaseDurationMs: this.leaseDurationMs,
			});
			await this.options.launchSolver({
				challengeId: intent.challengeId,
				profileId,
				profileFingerprint: schedulerProfileFingerprint(profile),
				solverId,
				lease,
				handoff: intentHandoff(intent),
			});
			return { intentId: intent.id, profileId, solverId, status: "started" };
		} catch (error) {
			if (lease) await this.compensate(intent, lease);
			return { intentId: intent.id, profileId, solverId, status: "failed", error: safeError(error) };
		}
	}

	private async reuseAssignment(
		intent: GraphIntent,
		profile: SchedulerSolverProfile,
		solverId: string,
	): Promise<SchedulerAssignmentResult> {
		const profileId = profile.id;
		let lease: IntentLease | undefined;
		let reuseError: unknown;
		try {
			const context = this.options.service.getIntentFocusedContext(intent.challengeId, intent.id);
			lease = this.options.service.claimIntent({
				actor: { id: this.options.hostId, role: "host", challengeId: intent.challengeId },
				idempotencyKey: `scheduler-reuse-claim:${intent.id}:${intent.version}:${solverId}`,
				intentId: intent.id,
				solverId,
				expectedVersion: intent.version,
				leaseDurationMs: this.leaseDurationMs,
			});
			await this.options.reuseSolver({
				solverId,
				profileId,
				profileFingerprint: schedulerProfileFingerprint(profile),
				lease,
				context: intentSwitchContext(intent, context),
			});
			return { intentId: intent.id, profileId, solverId, status: "reused" };
		} catch (error) {
			reuseError = error;
			if (lease) await this.compensate(intent, lease);
			else {
				try {
					await this.options.stopSolver(solverId);
				} catch {
					// The old Runtime may already have exited.
				}
			}
		}

		const refreshed = this.options.service.readSchedulerState(intent.challengeId);
		const currentIntent = refreshed.graph.intents.find((item) => item.id === intent.id);
		const capacity = await this.options.readCapacity(intent.challengeId);
		if (
			!currentIntent ||
			currentIntent.status !== "open" ||
			capacity.perChallengeSolverCap <= 0 ||
			capacity.globalRemainingSolverSlots <= 0
		) {
			return { intentId: intent.id, profileId, solverId, status: "failed", error: safeError(reuseError) };
		}
		const activeChallengeSolverCount = this.options
			.listSolvers()
			.filter(
				(solver) =>
					solver.challengeId === intent.challengeId && ["starting", "running", "stopping"].includes(solver.status),
			).length;
		if (activeChallengeSolverCount >= capacity.perChallengeSolverCap) {
			return { intentId: intent.id, profileId, solverId, status: "failed", error: safeError(reuseError) };
		}
		const fallback = await this.startAssignment(currentIntent, profile);
		if (fallback.status === "started") {
			return {
				...fallback,
				status: "fallback_started",
				error: safeError(reuseError),
			};
		}
		return {
			...fallback,
			error: `${safeError(reuseError)}; fallback: ${fallback.error ?? "failed"}`.slice(0, 240),
		};
	}

	private async compensate(intent: GraphIntent, lease: IntentLease): Promise<void> {
		try {
			await this.options.stopSolver(lease.solverId);
		} catch {
			// A missing or already stopped Runtime needs no further process action.
		}
		try {
			this.options.service.releaseClaimForRuntimeFailure({
				actor: { id: this.options.hostId, role: "host", challengeId: intent.challengeId },
				idempotencyKey: `scheduler-compensate:${intent.id}:${lease.generation}:${lease.solverId}`,
				intentId: intent.id,
				solverId: lease.solverId,
				generation: lease.generation,
				expectedVersion: lease.version,
			});
		} catch {
			// If acknowledgement already advanced the Intent, Runtime release or Lease expiry is authoritative.
		}
	}
}
