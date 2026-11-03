import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { CompetitionPlatformError } from "./competition-adapters.js";
import { competitionEnvPath, isEnvironmentBackedExercise, normalizeCompetitionFlag, SlabAgentApi, } from "./competition-api.js";
import { AttachmentCache } from "./competition-attachments.js";
import { CompetitionBroker } from "./competition-broker.js";
import { CompetitionBrokerServer } from "./competition-protocol-service.js";
import { competitionAdapterConfigFromEnvironment, createCompetitionAdapter, resolveCompetitionAdapterConfig, } from "./competition-runtime.js";
import { CompetitionCoordinatorBinding, CompetitionSolverBinding } from "./competition-solver.js";
import { CompetitionStore } from "./competition-store.js";
import { createSecHeurRuntime } from "./runtime.js";
import { competitionSocketPath as deriveCompetitionSocketPath } from "./session-registry.js";
import { finalAssistantText } from "./subagent.js";
import { WorklistStore } from "./worklist-store.js";
const DEFAULT_SYNC_INTERVAL_MS = 30_000;
const DEFAULT_MAX_ENVIRONMENTS = 3;
const DEFAULT_MAX_FAILURES = 2;
const DEFAULT_MAX_FLAG_ATTEMPTS = 3;
const ATTACHMENT_MAX_BYTES = 512 * 1024 * 1024;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function envNumber(env, name, fallback, minimum) {
    const value = Number(env[name] ?? fallback);
    return Number.isFinite(value) ? Math.max(minimum, Math.trunc(value)) : fallback;
}
function envIdSet(env, name) {
    return new Set((env[name] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean));
}
function safeName(value, fallback) {
    const normalized = value
        .replace(/[^A-Za-z0-9_.-]+/gu, "-")
        .replace(/^-+|-+$/gu, "")
        .slice(0, 100);
    return normalized || fallback;
}
function exerciseNeedsEnvironment(details) {
    return isEnvironmentBackedExercise(details);
}
function cachedAttachments(value) {
    const entries = Array.isArray(value) ? value : isRecord(value) ? [value] : [];
    return entries.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.url !== "string" || !entry.url.trim())
            return [];
        const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : "attachment";
        const ext = typeof entry.ext === "string" && entry.ext.trim() ? entry.ext.trim() : undefined;
        return [{ name, url: entry.url.trim(), ...(ext ? { ext } : {}) }];
    });
}
function cachedDetails(item) {
    const raw = isRecord(item.metadata.raw) ? item.metadata.raw : undefined;
    if (!raw)
        return undefined;
    const attachments = Array.isArray(item.metadata.attachments) && item.metadata.attachments.length > 0
        ? cachedAttachments(item.metadata.attachments)
        : cachedAttachments(raw.attachment);
    const endpoints = Array.isArray(item.metadata.endpoints)
        ? item.metadata.endpoints
        : Array.isArray(raw.endpoints)
            ? raw.endpoints
            : [];
    const endpointType = typeof item.metadata.endpointType === "string"
        ? item.metadata.endpointType
        : typeof raw.endpointType === "string"
            ? raw.endpointType
            : undefined;
    const description = typeof raw.description === "string" ? raw.description : item.description;
    return {
        id: item.exerciseId,
        name: typeof raw.name === "string" && raw.name.trim() ? raw.name : item.name,
        isOpen: raw.isOpen !== false,
        hasSolved: raw.hasSolved === true,
        ...(item.category ? { category: item.category } : {}),
        description,
        isNeedInit: raw.isNeedInit === true,
        isNeedCheck: raw.isNeedCheck === true,
        ...(endpointType ? { endpointType } : {}),
        attachments,
        endpoints,
        raw,
    };
}
function detailsFromCompetitionChallenge(challenge) {
    const environmentRequired = challenge.environment.required;
    const environmentPending = environmentRequired && challenge.environment.status === "pending";
    const raw = {
        ...challenge.platform,
        name: challenge.name,
        category: challenge.category,
        description: challenge.description,
        hints: challenge.hints,
        scoring: challenge.scoring,
        flagFormat: challenge.flagFormat,
        environment: challenge.environment,
    };
    return {
        id: challenge.exerciseId,
        name: challenge.name,
        isOpen: challenge.isOpen,
        hasSolved: challenge.hasSolved,
        category: challenge.category,
        description: challenge.description,
        isNeedInit: environmentPending,
        isNeedCheck: environmentPending,
        endpointType: environmentRequired ? "tcp" : "none",
        attachments: challenge.attachments.map((attachment) => ({ name: attachment.name, url: attachment.url })),
        endpoints: challenge.environment.endpoints,
        raw,
    };
}
function worklistStatusForCompetition(status) {
    if (status === "solved")
        return "solved";
    if (status === "platform_closed")
        return "platform_closed";
    if (status === "environment_blocked")
        return "environment_blocked";
    if (status === "stopped")
        return "stopped";
    if (status === "blocked" || status === "failed")
        return "blocked";
    if (status === "preparing")
        return "preparing";
    if (status === "running" || status === "verifying")
        return status;
    if (status === "assigned")
        return "preparing";
    return "queued";
}
function json(value, limit = 80_000) {
    try {
        const output = JSON.stringify(value, null, 2);
        return output.length <= limit ? output : `${output.slice(0, limit)}\n...[truncated]`;
    }
    catch {
        return String(value);
    }
}
function redactForUi(value) {
    if (Array.isArray(value))
        return value.map(redactForUi);
    if (!isRecord(value))
        return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
        if (/(?:password|passwd|secret|token|accesskey|api[_-]?key|authorization|cookie)/iu.test(key)) {
            return [key, "[REDACTED]"];
        }
        return [key, redactForUi(child)];
    }));
}
function itemForUi(item) {
    return { ...item, metadata: redactForUi(item.metadata) };
}
function operatorGuidance(item) {
    if (!Array.isArray(item.metadata.operatorGuidance))
        return [];
    return item.metadata.operatorGuidance.flatMap((entry) => {
        if (typeof entry === "string" && entry.trim())
            return [entry.trim()];
        if (isRecord(entry) && typeof entry.message === "string" && entry.message.trim())
            return [entry.message.trim()];
        return [];
    });
}
function endpointText(details) {
    if (details.endpoints.length === 0)
        return "No remote environment was reported for this challenge.";
    return `Live environment details (use only for this challenge):\n${json(details.endpoints, 50_000)}`;
}
function attachmentText(details, workdir) {
    if (details.attachments.length === 0)
        return "No downloadable attachments were reported.";
    return details.attachments
        .map((attachment) => `- ${attachment.name}: ${join(workdir, safeName(attachment.name, "attachment"))}`)
        .join("\n");
}
export function buildSolverPrompt(details, workdir, coordinatorSessionId, guidance, envelope) {
    return [
        "You are an independent CTF solving agent in the SecHeur competition workflow.",
        "Work only on this challenge and keep all files under the assigned work directory.",
        "Inspect the supplied files and live endpoint carefully, use the relevant CTF skills and tools, and check your evidence before submitting to the platform.",
        "The Main Agent is a separate platform-coordination agent, not a parent subagent. Record useful discoveries through the competition protocol and in your final report.",
        coordinatorSessionId ? `Coordinator session: ${coordinatorSessionId}` : "",
        envelope ? `Competition task envelope:\n${json(envelope, 80_000)}` : "",
        `Challenge ID: ${String(details.id)}`,
        `Challenge name: ${details.name}`,
        `Category: ${details.category ?? "unknown"}`,
        `Description:\n${details.description || "(no description returned)"}`,
        `Assigned work directory: ${workdir}`,
        `Attachments:\n${attachmentText(details, workdir)}`,
        endpointText(details),
        guidance.length > 0 ? `Operator guidance:\n${guidance.map((entry) => `- ${entry}`).join("\n")}` : "",
        "Claim/report the task through competition_claim and competition_progress. Record reproducible evidence before producing a candidate.",
        "Before relying on external vulnerability intelligence, classify the target with osv_query: use constructed_ctf for task-specific code, services, binaries, or flag wrappers; use real_world_software for public software, including a CTF challenge that wraps a public release. For uncertain targets, osv_query asks the operator and remains pending until answered.",
        "Call osv_query only after recording exact package/version, versioned PURL, or full Git commit evidence. Its OSV result is advisory evidence, not proof of exploitability or a flag; validate locally before submitting through the broker.",
        "Use competition_submit_request to test every candidate. The main broker performs the real platform request, enforces format and attempt limits, and returns accepted/incorrect/blocking details.",
        "Do not submit a guess. Platform acceptance automatically ends this solver; do not call another tool after acceptance. An incorrect verdict is feedback, not completion: inspect feedback and remainingAttempts, revise using evidence and resubmit while canContinue is true. Do not use local verify_flag/check_flag as a competition judge. If blocked or out of attempts, report competition_blocked and omit FINAL_ANSWER.",
    ]
        .filter(Boolean)
        .join("\n\n");
}
export class WorklistOrchestrator {
    store;
    apiRef;
    config;
    env;
    workRoot;
    maxEnvironments;
    syncIntervalMs;
    maxFailures;
    maxFlagAttempts;
    competitionStore;
    competitionBroker;
    attachmentCache;
    ownsCompetitionStore;
    competitionServer;
    ownsCompetitionServer;
    competitionSocketPath;
    mode;
    excludedExerciseIds;
    onUpdate;
    active = new Map();
    itemControllers = new Map();
    activeRuntimes = new Map();
    manuallyStopped = new Set();
    activeAttachmentItems = new Set();
    coordinator;
    coordinatorSessionId;
    coordinatorTail = Promise.resolve();
    coordinatorReady;
    syncInFlight;
    loop;
    stopped = true;
    controller;
    constructor(options, store, apiRef, competitionStore, competitionBroker, ownsCompetitionStore, competitionServer, ownsCompetitionServer) {
        this.config = options.config;
        this.env = options.env ?? process.env;
        this.store = store;
        this.apiRef = apiRef;
        this.competitionStore = competitionStore;
        this.competitionBroker = competitionBroker;
        this.ownsCompetitionStore = ownsCompetitionStore;
        this.competitionServer = competitionServer;
        this.ownsCompetitionServer = ownsCompetitionServer;
        this.competitionSocketPath =
            options.competitionSocketPath ??
                this.env.SECHEUR_COMPETITION_SOCKET ??
                deriveCompetitionSocketPath(this.config.stateDir);
        this.mode = options.mode ?? "auto";
        this.attachmentCache = new AttachmentCache({
            store: competitionStore,
            cacheRoot: join(this.config.stateDir, "attachments"),
            fetchImpl: options.attachmentFetch,
            maxConcurrent: envNumber(this.env, "COMPETITION_ATTACHMENT_MAX_CONCURRENT", 3, 1),
            maxBytes: envNumber(this.env, "COMPETITION_ATTACHMENT_MAX_BYTES", ATTACHMENT_MAX_BYTES, 1),
            perHostIntervalMs: envNumber(this.env, "COMPETITION_ATTACHMENT_HOST_INTERVAL_MS", 250, 0),
        });
        this.workRoot = resolve(options.workRoot ?? this.env.WORKLIST_WORK_ROOT ?? join(this.config.projectRoot, "worklist"));
        this.maxEnvironments =
            options.maxEnvironments ?? envNumber(this.env, "WORKLIST_MAX_ENVIRONMENTS", DEFAULT_MAX_ENVIRONMENTS, 1);
        this.syncIntervalMs =
            options.syncIntervalMs ?? envNumber(this.env, "WORKLIST_SYNC_INTERVAL_MS", DEFAULT_SYNC_INTERVAL_MS, 5_000);
        this.maxFailures = envNumber(this.env, "WORKLIST_MAX_FAILURES", DEFAULT_MAX_FAILURES, 1);
        this.maxFlagAttempts = envNumber(this.env, "WORKLIST_MAX_FLAG_ATTEMPTS", DEFAULT_MAX_FLAG_ATTEMPTS, 1);
        this.excludedExerciseIds = envIdSet(this.env, "WORKLIST_EXCLUDE_EXERCISE_IDS");
        this.onUpdate = options.onUpdate;
        mkdirSync(this.workRoot, { recursive: true });
    }
    get api() {
        return this.apiRef.current;
    }
    static async open(options) {
        const env = options.env ?? process.env;
        const store = options.store ?? (await WorklistStore.open(join(options.config.stateDir, "worklist.sqlite")));
        const api = options.api ??
            new SlabAgentApi({
                env,
                competitionEnvFile: competitionEnvPath(options.config, env),
                recoverAfterSubmit: false,
            });
        const competitionStore = options.competitionBroker?.store ??
            options.competitionStore ??
            (await CompetitionStore.open(env.SECHEUR_COMPETITION_DATABASE?.trim() || join(options.config.stateDir, "competition.sqlite")));
        const maxEnvironmentSlots = options.maxEnvironments ?? envNumber(env, "WORKLIST_MAX_ENVIRONMENTS", DEFAULT_MAX_ENVIRONMENTS, 1);
        const initialConfig = competitionAdapterConfigFromEnvironment(env);
        const initialBuild = options.competitionBroker
            ? undefined
            : createCompetitionAdapter(initialConfig, {
                config: options.config,
                env,
                maxEnvironmentSlots,
                slabApi: api,
                reuseSlabApi: true,
            });
        const apiRef = { current: initialBuild?.attachmentApi ?? api };
        let currentConfig = initialBuild?.config ?? initialConfig;
        const reconfigureAdapter = async (patch) => {
            const nextConfig = resolveCompetitionAdapterConfig(patch, currentConfig, env);
            const nextBuild = createCompetitionAdapter(nextConfig, {
                config: options.config,
                env,
                maxEnvironmentSlots,
                slabApi: apiRef.current,
                reuseSlabApi: false,
            });
            currentConfig = nextBuild.config;
            apiRef.current = nextBuild.attachmentApi;
            return nextBuild;
        };
        const competitionBroker = options.competitionBroker ??
            CompetitionBroker.from({
                store: competitionStore,
                adapter: initialBuild?.adapter ??
                    (() => {
                        throw new Error("Competition adapter was not initialized");
                    })(),
                ...(initialBuild?.summary ? { adapterSummary: initialBuild.summary } : {}),
                reconfigureAdapter,
                maxEnvironmentSlots: options.maxEnvironments ?? envNumber(env, "WORKLIST_MAX_ENVIRONMENTS", DEFAULT_MAX_ENVIRONMENTS, 1),
                ownerId: `worklist:${process.pid}:${Math.random().toString(16).slice(2)}`,
            });
        const competitionSocketPath = options.competitionSocketPath ??
            env.SECHEUR_COMPETITION_SOCKET ??
            deriveCompetitionSocketPath(options.config.stateDir);
        const competitionServer = options.competitionServer ??
            new CompetitionBrokerServer({ broker: competitionBroker, socketPath: competitionSocketPath });
        return new WorklistOrchestrator(options, store, apiRef, competitionStore, competitionBroker, !options.competitionBroker && !options.competitionStore, competitionServer, !options.competitionServer);
    }
    get isRunning() {
        return !this.stopped;
    }
    get coordinatorId() {
        return this.coordinatorSessionId;
    }
    isConfigured() {
        return this.competitionBroker.adapter.platform !== "slab" || this.api.isConfigured();
    }
    async configureCompetition(patch) {
        return this.competitionBroker.configureAdapter(patch);
    }
    snapshot() {
        const competitionPlan = this.competitionBroker.getPlan();
        return {
            items: this.store.list().map(itemForUi),
            events: this.store.events(),
            activeEnvironmentCount: this.competitionStore.activeEnvironmentCount(),
            activeAttachmentCount: this.activeAttachmentItems.size,
            maxEnvironmentCount: this.maxEnvironments,
            maxFlagAttempts: this.maxFlagAttempts,
            maxFailures: this.maxFailures,
            ...(competitionPlan ? { competitionPlan } : {}),
            updatedAt: Date.now(),
        };
    }
    competitionTaskId(exerciseId) {
        return `${this.competitionBroker.adapter.platform}:${String(exerciseId)}`;
    }
    emit() {
        const snapshot = this.snapshot();
        this.onUpdate?.(snapshot);
        return snapshot;
    }
    async syncNow(signal) {
        if (this.syncInFlight)
            return this.syncInFlight;
        const operation = this.syncExercises(signal);
        this.syncInFlight = operation;
        try {
            return await operation;
        }
        finally {
            if (this.syncInFlight === operation)
                this.syncInFlight = undefined;
        }
    }
    async refresh(signal) {
        const snapshot = await this.syncNow(signal);
        if (this.mode === "auto")
            this.pump();
        return snapshot;
    }
    get competitionSocket() {
        return this.competitionSocketPath;
    }
    get isMainControlled() {
        return this.mode === "main";
    }
    competitionTaskIdForExercise(exerciseId) {
        return this.competitionTaskId(exerciseId);
    }
    findItemForCompetitionTask(taskId) {
        return this.store.list().find((item) => this.competitionTaskId(item.exerciseId) === taskId);
    }
    async prepareTaskForSolver(itemId, signal) {
        const item = this.store.get(itemId);
        if (!item)
            throw new Error(`Worklist item not found: ${itemId}`);
        const details = await this.prepareDetails(item, signal ?? this.controller?.signal ?? new AbortController().signal);
        return { item: this.store.get(itemId) ?? item, details };
    }
    async syncExercises(signal) {
        for (const existing of this.store.list()) {
            if (this.excludedExerciseIds.has(String(existing.exerciseId)) &&
                !new Set(["running", "preparing", "verifying"]).has(existing.status)) {
                this.store.remove(existing.id, `Excluded exercise removed from the worklist: ${String(existing.exerciseId)}`);
            }
        }
        if (!this.isConfigured()) {
            this.store.addEvent(undefined, "sync-skipped", "Competition platform credentials are not configured");
            return this.emit();
        }
        try {
            const syncResult = await this.competitionBroker.sync(signal);
            let tasks = this.competitionBroker
                .listTasks()
                .filter((task) => !this.excludedExerciseIds.has(String(task.challenge.exerciseId)));
            if (!this.competitionBroker.getPlan()) {
                const initialOrder = tasks
                    .filter((task) => task.status === "queued" || task.status === "environment_blocked")
                    .map((task) => task.taskId);
                if (initialOrder.length > 0) {
                    this.competitionBroker.setPlan({
                        taskIds: initialOrder,
                        rationale: "Initial platform priority order; the main coordinator may revise this plan.",
                        generatedBy: "worklist-default",
                    });
                    tasks = this.competitionBroker
                        .listTasks()
                        .filter((task) => !this.excludedExerciseIds.has(String(task.challenge.exerciseId)));
                }
            }
            for (const task of tasks) {
                const details = detailsFromCompetitionChallenge({
                    ...task.challenge,
                    isOpen: task.status !== "platform_closed",
                    hasSolved: task.status === "solved",
                });
                const workdir = join(this.workRoot, safeName(String(details.id), "exercise"));
                const item = this.store.upsertExercise(details, workdir, task.priority);
                const desiredStatus = worklistStatusForCompetition(task.status);
                if (item.status !== desiredStatus && !this.active.has(item.id))
                    this.store.setStatus(item.id, desiredStatus, task.lastError ?? `Competition task status: ${task.status}`);
                this.store.addEvent(item.id, "synced", `Challenge synchronized: ${details.name}`, {
                    name: details.name,
                    category: details.category ?? null,
                    requiresEnvironment: exerciseNeedsEnvironment(details),
                    competitionTaskId: task.taskId,
                    priority: task.priority,
                });
            }
            this.store.addEvent(undefined, "sync-complete", `Synchronized ${syncResult.snapshotted} of ${syncResult.listed} competition challenge(s)`, { failedDetails: syncResult.failedDetails, orderedTaskIds: tasks.map((task) => task.taskId) });
            if (this.coordinator)
                void this.notifyCoordinator(this.coordinatorPlanMessage());
            return this.emit();
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.store.addEvent(undefined, "sync-error", message);
            return this.emit();
        }
    }
    async start() {
        if (!this.stopped)
            return this.snapshot();
        this.stopped = false;
        this.controller = new AbortController();
        await this.competitionServer?.start();
        if (this.mode === "main")
            return this.snapshot();
        const snapshot = await this.syncNow(this.controller.signal);
        await this.ensureCoordinator();
        if (this.coordinator)
            await this.notifyCoordinator(this.coordinatorPlanMessage());
        this.pump();
        this.loop = setInterval(() => {
            void this.syncNow(this.controller?.signal).then(() => this.pump());
        }, this.syncIntervalMs);
        this.loop.unref();
        return snapshot;
    }
    async stop() {
        if (this.stopped)
            return;
        this.stopped = true;
        this.controller?.abort();
        if (this.loop)
            clearInterval(this.loop);
        this.loop = undefined;
        if (this.coordinator) {
            await this.coordinator.abort("Worklist stopped").catch(() => undefined);
            this.coordinator.dispose();
            this.coordinator = undefined;
        }
        await Promise.allSettled([...this.active.values()]);
        this.active.clear();
        this.itemControllers.clear();
        this.activeRuntimes.clear();
        this.manuallyStopped.clear();
        this.activeAttachmentItems.clear();
        this.emit();
    }
    async close() {
        await this.stop();
        if (this.ownsCompetitionServer)
            await this.competitionServer?.close();
        this.store.close();
        if (this.ownsCompetitionStore)
            this.competitionStore.close();
    }
    async retry(itemId) {
        const item = this.store.get(itemId);
        if (!item)
            throw new Error(`Worklist item not found: ${itemId}`);
        if (this.active.has(itemId))
            throw new Error(`Worklist item is running: ${itemId}`);
        this.store.setStatus(itemId, "queued", "Manually queued for retry");
        this.pump();
        return this.emit();
    }
    async guideItem(itemId, message) {
        const normalized = message.trim().slice(0, 8_000);
        if (!normalized)
            throw new Error("Operator guidance must not be empty");
        const item = this.store.get(itemId);
        if (!item)
            throw new Error(`Worklist item not found: ${itemId}`);
        if (item.status === "solved")
            throw new Error(`Worklist item is already solved: ${itemId}`);
        this.store.appendGuidance(itemId, normalized);
        const runtime = this.activeRuntimes.get(itemId);
        if (runtime) {
            await runtime.session
                .prompt(`[Operator guidance]\n${normalized}`, { streamingBehavior: "followUp", source: "extension" })
                .catch((error) => {
                this.store.addEvent(itemId, "operator-guidance-error", error instanceof Error ? error.message : String(error));
            });
            this.store.addEvent(itemId, "operator-guidance-delivered", "Operator guidance queued for the solver session");
        }
        else {
            this.store.addEvent(itemId, "operator-guidance-pending", "Operator guidance will be included in the next solver attempt");
        }
        if (item.status === "queued")
            this.pump();
        return this.emit();
    }
    async stopItem(itemId) {
        const item = this.store.get(itemId);
        if (!item)
            throw new Error(`Worklist item not found: ${itemId}`);
        if (item.status === "solved")
            throw new Error(`Worklist item is already solved: ${itemId}`);
        const controller = this.itemControllers.get(itemId);
        const runtime = this.activeRuntimes.get(itemId);
        if (controller || runtime) {
            this.manuallyStopped.add(itemId);
            controller?.abort();
            await runtime?.abort("Worklist item stopped").catch(() => undefined);
        }
        this.store.setStatus(itemId, "blocked", "Stopped by operator; environment retained for manual review");
        if (!controller && !runtime)
            this.manuallyStopped.delete(itemId);
        return this.emit();
    }
    async selectModel(runtime, spec) {
        const separator = spec.indexOf("/");
        if (separator <= 0)
            return;
        const model = runtime.session.modelRuntime.getModel(spec.slice(0, separator), spec.slice(separator + 1));
        if (model)
            await runtime.session.setModel(model);
        else
            this.store.addEvent(undefined, "model-warning", `Requested ${spec} but the model is not available in Pi`);
    }
    async ensureCoordinator() {
        if (this.coordinator || this.stopped || !this.isConfigured())
            return;
        if (this.coordinatorReady)
            return this.coordinatorReady;
        const operation = (async () => {
            const binding = new CompetitionCoordinatorBinding({
                socketPath: this.competitionSocketPath,
                clientId: `worklist:${this.config.projectRoot}`,
            });
            try {
                const runtime = await createSecHeurRuntime({
                    projectRoot: this.config.projectRoot,
                    cwd: this.config.projectRoot,
                    persist: true,
                    mode: "print",
                    thinkingLevel: "max",
                    env: this.env,
                    competitionCoordinator: binding,
                });
                runtime.session.setSessionName("Competition Coordinator");
                await this.selectModel(runtime, "router/auto");
                this.coordinator = runtime;
                this.coordinatorSessionId = runtime.session.sessionId;
                this.store.addEvent(undefined, "coordinator-started", "Competition Coordinator session started", {
                    sessionId: this.coordinatorSessionId,
                });
            }
            catch (error) {
                binding.close();
                this.store.addEvent(undefined, "coordinator-error", error instanceof Error ? error.message : String(error));
            }
        })();
        this.coordinatorReady = operation;
        try {
            await operation;
        }
        finally {
            if (this.coordinatorReady === operation)
                this.coordinatorReady = undefined;
        }
    }
    notifyCoordinator(message) {
        const operation = this.coordinatorTail.then(async () => {
            if (!this.coordinator || this.stopped)
                return;
            try {
                await this.coordinator.prompt(message);
            }
            catch (error) {
                this.store.addEvent(undefined, "coordinator-error", error instanceof Error ? error.message : String(error));
            }
        });
        this.coordinatorTail = operation.then(() => undefined, () => undefined);
        return operation;
    }
    coordinatorPlanMessage() {
        const tasks = this.competitionBroker.listTasks().map((task) => ({
            taskId: task.taskId,
            status: task.status,
            priority: task.priority,
            shortTask: task.shortTask,
            challenge: {
                exerciseId: task.challenge.exerciseId,
                name: task.challenge.name,
                category: task.challenge.category,
                description: task.challenge.description,
                hints: task.challenge.hints,
                attachments: task.challenge.attachments,
                environment: task.challenge.environment,
                flagFormat: task.challenge.flagFormat,
                scoring: task.challenge.scoring,
            },
            submission: task.submission,
        }));
        return `Platform snapshot and solve order (broker-owned):\n${json(tasks, 100_000)}\nActive persisted plan:\n${json(this.competitionBroker.getPlan() ?? null, 20_000)}\nUse competition_set_plan to revise the order when needed. Never withdraw an active solver lease only because a later score refresh changes priority.`;
    }
    pump() {
        if (this.stopped)
            return;
        const queued = this.store.list("queued");
        const plan = this.competitionBroker.getPlan();
        const planRanks = new Map(plan?.orderedTaskIds.map((taskId, rank) => [taskId, rank]) ?? []);
        const ordered = [...queued].sort((left, right) => {
            const leftRank = planRanks.get(this.competitionTaskId(left.exerciseId)) ?? Number.MAX_SAFE_INTEGER;
            const rightRank = planRanks.get(this.competitionTaskId(right.exerciseId)) ?? Number.MAX_SAFE_INTEGER;
            return leftRank - rightRank || right.priority - left.priority || left.updatedAt - right.updatedAt;
        });
        const selected = plan
            ? ordered.slice(0, 1)
            : [
                ...ordered.filter((item) => !item.requiresEnvironment),
                ...ordered
                    .filter((item) => item.requiresEnvironment)
                    .slice(0, Math.max(0, this.maxEnvironments - this.competitionStore.activeEnvironmentCount())),
            ];
        for (const item of selected) {
            if (this.active.has(item.id))
                continue;
            if (!item.requiresEnvironment)
                this.activeAttachmentItems.add(item.id);
            const itemController = new AbortController();
            const parentSignal = this.controller?.signal;
            const relayAbort = () => itemController.abort();
            parentSignal?.addEventListener("abort", relayAbort, { once: true });
            this.itemControllers.set(item.id, itemController);
            const operation = this.runItem(item, itemController.signal).finally(() => {
                parentSignal?.removeEventListener("abort", relayAbort);
                if (this.itemControllers.get(item.id) === itemController)
                    this.itemControllers.delete(item.id);
                this.active.delete(item.id);
                this.activeAttachmentItems.delete(item.id);
                this.emit();
                this.pump();
            });
            this.active.set(item.id, operation);
        }
        if (selected.length > 0)
            this.emit();
    }
    async downloadAttachments(details, workdir, signal) {
        mkdirSync(workdir, { recursive: true });
        for (const attachment of details.attachments) {
            const target = join(workdir, safeName(basename(attachment.name), "attachment"));
            if (existsSync(target))
                continue;
            const cached = await this.attachmentCache.download({ name: attachment.name, url: attachment.url }, signal);
            copyFileSync(cached.path, target);
        }
    }
    async prepareDetails(item, signal) {
        let details;
        try {
            details = detailsFromCompetitionChallenge(await this.competitionBroker.adapter.getChallenge(item.exerciseId, signal));
        }
        catch (error) {
            const cached = cachedDetails(item);
            const hasLocalAttachment = cached?.attachments.some((attachment) => existsSync(join(item.workdir, safeName(basename(attachment.name), "attachment"))));
            if (!cached || !hasLocalAttachment || exerciseNeedsEnvironment(cached))
                throw error;
            details = cached;
            this.store.addEvent(item.id, "cache-fallback", "Competition detail API unavailable; using cached local attachment metadata");
        }
        await this.downloadAttachments(details, item.workdir, signal);
        return details;
    }
    async runPersistentRuntime(item, details, signal) {
        const taskId = this.competitionTaskId(details.id);
        const solverId = `worklist:${String(details.id)}:${randomUUID()}`;
        const binding = new CompetitionSolverBinding({
            socketPath: this.competitionSocketPath,
            taskId,
            solverId,
        });
        let runtime;
        let envelope;
        let abort;
        try {
            envelope = await binding.claim();
            this.store.addEvent(item.id, "competition-claimed", "Independent solver claimed the competition envelope", {
                taskId,
                solverId,
                assignmentId: envelope.assignmentId,
                environment: envelope.challenge.environment,
            });
            runtime = await createSecHeurRuntime({
                projectRoot: this.config.projectRoot,
                cwd: item.workdir,
                persist: true,
                mode: "print",
                thinkingLevel: "max",
                env: this.env,
                competition: binding,
            });
            runtime.session.setSessionName(`Worklist ${String(details.id)} - ${details.name}`);
            await this.selectModel(runtime, "router/auto");
            this.store.attachSession(item.id, runtime.session.sessionId, this.coordinatorSessionId);
            this.activeRuntimes.set(item.id, runtime);
            this.store.addEvent(item.id, "solver-started", "Independent solver Pi session started", {
                sessionId: runtime.session.sessionId,
                cwd: item.workdir,
                coordinatorSessionId: this.coordinatorSessionId ?? null,
                solverId,
                assignmentId: envelope.assignmentId,
            });
            abort = () => void runtime?.abort("Worklist item cancelled");
            signal.addEventListener("abort", abort, { once: true });
            const task = buildSolverPrompt(details, item.workdir, this.coordinatorSessionId, operatorGuidance(item), envelope);
            await runtime.prompt(this.env.WORKLIST_ULTRACODE === "1"
                ? `${task}\n\nUse /ultracode once for the implementation phase, then independently validate the winner.`
                : task);
            const finalText = finalAssistantText(runtime.session.messages);
            const submissions = this.competitionStore.listSubmissions(taskId, 1);
            if (submissions.length === 0) {
                const candidate = finalText.match(/<FINAL_ANSWER>\s*(.*?)\s*<\/FINAL_ANSWER>/is)?.[1]?.trim();
                if (candidate) {
                    const evidenceId = `compat-${randomUUID()}`;
                    await binding.sendEvent("evidence", {
                        evidenceId,
                        kind: "observation",
                        summary: finalText.slice(-8_000),
                        source: runtime.session.sessionFile ?? runtime.session.sessionId,
                        refs: [runtime.session.sessionFile ?? runtime.session.sessionId],
                        confidence: 0.2,
                    });
                    await binding.sendEvent("submit_request", {
                        candidate,
                        evidenceRefs: [evidenceId],
                        confidence: 0.2,
                        rationale: "Compatibility fallback from the independent solver final report",
                    });
                }
            }
            return {
                sessionId: runtime.session.sessionId,
                ...(runtime.session.sessionFile ? { sessionFile: runtime.session.sessionFile } : {}),
                finalText,
                taskId,
                solverId,
                envelope,
            };
        }
        catch (error) {
            if (envelope) {
                await binding
                    .sendEvent("blocked", {
                    category: "solver",
                    reason: error instanceof Error ? error.message : String(error),
                })
                    .catch(() => undefined);
            }
            const activeTask = this.competitionBroker.getTask(taskId);
            if (activeTask?.solverId === solverId) {
                this.competitionBroker.releaseTask(taskId, solverId, envelope ? "blocked" : "queued");
            }
            throw error;
        }
        finally {
            if (runtime) {
                if (this.activeRuntimes.get(item.id) === runtime)
                    this.activeRuntimes.delete(item.id);
                runtime.dispose();
            }
            if (abort)
                signal.removeEventListener("abort", abort);
            binding.close();
        }
    }
    async saveSolvedMetadata(details, normalizedFlag, submittedFlag, answer, flagFormat) {
        const directory = join(this.config.projectRoot, "writeups");
        mkdirSync(directory, { recursive: true });
        const path = join(directory, `${String(details.id)}-${safeName(details.name, "exercise")}.meta.json`);
        const displayFlag = flagFormat ? `${flagFormat.prefix}${normalizedFlag}${flagFormat.suffix}` : normalizedFlag;
        writeFileSync(path, `${JSON.stringify({
            exerciseId: details.id,
            name: details.name,
            flag: displayFlag,
            normalizedFlag,
            submittedFlag,
            ...(flagFormat ? { flagFormat } : {}),
            submittedAt: new Date().toISOString(),
            answerResponse: answer,
        }, null, 2)}\n`, { mode: 0o600 });
    }
    async runItem(item, signal) {
        let details;
        try {
            this.store.setStatus(item.id, "preparing", "Preparing challenge files and environment");
            details = await this.prepareDetails(item, signal);
            this.store.setStatus(item.id, "running", "Solver Pi agent is working", {
                challengeId: details.id,
                attachments: details.attachments.length,
                endpoints: details.endpoints.length,
            });
            await this.ensureCoordinator();
            const result = await this.runPersistentRuntime(item, details, signal);
            if (this.manuallyStopped.delete(item.id)) {
                this.store.setStatus(item.id, "blocked", "Stopped by operator; environment retained for manual review");
                return;
            }
            this.store.setStatus(item.id, "verifying", "Inspecting solver evidence");
            const competitionTask = this.competitionBroker.getTask(result.taskId);
            const submissions = this.competitionStore.listSubmissions(result.taskId, 20);
            const accepted = submissions.find((submission) => submission.category === "accepted" && submission.isCorrect === true);
            if (accepted) {
                const submittedFlag = accepted.requestPayload && typeof accepted.requestPayload.flag === "string"
                    ? accepted.requestPayload.flag
                    : "";
                const normalizedFlag = normalizeCompetitionFlag(submittedFlag);
                const flagFormat = competitionTask?.submission.flagFormat;
                await this.saveSolvedMetadata(details, normalizedFlag, submittedFlag, accepted.response ?? {}, flagFormat);
                this.store.recordAttempt(item.id, normalizedFlag);
                const displayFlag = flagFormat
                    ? `${flagFormat.prefix}${normalizedFlag}${flagFormat.suffix}`
                    : normalizedFlag;
                this.store.setStatus(item.id, "solved", "Platform accepted the solver submission", {
                    flag: displayFlag,
                    submittedFlag,
                    sessionId: result.sessionId,
                    solverId: result.solverId,
                });
                void this.notifyCoordinator(`Challenge ${String(details.id)} is solved. The independent solver submission was accepted by the platform.`);
                return;
            }
            const audit = this.competitionStore.getAuditVerdict(result.taskId);
            const latest = submissions[0];
            const attempted = this.store.get(item.id);
            const category = typeof latest?.category === "string"
                ? latest.category
                : audit?.verdict === "environment_blocked"
                    ? "environment_error"
                    : "request_error";
            if (category === "platform_closed") {
                this.store.setStatus(item.id, "platform_closed", "Competition platform is closed or no longer authorizes this task");
            }
            else if (category === "rate_limited" || category === "environment_error") {
                this.store.setStatus(item.id, "environment_blocked", `Platform temporarily blocked the task: ${category}`);
            }
            else if (audit?.paused === true || category === "format_mismatch") {
                this.store.setStatus(item.id, "blocked", audit?.reason ?? `Competition submission blocked: ${category}`);
            }
            else if ((attempted?.attempts ?? 0) >= this.maxFlagAttempts) {
                this.store.setStatus(item.id, "blocked", "Flag broker rejected the maximum number of attempts");
            }
            else {
                this.store.setStatus(item.id, "queued", "Solver ended without an accepted submission; retrying through the broker");
            }
            this.competitionBroker.releaseTask(result.taskId, result.solverId, this.store.get(item.id)?.status === "queued" ? "queued" : "blocked");
            void this.notifyCoordinator(`Challenge ${String(details.id)} ended with competition result ${category}. Structured solver evidence remains in the broker.`);
        }
        catch (error) {
            if (this.manuallyStopped.delete(item.id)) {
                this.store.setStatus(item.id, "blocked", "Stopped by operator; environment retained for manual review");
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            const failed = this.store.recordFailure(item.id, message);
            if ((failed?.failures ?? this.maxFailures) >= this.maxFailures) {
                const errorStatus = error instanceof CompetitionPlatformError && error.category === "platform_closed"
                    ? "platform_closed"
                    : error instanceof CompetitionPlatformError &&
                        (error.category === "environment_error" || error.category === "rate_limited")
                        ? "environment_blocked"
                        : "blocked";
                this.store.setStatus(item.id, errorStatus, message);
            }
            else {
                this.store.setStatus(item.id, "queued", `Retrying after solver/API failure: ${message}`);
            }
            await this.notifyCoordinator(`Challenge ${item.id} failed: ${message}`);
        }
    }
    publicSummary() {
        const snapshot = this.snapshot();
        return {
            ok: true,
            running: this.isRunning,
            configured: this.isConfigured(),
            competitionEnv: competitionEnvPath(this.config, this.env),
            coordinatorSessionId: this.coordinatorSessionId ?? null,
            ...snapshot,
        };
    }
}
export async function openWorklistOrchestrator(options) {
    return WorklistOrchestrator.open(options);
}
//# sourceMappingURL=worklist.js.map