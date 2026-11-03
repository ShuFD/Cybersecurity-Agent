import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { observerTurnOverview } from "./readonly-overview.ts";

export const RUN_OBSERVER_POLICY = Object.freeze({
	cadence: 6,
	recentTurns: 10,
	reminderGap: 6,
	dedupeTurns: 12,
	memoryOverview: 12,
	ideasOverview: 8,
	maxReviewModelTurns: 3,
	maxRunBudgetFraction: 0.1,
});
export interface ObserverNote {
	topic: string;
	kind: "memory" | "idea" | "failure_boundary" | "question";
	text: string;
	evidenceIds: string[];
}
export interface ObserverSuggestion {
	completion?: "submitted" | "no_change" | "skipped";
	runId: string;
	baseVersion: number;
	/** Host-attached immutable source frontier; never trusted from model output. */
	sourceEvidenceIds?: string[];
	notes: ObserverNote[];
	reminders: Array<{ topic: string; text: string; evidenceIds: string[] }>;
	corrections: Array<{ factId: string; replacementFactId: string; evidenceIds: string[] }>;
}
export interface ObserverSnapshot {
	runId: string;
	version: number;
	evidenceIds: string[];
	context: Record<string, unknown>;
}
export interface RunObserverOptions {
	runId: string;
	stateDir: string;
	mode: "report" | "guidance";
	signal?: AbortSignal;
	snapshot(): ObserverSnapshot;
	beforeDispatch?: (signal?: AbortSignal) => Promise<void>;
	readEvidence?: (id: string, offset: number, limit: number) => unknown | Promise<unknown>;
	observe(
		input: ObserverSnapshot & { recent: Record<string, unknown[]> },
		signal: AbortSignal,
	): Promise<ObserverSuggestion>;
	/** Only independently supported host corrections may use the existing fact invalidation API. */
	validateCorrection?: (correction: ObserverSuggestion["corrections"][number]) => boolean;
	applyCorrection?: (correction: ObserverSuggestion["corrections"][number]) => void;
	onEvent?(type: string, payload: Record<string, unknown>): void;
}

/** One asynchronous observer per run, outside executor slots; never controls an executor lifecycle. */
export class PlanRunObserver {
	private turns = 0;
	private lastDispatch = 0;
	private active?: Promise<void>;
	private readonly recent = new Map<string, unknown[]>();
	private readonly notes = new Map<string, ObserverNote>();
	private readonly reminderHistory = new Map<string, number>();
	private lastReminder = -RUN_OBSERVER_POLICY.reminderGap;
	private readonly delivery = new Map<
		string,
		Array<{ text: string; baseVersion: number; evidenceIds: string[]; sourceEvidenceIds?: string[] }>
	>();
	private readonly control = new AbortController();
	private readonly directory: string;
	private readonly options: RunObserverOptions;
	constructor(options: RunObserverOptions) {
		this.options = options;
		this.directory = join(
			options.stateDir,
			"planning",
			"run-observer",
			createHash("sha256").update(options.runId).digest("hex"),
		);
		mkdirSync(this.directory, { recursive: true });
	}
	private event(type: string, payload: Record<string, unknown>): void {
		try {
			this.options.onEvent?.(type, { runId: this.options.runId, role: "observer", ...payload });
		} catch {
			/* Diagnostics only. */
		}
	}
	recordTurn(executorId: string, observation: unknown): void {
		if (this.control.signal.aborted || this.options.signal?.aborted) return;
		const recent = this.recent.get(executorId) ?? [];
		recent.push(observerTurnOverview(observation));
		this.recent.set(executorId, recent.slice(-RUN_OBSERVER_POLICY.recentTurns));
		if (this.recent.size > 2) {
			const oldest = this.recent.keys().next().value;
			if (oldest !== undefined) {
				this.recent.delete(oldest);
				this.delivery.delete(oldest);
			}
		}
		if (!this.delivery.has(executorId)) this.delivery.set(executorId, []);
		this.turns++;
		if (!this.active && this.turns - this.lastDispatch >= RUN_OBSERVER_POLICY.cadence) {
			this.lastDispatch = this.turns;
			this.active = this.dispatch().finally(() => {
				this.active = undefined;
			});
		}
	}
	private async dispatch(): Promise<void> {
		const signal = this.options.signal
			? AbortSignal.any([this.options.signal, this.control.signal])
			: this.control.signal;
		try {
			await this.options.beforeDispatch?.(signal);
			signal.throwIfAborted();
			const snapshot = this.options.snapshot();
			if (snapshot.runId !== this.options.runId) throw new Error("Observer snapshot belongs to another run");
			const suggestion = await this.options.observe(
				{ ...snapshot, recent: structuredClone(Object.fromEntries(this.recent)) },
				signal,
			);
			// Audit the original suggestion even when late, stale, shadowed or invalid.
			appendFileSync(
				join(this.directory, "suggestions.jsonl"),
				JSON.stringify({ at: Date.now(), turn: this.turns, suggestion }) + "\n",
				{ mode: 0o600 },
			);
			if (suggestion.completion === "skipped") {
				this.event("observer_review_skipped", { status: "skipped", reason: "auxiliary_call_budget" });
				return;
			}
			if (signal.aborted) {
				this.event("observer_suggestion_rejected", { reason: "run_ended" });
				return;
			}
			this.apply({ ...suggestion, sourceEvidenceIds: snapshot.evidenceIds });
		} catch (error) {
			this.event("observer_request_failed", { message: error instanceof Error ? error.message : String(error) });
		}
	}
	apply(suggestion: ObserverSuggestion): boolean {
		const current = this.options.snapshot();
		const references = [...suggestion.notes, ...suggestion.reminders, ...suggestion.corrections].flatMap(
			(item) => item.evidenceIds,
		);
		const allowed = new Set(current.evidenceIds);
		const rejection =
			this.control.signal.aborted || this.options.signal?.aborted
				? "run_ended"
				: suggestion.runId !== this.options.runId || current.runId !== this.options.runId
					? "wrong_run"
					: suggestion.baseVersion !== current.version &&
							(!suggestion.sourceEvidenceIds ||
								suggestion.corrections.length > 0 ||
								!suggestion.sourceEvidenceIds.every((id) => allowed.has(id)))
						? "stale_version"
						: references.some((id) => !allowed.has(id))
							? "unknown_evidence"
							: suggestion.notes.some(
										(note) => !note.topic.trim() || !note.text.trim() || !note.evidenceIds.length,
									)
								? "unsupported_note"
								: suggestion.reminders.some(
											(note) => !note.topic.trim() || !note.text.trim() || !note.evidenceIds.length,
										)
									? "unsupported_reminder"
									: suggestion.corrections.some(
												(correction) =>
													!correction.evidenceIds.length ||
													!this.options.applyCorrection ||
													!this.options.validateCorrection?.(correction),
											)
										? "unproved_correction"
										: undefined;
		if (rejection) {
			this.event("observer_suggestion_rejected", { reason: rejection });
			return false;
		}
		if (this.options.mode === "report") {
			this.event("observer_shadow_recorded", {
				status:
					suggestion.notes.length || suggestion.reminders.length || suggestion.corrections.length
						? "submitted"
						: "no_change",
				notes: suggestion.notes.length,
				reminders: suggestion.reminders.length,
				corrections: suggestion.corrections.length,
			});
			return true;
		}
		const next = new Map(this.notes);
		for (const note of suggestion.notes)
			next.set(`${note.kind}:${note.topic.trim().toLowerCase()}`, structuredClone(note));
		for (const correction of suggestion.corrections) {
			try {
				this.options.applyCorrection?.(correction);
				appendFileSync(
					join(this.directory, "corrections.jsonl"),
					JSON.stringify({
						runId: current.runId,
						sourceVersion: current.version,
						correction,
						status: "host_applied",
					}) + "\n",
					{ mode: 0o600 },
				);
				this.event("observer_correction_applied", { ...correction });
			} catch (error) {
				// Existing graph operations own their transactions. A later failure
				// must not pretend earlier durable corrections were rolled back.
				this.event("observer_correction_failed", {
					...correction,
					error: error instanceof Error ? error.message : String(error),
				});
				return false;
			}
		}
		const temporary = join(this.directory, "notes.json.tmp");
		writeFileSync(
			temporary,
			JSON.stringify({ runId: current.runId, sourceVersion: current.version, notes: [...next.values()] }),
			{ mode: 0o600 },
		);
		renameSync(temporary, join(this.directory, "notes.json"));
		this.notes.clear();
		for (const [key, value] of next) this.notes.set(key, value);
		if (this.turns - this.lastReminder >= RUN_OBSERVER_POLICY.reminderGap) {
			for (const reminder of suggestion.reminders) {
				const key = createHash("sha256")
					.update(JSON.stringify([reminder.topic.trim().toLowerCase(), reminder.text.trim().replace(/\s+/g, " ")]))
					.digest("hex");
				if (this.turns - (this.reminderHistory.get(key) ?? -Infinity) < RUN_OBSERVER_POLICY.dedupeTurns) continue;
				const text = `Observer suggestion (unverified): ${reminder.text}\nSources: ${reminder.evidenceIds.join(", ")}. A failure applies only to its stated boundary; keep pending tools running.`;
				for (const queue of this.delivery.values())
					queue.push({
						text,
						baseVersion: current.version,
						evidenceIds: reminder.evidenceIds,
						sourceEvidenceIds: suggestion.sourceEvidenceIds,
					});
				this.reminderHistory.set(key, this.turns);
				this.lastReminder = this.turns;
			}
		}
		this.event("observer_suggestion_applied", {
			notes: suggestion.notes.length,
			corrections: suggestion.corrections.length,
		});
		return true;
	}
	takeReminders(executorId: string): string[] {
		const queue = this.delivery.get(executorId) ?? [];
		this.delivery.set(executorId, []);
		if (this.control.signal.aborted || this.options.signal?.aborted) return [];
		const current = this.options.snapshot();
		const valid = queue.filter(
			(item) =>
				(item.baseVersion === current.version ||
					Boolean(item.sourceEvidenceIds?.every((id) => current.evidenceIds.includes(id)))) &&
				item.evidenceIds.every((id) => current.evidenceIds.includes(id)),
		);
		if (valid.length !== queue.length)
			this.event("observer_reminder_rejected", { reason: "stale_at_delivery", count: queue.length - valid.length });
		return valid.map((item) => item.text);
	}
	overview(): ObserverNote[] {
		return [...this.notes.values()]
			.filter((note) => note.kind !== "idea")
			.slice(-RUN_OBSERVER_POLICY.memoryOverview)
			.concat(
				[...this.notes.values()].filter((note) => note.kind === "idea").slice(-RUN_OBSERVER_POLICY.ideasOverview),
			);
	}
	async waitForIdle(): Promise<void> {
		await this.active;
	}
	close(): void {
		this.control.abort(new Error("Observer run ended"));
	}
}
