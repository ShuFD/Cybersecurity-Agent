/** Adapted from sxd-git1/cairnpilot b015733fa117aa35f2406b8b31fd1bbf84d3ec6e.
 * Apache-2.0; see vendor/cairnpilot/LICENSE and NOTICE.md. */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	GRAPH_SCHEMA_SQL,
	GRAPH_SCHEMA_V1_SQL,
	GRAPH_SCHEMA_V2_SQL,
	GRAPH_SCHEMA_V3_SQL,
	GRAPH_SCHEMA_V4_SQL,
	GRAPH_SCHEMA_V5_SQL,
	GRAPH_SCHEMA_V6_SQL,
	GRAPH_SCHEMA_VERSION,
	goalStateFromRow,
	graphEventFromRow,
	graphFactFromRow,
	graphHintFromRow,
	graphIntentFromRow,
} from "./schema.ts";
import type {
	ChallengeGraphSnapshot,
	FactCandidate,
	GraphArtifact,
	GraphEvent,
	GraphFact,
	GraphHint,
	GraphIntent,
	IntentCandidate,
	IntentClaim,
	IntentClaimStatus,
	ReasonLeaseRecord,
	ReasonLeaseStatus,
	ReasonProposal,
	ReasonProposalApplyResult,
	ReasonTrigger,
	ShadowMigrationBatch,
	ShadowMigrationWriteResult,
} from "./types.ts";

export const DEFAULT_GRAPH_DATABASE_PATH = resolve(homedir(), ".secheur-agent", "cairn", "graph.db");

export interface OpenShadowGraphStoreOptions {
	shadowEnabled?: boolean;
	databasePath?: string;
}

interface ChangesResult {
	changes: number;
}

type EntityType = "fact" | "hint" | "intent";

export class GraphStore {
	private readonly database: DatabaseSync;
	private initialized = false;

	readonly databasePath: string;
	constructor(databasePath: string) {
		this.databasePath = databasePath;
		mkdirSync(dirname(databasePath), { recursive: true });
		this.database = new DatabaseSync(databasePath);
	}

	initialize(): void {
		const version = this.getRow<{ user_version: number }>("PRAGMA user_version").user_version;
		if (version > GRAPH_SCHEMA_VERSION) {
			throw new Error(`graph schema version ${version} is newer than supported version ${GRAPH_SCHEMA_VERSION}`);
		}
		if (
			version !== 0 &&
			version !== 1 &&
			version !== 2 &&
			version !== 3 &&
			version !== 4 &&
			version !== 5 &&
			version !== GRAPH_SCHEMA_VERSION
		) {
			throw new Error(`unsupported graph schema version ${version}`);
		}

		this.database.exec("PRAGMA journal_mode = WAL");
		this.database.exec("PRAGMA foreign_keys = ON");
		if (version === 0) {
			this.database.exec("BEGIN IMMEDIATE");
			try {
				this.database.exec(GRAPH_SCHEMA_SQL);
				this.run(
					"INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)",
					1,
					"2026-06-14T00:00:00.000Z",
				);
				this.run(
					"INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)",
					2,
					"2026-06-14T00:00:00.000Z",
				);
				this.run(
					"INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)",
					3,
					"2026-06-15T00:00:00.000Z",
				);
				this.run(
					"INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)",
					4,
					"2026-06-15T00:00:00.000Z",
				);
				this.run(
					"INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)",
					5,
					"2026-06-15T00:00:00.000Z",
				);
				this.run(
					"INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)",
					6,
					"2026-06-17T00:00:00.000Z",
				);
				this.database.exec(`PRAGMA user_version = ${GRAPH_SCHEMA_VERSION}`);
				this.database.exec("COMMIT");
			} catch (error) {
				if (this.database.isTransaction) this.database.exec("ROLLBACK");
				throw error;
			}
		} else if (version === 1) {
			this.database.exec("BEGIN IMMEDIATE");
			try {
				this.database.exec(GRAPH_SCHEMA_V1_SQL);
				this.database.exec(GRAPH_SCHEMA_V2_SQL);
				this.run(
					"INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)",
					2,
					"2026-06-14T00:00:00.000Z",
				);
				this.database.exec(GRAPH_SCHEMA_V3_SQL);
				this.run(
					"INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)",
					3,
					"2026-06-15T00:00:00.000Z",
				);
				this.database.exec(GRAPH_SCHEMA_V4_SQL);
				this.run(
					"INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)",
					4,
					"2026-06-15T00:00:00.000Z",
				);
				this.database.exec(GRAPH_SCHEMA_V5_SQL);
				this.run(
					"INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)",
					5,
					"2026-06-15T00:00:00.000Z",
				);
				this.database.exec(GRAPH_SCHEMA_V6_SQL);
				this.run(
					"INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)",
					6,
					"2026-06-17T00:00:00.000Z",
				);
				this.database.exec(`PRAGMA user_version = ${GRAPH_SCHEMA_VERSION}`);
				this.database.exec("COMMIT");
			} catch (error) {
				if (this.database.isTransaction) this.database.exec("ROLLBACK");
				throw error;
			}
		} else if (version === 2) {
			this.database.exec("BEGIN IMMEDIATE");
			try {
				this.database.exec(GRAPH_SCHEMA_V3_SQL);
				this.run(
					"INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)",
					3,
					"2026-06-15T00:00:00.000Z",
				);
				this.database.exec(GRAPH_SCHEMA_V4_SQL);
				this.run(
					"INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)",
					4,
					"2026-06-15T00:00:00.000Z",
				);
				this.database.exec(GRAPH_SCHEMA_V5_SQL);
				this.run(
					"INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)",
					5,
					"2026-06-15T00:00:00.000Z",
				);
				this.database.exec(GRAPH_SCHEMA_V6_SQL);
				this.run(
					"INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)",
					6,
					"2026-06-17T00:00:00.000Z",
				);
				this.database.exec(`PRAGMA user_version = ${GRAPH_SCHEMA_VERSION}`);
				this.database.exec("COMMIT");
			} catch (error) {
				if (this.database.isTransaction) this.database.exec("ROLLBACK");
				throw error;
			}
		} else if (version === 3) {
			this.database.exec("BEGIN IMMEDIATE");
			try {
				this.database.exec(GRAPH_SCHEMA_V4_SQL);
				this.run(
					"INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)",
					4,
					"2026-06-15T00:00:00.000Z",
				);
				this.database.exec(GRAPH_SCHEMA_V5_SQL);
				this.run(
					"INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)",
					5,
					"2026-06-15T00:00:00.000Z",
				);
				this.database.exec(GRAPH_SCHEMA_V6_SQL);
				this.run(
					"INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)",
					6,
					"2026-06-17T00:00:00.000Z",
				);
				this.database.exec(`PRAGMA user_version = ${GRAPH_SCHEMA_VERSION}`);
				this.database.exec("COMMIT");
			} catch (error) {
				if (this.database.isTransaction) this.database.exec("ROLLBACK");
				throw error;
			}
		} else if (version === 4) {
			this.database.exec("BEGIN IMMEDIATE");
			try {
				this.database.exec(GRAPH_SCHEMA_V5_SQL);
				this.run(
					"INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)",
					5,
					"2026-06-15T00:00:00.000Z",
				);
				this.database.exec(GRAPH_SCHEMA_V6_SQL);
				this.run(
					"INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)",
					6,
					"2026-06-17T00:00:00.000Z",
				);
				this.database.exec(`PRAGMA user_version = ${GRAPH_SCHEMA_VERSION}`);
				this.database.exec("COMMIT");
			} catch (error) {
				if (this.database.isTransaction) this.database.exec("ROLLBACK");
				throw error;
			}
		} else if (version === 5) {
			this.database.exec("BEGIN IMMEDIATE");
			try {
				this.database.exec(GRAPH_SCHEMA_V6_SQL);
				this.run(
					"INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)",
					6,
					"2026-06-17T00:00:00.000Z",
				);
				this.database.exec(`PRAGMA user_version = ${GRAPH_SCHEMA_VERSION}`);
				this.database.exec("COMMIT");
			} catch (error) {
				if (this.database.isTransaction) this.database.exec("ROLLBACK");
				throw error;
			}
		} else {
			this.database.exec(GRAPH_SCHEMA_SQL);
		}
		this.initialized = true;
	}

	close(): void {
		this.database.close();
		this.initialized = false;
	}

	readPragmas(): { journalMode: string; foreignKeys: boolean; schemaVersion: number } {
		this.requireInitialized();
		const journal = this.getRow<{ journal_mode: string }>("PRAGMA journal_mode");
		const foreignKeys = this.getRow<{ foreign_keys: number }>("PRAGMA foreign_keys");
		const schemaVersion = this.getRow<{ user_version: number }>("PRAGMA user_version");
		return {
			journalMode: journal.journal_mode,
			foreignKeys: foreignKeys.foreign_keys === 1,
			schemaVersion: schemaVersion.user_version,
		};
	}

	readChallengeGraph(challengeId: string): ChallengeGraphSnapshot {
		this.requireInitialized();
		const factRows = this.allRows<Parameters<typeof graphFactFromRow>[0]>(
			`SELECT facts.* FROM facts
                 JOIN shadow_current_entities current
                   ON current.challenge_id = facts.challenge_id
                  AND current.entity_type = 'fact'
                  AND current.entity_id = facts.id
                 WHERE facts.challenge_id = ?
                 ORDER BY facts.id`,
			challengeId,
		);
		const facts = factRows.map((row) =>
			graphFactFromRow(
				row,
				this.readRelationIds("fact_evidence", "evidence_ref", challengeId, "fact_id", row.id),
				this.readRelationIds("fact_memory_sources", "memory_id", challengeId, "fact_id", row.id),
			),
		);

		const hintRows = this.allRows<Parameters<typeof graphHintFromRow>[0]>(
			`SELECT hints.* FROM hints
                 JOIN shadow_current_entities current
                   ON current.challenge_id = hints.challenge_id
                  AND current.entity_type = 'hint'
                  AND current.entity_id = hints.id
                 WHERE hints.challenge_id = ?
                 ORDER BY hints.id`,
			challengeId,
		);
		const hints = hintRows.map((row) =>
			graphHintFromRow(
				row,
				this.readRelationIds("hint_memory_sources", "memory_id", challengeId, "hint_id", row.id),
			),
		);

		const intentRows = this.allRows<Parameters<typeof graphIntentFromRow>[0]>(
			`SELECT intents.* FROM intents
                 JOIN shadow_current_entities current
                   ON current.challenge_id = intents.challenge_id
                  AND current.entity_type = 'intent'
                  AND current.entity_id = intents.id
                 WHERE intents.challenge_id = ?
                 ORDER BY intents.id`,
			challengeId,
		);
		const intents = intentRows.map((row) =>
			graphIntentFromRow(
				row,
				this.readRelationIds("intent_sources", "fact_id", challengeId, "intent_id", row.id),
				this.readRelationIds("intent_hint_sources", "hint_id", challengeId, "intent_id", row.id),
				this.readRelationIds("intent_results", "fact_id", challengeId, "intent_id", row.id),
				this.readRelationIds("intent_idea_sources", "idea_id", challengeId, "intent_id", row.id),
			),
		);
		const goalRow = this.getOptionalRow<Parameters<typeof goalStateFromRow>[0]>(
			"SELECT * FROM challenge_goal_states WHERE challenge_id = ?",
			challengeId,
		);
		return {
			challengeId,
			facts,
			hints,
			intents,
			goalState: goalRow ? goalStateFromRow(goalRow) : undefined,
		};
	}

	readEventsAfter(challengeId: string, sequence: number, limit?: number): GraphEvent[] {
		this.requireInitialized();
		if (limit !== undefined) {
			return this.allRows<Parameters<typeof graphEventFromRow>[0]>(
				"SELECT * FROM graph_events WHERE challenge_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
				challengeId,
				sequence,
				limit,
			).map(graphEventFromRow);
		}
		return this.allRows<Parameters<typeof graphEventFromRow>[0]>(
			"SELECT * FROM graph_events WHERE challenge_id = ? AND sequence > ? ORDER BY sequence",
			challengeId,
			sequence,
		).map(graphEventFromRow);
	}

	getLatestEventSequence(challengeId?: string): number {
		this.requireInitialized();
		const row = challengeId
			? this.getRow<{ sequence: number }>(
					"SELECT COALESCE(MAX(sequence), 0) AS sequence FROM graph_events WHERE challenge_id = ?",
					challengeId,
				)
			: this.getRow<{ sequence: number }>("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM graph_events");
		return row.sequence;
	}

	executeServiceTransaction<T>(operation: () => T): T {
		this.requireInitialized();
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			if (this.database.isTransaction) this.database.exec("ROLLBACK");
			throw error;
		}
	}

	ensureServiceChallenge(challengeId: string): void {
		this.run("INSERT OR IGNORE INTO challenges (id) VALUES (?)", challengeId);
	}

	readIdempotencyRecord(
		challengeId: string,
		operation: string,
		idempotencyKey: string,
	): { payloadHash: string; result: unknown } | undefined {
		const row = this.getOptionalRow<{ payload_hash: string; result_json: string }>(
			"SELECT payload_hash, result_json FROM idempotency_records WHERE challenge_id = ? AND operation = ? AND idempotency_key = ?",
			challengeId,
			operation,
			idempotencyKey,
		);
		return row ? { payloadHash: row.payload_hash, result: JSON.parse(row.result_json) as unknown } : undefined;
	}

	writeIdempotencyRecord(input: {
		challengeId: string;
		operation: string;
		idempotencyKey: string;
		payloadHash: string;
		result: unknown;
		createdAt: string;
	}): void {
		this.run(
			`INSERT INTO idempotency_records
             (challenge_id, operation, idempotency_key, payload_hash, result_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
			input.challengeId,
			input.operation,
			input.idempotencyKey,
			input.payloadHash,
			JSON.stringify(input.result),
			input.createdAt,
		);
	}

	readFactCandidate(challengeId: string, id: string): FactCandidate | undefined {
		const row = this.getOptionalRow<Record<string, unknown>>(
			"SELECT * FROM fact_candidates WHERE challenge_id = ? AND id = ?",
			challengeId,
			id,
		);
		return row ? this.factCandidateFromRow(row) : undefined;
	}

	insertFactCandidate(candidate: FactCandidate): void {
		this.assertEntityOwner("fact_candidates", candidate.id, candidate.challengeId, "fact candidate");
		this.run(
			`INSERT INTO fact_candidates (
                id, challenge_id, kind, statement, confidence, evidence_refs_json, source_event_ids_json,
                source_actor_id, source_role, status, result_fact_id, merged_into_candidate_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			candidate.id,
			candidate.challengeId,
			candidate.kind,
			candidate.statement,
			candidate.confidence,
			JSON.stringify(candidate.evidenceRefs),
			JSON.stringify(candidate.sourceEventIds),
			candidate.sourceActorId,
			candidate.sourceRole,
			candidate.status,
			candidate.resultFactId ?? null,
			candidate.mergedIntoCandidateId ?? null,
			candidate.createdAt,
			candidate.updatedAt,
		);
	}

	confirmFactCandidate(challengeId: string, candidateId: string, factId: string, updatedAt: string): void {
		const result = this.run(
			`UPDATE fact_candidates SET status = 'confirmed', result_fact_id = ?, updated_at = ?
             WHERE challenge_id = ? AND id = ? AND status = 'proposed'`,
			factId,
			updatedAt,
			challengeId,
			candidateId,
		);
		if (result.changes !== 1) throw new Error(`fact candidate ${candidateId} is not proposed`);
	}

	readIntentCandidate(challengeId: string, id: string): IntentCandidate | undefined {
		const row = this.getOptionalRow<Record<string, unknown>>(
			"SELECT * FROM intent_candidates WHERE challenge_id = ? AND id = ?",
			challengeId,
			id,
		);
		return row ? this.intentCandidateFromRow(row) : undefined;
	}

	insertIntentCandidate(candidate: IntentCandidate): void {
		this.assertEntityOwner("intent_candidates", candidate.id, candidate.challengeId, "intent candidate");
		this.run(
			`INSERT INTO intent_candidates (
                id, challenge_id, objective, scope, confidence, from_fact_ids_json, source_hint_ids_json,
                capability_tags_json, source_event_ids_json, source_actor_id, source_role, status,
                result_intent_id, merged_into_candidate_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			candidate.id,
			candidate.challengeId,
			candidate.objective,
			candidate.scope,
			candidate.confidence,
			JSON.stringify(candidate.fromFactIds),
			JSON.stringify(candidate.sourceHintIds),
			JSON.stringify(candidate.capabilityTags),
			JSON.stringify(candidate.sourceEventIds),
			candidate.sourceActorId,
			candidate.sourceRole,
			candidate.status,
			candidate.resultIntentId ?? null,
			candidate.mergedIntoCandidateId ?? null,
			candidate.createdAt,
			candidate.updatedAt,
		);
	}

	confirmIntentCandidate(challengeId: string, candidateId: string, intentId: string, updatedAt: string): void {
		const result = this.run(
			`UPDATE intent_candidates SET status = 'confirmed', result_intent_id = ?, updated_at = ?
             WHERE challenge_id = ? AND id = ? AND status = 'proposed'`,
			intentId,
			updatedAt,
			challengeId,
			candidateId,
		);
		if (result.changes !== 1) throw new Error(`intent candidate ${candidateId} is not proposed`);
	}

	insertServiceFact(fact: GraphFact): void {
		this.assertEntityOwner("facts", fact.id, fact.challengeId, "fact");
		this.run(
			`INSERT INTO facts (
                id, challenge_id, kind, statement, source_solver_id, produced_by_intent_id, fingerprint,
                status, invalidated_by_fact_id, observed_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			fact.id,
			fact.challengeId,
			fact.kind,
			fact.statement,
			fact.sourceSolverId ?? null,
			fact.producedByIntentId ?? null,
			fact.fingerprint,
			fact.status,
			fact.invalidatedByFactId ?? null,
			fact.observedAt,
			fact.createdAt,
		);
		this.appendRelations("fact_evidence", "evidence_ref", fact.challengeId, "fact_id", fact.id, fact.evidenceRefs);
	}

	insertServiceHint(hint: GraphHint): void {
		this.assertEntityOwner("hints", hint.id, hint.challengeId, "hint");
		this.run(
			`INSERT INTO hints (id, challenge_id, content, creator, fingerprint, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
			hint.id,
			hint.challengeId,
			hint.content,
			hint.creator,
			hint.fingerprint,
			hint.createdAt,
		);
	}

	readFactByFingerprint(challengeId: string, fingerprint: string): GraphFact | undefined {
		const row = this.getOptionalRow<Parameters<typeof graphFactFromRow>[0]>(
			"SELECT * FROM facts WHERE challenge_id = ? AND fingerprint = ?",
			challengeId,
			fingerprint,
		);
		if (!row) return;
		return graphFactFromRow(
			row,
			this.readRelationIds("fact_evidence", "evidence_ref", challengeId, "fact_id", row.id),
			this.readRelationIds("fact_memory_sources", "memory_id", challengeId, "fact_id", row.id),
		);
	}

	insertServiceIntent(intent: GraphIntent): void {
		this.assertEntityOwner("intents", intent.id, intent.challengeId, "intent");
		this.run(
			`INSERT INTO intents (
                id, challenge_id, objective, scope, capability_tags_json, priority, status, outcome,
                owner_solver_id, lease_until, attempt_count, version, created_by, fingerprint, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			intent.id,
			intent.challengeId,
			intent.objective,
			intent.scope,
			JSON.stringify(intent.capabilityTags),
			intent.priority,
			intent.status,
			intent.outcome ?? null,
			intent.ownerSolverId ?? null,
			intent.leaseUntil ?? null,
			intent.attemptCount,
			intent.version,
			intent.createdBy,
			intent.fingerprint,
			intent.createdAt,
			intent.updatedAt,
		);
		this.appendRelations("intent_sources", "fact_id", intent.challengeId, "intent_id", intent.id, intent.fromFactIds);
		this.appendRelations(
			"intent_hint_sources",
			"hint_id",
			intent.challengeId,
			"intent_id",
			intent.id,
			intent.sourceHintIds,
		);
	}

	appendServiceFactEvidence(challengeId: string, factId: string, evidenceRef: string): boolean {
		this.requireOwnedEntity("facts", factId, challengeId, "fact");
		return (
			this.run(
				"INSERT OR IGNORE INTO fact_evidence (challenge_id, fact_id, evidence_ref) VALUES (?, ?, ?)",
				challengeId,
				factId,
				evidenceRef,
			).changes === 1
		);
	}

	invalidateServiceFact(challengeId: string, factId: string, replacementFactId: string): void {
		this.requireOwnedEntity("facts", factId, challengeId, "fact");
		this.requireOwnedEntity("facts", replacementFactId, challengeId, "replacement fact");
		this.run(
			"UPDATE facts SET status = 'invalidated', invalidated_by_fact_id = ? WHERE challenge_id = ? AND id = ?",
			replacementFactId,
			challengeId,
			factId,
		);
	}

	insertArtifact(artifact: GraphArtifact): void {
		this.assertEntityOwner("artifacts", artifact.id, artifact.challengeId, "artifact");
		if (artifact.intentId) this.requireOwnedEntity("intents", artifact.intentId, artifact.challengeId, "intent");
		this.run(
			`INSERT INTO artifacts (id, challenge_id, solver_id, intent_id, path, sha256, mime_type, size, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			artifact.id,
			artifact.challengeId,
			artifact.solverId,
			artifact.intentId ?? null,
			artifact.path,
			artifact.sha256,
			artifact.mimeType,
			artifact.size,
			artifact.createdAt,
		);
	}

	readIntentForLease(challengeId: string, intentId: string): GraphIntent | undefined {
		const snapshot = this.readServiceGraph(challengeId);
		return snapshot.intents.find((intent) => intent.id === intentId);
	}

	readActiveClaimByIntent(challengeId: string, intentId: string): IntentClaim | undefined {
		return this.readClaimRow(
			"SELECT * FROM intent_claims WHERE challenge_id = ? AND intent_id = ? AND status = 'active'",
			challengeId,
			intentId,
		);
	}

	readActiveClaimBySolver(solverId: string): IntentClaim | undefined {
		return this.readClaimRow("SELECT * FROM intent_claims WHERE solver_id = ? AND status = 'active'", solverId);
	}

	readClaims(challengeId: string): IntentClaim[] {
		return this.allRows<Record<string, unknown>>(
			"SELECT * FROM intent_claims WHERE challenge_id = ? ORDER BY intent_id, generation",
			challengeId,
		).map((row) => this.claimFromRow(row));
	}

	readSchedulerChallengeIds(limit: number): string[] {
		return this.allRows<{ challenge_id: string }>(
			`SELECT DISTINCT intents.challenge_id
               FROM intents
               LEFT JOIN challenge_goal_states goal
                 ON goal.challenge_id = intents.challenge_id
              WHERE intents.status IN ('open', 'claimed')
                AND COALESCE(goal.completed, 0) = 0
              ORDER BY intents.challenge_id
              LIMIT ?`,
			limit,
		).map((row) => row.challenge_id);
	}

	nextClaimGeneration(challengeId: string, intentId: string): number {
		return this.getRow<{ generation: number }>(
			"SELECT COALESCE(MAX(generation), 0) + 1 AS generation FROM intent_claims WHERE challenge_id = ? AND intent_id = ?",
			challengeId,
			intentId,
		).generation;
	}

	registerLeaseSolver(challengeId: string, solverId: string, createdAt: string): void {
		const existing = this.getOptionalRow<{ challenge_id: string }>(
			"SELECT challenge_id FROM graph_solvers WHERE solver_id = ?",
			solverId,
		);
		if (existing && existing.challenge_id !== challengeId) throw new Error("solver belongs to another challenge");
		this.run(
			"INSERT OR IGNORE INTO graph_solvers (solver_id, challenge_id, created_at) VALUES (?, ?, ?)",
			solverId,
			challengeId,
			createdAt,
		);
	}

	insertIntentClaim(claim: IntentClaim): void {
		this.run(
			`INSERT INTO intent_claims
             (id, challenge_id, intent_id, solver_id, token_hash, generation, lease_until, heartbeat_at, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			claim.id,
			claim.challengeId,
			claim.intentId,
			claim.solverId,
			claim.tokenHash,
			claim.generation,
			claim.leaseUntil,
			claim.heartbeatAt,
			claim.status,
			claim.createdAt,
			claim.updatedAt,
		);
	}

	updateIntentLeaseState(input: {
		challengeId: string;
		intentId: string;
		expectedVersion: number;
		status: GraphIntent["status"];
		ownerSolverId?: string;
		leaseUntil?: string;
		outcome?: GraphIntent["outcome"];
		updatedAt: string;
		incrementAttempt?: boolean;
	}): number {
		const result = this.run(
			`UPDATE intents
             SET status = ?, owner_solver_id = ?, lease_until = ?, outcome = ?,
                 attempt_count = attempt_count + ?, version = version + 1, updated_at = ?
             WHERE challenge_id = ? AND id = ? AND version = ?`,
			input.status,
			input.ownerSolverId ?? null,
			input.leaseUntil ?? null,
			input.outcome ?? null,
			input.incrementAttempt ? 1 : 0,
			input.updatedAt,
			input.challengeId,
			input.intentId,
			input.expectedVersion,
		);
		if (result.changes !== 1) throw new Error("intent version conflict");
		return input.expectedVersion + 1;
	}

	renewIntentLease(
		challengeId: string,
		intentId: string,
		expectedVersion: number,
		leaseUntil: string,
		updatedAt: string,
	): number {
		const result = this.run(
			`UPDATE intents SET lease_until = ?, version = version + 1, updated_at = ?
             WHERE challenge_id = ? AND id = ? AND version = ? AND status IN ('claimed', 'running')`,
			leaseUntil,
			updatedAt,
			challengeId,
			intentId,
			expectedVersion,
		);
		if (result.changes !== 1) throw new Error("intent version conflict");
		return expectedVersion + 1;
	}

	updateActiveClaim(
		claimId: string,
		input: { leaseUntil?: string; heartbeatAt?: string; status?: IntentClaimStatus; updatedAt: string },
	): void {
		const result = this.run(
			`UPDATE intent_claims SET lease_until = COALESCE(?, lease_until), heartbeat_at = COALESCE(?, heartbeat_at),
             status = COALESCE(?, status), updated_at = ? WHERE id = ? AND status = 'active'`,
			input.leaseUntil ?? null,
			input.heartbeatAt ?? null,
			input.status ?? null,
			input.updatedAt,
			claimId,
		);
		if (result.changes !== 1) throw new Error("claim is not active");
	}

	readExpiredActiveClaims(now: string, challengeId?: string): IntentClaim[] {
		const rows = challengeId
			? this.allRows<Record<string, unknown>>(
					"SELECT * FROM intent_claims WHERE status = 'active' AND lease_until <= ? AND challenge_id = ? ORDER BY id",
					now,
					challengeId,
				)
			: this.allRows<Record<string, unknown>>(
					"SELECT * FROM intent_claims WHERE status = 'active' AND lease_until <= ? ORDER BY id",
					now,
				);
		return rows.map((row) => this.claimFromRow(row));
	}

	appendIntentResult(challengeId: string, intentId: string, factId: string): void {
		this.requireOwnedEntity("intents", intentId, challengeId, "intent");
		this.requireOwnedEntity("facts", factId, challengeId, "fact");
		this.run(
			"INSERT OR IGNORE INTO intent_results (challenge_id, intent_id, fact_id) VALUES (?, ?, ?)",
			challengeId,
			intentId,
			factId,
		);
	}

	markChallengeCompleted(challengeId: string, updatedAt: string): boolean {
		this.ensureServiceChallenge(challengeId);
		const existing = this.getOptionalRow<{ completed: number }>(
			"SELECT completed FROM challenge_goal_states WHERE challenge_id = ?",
			challengeId,
		);
		if (existing?.completed === 1) return false;
		this.run(
			`INSERT INTO challenge_goal_states (challenge_id, completed, flag_count, solved_flag_count, updated_at)
             VALUES (?, 1, NULL, 0, ?)
             ON CONFLICT(challenge_id) DO UPDATE SET completed = 1, updated_at = excluded.updated_at`,
			challengeId,
			updatedAt,
		);
		return true;
	}

	readArtifact(challengeId: string, artifactId: string): GraphArtifact | undefined {
		const row = this.getOptionalRow<Record<string, unknown>>(
			"SELECT * FROM artifacts WHERE challenge_id = ? AND id = ?",
			challengeId,
			artifactId,
		);
		if (!row) return;
		return {
			id: String(row.id),
			challengeId: String(row.challenge_id),
			solverId: String(row.solver_id),
			intentId: row.intent_id ? String(row.intent_id) : undefined,
			path: String(row.path),
			sha256: String(row.sha256),
			mimeType: String(row.mime_type),
			size: Number(row.size),
			createdAt: String(row.created_at),
		};
	}

	appendServiceEvent(event: Omit<GraphEvent, "sequence">): number {
		this.insertEvent(event);
		return this.getRow<{ sequence: number }>(
			"SELECT sequence FROM graph_events WHERE idempotency_key = ?",
			event.idempotencyKey,
		).sequence;
	}

	insertReasonTrigger(trigger: ReasonTrigger): boolean {
		this.ensureServiceChallenge(trigger.challengeId);
		return (
			this.run(
				`INSERT OR IGNORE INTO reason_triggers
             (id, challenge_id, reason, source_event_sequence, source_entity_id, payload_fingerprint,
              status, attempt_count, not_before, lease_generation, last_error, created_at, updated_at, completed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				trigger.id,
				trigger.challengeId,
				trigger.reason,
				trigger.sourceEventSequence,
				trigger.sourceEntityId,
				trigger.payloadFingerprint,
				trigger.status,
				trigger.attemptCount,
				trigger.notBefore,
				trigger.leaseGeneration ?? null,
				trigger.lastError ?? null,
				trigger.createdAt,
				trigger.updatedAt,
				trigger.completedAt ?? null,
			).changes === 1
		);
	}

	readPendingReasonTriggers(challengeId: string, now: string, limit: number): ReasonTrigger[] {
		return this.allRows<Record<string, unknown>>(
			`SELECT * FROM reason_triggers
             WHERE challenge_id = ? AND status = 'pending' AND not_before <= ?
             ORDER BY not_before, source_event_sequence, id LIMIT ?`,
			challengeId,
			now,
			limit,
		).map((row) => this.reasonTriggerFromRow(row));
	}

	readPendingReasonChallengeIds(now: string, limit: number): string[] {
		return this.allRows<{ challenge_id: string }>(
			`SELECT challenge_id FROM reason_triggers
             WHERE status = 'pending' AND not_before <= ?
             GROUP BY challenge_id
             ORDER BY MIN(not_before), MIN(source_event_sequence), challenge_id
             LIMIT ?`,
			now,
			limit,
		).map((row) => row.challenge_id);
	}

	readReasonTriggers(challengeId: string, limit: number): ReasonTrigger[] {
		return this.allRows<Record<string, unknown>>(
			`SELECT * FROM reason_triggers WHERE challenge_id = ?
             ORDER BY not_before, source_event_sequence, id LIMIT ?`,
			challengeId,
			limit,
		).map((row) => this.reasonTriggerFromRow(row));
	}

	readReasonTrigger(challengeId: string, triggerId: string): ReasonTrigger | undefined {
		const row = this.getOptionalRow<Record<string, unknown>>(
			"SELECT * FROM reason_triggers WHERE challenge_id = ? AND id = ?",
			challengeId,
			triggerId,
		);
		return row ? this.reasonTriggerFromRow(row) : undefined;
	}

	readReasonTriggersByIds(challengeId: string, ids: string[]): ReasonTrigger[] {
		if (ids.length === 0) return [];
		const placeholders = ids.map(() => "?").join(", ");
		return this.allRows<Record<string, unknown>>(
			`SELECT * FROM reason_triggers
             WHERE challenge_id = ? AND id IN (${placeholders})
             ORDER BY id`,
			challengeId,
			...ids,
		).map((row) => this.reasonTriggerFromRow(row));
	}

	readActionableReasonTrigger(challengeId: string): ReasonTrigger | undefined {
		const row = this.getOptionalRow<Record<string, unknown>>(
			`SELECT * FROM reason_triggers
             WHERE challenge_id = ? AND status IN ('pending', 'processing')
             ORDER BY not_before, source_event_sequence, id LIMIT 1`,
			challengeId,
		);
		return row ? this.reasonTriggerFromRow(row) : undefined;
	}

	insertReasonProposal(proposal: ReasonProposal): void {
		this.ensureServiceChallenge(proposal.challengeId);
		this.run(
			`INSERT INTO reason_proposals
             (id, challenge_id, status, reason_lease_generation, base_event_sequence,
              context_fingerprint, rationale_summary, model, provider, prompt_version, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			proposal.id,
			proposal.challengeId,
			proposal.status,
			proposal.reasonLeaseGeneration,
			proposal.baseEventSequence,
			proposal.contextFingerprint,
			proposal.rationaleSummary,
			proposal.model,
			proposal.provider,
			proposal.promptVersion,
			proposal.createdAt,
		);
		for (const triggerId of proposal.sourceTriggerIds) {
			this.run(
				"INSERT INTO reason_proposal_triggers (challenge_id, proposal_id, trigger_id) VALUES (?, ?, ?)",
				proposal.challengeId,
				proposal.id,
				triggerId,
			);
		}
		proposal.proposedIntents.forEach((intent, ordinal) => {
			this.run(
				`INSERT INTO reason_proposal_intents
                 (challenge_id, proposal_id, client_id, objective, rationale, priority, ordinal)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				proposal.challengeId,
				proposal.id,
				intent.clientId,
				intent.objective,
				intent.rationale,
				intent.priority,
				ordinal,
			);
			intent.successCriteria.forEach((criterion, index) => {
				this.run(
					`INSERT INTO reason_proposal_success_criteria
                     (challenge_id, proposal_id, intent_ordinal, ordinal, criterion) VALUES (?, ?, ?, ?, ?)`,
					proposal.challengeId,
					proposal.id,
					ordinal,
					index,
					criterion,
				);
			});
			for (const tag of intent.capabilityTags) {
				this.run(
					`INSERT INTO reason_proposal_capability_tags
                     (challenge_id, proposal_id, intent_ordinal, tag) VALUES (?, ?, ?, ?)`,
					proposal.challengeId,
					proposal.id,
					ordinal,
					tag,
				);
			}
			for (const factId of intent.fromFactIds) {
				this.run(
					`INSERT INTO reason_proposal_fact_refs
                     (challenge_id, proposal_id, intent_ordinal, fact_id) VALUES (?, ?, ?, ?)`,
					proposal.challengeId,
					proposal.id,
					ordinal,
					factId,
				);
			}
			for (const hintId of intent.sourceHintIds) {
				this.run(
					`INSERT INTO reason_proposal_hint_refs
                     (challenge_id, proposal_id, intent_ordinal, hint_id) VALUES (?, ?, ?, ?)`,
					proposal.challengeId,
					proposal.id,
					ordinal,
					hintId,
				);
			}
			for (const intentId of intent.supersedesIntentIds) {
				this.run(
					`INSERT INTO reason_proposal_intent_supersedes
                     (challenge_id, proposal_id, intent_ordinal, intent_id) VALUES (?, ?, ?, ?)`,
					proposal.challengeId,
					proposal.id,
					ordinal,
					intentId,
				);
			}
		});
		proposal.supersedeRecommendations.forEach((recommendation, ordinal) => {
			this.run(
				`INSERT INTO reason_proposal_supersede_recommendations
                 (challenge_id, proposal_id, intent_id, rationale, replacement_client_id, ordinal)
                 VALUES (?, ?, ?, ?, ?, ?)`,
				proposal.challengeId,
				proposal.id,
				recommendation.intentId,
				recommendation.rationale,
				recommendation.replacementClientId ?? null,
				ordinal,
			);
		});
		proposal.validationErrors.forEach((error, ordinal) => {
			this.run(
				`INSERT INTO reason_proposal_validation_errors
                 (challenge_id, proposal_id, ordinal, error) VALUES (?, ?, ?, ?)`,
				proposal.challengeId,
				proposal.id,
				ordinal,
				error,
			);
		});
	}

	readReasonProposal(challengeId: string, proposalId: string): ReasonProposal | undefined {
		const row = this.getOptionalRow<Record<string, unknown>>(
			"SELECT * FROM reason_proposals WHERE challenge_id = ? AND id = ?",
			challengeId,
			proposalId,
		);
		return row ? this.reasonProposalFromRow(row) : undefined;
	}

	listReasonProposals(challengeId: string, limit: number): ReasonProposal[] {
		return this.allRows<Record<string, unknown>>(
			`SELECT * FROM reason_proposals WHERE challenge_id = ?
             ORDER BY created_at DESC, id DESC LIMIT ?`,
			challengeId,
			limit,
		).map((row) => this.reasonProposalFromRow(row));
	}

	insertReasonProposalApplication(
		result: ReasonProposalApplyResult,
		idempotencyKey: string,
		actorId: string,
		baseEventSequence: number,
		createdIntentClientIds: Map<string, string> = new Map(),
		supersedeReplacementIntentIds: Map<string, string> = new Map(),
	): void {
		this.run(
			`INSERT INTO reason_proposal_applications
             (challenge_id, proposal_id, idempotency_key, status, applied_at, actor_id, base_event_sequence, applied_event_sequence)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			result.challengeId,
			result.proposalId,
			idempotencyKey,
			result.status,
			result.appliedAt,
			actorId,
			baseEventSequence,
			result.eventSequence,
		);
		for (const intentId of result.createdIntentIds) {
			this.run(
				`INSERT INTO reason_proposal_intent_results
                 (challenge_id, proposal_id, client_id, intent_id, status, reason)
                 VALUES (?, ?, ?, ?, 'created', 'created')`,
				result.challengeId,
				result.proposalId,
				createdIntentClientIds.get(intentId) ?? intentId,
				intentId,
			);
		}
		for (const skipped of result.skippedIntents) {
			this.run(
				`INSERT INTO reason_proposal_intent_results
                 (challenge_id, proposal_id, client_id, intent_id, status, reason)
                 VALUES (?, ?, ?, ?, 'skipped_duplicate', ?)`,
				result.challengeId,
				result.proposalId,
				skipped.clientId,
				skipped.duplicateIntentId ?? null,
				skipped.reason,
			);
		}
		for (const intentId of result.supersededIntentIds) {
			this.run(
				`INSERT INTO reason_proposal_supersede_results
                 (challenge_id, proposal_id, intent_id, replacement_intent_id, status, reason)
                 VALUES (?, ?, ?, ?, 'superseded', 'superseded')`,
				result.challengeId,
				result.proposalId,
				intentId,
				supersedeReplacementIntentIds.get(intentId) ?? null,
			);
		}
		for (const skipped of result.skippedSupersedes) {
			this.run(
				`INSERT INTO reason_proposal_supersede_results
                 (challenge_id, proposal_id, intent_id, replacement_intent_id, status, reason)
                 VALUES (?, ?, ?, NULL, 'skipped', ?)`,
				result.challengeId,
				result.proposalId,
				skipped.intentId,
				skipped.reason,
			);
		}
		result.staleReasons.forEach((reason, ordinal) => {
			this.run(
				`INSERT INTO reason_proposal_stale_reasons (challenge_id, proposal_id, ordinal, reason)
                 VALUES (?, ?, ?, ?)`,
				result.challengeId,
				result.proposalId,
				ordinal,
				reason,
			);
		});
	}

	markReasonProposalApplied(challengeId: string, proposalId: string): void {
		const result = this.run(
			"UPDATE reason_proposals SET status = 'applied' WHERE challenge_id = ? AND id = ? AND status = 'proposed'",
			challengeId,
			proposalId,
		);
		if (result.changes !== 1) throw new Error("reason proposal is not proposed");
	}

	readReasonProposalApplication(challengeId: string, proposalId: string): ReasonProposalApplyResult | undefined {
		const row = this.getOptionalRow<{
			proposal_id: string;
			challenge_id: string;
			status: ReasonProposalApplyResult["status"];
			applied_at: string;
			applied_event_sequence: number;
		}>(
			`SELECT proposal_id, challenge_id, status, applied_at, applied_event_sequence
             FROM reason_proposal_applications WHERE challenge_id = ? AND proposal_id = ?`,
			challengeId,
			proposalId,
		);
		if (!row) return;
		return this.reasonProposalApplyResultFromRow(row);
	}

	markReasonTriggersProcessing(challengeId: string, ids: string[], generation: number, updatedAt: string): void {
		for (const id of ids) {
			const result = this.run(
				`UPDATE reason_triggers SET status = 'processing', lease_generation = ?, updated_at = ?
                 WHERE challenge_id = ? AND id = ? AND status = 'pending'`,
				generation,
				updatedAt,
				challengeId,
				id,
			);
			if (result.changes !== 1) throw new Error(`reason trigger ${id} is not pending in challenge`);
		}
	}

	completeReasonTriggerRows(challengeId: string, ids: string[], generation: number, completedAt: string): number {
		let completed = 0;
		for (const id of ids) {
			const result = this.run(
				`UPDATE reason_triggers
                 SET status = 'completed', completed_at = ?, updated_at = ?
                 WHERE challenge_id = ? AND id = ? AND status = 'processing' AND lease_generation = ?`,
				completedAt,
				completedAt,
				challengeId,
				id,
				generation,
			);
			completed += result.changes;
		}
		return completed;
	}

	failReasonTriggerRows(input: {
		challengeId: string;
		ids: string[];
		generation: number;
		notBefore: string;
		lastError: string;
		maxAttempts: number;
		updatedAt: string;
	}): { retried: number; deadLettered: number } {
		let retried = 0;
		let deadLettered = 0;
		for (const id of input.ids) {
			const row = this.getOptionalRow<{ attempt_count: number }>(
				`SELECT attempt_count FROM reason_triggers
                 WHERE challenge_id = ? AND id = ? AND status = 'processing' AND lease_generation = ?`,
				input.challengeId,
				id,
				input.generation,
			);
			if (!row) continue;
			const attempts = row.attempt_count + 1;
			const dead = attempts >= input.maxAttempts;
			this.run(
				`UPDATE reason_triggers SET status = ?, attempt_count = ?, not_before = ?,
                 lease_generation = NULL, last_error = ?, updated_at = ?
                 WHERE challenge_id = ? AND id = ? AND status = 'processing' AND lease_generation = ?`,
				dead ? "dead_letter" : "pending",
				attempts,
				input.notBefore,
				input.lastError,
				input.updatedAt,
				input.challengeId,
				id,
				input.generation,
			);
			if (dead) deadLettered += 1;
			else retried += 1;
		}
		return { retried, deadLettered };
	}

	nextReasonLeaseGeneration(challengeId: string): number {
		return this.getRow<{ generation: number }>(
			"SELECT COALESCE(MAX(generation), 0) + 1 AS generation FROM reason_leases WHERE challenge_id = ?",
			challengeId,
		).generation;
	}

	readActiveReasonLease(challengeId: string): ReasonLeaseRecord | undefined {
		const row = this.getOptionalRow<Record<string, unknown>>(
			"SELECT * FROM reason_leases WHERE challenge_id = ? AND status = 'active'",
			challengeId,
		);
		return row ? this.reasonLeaseFromRow(row) : undefined;
	}

	insertReasonLease(lease: ReasonLeaseRecord): void {
		this.ensureServiceChallenge(lease.challengeId);
		this.run(
			`INSERT INTO reason_leases
             (challenge_id, owner_id, generation, token_hash, lease_until, heartbeat_at, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			lease.challengeId,
			lease.ownerId,
			lease.generation,
			lease.tokenHash,
			lease.leaseUntil,
			lease.heartbeatAt,
			lease.status,
			lease.createdAt,
			lease.updatedAt,
		);
	}

	updateActiveReasonLease(
		challengeId: string,
		generation: number,
		input: { leaseUntil?: string; heartbeatAt?: string; status?: ReasonLeaseStatus; updatedAt: string },
	): void {
		const result = this.run(
			`UPDATE reason_leases SET lease_until = COALESCE(?, lease_until),
             heartbeat_at = COALESCE(?, heartbeat_at), status = COALESCE(?, status), updated_at = ?
             WHERE challenge_id = ? AND generation = ? AND status = 'active'`,
			input.leaseUntil ?? null,
			input.heartbeatAt ?? null,
			input.status ?? null,
			input.updatedAt,
			challengeId,
			generation,
		);
		if (result.changes !== 1) throw new Error("reason lease is not active");
	}

	releaseReasonLeaseRows(
		challengeId: string,
		generation: number,
		updatedAt: string,
	): { released: true; recovered: number } {
		const recovered = this.run(
			`UPDATE reason_triggers SET status = 'pending', lease_generation = NULL, updated_at = ?
             WHERE challenge_id = ? AND status = 'processing' AND lease_generation = ?`,
			updatedAt,
			challengeId,
			generation,
		).changes;
		this.updateActiveReasonLease(challengeId, generation, { status: "released", updatedAt });
		return { released: true, recovered };
	}

	expireReasonLeaseRows(now: string): { expired: number; recovered: number } {
		const leases = this.allRows<Record<string, unknown>>(
			"SELECT * FROM reason_leases WHERE status = 'active' AND lease_until <= ? ORDER BY challenge_id",
			now,
		).map((row) => this.reasonLeaseFromRow(row));
		let recovered = 0;
		for (const lease of leases) {
			this.updateActiveReasonLease(lease.challengeId, lease.generation, { status: "expired", updatedAt: now });
			recovered += this.run(
				`UPDATE reason_triggers SET status = 'pending', lease_generation = NULL, updated_at = ?
                 WHERE challenge_id = ? AND status = 'processing' AND lease_generation = ?`,
				now,
				lease.challengeId,
				lease.generation,
			).changes;
		}
		return { expired: leases.length, recovered };
	}

	hasReasonHistory(challengeId: string): boolean {
		return (
			this.getRow<{ count: number }>(
				`SELECT (
                (SELECT COUNT(*) FROM reason_triggers WHERE challenge_id = ?)
                + (SELECT COUNT(*) FROM intents WHERE challenge_id = ?)
            ) AS count`,
				challengeId,
				challengeId,
			).count > 0
		);
	}

	readServiceGraph(challengeId: string): ChallengeGraphSnapshot {
		this.requireInitialized();
		const factRows = this.allRows<Parameters<typeof graphFactFromRow>[0]>(
			"SELECT * FROM facts WHERE challenge_id = ? ORDER BY id",
			challengeId,
		);
		const hintRows = this.allRows<Parameters<typeof graphHintFromRow>[0]>(
			"SELECT * FROM hints WHERE challenge_id = ? ORDER BY id",
			challengeId,
		);
		const intentRows = this.allRows<Parameters<typeof graphIntentFromRow>[0]>(
			"SELECT * FROM intents WHERE challenge_id = ? ORDER BY id",
			challengeId,
		);
		const goalRow = this.getOptionalRow<Parameters<typeof goalStateFromRow>[0]>(
			"SELECT * FROM challenge_goal_states WHERE challenge_id = ?",
			challengeId,
		);
		return {
			challengeId,
			facts: factRows.map((row) =>
				graphFactFromRow(
					row,
					this.readRelationIds("fact_evidence", "evidence_ref", challengeId, "fact_id", row.id),
					this.readRelationIds("fact_memory_sources", "memory_id", challengeId, "fact_id", row.id),
				),
			),
			hints: hintRows.map((row) =>
				graphHintFromRow(
					row,
					this.readRelationIds("hint_memory_sources", "memory_id", challengeId, "hint_id", row.id),
				),
			),
			intents: intentRows.map((row) =>
				graphIntentFromRow(
					row,
					this.readRelationIds("intent_sources", "fact_id", challengeId, "intent_id", row.id),
					this.readRelationIds("intent_hint_sources", "hint_id", challengeId, "intent_id", row.id),
					this.readRelationIds("intent_results", "fact_id", challengeId, "intent_id", row.id),
					this.readRelationIds("intent_idea_sources", "idea_id", challengeId, "intent_id", row.id),
				),
			),
			goalState: goalRow ? goalStateFromRow(goalRow) : undefined,
		};
	}

	readCurrentSnapshot(challengeId: string): { snapshotFingerprint: string; capturedAt: string } | undefined {
		this.requireInitialized();
		const row = this.getOptionalRow<{ snapshot_fingerprint: string; captured_at: string }>(
			"SELECT snapshot_fingerprint, captured_at FROM shadow_snapshots WHERE challenge_id = ?",
			challengeId,
		);
		return row ? { snapshotFingerprint: row.snapshot_fingerprint, capturedAt: row.captured_at } : undefined;
	}

	applyShadowMigration(batch: ShadowMigrationBatch): ShadowMigrationWriteResult {
		this.requireInitialized();
		if (!batch.capturedAt.trim() || !Number.isFinite(Date.parse(batch.capturedAt))) {
			throw new Error("capturedAt must be a valid timestamp");
		}
		this.database.exec("BEGIN IMMEDIATE");
		try {
			this.run("INSERT OR IGNORE INTO challenges (id) VALUES (?)", batch.challengeId);
			const existingSnapshot = this.readCurrentSnapshot(batch.challengeId);
			if (existingSnapshot?.snapshotFingerprint === batch.snapshotFingerprint) {
				this.database.exec("COMMIT");
				return this.emptyWriteResult();
			}

			this.assertBatchEntityOwnership(batch);
			const previous = this.readCurrentEntityIds(batch.challengeId);
			const current = {
				fact: new Set(batch.facts.map((fact) => fact.id)),
				hint: new Set(batch.hints.map((hint) => hint.id)),
				intent: new Set(batch.intents.map((intent) => intent.id)),
			};
			let insertedFacts = 0;
			let insertedHints = 0;
			let insertedIntents = 0;
			let insertedEvents = 0;

			for (const intent of batch.intents) {
				this.requireChallenge(batch.challengeId, intent.challengeId, "intent");
				const existed = this.entityExists("intents", intent.id);
				this.run(
					`INSERT INTO intents (
                            id, challenge_id, objective, scope, capability_tags_json, priority, status, outcome,
                            owner_solver_id, lease_until, attempt_count, version, created_by, fingerprint, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET
                            objective = excluded.objective,
                            scope = excluded.scope,
                            capability_tags_json = excluded.capability_tags_json,
                            priority = excluded.priority,
                            status = excluded.status,
                            outcome = excluded.outcome,
                            owner_solver_id = excluded.owner_solver_id,
                            lease_until = excluded.lease_until,
                            attempt_count = excluded.attempt_count,
                            version = excluded.version,
                            updated_at = excluded.updated_at`,
					intent.id,
					intent.challengeId,
					intent.objective,
					intent.scope,
					JSON.stringify(intent.capabilityTags),
					intent.priority,
					intent.status,
					intent.outcome ?? null,
					intent.ownerSolverId ?? null,
					intent.leaseUntil ?? null,
					intent.attemptCount,
					intent.version,
					intent.createdBy,
					intent.fingerprint,
					intent.createdAt,
					intent.updatedAt,
				);
				if (!existed) insertedIntents += 1;
			}

			for (const fact of [...batch.facts].sort((left, right) => left.status.localeCompare(right.status))) {
				this.requireChallenge(batch.challengeId, fact.challengeId, "fact");
				const result = this.run(
					`INSERT OR IGNORE INTO facts (
                            id, challenge_id, kind, statement, source_solver_id, produced_by_intent_id, fingerprint,
                            status, invalidated_by_fact_id, observed_at, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					fact.id,
					fact.challengeId,
					fact.kind,
					fact.statement,
					fact.sourceSolverId ?? null,
					fact.producedByIntentId ?? null,
					fact.fingerprint,
					fact.status,
					fact.invalidatedByFactId ?? null,
					fact.observedAt,
					fact.createdAt,
				);
				insertedFacts += result.changes;
				this.replaceRelations(
					"fact_memory_sources",
					"memory_id",
					batch.challengeId,
					"fact_id",
					fact.id,
					fact.sourceMemoryIds,
				);
				this.appendRelations(
					"fact_evidence",
					"evidence_ref",
					batch.challengeId,
					"fact_id",
					fact.id,
					fact.evidenceRefs,
				);
			}

			for (const hint of batch.hints) {
				this.requireChallenge(batch.challengeId, hint.challengeId, "hint");
				const existed = this.entityExists("hints", hint.id);
				this.run(
					`INSERT INTO hints (id, challenge_id, content, creator, fingerprint, created_at)
                         VALUES (?, ?, ?, ?, ?, ?)
                         ON CONFLICT(id) DO UPDATE SET content = excluded.content, creator = excluded.creator`,
					hint.id,
					hint.challengeId,
					hint.content,
					hint.creator,
					hint.fingerprint,
					hint.createdAt,
				);
				if (!existed) insertedHints += 1;
				this.replaceRelations(
					"hint_memory_sources",
					"memory_id",
					batch.challengeId,
					"hint_id",
					hint.id,
					hint.sourceMemoryIds,
				);
			}

			for (const intent of batch.intents) {
				this.replaceRelations(
					"intent_sources",
					"fact_id",
					batch.challengeId,
					"intent_id",
					intent.id,
					intent.fromFactIds,
				);
				this.replaceRelations(
					"intent_hint_sources",
					"hint_id",
					batch.challengeId,
					"intent_id",
					intent.id,
					intent.sourceHintIds,
				);
				this.replaceRelations(
					"intent_results",
					"fact_id",
					batch.challengeId,
					"intent_id",
					intent.id,
					intent.resultFactIds,
				);
				this.replaceRelations(
					"intent_idea_sources",
					"idea_id",
					batch.challengeId,
					"intent_id",
					intent.id,
					intent.sourceIdeaIds,
				);
			}

			this.run("DELETE FROM shadow_current_entities WHERE challenge_id = ?", batch.challengeId);
			for (const [entityType, ids] of Object.entries(current) as Array<[EntityType, Set<string>]>) {
				for (const id of ids) {
					this.assertEntityOwner(this.entityTable(entityType), id, batch.challengeId, entityType);
					this.run(
						"INSERT INTO shadow_current_entities (challenge_id, entity_type, entity_id, snapshot_fingerprint) VALUES (?, ?, ?, ?)",
						batch.challengeId,
						entityType,
						id,
						batch.snapshotFingerprint,
					);
				}
			}

			for (const event of batch.events) {
				this.requireChallenge(batch.challengeId, event.challengeId, "event");
				insertedEvents += this.insertEvent(event);
			}

			const retired = {
				fact: [...previous.fact].filter((id) => !current.fact.has(id)),
				hint: [...previous.hint].filter((id) => !current.hint.has(id)),
				intent: [...previous.intent].filter((id) => !current.intent.has(id)),
			};
			for (const [entityType, ids] of Object.entries(retired) as Array<[EntityType, string[]]>) {
				for (const id of ids.sort()) {
					insertedEvents += this.insertEvent({
						challengeId: batch.challengeId,
						type: `shadow_${entityType}_retired`,
						entityId: id,
						actorId: "shadow-migration",
						idempotencyKey: `shadow:shadow_${entityType}_retired:${batch.challengeId}:${id}:${batch.snapshotFingerprint}`,
						payload: { snapshotFingerprint: batch.snapshotFingerprint },
						createdAt: batch.capturedAt,
					});
				}
			}

			insertedEvents += this.insertEvent({
				challengeId: batch.challengeId,
				type: "shadow_snapshot_applied",
				entityId: batch.challengeId,
				actorId: "shadow-migration",
				idempotencyKey: `shadow:shadow_snapshot_applied:${batch.challengeId}:${batch.capturedAt}:${batch.snapshotFingerprint}`,
				payload: {
					previousSnapshotFingerprint: existingSnapshot?.snapshotFingerprint ?? null,
					snapshotFingerprint: batch.snapshotFingerprint,
					capturedAt: batch.capturedAt,
				},
				createdAt: batch.capturedAt,
			});
			this.run(
				`INSERT INTO shadow_snapshots (challenge_id, snapshot_fingerprint, captured_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(challenge_id) DO UPDATE SET
                    snapshot_fingerprint = excluded.snapshot_fingerprint,
                    captured_at = excluded.captured_at`,
				batch.challengeId,
				batch.snapshotFingerprint,
				batch.capturedAt,
			);

			const result = {
				insertedFacts,
				insertedHints,
				insertedIntents,
				insertedEvents,
				retiredFacts: retired.fact.length,
				retiredHints: retired.hint.length,
				retiredIntents: retired.intent.length,
				snapshotApplied: true,
			};
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			if (this.database.isTransaction) this.database.exec("ROLLBACK");
			throw error;
		}
	}

	private readCurrentEntityIds(challengeId: string): Record<EntityType, Set<string>> {
		const rows = this.allRows<{ entity_type: EntityType; entity_id: string }>(
			"SELECT entity_type, entity_id FROM shadow_current_entities WHERE challenge_id = ?",
			challengeId,
		);
		const result: Record<EntityType, Set<string>> = { fact: new Set(), hint: new Set(), intent: new Set() };
		for (const row of rows) result[row.entity_type].add(row.entity_id);
		return result;
	}

	private readRelationIds(
		table: string,
		valueColumn: string,
		challengeId: string,
		ownerColumn: string,
		ownerId: string,
	): string[] {
		return this.allRows<{ value: string }>(
			`SELECT ${valueColumn} AS value FROM ${table} WHERE challenge_id = ? AND ${ownerColumn} = ? ORDER BY ${valueColumn}`,
			challengeId,
			ownerId,
		).map((row) => row.value);
	}

	private replaceRelations(
		table: string,
		valueColumn: string,
		challengeId: string,
		ownerColumn: string,
		ownerId: string,
		values: string[],
	): void {
		this.run(`DELETE FROM ${table} WHERE challenge_id = ? AND ${ownerColumn} = ?`, challengeId, ownerId);
		this.appendRelations(table, valueColumn, challengeId, ownerColumn, ownerId, values);
	}

	private appendRelations(
		table: string,
		valueColumn: string,
		challengeId: string,
		ownerColumn: string,
		ownerId: string,
		values: string[],
	): void {
		for (const value of [...new Set(values)].sort()) {
			this.run(
				`INSERT OR IGNORE INTO ${table} (challenge_id, ${ownerColumn}, ${valueColumn}) VALUES (?, ?, ?)`,
				challengeId,
				ownerId,
				value,
			);
		}
	}

	private entityExists(table: "hints" | "intents", id: string): boolean {
		return this.getOptionalRow<{ found: number }>(`SELECT 1 AS found FROM ${table} WHERE id = ?`, id) !== null;
	}

	private assertBatchEntityOwnership(batch: ShadowMigrationBatch): void {
		for (const fact of batch.facts) {
			this.requireChallenge(batch.challengeId, fact.challengeId, "fact");
			this.assertEntityOwner("facts", fact.id, batch.challengeId, "fact");
		}
		for (const hint of batch.hints) {
			this.requireChallenge(batch.challengeId, hint.challengeId, "hint");
			this.assertEntityOwner("hints", hint.id, batch.challengeId, "hint");
		}
		for (const intent of batch.intents) {
			this.requireChallenge(batch.challengeId, intent.challengeId, "intent");
			this.assertEntityOwner("intents", intent.id, batch.challengeId, "intent");
		}
	}

	private assertEntityOwner(
		table: "facts" | "hints" | "intents" | "fact_candidates" | "intent_candidates" | "artifacts",
		id: string,
		challengeId: string,
		entityType: string,
	): void {
		const row = this.getOptionalRow<{ challenge_id: string }>(`SELECT challenge_id FROM ${table} WHERE id = ?`, id);
		if (row && row.challenge_id !== challengeId) {
			throw new Error(`${entityType} ${id} belongs to challenge ${row.challenge_id}, not ${challengeId}`);
		}
	}

	private requireOwnedEntity(
		table: "facts" | "hints" | "intents",
		id: string,
		challengeId: string,
		entityType: string,
	): void {
		const row = this.getOptionalRow<{ challenge_id: string }>(`SELECT challenge_id FROM ${table} WHERE id = ?`, id);
		if (!row) throw new Error(`${entityType} ${id} was not found`);
		if (row.challenge_id !== challengeId) throw new Error(`${entityType} ${id} belongs to another challenge`);
	}

	private factCandidateFromRow(row: Record<string, unknown>): FactCandidate {
		return {
			id: row.id as string,
			challengeId: row.challenge_id as string,
			kind: row.kind as FactCandidate["kind"],
			statement: row.statement as string,
			confidence: row.confidence as number,
			evidenceRefs: JSON.parse(row.evidence_refs_json as string) as string[],
			sourceEventIds: JSON.parse(row.source_event_ids_json as string) as string[],
			sourceActorId: row.source_actor_id as string,
			sourceRole: row.source_role as FactCandidate["sourceRole"],
			status: row.status as FactCandidate["status"],
			resultFactId: (row.result_fact_id as string | null) ?? undefined,
			mergedIntoCandidateId: (row.merged_into_candidate_id as string | null) ?? undefined,
			createdAt: row.created_at as string,
			updatedAt: row.updated_at as string,
		};
	}

	private intentCandidateFromRow(row: Record<string, unknown>): IntentCandidate {
		return {
			id: row.id as string,
			challengeId: row.challenge_id as string,
			objective: row.objective as string,
			scope: row.scope as string,
			confidence: row.confidence as number,
			fromFactIds: JSON.parse(row.from_fact_ids_json as string) as string[],
			sourceHintIds: JSON.parse(row.source_hint_ids_json as string) as string[],
			capabilityTags: JSON.parse(row.capability_tags_json as string) as string[],
			sourceEventIds: JSON.parse(row.source_event_ids_json as string) as string[],
			sourceActorId: row.source_actor_id as string,
			sourceRole: row.source_role as IntentCandidate["sourceRole"],
			status: row.status as IntentCandidate["status"],
			resultIntentId: (row.result_intent_id as string | null) ?? undefined,
			mergedIntoCandidateId: (row.merged_into_candidate_id as string | null) ?? undefined,
			createdAt: row.created_at as string,
			updatedAt: row.updated_at as string,
		};
	}

	private entityTable(entityType: EntityType): "facts" | "hints" | "intents" {
		if (entityType === "fact") return "facts";
		if (entityType === "hint") return "hints";
		return "intents";
	}

	private emptyWriteResult(): ShadowMigrationWriteResult {
		return {
			insertedFacts: 0,
			insertedHints: 0,
			insertedIntents: 0,
			insertedEvents: 0,
			retiredFacts: 0,
			retiredHints: 0,
			retiredIntents: 0,
			snapshotApplied: false,
		};
	}

	private insertEvent(event: Omit<GraphEvent, "sequence">): number {
		return this.run(
			"INSERT OR IGNORE INTO graph_events (challenge_id, type, entity_id, actor_id, idempotency_key, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			event.challengeId,
			event.type,
			event.entityId,
			event.actorId,
			event.idempotencyKey,
			JSON.stringify(event.payload),
			event.createdAt,
		).changes;
	}

	private run(sql: string, ...bindings: Array<string | number | null>): ChangesResult {
		const statement = this.database.prepare(sql);
		return statement.run(...bindings) as ChangesResult;
	}

	private readClaimRow(sql: string, ...bindings: Array<string | number | null>): IntentClaim | undefined {
		const row = this.getOptionalRow<Record<string, unknown>>(sql, ...bindings);
		return row ? this.claimFromRow(row) : undefined;
	}

	private claimFromRow(row: Record<string, unknown>): IntentClaim {
		return {
			id: String(row.id),
			challengeId: String(row.challenge_id),
			intentId: String(row.intent_id),
			solverId: String(row.solver_id),
			tokenHash: String(row.token_hash),
			generation: Number(row.generation),
			leaseUntil: String(row.lease_until),
			heartbeatAt: String(row.heartbeat_at),
			status: row.status as IntentClaimStatus,
			createdAt: String(row.created_at),
			updatedAt: String(row.updated_at),
		};
	}

	private reasonTriggerFromRow(row: Record<string, unknown>): ReasonTrigger {
		return {
			id: String(row.id),
			challengeId: String(row.challenge_id),
			reason: row.reason as ReasonTrigger["reason"],
			sourceEventSequence: Number(row.source_event_sequence),
			sourceEntityId: String(row.source_entity_id),
			payloadFingerprint: String(row.payload_fingerprint),
			status: row.status as ReasonTrigger["status"],
			attemptCount: Number(row.attempt_count),
			notBefore: String(row.not_before),
			leaseGeneration: row.lease_generation === null ? undefined : Number(row.lease_generation),
			lastError: row.last_error === null ? undefined : String(row.last_error),
			createdAt: String(row.created_at),
			updatedAt: String(row.updated_at),
			completedAt: row.completed_at === null ? undefined : String(row.completed_at),
		};
	}

	private reasonLeaseFromRow(row: Record<string, unknown>): ReasonLeaseRecord {
		return {
			challengeId: String(row.challenge_id),
			ownerId: String(row.owner_id),
			generation: Number(row.generation),
			tokenHash: String(row.token_hash),
			leaseUntil: String(row.lease_until),
			heartbeatAt: String(row.heartbeat_at),
			status: row.status as ReasonLeaseStatus,
			createdAt: String(row.created_at),
			updatedAt: String(row.updated_at),
		};
	}

	private reasonProposalFromRow(row: Record<string, unknown>): ReasonProposal {
		const challengeId = String(row.challenge_id);
		const proposalId = String(row.id);
		const intents = this.allRows<{
			client_id: string;
			objective: string;
			rationale: string;
			priority: number;
			ordinal: number;
		}>(
			`SELECT client_id, objective, rationale, priority, ordinal
             FROM reason_proposal_intents
             WHERE challenge_id = ? AND proposal_id = ? ORDER BY ordinal`,
			challengeId,
			proposalId,
		);
		return {
			id: proposalId,
			challengeId,
			status: row.status as ReasonProposal["status"],
			sourceTriggerIds: this.readRelationIds(
				"reason_proposal_triggers",
				"trigger_id",
				challengeId,
				"proposal_id",
				proposalId,
			),
			reasonLeaseGeneration: Number(row.reason_lease_generation),
			baseEventSequence: Number(row.base_event_sequence),
			contextFingerprint: String(row.context_fingerprint),
			rationaleSummary: String(row.rationale_summary),
			proposedIntents: intents.map((intent) => ({
				clientId: intent.client_id,
				objective: intent.objective,
				rationale: intent.rationale,
				priority: intent.priority,
				successCriteria: this.readOrderedProposalValues(
					"reason_proposal_success_criteria",
					"criterion",
					challengeId,
					proposalId,
					intent.ordinal,
				),
				capabilityTags: this.readProposalValues(
					"reason_proposal_capability_tags",
					"tag",
					challengeId,
					proposalId,
					intent.ordinal,
				),
				fromFactIds: this.readProposalValues(
					"reason_proposal_fact_refs",
					"fact_id",
					challengeId,
					proposalId,
					intent.ordinal,
				),
				sourceHintIds: this.readProposalValues(
					"reason_proposal_hint_refs",
					"hint_id",
					challengeId,
					proposalId,
					intent.ordinal,
				),
				supersedesIntentIds: this.readProposalValues(
					"reason_proposal_intent_supersedes",
					"intent_id",
					challengeId,
					proposalId,
					intent.ordinal,
				),
			})),
			supersedeRecommendations: this.allRows<{
				intent_id: string;
				rationale: string;
				replacement_client_id: string | null;
			}>(
				`SELECT intent_id, rationale, replacement_client_id
                 FROM reason_proposal_supersede_recommendations
                 WHERE challenge_id = ? AND proposal_id = ? ORDER BY ordinal`,
				challengeId,
				proposalId,
			).map((item) => ({
				intentId: item.intent_id,
				rationale: item.rationale,
				replacementClientId: item.replacement_client_id ?? undefined,
			})),
			model: String(row.model),
			provider: String(row.provider),
			promptVersion: String(row.prompt_version),
			createdAt: String(row.created_at),
			validationErrors: this.allRows<{ error: string }>(
				`SELECT error FROM reason_proposal_validation_errors
                 WHERE challenge_id = ? AND proposal_id = ? ORDER BY ordinal`,
				challengeId,
				proposalId,
			).map((item) => item.error),
		};
	}

	private reasonProposalApplyResultFromRow(row: {
		proposal_id: string;
		challenge_id: string;
		status: ReasonProposalApplyResult["status"];
		applied_at: string;
		applied_event_sequence: number;
	}): ReasonProposalApplyResult {
		const createdIntentRows = this.allRows<{ client_id: string; intent_id: string | null }>(
			`SELECT client_id, intent_id FROM reason_proposal_intent_results
             WHERE challenge_id = ? AND proposal_id = ? AND status = 'created'
             ORDER BY client_id`,
			row.challenge_id,
			row.proposal_id,
		);
		const skippedIntentRows = this.allRows<{ client_id: string; intent_id: string | null; reason: string }>(
			`SELECT client_id, intent_id, reason FROM reason_proposal_intent_results
             WHERE challenge_id = ? AND proposal_id = ? AND status = 'skipped_duplicate'
             ORDER BY client_id`,
			row.challenge_id,
			row.proposal_id,
		);
		const supersedeRows = this.allRows<{ intent_id: string }>(
			`SELECT intent_id FROM reason_proposal_supersede_results
             WHERE challenge_id = ? AND proposal_id = ? AND status = 'superseded'
             ORDER BY intent_id`,
			row.challenge_id,
			row.proposal_id,
		);
		const skippedSupersedeRows = this.allRows<{ intent_id: string; reason: string }>(
			`SELECT intent_id, reason FROM reason_proposal_supersede_results
             WHERE challenge_id = ? AND proposal_id = ? AND status = 'skipped'
             ORDER BY intent_id`,
			row.challenge_id,
			row.proposal_id,
		);
		return {
			proposalId: row.proposal_id,
			challengeId: row.challenge_id,
			status: row.status,
			createdIntentIds: createdIntentRows
				.map((item) => item.intent_id)
				.filter((item): item is string => item !== null)
				.sort(),
			skippedIntents: skippedIntentRows.map((item) => ({
				clientId: item.client_id,
				reason: item.reason,
				duplicateIntentId: item.intent_id ?? undefined,
			})),
			supersededIntentIds: supersedeRows.map((item) => item.intent_id),
			skippedSupersedes: skippedSupersedeRows.map((item) => ({
				intentId: item.intent_id,
				reason: item.reason,
			})),
			staleReasons: this.allRows<{ reason: string }>(
				`SELECT reason FROM reason_proposal_stale_reasons
                 WHERE challenge_id = ? AND proposal_id = ? ORDER BY ordinal`,
				row.challenge_id,
				row.proposal_id,
			).map((item) => item.reason),
			eventSequence: row.applied_event_sequence,
			appliedAt: row.applied_at,
		};
	}

	private readProposalValues(
		table: string,
		column: string,
		challengeId: string,
		proposalId: string,
		intentOrdinal: number,
	): string[] {
		return this.allRows<{ value: string }>(
			`SELECT ${column} AS value FROM ${table}
             WHERE challenge_id = ? AND proposal_id = ? AND intent_ordinal = ? ORDER BY ${column}`,
			challengeId,
			proposalId,
			intentOrdinal,
		).map((row) => row.value);
	}

	private readOrderedProposalValues(
		table: string,
		column: string,
		challengeId: string,
		proposalId: string,
		intentOrdinal: number,
	): string[] {
		return this.allRows<{ value: string }>(
			`SELECT ${column} AS value FROM ${table}
             WHERE challenge_id = ? AND proposal_id = ? AND intent_ordinal = ? ORDER BY ordinal`,
			challengeId,
			proposalId,
			intentOrdinal,
		).map((row) => row.value);
	}

	private allRows<T>(sql: string, ...bindings: Array<string | number | null>): T[] {
		const statement = this.database.prepare(sql);
		return statement.all(...bindings) as T[];
	}

	private getRow<T>(sql: string, ...bindings: Array<string | number | null>): T {
		const row = this.getOptionalRow<T>(sql, ...bindings);
		if (row === null) throw new Error(`query returned no row: ${sql}`);
		return row;
	}

	private getOptionalRow<T>(sql: string, ...bindings: Array<string | number | null>): T | null {
		const statement = this.database.prepare(sql);
		return (statement.get(...bindings) ?? null) as T | null;
	}

	private requireInitialized(): void {
		if (!this.initialized) throw new Error("GraphStore.initialize() is required");
	}

	private requireChallenge(expected: string, actual: string, entity: string): void {
		if (expected !== actual) throw new Error(`${entity} challengeId does not match migration batch`);
	}
}

export function openShadowGraphStore(options: OpenShadowGraphStoreOptions): GraphStore | undefined {
	if (options.shadowEnabled !== true) return;
	const store = new GraphStore(options.databasePath ?? DEFAULT_GRAPH_DATABASE_PATH);
	store.initialize();
	return store;
}
