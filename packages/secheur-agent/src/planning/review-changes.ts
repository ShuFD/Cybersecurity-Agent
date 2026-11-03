import { createHash } from "node:crypto";
import type { PlanningSnapshot, PlanningTaskStatus } from "./contracts.ts";

/** IDs refer to the current run's authoritative records, not model-generated aliases. */
export interface PlanningChanges {
	initial: boolean;
	tasks: { taskId: string; status: PlanningTaskStatus }[];
	evidenceIds: string[];
	evidenceCardIds: string[];
	artexNodeIds: string[];
	hypothesisNodeIds: string[];
	checkpointId?: string;
}

export interface PlanningReviewState {
	tasks: Record<string, PlanningTaskStatus>;
	evidence: Record<string, string>;
	cards: Record<string, string>;
	artex: Record<string, string>;
	hypotheses: Record<string, string>;
	checkpoint: Record<string, string>;
}

function fingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function capturePlanningReview(snapshot: PlanningSnapshot): PlanningReviewState {
	return {
		tasks: Object.fromEntries(snapshot.tasks.map((task) => [task.taskId, task.status])),
		evidence: Object.fromEntries(snapshot.evidence.map((item) => [item.evidenceId, item.contentHash])),
		cards: Object.fromEntries((snapshot.evidenceCards ?? []).map((card) => [card.id, fingerprint(card)])),
		artex: Object.fromEntries(
			(snapshot.artexGraph?.nodes ?? [])
				.filter((node) => node.origin === "worker" && (node.kind === "fact" || node.kind === "finding"))
				.map((node) => [node.id, fingerprint([node.payload, node.evidenceRefs, node.confidence])]),
		),
		hypotheses: Object.fromEntries(
			(snapshot.hypothesisGraph?.nodes ?? []).map((node) => [
				node.id,
				fingerprint([node.status, node.basisRefs, node.verificationEvidenceRefs, node.needsReview]),
			]),
		),
		checkpoint: snapshot.latestCheckpoint ? { [snapshot.latestCheckpoint.checkpointId]: "present" } : {},
	};
}

function changedIds(current: Record<string, string>, reviewed: Record<string, string> = {}): string[] {
	return Object.keys(current).filter((id) => current[id] !== reviewed[id]);
}

/** A request owns only its input snapshot; arrivals during planning remain pending. */
export class PlanningReviewChanges {
	private reviewed: PlanningReviewState | undefined;

	changes(current: PlanningReviewState): PlanningChanges {
		return {
			initial: !this.reviewed,
			tasks: changedIds(current.tasks, this.reviewed?.tasks).map((taskId) => ({
				taskId,
				status: current.tasks[taskId],
			})),
			evidenceIds: changedIds(current.evidence, this.reviewed?.evidence),
			evidenceCardIds: changedIds(current.cards, this.reviewed?.cards),
			artexNodeIds: changedIds(current.artex, this.reviewed?.artex),
			hypothesisNodeIds: changedIds(current.hypotheses, this.reviewed?.hypotheses),
			checkpointId: changedIds(current.checkpoint, this.reviewed?.checkpoint)[0],
		};
	}

	acknowledge(input: PlanningReviewState, before = input, after = input): void {
		const reviewed = structuredClone(input);
		// Acknowledge the planner's own committed edits, not concurrent worker arrivals.
		for (const section of Object.keys(reviewed) as (keyof PlanningReviewState)[]) {
			for (const id of Object.keys(after[section])) {
				if (before[section][id] !== after[section][id]) {
					Object.assign(reviewed[section], { [id]: after[section][id] });
				}
			}
		}
		this.reviewed = reviewed;
	}

	wakeState(current: PlanningReviewState | undefined = this.reviewed): string {
		if (!current) return "";
		return JSON.stringify({
			...current,
			// Acquiring a lease is ownership bookkeeping; results and new knowledge still wake the planner.
			tasks: Object.fromEntries(
				Object.entries(current.tasks).map(([id, status]) => [
					id,
					["proposed", "ready", "leased", "running"].includes(status) ? "active" : status,
				]),
			),
		});
	}
}

/** Keep the delta small; all exact IDs remain available through the existing run catalog. */
export function planningChangesOverview(changes: PlanningChanges): Record<string, unknown> {
	const result: Record<string, unknown> = { initial: changes.initial, checkpointId: changes.checkpointId };
	for (const key of ["tasks", "evidenceIds", "evidenceCardIds", "artexNodeIds", "hypothesisNodeIds"] as const) {
		result[key] = changes[key].slice(-16);
		result[`${key}Omitted`] = Math.max(0, changes[key].length - 16);
	}
	return result;
}
