import type { IntentLease, IntentSessionTag } from "./types.ts";

export type IntentSessionPhase = "active" | "checkpointed" | "released" | "preparing";

export interface IntentSessionSnapshot {
	solverId: string;
	tag: IntentSessionTag;
	phase: IntentSessionPhase;
	reuseReady: boolean;
}

interface IntentSessionRecord extends IntentSessionSnapshot {}

function sameTag(left: IntentSessionTag, right: IntentSessionTag): boolean {
	return (
		left.challengeId === right.challengeId &&
		left.intentId === right.intentId &&
		left.generation === right.generation &&
		left.sessionEpoch === right.sessionEpoch
	);
}

/**
 * Host-only lifecycle state. Lease bearer tokens deliberately remain in the
 * IntentLeaseController and never enter this public session identity.
 */
export class IntentSessionController {
	private readonly sessions = new Map<string, IntentSessionRecord>();

	prepare(lease: IntentLease): IntentSessionTag {
		const current = this.sessions.get(lease.solverId);
		if (!current || current.phase !== "checkpointed" || current.tag.challengeId !== lease.challengeId) {
			throw new Error("Solver Intent session is not safely reusable");
		}
		const tag: IntentSessionTag = {
			challengeId: lease.challengeId,
			intentId: lease.intentId,
			generation: lease.generation,
			sessionEpoch: current.tag.sessionEpoch + 1,
		};
		this.sessions.set(lease.solverId, { solverId: lease.solverId, tag, phase: "preparing", reuseReady: false });
		return tag;
	}

	bind(lease: IntentLease, prepared?: IntentSessionTag): IntentSessionTag {
		const current = this.sessions.get(lease.solverId);
		if (
			!prepared &&
			current?.phase === "active" &&
			current.tag.challengeId === lease.challengeId &&
			current.tag.intentId === lease.intentId &&
			current.tag.generation === lease.generation
		) {
			return { ...current.tag };
		}
		const tag = prepared ?? {
			challengeId: lease.challengeId,
			intentId: lease.intentId,
			generation: lease.generation,
			sessionEpoch: (current?.tag.sessionEpoch ?? 0) + 1,
		};
		if (
			tag.challengeId !== lease.challengeId ||
			tag.intentId !== lease.intentId ||
			tag.generation !== lease.generation
		) {
			throw new Error("Intent session tag does not match Lease");
		}
		if (prepared && (!current || current.phase !== "preparing" || !sameTag(current.tag, prepared))) {
			throw new Error("Prepared Intent session is stale");
		}
		this.sessions.set(lease.solverId, { solverId: lease.solverId, tag, phase: "active", reuseReady: false });
		return tag;
	}

	finish(solverId: string, reusable: boolean): void {
		const current = this.sessions.get(solverId);
		if (!current) return;
		this.sessions.set(solverId, {
			...current,
			phase: reusable ? "checkpointed" : "released",
			reuseReady: reusable,
		});
	}

	isCurrent(solverId: string, tag: IntentSessionTag | undefined): boolean {
		const current = this.sessions.get(solverId);
		return !!tag && !!current && current.phase === "active" && sameTag(current.tag, tag);
	}

	get(solverId: string): IntentSessionSnapshot | undefined {
		const current = this.sessions.get(solverId);
		return current ? { ...current, tag: { ...current.tag } } : undefined;
	}

	clear(solverId: string): void {
		this.sessions.delete(solverId);
	}
}
