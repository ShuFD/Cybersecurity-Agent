import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PlanningPersistenceError } from "./failures.ts";

export interface PlanningCoverage {
	remaining: Array<{ question: string; ownerId?: string; dependsOn?: string[]; evidenceIds?: string[] }>;
	recheckOn: string;
}
interface Notebook {
	runId: string;
	role: string;
	pages: Array<{ evidenceId: string; offset: number; limit: number; hash: string; at: number; value?: unknown }>;
	todos: unknown[];
	coverage?: PlanningCoverage;
}
/** A durable reading ledger and plan scratchpad; never a source of verified facts. */
export class PlannerMemory {
	private readonly path: string;
	private data: Notebook;
	constructor(stateDir: string, runId: string, role: string) {
		const directory = join(stateDir, "planning", "notebooks");
		mkdirSync(directory, { recursive: true });
		this.path = join(directory, `${createHash("sha256").update(`${runId}:${role}`).digest("hex")}.json`);
		this.data = { runId, role, pages: [], todos: [] };
		try {
			const saved = JSON.parse(readFileSync(this.path, "utf8")) as Notebook;
			if (saved.runId !== runId || saved.role !== role || !Array.isArray(saved.pages) || !Array.isArray(saved.todos))
				throw new Error("Invalid planner notebook identity");
			this.data = saved;
		} catch (error) {
			if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
				throw new PlanningPersistenceError("Planner notebook could not be read", error);
		}
	}
	private save(): void {
		try {
			writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data), { mode: 0o600 });
			renameSync(`${this.path}.tmp`, this.path);
		} catch (error) {
			throw new PlanningPersistenceError("Planner notebook could not be saved", error);
		}
	}
	readPage(
		evidenceId: string,
		offset: number,
		limit: number,
		value: unknown,
	): { cacheHit: boolean; hash: string; value: unknown } {
		const hash = createHash("sha256").update(JSON.stringify(value)).digest("hex");
		const prior = this.data.pages.find(
			(p) => p.evidenceId === evidenceId && p.offset === offset && p.limit === limit,
		);
		const cacheHit = prior?.hash === hash;
		this.data.pages = [
			...this.data.pages.filter((p) => !(p.evidenceId === evidenceId && p.offset === offset && p.limit === limit)),
			{
				evidenceId,
				offset,
				limit,
				hash,
				at: Date.now(),
				...(JSON.stringify(value).length <= 16384 ? { value } : {}),
			},
		].slice(-64);
		this.save();
		return { cacheHit, hash, value: cacheHit && prior?.value !== undefined ? prior.value : value };
	}
	stage(value: unknown): void {
		if (!value || typeof value !== "object") return;
		const proposal = value as Record<string, unknown>;
		const tasks = proposal.tasks ?? proposal.proposedIntents;
		if (Array.isArray(tasks) && tasks.length) this.data.todos = [...this.data.todos, ...tasks].slice(-32);
		if (proposal.coverage) this.data.coverage = proposal.coverage as PlanningCoverage;
		this.save();
	}
	overview(): unknown {
		return {
			runId: this.data.runId,
			role: this.data.role,
			unverifiedPlanScratchpad: this.data.todos.slice(-8),
			previouslyReadPages: this.data.pages.slice(-12).map(({ value: _value, ...pointer }) => pointer),
			coverage: this.data.coverage,
		};
	}
}

export function validatePlanningCoverage(
	value: unknown,
	ownerIds: string[],
	dependencyIds: string[],
	evidenceIds: string[],
): void {
	if (!value || typeof value !== "object")
		throw new Error("Waiting requires coverage of remaining questions and a recheck condition");
	const coverage = value as PlanningCoverage;
	if (
		!Array.isArray(coverage.remaining) ||
		!coverage.remaining.length ||
		coverage.remaining.length > 16 ||
		typeof coverage.recheckOn !== "string" ||
		!coverage.recheckOn.trim() ||
		coverage.recheckOn.length > 500
	)
		throw new Error("Waiting requires bounded remaining questions and recheckOn");
	for (const entry of coverage.remaining) {
		if (!entry || typeof entry.question !== "string" || !entry.question.trim() || entry.question.length > 500)
			throw new Error("Each remaining question must be concrete and at most 500 characters");
		if (
			!(entry.ownerId && ownerIds.includes(entry.ownerId)) &&
			!(entry.dependsOn?.length && entry.dependsOn.every((id) => dependencyIds.includes(id)))
		)
			throw new Error(
				"Waiting must name a current owner or live dependency; append useful work when nobody can advance it",
			);
		if (entry.evidenceIds?.some((id) => !evidenceIds.includes(id)))
			throw new Error("Coverage cites evidence outside this run");
	}
}
