import type { PlanningEvidence } from "./contracts.ts";
import { EVIDENCE_PAGE_SIZE, type EvidenceCard, TASK_DELIVERY_PREVIEW_CHARS } from "./evidence-cards.ts";

export interface SharedVerificationEntry {
	evidenceId: string;
	taskId?: string;
	leaseId?: string;
	status: string;
	verificationOutcome?: string;
	requestSent?: boolean;
	remainingAttempts?: number;
}

export function boundedVerificationHistory(history: SharedVerificationEntry[]): SharedVerificationEntry[] {
	const retained = new Set(history.slice(-16).map((entry) => entry.evidenceId));
	// Repeated blocked calls must not evict the few actual verdicts from the
	// shared allowance. Keep the existing recent-event window for diagnostics.
	for (const entry of history)
		if (["correct", "incorrect"].includes(entry.status) && entry.requestSent !== false)
			retained.add(entry.evidenceId);
	return history.filter((entry) => retained.has(entry.evidenceId));
}

/** Host metadata only. Candidate contents remain available through the evidence ID. */
export function sharedVerificationHistory(evidence: PlanningEvidence[]): SharedVerificationEntry[] {
	return boundedVerificationHistory(
		evidence
			.filter(
				(item) =>
					item.kind === "tool" &&
					item.source === item.toolName &&
					["verify_flag", "check_flag"].includes(item.toolName ?? ""),
			)
			.map((item) => {
				const meta = item.metadata;
				return {
					evidenceId: item.evidenceId,
					taskId: item.taskId,
					leaseId: item.leaseId,
					status: typeof meta.verifierStatus === "string" ? meta.verifierStatus : "unknown",
					...(typeof meta.verificationOutcome === "string"
						? { verificationOutcome: meta.verificationOutcome }
						: {}),
					...(typeof meta.requestSent === "boolean" ? { requestSent: meta.requestSent } : {}),
					...(typeof meta.remainingAttempts === "number" ? { remainingAttempts: meta.remainingAttempts } : {}),
				};
			}),
	);
}

export function renderSharedVerificationHistory(history: SharedVerificationEntry[]): string {
	return history.length
		? `[Shared native verification history] ${JSON.stringify(history)}. Each evidenceId identifies the candidate and full response; read it when needed. Only incorrect is a wrong-answer verdict; duplicate, fresh_evidence_required and request errors are not new wrong verdicts. Correct a candidate using available evidence and feedback; do not resubmit an identical candidate. Remaining attempts are host-owned; these historical counts are not a new allowance. A local task report is not overall success.`
		: "";
}

/** Reuse delivery cards, preserving one latest report per task instead of a shared slot. */
export function renderSharedTaskProgress(cards: EvidenceCard[], taskId: string, maxBytes = 16_384): string {
	const latest = new Map<string, EvidenceCard>();
	for (const card of cards)
		if (["checkpoint", "task delivery", "intent delivery"].includes(card.scope)) {
			latest.delete(card.sourceTaskId);
			latest.set(card.sourceTaskId, card);
		}
	if (!latest.size) return "";
	const ordered = [...latest.values()].reverse();
	const own = latest.get(taskId);
	if (own) ordered.splice(ordered.indexOf(own), 1);
	if (own) ordered.unshift(own);
	const reports: Array<{ cardId: string; taskId: string; leaseId: string; summary: string; evidenceRefs: string[] }> =
		[];
	const heading =
		"[Shared task progress; executor reports, not verified facts. Full reports remain available through evidenceRefs.]\n";
	const view = { reports, totalTasks: latest.size, omittedTasks: latest.size };
	for (const card of ordered.slice(0, EVIDENCE_PAGE_SIZE)) {
		reports.push({
			cardId: card.id,
			taskId: card.sourceTaskId,
			leaseId: card.sourceLeaseId,
			summary: card.summary.slice(0, TASK_DELIVERY_PREVIEW_CHARS),
			evidenceRefs: card.evidenceRefs,
		});
		view.omittedTasks--;
		if (Buffer.byteLength(heading + JSON.stringify(view), "utf8") > Math.min(maxBytes, 16_384)) {
			reports.pop();
			view.omittedTasks++;
		}
	}
	return heading + JSON.stringify(view);
}
