import { createHash } from "node:crypto";
import type { PlanningEvidence, PlanningEvidenceInput } from "./contracts.ts";

export const EVIDENCE_PAGE_SIZE = 20;
export const EVIDENCE_MAX_PAGE_SIZE = 100;
export const EVIDENCE_CARD_MAX_REFS = 32;
export const TASK_DELIVERY_PREVIEW_CHARS = 600;

export interface EvidenceCard {
	id: string;
	summary: string;
	keyValues: Record<string, unknown>;
	scope: string;
	limitations: string;
	evidenceRefs: string[];
	basis?: "observed" | "inferred";
	sourceTaskId: string;
	sourceLeaseId: string;
	sourceHashes: Record<string, string>;
}
export type EvidenceCardInput = Omit<EvidenceCard, "id" | "sourceTaskId" | "sourceLeaseId" | "sourceHashes">;
export interface EvidenceOwner {
	runId: string;
	taskId: string;
	leaseId: string;
}

export function evidenceCardId(leaseId: string, input: EvidenceCardInput): string {
	return `card_${createHash("sha256")
		.update(`${leaseId}\0${JSON.stringify(input)}`)
		.digest("hex")
		.slice(0, 24)}`;
}

// Both existing SQLite drivers implement this synchronous subset. The caller
// owns transactions, leases and lifecycle events; this layer never schedules.
type SqlValue = string | number | null;
export interface EvidenceDatabase {
	exec(sql: string): void;
	prepare(sql: string): {
		get(...params: SqlValue[]): unknown;
		all(...params: SqlValue[]): unknown[];
		run(...params: SqlValue[]): unknown;
	};
}
export interface EvidenceRow {
	evidence_id: string;
	run_id: string;
	task_id: string;
	lease_id: string;
	kind: PlanningEvidence["kind"];
	source: string;
	summary: string;
	tool_name: string | null;
	excerpt: string | null;
	content_ref: string | null;
	content_hash: string;
	excerpt_hash: string | null;
	locator_json: string | null;
	content_bytes: number | null;
	is_truncated: number | null;
	metadata_json: string;
	created_at: number;
}
export function evidenceFromRow(row: EvidenceRow): PlanningEvidence {
	return {
		evidenceId: row.evidence_id,
		runId: row.run_id,
		taskId: row.task_id,
		leaseId: row.lease_id,
		kind: row.kind,
		source: row.source,
		toolName: row.tool_name ?? row.source,
		summary: row.summary,
		excerpt: row.excerpt ?? row.summary,
		contentRef: row.content_ref ?? null,
		contentHash: row.content_hash,
		excerptHash: row.excerpt_hash ?? null,
		locator: JSON.parse(row.locator_json ?? "{}"),
		contentBytes: Number(row.content_bytes ?? 0),
		contentComplete: row.is_truncated !== 1,
		isTruncated: row.is_truncated === 1,
		metadata: JSON.parse(row.metadata_json),
		createdAt: row.created_at,
	};
}

export function createEvidenceCard(
	owner: EvidenceOwner,
	input: EvidenceCardInput,
	findEvidence: (id: string) => Pick<PlanningEvidence, "runId" | "kind" | "contentHash"> | undefined,
): EvidenceCard {
	if (typeof input.summary !== "string" || !input.summary.trim()) throw new Error("Evidence card summary is required");
	// Retain the existing bounded-payload safeguard, but 30–50 characters is a
	// writing target, not a reason to discard a useful supported delivery.
	if (JSON.stringify(input).length > 20_000) throw new Error("Observation exceeds the bounded card size");
	if (!Array.isArray(input.evidenceRefs) || !input.evidenceRefs.length)
		throw new Error("Evidence card requires original evidence references");
	if (
		!input.keyValues ||
		typeof input.keyValues !== "object" ||
		Array.isArray(input.keyValues) ||
		typeof input.scope !== "string" ||
		typeof input.limitations !== "string" ||
		(input.basis !== undefined && input.basis !== "observed" && input.basis !== "inferred")
	)
		throw new Error("Invalid evidence card fields");
	const sourceHashes: Record<string, string> = {};
	for (const id of input.evidenceRefs) {
		const record = findEvidence(id);
		if (!record || record.runId !== owner.runId || record.kind !== "tool")
			throw new Error("Card must reference original same-run tool observations");
		sourceHashes[id] = record.contentHash;
	}
	return {
		...structuredClone(input),
		// Keep historical hypothesis card IDs stable.
		id: evidenceCardId(owner.leaseId, input),
		sourceTaskId: owner.taskId,
		sourceLeaseId: owner.leaseId,
		sourceHashes,
	};
}

export function planningEvidenceSchema(ownerReferences = false): string {
	return `CREATE TABLE IF NOT EXISTS planning_evidence (
		 evidence_id TEXT PRIMARY KEY, run_id TEXT NOT NULL${ownerReferences ? " REFERENCES planning_runs(run_id) ON DELETE CASCADE" : ""},
		 task_id TEXT NOT NULL${ownerReferences ? " REFERENCES planning_tasks(task_id) ON DELETE CASCADE" : ""},
		 lease_id TEXT NOT NULL${ownerReferences ? " REFERENCES planning_leases(lease_id) ON DELETE CASCADE" : ""},
		 kind TEXT NOT NULL, source TEXT NOT NULL, summary TEXT NOT NULL, tool_name TEXT,
		 excerpt TEXT NOT NULL DEFAULT '', content_ref TEXT, content_hash TEXT NOT NULL, excerpt_hash TEXT,
		 locator_json TEXT NOT NULL DEFAULT '{}', content_bytes INTEGER NOT NULL DEFAULT 0,
		 is_truncated INTEGER NOT NULL DEFAULT 1, metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL);
		 CREATE INDEX IF NOT EXISTS planning_evidence_run_idx ON planning_evidence(run_id, created_at);
		 CREATE TABLE IF NOT EXISTS planning_evidence_cards (
		 card_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, card_json TEXT NOT NULL);
		 CREATE INDEX IF NOT EXISTS planning_evidence_cards_run_idx ON planning_evidence_cards(run_id);`;
}

export class PlanningEvidenceRepository {
	private readonly db: EvidenceDatabase;
	constructor(db: EvidenceDatabase) {
		this.db = db;
		// Progressive already owns this table (including its foreign keys). Cairn
		// uses the same schema without creating fake planning tasks or leases.
		db.exec(planningEvidenceSchema());
	}
	insert(owner: EvidenceOwner, input: PlanningEvidenceInput, id: string, now: number, attemptFailed = false): boolean {
		const existing = this.get(owner.runId, id);
		const elsewhere = this.db.prepare("SELECT run_id FROM planning_evidence WHERE evidence_id=?").get(id);
		if (elsewhere && !existing) throw new Error(`Planning evidence identity is already bound to another run: ${id}`);
		if (existing) {
			if (
				existing.taskId !== owner.taskId ||
				existing.leaseId !== owner.leaseId ||
				existing.contentHash !== input.contentHash ||
				existing.toolName !== (input.toolName ?? input.source) ||
				existing.metadata.isError !== input.metadata?.isError
			)
				throw new Error(
					`Planning evidence identity is already bound to another run, task, lease, or content: ${id}`,
				);
			if (attemptFailed)
				this.db
					.prepare("UPDATE planning_evidence SET metadata_json=? WHERE evidence_id=?")
					.run(JSON.stringify({ ...existing.metadata, ...input.metadata, attemptFailed: true }), id);
			return false;
		}
		this.db
			.prepare(`INSERT INTO planning_evidence
		 (evidence_id,run_id,task_id,lease_id,kind,source,summary,tool_name,excerpt,content_ref,content_hash,
		 excerpt_hash,locator_json,content_bytes,is_truncated,metadata_json,created_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
			.run(
				id,
				owner.runId,
				owner.taskId,
				owner.leaseId,
				input.kind,
				input.source,
				input.summary,
				input.toolName ?? input.source,
				input.excerpt ?? input.summary,
				input.contentRef ?? null,
				input.contentHash,
				input.excerptHash ?? null,
				JSON.stringify(input.locator ?? {}),
				Number(input.contentBytes ?? 0),
				input.isTruncated === true || input.contentComplete === false ? 1 : 0,
				JSON.stringify({ ...input.metadata, ...(attemptFailed ? { attemptFailed: true } : {}) }),
				now,
			);
		return true;
	}
	get(runId: string, id: string): PlanningEvidence | undefined {
		const row = this.db.prepare("SELECT * FROM planning_evidence WHERE run_id=? AND evidence_id=?").get(runId, id) as
			| EvidenceRow
			| undefined;
		return row ? evidenceFromRow(row) : undefined;
	}
	publish(owner: EvidenceOwner, input: EvidenceCardInput): EvidenceCard {
		const card = createEvidenceCard(owner, input, (id) => this.get(owner.runId, id));
		const prior = this.db
			.prepare("SELECT run_id,card_json FROM planning_evidence_cards WHERE card_id=?")
			.get(card.id) as { run_id: string; card_json: string } | undefined;
		// Cairn reuses a solver across intents; its displayed lease ID can repeat.
		// Preserve existing IDs, but namespace a collision by the complete owner.
		if (prior && (prior.run_id !== owner.runId || JSON.parse(prior.card_json).sourceTaskId !== owner.taskId))
			card.id = `card_${createHash("sha256")
				.update(JSON.stringify([owner.runId, owner.taskId, owner.leaseId, input]))
				.digest("hex")
				.slice(0, 24)}`;
		this.saveCard(owner.runId, card);
		return card;
	}
	publishDelivery(
		owner: EvidenceOwner,
		input: { summary: string; evidenceRefs: string[]; scope: string; keyValues?: Record<string, unknown> },
	): EvidenceCard[] {
		const refs = input.evidenceRefs.filter((id) => this.get(owner.runId, id)?.kind === "tool");
		if (!input.summary.trim()) return [];
		const cards: EvidenceCard[] = [];
		// Existing deliveries allow more references than one card. Preserve all
		// of them in bounded groups rather than rejecting an accepted delivery.
		for (let offset = 0; offset < refs.length; offset += EVIDENCE_CARD_MAX_REFS)
			cards.push(
				this.publish(owner, {
					summary: input.summary.slice(0, TASK_DELIVERY_PREVIEW_CHARS),
					keyValues: {
						...input.keyValues,
						deliveryDetailOmitted: input.summary.length > TASK_DELIVERY_PREVIEW_CHARS,
					},
					scope: input.scope,
					limitations:
						"Executor delivery; full text retained in checkpoint/result or Fact; semantic verification not performed",
					evidenceRefs: refs.slice(offset, offset + EVIDENCE_CARD_MAX_REFS),
				}),
			);
		return cards;
	}
	saveCard(runId: string, card: EvidenceCard): void {
		const prior = this.db
			.prepare("SELECT run_id,card_json FROM planning_evidence_cards WHERE card_id=?")
			.get(card.id) as { run_id: string; card_json: string } | undefined;
		if (prior && (prior.run_id !== runId || prior.card_json !== JSON.stringify(card)))
			throw new Error("Conflicting evidence card identity");
		if (!prior)
			this.db
				.prepare("INSERT INTO planning_evidence_cards VALUES (?,?,?,?)")
				.run(card.id, runId, card.sourceTaskId, JSON.stringify(card));
	}
	listCards(runId: string, after = 0, limit = EVIDENCE_PAGE_SIZE) {
		validateEvidencePage(after, limit);
		const rows = this.db
			.prepare(
				"SELECT rowid AS sequence,card_json FROM planning_evidence_cards WHERE run_id=? AND rowid>? ORDER BY rowid LIMIT ?",
			)
			.all(runId, after, limit + 1) as { sequence: number; card_json: string }[];
		const selected = rows.slice(0, limit);
		return {
			items: selected.map((row) => JSON.parse(row.card_json) as EvidenceCard),
			nextCursor: selected.length ? Number(selected.at(-1)!.sequence) : after,
			hasMore: rows.length > limit,
		};
	}
	allCards(runId: string): EvidenceCard[] {
		return this.db
			.prepare("SELECT card_json FROM planning_evidence_cards WHERE run_id=? ORDER BY rowid")
			.all(runId)
			.map((row) => JSON.parse((row as { card_json: string }).card_json) as EvidenceCard);
	}
}

export function validateEvidencePage(after: number, limit: number): void {
	if (
		!Number.isSafeInteger(after) ||
		after < 0 ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > EVIDENCE_MAX_PAGE_SIZE
	)
		throw new Error("Evidence cursor/limit must be valid integers; limit 1..100");
}

/** A compact common board, never raw tool input/output. Full cards remain paged. */
export function evidenceBoardView(cards: EvidenceCard[]) {
	return {
		cards: cards.slice(-EVIDENCE_PAGE_SIZE).map((card) => ({
			...card,
			keyValues: Object.fromEntries(
				Object.entries(card.keyValues).map(([key, value]) => [
					key,
					JSON.stringify(value).length <= 512
						? value
						: { detailOmitted: true, sourceEvidenceRefs: card.evidenceRefs },
				]),
			),
		})),
		totalCount: cards.length,
		omittedCount: Math.max(0, cards.length - EVIDENCE_PAGE_SIZE),
		semanticVerification: "not_performed",
	};
}
