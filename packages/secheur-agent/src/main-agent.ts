import type { CompetitionAdapterConfigPatch } from "./competition-runtime.ts";
import { CompetitionCoordinatorBinding, summarizeCompetitionTask } from "./competition-solver.ts";
import type { CompetitionTaskRecord } from "./competition-store.ts";
import type { SecHeurConfig } from "./config.ts";
import { listSessionRegistrations, type PiSessionRegistration } from "./session-registry.ts";
import { type DispatchSolverInput, TmuxSolverProcessManager } from "./solver-process.ts";
import { openWorklistOrchestrator, type WorklistOrchestrator } from "./worklist.ts";

const DEFAULT_SOLVER_DISPATCH_INTERVAL_MS = 2_000;
const MIN_SOLVER_DISPATCH_INTERVAL_MS = 1_000;
const MAX_SOLVER_DISPATCH_INTERVAL_MS = 5_000;

function countStatuses(values: string[]): Record<string, number> {
	return values.reduce<Record<string, number>>((counts, value) => {
		counts[value] = (counts[value] ?? 0) + 1;
		return counts;
	}, {});
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveSolverDispatchIntervalMs(env: NodeJS.ProcessEnv = process.env, override?: number): number {
	const configured =
		override ?? Number(env.SECHEUR_SOLVER_DISPATCH_INTERVAL_MS ?? DEFAULT_SOLVER_DISPATCH_INTERVAL_MS);
	if (!Number.isFinite(configured)) return DEFAULT_SOLVER_DISPATCH_INTERVAL_MS;
	return Math.min(MAX_SOLVER_DISPATCH_INTERVAL_MS, Math.max(MIN_SOLVER_DISPATCH_INTERVAL_MS, Math.trunc(configured)));
}

export class SerialDispatchQueue<T> {
	private tail: Promise<void> = Promise.resolve();
	private nextAllowedAt = 0;
	private readonly intervalMs: number;

	constructor(intervalMs: number) {
		this.intervalMs = Math.max(0, Math.trunc(intervalMs));
	}

	enqueue(operation: () => Promise<T>): Promise<T> {
		const run = this.tail.then(async () => {
			const remaining = this.nextAllowedAt - Date.now();
			if (remaining > 0) await wait(remaining);
			this.nextAllowedAt = Date.now() + this.intervalMs;
			return operation();
		});
		this.tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}
}

export interface MainWorkflowBinding {
	configureCompetition(patch: CompetitionAdapterConfigPatch): Promise<Record<string, unknown>>;
	sync(): Promise<Record<string, unknown>>;
	setAttemptBudgets(budgets: Array<{ taskId: string; budget: number }>): Promise<Record<string, unknown>>;
	requeueTasks(taskIds: string[], reason?: string): Promise<Record<string, unknown>>;
	dispatchSolver(input: DispatchSolverInput): Promise<Record<string, unknown>>;
	listSolvers(): Promise<PiSessionRegistration[]>;
	guideSolver(taskId: string, message: string): Promise<Record<string, unknown>>;
	stopSolver(taskId: string, reason?: string): Promise<Record<string, unknown>>;
}

export interface MainAgentControllerOptions {
	config: SecHeurConfig;
	env?: NodeJS.ProcessEnv;
	dispatchIntervalMs?: number;
}

export class MainAgentController implements MainWorkflowBinding {
	readonly worklist: WorklistOrchestrator;
	private readonly config: SecHeurConfig;
	private readonly env: NodeJS.ProcessEnv;
	readonly coordinator: CompetitionCoordinatorBinding;
	private solverManager?: TmuxSolverProcessManager;
	private readonly dispatchQueue: SerialDispatchQueue<Record<string, unknown>>;
	private closed = false;

	private constructor(
		config: SecHeurConfig,
		env: NodeJS.ProcessEnv,
		worklist: WorklistOrchestrator,
		coordinator: CompetitionCoordinatorBinding,
		dispatchIntervalMs: number,
	) {
		this.config = config;
		this.env = env;
		this.worklist = worklist;
		this.coordinator = coordinator;
		this.dispatchQueue = new SerialDispatchQueue(dispatchIntervalMs);
	}

	static async open(options: MainAgentControllerOptions): Promise<MainAgentController> {
		const env = options.env ?? process.env;
		const worklist = await openWorklistOrchestrator({ config: options.config, env, mode: "main" });
		try {
			await worklist.start();
			const coordinator = new CompetitionCoordinatorBinding({
				socketPath: worklist.competitionSocket,
				clientId: `main:${process.pid}`,
			});
			return new MainAgentController(
				options.config,
				env,
				worklist,
				coordinator,
				resolveSolverDispatchIntervalMs(env, options.dispatchIntervalMs),
			);
		} catch (error) {
			await worklist.close();
			throw error;
		}
	}

	attachMainSession(sessionId: string): void {
		this.solverManager = new TmuxSolverProcessManager({
			config: this.config,
			env: this.env,
			worklist: this.worklist,
			mainSessionId: sessionId,
		});
	}

	async sync(): Promise<Record<string, unknown>> {
		const snapshot = await this.worklist.refresh();
		const tasks = await this.coordinator.listTasks();
		return {
			snapshot: {
				itemCount: snapshot.items.length,
				statusCounts: countStatuses(snapshot.items.map((item) => item.status)),
				activeEnvironmentCount: snapshot.activeEnvironmentCount,
				activeAttachmentCount: snapshot.activeAttachmentCount,
			},
			taskCount: tasks.length,
			statusCounts: countStatuses(tasks.map((task) => task.status)),
			taskIds: tasks.map((task) => task.taskId),
		};
	}

	async configureCompetition(patch: CompetitionAdapterConfigPatch): Promise<Record<string, unknown>> {
		return this.worklist.configureCompetition(patch);
	}

	async listTasks(): Promise<CompetitionTaskRecord[]> {
		return this.coordinator.listTasks();
	}

	async setPlan(input: {
		taskIds: string[];
		rationale: string;
		expectedRevision?: number;
	}): Promise<Record<string, unknown>> {
		const result = await this.coordinator.setPlan(input);
		return { plan: result.plan, tasks: result.tasks.map(summarizeCompetitionTask) };
	}

	async getPlan(): Promise<Record<string, unknown>> {
		const result = await this.coordinator.getPlan();
		return { plan: result.plan ?? null, tasks: result.tasks.map(summarizeCompetitionTask) };
	}

	async setAttemptBudgets(budgets: Array<{ taskId: string; budget: number }>): Promise<Record<string, unknown>> {
		const result = await this.coordinator.setAttemptBudgets(budgets);
		return { tasks: result.tasks.map(summarizeCompetitionTask) };
	}

	async requeueTasks(taskIds: string[], reason?: string): Promise<Record<string, unknown>> {
		if (!this.solverManager) throw new Error("Main session host is not ready");
		const unique = [...new Set(taskIds.map((taskId) => taskId.trim()).filter(Boolean))];
		if (unique.length === 0) throw new Error("At least one competition task is required");
		const normalizedReason = reason?.trim() || "Requeued by Main Agent";
		for (const taskId of unique) {
			await this.solverManager.stop(taskId);
			await this.coordinator.stopTask(taskId, `Preparing task for a new solver: ${normalizedReason}`);
		}
		const result = await this.coordinator.requeueTasks(unique, normalizedReason);
		await this.worklist.refresh().catch(() => undefined);
		return {
			reason: result.reason,
			previousStatuses: result.previousStatuses,
			tasks: result.tasks.map(summarizeCompetitionTask),
		};
	}

	async dispatchSolver(input: DispatchSolverInput): Promise<Record<string, unknown>> {
		if (!this.solverManager) throw new Error("Main session host is not ready");
		return this.dispatchQueue.enqueue(async () => {
			if (this.closed) throw new Error("Main session host is closed");
			if (!this.solverManager) throw new Error("Main session host is not ready");
			return this.solverManager.dispatch(input);
		});
	}

	async listSolvers(): Promise<PiSessionRegistration[]> {
		return listSessionRegistrations(this.config.stateDir, { pruneStale: true });
	}

	async guideSolver(taskId: string, message: string): Promise<Record<string, unknown>> {
		if (!this.solverManager) throw new Error("Main session host is not ready");
		return this.solverManager.guide(taskId, message);
	}

	async stopSolver(taskId: string, reason?: string): Promise<Record<string, unknown>> {
		if (!this.solverManager) throw new Error("Main session host is not ready");
		const processResult = await this.solverManager.stop(taskId);
		const taskResult = await this.coordinator.stopTask(taskId, reason ?? "Stopped by Main Agent");
		return { ...processResult, task: taskResult };
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.solverManager?.close();
		this.coordinator.close();
		await this.worklist.close();
	}
}
