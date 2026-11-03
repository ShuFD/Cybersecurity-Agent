import type { CompetitionAuditVerdict, CompetitionEvent, CompetitionEventPayload } from "./competition-protocol.ts";
import type { CompetitionStore, StoredEvent } from "./competition-store.ts";

export interface CompetitionAuditResult {
	verdict: CompetitionAuditVerdict;
	reason: string;
	paused: boolean;
	confidence: number;
	maxAllowedConfidence: number;
	newEvidence: boolean;
}

export interface AuditCandidateInput {
	taskId: string;
	candidate: string;
	evidenceRefs: string[];
	confidence: number;
	candidateEventId?: string;
	now?: number;
}

const CONFIDENCE_CAPS = {
	none: 0.2,
	observation: 0.2,
	vulnerability_primitive: 0.55,
	local_exploit: 0.8,
	shell_proof: 0.95,
	platform_accepted: 1,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadRecord(event: StoredEvent): Record<string, unknown> {
	return isRecord(event.payload) ? event.payload : {};
}

function evidenceKind(event: StoredEvent): keyof typeof CONFIDENCE_CAPS {
	const kind = payloadRecord(event).kind;
	return typeof kind === "string" && kind in CONFIDENCE_CAPS ? (kind as keyof typeof CONFIDENCE_CAPS) : "observation";
}

function evidenceIds(events: StoredEvent[]): Set<string> {
	return new Set(
		events.flatMap((event) => {
			const id = payloadRecord(event).evidenceId;
			return typeof id === "string" && id ? [id] : [];
		}),
	);
}

function candidateEvidenceRefs(events: StoredEvent[]): Set<string> {
	return new Set(
		events.flatMap((event) => {
			const refs = payloadRecord(event).evidenceRefs;
			return Array.isArray(refs) ? refs.filter((ref): ref is string => typeof ref === "string") : [];
		}),
	);
}

export function maxEvidenceConfidence(events: StoredEvent[]): number {
	const evidence = events.filter((event) => event.type === "evidence");
	if (evidence.length === 0) return CONFIDENCE_CAPS.none;
	return Math.max(...evidence.map(evidenceKind).map((kind) => CONFIDENCE_CAPS[kind]));
}

export class CompetitionAuditObserver {
	private readonly store: CompetitionStore;
	private readonly maxAttemptsInWindow: number;
	private readonly windowMs: number;

	constructor(store: CompetitionStore, options: { maxAttemptsInWindow?: number; windowMs?: number } = {}) {
		this.store = store;
		this.maxAttemptsInWindow = Math.max(1, Math.trunc(options.maxAttemptsInWindow ?? 5));
		this.windowMs = Math.max(1_000, Math.trunc(options.windowMs ?? 10 * 60_000));
	}

	observe(event: CompetitionEvent, now = Date.now()): CompetitionAuditResult {
		if (event.type === "evidence") return this.observeEvidence(event, now);
		if (event.type === "progress_report") {
			const payload = event.payload as Extract<CompetitionEventPayload, { status: string }>;
			const result: CompetitionAuditResult = {
				verdict:
					payload.status === "blocked"
						? "stalled"
						: payload.status === "completed"
							? "progressing"
							: "progressing",
				reason: payload.summary,
				paused: payload.status === "blocked",
				confidence: payload.confidence,
				maxAllowedConfidence: maxEvidenceConfidence(this.store.evidence(event.taskId)),
				newEvidence: false,
			};
			this.persist(event.taskId, result, now);
			return result;
		}
		if (event.type === "blocked") {
			const payload = event.payload as Extract<CompetitionEventPayload, { reason: string; category: string }>;
			const result: CompetitionAuditResult = {
				verdict: payload.category === "environment" ? "environment_blocked" : "stalled",
				reason: payload.reason,
				paused: true,
				confidence: 0,
				maxAllowedConfidence: maxEvidenceConfidence(this.store.evidence(event.taskId)),
				newEvidence: false,
			};
			this.persist(event.taskId, result, now);
			return result;
		}
		if (event.type === "completed") {
			const payload = event.payload as Extract<CompetitionEventPayload, { summary: string; evidenceRefs: string[] }>;
			const result: CompetitionAuditResult = {
				verdict: "progressing",
				reason: payload.summary,
				paused: false,
				confidence: 0,
				maxAllowedConfidence: maxEvidenceConfidence(this.store.evidence(event.taskId)),
				newEvidence: false,
			};
			this.persist(event.taskId, result, now);
			return result;
		}
		return {
			verdict: "progressing",
			reason: `${event.type} recorded`,
			paused: false,
			confidence: 0,
			maxAllowedConfidence: maxEvidenceConfidence(this.store.evidence(event.taskId)),
			newEvidence: false,
		};
	}

	evaluateCandidate(input: AuditCandidateInput): CompetitionAuditResult {
		const now = input.now ?? Date.now();
		const evidence = this.store.evidence(input.taskId);
		const ids = evidenceIds(evidence);
		const missing = input.evidenceRefs.filter((ref) => !ids.has(ref));
		const maxAllowedConfidence = maxEvidenceConfidence(evidence);
		if (input.evidenceRefs.length === 0 || missing.length > 0) {
			const result: CompetitionAuditResult = {
				verdict: "format_blocked",
				reason:
					input.evidenceRefs.length === 0
						? "flag candidate has no evidence references"
						: `unknown evidence references: ${missing.join(", ")}`,
				paused: true,
				confidence: input.confidence,
				maxAllowedConfidence,
				newEvidence: false,
			};
			this.persist(input.taskId, result, now);
			return result;
		}
		const candidateEvents = this.store
			.listEvents(input.taskId)
			.filter((event) => event.eventId !== input.candidateEventId)
			.filter((event) => event.type === "flag_candidate" || event.type === "submit_request");
		const priorEvidence = candidateEvidenceRefs(candidateEvents);
		const newEvidence = input.evidenceRefs.some((ref) => !priorEvidence.has(ref));
		const repeatedCandidateCount = candidateEvents.filter((event) => {
			if (event.type !== "submit_request") return false;
			const candidate = payloadRecord(event).candidate;
			return typeof candidate === "string" && candidate.trim() === input.candidate.trim();
		}).length;
		if (input.confidence > maxAllowedConfidence) {
			const result: CompetitionAuditResult = {
				verdict: "guessing",
				reason: `confidence ${input.confidence.toFixed(3)} exceeds evidence cap ${maxAllowedConfidence.toFixed(3)}`,
				paused: true,
				confidence: input.confidence,
				maxAllowedConfidence,
				newEvidence,
			};
			this.persist(input.taskId, result, now);
			return result;
		}
		const recent = this.store.listSubmissions(input.taskId, this.maxAttemptsInWindow);
		const recentWindow = recent.filter(
			(submission) => submission.createdAt >= now - this.windowMs && submission.attemptNo > 0,
		);
		const repeated =
			recentWindow.length >= this.maxAttemptsInWindow ||
			(recentWindow.filter((submission) => submission.category === "incorrect").length >= 2 && !newEvidence) ||
			repeatedCandidateCount >= 1;
		const result: CompetitionAuditResult = repeated
			? {
					verdict: "guessing",
					reason: "submission threshold reached without materially new evidence",
					paused: true,
					confidence: input.confidence,
					maxAllowedConfidence,
					newEvidence,
				}
			: {
					verdict: "progressing",
					reason: "candidate is evidence-backed",
					paused: false,
					confidence: input.confidence,
					maxAllowedConfidence,
					newEvidence,
				};
		this.persist(input.taskId, result, now);
		return result;
	}

	onSubmissionResult(taskId: string, category: string, now = Date.now(), newEvidence = false): CompetitionAuditResult {
		const recentIncorrect = this.store
			.listSubmissions(taskId, this.maxAttemptsInWindow)
			.filter((submission) => submission.attemptNo > 0 && submission.category === "incorrect")
			.filter((submission) => submission.createdAt >= now - this.windowMs);
		const guessing = category === "incorrect" && recentIncorrect.length >= 2 && !newEvidence;
		const verdict: CompetitionAuditVerdict = guessing
			? "guessing"
			: category === "accepted"
				? "solved"
				: category === "format_mismatch"
					? "format_blocked"
					: category === "rate_limited" || category === "environment_error"
						? "environment_blocked"
						: category === "incorrect"
							? "progressing"
							: "stalled";
		const result: CompetitionAuditResult = {
			verdict,
			reason: guessing
				? "two incorrect submissions were made without materially new evidence"
				: `platform submission result: ${category}`,
			paused: guessing || verdict === "format_blocked" || verdict === "environment_blocked",
			confidence: category === "accepted" ? 1 : 0,
			maxAllowedConfidence: category === "accepted" ? 1 : maxEvidenceConfidence(this.store.evidence(taskId)),
			newEvidence,
		};
		this.persist(taskId, result, now);
		return result;
	}

	private observeEvidence(event: CompetitionEvent, now: number): CompetitionAuditResult {
		const payload = event.payload as Extract<CompetitionEventPayload, { kind: string; confidence?: number }>;
		const kind = payload.kind as keyof typeof CONFIDENCE_CAPS;
		const result: CompetitionAuditResult = {
			verdict: "progressing",
			reason: `evidence recorded: ${kind}`,
			paused: false,
			confidence: payload.confidence ?? CONFIDENCE_CAPS[kind],
			maxAllowedConfidence: Math.max(
				maxEvidenceConfidence(this.store.evidence(event.taskId)),
				CONFIDENCE_CAPS[kind],
			),
			newEvidence: true,
		};
		this.persist(event.taskId, result, now);
		return result;
	}

	private persist(taskId: string, result: CompetitionAuditResult, now: number): void {
		this.store.setAuditVerdict(taskId, result.verdict, result.reason, result.paused, result.confidence, now);
	}
}
