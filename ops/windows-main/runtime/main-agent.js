import { CompetitionCoordinatorBinding, summarizeCompetitionTask } from "./competition-solver.js";
import { listSessionRegistrations } from "./session-registry.js";
import { TmuxSolverProcessManager } from "./solver-process.js";
import { openWorklistOrchestrator } from "./worklist.js";
const DEFAULT_SOLVER_DISPATCH_INTERVAL_MS = 2_000;
const MIN_SOLVER_DISPATCH_INTERVAL_MS = 1_000;
const MAX_SOLVER_DISPATCH_INTERVAL_MS = 5_000;
function countStatuses(values) {
    return values.reduce((counts, value) => {
        counts[value] = (counts[value] ?? 0) + 1;
        return counts;
    }, {});
}
function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export function resolveSolverDispatchIntervalMs(env = process.env, override) {
    const configured = override ?? Number(env.SECHEUR_SOLVER_DISPATCH_INTERVAL_MS ?? DEFAULT_SOLVER_DISPATCH_INTERVAL_MS);
    if (!Number.isFinite(configured))
        return DEFAULT_SOLVER_DISPATCH_INTERVAL_MS;
    return Math.min(MAX_SOLVER_DISPATCH_INTERVAL_MS, Math.max(MIN_SOLVER_DISPATCH_INTERVAL_MS, Math.trunc(configured)));
}
export class SerialDispatchQueue {
    tail = Promise.resolve();
    nextAllowedAt = 0;
    intervalMs;
    constructor(intervalMs) {
        this.intervalMs = Math.max(0, Math.trunc(intervalMs));
    }
    enqueue(operation) {
        const run = this.tail.then(async () => {
            const remaining = this.nextAllowedAt - Date.now();
            if (remaining > 0)
                await wait(remaining);
            this.nextAllowedAt = Date.now() + this.intervalMs;
            return operation();
        });
        this.tail = run.then(() => undefined, () => undefined);
        return run;
    }
}
export class MainAgentController {
    worklist;
    config;
    env;
    coordinator;
    solverManager;
    dispatchQueue;
    closed = false;
    constructor(config, env, worklist, coordinator, dispatchIntervalMs) {
        this.config = config;
        this.env = env;
        this.worklist = worklist;
        this.coordinator = coordinator;
        this.dispatchQueue = new SerialDispatchQueue(dispatchIntervalMs);
    }
    static async open(options) {
        const env = options.env ?? process.env;
        const worklist = options.worklist ?? await openWorklistOrchestrator({ config: options.config, env, mode: "main" });
        try {
            await worklist.start();
            const coordinator = new CompetitionCoordinatorBinding({
                socketPath: worklist.competitionSocket,
                clientId: `main:${process.pid}`,
            });
            return new MainAgentController(options.config, env, worklist, coordinator, resolveSolverDispatchIntervalMs(env, options.dispatchIntervalMs));
        }
        catch (error) {
            await worklist.close();
            throw error;
        }
    }
    attachMainSession(sessionId, manager) {
        if (manager) { this.solverManager = manager; return; }
        this.solverManager = new TmuxSolverProcessManager({
            config: this.config,
            env: this.env,
            worklist: this.worklist,
            mainSessionId: sessionId,
        });
    }
    async sync() {
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
    async configureCompetition(patch) {
        return this.worklist.configureCompetition(patch);
    }
    async listTasks() {
        return this.coordinator.listTasks();
    }
    async setPlan(input) {
        const result = await this.coordinator.setPlan(input);
        return { plan: result.plan, tasks: result.tasks.map(summarizeCompetitionTask) };
    }
    async getPlan() {
        const result = await this.coordinator.getPlan();
        return { plan: result.plan ?? null, tasks: result.tasks.map(summarizeCompetitionTask) };
    }
    async setAttemptBudgets(budgets) {
        const result = await this.coordinator.setAttemptBudgets(budgets);
        return { tasks: result.tasks.map(summarizeCompetitionTask) };
    }
    async requeueTasks(taskIds, reason) {
        if (!this.solverManager)
            throw new Error("Main session host is not ready");
        const unique = [...new Set(taskIds.map((taskId) => taskId.trim()).filter(Boolean))];
        if (unique.length === 0)
            throw new Error("At least one competition task is required");
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
    async dispatchSolver(input) {
        if (!this.solverManager)
            throw new Error("Main session host is not ready");
        return this.dispatchQueue.enqueue(async () => {
            if (this.closed)
                throw new Error("Main session host is closed");
            if (!this.solverManager)
                throw new Error("Main session host is not ready");
            return this.solverManager.dispatch(input);
        });
    }
    async listSolvers() {
        return this.solverManager ? this.solverManager.list() : listSessionRegistrations(this.config.stateDir, { pruneStale: true });
    }
    async guideSolver(taskId, message) {
        if (!this.solverManager)
            throw new Error("Main session host is not ready");
        return this.solverManager.guide(taskId, message);
    }
    async stopSolver(taskId, reason) {
        if (!this.solverManager)
            throw new Error("Main session host is not ready");
        const processResult = await this.solverManager.stop(taskId);
        const taskResult = await this.coordinator.stopTask(taskId, reason ?? "Stopped by Main Agent");
        return { ...processResult, task: taskResult };
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        await this.solverManager?.close();
        this.coordinator.close();
        await this.worklist.close();
    }
}
//# sourceMappingURL=main-agent.js.map