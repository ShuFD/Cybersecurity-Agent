import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createNodeSqliteFactory, type SqliteDatabase } from "@earendil-works/pi-session-backend-sqlite-node";
import { applyArtexObservation, applyArtexPlan, createArtexGraph, projectArtexGraph } from "./artex-graph.ts";
import type { ArtexGraph, ArtexObservation, ArtexPlanUpdate } from "./artex-types.ts";
import {
	PLANNING_SCHEMA_VERSION,
	type PlanningAttemptReport,
	type PlanningCheckpoint,
	type PlanningCheckpointInput,
	type PlanningEvidence,
	type PlanningEvidenceInput,
	type PlanningEvidenceListOptions,
	type PlanningEvidenceListResult,
	type PlanningEvidenceReadResult,
	type PlanningExecutionFrameRecord,
	type PlanningLeaseStatus,
	type PlanningMode,
	type PlanningRun,
	type PlanningRunStatus,
	type PlanningSnapshot,
	type PlanningTask,
	type PlanningTaskLease,
	type PlanningTaskOutcome,
	type PlanningTaskResult,
	type PlanningTaskStatus,
} from "./contracts.ts";
import {
	EVIDENCE_PAGE_SIZE,
	type EvidenceCard,
	type EvidenceCardInput,
	type EvidenceRow,
	evidenceFromRow,
	PlanningEvidenceRepository,
	planningEvidenceSchema,
	validateEvidencePage,
} from "./evidence-cards.ts";
import { readEvidenceBlob } from "./evidence-store.ts";
import {
	PlanningCheckpointValidationError,
	PlanningEvidenceListInputError,
	PlanningEvidenceNotFoundError,
	PlanningPersistenceError,
	PlanningResultValidationError,
	planningFailure,
} from "./failures.ts";
import {
	emptyExecutionFrame,
	normalizeExecutionFrame,
	reduceExecutionFrame,
	registerPlanningArtifact,
	resolveArtifactScope,
} from "./frame-reducer.ts";
import {
	applyHypothesisObservation,
	applyHypothesisUpdate,
	emptyHypothesisGraph,
	HypothesisInputError,
	hypothesisTaskRunnable,
} from "./hypothesis-graph.ts";
import type { HypothesisGraph, HypothesisGraphUpdate, HypothesisObservation } from "./hypothesis-types.ts";

export interface CreatePlanningRunInput {
	runId: string;
	outerTaskId: string;
	goal: string;
	mode: PlanningMode;
}

export interface CompiledPlanningTask {
	taskId: string;
	objective: string;
	doneWhen: string;
	priority: number;
	sequence: number;
	dependsOnTaskIds: string[];
	inputEvidenceRefs?: string[];
	parentTaskId?: string;
}

export interface CommitPlanningPlanInput {
	artexUpdate?: ArtexPlanUpdate;
	hypothesisUpdate?: HypothesisGraphUpdate;
	/** PLAN_MULTI may append tasks without mutating any existing task or lease. */
	allowActiveLeases?: boolean;
	runId: string;
	expectedRevision: number;
	rationale: string;
	idempotencyKey: string;
	tasks: CompiledPlanningTask[];
}

export interface CommitPlanningResultInput {
	leaseId: string;
	planRevision: number;
	result?: PlanningTaskResult;
	preserveTaskProvenance?: boolean;
	/** Trusted executor workspace used only to register producer-local artifact aliases. */
	artifactWorkspace?: string;
	outcome?: PlanningTaskOutcome;
	summary?: string;
	evidence: PlanningEvidenceInput[];
}

export interface PlanningLifecycleEvent {
	eventId: string;
	runId: string;
	type: string;
	createdAt: number;
	/** SQLite rowid used as a stable insertion-order cursor. */
	sequence: number;
	payload: Record<string, unknown>;
}

export interface PlanningLifecycleEventPage {
	events: PlanningLifecycleEvent[];
	totalCount: number;
	nextCursor: string | null;
}

export interface ListLifecycleEventsOptions {
	cursor?: string | number;
	limit?: number;
}

export interface SealPlanningAttemptInput {
	leaseId: string;
	source: "runtime_failure";
	stage: string;
	code: string;
	message: string;
	progress?: PlanningCheckpointInput;
}

export interface PlanningAttemptRoutingInput {
	leaseId: string;
	routingState: "terminal" | "replan_queued" | "supervisor_started";
	replanAllowed: boolean;
	replanStarted: boolean;
	replanReason: string;
}

interface RunRow {
	run_id: string;
	outer_task_id: string;
	goal: string;
	mode: PlanningMode;
	status: PlanningRunStatus;
	revision: number;
	created_at: number;
	updated_at: number;
	last_error: string | null;
}

interface TaskRow {
	task_id: string;
	run_id: string;
	objective: string;
	done_when: string;
	status: PlanningTaskStatus;
	priority: number;
	sequence_no: number;
	parent_task_id: string | null;
	created_at: number;
	updated_at: number;
	last_error: string | null;
	input_evidence_refs_json: string | null;
}

interface EvidencePageCursor {
	v: 1;
	highWaterRowId: number;
	beforeCreatedAt: number;
	beforeRowId: number;
	scope: string;
}

function evidenceQueryScope(runId: string, options: PlanningEvidenceListOptions): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				runId,
				taskId: options.taskId?.trim().slice(0, 256) ?? "",
				leaseId: options.leaseId?.trim().slice(0, 256) ?? "",
				toolName: options.toolName?.trim().slice(0, 128) ?? "",
				outcome: options.outcome ?? "",
				keyword: options.keyword?.trim().slice(0, 128) ?? "",
			}),
		)
		.digest("hex");
}

function decodeEvidencePageCursor(cursor: string, scope: string): EvidencePageCursor {
	try {
		const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			const value = parsed as Record<string, unknown>;
			if (
				value.v === 1 &&
				typeof value.highWaterRowId === "number" &&
				Number.isSafeInteger(value.highWaterRowId) &&
				typeof value.beforeCreatedAt === "number" &&
				Number.isSafeInteger(value.beforeCreatedAt) &&
				typeof value.beforeRowId === "number" &&
				Number.isSafeInteger(value.beforeRowId) &&
				typeof value.scope === "string" &&
				value.scope === scope &&
				value.beforeRowId > 0 &&
				value.beforeRowId <= value.highWaterRowId
			) {
				return value as unknown as EvidencePageCursor;
			}
		}
	} catch {
		// The common error below keeps malformed cursors from changing query scope.
	}
	throw new PlanningEvidenceListInputError("invalid_cursor");
}

function encodeEvidencePageCursor(cursor: EvidencePageCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

interface ExecutionFrameRow {
	run_id: string;
	revision: number;
	frame_json: string;
	updated_at: number;
}

interface LeaseRow {
	lease_id: string;
	run_id: string;
	task_id: string;
	plan_revision: number;
	objective: string;
	done_when: string;
	allowed_scope: string;
	issued_at: number;
	expires_at: number;
	status: PlanningLeaseStatus;
	attempt_no: number | null;
	ended_at: number | null;
	failure_report_json: string | null;
}

interface LifecycleEventRow {
	event_id: string;
	run_id: string;
	type: string;
	payload_json: string;
	created_at: number;
	sequence: number;
}

interface CheckpointRow {
	checkpoint_id: string;
	run_id: string;
	task_id: string;
	lease_id: string;
	checkpoint_sequence: number;
	checkpoint_json: string;
	created_at: number;
}

const IMPOSSIBLE_DEPENDENCY_STATUSES = new Set<PlanningTaskStatus>(["blocked", "failed", "pruned"]);
const MAX_LIFECYCLE_EVENT_PAGE_SIZE = 200;

function parseRecord(value: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function parseStringArray(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
			: [];
	} catch {
		return [];
	}
}

function runFromRow(row: RunRow): PlanningRun {
	return {
		runId: row.run_id,
		outerTaskId: row.outer_task_id,
		goal: row.goal,
		mode: row.mode,
		status: row.status,
		revision: row.revision,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(row.last_error ? { lastError: row.last_error } : {}),
	};
}

function taskFromRow(row: TaskRow, dependencies: string[]): PlanningTask {
	return {
		taskId: row.task_id,
		runId: row.run_id,
		objective: row.objective,
		doneWhen: row.done_when,
		status: row.status,
		priority: row.priority,
		sequence: row.sequence_no,
		dependsOnTaskIds: dependencies,
		inputEvidenceRefs: parseStringArray(row.input_evidence_refs_json),
		...(row.parent_task_id ? { parentTaskId: row.parent_task_id } : {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(row.last_error ? { lastError: row.last_error } : {}),
	};
}

function frameFromRow(row: ExecutionFrameRow): PlanningExecutionFrameRecord {
	return {
		runId: row.run_id,
		revision: row.revision,
		frame: normalizeExecutionFrame(parseRecord(row.frame_json)),
		updatedAt: row.updated_at,
	};
}

function ensureEvidenceColumns(db: SqliteDatabase): void {
	const columns = new Set(
		db
			.prepare("PRAGMA table_info(planning_evidence)")
			.all<{ name: string }>()
			.map((row) => row.name),
	);
	const additions: Array<[string, string]> = [
		["tool_name", "TEXT"],
		["excerpt", "TEXT NOT NULL DEFAULT ''"],
		["content_ref", "TEXT"],
		["excerpt_hash", "TEXT"],
		["locator_json", "TEXT NOT NULL DEFAULT '{}'"],
		["content_bytes", "INTEGER NOT NULL DEFAULT 0"],
		["is_truncated", "INTEGER NOT NULL DEFAULT 1"],
	];
	for (const [name, definition] of additions) {
		if (!columns.has(name)) db.exec(`ALTER TABLE planning_evidence ADD COLUMN ${name} ${definition}`);
	}
}

function ensurePlanningColumns(db: SqliteDatabase): void {
	const taskColumns = new Set(
		db
			.prepare("PRAGMA table_info(planning_tasks)")
			.all<{ name: string }>()
			.map((row) => row.name),
	);
	if (!taskColumns.has("input_evidence_refs_json")) {
		db.exec("ALTER TABLE planning_tasks ADD COLUMN input_evidence_refs_json TEXT NOT NULL DEFAULT '[]'");
	}
	const leaseColumns = new Set(
		db
			.prepare("PRAGMA table_info(planning_leases)")
			.all<{ name: string }>()
			.map((row) => row.name),
	);
	const additions: Array<[string, string]> = [
		["attempt_no", "INTEGER NOT NULL DEFAULT 1"],
		["ended_at", "INTEGER"],
		["failure_report_json", "TEXT"],
	];
	for (const [name, definition] of additions) {
		if (!leaseColumns.has(name)) db.exec(`ALTER TABLE planning_leases ADD COLUMN ${name} ${definition}`);
	}
}

function leaseFromRow(row: LeaseRow): PlanningTaskLease {
	return {
		schemaVersion: PLANNING_SCHEMA_VERSION,
		leaseId: row.lease_id,
		runId: row.run_id,
		taskId: row.task_id,
		planRevision: row.plan_revision,
		objective: row.objective,
		doneWhen: row.done_when,
		allowedScope: row.allowed_scope,
		issuedAt: row.issued_at,
		expiresAt: row.expires_at,
		attempt: Number(row.attempt_no ?? 1),
	};
}

function checkpointFromRow(row: CheckpointRow): PlanningCheckpoint {
	const payload = parseRecord(row.checkpoint_json);
	return {
		schemaVersion: PLANNING_SCHEMA_VERSION,
		checkpointId: row.checkpoint_id,
		runId: row.run_id,
		taskId: row.task_id,
		leaseId: row.lease_id,
		checkpointSequence: row.checkpoint_sequence,
		source: "executor",
		summary: typeof payload.summary === "string" ? payload.summary : "",
		evidenceRefs: parseStringArrayFromValue(payload.evidenceRefs),
		completedItems: parseStringArrayFromValue(payload.completedItems),
		remainingItems: parseStringArrayFromValue(payload.remainingItems),
		rejectedDirections: Array.isArray(payload.rejectedDirections)
			? (payload.rejectedDirections as PlanningCheckpoint["rejectedDirections"])
			: [],
		artifacts: Array.isArray(payload.artifacts) ? (payload.artifacts as PlanningCheckpoint["artifacts"]) : [],
		suggestedNextSteps: Array.isArray(payload.suggestedNextSteps)
			? (payload.suggestedNextSteps as PlanningCheckpoint["suggestedNextSteps"])
			: [],
		createdAt: row.created_at,
	};
}

function parseStringArrayFromValue(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		: [];
}

function stableEvidenceId(leaseId: string, item: PlanningEvidenceInput): string {
	if (item.evidenceId) return item.evidenceId;
	return `evidence-${createHash("sha256")
		.update(`${leaseId}\0${item.toolName ?? item.source}\0${item.contentHash}\0${item.excerptHash ?? ""}`)
		.digest("hex")
		.slice(0, 32)}`;
}

function boundedFailureMessage(message: string): string {
	return message.trim().slice(0, 2_000);
}

function checkpointEvidenceRefs(input: PlanningCheckpointInput): string[] {
	return [
		...new Set([
			...input.evidenceRefs,
			...input.rejectedDirections.flatMap((item) => item.evidenceRefs),
			...input.suggestedNextSteps.flatMap((item) => item.inputEvidenceRefs ?? []),
		]),
	];
}

function checkpointValidationError(
	message: string,
	reason: string,
	fieldName: string,
	options: {
		scopeDecision?: "not_checked" | "accepted" | "rejected";
		evidenceRefs?: string[];
		artifactReferenceHashes?: string[];
	} = {},
): PlanningCheckpointValidationError {
	return new PlanningCheckpointValidationError(message, {
		reason,
		fieldName,
		scopeDecision: options.scopeDecision ?? "not_checked",
		...(options.evidenceRefs?.length
			? { evidenceRefs: options.evidenceRefs.slice(0, 16).map((reference) => reference.slice(0, 256)) }
			: {}),
		...(options.artifactReferenceHashes?.length
			? { artifactReferenceHashes: options.artifactReferenceHashes.slice(0, 16) }
			: {}),
	});
}

function validateCheckpointInput(checkpointId: string, input: PlanningCheckpointInput): void {
	if (checkpointId.trim().length === 0 || checkpointId.length > 256)
		throw checkpointValidationError(
			"Checkpoint id must be between 1 and 256 characters",
			"checkpoint_id_invalid",
			"checkpointId",
		);
	if (input.summary.trim().length === 0 || input.summary.length > 8_000)
		throw checkpointValidationError(
			"Checkpoint summary must be between 1 and 8,000 characters",
			"checkpoint_summary_invalid",
			"summary",
		);
	if (input.evidenceRefs.length > 256 || input.evidenceRefs.some((item) => item.length === 0 || item.length > 256))
		throw checkpointValidationError(
			"Checkpoint evidenceRefs exceed the allowed bound",
			"checkpoint_evidence_refs_out_of_bounds",
			"evidenceRefs",
			{ evidenceRefs: input.evidenceRefs, scopeDecision: "not_checked" },
		);
	if (
		input.completedItems.length > 64 ||
		input.remainingItems.length > 64 ||
		input.completedItems.some((item) => item.length === 0 || item.length > 2_000) ||
		input.remainingItems.some((item) => item.length === 0 || item.length > 2_000)
	)
		throw checkpointValidationError(
			"Checkpoint item lists exceed the allowed bound",
			"checkpoint_items_out_of_bounds",
			"completedItems|remainingItems",
		);
	const rejectedDirectionTooLarge = input.rejectedDirections.some(
		(item) =>
			item.direction.length === 0 ||
			item.direction.length > 2_000 ||
			item.reason.length === 0 ||
			item.reason.length > 20_000 ||
			item.evidenceRefs.length > 256 ||
			item.evidenceRefs.some((evidenceId) => evidenceId.length === 0 || evidenceId.length > 256),
	);
	if (input.rejectedDirections.length > 64 || rejectedDirectionTooLarge)
		throw checkpointValidationError(
			"Checkpoint rejected directions exceed the allowed bound",
			"checkpoint_rejected_directions_out_of_bounds",
			"rejectedDirections",
			{ evidenceRefs: input.rejectedDirections.flatMap((item) => item.evidenceRefs) },
		);
	const artifactTooLarge = input.artifacts.some(
		(item) =>
			item.path.length === 0 ||
			item.path.length > 4_096 ||
			item.type.length === 0 ||
			item.type.length > 256 ||
			item.description.length === 0 ||
			item.description.length > 8_000 ||
			(item.sha256 !== undefined && item.sha256.length > 128),
	);
	if (input.artifacts.length > 64 || artifactTooLarge)
		throw checkpointValidationError(
			"Checkpoint artifacts exceed the allowed bound",
			"checkpoint_artifacts_out_of_bounds",
			"artifacts",
			{
				artifactReferenceHashes: input.artifacts
					.slice(0, 16)
					.map((artifact) => createHash("sha256").update(artifact.path).digest("hex")),
			},
		);
	if (
		input.suggestedNextSteps.length > 48 ||
		input.suggestedNextSteps.some(
			(item) =>
				item.objective.length === 0 ||
				item.objective.length > 40_000 ||
				item.doneWhen.length === 0 ||
				item.doneWhen.length > 40_000 ||
				(item.inputEvidenceRefs?.length ?? 0) > 256 ||
				(item.inputEvidenceRefs ?? []).some((evidenceId) => evidenceId.length === 0 || evidenceId.length > 256),
		)
	)
		throw checkpointValidationError(
			"Checkpoint suggested next steps exceed the allowed bound",
			"checkpoint_suggested_next_steps_out_of_bounds",
			"suggestedNextSteps",
			{ evidenceRefs: input.suggestedNextSteps.flatMap((item) => item.inputEvidenceRefs ?? []) },
		);
	const serialized = JSON.stringify(input);
	if (Buffer.byteLength(serialized, "utf8") > 64 * 1024)
		throw checkpointValidationError("Checkpoint JSON exceeds the 64 KiB bound", "checkpoint_json_out_of_bounds", "$");
}

export class PlanningStore {
	readonly path: string;
	private readonly db: SqliteDatabase;
	private readonly stateDir?: string;
	private readonly evidenceRepository: PlanningEvidenceRepository;

	private constructor(db: SqliteDatabase, path: string) {
		this.db = db;
		this.evidenceRepository = new PlanningEvidenceRepository(db);
		this.path = path;
		this.stateDir = path === ":memory:" ? undefined : dirname(path);
	}

	static async open(path: string): Promise<PlanningStore> {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		const db = await createNodeSqliteFactory().open(path);
		db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
		db.exec(`
			CREATE TABLE IF NOT EXISTS planning_runs (
				run_id TEXT PRIMARY KEY,
				outer_task_id TEXT NOT NULL,
				goal TEXT NOT NULL,
				mode TEXT NOT NULL,
				status TEXT NOT NULL,
				revision INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				last_error TEXT
			);
			CREATE UNIQUE INDEX IF NOT EXISTS planning_runs_outer_idx ON planning_runs(outer_task_id);
			CREATE TABLE IF NOT EXISTS planning_tasks (
				task_id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES planning_runs(run_id) ON DELETE CASCADE,
				objective TEXT NOT NULL,
				done_when TEXT NOT NULL,
				status TEXT NOT NULL,
				priority REAL NOT NULL,
				sequence_no INTEGER NOT NULL,
				parent_task_id TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				last_error TEXT,
				input_evidence_refs_json TEXT NOT NULL DEFAULT '[]'
			);
			CREATE INDEX IF NOT EXISTS planning_tasks_schedule_idx
				ON planning_tasks(run_id, status, priority DESC, sequence_no ASC);
			CREATE TABLE IF NOT EXISTS planning_dependencies (
				task_id TEXT NOT NULL REFERENCES planning_tasks(task_id) ON DELETE CASCADE,
				depends_on_task_id TEXT NOT NULL REFERENCES planning_tasks(task_id) ON DELETE CASCADE,
				PRIMARY KEY(task_id, depends_on_task_id)
			);
			CREATE TABLE IF NOT EXISTS planning_leases (
				lease_id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES planning_runs(run_id) ON DELETE CASCADE,
				task_id TEXT NOT NULL REFERENCES planning_tasks(task_id) ON DELETE CASCADE,
				plan_revision INTEGER NOT NULL,
				objective TEXT NOT NULL,
				done_when TEXT NOT NULL,
				allowed_scope TEXT NOT NULL,
				issued_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL,
				status TEXT NOT NULL,
				 committed_at INTEGER,
				 attempt_no INTEGER NOT NULL DEFAULT 1,
				 ended_at INTEGER,
				 failure_report_json TEXT
			);
			${planningEvidenceSchema(true)}
			CREATE TABLE IF NOT EXISTS planning_execution_frames (
				run_id TEXT PRIMARY KEY REFERENCES planning_runs(run_id) ON DELETE CASCADE,
				revision INTEGER NOT NULL DEFAULT 0,
				frame_json TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS planning_hypothesis_graphs (run_id TEXT PRIMARY KEY REFERENCES planning_runs(run_id), graph_json TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS planning_artex_graphs (run_id TEXT PRIMARY KEY REFERENCES planning_runs(run_id), graph_json TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS planning_checkpoints (
				checkpoint_id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES planning_runs(run_id) ON DELETE CASCADE,
				task_id TEXT NOT NULL REFERENCES planning_tasks(task_id) ON DELETE CASCADE,
				lease_id TEXT NOT NULL REFERENCES planning_leases(lease_id) ON DELETE CASCADE,
				checkpoint_sequence INTEGER NOT NULL,
				checkpoint_json TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				UNIQUE(lease_id, checkpoint_sequence)
			);
			CREATE INDEX IF NOT EXISTS planning_checkpoints_run_idx
				ON planning_checkpoints(run_id, created_at DESC);
			CREATE TABLE IF NOT EXISTS planning_events (
				event_id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES planning_runs(run_id) ON DELETE CASCADE,
				type TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				idempotency_key TEXT,
				created_at INTEGER NOT NULL
			);
			CREATE UNIQUE INDEX IF NOT EXISTS planning_events_idempotency_idx
				ON planning_events(idempotency_key) WHERE idempotency_key IS NOT NULL;
		`);
		// Replace the run-wide exclusion atomically; reopening is idempotent.
		db.transaction(() =>
			db.exec(
				"CREATE UNIQUE INDEX IF NOT EXISTS planning_active_task_lease_idx ON planning_leases(run_id, task_id) WHERE status = 'active'; DROP INDEX IF EXISTS planning_active_run_lease_idx;",
			),
		);
		ensureEvidenceColumns(db);
		ensurePlanningColumns(db);
		db.exec("CREATE INDEX IF NOT EXISTS planning_evidence_content_ref_idx ON planning_evidence(content_ref);");
		return new PlanningStore(db, path);
	}

	createRun(input: CreatePlanningRunInput, now = Date.now()): PlanningRun {
		return this.db.transaction(() => {
			const existing = this.db.prepare("SELECT * FROM planning_runs WHERE run_id = ?").get<RunRow>(input.runId);
			if (existing) {
				if (existing.outer_task_id !== input.outerTaskId)
					throw new Error("Planning run id belongs to another outer task");
				this.ensureExecutionFrame(input.runId, existing.updated_at);
				return runFromRow(existing);
			}
			this.db
				.prepare(`
				INSERT INTO planning_runs
				(run_id, outer_task_id, goal, mode, status, revision, created_at, updated_at)
				VALUES (?, ?, ?, ?, 'created', 0, ?, ?)
			`)
				.run(input.runId, input.outerTaskId, input.goal, input.mode, now, now);
			this.ensureExecutionFrame(input.runId, now);
			this.insertEvent(input.runId, "run_created", { mode: input.mode, outerTaskId: input.outerTaskId }, now);
			return this.requireRun(input.runId);
		});
	}

	getRun(runId: string): PlanningRun | undefined {
		const row = this.db.prepare("SELECT * FROM planning_runs WHERE run_id = ?").get<RunRow>(runId);
		return row ? runFromRow(row) : undefined;
	}

	recordLifecycleEvent(
		runId: string,
		type: string,
		payload: Record<string, unknown>,
		now = Date.now(),
		idempotencyKey?: string,
	): void {
		this.db.transaction(() => {
			this.requireRun(runId);
			this.insertEvent(runId, type, payload, now, idempotencyKey);
		});
	}

	listLifecycleEvents(runId: string, options: ListLifecycleEventsOptions = {}): PlanningLifecycleEventPage {
		const rawCursor = options.cursor ?? 0;
		const cursor =
			typeof rawCursor === "number" ? rawCursor : /^\d+$/u.test(rawCursor.trim()) ? Number(rawCursor) : Number.NaN;
		if (!Number.isSafeInteger(cursor) || cursor < 0)
			throw new Error("Planning lifecycle event cursor must be non-negative");
		const requestedLimit = options.limit ?? 100;
		if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
			throw new Error("Planning lifecycle event limit must be a positive integer");
		}
		const limit = Math.min(MAX_LIFECYCLE_EVENT_PAGE_SIZE, requestedLimit);
		const totalCount =
			this.db.prepare("SELECT COUNT(*) AS count FROM planning_events WHERE run_id = ?").get<{ count: number }>(runId)
				?.count ?? 0;
		const rows = this.db
			.prepare(`
				SELECT event_id, run_id, type, payload_json, created_at, rowid AS sequence
				FROM planning_events
				WHERE run_id = ? AND rowid > ?
				ORDER BY rowid ASC
				LIMIT ?
			`)
			.all<LifecycleEventRow>(runId, cursor, limit + 1);
		const hasMore = rows.length > limit;
		const pageRows = hasMore ? rows.slice(0, limit) : rows;
		return {
			events: pageRows.map((row) => ({
				eventId: row.event_id,
				runId: row.run_id,
				type: row.type,
				createdAt: row.created_at,
				sequence: row.sequence,
				payload: parseRecord(row.payload_json),
			})),
			totalCount,
			nextCursor: hasMore ? String(pageRows.at(-1)?.sequence ?? cursor) : null,
		};
	}

	getArtexGraph(runId: string): ArtexGraph | undefined {
		const row = this.db
			.prepare("SELECT graph_json FROM planning_artex_graphs WHERE run_id = ?")
			.get<{ graph_json: string }>(runId);
		return row ? (JSON.parse(row.graph_json) as ArtexGraph) : undefined;
	}
	getArtexGraphForLease(leaseId: string): ArtexGraph {
		const graph = this.snapshot(this.requireActiveLease(leaseId).run_id, true).artexGraph;
		if (!graph) throw new Error("This is not an Artex run");
		return graph;
	}
	private saveArtexGraph(runId: string, graph: ArtexGraph): void {
		this.db
			.prepare(
				"INSERT INTO planning_artex_graphs (run_id, graph_json) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET graph_json = excluded.graph_json",
			)
			.run(runId, JSON.stringify(graph));
	}
	publishArtexObservation(leaseId: string, input: ArtexObservation): ArtexGraph {
		return this.db.transaction(() => {
			const lease = this.requireActiveLease(leaseId);
			const snapshot = this.snapshot(lease.run_id, true);
			if (!snapshot.artexGraph) throw new Error("This is not an Artex run");
			const next = applyArtexObservation(snapshot.artexGraph, input, snapshot, lease.task_id, leaseId);
			this.saveArtexGraph(lease.run_id, next);
			this.insertEvent(
				lease.run_id,
				"artex_observation_published",
				{
					taskId: lease.task_id,
					leaseId,
					graphVersion: next.version,
					kind: input.kind,
					evidenceRefs: input.evidenceRefs,
					nodeCount: next.nodes.length,
				},
				Date.now(),
			);
			return next;
		});
	}

	getHypothesisGraph(runId: string): HypothesisGraph | undefined {
		const row = this.db
			.prepare("SELECT graph_json FROM planning_hypothesis_graphs WHERE run_id = ?")
			.get<{ graph_json: string }>(runId);
		if (!row) return undefined;
		const graph = JSON.parse(row.graph_json) as HypothesisGraph;
		const cards = new Map(graph.cards.map((card) => [card.id, card]));
		for (const card of this.evidenceRepository.allCards(runId)) cards.set(card.id, card);
		return { ...graph, cards: [...cards.values()] };
	}
	getHypothesisGraphForLease(leaseId: string): HypothesisGraph {
		return this.getHypothesisGraph(this.requireActiveLease(leaseId).run_id) ?? emptyHypothesisGraph();
	}
	private saveHypothesisGraph(runId: string, graph: HypothesisGraph): void {
		this.db
			.prepare(
				"INSERT INTO planning_hypothesis_graphs (run_id, graph_json) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET graph_json = excluded.graph_json",
			)
			.run(runId, JSON.stringify(graph));
	}
	publishHypothesisObservation(leaseId: string, observation: HypothesisObservation): HypothesisGraph {
		return this.db.transaction(() => {
			const lease = this.requireActiveLease(leaseId);
			const graph = this.getHypothesisGraph(lease.run_id);
			if (!graph) throw new Error("This is not a hypothesis DAG run");
			if (JSON.stringify(observation).length > 20000)
				throw new HypothesisInputError("hypothesis_card_invalid", "Observation exceeds the bounded card size", [
					"card",
					"resolutions",
				]);
			const next = applyHypothesisObservation(
				graph,
				observation,
				this.snapshot(lease.run_id, true),
				lease.task_id,
				leaseId,
			);
			for (const card of next.cards) this.evidenceRepository.saveCard(lease.run_id, card);
			this.saveHypothesisGraph(lease.run_id, next);
			this.refreshReadiness(lease.run_id, Date.now());
			this.insertEvent(
				lease.run_id,
				"hypothesis_observation_applied",
				{ taskId: lease.task_id, leaseId, graphVersion: next.version, observation },
				Date.now(),
			);
			return next;
		});
	}
	publishEvidenceCard(leaseId: string, input: EvidenceCardInput): EvidenceCard {
		return this.db.transaction(() => {
			const lease = this.requireActiveLease(leaseId);
			const card = this.evidenceRepository.publish({ runId: lease.run_id, taskId: lease.task_id, leaseId }, input);
			this.insertEvent(
				lease.run_id,
				"evidence_card_published",
				{ taskId: lease.task_id, leaseId, cardId: card.id },
				Date.now(),
				"card:" + card.id,
			);
			return card;
		});
	}
	listEvidenceCards(runId: string, after = 0, limit = EVIDENCE_PAGE_SIZE) {
		this.requireRun(runId);
		validateEvidencePage(after, limit);
		const cards = this.getEvidenceCards(runId);
		return {
			items: cards.slice(after, after + limit),
			nextCursor: Math.min(cards.length, after + limit),
			hasMore: after + limit < cards.length,
		};
	}
	getEvidenceCards(runId: string): EvidenceCard[] {
		// Historical DAG cards stay readable in place; no bulk migration.
		const cards = new Map((this.getHypothesisGraph(runId)?.cards ?? []).map((card) => [card.id, card]));
		for (const card of this.evidenceRepository.allCards(runId)) cards.set(card.id, card);
		return [...cards.values()];
	}
	private publishDeliveryCard(lease: LeaseRow, summary: string, refs: string[], scope: string): void {
		const cards = this.evidenceRepository.publishDelivery(
			{ runId: lease.run_id, taskId: lease.task_id, leaseId: lease.lease_id },
			{ summary, evidenceRefs: refs, scope },
		);
		for (const card of cards)
			this.insertEvent(
				lease.run_id,
				"evidence_card_published",
				{ taskId: lease.task_id, leaseId: lease.lease_id, cardId: card.id },
				Date.now(),
				"card:" + card.id,
			);
	}

	getExecutionFrame(runId: string): PlanningExecutionFrameRecord {
		const row = this.db
			.prepare("SELECT * FROM planning_execution_frames WHERE run_id = ?")
			.get<ExecutionFrameRow>(runId);
		if (!row) throw new Error(`Planning execution frame not found: ${runId}`);
		return frameFromRow(row);
	}

	listEvidence(runId: string, options: PlanningEvidenceListOptions = {}): PlanningEvidenceListResult {
		this.requireRun(runId);
		const requestedLimit = options.limit ?? 25;
		if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
			throw new PlanningEvidenceListInputError("invalid_limit");
		}
		const limit = Math.min(50, requestedLimit);
		const scope = evidenceQueryScope(runId, options);
		const cursor = options.cursor ? decodeEvidencePageCursor(options.cursor, scope) : undefined;
		const highWaterRowId =
			cursor?.highWaterRowId ??
			this.db
				.prepare("SELECT COALESCE(MAX(rowid), 0) AS row_id FROM planning_evidence WHERE run_id = ?")
				.get<{ row_id: number }>(runId)?.row_id ??
			0;
		const filters = ["run_id = ?"];
		const filterParameters: Array<string | number> = [runId];
		if (options.taskId?.trim()) {
			filters.push("task_id = ?");
			filterParameters.push(options.taskId.trim().slice(0, 256));
		}
		if (options.leaseId?.trim()) {
			filters.push("lease_id = ?");
			filterParameters.push(options.leaseId.trim().slice(0, 256));
		}
		if (options.toolName?.trim()) {
			filters.push("tool_name = ?");
			filterParameters.push(options.toolName.trim().slice(0, 128));
		}
		if (options.outcome === "success") filters.push("json_extract(metadata_json, '$.isError') = 0");
		if (options.outcome === "error") filters.push("json_extract(metadata_json, '$.isError') = 1");
		const keyword = options.keyword?.trim().slice(0, 128);
		if (keyword) {
			filters.push(
				"(instr(lower(summary), lower(?)) > 0 OR instr(lower(excerpt), lower(?)) > 0 OR instr(lower(metadata_json), lower(?)) > 0)",
			);
			filterParameters.push(keyword, keyword, keyword);
		}
		const where = filters.join(" AND ");
		const totalCount =
			this.db
				.prepare(`SELECT COUNT(*) AS count FROM planning_evidence WHERE ${where} AND rowid <= ?`)
				.get<{ count: number }>(...filterParameters, highWaterRowId)?.count ?? 0;
		const boundary = cursor ? "AND (created_at < ? OR (created_at = ? AND rowid < ?))" : "";
		const pageParameters: Array<string | number> = [
			...filterParameters,
			highWaterRowId,
			...(cursor ? [cursor.beforeCreatedAt, cursor.beforeCreatedAt, cursor.beforeRowId] : []),
			limit + 1,
		];
		const rows = this.db
			.prepare(
				`SELECT *, rowid AS row_sequence FROM planning_evidence
				WHERE ${where} AND rowid <= ? ${boundary}
				ORDER BY created_at DESC, rowid DESC
				LIMIT ?`,
			)
			.all<EvidenceRow & { row_sequence: number }>(...pageParameters);
		const hasMore = rows.length > limit;
		const pageRows = hasMore ? rows.slice(0, limit) : rows;
		const lastRow = pageRows.at(-1);
		return {
			items: pageRows.map(evidenceFromRow),
			totalCount,
			hasMore,
			nextCursor:
				hasMore && lastRow
					? encodeEvidencePageCursor({
							v: 1,
							highWaterRowId,
							beforeCreatedAt: lastRow.created_at,
							beforeRowId: lastRow.row_sequence,
							scope,
						})
					: null,
		};
	}

	recordObservation(
		leaseId: string,
		source: "planning_observer_report" | "planning_observer_runtime",
		summary: string,
		metadata: Record<string, unknown>,
		now = Date.now(),
	): PlanningEvidence {
		if (!summary.trim()) throw new Error("Planning observation summary must not be empty");
		return this.db.transaction(() => {
			const lease = this.requireActiveLease(leaseId);
			const contentHash = createHash("sha256").update(summary).digest("hex");
			const item: PlanningEvidenceInput = {
				kind: "observation",
				source,
				toolName: source,
				summary,
				excerpt: summary,
				contentHash,
				contentBytes: Buffer.byteLength(summary, "utf8"),
				contentComplete: true,
				isTruncated: false,
				metadata,
			};
			const evidenceId = stableEvidenceId(leaseId, item);
			const inserted = this.insertEvidence(lease, item, evidenceId, now, false);
			this.insertEvent(
				lease.run_id,
				"evidence_saved",
				{ taskId: lease.task_id, leaseId, evidenceId, evidenceCount: 1, inserted },
				now,
				`planning-evidence:${leaseId}:${evidenceId}`,
			);
			this.insertEvent(
				lease.run_id,
				"planning_observer_report_saved",
				{
					taskId: lease.task_id,
					leaseId,
					evidenceId,
					source,
					semanticReportGenerated: source === "planning_observer_report",
					...(Array.isArray(metadata.evidenceRefs)
						? {
								evidenceRefs: metadata.evidenceRefs
									.filter((item): item is string => typeof item === "string")
									.slice(0, 32),
							}
						: {}),
				},
				now,
				`planning-observation:${leaseId}:${evidenceId}`,
			);
			const row = this.db
				.prepare("SELECT * FROM planning_evidence WHERE run_id = ? AND evidence_id = ?")
				.get<EvidenceRow>(lease.run_id, evidenceId);
			if (!row) throw new Error(`Planning observation was not persisted: ${evidenceId}`);
			return evidenceFromRow(row);
		});
	}

	readEvidence(
		runId: string,
		evidenceId: string,
		options: { offset?: number; maxBytes?: number; requestId?: string; taskId?: string; leaseId?: string } = {},
	): PlanningEvidenceReadResult {
		const requestId = options.requestId?.replace(/[^A-Za-z0-9_.:-]/gu, "").slice(0, 128) ?? "";
		const eventKey =
			requestId && options.leaseId ? `planning-evidence-read:${options.leaseId}:${requestId}` : undefined;
		const recordReadEvent = (payload: Record<string, unknown>): void => {
			if (!requestId) return;
			try {
				this.recordLifecycleEvent(
					runId,
					"planning_evidence_read",
					{
						requestId,
						evidenceId: evidenceId.slice(0, 256),
						...(options.taskId ? { taskId: options.taskId.slice(0, 160) } : {}),
						...(options.leaseId ? { leaseId: options.leaseId.slice(0, 160) } : {}),
						...payload,
					},
					Date.now(),
					eventKey,
				);
			} catch (error) {
				throw new PlanningPersistenceError("Planning evidence read diagnostics could not be persisted", error);
			}
		};
		let row: EvidenceRow | undefined;
		try {
			row = this.db
				.prepare("SELECT * FROM planning_evidence WHERE run_id = ? AND evidence_id = ?")
				.get<EvidenceRow>(runId, evidenceId);
		} catch (error) {
			recordReadEvent({
				readState: "failed",
				failureCategory: "evidence_metadata_read_failed",
				scopeDecision: "not_checked",
			});
			throw error;
		}
		if (!row) {
			recordReadEvent({
				readState: "not_found",
				failureCategory: "evidence_not_found_in_run",
				scopeDecision: "rejected",
			});
			throw new PlanningEvidenceNotFoundError(evidenceId);
		}
		let result: PlanningEvidenceReadResult;
		try {
			if (row.content_ref) {
				result = readEvidenceBlob({
					stateDir: this.stateDir,
					contentRef: row.content_ref,
					contentHash: row.content_hash,
					offset: options.offset,
					maxBytes: options.maxBytes,
				});
			} else {
				const content = row.excerpt ?? row.summary;
				const bytes = Buffer.from(content, "utf8");
				const offset = Number.isFinite(options.offset) ? Math.max(0, Math.trunc(options.offset as number)) : 0;
				const maxBytes = Number.isFinite(options.maxBytes)
					? Math.min(64 * 1024, Math.max(256, Math.trunc(options.maxBytes as number)))
					: 64 * 1024;
				const chunk = bytes.subarray(offset, offset + maxBytes);
				result = {
					contentRef: "",
					contentHash: row.content_hash,
					offset,
					nextOffset: offset + chunk.length,
					totalBytes: bytes.length,
					hasMore: offset + chunk.length < bytes.length,
					content: chunk.toString("utf8"),
					contentComplete: false,
				};
			}
		} catch (error) {
			recordReadEvent({
				sourceTaskId: row.task_id,
				sourceLeaseId: row.lease_id,
				readState: "failed",
				failureCategory: "evidence_content_read_failed",
				scopeDecision: "accepted",
			});
			throw error;
		}
		const returnedBytes = Buffer.byteLength(result.content, "utf8");
		recordReadEvent({
			sourceRunId: row.run_id,
			sourceTaskId: row.task_id,
			sourceLeaseId: row.lease_id,
			offset: result.offset,
			nextOffset: result.nextOffset,
			totalBytes: result.totalBytes,
			requestedMaxBytes: Number.isFinite(options.maxBytes)
				? Math.min(64 * 1024, Math.max(256, Math.trunc(options.maxBytes as number)))
				: 64 * 1024,
			returnedBytes,
			contentHash: result.contentHash,
			resultHash: createHash("sha256").update(Buffer.from(result.content, "utf8")).digest("hex"),
			hasMore: result.hasMore,
			readState: "completed",
			scopeDecision: row.run_id === runId ? "accepted" : "rejected",
		});
		return result;
	}

	getAttemptCount(runId: string): number {
		return (
			this.db.prepare("SELECT COUNT(*) AS count FROM planning_leases WHERE run_id = ?").get<{ count: number }>(runId)
				?.count ?? 0
		);
	}

	snapshot(runId: string, includeRecentFailures = false): PlanningSnapshot {
		const run = this.requireRun(runId);
		this.ensureExecutionFrame(runId, run.updatedAt);
		const dependencies = this.db
			.prepare(`SELECT task_id, depends_on_task_id FROM planning_dependencies WHERE task_id IN
				(SELECT task_id FROM planning_tasks WHERE run_id = ?)`)
			.all<{ task_id: string; depends_on_task_id: string }>(runId);
		const byTask = new Map<string, string[]>();
		for (const row of dependencies) {
			const values = byTask.get(row.task_id) ?? [];
			values.push(row.depends_on_task_id);
			byTask.set(row.task_id, values);
		}
		const tasks = this.db
			.prepare("SELECT * FROM planning_tasks WHERE run_id = ? ORDER BY sequence_no ASC")
			.all<TaskRow>(runId)
			.map((row) => taskFromRow(row, byTask.get(row.task_id) ?? []));
		const evidence = this.db
			.prepare("SELECT * FROM planning_evidence WHERE run_id = ? ORDER BY created_at ASC")
			.all<EvidenceRow>(runId)
			.map(evidenceFromRow);
		const leases = this.db
			.prepare(
				"SELECT * FROM planning_leases WHERE run_id = ? AND status = 'active' ORDER BY issued_at DESC, lease_id ASC",
			)
			.all<LeaseRow>(runId);
		const latestCheckpoint = this.db
			.prepare("SELECT * FROM planning_checkpoints WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
			.get<CheckpointRow>(runId);
		const latestFailure = this.db
			.prepare(
				"SELECT failure_report_json FROM planning_leases WHERE run_id = ? AND failure_report_json IS NOT NULL ORDER BY ended_at DESC, rowid DESC LIMIT 1",
			)
			.get<{ failure_report_json: string }>(runId);
		const snapshot: PlanningSnapshot = {
			run,
			tasks,
			evidence,
			evidenceCards: this.getEvidenceCards(runId),
			executionFrame: this.getExecutionFrame(runId),
			...(this.getHypothesisGraph(runId) ? { hypothesisGraph: this.getHypothesisGraph(runId) } : {}),
			...(latestCheckpoint ? { latestCheckpoint: checkpointFromRow(latestCheckpoint) } : {}),
			...(latestFailure?.failure_report_json
				? { latestFailure: parseRecord(latestFailure.failure_report_json) as unknown as PlanningAttemptReport }
				: {}),
			...(includeRecentFailures
				? {
						recentFailures: this.db
							.prepare(
								"SELECT failure_report_json FROM planning_leases WHERE run_id = ? AND failure_report_json IS NOT NULL ORDER BY ended_at DESC, rowid DESC LIMIT 8",
							)
							.all<{ failure_report_json: string }>(runId)
							.map((row) => parseRecord(row.failure_report_json) as unknown as PlanningAttemptReport),
					}
				: {}),
			activeLeases: leases.map(leaseFromRow),
			...(leases.length === 1 ? { activeLease: leaseFromRow(leases[0]) } : {}),
		};
		const artex = this.getArtexGraph(runId);
		if (artex) snapshot.artexGraph = projectArtexGraph(artex, snapshot);
		return snapshot;
	}

	commitPlan(input: CommitPlanningPlanInput, now = Date.now()): PlanningSnapshot {
		return this.db.transaction(() => {
			const duplicate = this.db
				.prepare("SELECT event_id FROM planning_events WHERE idempotency_key = ?")
				.get<{ event_id: string }>(input.idempotencyKey);
			if (duplicate) return this.snapshot(input.runId);
			const run = this.requireRun(input.runId);
			if (run.revision !== input.expectedRevision) {
				throw new Error(`Stale planning revision: expected ${input.expectedRevision}, actual ${run.revision}`);
			}
			const active = this.db
				.prepare("SELECT lease_id FROM planning_leases WHERE run_id = ? AND status = 'active'")
				.get<{ lease_id: string }>(input.runId);
			if (active && !input.allowActiveLeases) throw new Error("Cannot revise a plan while a task lease is active");

			if (input.artexUpdate) {
				const snapshot = this.snapshot(input.runId, true);
				const graph = applyArtexPlan(
					snapshot.artexGraph ?? createArtexGraph(input.runId, snapshot.run.goal),
					input.artexUpdate,
					snapshot,
					input.tasks,
				);
				this.saveArtexGraph(input.runId, graph);
				this.insertEvent(
					input.runId,
					"artex_plan_applied",
					{
						graphVersion: graph.version,
						round: graph.round,
						nodeCount: graph.nodes.length,
						edgeCount: graph.edges.length,
						taskIds: input.tasks.map((task) => task.taskId),
					},
					now,
				);
			}
			if (input.hypothesisUpdate) {
				let graph: HypothesisGraph;
				try {
					graph = applyHypothesisUpdate(
						this.getHypothesisGraph(input.runId) ?? emptyHypothesisGraph(),
						input.hypothesisUpdate,
						this.snapshot(input.runId, true),
						input.tasks.map((task) => task.taskId),
						input.tasks,
					);
				} catch (error) {
					throw planningFailure(
						"proposal_validation",
						"proposal_validation_error",
						error instanceof Error ? error.message : String(error),
						error,
						input.runId,
					);
				}
				this.saveHypothesisGraph(input.runId, graph);
				this.insertEvent(
					input.runId,
					"hypothesis_plan_applied",
					{ graphVersion: graph.version, update: input.hypothesisUpdate },
					now,
				);
			}
			for (const task of input.tasks) {
				this.db
					.prepare(`
					INSERT INTO planning_tasks
					(task_id, run_id, objective, done_when, status, priority, sequence_no, parent_task_id, created_at, updated_at, input_evidence_refs_json)
					VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?)
				`)
					.run(
						task.taskId,
						input.runId,
						task.objective,
						task.doneWhen,
						task.priority,
						task.sequence,
						task.parentTaskId ?? null,
						now,
						now,
						JSON.stringify(task.inputEvidenceRefs ?? []),
					);
			}

			for (const task of input.tasks) {
				for (const dependency of task.dependsOnTaskIds) {
					this.db
						.prepare("INSERT INTO planning_dependencies (task_id, depends_on_task_id) VALUES (?, ?)")
						.run(task.taskId, dependency);
				}
			}
			const revision = run.revision + (input.tasks.length > 0 ? 1 : 0);
			this.db
				.prepare(
					"UPDATE planning_runs SET revision = ?, status = 'running', updated_at = ?, last_error = NULL WHERE run_id = ?",
				)
				.run(revision, now, input.runId);
			this.refreshReadiness(input.runId, now);
			this.insertEvent(
				input.runId,
				"plan_committed",
				{
					revision,
					rationale: input.rationale,
					taskIds: input.tasks.map((task) => task.taskId),
					taskInputEvidenceRefs: input.tasks.flatMap((task) =>
						(task.inputEvidenceRefs ?? []).map((evidenceId) => `${task.taskId}:${evidenceId}`),
					),
				},
				now,
				input.idempotencyKey,
			);
			return this.snapshot(input.runId);
		});
	}

	leaseTask(
		runId: string,
		taskId: string,
		allowedScope: string,
		ttlMs: number,
		now = Date.now(),
		capacity = 1,
	): PlanningTaskLease {
		return this.db.transaction(() => {
			this.recoverExpiredLeases(runId, now);
			const run = this.requireRun(runId);
			const active = this.db
				.prepare("SELECT lease_id FROM planning_leases WHERE run_id = ? AND task_id = ? AND status = 'active'")
				.get<{ lease_id: string }>(runId, taskId);
			if (active) throw new Error(`Planning task already has an active lease: ${active.lease_id}`);
			const activeCount =
				this.db
					.prepare("SELECT COUNT(*) AS count FROM planning_leases WHERE run_id = ? AND status = 'active'")
					.get<{ count: number }>(runId)?.count ?? 0;
			if (activeCount >= Math.max(1, Math.trunc(capacity)))
				throw new Error("Planning run already has an active lease at capacity");
			const task = this.db
				.prepare("SELECT * FROM planning_tasks WHERE run_id = ? AND task_id = ?")
				.get<TaskRow>(runId, taskId);
			if (!task) throw new Error(`Planning task not found: ${taskId}`);
			if (task.status !== "ready") throw new Error(`Planning task is not ready: ${taskId} (${task.status})`);
			const leaseId = randomUUID();
			const attempt =
				(this.db
					.prepare("SELECT COUNT(*) AS count FROM planning_leases WHERE run_id = ? AND task_id = ?")
					.get<{ count: number }>(runId, taskId)?.count ?? 0) + 1;
			const expiresAt = now + Math.max(5_000, Math.trunc(ttlMs));
			this.db
				.prepare(`
				INSERT INTO planning_leases
				(lease_id, run_id, task_id, plan_revision, objective, done_when, allowed_scope, issued_at, expires_at, status, attempt_no)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
			`)
				.run(
					leaseId,
					runId,
					taskId,
					run.revision,
					task.objective,
					task.done_when,
					allowedScope,
					now,
					expiresAt,
					attempt,
				);
			this.db
				.prepare("UPDATE planning_tasks SET status = 'leased', updated_at = ? WHERE task_id = ?")
				.run(now, taskId);
			this.insertEvent(runId, "task_leased", { taskId, leaseId, expiresAt, attemptNumber: attempt }, now);
			return leaseFromRow({
				lease_id: leaseId,
				run_id: runId,
				task_id: taskId,
				plan_revision: run.revision,
				objective: task.objective,
				done_when: task.done_when,
				allowed_scope: allowedScope,
				issued_at: now,
				expires_at: expiresAt,
				status: "active",
				attempt_no: attempt,
				ended_at: null,
				failure_report_json: null,
			});
		});
	}

	/** Renew only a still-active owned lease. Never resurrect sealed/expired work. */
	renewLease(leaseId: string, ttlMs: number, now = Date.now()): void {
		this.db.transaction(() => {
			const lease = this.requireActiveLease(leaseId);
			this.db
				.prepare("UPDATE planning_leases SET expires_at = ? WHERE lease_id = ? AND status = 'active'")
				.run(now + Math.max(5_000, Math.trunc(ttlMs)), lease.lease_id);
		});
	}

	startLease(leaseId: string, now = Date.now()): void {
		this.db.transaction(() => {
			const lease = this.requireActiveLease(leaseId);
			const result = this.db
				.prepare(
					"UPDATE planning_tasks SET status = 'running', updated_at = ? WHERE task_id = ? AND status = 'leased'",
				)
				.run(now, lease.task_id);
			if (result.changes !== 1) throw new Error(`Planning lease task is not leased: ${lease.task_id}`);
			this.insertEvent(lease.run_id, "task_started", { taskId: lease.task_id, leaseId }, now);
		});
	}

	recordEvidence(leaseId: string, evidence: PlanningEvidenceInput[], now = Date.now()): number {
		return this.db.transaction(() => {
			const lease = this.requireActiveLease(leaseId);
			let inserted = 0;
			for (const item of evidence) {
				const evidenceId = stableEvidenceId(leaseId, item);
				const wasInserted = this.insertEvidence(lease, item, evidenceId, now, false);
				inserted += wasInserted ? 1 : 0;
				this.insertEvent(
					lease.run_id,
					"evidence_saved",
					{
						taskId: lease.task_id,
						leaseId,
						evidenceId,
						evidenceCount: 1,
						inserted: wasInserted,
					},
					now,
					`planning-evidence:${leaseId}:${evidenceId}`,
				);
			}
			return inserted;
		});
	}

	recordAttemptEvidence(leaseId: string, evidence: PlanningEvidenceInput[], now = Date.now()): number {
		return this.db.transaction(() => {
			const lease = this.requireActiveLease(leaseId);
			let inserted = 0;
			for (const item of evidence) {
				const evidenceId = stableEvidenceId(leaseId, item);
				inserted += this.insertEvidence(lease, item, evidenceId, now, true) ? 1 : 0;
			}
			this.markLeaseEvidenceFailed(leaseId);
			this.insertEvent(
				lease.run_id,
				"attempt_evidence_recorded",
				{ taskId: lease.task_id, leaseId, evidenceCount: inserted },
				now,
				`planning-attempt-evidence:${leaseId}`,
			);
			return inserted;
		});
	}

	recordAttemptRouting(input: PlanningAttemptRoutingInput, now = Date.now()): void {
		const lease = this.db
			.prepare("SELECT run_id, task_id, attempt_no FROM planning_leases WHERE lease_id = ?")
			.get<{ run_id: string; task_id: string; attempt_no: number }>(input.leaseId);
		if (!lease) return;
		this.insertEvent(
			lease.run_id,
			"attempt_routing_decided",
			{
				taskId: lease.task_id,
				leaseId: input.leaseId,
				attemptNumber: Number(lease.attempt_no ?? 1),
				routingState: input.routingState,
				replanAllowed: input.replanAllowed,
				replanStarted: input.replanStarted,
				replanReason: input.replanReason.trim().slice(0, 512),
			},
			now,
			`planning-attempt-routing:${input.leaseId}:${input.routingState}`,
		);
	}

	recordCheckpoint(
		leaseId: string,
		checkpointId: string,
		input: PlanningCheckpointInput,
		now = Date.now(),
		elapsedMs?: number,
		artifactWorkspace?: string,
	): PlanningCheckpoint {
		try {
			validateCheckpointInput(checkpointId, input);
			const leaseState = this.db
				.prepare("SELECT run_id, task_id, status FROM planning_leases WHERE lease_id = ?")
				.get<{ run_id: string; task_id: string; status: PlanningLeaseStatus }>(leaseId);
			if (!leaseState || leaseState.status !== "active") {
				throw checkpointValidationError("Active planning lease not found", "active_lease_required", "leaseId", {
					scopeDecision: "rejected",
				});
			}
			return this.db.transaction(() => {
				const lease = this.requireActiveLease(leaseId);
				const knownEvidence = new Set(
					this.db
						.prepare("SELECT evidence_id FROM planning_evidence WHERE run_id = ?")
						.all<{ evidence_id: string }>(lease.run_id)
						.map((row) => row.evidence_id),
				);
				const unknownEvidence = checkpointEvidenceRefs(input).filter(
					(evidenceId) => !knownEvidence.has(evidenceId),
				);
				if (unknownEvidence.length > 0) {
					throw checkpointValidationError(
						"Checkpoint references evidence outside the current run or not yet persisted",
						"evidence_reference_not_persisted_or_wrong_run",
						"evidenceRefs",
						{ evidenceRefs: unknownEvidence, scopeDecision: "rejected" },
					);
				}
				const scopedArtifacts = input.artifacts.map((artifact, artifactIndex) => {
					const registered = registerPlanningArtifact(
						artifact,
						lease.allowed_scope,
						lease.task_id,
						lease.lease_id,
						artifactWorkspace,
					);
					if (!registered) {
						const resolution = resolveArtifactScope(artifact.path, lease.allowed_scope);
						throw checkpointValidationError(
							"Checkpoint artifact path did not pass active lease scope validation",
							resolution.accepted ? "artifact_scope_unverifiable" : resolution.reason,
							`artifacts[${artifactIndex}].path`,
							{
								scopeDecision: "rejected",
								artifactReferenceHashes: [createHash("sha256").update(artifact.path).digest("hex")],
							},
						);
					}
					return registered;
				});
				const persistedInput: PlanningCheckpointInput = { ...input, artifacts: scopedArtifacts };
				const duplicate = this.db
					.prepare("SELECT * FROM planning_checkpoints WHERE checkpoint_id = ?")
					.get<CheckpointRow>(checkpointId);
				if (duplicate) {
					if (
						duplicate.run_id !== lease.run_id ||
						duplicate.task_id !== lease.task_id ||
						duplicate.lease_id !== lease.lease_id
					) {
						throw checkpointValidationError(
							"Checkpoint identity is already bound to another lease",
							"checkpoint_identity_scope_rejected",
							"checkpointId",
							{ scopeDecision: "rejected" },
						);
					}
					return checkpointFromRow(duplicate);
				}
				const nextSequence =
					(this.db
						.prepare("SELECT MAX(checkpoint_sequence) AS sequence FROM planning_checkpoints WHERE lease_id = ?")
						.get<{ sequence: number | null }>(leaseId)?.sequence ?? 0) + 1;
				const persisted: PlanningCheckpoint = {
					schemaVersion: PLANNING_SCHEMA_VERSION,
					checkpointId,
					runId: lease.run_id,
					taskId: lease.task_id,
					leaseId,
					checkpointSequence: nextSequence,
					source: "executor",
					...persistedInput,
					createdAt: now,
				};
				this.db
					.prepare(
						"INSERT INTO planning_checkpoints (checkpoint_id, run_id, task_id, lease_id, checkpoint_sequence, checkpoint_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						checkpointId,
						lease.run_id,
						lease.task_id,
						leaseId,
						nextSequence,
						JSON.stringify(persistedInput),
						now,
					);
				this.insertEvent(
					lease.run_id,
					"planning_checkpoint_saved",
					{
						taskId: lease.task_id,
						leaseId,
						checkpointId,
						checkpointSequence: nextSequence,
						evidenceCount: checkpointEvidenceRefs(persistedInput).length,
						artifactCount: persistedInput.artifacts.length,
						source: "executor",
						...(elapsedMs === undefined ? {} : { elapsedMs: Math.max(0, Math.trunc(elapsedMs)) }),
					},
					now,
					`planning-checkpoint:${checkpointId}`,
				);
				this.publishDeliveryCard(lease, persistedInput.summary, persistedInput.evidenceRefs, "checkpoint");
				const graph = this.getHypothesisGraph(lease.run_id);
				if (graph) {
					graph.checkpointArtifacts ??= [];
					for (const artifact of persistedInput.artifacts) {
						graph.checkpointArtifacts = graph.checkpointArtifacts.filter(
							(item) => item.sourceTaskId !== lease.task_id || item.path !== artifact.path,
						);
						graph.checkpointArtifacts.push({
							sourceTaskId: lease.task_id,
							path: artifact.path,
							sha256: artifact.sha256,
							...("logicalPath" in artifact && typeof artifact.logicalPath === "string"
								? { logicalPath: artifact.logicalPath, sourceLeaseId: lease.lease_id }
								: {}),
						});
					}
					graph.version++;
					this.saveHypothesisGraph(lease.run_id, graph);
					this.refreshReadiness(lease.run_id, now);
				}
				return persisted;
			});
		} catch (error) {
			if (error instanceof PlanningCheckpointValidationError) {
				const lease = this.db
					.prepare("SELECT run_id, task_id, status FROM planning_leases WHERE lease_id = ?")
					.get<{ run_id: string; task_id: string; status: PlanningLeaseStatus }>(leaseId);
				if (lease) {
					try {
						this.recordLifecycleEvent(
							lease.run_id,
							"planning_checkpoint_rejected",
							{
								taskId: lease.task_id,
								leaseId,
								checkpointId: checkpointId.slice(0, 160),
								failureCode: error.code,
								diagnosticLayer: "store_validation",
								diagnosticReason: error.diagnostic.reason,
								fieldName: error.diagnostic.fieldName,
								scopeDecision: error.diagnostic.scopeDecision,
								...(error.diagnostic.evidenceRefs
									? { evidenceRefs: error.diagnostic.evidenceRefs.slice(0, 16) }
									: {}),
								...(error.diagnostic.artifactReferenceHashes
									? { artifactReferenceHashes: error.diagnostic.artifactReferenceHashes.slice(0, 16) }
									: {}),
							},
							now,
						);
					} catch {
						// Rejection diagnostics must not replace the validation error.
					}
				}
				throw error;
			}
			if (error instanceof PlanningPersistenceError) throw error;
			throw new PlanningPersistenceError("Planning checkpoint persistence failed", error);
		}
	}

	/** Durable local submission, distinct from settlement and from trusted goal verification. */
	recordResultSubmission(leaseId: string, result: PlanningTaskResult, now = Date.now()): void {
		try {
			this.db.transaction(() => {
				const lease = this.requireActiveLease(leaseId);
				if (result.leaseId !== leaseId)
					throw new PlanningResultValidationError("Submission belongs to another lease");
				for (const reference of result.evidenceRefs ?? []) {
					if (
						!this.db
							.prepare("SELECT evidence_id FROM planning_evidence WHERE run_id = ? AND evidence_id = ?")
							.get(lease.run_id, reference)
					) {
						throw new PlanningResultValidationError("Submission evidence reference is not in this run");
					}
				}
				this.publishDeliveryCard(lease, result.summary, result.evidenceRefs ?? [], "task delivery");
				this.insertEvent(
					lease.run_id,
					"task_result_submitted",
					{
						taskId: lease.task_id,
						leaseId,
						outcome: result.outcome,
						result,
					},
					now,
					`planning-submission:${leaseId}`,
				);
			});
		} catch (error) {
			if (error instanceof PlanningResultValidationError || error instanceof PlanningPersistenceError) throw error;
			throw new PlanningPersistenceError("Planning submission persistence failed", error);
		}
	}

	commitResult(input: CommitPlanningResultInput, now = Date.now()): PlanningSnapshot {
		try {
			return this.db.transaction(() => {
				const idempotencyKey = `planning-result:${input.leaseId}`;
				const duplicate = this.db
					.prepare("SELECT run_id FROM planning_events WHERE idempotency_key = ?")
					.get<{ run_id: string }>(idempotencyKey);
				if (duplicate) return this.snapshot(duplicate.run_id);
				const lease = this.requireActiveLease(input.leaseId);
				if (lease.plan_revision !== input.planRevision) {
					throw new PlanningResultValidationError(
						`Task result revision ${input.planRevision} does not match lease revision ${lease.plan_revision}`,
					);
				}
				const result: PlanningTaskResult = input.result ?? {
					schemaVersion: PLANNING_SCHEMA_VERSION,
					leaseId: input.leaseId,
					outcome: input.outcome ?? "failed",
					summary: input.summary ?? "Legacy planning result",
					suggestedTasks: [],
					flagCandidates: [],
					evidenceRefs: input.evidence.flatMap((item) => (item.evidenceId ? [item.evidenceId] : [])),
					facts: [],
					rejectedDirections: [],
					openQuestions: [],
					resolvedQuestionIds: [],
					artifacts: [],
				};
				const status: PlanningTaskStatus = result.outcome;
				for (const evidence of input.evidence) {
					this.insertEvidence(lease, evidence, stableEvidenceId(lease.lease_id, evidence), now, false);
				}
				const persistedEvidence = this.db
					.prepare("SELECT * FROM planning_evidence WHERE lease_id = ? ORDER BY created_at ASC")
					.all<EvidenceRow>(lease.lease_id)
					.map(evidenceFromRow);
				// Analysis tasks can use explicitly referenced sibling tool results.
				// Resolve through the same-run reader; unknown/cross-run refs still fail.
				const completionEvidence =
					input.preserveTaskProvenance && (status === "done" || status === "disproved")
						? [
								...persistedEvidence,
								...(result.evidenceRefs ?? []).map((id) => {
									const row = this.db
										.prepare("SELECT * FROM planning_evidence WHERE run_id = ? AND evidence_id = ?")
										.get<EvidenceRow>(lease.run_id, id);
									if (!row)
										throw new PlanningResultValidationError(
											"Task result evidence reference is not in this run",
										);
									return evidenceFromRow(row);
								}),
							]
						: persistedEvidence;
				if (
					(status === "done" || status === "disproved") &&
					!completionEvidence.some((item) => item.kind === "tool" && item.metadata.isError !== true)
				) {
					throw new PlanningResultValidationError(
						`Planning task ${lease.task_id} cannot be ${status} without successful tool evidence`,
					);
				}
				const taskRow = this.db
					.prepare("SELECT * FROM planning_tasks WHERE task_id = ?")
					.get<TaskRow>(lease.task_id);
				if (!taskRow) throw new Error(`Planning task not found: ${lease.task_id}`);
				const frameRecord = this.getExecutionFrame(lease.run_id);
				const frame = reduceExecutionFrame({
					frame: frameRecord.frame,
					task: taskFromRow(taskRow, []),
					result,
					evidence: input.preserveTaskProvenance
						? this.db
								.prepare("SELECT * FROM planning_evidence WHERE run_id = ? ORDER BY created_at ASC")
								.all<EvidenceRow>(lease.run_id)
								.map(evidenceFromRow)
						: persistedEvidence,
					allowedScope: lease.allowed_scope,
					artifactWorkspace: input.artifactWorkspace,
					sourceLeaseId: lease.lease_id,
					preserveTaskProvenance: input.preserveTaskProvenance,
				});
				const frameRevision = frameRecord.revision + 1;
				const frameUpdate = this.db
					.prepare(`
				UPDATE planning_execution_frames SET revision = ?, frame_json = ?, updated_at = ?
				WHERE run_id = ? AND revision = ?
			`)
					.run(frameRevision, JSON.stringify(frame), now, lease.run_id, frameRecord.revision);
				if (frameUpdate.changes !== 1) throw new Error(`Stale execution frame revision for ${lease.run_id}`);
				this.db
					.prepare("UPDATE planning_tasks SET status = ?, updated_at = ?, last_error = ? WHERE task_id = ?")
					.run(status, now, status === "blocked" || status === "failed" ? result.summary : null, lease.task_id);
				this.db
					.prepare(
						"UPDATE planning_leases SET status = 'committed', committed_at = ?, ended_at = ? WHERE lease_id = ?",
					)
					.run(now, now, lease.lease_id);
				this.refreshReadiness(lease.run_id, now);
				this.db.prepare("UPDATE planning_runs SET updated_at = ? WHERE run_id = ?").run(now, lease.run_id);
				this.insertEvent(
					lease.run_id,
					"task_committed",
					{
						taskId: lease.task_id,
						leaseId: lease.lease_id,
						outcome: result.outcome,
						resultSource: "executor_commit",
						summary: result.summary,
						frameRevision,
						framePatch: {
							facts: result.facts,
							rejectedDirections: result.rejectedDirections,
							openQuestions: result.openQuestions,
							resolvedQuestionIds: result.resolvedQuestionIds,
							artifacts: result.artifacts,
							suggestedNextSteps: result.suggestedTasks,
						},
					},
					now,
					idempotencyKey,
				);
				this.insertEvent(lease.run_id, "frame_updated", { taskId: lease.task_id, frameRevision }, now);
				return this.snapshot(lease.run_id);
			});
		} catch (error) {
			if (error instanceof PlanningResultValidationError || error instanceof PlanningPersistenceError) throw error;
			throw new PlanningPersistenceError("Planning task result persistence failed", error);
		}
	}

	sealActiveLease(input: SealPlanningAttemptInput, now = Date.now()): PlanningSnapshot {
		return this.db.transaction(() => {
			const lease = this.db.prepare("SELECT * FROM planning_leases WHERE lease_id = ?").get<LeaseRow>(input.leaseId);
			if (!lease) throw new Error(`Planning lease not found: ${input.leaseId}`);
			if (lease.status !== "active") return this.snapshot(lease.run_id);
			const checkpointRow = this.db
				.prepare(
					"SELECT * FROM planning_checkpoints WHERE lease_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
				)
				.get<CheckpointRow>(input.leaseId);
			const checkpoint = checkpointRow ? checkpointFromRow(checkpointRow) : undefined;
			const evidenceRows = this.db
				.prepare("SELECT * FROM planning_evidence WHERE lease_id = ? ORDER BY created_at ASC")
				.all<EvidenceRow>(input.leaseId)
				.map(evidenceFromRow);
			this.markLeaseEvidenceFailed(input.leaseId);
			const report: PlanningAttemptReport = {
				runId: lease.run_id,
				taskId: lease.task_id,
				leaseId: lease.lease_id,
				attempt: Number(lease.attempt_no ?? 1),
				objective: lease.objective,
				doneWhen: lease.done_when,
				source: "runtime_failure",
				stage: input.stage.slice(0, 160),
				code: input.code.slice(0, 160),
				message: boundedFailureMessage(input.message),
				...(input.progress?.summary ? { executorSummary: input.progress.summary.slice(0, 8_000) } : {}),
				evidenceRefs: evidenceRows.map((item) => item.evidenceId),
				...(checkpoint
					? {
							checkpointId: checkpoint.checkpointId,
							checkpoint,
							completedItems: checkpoint.completedItems,
							remainingItems: checkpoint.remainingItems,
							rejectedDirections: checkpoint.rejectedDirections,
							suggestedNextSteps: checkpoint.suggestedNextSteps,
						}
					: {
							completedItems: input.progress?.completedItems ?? [],
							remainingItems: input.progress?.remainingItems ?? [],
							rejectedDirections: input.progress?.rejectedDirections ?? [],
							suggestedNextSteps: input.progress?.suggestedNextSteps ?? [],
						}),
				createdAt: now,
			};
			this.db
				.prepare(
					"UPDATE planning_leases SET status = 'failed', ended_at = ?, failure_report_json = ? WHERE lease_id = ? AND status = 'active'",
				)
				.run(now, JSON.stringify(report), input.leaseId);
			this.db
				.prepare(
					"UPDATE planning_tasks SET status = 'failed', updated_at = ?, last_error = ? WHERE task_id = ? AND status IN ('leased', 'running')",
				)
				.run(now, boundedFailureMessage(`${input.code}: ${input.message}`), lease.task_id);
			this.refreshReadiness(lease.run_id, now);
			this.db.prepare("UPDATE planning_runs SET updated_at = ? WHERE run_id = ?").run(now, lease.run_id);
			this.insertEvent(
				lease.run_id,
				"attempt_sealed",
				{
					taskId: lease.task_id,
					leaseId: lease.lease_id,
					attemptNumber: Number(lease.attempt_no ?? 1),
					failureSource: input.source,
					failureStage: report.stage,
					failureCode: report.code,
					evidenceCount: report.evidenceRefs.length,
					...(report.checkpointId ? { checkpointId: report.checkpointId } : {}),
					resultSource: "runtime_failure",
				},
				now,
				`planning-attempt-sealed:${input.leaseId}`,
			);
			return this.snapshot(lease.run_id);
		});
	}

	setRunStatus(runId: string, status: PlanningRunStatus, reason?: string, now = Date.now()): PlanningRun {
		return this.db.transaction(() => {
			const current = this.requireRun(runId);
			const terminalStatuses = new Set<PlanningRunStatus>(["completed", "blocked", "failed", "cancelled"]);
			if (terminalStatuses.has(current.status) && current.status !== status) return current;
			this.db
				.prepare("UPDATE planning_runs SET status = ?, updated_at = ?, last_error = ? WHERE run_id = ?")
				.run(status, now, reason ?? null, runId);
			this.insertEvent(runId, `run_${status}`, { reason: reason ?? "" }, now);
			return this.requireRun(runId);
		});
	}

	recoverExpiredLeases(runId: string, now = Date.now()): number {
		const leases = this.db
			.prepare("SELECT * FROM planning_leases WHERE run_id = ? AND status = 'active' AND expires_at <= ?")
			.all<LeaseRow>(runId, now);
		for (const lease of leases) {
			this.db.prepare("UPDATE planning_leases SET status = 'expired' WHERE lease_id = ?").run(lease.lease_id);
			this.db
				.prepare(
					"UPDATE planning_tasks SET status = 'ready', updated_at = ? WHERE task_id = ? AND status IN ('leased', 'running')",
				)
				.run(now, lease.task_id);
			this.insertEvent(runId, "lease_expired", { taskId: lease.task_id, leaseId: lease.lease_id }, now);
		}
		return leases.length;
	}

	recoverActiveLease(runId: string, reason: string, now = Date.now()): boolean {
		return this.db.transaction(() => {
			const leases = this.db
				.prepare(
					"SELECT * FROM planning_leases WHERE run_id = ? AND status = 'active' ORDER BY issued_at DESC, lease_id ASC",
				)
				.all<LeaseRow>(runId);
			if (leases.length === 0) return false;
			for (const lease of leases) {
				this.db.prepare("UPDATE planning_leases SET status = 'expired' WHERE lease_id = ?").run(lease.lease_id);
				this.db
					.prepare(
						"UPDATE planning_tasks SET status = 'ready', updated_at = ?, last_error = ? WHERE task_id = ? AND status IN ('leased', 'running')",
					)
					.run(now, reason, lease.task_id);
				this.insertEvent(
					runId,
					"lease_recovered",
					{ taskId: lease.task_id, leaseId: lease.lease_id, reason },
					now,
					`planning-lease-recovery:${lease.lease_id}`,
				);
			}
			return true;
		});
	}

	cancelActiveLease(runId: string, reason: string, now = Date.now()): boolean {
		return this.db.transaction(() => {
			const leases = this.db
				.prepare(
					"SELECT * FROM planning_leases WHERE run_id = ? AND status = 'active' ORDER BY issued_at DESC, lease_id ASC",
				)
				.all<LeaseRow>(runId);
			if (leases.length === 0) return false;
			for (const lease of leases) {
				this.db.prepare("UPDATE planning_leases SET status = 'cancelled' WHERE lease_id = ?").run(lease.lease_id);
				this.db
					.prepare(
						"UPDATE planning_tasks SET status = 'ready', updated_at = ?, last_error = ? WHERE task_id = ? AND status IN ('leased', 'running')",
					)
					.run(now, reason, lease.task_id);
				this.insertEvent(
					runId,
					"lease_cancelled",
					{ taskId: lease.task_id, leaseId: lease.lease_id, reason },
					now,
					`planning-lease-cancel:${lease.lease_id}`,
				);
			}
			return true;
		});
	}

	close(): void {
		this.db.close();
	}

	private insertEvidence(
		lease: LeaseRow,
		item: PlanningEvidenceInput,
		evidenceId: string,
		now: number,
		attemptFailed: boolean,
	): boolean {
		return this.evidenceRepository.insert(
			{ runId: lease.run_id, taskId: lease.task_id, leaseId: lease.lease_id },
			item,
			evidenceId,
			now,
			attemptFailed,
		);
	}

	private markLeaseEvidenceFailed(leaseId: string): void {
		const rows = this.db
			.prepare("SELECT evidence_id, metadata_json FROM planning_evidence WHERE lease_id = ?")
			.all<{ evidence_id: string; metadata_json: string }>(leaseId);
		for (const row of rows) {
			this.db
				.prepare("UPDATE planning_evidence SET metadata_json = ? WHERE evidence_id = ?")
				.run(JSON.stringify({ ...parseRecord(row.metadata_json), attemptFailed: true }), row.evidence_id);
		}
	}

	private ensureExecutionFrame(runId: string, now: number): void {
		this.db
			.prepare(`
			INSERT OR IGNORE INTO planning_execution_frames (run_id, revision, frame_json, updated_at)
			VALUES (?, 0, ?, ?)
		`)
			.run(runId, JSON.stringify(emptyExecutionFrame()), now);
	}

	private requireRun(runId: string): PlanningRun {
		const row = this.db.prepare("SELECT * FROM planning_runs WHERE run_id = ?").get<RunRow>(runId);
		if (!row) throw new Error(`Planning run not found: ${runId}`);
		return runFromRow(row);
	}

	private requireActiveLease(leaseId: string): LeaseRow {
		const row = this.db
			.prepare("SELECT * FROM planning_leases WHERE lease_id = ? AND status = 'active'")
			.get<LeaseRow>(leaseId);
		if (!row) throw new Error(`Active planning lease not found: ${leaseId}`);
		return row;
	}

	private refreshReadiness(runId: string, now: number): void {
		for (;;) {
			const tasks = this.db
				.prepare("SELECT * FROM planning_tasks WHERE run_id = ? ORDER BY sequence_no ASC")
				.all<TaskRow>(runId);
			const statusByTaskId = new Map(tasks.map((task) => [task.task_id, task.status]));
			const dependencies = this.db
				.prepare(`
				SELECT dependency.task_id, dependency.depends_on_task_id
				FROM planning_dependencies dependency
				JOIN planning_tasks task ON task.task_id = dependency.task_id
				WHERE task.run_id = ?
				ORDER BY dependency.task_id ASC, dependency.depends_on_task_id ASC
			`)
				.all<{ task_id: string; depends_on_task_id: string }>(runId);
			const blockedBy = new Map<string, { taskId: string; status: PlanningTaskStatus }>();
			for (const dependency of dependencies) {
				const status = statusByTaskId.get(dependency.depends_on_task_id);
				if (!status || !IMPOSSIBLE_DEPENDENCY_STATUSES.has(status)) continue;
				const dependentStatus = statusByTaskId.get(dependency.task_id);
				if (dependentStatus === "proposed" && !blockedBy.has(dependency.task_id)) {
					blockedBy.set(dependency.task_id, { taskId: dependency.depends_on_task_id, status });
				}
			}
			if (blockedBy.size === 0) break;
			for (const [taskId, dependency] of blockedBy) {
				this.db
					.prepare(
						"UPDATE planning_tasks SET status = 'blocked', updated_at = ?, last_error = ? WHERE run_id = ? AND task_id = ? AND status = 'proposed'",
					)
					.run(now, `blocked by dependency: ${dependency.taskId} (${dependency.status})`, runId, taskId);
			}
		}
		this.db
			.prepare(`
			UPDATE planning_tasks AS task
			SET status = 'ready', updated_at = ?, last_error = NULL
			WHERE task.run_id = ? AND task.status = 'proposed'
			AND NOT EXISTS (
				SELECT 1 FROM planning_dependencies dependency
				JOIN planning_tasks required ON required.task_id = dependency.depends_on_task_id
				WHERE dependency.task_id = task.task_id AND required.status NOT IN ('done', 'disproved')
			)
		`)
			.run(now, runId);
		const graph = this.getHypothesisGraph(runId);
		if (graph) {
			const snapshot = this.snapshot(runId, true);
			for (const task of snapshot.tasks)
				if (task.status === "ready" && !hypothesisTaskRunnable(graph, snapshot, task.taskId))
					this.db
						.prepare("UPDATE planning_tasks SET status = 'proposed' WHERE task_id = ? AND status = 'ready'")
						.run(task.taskId);
		}
	}

	private insertEvent(
		runId: string,
		type: string,
		payload: Record<string, unknown>,
		now: number,
		idempotencyKey?: string,
	): void {
		this.db
			.prepare(`
			INSERT OR IGNORE INTO planning_events (event_id, run_id, type, payload_json, idempotency_key, created_at)
			VALUES (?, ?, ?, ?, ?, ?)
		`)
			.run(randomUUID(), runId, type, JSON.stringify(payload), idempotencyKey ?? null, now);
	}
}
