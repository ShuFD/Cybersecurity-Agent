import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createNodeSqliteFactory, type SqliteDatabase } from "@earendil-works/pi-session-backend-sqlite-node";
import type {
	ChallengeSnapshot,
	CompetitionEvent,
	CompetitionEventPayload,
	CompetitionPlan,
	CompetitionTaskStatus,
	SubmissionPolicy,
	TaskLease,
} from "./competition-protocol.ts";

export interface CompetitionTaskRecord {
	taskId: string;
	assignmentId: string;
	shortTask: string;
	challenge: ChallengeSnapshot;
	submission: SubmissionPolicy;
	policySnapshotId: string;
	status: CompetitionTaskStatus;
	priority: number;
	createdAt: number;
	updatedAt: number;
	actualAttempts: number;
	attemptBudget?: number;
	lastError?: string;
	solverId?: string;
	lease?: TaskLease;
	environmentLeaseId?: string;
	plan?: { planId: string; revision: number; rank: number };
}

export interface UpsertCompetitionTaskInput {
	taskId: string;
	shortTask: string;
	challenge: ChallengeSnapshot;
	submission: SubmissionPolicy;
	policySnapshotId: string;
	priority: number;
	status?: CompetitionTaskStatus;
}

export interface SetCompetitionPlanInput {
	orderedTaskIds: string[];
	rationale: string;
	generatedBy: string;
	expectedRevision?: number;
}

export interface TaskClaimResult {
	granted: boolean;
	reason: "claimed" | "already_claimed" | "not_queued" | "not_found";
	task?: CompetitionTaskRecord;
}

export interface EnvironmentLease {
	leaseId: string;
	exerciseId: string;
	taskId: string;
	ownerId: string;
	acquiredAt: number;
	heartbeatAt: number;
	expiresAt: number;
	status: "active" | "released" | "expired";
}

export interface EnvironmentLeaseResult {
	granted: boolean;
	reason: "acquired" | "already_held" | "capacity";
	lease?: EnvironmentLease;
}

export interface EnvironmentBuildLease {
	exerciseId: string;
	token: string;
	ownerId: string;
	state: "acquired" | "in_progress" | "ready" | "retry_wait";
	retryAt?: number;
	failureCount?: number;
	metadata?: Record<string, unknown>;
}

export interface StoredEvent {
	eventId: string;
	taskId: string;
	assignmentId: string;
	solverId: string;
	type: CompetitionEvent["type"];
	occurredAt: number;
	payload: CompetitionEventPayload;
	createdAt: number;
}

export interface SubmissionRecord {
	recordId: string;
	taskId: string;
	assignmentId: string;
	clientSubmissionId?: string;
	rawCandidateHash: string;
	normalizedCandidateHash: string;
	attemptNo: number;
	category:
		| "pending"
		| "accepted"
		| "incorrect"
		| "duplicate"
		| "format_mismatch"
		| "rate_limited"
		| "environment_error"
		| "platform_closed"
		| "blocked"
		| "request_error";
	httpStatus?: number;
	businessCode?: string;
	isCorrect?: boolean;
	requestPayload?: Record<string, unknown>;
	response?: Record<string, unknown>;
	evidenceRefs: string[];
	createdAt: number;
	updatedAt: number;
}

export interface BeginSubmissionInput {
	taskId: string;
	assignmentId: string;
	rawCandidateHash: string;
	normalizedCandidateHash: string;
	maxAttempts: number;
	evidenceRefs: string[];
	clientSubmissionId?: string;
	requestPayload: Record<string, unknown>;
	now?: number;
}

export type BeginSubmissionResult =
	| { kind: "started"; submission: SubmissionRecord }
	| { kind: "duplicate"; submission: SubmissionRecord }
	| { kind: "attempt_limit"; attempts: number }
	| { kind: "not_found" }
	| { kind: "terminal"; task: CompetitionTaskRecord };

export interface AttachmentCacheEntry {
	cacheKey: string;
	url: string;
	sha256: string;
	sizeBytes: number;
	path: string;
	createdAt: number;
	lastAccessedAt: number;
}

interface TaskRow {
	task_id: string;
	assignment_id: string;
	short_task: string;
	challenge_json: string;
	submission_json: string;
	policy_snapshot_id: string;
	status: CompetitionTaskStatus;
	priority: number;
	created_at: number;
	updated_at: number;
	actual_attempts: number;
	attempt_budget: number | null;
	last_error: string | null;
	solver_id: string | null;
	lease_id: string | null;
	lease_assigned_at: number | null;
	lease_heartbeat_at: number | null;
	lease_expires_at: number | null;
	environment_lease_id: string | null;
	plan_id: string | null;
	plan_revision: number | null;
	plan_rank: number | null;
}

interface EnvironmentRow {
	lease_id: string;
	exercise_id: string;
	task_id: string;
	owner_id: string;
	acquired_at: number;
	heartbeat_at: number;
	expires_at: number;
	status: "active" | "released" | "expired";
}

interface EventRow {
	event_id: string;
	task_id: string;
	assignment_id: string;
	solver_id: string;
	type: CompetitionEvent["type"];
	occurred_at: number;
	payload_json: string;
	created_at: number;
}

interface SubmissionRow {
	record_id: string;
	task_id: string;
	assignment_id: string;
	client_submission_id: string | null;
	raw_candidate_hash: string;
	normalized_candidate_hash: string;
	attempt_no: number;
	category: SubmissionRecord["category"];
	http_status: number | null;
	business_code: string | null;
	is_correct: number | null;
	request_payload_json: string | null;
	response_json: string | null;
	evidence_refs_json: string;
	created_at: number;
	updated_at: number;
}

interface CompetitionPlanRow {
	plan_id: string;
	revision: number;
	ordered_task_ids_json: string;
	rationale: string;
	generated_by: string;
	generated_at: number;
}

function jsonValue(value: unknown): string {
	const result = JSON.stringify(value);
	return result === undefined ? "null" : result;
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function parseRecord(value: string): Record<string, unknown> {
	const parsed = parseJson(value);
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: {};
}

function parseArray(value: string): string[] {
	const parsed = parseJson(value);
	return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

function rowTask(row: TaskRow): CompetitionTaskRecord {
	const task: CompetitionTaskRecord = {
		taskId: row.task_id,
		assignmentId: row.assignment_id,
		shortTask: row.short_task,
		challenge: parseRecord(row.challenge_json) as unknown as ChallengeSnapshot,
		submission: parseRecord(row.submission_json) as unknown as SubmissionPolicy,
		policySnapshotId: row.policy_snapshot_id,
		status: row.status,
		priority: row.priority,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		actualAttempts: row.actual_attempts,
		...(row.attempt_budget === null ? {} : { attemptBudget: row.attempt_budget }),
		...(row.last_error ? { lastError: row.last_error } : {}),
		...(row.solver_id ? { solverId: row.solver_id } : {}),
		...(row.environment_lease_id ? { environmentLeaseId: row.environment_lease_id } : {}),
	};
	if (
		row.lease_id &&
		row.lease_assigned_at !== null &&
		row.lease_heartbeat_at !== null &&
		row.lease_expires_at !== null &&
		row.solver_id
	) {
		task.lease = {
			leaseId: row.lease_id,
			ownerId: row.solver_id,
			assignedAt: row.lease_assigned_at,
			heartbeatAt: row.lease_heartbeat_at,
			expiresAt: row.lease_expires_at,
		};
	}
	if (row.plan_id && row.plan_revision !== null && row.plan_rank !== null) {
		task.plan = {
			planId: row.plan_id,
			revision: row.plan_revision,
			rank: row.plan_rank,
		};
	}
	return task;
}

function rowEvent(row: EventRow): StoredEvent {
	return {
		eventId: row.event_id,
		taskId: row.task_id,
		assignmentId: row.assignment_id,
		solverId: row.solver_id,
		type: row.type,
		occurredAt: row.occurred_at,
		payload: parseJson(row.payload_json) as CompetitionEventPayload,
		createdAt: row.created_at,
	};
}

function rowSubmission(row: SubmissionRow): SubmissionRecord {
	const requestPayload = row.request_payload_json ? parseJson(row.request_payload_json) : undefined;
	const response = row.response_json ? parseJson(row.response_json) : undefined;
	return {
		recordId: row.record_id,
		taskId: row.task_id,
		assignmentId: row.assignment_id,
		...(row.client_submission_id ? { clientSubmissionId: row.client_submission_id } : {}),
		rawCandidateHash: row.raw_candidate_hash,
		normalizedCandidateHash: row.normalized_candidate_hash,
		attemptNo: row.attempt_no,
		category: row.category,
		...(row.http_status === null ? {} : { httpStatus: row.http_status }),
		...(row.business_code ? { businessCode: row.business_code } : {}),
		...(row.is_correct === null ? {} : { isCorrect: row.is_correct === 1 }),
		...(typeof requestPayload === "object" && requestPayload !== null && !Array.isArray(requestPayload)
			? { requestPayload: requestPayload as Record<string, unknown> }
			: {}),
		...(typeof response === "object" && response !== null && !Array.isArray(response)
			? { response: response as Record<string, unknown> }
			: {}),
		evidenceRefs: parseArray(row.evidence_refs_json),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class CompetitionStore {
	readonly path: string;
	private readonly db: SqliteDatabase;

	private constructor(db: SqliteDatabase, path: string) {
		this.db = db;
		this.path = path;
	}

	static async open(path: string): Promise<CompetitionStore> {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		const db = await createNodeSqliteFactory().open(path);
		db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
		db.exec(`
			CREATE TABLE IF NOT EXISTS competition_policy_snapshots (
				policy_snapshot_id TEXT PRIMARY KEY,
				payload_json TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS competition_tasks (
				task_id TEXT PRIMARY KEY,
				assignment_id TEXT NOT NULL,
				short_task TEXT NOT NULL,
				challenge_json TEXT NOT NULL,
				submission_json TEXT NOT NULL,
				policy_snapshot_id TEXT NOT NULL,
				status TEXT NOT NULL,
				priority REAL NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				actual_attempts INTEGER NOT NULL DEFAULT 0,
				attempt_budget INTEGER,
				last_error TEXT,
				solver_id TEXT,
				lease_id TEXT,
				lease_assigned_at INTEGER,
				lease_heartbeat_at INTEGER,
				lease_expires_at INTEGER,
				environment_lease_id TEXT,
				plan_id TEXT,
				plan_revision INTEGER,
				plan_rank INTEGER
			);
			CREATE TABLE IF NOT EXISTS competition_plan_state (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				plan_id TEXT NOT NULL,
				revision INTEGER NOT NULL,
				ordered_task_ids_json TEXT NOT NULL,
				rationale TEXT NOT NULL,
				generated_by TEXT NOT NULL,
				generated_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS competition_task_events (
				event_id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL,
				assignment_id TEXT NOT NULL,
				solver_id TEXT NOT NULL,
				type TEXT NOT NULL,
				occurred_at INTEGER NOT NULL,
				payload_json TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS competition_task_events_task_idx ON competition_task_events(task_id, created_at);
			CREATE TABLE IF NOT EXISTS competition_environment_leases (
				lease_id TEXT PRIMARY KEY,
				exercise_id TEXT NOT NULL,
				task_id TEXT NOT NULL,
				owner_id TEXT NOT NULL,
				acquired_at INTEGER NOT NULL,
				heartbeat_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL,
				status TEXT NOT NULL
			);
			CREATE UNIQUE INDEX IF NOT EXISTS competition_environment_active_exercise_idx
				ON competition_environment_leases(exercise_id) WHERE status = 'active';
			CREATE INDEX IF NOT EXISTS competition_environment_active_idx ON competition_environment_leases(status, expires_at);
			CREATE TABLE IF NOT EXISTS competition_environment_builds (
				exercise_id TEXT PRIMARY KEY,
				state TEXT NOT NULL,
				owner_id TEXT,
				token TEXT,
				retry_at INTEGER,
				failure_count INTEGER NOT NULL DEFAULT 0,
				metadata_json TEXT,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS competition_submissions (
				record_id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL,
				assignment_id TEXT NOT NULL,
				client_submission_id TEXT,
				raw_candidate_hash TEXT NOT NULL,
				normalized_candidate_hash TEXT NOT NULL,
				attempt_no INTEGER NOT NULL,
				category TEXT NOT NULL,
				http_status INTEGER,
				business_code TEXT,
				is_correct INTEGER,
				request_payload_json TEXT,
				response_json TEXT,
				evidence_refs_json TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE UNIQUE INDEX IF NOT EXISTS competition_submission_task_candidate_idx
				ON competition_submissions(task_id, normalized_candidate_hash);
			CREATE INDEX IF NOT EXISTS competition_submissions_task_idx ON competition_submissions(task_id, attempt_no);
			CREATE TABLE IF NOT EXISTS competition_audit_verdicts (
				task_id TEXT PRIMARY KEY,
				verdict TEXT NOT NULL,
				reason TEXT NOT NULL,
				paused INTEGER NOT NULL,
				confidence REAL NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS competition_artifact_cache (
				cache_key TEXT PRIMARY KEY,
				url TEXT NOT NULL,
				sha256 TEXT NOT NULL,
				size_bytes INTEGER NOT NULL,
				path TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				last_accessed_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS competition_artifact_leases (
				cache_key TEXT PRIMARY KEY,
				owner_id TEXT NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS competition_host_rate_limits (
				host TEXT PRIMARY KEY,
				next_allowed_at INTEGER NOT NULL
			);
		`);
		try {
			db.exec("ALTER TABLE competition_environment_builds ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;");
		} catch {
			// Existing databases already have the failure counter.
		}
		try {
			db.exec("ALTER TABLE competition_tasks ADD COLUMN priority REAL NOT NULL DEFAULT 0;");
		} catch {
			// Existing databases already have the priority column.
		}
		for (const column of ["plan_id TEXT", "plan_revision INTEGER", "plan_rank INTEGER"]) {
			try {
				db.exec(`ALTER TABLE competition_tasks ADD COLUMN ${column};`);
			} catch {
				// Existing databases already have the plan columns.
			}
		}
		try {
			db.exec("ALTER TABLE competition_tasks ADD COLUMN attempt_budget INTEGER;");
		} catch {
			// Existing databases already have the attempt budget column.
		}
		db.exec(
			"CREATE INDEX IF NOT EXISTS competition_tasks_queue_idx ON competition_tasks(status, plan_rank ASC, priority DESC, created_at ASC);",
		);
		return new CompetitionStore(db, path);
	}

	putPolicySnapshot(policySnapshotId: string, value: Record<string, unknown>, now = Date.now()): void {
		this.db
			.prepare(
				"INSERT OR IGNORE INTO competition_policy_snapshots (policy_snapshot_id, payload_json, created_at) VALUES (?, ?, ?)",
			)
			.run(policySnapshotId, jsonValue(value), now);
	}

	getPolicySnapshot(policySnapshotId: string): Record<string, unknown> | undefined {
		const row = this.db
			.prepare("SELECT payload_json FROM competition_policy_snapshots WHERE policy_snapshot_id = ?")
			.get<{ payload_json: string }>(policySnapshotId);
		return row ? parseRecord(row.payload_json) : undefined;
	}

	upsertTask(input: UpsertCompetitionTaskInput, now = Date.now()): CompetitionTaskRecord {
		const existing = this.getTask(input.taskId);
		const assignmentId = existing?.assignmentId ?? randomUUID();
		const status = existing?.status === "solved" ? "solved" : (existing?.status ?? input.status ?? "queued");
		this.db
			.prepare(`
				INSERT INTO competition_tasks (
					task_id, assignment_id, short_task, challenge_json, submission_json, policy_snapshot_id, status,
					priority, created_at, updated_at, actual_attempts, attempt_budget
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(task_id) DO UPDATE SET
					short_task = excluded.short_task,
					challenge_json = excluded.challenge_json,
					submission_json = excluded.submission_json,
					policy_snapshot_id = excluded.policy_snapshot_id,
					status = CASE WHEN competition_tasks.status IN ('assigned', 'preparing', 'running', 'verifying') THEN competition_tasks.status ELSE excluded.status END,
					priority = CASE WHEN competition_tasks.status IN ('assigned', 'preparing', 'running', 'verifying') THEN competition_tasks.priority ELSE excluded.priority END,
					updated_at = excluded.updated_at
			`)
			.run(
				input.taskId,
				assignmentId,
				input.shortTask,
				jsonValue(input.challenge),
				jsonValue(input.submission),
				input.policySnapshotId,
				status,
				input.priority,
				existing?.createdAt ?? now,
				now,
				existing?.actualAttempts ?? 0,
				existing?.attemptBudget ?? null,
			);
		return this.getTask(input.taskId) as CompetitionTaskRecord;
	}

	setAttemptBudget(taskId: string, budget: number): CompetitionTaskRecord {
		if (!Number.isSafeInteger(budget) || budget < 1) throw new Error("Attempt budget must be a positive integer");
		const task = this.getTask(taskId);
		if (!task) throw new Error(`Competition task not found: ${taskId}`);
		if (budget > task.submission.maxAttempts)
			throw new Error(`Attempt budget for ${taskId} exceeds platform maximum ${task.submission.maxAttempts}`);
		if (!(task.status === "queued" || task.status === "environment_blocked") || task.solverId || task.lease) {
			throw new Error(`Attempt budget for ${taskId} can only be changed before dispatch`);
		}
		this.db
			.prepare("UPDATE competition_tasks SET attempt_budget = ?, updated_at = ? WHERE task_id = ?")
			.run(budget, Date.now(), taskId);
		return this.getTask(taskId) as CompetitionTaskRecord;
	}

	setAttemptBudgets(budgets: Array<{ taskId: string; budget: number }>): CompetitionTaskRecord[] {
		return this.db.transaction(() => budgets.map((item) => this.setAttemptBudget(item.taskId, item.budget)));
	}

	getTask(taskId: string): CompetitionTaskRecord | undefined {
		const row = this.db.prepare("SELECT * FROM competition_tasks WHERE task_id = ?").get<TaskRow>(taskId);
		return row ? rowTask(row) : undefined;
	}

	listTasks(options: { unassignedOnly?: boolean } = {}): CompetitionTaskRecord[] {
		const rows = options.unassignedOnly
			? this.db
					.prepare(
						"SELECT * FROM competition_tasks WHERE status IN ('queued', 'environment_blocked') AND solver_id IS NULL ORDER BY CASE WHEN plan_rank IS NULL THEN 1 ELSE 0 END, plan_rank ASC, priority DESC, created_at ASC, task_id ASC",
					)
					.all<TaskRow>()
			: this.db
					.prepare(
						"SELECT * FROM competition_tasks ORDER BY CASE WHEN status IN ('queued', 'environment_blocked') THEN 0 ELSE 1 END, CASE WHEN plan_rank IS NULL THEN 1 ELSE 0 END, plan_rank ASC, priority DESC, updated_at DESC, task_id ASC",
					)
					.all<TaskRow>();
		return rows.map(rowTask);
	}

	getPlan(): CompetitionPlan | undefined {
		const row = this.db.prepare("SELECT * FROM competition_plan_state WHERE singleton = 1").get<CompetitionPlanRow>();
		if (!row) return undefined;
		return {
			planId: row.plan_id,
			revision: row.revision,
			orderedTaskIds: parseArray(row.ordered_task_ids_json),
			rationale: row.rationale,
			generatedBy: row.generated_by,
			generatedAt: row.generated_at,
		};
	}

	setPlan(input: SetCompetitionPlanInput, now = Date.now()): CompetitionPlan {
		return this.db.transaction(() => {
			const current = this.getPlan();
			if (input.expectedRevision !== undefined && input.expectedRevision !== (current?.revision ?? 0))
				throw new Error(
					`Competition plan revision conflict: expected ${input.expectedRevision}, current ${current?.revision ?? 0}`,
				);
			const plan: CompetitionPlan = {
				planId: randomUUID(),
				revision: (current?.revision ?? 0) + 1,
				orderedTaskIds: [...input.orderedTaskIds],
				rationale: input.rationale,
				generatedBy: input.generatedBy,
				generatedAt: now,
			};
			this.db
				.prepare(
					"INSERT INTO competition_plan_state (singleton, plan_id, revision, ordered_task_ids_json, rationale, generated_by, generated_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET plan_id = excluded.plan_id, revision = excluded.revision, ordered_task_ids_json = excluded.ordered_task_ids_json, rationale = excluded.rationale, generated_by = excluded.generated_by, generated_at = excluded.generated_at, updated_at = excluded.updated_at",
				)
				.run(
					plan.planId,
					plan.revision,
					jsonValue(plan.orderedTaskIds),
					plan.rationale,
					plan.generatedBy,
					plan.generatedAt,
					now,
				);
			this.db
				.prepare(
					"UPDATE competition_tasks SET plan_id = NULL, plan_revision = NULL, plan_rank = NULL, updated_at = ?",
				)
				.run(now);
			const update = this.db.prepare(
				"UPDATE competition_tasks SET plan_id = ?, plan_revision = ?, plan_rank = ?, updated_at = ? WHERE task_id = ?",
			);
			for (const [rank, taskId] of plan.orderedTaskIds.entries())
				update.run(plan.planId, plan.revision, rank, now, taskId);
			return plan;
		});
	}

	clearPlan(now = Date.now()): void {
		this.db.transaction(() => {
			this.db.prepare("DELETE FROM competition_plan_state WHERE singleton = 1").run();
			this.db
				.prepare(
					"UPDATE competition_tasks SET plan_id = NULL, plan_revision = NULL, plan_rank = NULL, updated_at = ?",
				)
				.run(now);
		});
	}

	setTaskStatus(
		taskId: string,
		status: CompetitionTaskStatus,
		message?: string,
		now = Date.now(),
	): CompetitionTaskRecord | undefined {
		this.db
			.prepare(
				"UPDATE competition_tasks SET status = CASE WHEN status = 'solved' AND ? <> 'solved' THEN status ELSE ? END, last_error = CASE WHEN status = 'solved' AND ? <> 'solved' THEN last_error ELSE ? END, updated_at = ? WHERE task_id = ?",
			)
			.run(status, status, status, message ?? null, now, taskId);
		return this.getTask(taskId);
	}

	stopTask(
		taskId: string,
		message = "Stopped by operator",
		clearEnvironmentLease = false,
		now = Date.now(),
	): CompetitionTaskRecord | undefined {
		this.db
			.prepare(
				"UPDATE competition_tasks SET status = CASE WHEN status IN ('solved', 'platform_closed') THEN status ELSE 'stopped' END, last_error = CASE WHEN status IN ('solved', 'platform_closed') THEN last_error ELSE ? END, solver_id = CASE WHEN status IN ('solved', 'platform_closed') THEN solver_id ELSE NULL END, lease_id = CASE WHEN status IN ('solved', 'platform_closed') THEN lease_id ELSE NULL END, lease_assigned_at = CASE WHEN status IN ('solved', 'platform_closed') THEN lease_assigned_at ELSE NULL END, lease_heartbeat_at = CASE WHEN status IN ('solved', 'platform_closed') THEN lease_heartbeat_at ELSE NULL END, lease_expires_at = CASE WHEN status IN ('solved', 'platform_closed') THEN lease_expires_at ELSE NULL END, environment_lease_id = CASE WHEN status IN ('solved', 'platform_closed') OR ? = 0 THEN environment_lease_id ELSE NULL END, updated_at = ? WHERE task_id = ?",
			)
			.run(message, clearEnvironmentLease ? 1 : 0, now, taskId);
		return this.getTask(taskId);
	}

	requeueTask(taskId: string, now = Date.now()): CompetitionTaskRecord | undefined {
		return this.db.transaction(() => {
			const current = this.getTask(taskId);
			if (!current) return undefined;
			if (current.status === "solved") throw new Error(`Competition task is already solved: ${taskId}`);
			if (current.status === "platform_closed")
				throw new Error(`Competition task is platform-closed and cannot be requeued: ${taskId}`);
			const activeStatuses: CompetitionTaskStatus[] = ["assigned", "preparing", "running", "verifying"];
			if (activeStatuses.includes(current.status) && current.lease && current.lease.expiresAt > now)
				throw new Error(`Competition task has an active solver lease: ${taskId}`);
			this.db
				.prepare(
					"UPDATE competition_tasks SET status = 'queued', last_error = NULL, solver_id = NULL, lease_id = NULL, lease_assigned_at = NULL, lease_heartbeat_at = NULL, lease_expires_at = NULL, environment_lease_id = NULL, updated_at = ? WHERE task_id = ?",
				)
				.run(now, taskId);
			return this.getTask(taskId);
		});
	}

	updateTaskChallenge(
		taskId: string,
		challenge: ChallengeSnapshot,
		now = Date.now(),
	): CompetitionTaskRecord | undefined {
		this.db
			.prepare("UPDATE competition_tasks SET challenge_json = ?, updated_at = ? WHERE task_id = ?")
			.run(jsonValue(challenge), now, taskId);
		return this.getTask(taskId);
	}

	claimTask(taskId: string, solverId: string, leaseTtlMs: number, now = Date.now()): TaskClaimResult {
		return this.db.transaction(() => {
			this.db
				.prepare(
					"UPDATE competition_environment_leases SET status = 'expired', expires_at = ? WHERE status = 'active' AND task_id IN (SELECT task_id FROM competition_tasks WHERE status IN ('assigned', 'preparing', 'running', 'verifying') AND lease_expires_at <= ?)",
				)
				.run(now, now);
			this.db
				.prepare(
					"UPDATE competition_tasks SET environment_lease_id = NULL, updated_at = ? WHERE environment_lease_id IN (SELECT lease_id FROM competition_environment_leases WHERE status = 'expired' AND expires_at <= ?)",
				)
				.run(now, now);
			this.db
				.prepare(
					"UPDATE competition_tasks SET status = 'queued', solver_id = NULL, lease_id = NULL, lease_assigned_at = NULL, lease_heartbeat_at = NULL, lease_expires_at = NULL, updated_at = ? WHERE status IN ('assigned', 'preparing', 'running', 'verifying') AND lease_expires_at <= ?",
				)
				.run(now, now);
			const current = this.getTask(taskId);
			if (!current) return { granted: false, reason: "not_found" };
			if (current.lease && current.lease.expiresAt > now) {
				return current.solverId === solverId
					? { granted: true, reason: "already_claimed", task: current }
					: { granted: false, reason: "already_claimed", task: current };
			}
			if (!["queued", "environment_blocked"].includes(current.status))
				return { granted: false, reason: "not_queued", task: current };
			const assignmentId = randomUUID();
			const leaseId = randomUUID();
			this.db
				.prepare(
					"UPDATE competition_tasks SET assignment_id = ?, status = 'assigned', solver_id = ?, lease_id = ?, lease_assigned_at = ?, lease_heartbeat_at = ?, lease_expires_at = ?, updated_at = ? WHERE task_id = ?",
				)
				.run(assignmentId, solverId, leaseId, now, now, now + Math.max(1, Math.trunc(leaseTtlMs)), now, taskId);
			return { granted: true, reason: "claimed", task: this.getTask(taskId) };
		});
	}

	heartbeatTask(taskId: string, leaseId: string, solverId: string, leaseTtlMs: number, now = Date.now()): boolean {
		const result = this.db
			.prepare(
				"UPDATE competition_tasks SET lease_heartbeat_at = ?, lease_expires_at = ?, updated_at = ? WHERE task_id = ? AND lease_id = ? AND solver_id = ? AND status IN ('assigned', 'preparing', 'running', 'verifying') AND lease_expires_at > ?",
			)
			.run(now, now + Math.max(1, Math.trunc(leaseTtlMs)), now, taskId, leaseId, solverId, now);
		return result.changes === 1;
	}

	releaseTask(taskId: string, solverId: string, status: CompetitionTaskStatus = "queued", now = Date.now()): boolean {
		const result = this.db
			.prepare(
				"UPDATE competition_tasks SET status = ?, solver_id = NULL, lease_id = NULL, lease_assigned_at = NULL, lease_heartbeat_at = NULL, lease_expires_at = NULL, updated_at = ? WHERE task_id = ? AND solver_id = ? AND status <> 'solved'",
			)
			.run(status, now, taskId, solverId);
		return result.changes === 1;
	}

	claimEnvironmentLease(
		exerciseId: string | number,
		taskId: string,
		ownerId: string,
		maxSlots: number,
		ttlMs: number,
		now = Date.now(),
	): EnvironmentLeaseResult {
		const exercise = String(exerciseId);
		return this.db.transaction(() => {
			this.db
				.prepare(
					"UPDATE competition_environment_leases SET status = 'expired' WHERE status = 'active' AND expires_at <= ?",
				)
				.run(now);
			this.db
				.prepare(
					"UPDATE competition_tasks SET environment_lease_id = NULL, updated_at = ? WHERE environment_lease_id IN (SELECT lease_id FROM competition_environment_leases WHERE status = 'expired' AND expires_at <= ?)",
				)
				.run(now, now);
			const existing = this.db
				.prepare("SELECT * FROM competition_environment_leases WHERE exercise_id = ? AND status = 'active'")
				.get<EnvironmentRow>(exercise);
			if (existing) {
				if (existing.task_id === taskId && existing.owner_id !== ownerId) {
					this.db
						.prepare(
							"UPDATE competition_environment_leases SET owner_id = ?, heartbeat_at = ?, expires_at = ? WHERE lease_id = ? AND status = 'active'",
						)
						.run(ownerId, now, now + Math.max(1, Math.trunc(ttlMs)), existing.lease_id);
					const adopted = this.db
						.prepare("SELECT * FROM competition_environment_leases WHERE lease_id = ?")
						.get<EnvironmentRow>(existing.lease_id);
					return adopted
						? { granted: true, reason: "already_held", lease: rowEnvironment(adopted) }
						: { granted: false, reason: "capacity" };
				}
				return {
					granted: existing.owner_id === ownerId,
					reason: existing.owner_id === ownerId ? "already_held" : "capacity",
					lease: existing.owner_id === ownerId ? rowEnvironment(existing) : undefined,
				};
			}
			const count = this.db
				.prepare("SELECT COUNT(*) AS count FROM competition_environment_leases WHERE status = 'active'")
				.get<{ count: number }>();
			if ((count?.count ?? 0) >= Math.max(1, Math.trunc(maxSlots))) return { granted: false, reason: "capacity" };
			const lease: EnvironmentLease = {
				leaseId: randomUUID(),
				exerciseId: exercise,
				taskId,
				ownerId,
				acquiredAt: now,
				heartbeatAt: now,
				expiresAt: now + Math.max(1, Math.trunc(ttlMs)),
				status: "active",
			};
			this.db
				.prepare(
					"INSERT INTO competition_environment_leases (lease_id, exercise_id, task_id, owner_id, acquired_at, heartbeat_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')",
				)
				.run(
					lease.leaseId,
					lease.exerciseId,
					lease.taskId,
					lease.ownerId,
					lease.acquiredAt,
					lease.heartbeatAt,
					lease.expiresAt,
				);
			this.db
				.prepare("UPDATE competition_tasks SET environment_lease_id = ?, updated_at = ? WHERE task_id = ?")
				.run(lease.leaseId, now, taskId);
			return { granted: true, reason: "acquired", lease };
		});
	}

	heartbeatEnvironmentLease(leaseId: string, ownerId: string, ttlMs: number, now = Date.now()): boolean {
		const result = this.db
			.prepare(
				"UPDATE competition_environment_leases SET heartbeat_at = ?, expires_at = ? WHERE lease_id = ? AND owner_id = ? AND status = 'active' AND expires_at > ?",
			)
			.run(now, now + Math.max(1, Math.trunc(ttlMs)), leaseId, ownerId, now);
		return result.changes === 1;
	}

	releaseEnvironmentLease(
		leaseId: string,
		ownerId?: string,
		status: "released" | "expired" = "released",
		now = Date.now(),
	): boolean {
		const result = this.db
			.prepare(
				`UPDATE competition_environment_leases SET status = ?, expires_at = ? WHERE lease_id = ? AND status = 'active'${ownerId ? " AND owner_id = ?" : ""}`,
			)
			.run(status, now, leaseId, ...(ownerId ? [ownerId] : []));
		if (result.changes === 1)
			this.db
				.prepare(
					"UPDATE competition_tasks SET environment_lease_id = NULL, updated_at = ? WHERE environment_lease_id = ?",
				)
				.run(now, leaseId);
		return result.changes === 1;
	}

	getEnvironmentLease(leaseId: string): EnvironmentLease | undefined {
		const row = this.db
			.prepare("SELECT * FROM competition_environment_leases WHERE lease_id = ?")
			.get<EnvironmentRow>(leaseId);
		return row ? rowEnvironment(row) : undefined;
	}

	activeEnvironmentCount(now = Date.now()): number {
		this.db
			.prepare(
				"UPDATE competition_environment_leases SET status = 'expired' WHERE status = 'active' AND expires_at <= ?",
			)
			.run(now);
		this.db
			.prepare(
				"UPDATE competition_tasks SET environment_lease_id = NULL, updated_at = ? WHERE environment_lease_id IN (SELECT lease_id FROM competition_environment_leases WHERE status = 'expired' AND expires_at <= ?)",
			)
			.run(now, now);
		return (
			this.db
				.prepare("SELECT COUNT(*) AS count FROM competition_environment_leases WHERE status = 'active'")
				.get<{ count: number }>()?.count ?? 0
		);
	}

	beginEnvironmentBuild(
		exerciseId: string | number,
		ownerId: string,
		_retryAfterMs = 0,
		now = Date.now(),
	): EnvironmentBuildLease {
		const exercise = String(exerciseId);
		return this.db.transaction(() => {
			const current = this.db.prepare("SELECT * FROM competition_environment_builds WHERE exercise_id = ?").get<{
				state: string;
				owner_id: string | null;
				token: string | null;
				retry_at: number | null;
				failure_count: number;
				metadata_json: string | null;
			}>(exercise);
			if (current?.state === "ready")
				return {
					exerciseId: exercise,
					token: current.token ?? "",
					ownerId,
					state: "ready",
					failureCount: current.failure_count,
					metadata: current.metadata_json ? parseRecord(current.metadata_json) : {},
				};
			if (current?.state === "building")
				return {
					exerciseId: exercise,
					token: current.token ?? "",
					ownerId: current.owner_id ?? ownerId,
					state: "in_progress",
					failureCount: current.failure_count,
				};
			if (current?.retry_at !== null && current?.retry_at !== undefined && current.retry_at > now)
				return {
					exerciseId: exercise,
					token: current.token ?? "",
					ownerId,
					state: "retry_wait",
					retryAt: current.retry_at,
					failureCount: current.failure_count,
				};
			const token = randomUUID();
			this.db
				.prepare(
					"INSERT INTO competition_environment_builds (exercise_id, state, owner_id, token, retry_at, failure_count, metadata_json, updated_at) VALUES (?, 'building', ?, ?, NULL, 0, NULL, ?) ON CONFLICT(exercise_id) DO UPDATE SET state = 'building', owner_id = excluded.owner_id, token = excluded.token, retry_at = NULL, metadata_json = NULL, updated_at = excluded.updated_at",
				)
				.run(exercise, ownerId, token, now);
			return { exerciseId: exercise, token, ownerId, state: "acquired" };
		});
	}

	completeEnvironmentBuild(
		exerciseId: string | number,
		token: string,
		metadata: Record<string, unknown> = {},
		now = Date.now(),
	): boolean {
		const result = this.db
			.prepare(
				"UPDATE competition_environment_builds SET state = 'ready', metadata_json = ?, retry_at = NULL, failure_count = 0, updated_at = ? WHERE exercise_id = ? AND token = ?",
			)
			.run(jsonValue(metadata), now, String(exerciseId), token);
		return result.changes === 1;
	}

	failEnvironmentBuild(
		exerciseId: string | number,
		token: string,
		retryAt: number,
		metadata: Record<string, unknown> = {},
		now = Date.now(),
	): boolean {
		const result = this.db
			.prepare(
				"UPDATE competition_environment_builds SET state = 'failed', metadata_json = ?, retry_at = ?, failure_count = failure_count + 1, updated_at = ? WHERE exercise_id = ? AND token = ?",
			)
			.run(jsonValue(metadata), retryAt, now, String(exerciseId), token);
		return result.changes === 1;
	}

	appendEvent(event: CompetitionEvent): { inserted: boolean; event: StoredEvent } {
		const createdAt = Date.now();
		const result = this.db
			.prepare(
				"INSERT OR IGNORE INTO competition_task_events (event_id, task_id, assignment_id, solver_id, type, occurred_at, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				event.eventId,
				event.taskId,
				event.assignmentId,
				event.solverId,
				event.type,
				event.occurredAt,
				jsonValue(event.payload),
				createdAt,
			);
		const row = this.db
			.prepare("SELECT * FROM competition_task_events WHERE event_id = ?")
			.get<EventRow>(event.eventId);
		if (!row) throw new Error("Event was not persisted");
		return { inserted: result.changes === 1, event: rowEvent(row) };
	}

	listEvents(taskId?: string, limit = 500): StoredEvent[] {
		const bounded = Math.max(1, Math.min(2_000, Math.trunc(limit)));
		const rows = taskId
			? this.db
					.prepare("SELECT * FROM competition_task_events WHERE task_id = ? ORDER BY created_at ASC LIMIT ?")
					.all<EventRow>(taskId, bounded)
			: this.db
					.prepare("SELECT * FROM competition_task_events ORDER BY created_at DESC LIMIT ?")
					.all<EventRow>(bounded)
					.reverse();
		return rows.map(rowEvent);
	}

	evidence(taskId: string): StoredEvent[] {
		return this.listEvents(taskId).filter((event) => event.type === "evidence");
	}

	beginSubmission(input: BeginSubmissionInput): BeginSubmissionResult {
		const now = input.now ?? Date.now();
		return this.db.transaction(() => {
			const task = this.getTask(input.taskId);
			if (!task) return { kind: "not_found" };
			if (task.status === "solved" || task.status === "platform_closed" || task.status === "stopped")
				return { kind: "terminal", task };
			const duplicate = this.db
				.prepare("SELECT * FROM competition_submissions WHERE task_id = ? AND normalized_candidate_hash = ?")
				.get<SubmissionRow>(input.taskId, input.normalizedCandidateHash);
			if (duplicate) return { kind: "duplicate", submission: rowSubmission(duplicate) };
			const count =
				this.db
					.prepare(
						"SELECT COALESCE(MAX(attempt_no), 0) AS attempt_no FROM competition_submissions WHERE task_id = ? AND attempt_no > 0",
					)
					.get<{ attempt_no: number }>(input.taskId)?.attempt_no ?? 0;
			if (count >= Math.max(1, Math.trunc(input.maxAttempts))) return { kind: "attempt_limit", attempts: count };
			const submission: SubmissionRecord = {
				recordId: randomUUID(),
				taskId: input.taskId,
				assignmentId: input.assignmentId,
				...(input.clientSubmissionId ? { clientSubmissionId: input.clientSubmissionId } : {}),
				rawCandidateHash: input.rawCandidateHash,
				normalizedCandidateHash: input.normalizedCandidateHash,
				attemptNo: count + 1,
				category: "pending",
				requestPayload: input.requestPayload,
				evidenceRefs: [...input.evidenceRefs],
				createdAt: now,
				updatedAt: now,
			};
			this.db
				.prepare(
					"INSERT INTO competition_submissions (record_id, task_id, assignment_id, client_submission_id, raw_candidate_hash, normalized_candidate_hash, attempt_no, category, request_payload_json, evidence_refs_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
				)
				.run(
					submission.recordId,
					submission.taskId,
					submission.assignmentId,
					input.clientSubmissionId ?? null,
					submission.rawCandidateHash,
					submission.normalizedCandidateHash,
					submission.attemptNo,
					jsonValue(input.requestPayload),
					jsonValue(input.evidenceRefs),
					now,
					now,
				);
			this.db
				.prepare(
					"UPDATE competition_tasks SET actual_attempts = actual_attempts + 1, updated_at = ? WHERE task_id = ?",
				)
				.run(now, input.taskId);
			return { kind: "started", submission };
		});
	}

	finishSubmission(
		recordId: string,
		result: {
			category: SubmissionRecord["category"];
			isCorrect?: boolean;
			httpStatus?: number;
			businessCode?: string;
			requestPayload?: Record<string, unknown>;
			response?: Record<string, unknown>;
		},
		now = Date.now(),
	): SubmissionRecord | undefined {
		this.db
			.prepare(
				"UPDATE competition_submissions SET category = ?, is_correct = ?, http_status = ?, business_code = ?, request_payload_json = COALESCE(?, request_payload_json), response_json = ?, updated_at = ? WHERE record_id = ?",
			)
			.run(
				result.category,
				result.isCorrect === undefined ? null : result.isCorrect ? 1 : 0,
				result.httpStatus ?? null,
				result.businessCode ?? null,
				result.requestPayload ? jsonValue(result.requestPayload) : null,
				result.response ? jsonValue(result.response) : null,
				now,
				recordId,
			);
		const row = this.db
			.prepare("SELECT * FROM competition_submissions WHERE record_id = ?")
			.get<SubmissionRow>(recordId);
		if (!row) return undefined;
		if (result.isCorrect === true)
			this.db
				.prepare(
					"UPDATE competition_tasks SET status = 'solved', last_error = NULL, updated_at = ? WHERE task_id = ?",
				)
				.run(now, row.task_id);
		return rowSubmission(row);
	}

	recordLocalSubmission(
		input: Omit<BeginSubmissionInput, "maxAttempts" | "now"> & {
			category: Exclude<
				SubmissionRecord["category"],
				| "pending"
				| "accepted"
				| "incorrect"
				| "rate_limited"
				| "environment_error"
				| "platform_closed"
				| "request_error"
			>;
			reason?: string;
		},
		now = Date.now(),
	): SubmissionRecord {
		const existing = this.db
			.prepare("SELECT * FROM competition_submissions WHERE task_id = ? AND normalized_candidate_hash = ?")
			.get<SubmissionRow>(input.taskId, input.normalizedCandidateHash);
		if (existing) return rowSubmission(existing);
		const recordId = randomUUID();
		this.db
			.prepare(
				"INSERT INTO competition_submissions (record_id, task_id, assignment_id, client_submission_id, raw_candidate_hash, normalized_candidate_hash, attempt_no, category, request_payload_json, response_json, evidence_refs_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				recordId,
				input.taskId,
				input.assignmentId,
				input.clientSubmissionId ?? null,
				input.rawCandidateHash,
				input.normalizedCandidateHash,
				input.category,
				jsonValue(input.requestPayload),
				input.reason ? jsonValue({ reason: input.reason }) : null,
				jsonValue(input.evidenceRefs),
				now,
				now,
			);
		return this.getSubmission(recordId) as SubmissionRecord;
	}

	getSubmission(recordId: string): SubmissionRecord | undefined {
		const row = this.db
			.prepare("SELECT * FROM competition_submissions WHERE record_id = ?")
			.get<SubmissionRow>(recordId);
		return row ? rowSubmission(row) : undefined;
	}

	listSubmissions(taskId: string, limit = 100): SubmissionRecord[] {
		return this.db
			.prepare("SELECT * FROM competition_submissions WHERE task_id = ? ORDER BY created_at DESC LIMIT ?")
			.all<SubmissionRow>(taskId, Math.max(1, Math.min(500, Math.trunc(limit))))
			.map(rowSubmission);
	}

	setAuditVerdict(
		taskId: string,
		verdict: CompetitionAuditVerdictRow["verdict"],
		reason: string,
		paused: boolean,
		confidence: number,
		now = Date.now(),
	): void {
		this.db
			.prepare(
				"INSERT INTO competition_audit_verdicts (task_id, verdict, reason, paused, confidence, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET verdict = excluded.verdict, reason = excluded.reason, paused = excluded.paused, confidence = excluded.confidence, updated_at = excluded.updated_at",
			)
			.run(taskId, verdict, reason, paused ? 1 : 0, confidence, now);
	}

	getAuditVerdict(taskId: string): CompetitionAuditVerdictRow | undefined {
		const row = this.db.prepare("SELECT * FROM competition_audit_verdicts WHERE task_id = ?").get<{
			task_id: string;
			verdict: CompetitionAuditVerdictRow["verdict"];
			reason: string;
			paused: number;
			confidence: number;
			updated_at: number;
		}>(taskId);
		return row
			? {
					taskId: row.task_id,
					verdict: row.verdict,
					reason: row.reason,
					paused: row.paused === 1,
					confidence: row.confidence,
					updatedAt: row.updated_at,
				}
			: undefined;
	}

	getArtifact(cacheKey: string): AttachmentCacheEntry | undefined {
		const row = this.db.prepare("SELECT * FROM competition_artifact_cache WHERE cache_key = ?").get<{
			cache_key: string;
			url: string;
			sha256: string;
			size_bytes: number;
			path: string;
			created_at: number;
			last_accessed_at: number;
		}>(cacheKey);
		if (!row) return undefined;
		const now = Date.now();
		this.db
			.prepare("UPDATE competition_artifact_cache SET last_accessed_at = ? WHERE cache_key = ?")
			.run(now, cacheKey);
		return {
			cacheKey: row.cache_key,
			url: row.url,
			sha256: row.sha256,
			sizeBytes: row.size_bytes,
			path: row.path,
			createdAt: row.created_at,
			lastAccessedAt: now,
		};
	}

	putArtifact(entry: AttachmentCacheEntry): void {
		this.db
			.prepare(
				"INSERT INTO competition_artifact_cache (cache_key, url, sha256, size_bytes, path, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET sha256 = excluded.sha256, size_bytes = excluded.size_bytes, path = excluded.path, last_accessed_at = excluded.last_accessed_at",
			)
			.run(
				entry.cacheKey,
				entry.url,
				entry.sha256,
				entry.sizeBytes,
				entry.path,
				entry.createdAt,
				entry.lastAccessedAt,
			);
	}

	tryAcquireArtifactLease(
		cacheKey: string,
		ownerId: string,
		ttlMs: number,
		now = Date.now(),
		maxConcurrent = Number.MAX_SAFE_INTEGER,
	): boolean {
		return this.db.transaction(() => {
			this.db.prepare("DELETE FROM competition_artifact_leases WHERE expires_at <= ?").run(now);
			const current = this.db
				.prepare("SELECT owner_id FROM competition_artifact_leases WHERE cache_key = ?")
				.get<{ owner_id: string }>(cacheKey);
			if (current && current.owner_id !== ownerId) return false;
			if (!current) {
				const count =
					this.db.prepare("SELECT COUNT(*) AS count FROM competition_artifact_leases").get<{ count: number }>()
						?.count ?? 0;
				if (count >= Math.max(1, Math.trunc(maxConcurrent))) return false;
			}
			this.db
				.prepare(
					"INSERT INTO competition_artifact_leases (cache_key, owner_id, expires_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET owner_id = excluded.owner_id, expires_at = excluded.expires_at",
				)
				.run(cacheKey, ownerId, now + Math.max(1, Math.trunc(ttlMs)));
			return true;
		});
	}

	releaseArtifactLease(cacheKey: string, ownerId: string): void {
		this.db
			.prepare("DELETE FROM competition_artifact_leases WHERE cache_key = ? AND owner_id = ?")
			.run(cacheKey, ownerId);
	}

	reserveHostRate(host: string, intervalMs: number, now = Date.now()): number {
		return this.db.transaction(() => {
			const row = this.db
				.prepare("SELECT next_allowed_at FROM competition_host_rate_limits WHERE host = ?")
				.get<{ next_allowed_at: number }>(host);
			const start = Math.max(now, row?.next_allowed_at ?? now);
			this.db
				.prepare(
					"INSERT INTO competition_host_rate_limits (host, next_allowed_at) VALUES (?, ?) ON CONFLICT(host) DO UPDATE SET next_allowed_at = excluded.next_allowed_at",
				)
				.run(host, start + Math.max(0, Math.trunc(intervalMs)));
			return start;
		});
	}

	close(): void {
		this.db.close();
	}
}

interface CompetitionAuditVerdictRow {
	taskId: string;
	verdict: "progressing" | "stalled" | "format_blocked" | "guessing" | "environment_blocked" | "solved";
	reason: string;
	paused: boolean;
	confidence: number;
	updatedAt: number;
}

function rowEnvironment(row: EnvironmentRow): EnvironmentLease {
	return {
		leaseId: row.lease_id,
		exerciseId: row.exercise_id,
		taskId: row.task_id,
		ownerId: row.owner_id,
		acquiredAt: row.acquired_at,
		heartbeatAt: row.heartbeat_at,
		expiresAt: row.expires_at,
		status: row.status,
	};
}

export type { CompetitionAuditVerdictRow };
