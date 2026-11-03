import { randomUUID } from "node:crypto";
import { CompetitionSolverBinding } from "./competition-solver.js";
import { buildSolverPrompt } from "./worklist.js";

export class DesktopSolverManager {
    constructor(controller, bridge, mainSessionId, options = {}) {
        this.controller = controller; this.bridge = bridge; this.mainSessionId = mainSessionId;
        this.submissionSupported = options.submissionSupported === true;
        this.entries = new Map();
        this.finalizing = new Map();
    }
    // Stop a task and make sure its platform environment slot is actually freed.
    // The broker keeps the environment lease when the platform DELETE fails, so a
    // plain stopTask() can leave a slot reserved. Retry the release by lease id and
    // surface an incomplete cleanup instead of reporting a clean stop.
    async finalizeTask(taskId, reason) {
        if (this.finalizing.has(taskId)) return this.finalizing.get(taskId);
        const operation = this.finalizeTaskInternal(taskId, reason);
        this.finalizing.set(taskId, operation);
        try { return await operation; }
        finally { this.finalizing.delete(taskId); }
    }
    async findTask(taskId) {
        const tasks = await this.controller.listTasks().catch(() => []);
        return tasks.find(t => t.taskId === taskId);
    }
    async releaseLease(leaseId) {
        if (!leaseId) return { released: true, status: "no-lease" };
        return await this.controller.coordinator.releaseEnvironment(leaseId);
    }
    async finalizeTaskInternal(taskId, reason) {
        const before = await this.findTask(taskId);
        const leaseId = before?.environmentLeaseId;
        if (before?.status === "solved") {
            const release = await this.releaseLease(leaseId);
            if (release?.released === false || release?.error)
                throw new Error("Accepted task environment cleanup failed: " + (release.error ?? "not released"));
            return { taskId, solved: true, release };
        }
        let stopped;
        try {
            stopped = await this.controller.coordinator.stopTask(taskId, reason);
        } catch (error) {
            if (!leaseId) throw error;
            const released = await this.releaseLease(leaseId).catch(e => ({ released: false, error: e.message }));
            if (released && released.released !== false) return { taskId, stopped: false, release: released };
            throw new Error(`stop_task failed (${error.message}); environment release failed (${released?.error ?? "unconfirmed"})`);
        }
        const release = stopped?.environmentRelease;
        if (!release || !release.error) return { taskId, stopped: true, result: stopped };
        if (!leaseId)
            throw new Error("Environment release failed and the task retained no lease id: " + release.error);
        const retried = await this.releaseLease(leaseId).catch(e => ({ released: false, error: e.message }));
        if (retried && retried.released !== false)
            return { taskId, stopped: true, result: stopped, release: retried };
        throw new Error(`Environment release failed: ${release.error}; retry: ${retried?.error ?? "not released"}`);
    }
    async dispatch(input) {
        if (this.entries.has(input.taskId)) throw new Error("Task already has a live desktop solver");
        if (!input.prompt?.trim()) throw new Error("Solver directive must not be empty");
        const tasks = await this.controller.listTasks();
        const task = tasks.find(t => t.taskId === input.taskId);
        if (!task || !["queued", "environment_blocked"].includes(task.status)) throw new Error("Task is not dispatchable");
        if (task.attemptBudget === undefined) throw new Error("Set the attempt budget before dispatch");
        const item = this.controller.worklist.findItemForCompetitionTask(task.taskId);
        if (!item) throw new Error("Task is not synchronized into the worklist");
        const prepared = await this.controller.worklist.prepareTaskForSolver(item.id);
        const binding = new CompetitionSolverBinding({ socketPath: this.controller.worklist.competitionSocket,
            taskId: task.taskId, solverId: "desktop-solver:" + randomUUID() });
        let entry;
        try {
            const envelope = await binding.claim();
            const modelProfiles = await this.bridge.modelProfiles();
            const llmNo = input.model ? modelProfiles.findIndex(m => m.provider === input.model.provider && m.model === input.model.id) : undefined;
            if (llmNo === -1) throw new Error("Requested solver model is unavailable");
            const session = await this.bridge.createDesktopSolverSession({
                title: input.title || `Solver — ${task.challenge.name}`, cwd: prepared.item.workdir,
                persist: true, executionMode: "direct", memoryReferenceEnabled: false, knowledgeBaseEnabled: false,
                ...(llmNo === undefined ? {} : { llmNo }),
            }, binding);
            entry = { sessionId: session.id, taskId: task.taskId, binding, running: true, finalized: false };
            this.entries.set(task.taskId, entry);
            const prompt = buildSolverPrompt(prepared.details, prepared.item.workdir, this.mainSessionId, []) +
                "\n\nBroker-owned task envelope:\n" + JSON.stringify(envelope) +
                "\n\nMain Agent directive:\n" + input.prompt +
                (this.submissionSupported
                    ? "\nThis platform verifies flags through the broker. When you hold an evidence-backed candidate, record it with competition_flag_candidate and submit it with competition_submit_request; the broker returns the platform verdict. Accepted automatically ends this solver. Incorrect returns feedback and remainingAttempts: revise with evidence and continue within budget. Do not call verify_flag/check_flag, and do not claim acceptance yourself. Report work through competition progress/blocked tools."
                    : "\nThis platform has no flag submission endpoint. Do not call verify_flag/check_flag or claim accepted verification. Report work through competition progress/blocked tools.");
            await this.bridge.promptDesktopSession(session.id, prompt);
            entry.completion = this.settle(entry);
            return { taskId: task.taskId, solverId: binding.solverId, sessionId: session.id, status: "starting",
                parentMainSessionId: this.mainSessionId, transport: "desktop-pi-session" };
        } catch (error) {
            binding.close();
            await this.finalizeTask(task.taskId, "Desktop solver startup failed").catch(() => undefined);
            throw error;
        }
    }
    async settle(entry) {
        try {
            const state = await this.bridge.waitDesktopSession(entry.sessionId);
            if (!entry.finalized) {
                entry.finalized = true;
                await this.finalizeTask(entry.taskId,
                    entry.binding.verifiedSubmission ? "Platform accepted the submitted answer" :
                    state.lastError ? "Desktop solver ended with a model/tool error" :
                        "Desktop solver completed its finite assignment; no platform flag verification");
            }
        } catch (error) { entry.cleanupError = error.message; }
        finally { entry.running = false; entry.binding.close(); }
    }
    async list() {
        const result = [{ sessionId: this.mainSessionId, role: "main", title: "Main Agent", status: "idle" }];
        for (const e of this.entries.values()) result.push({ sessionId: e.sessionId, role: "solver", taskId: e.taskId,
            parentMainSessionId: this.mainSessionId, status: e.running ? "running" : e.cleanupError ? "error" : e.binding?.verifiedSubmission ? "solved" : "stopped",
            ...(e.cleanupError ? { cleanupError: e.cleanupError } : {}) });
        return result;
    }
    async guide(taskId, message) {
        const entry = this.entries.get(taskId);
        if (!entry?.running) return { taskId, delivered: false };
        await this.bridge.guideDesktopSession(entry.sessionId, message);
        return { taskId, delivered: true, sessionId: entry.sessionId };
    }
    async stop(taskId) {
        const entry = this.entries.get(taskId);
        if (!entry) {
            // Idempotent retry: a previous stop may have left the environment lease behind.
            const task = await this.findTask(taskId);
            if (!task?.environmentLeaseId) return { taskId, stopped: false };
            const recovered = await this.finalizeTask(taskId, "Desktop Main Agent stopped the task");
            return { taskId, stopped: true, recovered: true, ...(recovered.release ? { release: recovered.release } : {}) };
        }
        if (entry.running) await this.bridge.abortDesktopSession(entry.sessionId);
        await entry.completion;
        if (entry.cleanupError) {
            try { await this.finalizeTask(taskId, "Desktop solver cleanup retry"); entry.cleanupError = undefined; }
            catch (error) { entry.cleanupError = error.message; }
        }
        this.entries.delete(taskId);
        return { taskId, stopped: true, ...(entry.cleanupError ? { cleanupError: entry.cleanupError } : {}) };
    }
    async close() { for (const taskId of this.entries.keys()) await this.stop(taskId); }
}
