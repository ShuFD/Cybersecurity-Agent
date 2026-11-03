import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createNodeSqliteFactory, type SqliteDatabase } from "@earendil-works/pi-session-backend-sqlite-node";
import { isEnvironmentBackedExercise, type SlabExerciseDetails, type SlabExerciseId } from "./competition-api.ts";
import type { CompetitionPlan } from "./competition-protocol.ts";

export type WorklistStatus =
	| "queued"
	| "preparing"
	| "running"
	| "verifying"
	| "solved"
	| "failed"
	| "blocked"
	| "environment_blocked"
	| "platform_closed"
	| "stopped";

export interface WorklistItem {
	id: string;
	exerciseId: SlabExerciseId;
	name: string;
	category?: string;
	description: string;
	status: WorklistStatus;
	priority: number;
	requiresEnvironment: boolean;
	workdir: string;
	sessionId?: string;
	coordinatorSessionId?: string;
	attempts: number;
	failures: number;
	lastError?: string;
	lastFlag?: string;
	metadata: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
}

export interface WorklistEvent {
	id: number;
	itemId?: string;
	type: string;
	message: string;
	payload: Record<string, unknown>;
	createdAt: number;
}

export interface WorklistSnapshot {
	items: WorklistItem[];
	events: WorklistEvent[];
	activeEnvironmentCount: number;
	activeAttachmentCount: number;
	maxEnvironmentCount: number;
	maxFlagAttempts: number;
	maxFailures: number;
	competitionPlan?: CompetitionPlan;
	updatedAt: number;
}

interface WorklistRow {
	id: string;
	exercise_id: string;
	name: string;
	category: string | null;
	description: string;
	status: WorklistStatus;
	priority: number;
	requires_environment: number;
	workdir: string;
	session_id: string | null;
	coordinator_session_id: string | null;
	attempts: number;
	failures: number;
	last_error: string | null;
	last_flag: string | null;
	metadata_json: string;
	created_at: number;
	updated_at: number;
}

interface EventRow {
	id: number;
	item_id: string | null;
	type: string;
	message: string;
	payload_json: string;
	created_at: number;
}

function parseJson(value: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function idText(value: SlabExerciseId): string {
	return String(value);
}

function rowItem(row: WorklistRow): WorklistItem {
	const numericId = /^\d+$/u.test(row.exercise_id) ? Number(row.exercise_id) : row.exercise_id;
	return {
		id: row.id,
		exerciseId: numericId,
		name: row.name,
		...(row.category ? { category: row.category } : {}),
		description: row.description,
		status: row.status,
		priority: row.priority,
		requiresEnvironment: row.requires_environment === 1,
		workdir: row.workdir,
		...(row.session_id ? { sessionId: row.session_id } : {}),
		...(row.coordinator_session_id ? { coordinatorSessionId: row.coordinator_session_id } : {}),
		attempts: row.attempts,
		failures: row.failures,
		...(row.last_error ? { lastError: row.last_error } : {}),
		...(row.last_flag ? { lastFlag: row.last_flag } : {}),
		metadata: parseJson(row.metadata_json),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function rowEvent(row: EventRow): WorklistEvent {
	return {
		id: row.id,
		...(row.item_id ? { itemId: row.item_id } : {}),
		type: row.type,
		message: row.message,
		payload: parseJson(row.payload_json),
		createdAt: row.created_at,
	};
}

export class WorklistStore {
	readonly path: string;
	private readonly db: SqliteDatabase;

	private constructor(db: SqliteDatabase, path: string) {
		this.db = db;
		this.path = path;
	}

	static async open(path: string): Promise<WorklistStore> {
		mkdirSync(dirname(path), { recursive: true });
		const db = await createNodeSqliteFactory().open(path);
		db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
		db.exec(`
			CREATE TABLE IF NOT EXISTS work_items (
				id TEXT PRIMARY KEY,
				exercise_id TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				category TEXT,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL,
				priority REAL NOT NULL DEFAULT 0,
				requires_environment INTEGER NOT NULL DEFAULT 0,
				workdir TEXT NOT NULL,
				session_id TEXT,
				coordinator_session_id TEXT,
				attempts INTEGER NOT NULL DEFAULT 0,
				failures INTEGER NOT NULL DEFAULT 0,
				last_error TEXT,
				last_flag TEXT,
				metadata_json TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
				CREATE TABLE IF NOT EXISTS work_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				item_id TEXT,
				type TEXT NOT NULL,
				message TEXT NOT NULL,
				payload_json TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS work_events_created_idx ON work_events(created_at DESC);
		`);
		try {
			db.exec("ALTER TABLE work_items ADD COLUMN priority REAL NOT NULL DEFAULT 0;");
		} catch {
			// Existing databases already have the priority column.
		}
		db.exec(
			"CREATE INDEX IF NOT EXISTS work_items_status_idx ON work_items(status, requires_environment, updated_at);",
		);
		return new WorklistStore(db, path);
	}

	upsertExercise(details: SlabExerciseDetails, workdir: string, priority = 0): WorklistItem {
		const id = idText(details.id);
		const now = Date.now();
		const metadata = {
			raw: details.raw,
			attachments: details.attachments,
			endpoints: details.endpoints,
			isOpen: details.isOpen,
			hasSolved: details.hasSolved,
			isNeedInit: details.isNeedInit,
			isNeedCheck: details.isNeedCheck,
			endpointType: details.endpointType ?? null,
		};
		const existing = this.db
			.prepare("SELECT status, attempts, failures, created_at FROM work_items WHERE exercise_id = ?")
			.get<{
				status: WorklistStatus;
				attempts: number;
				failures: number;
				created_at: number;
			}>(id);
		const status: WorklistStatus = details.hasSolved ? "solved" : (existing?.status ?? "queued");
		this.db
			.prepare(`
			INSERT INTO work_items (
					id, exercise_id, name, category, description, status, requires_environment, workdir,
					priority, attempts, failures, metadata_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(exercise_id) DO UPDATE SET
				name = excluded.name,
				category = excluded.category,
				description = excluded.description,
				requires_environment = excluded.requires_environment,
				workdir = excluded.workdir,
				status = CASE WHEN work_items.status IN ('running', 'preparing', 'verifying') THEN work_items.status ELSE excluded.status END,
				priority = CASE WHEN work_items.status IN ('running', 'preparing', 'verifying') THEN work_items.priority ELSE excluded.priority END,
				metadata_json = excluded.metadata_json,
				updated_at = excluded.updated_at
		`)
			.run(
				id,
				id,
				details.name,
				details.category ?? null,
				details.description,
				status,
				isEnvironmentBackedExercise(details) ? 1 : 0,
				workdir,
				priority,
				existing?.attempts ?? 0,
				existing?.failures ?? 0,
				JSON.stringify(metadata),
				existing?.created_at ?? now,
				now,
			);
		return this.get(id) as WorklistItem;
	}

	get(itemId: string): WorklistItem | undefined {
		const row = this.db.prepare("SELECT * FROM work_items WHERE id = ?").get<WorklistRow>(itemId);
		return row ? rowItem(row) : undefined;
	}

	remove(itemId: string, message = "Removed from the worklist"): boolean {
		const item = this.get(itemId);
		if (!item) return false;
		this.db.prepare("DELETE FROM work_events WHERE item_id = ?").run(itemId);
		this.db.prepare("DELETE FROM work_items WHERE id = ?").run(itemId);
		this.addEvent(undefined, "removed", message, { itemId, exerciseId: item.exerciseId, name: item.name });
		return true;
	}

	list(status?: WorklistStatus): WorklistItem[] {
		const rows = status
			? this.db
					.prepare("SELECT * FROM work_items WHERE status = ? ORDER BY priority DESC, updated_at ASC, id ASC")
					.all<WorklistRow>(status)
			: this.db
					.prepare(
						"SELECT * FROM work_items ORDER BY CASE WHEN status = 'queued' THEN 0 ELSE 1 END, priority DESC, updated_at DESC, id ASC",
					)
					.all<WorklistRow>();
		return rows.map(rowItem);
	}

	attachSession(itemId: string, sessionId: string, coordinatorSessionId?: string): void {
		this.db
			.prepare(
				"UPDATE work_items SET session_id = ?, coordinator_session_id = COALESCE(?, coordinator_session_id), updated_at = ? WHERE id = ?",
			)
			.run(sessionId, coordinatorSessionId ?? null, Date.now(), itemId);
	}

	setStatus(itemId: string, status: WorklistStatus, message = "", payload: Record<string, unknown> = {}): void {
		this.db
			.prepare("UPDATE work_items SET status = ?, last_error = ?, updated_at = ? WHERE id = ?")
			.run(
				status,
				["failed", "blocked", "environment_blocked", "platform_closed", "stopped"].includes(status)
					? message
					: null,
				Date.now(),
				itemId,
			);
		this.addEvent(itemId, status, message || `work item status: ${status}`, payload);
	}

	recordAttempt(itemId: string, flag?: string): WorklistItem | undefined {
		this.db
			.prepare("UPDATE work_items SET attempts = attempts + 1, last_flag = ?, updated_at = ? WHERE id = ?")
			.run(flag ?? null, Date.now(), itemId);
		return this.get(itemId);
	}

	appendGuidance(itemId: string, message: string): WorklistItem | undefined {
		const item = this.get(itemId);
		if (!item) return undefined;
		const now = Date.now();
		const previous = Array.isArray(item.metadata.operatorGuidance) ? item.metadata.operatorGuidance : [];
		const guidance = [...previous, { message, createdAt: now }].slice(-20);
		this.db
			.prepare("UPDATE work_items SET metadata_json = ?, updated_at = ? WHERE id = ?")
			.run(JSON.stringify({ ...item.metadata, operatorGuidance: guidance }), now, itemId);
		this.addEvent(itemId, "operator-guidance", "Operator guidance recorded", { message });
		return this.get(itemId);
	}

	recordFailure(itemId: string, message: string): WorklistItem | undefined {
		this.db
			.prepare("UPDATE work_items SET failures = failures + 1, last_error = ?, updated_at = ? WHERE id = ?")
			.run(message, Date.now(), itemId);
		this.addEvent(itemId, "failure", message);
		return this.get(itemId);
	}

	addEvent(
		itemId: string | undefined,
		type: string,
		message: string,
		payload: Record<string, unknown> = {},
	): WorklistEvent {
		const now = Date.now();
		const result = this.db
			.prepare("INSERT INTO work_events (item_id, type, message, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
			.run(itemId ?? null, type, message, JSON.stringify(payload), now);
		return {
			id: result.lastInsertRowid ?? 0,
			...(itemId ? { itemId } : {}),
			type,
			message,
			payload,
			createdAt: now,
		};
	}

	events(limit = 100): WorklistEvent[] {
		return this.db
			.prepare("SELECT * FROM work_events ORDER BY id DESC LIMIT ?")
			.all<EventRow>(Math.max(1, Math.min(500, limit)))
			.map(rowEvent)
			.reverse();
	}

	close(): void {
		this.db.close();
	}
}
