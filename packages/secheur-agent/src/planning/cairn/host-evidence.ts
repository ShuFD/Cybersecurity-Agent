import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PiToolExecution } from "../../subagent.ts";
import { acceptedNativeFlagVerification } from "../../verifier-contract.ts";
import type { TrustedPlanningVerification } from "../contracts.ts";
import {
	EVIDENCE_PAGE_SIZE,
	type EvidenceCardInput,
	PlanningEvidenceRepository,
	validateEvidencePage,
} from "../evidence-cards.ts";
import { readCompleteEvidenceBlob } from "../evidence-store.ts";
import { PlanningPersistenceError } from "../failures.ts";
import { boundedVerificationHistory, sharedVerificationHistory } from "../shared-feedback.ts";
import { captureToolEvidence } from "../tool-evidence.ts";
import type { IntentLease } from "./types.ts";

export interface CairnEvidence {
	evidenceId: string;
	runId: string;
	intentId: string;
	solverId: string;
	generation: number;
	toolCallId: string;
	toolName: string;
	isError: boolean;
	content: string;
	toolInput?: unknown;
	createdAt: number;
	contentComplete?: boolean;
	contentHash?: string;
}

/** Raw tool evidence is host-owned, never a Solver's claimed Fact or success. */
export class CairnHostEvidence {
	private readonly db: DatabaseSync;
	private readonly repository: PlanningEvidenceRepository;
	private readonly stateDir: string;
	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path);
		this.stateDir = dirname(path);
		this.repository = new PlanningEvidenceRepository(this.db);
		this.db.exec(`
   PRAGMA journal_mode=WAL;
   CREATE TABLE IF NOT EXISTS tool_evidence (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, intent_id TEXT NOT NULL,
    solver_id TEXT NOT NULL, generation INTEGER NOT NULL, call_id TEXT NOT NULL,
    tool_name TEXT NOT NULL, is_error INTEGER NOT NULL, content TEXT NOT NULL,
    created_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS evidence_run ON tool_evidence(run_id, created_at);
   CREATE TABLE IF NOT EXISTS tool_inputs (evidence_id TEXT PRIMARY KEY, input_json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS lifecycle (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
    event_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
	}
	close(): void {
		this.db.close();
	}
	save(lease: IntentLease, execution: PiToolExecution): CairnEvidence {
		const id =
			"cairn_ev_" +
			createHash("sha256")
				.update(
					JSON.stringify([
						lease.challengeId,
						lease.intentId,
						lease.solverId,
						lease.generation,
						execution.toolCallId,
					]),
				)
				.digest("hex");
		const prior = this.read(lease.challengeId, id);
		const input = captureToolEvidence(execution, {
			stateDir: this.stateDir,
			runId: lease.challengeId,
			leaseId: lease.solverId + ":" + lease.generation,
			evidenceId: id,
		});
		if (prior && !this.repository.get(lease.challengeId, id)) {
			if (
				prior.content !== JSON.stringify(execution.result) ||
				prior.toolName !== execution.toolName ||
				prior.isError !== execution.isError ||
				(prior.toolInput !== undefined &&
					JSON.stringify(prior.toolInput) !== JSON.stringify(execution.toolInput ?? null))
			)
				throw new PlanningPersistenceError("Conflicting tool result for one Cairn tool call");
			return prior;
		}
		try {
			this.repository.insert(
				{ runId: lease.challengeId, taskId: lease.intentId, leaseId: lease.solverId + ":" + lease.generation },
				{ ...input, metadata: { ...input.metadata, solverId: lease.solverId, generation: lease.generation } },
				id,
				Date.now(),
			);
		} catch (error) {
			throw new PlanningPersistenceError(
				"Conflicting tool result or Cairn original observation persistence failure",
				error,
			);
		}
		if (execution.toolName === "update_working_checkpoint" && !execution.isError)
			this.repository.publishDelivery(
				{ runId: lease.challengeId, taskId: lease.intentId, leaseId: lease.solverId + ":" + lease.generation },
				{ summary: JSON.stringify(execution.toolInput ?? {}), evidenceRefs: [id], scope: "checkpoint" },
			);
		return this.read(lease.challengeId, id)!;
	}

	read(runId: string, id: string): CairnEvidence | undefined {
		const saved = this.repository.get(runId, id);
		if (saved) {
			const payload = readCompleteEvidenceBlob({
				stateDir: this.stateDir,
				contentRef: saved.contentRef!,
				contentHash: saved.contentHash,
				runId,
				evidenceId: id,
				allowIncomplete: true,
			}) as { input?: unknown; result?: unknown; truncated?: boolean; head?: string; tail?: string };
			return {
				evidenceId: id,
				runId,
				intentId: saved.taskId,
				solverId: String(saved.metadata.solverId),
				generation: Number(saved.metadata.generation),
				toolCallId: String(saved.metadata.toolCallId),
				toolName: saved.toolName!,
				isError: saved.metadata.isError === true,
				content: JSON.stringify(saved.contentComplete ? payload.result : payload),
				toolInput: payload.input,
				createdAt: saved.createdAt,
				contentComplete: saved.contentComplete,
				contentHash: saved.contentHash,
			};
		}
		const row = this.db.prepare("SELECT * FROM tool_evidence WHERE run_id=? AND id=?").get(runId, id);
		if (!row) return undefined;
		const input = this.db.prepare("SELECT input_json FROM tool_inputs WHERE evidence_id=?").get(id);
		return {
			evidenceId: String(row.id),
			runId: String(row.run_id),
			intentId: String(row.intent_id),
			solverId: String(row.solver_id),
			generation: Number(row.generation),
			toolCallId: String(row.call_id),
			toolName: String(row.tool_name),
			isError: row.is_error === 1,
			content: String(row.content),
			...(input ? { toolInput: JSON.parse(String(input.input_json)) as unknown } : {}),
			createdAt: Number(row.created_at),
		};
	}
	list(runId: string, after = 0, limit = EVIDENCE_PAGE_SIZE) {
		validateEvidencePage(after, limit);
		// Old rows stay in place. New rows use the shared index; a stable offset
		// keeps existing numeric cursors valid without rewriting old evidence.
		const legacyEnd = Number(this.db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM tool_evidence").get()?.n ?? 0);
		const rows = this.db
			.prepare(
				"SELECT rowid AS sequence,id,intent_id,tool_name,is_error,created_at FROM tool_evidence WHERE run_id=? AND rowid>? UNION ALL SELECT rowid+? AS sequence,evidence_id AS id,task_id AS intent_id,tool_name,json_extract(metadata_json,'$.isError') AS is_error,created_at FROM planning_evidence WHERE run_id=? AND rowid+?>? ORDER BY sequence LIMIT ?",
			)
			.all(runId, after, legacyEnd, runId, legacyEnd, after, limit + 1);
		const selected = rows.slice(0, limit);
		return {
			items: selected.map((row) => ({
				sequence: Number(row.sequence),
				evidenceId: String(row.id),
				intentId: String(row.intent_id),
				toolName: String(row.tool_name),
				isError: row.is_error === 1,
				createdAt: Number(row.created_at),
			})),
			nextCursor: selected.length ? Number(selected.at(-1)!.sequence) : after,
			hasMore: rows.length > limit,
		};
	}
	publishCard(lease: IntentLease, input: EvidenceCardInput) {
		return this.repository.publish(
			{ runId: lease.challengeId, taskId: lease.intentId, leaseId: lease.solverId + ":" + lease.generation },
			input,
		);
	}
	publishFactCard(lease: IntentLease, fact: { statement: string; evidenceRefs: string[]; id?: string }): void {
		this.repository.publishDelivery(
			{ runId: lease.challengeId, taskId: lease.intentId, leaseId: lease.solverId + ":" + lease.generation },
			{
				summary: fact.statement,
				evidenceRefs: fact.evidenceRefs,
				scope: "intent delivery",
				keyValues: fact.id ? { cairnFactId: fact.id } : {},
			},
		);
	}

	listCards(runId: string, after = 0, limit = EVIDENCE_PAGE_SIZE) {
		return this.repository.listCards(runId, after, limit);
	}
	cards(runId: string) {
		return this.repository.allCards(runId);
	}
	verificationHistory(runId: string) {
		const rows = this.db
			.prepare(`
		 SELECT id AS evidence_id,created_at,rowid AS sequence FROM tool_evidence
		 WHERE run_id=? AND tool_name IN ('verify_flag','check_flag')
		 UNION ALL SELECT evidence_id,created_at,rowid+(SELECT COALESCE(MAX(rowid),0) FROM tool_evidence) AS sequence FROM planning_evidence
		 WHERE run_id=? AND source=tool_name AND tool_name IN ('verify_flag','check_flag')
		 ORDER BY created_at DESC,sequence DESC`)
			.all(runId, runId);
		return boundedVerificationHistory(
			rows.reverse().flatMap((row) => {
				const saved = this.repository.get(runId, String(row.evidence_id));
				if (saved) return sharedVerificationHistory([saved]);
				// Existing legacy observations stay in place and retain their original IDs.
				const old = this.read(runId, String(row.evidence_id));
				if (!old) return [];
				const result = JSON.parse(old.content) as {
					details?: {
						data?: { status?: string; verificationOutcome?: string; requestSent?: boolean };
						remainingAttempts?: number;
					};
				};
				return [
					{
						evidenceId: old.evidenceId,
						taskId: old.intentId,
						leaseId: old.solverId + ":" + old.generation,
						status: result.details?.data?.status ?? "unknown",
						verificationOutcome: result.details?.data?.verificationOutcome,
						requestSent: result.details?.data?.requestSent,
						remainingAttempts: result.details?.remainingAttempts,
					},
				];
			}),
		);
	}

	listAll(runId: string) {
		const items: ReturnType<CairnHostEvidence["list"]>["items"] = [];
		let cursor = 0;
		for (;;) {
			const page = this.list(runId, cursor, 100);
			items.push(...page.items);
			if (!page.hasMore) return items;
			cursor = page.nextCursor;
		}
	}
	proof(runId: string): TrustedPlanningVerification | undefined {
		const rows = this.db
			.prepare(`
		 SELECT id AS evidence_id,created_at FROM tool_evidence
		 WHERE run_id=? AND is_error=0 AND tool_name IN ('verify_flag','check_flag')
		 UNION ALL SELECT evidence_id,created_at FROM planning_evidence
		 WHERE run_id=? AND json_extract(metadata_json,'$.isError')=0 AND tool_name IN ('verify_flag','check_flag')
		 ORDER BY created_at`)
			.all(runId, runId);
		for (const row of rows) {
			const evidence = this.read(runId, String(row.evidence_id))!;
			if (evidence.contentComplete === false) continue;
			const accepted = acceptedNativeFlagVerification(
				evidence.toolName,
				evidence.isError,
				JSON.parse(evidence.content),
			);
			if (accepted)
				return {
					source: "planning_verifier_evidence",
					verificationOutcome: "correct",
					planningRunId: runId,
					taskId: evidence.intentId,
					leaseId: evidence.solverId + ":" + evidence.generation,
					evidenceId: evidence.evidenceId,
					evidenceCreatedAt: evidence.createdAt,
					...(accepted.challengeId ? { challengeId: accepted.challengeId } : {}),
				};
		}
		return undefined;
	}
	event(runId: string, type: string, payload: Record<string, unknown> = {}): void {
		this.db
			.prepare("INSERT INTO lifecycle(run_id,event_id,type,payload,created_at) VALUES(?,?,?,?,?)")
			.run(runId, randomUUID(), type, JSON.stringify({ ...payload, engine: "cairn", runId }), Date.now());
	}
	events(runId: string, cursor = 0, limit = 100) {
		const rows = this.db
			.prepare("SELECT * FROM lifecycle WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?")
			.all(runId, cursor, limit + 1);
		const selected = rows.slice(0, limit);
		return {
			events: selected.map((row) => ({
				eventId: String(row.event_id),
				runId,
				type: String(row.type),
				createdAt: Number(row.created_at),
				sequence: Number(row.sequence),
				payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
			})),
			nextCursor: selected.length ? Number(selected.at(-1)?.sequence) : cursor,
			hasMore: rows.length > limit,
		};
	}
	eventsCount(runId: string): number {
		return Number(this.db.prepare("SELECT COUNT(*) AS count FROM lifecycle WHERE run_id=?").get(runId)?.count ?? 0);
	}
	runStatus(runId: string): string {
		const row = this.db
			.prepare(
				"SELECT payload FROM lifecycle WHERE run_id=? AND type='cairn_run_end' ORDER BY sequence DESC LIMIT 1",
			)
			.get(runId);
		if (!row) return "running";
		const payload = JSON.parse(String(row.payload)) as Record<string, unknown>;
		return typeof payload.status === "string" ? payload.status : "unknown";
	}
}
