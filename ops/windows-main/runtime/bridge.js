import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { URL } from "node:url";
import { PiClient } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { ModelRuntime, ProjectTrustStore, SessionManager, } from "@earendil-works/pi-coding-agent";
import { buildSessionBlackboardGraph } from "./blackboard.js";
import { CompetitionBroker } from "./competition-broker.js";
import { CompetitionBrokerClient, CompetitionBrokerServer } from "./competition-protocol-service.js";
import { competitionAdapterConfigFromEnvironment, createCompetitionAdapter, resolveCompetitionAdapterConfig, } from "./competition-runtime.js";
import { CompetitionCoordinatorBinding } from "./competition-solver.js";
import { loadSecHeurConfig } from "./config.js";
import { buildDesktopRegistry, clearRegistryState, deleteApiConfig, deleteMcpServer, deleteProjectAgent, deleteProjectSkill, readApiConfig, readBridgeState, readDesktopConfig, resolveApiProfile, saveApiConfig, saveMcpServer, saveProjectAgent, saveProjectSkill, writeBridgeState, writeDesktopConfig, writeRegistryState, } from "./desktop-config.js";
import { flagOracleAttempts, flagOracleSummary } from "./flag-oracle.js";
import { ABORT_GRACE_MS, boundedAbort } from "./operational-guard.js";
import { installPiPlugin, listDesktopUiPlugins, listPiPlugins, removePiPlugin, resolveDesktopUiPluginAsset, setPiPluginEnabled, updatePiPlugin, } from "./pi-plugins.js";
import { cairnRunDirectory } from "./planning/cairn/engine.js";
import { CairnHostEvidence } from "./planning/cairn/host-evidence.js";
import { sanitizeCairnTracePayload } from "./planning/cairn/trace.js";
import { isPlanningFailureError } from "./planning/failures.js";
import { PlanningStore } from "./planning/store.js";
import { listUnifiedPluginCatalog, setBuiltinPlanningEnabled } from "./plugin-catalog.js";
import { normalizePromptPayload } from "./prompt-payload.js";
import { createSecHeurRuntime } from "./runtime.js";
import { LegacySchedulerBackend, SchedulerPoller } from "./scheduler.js";
import { competitionSocketPath as deriveCompetitionSocketPath, listSessionRegistrations, sessionSocketPath, } from "./session-registry.js";
import { acceptedNativeFlagVerification } from "./verifier-contract.js";
import { openWorklistOrchestrator } from "./worklist.js";
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_WS_FRAME_BYTES = 1024 * 1024;
const MAX_RUNTIME_EVENTS = 500;
const MAX_RUNTIME_TRACE_TEXT = 24 * 1024;
const MAX_RUNTIME_TRACE_DEPTH = 6;
const MAX_BRIDGE_EVENT_HISTORY = 1_000;
const MAX_SSE_QUEUE_EVENTS = 256;
const SSE_HEARTBEAT_MS = 15_000;
const MAX_WS_QUEUE_EVENTS = 256;
const WS_HEARTBEAT_MS = 15_000;
const SESSION_EVENT_FLUSH_MS = 50;
const TIMED_OUT_RUNTIME_ABORT_GRACE_MS = 1_000;
const MANAGED_SESSION_CONNECT_TIMEOUT_MS = 2_000;
const MAX_MODEL_CONTINUATIONS = 1;
const SENSITIVE_TRACE_KEY = /(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|credential|cookie)/iu;
const OMITTED_RUNTIME_EVENTS = new Set(["message_update", "tool_execution_update", "bash_execution_update"]);
const STATIC_MIME_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".webp": "image/webp",
};
const VALID_PERMISSION_MODES = new Set([
    "default",
    "acceptEdits",
    "dontAsk",
    "bypassPermissions",
    "plan",
]);
const VALID_PERMISSION_DECISIONS = new Set(["allow_once", "allow_session", "deny", "answer"]);
const PLANNING_ENGINES = ["progressive", "cairn", "hypothesis"];
function isPlanningEngine(value) {
    return value === "progressive" || value === "cairn" || value === "hypothesis";
}
class BridgePromptTimeoutError extends Error {
    kind;
    timeoutMs;
    constructor(kind, timeoutMs) {
        super(kind === "first-output"
            ? "model first output timed out"
            : kind === "tool-stalled"
                ? "tool execution became idle"
                : "model output became idle");
        this.name = "BridgePromptTimeoutError";
        this.kind = kind;
        this.timeoutMs = timeoutMs;
    }
}
class BridgeHttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.name = "BridgeHttpError";
        this.status = status;
    }
}
function managedWorklistStatus(value) {
    const status = typeof value === "string" ? value : "queued";
    if (status === "assigned" || status === "preparing")
        return "preparing";
    if (status === "running" || status === "verifying" || status === "solved" || status === "queued")
        return status;
    if (status === "failed" || status === "blocked" || status === "environment_blocked")
        return "blocked";
    return status === "platform_closed" || status === "stopped" ? "blocked" : "queued";
}
function managedKnowledgeBaseEnabled(registration, fallback) {
    return typeof registration.knowledgeBaseEnabled === "boolean" ? registration.knowledgeBaseEnabled : fallback;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function verifierFailureCode(category) {
    const knownCategories = new Set([
        "quota_exhausted",
        "timeout",
        "transport_error",
        "protocol_error",
        "invalid_request",
        "identity_conflict",
        "identity_missing",
        "aborted",
    ]);
    return knownCategories.has(category) ? `verifier_${category}` : "verifier_unavailable";
}
const PLANNING_ASSOCIATED_CUSTOM_TYPES = new Set([
    "hypothesis-planning-result",
    "hypothesis-planning-goal",
    "hypothesis-planning-failure",
    "cairn-planning-result",
    "cairn-planning-goal",
    "cairn-planning-failure",
    "progressive-planning-goal",
    "progressive-planning-result",
    "progressive-planning-failure",
]);
const PLANNING_TRACE_EVENT_FIELDS = {
    run_created: ["mode"],
    execution_mode_selected: ["mode", "planningEnabled", "capacity", "legacyPlanningMode"],
    supervisor_propose_start: ["revision", "elapsedMs"],
    supervisor_attempt_start: [
        "attempt",
        "attemptType",
        "originalOutputChars",
        "correctionInputChars",
        "truncated",
        "elapsedMs",
    ],
    supervisor_attempt_end: ["attempt", "attemptType", "outputChars", "stopReason", "elapsedMs"],
    proposal_generation_start: ["attempt", "attemptType", "elapsedMs"],
    proposal_generation_end: ["attempt", "attemptType", "outputChars", "stopReason", "isError", "elapsedMs"],
    supervisor_parse_start: ["attempt", "attemptType", "outputChars", "stopReason", "elapsedMs"],
    supervisor_parse_end: [
        "attempt",
        "attemptType",
        "outputChars",
        "stopReason",
        "parseSucceeded",
        "validationSucceeded",
        "failureCode",
        "elapsedMs",
    ],
    supervisor_task_identity_validation_failed: [
        "attempt",
        "attemptType",
        "parseSucceeded",
        "validationSucceeded",
        "failureCode",
        "elapsedMs",
    ],
    supervisor_dependency_validation_failed: [
        "attempt",
        "attemptType",
        "parseSucceeded",
        "validationSucceeded",
        "failureCode",
        "elapsedMs",
    ],
    supervisor_propose_end: [
        "decision",
        "taskCount",
        "attempt",
        "attemptType",
        "outputChars",
        "stopReason",
        "parseSucceeded",
        "validationSucceeded",
        "elapsedMs",
    ],
    supervisor_propose_error: ["failureStage", "failureCode", "elapsedMs"],
    plan_committed: ["revision", "taskIds", "taskInputEvidenceRefs"],
    task_leased: ["taskId", "leaseId", "expiresAt", "attemptNumber"],
    task_started: ["taskId", "leaseId"],
    lease_expired: ["taskId", "leaseId"],
    lease_recovered: ["taskId", "leaseId"],
    lease_cancelled: ["taskId", "leaseId"],
    evidence_saved: ["taskId", "leaseId", "evidenceId", "evidenceCount", "inserted"],
    planning_checkpoint_saved: [
        "taskId",
        "leaseId",
        "checkpointId",
        "checkpointSequence",
        "evidenceCount",
        "artifactCount",
        "source",
        "elapsedMs",
    ],
    planning_observer_report_saved: [
        "taskId",
        "leaseId",
        "evidenceId",
        "source",
        "semanticReportGenerated",
        "evidenceRefs",
    ],
    planning_checkpoint_rejected: [
        "revision",
        "taskId",
        "leaseId",
        "checkpointId",
        "failureCode",
        "diagnosticLayer",
        "diagnosticReason",
        "fieldName",
        "scopeDecision",
        "evidenceRefs",
        "artifactReferenceHashes",
    ],
    planning_evidence_read: [
        "revision",
        "requestId",
        "evidenceId",
        "taskId",
        "leaseId",
        "sourceRunId",
        "sourceTaskId",
        "sourceLeaseId",
        "offset",
        "nextOffset",
        "totalBytes",
        "requestedMaxBytes",
        "returnedBytes",
        "contentHash",
        "resultHash",
        "hasMore",
        "readState",
        "failureCategory",
        "scopeDecision",
    ],
    planning_context_rendered: [
        "revision",
        "contextRole",
        "taskId",
        "leaseId",
        "contextBytes",
        "contextLimitBytes",
        "identityBlockBytes",
        "failureBlockBytes",
        "evidenceBlockBytes",
        "progressBlockBytes",
        "supplementalBlockBytes",
        "evidenceRefsCandidateCount",
        "evidenceRefsPresentedCount",
        "evidenceRefsPresented",
        "evidenceRefsSummaryPresentedCount",
        "evidenceRefsSummaryPresented",
        "evidenceRefsReferenceOnlyCount",
        "evidenceRefsReferenceOnly",
        "evidenceRefsOmitted",
        "evidenceRefsOmittedCount",
        "checkpointRefsCandidateCount",
        "checkpointRefsPresentedCount",
        "checkpointRefsPresented",
        "checkpointRefsOmitted",
        "checkpointRefsOmittedCount",
        "referenceListsTruncated",
    ],
    attempt_sealed: [
        "taskId",
        "leaseId",
        "attemptNumber",
        "failureSource",
        "failureStage",
        "failureCode",
        "evidenceCount",
        "checkpointId",
        "resultSource",
    ],
    attempt_routing_decided: [
        "taskId",
        "leaseId",
        "attemptNumber",
        "routingState",
        "replanAllowed",
        "replanStarted",
        "replanReason",
    ],
    executor_start: ["revision", "taskId", "leaseId", "elapsedMs"],
    extension_bundle_create_start: ["provided", "elapsedMs"],
    extension_bundle_create_end: ["created", "elapsedMs"],
    executor_tool_execution_start: ["toolCallId", "toolName", "elapsedMs"],
    executor_tool_execution_end: ["toolCallId", "toolName", "isError", "toolElapsedMs", "elapsedMs"],
    planning_commit_observed: ["toolCallId", "isError", "commitAccepted", "elapsedMs"],
    executor_end: ["elapsedMs"],
    executor_error: [
        "executorPhase",
        "failureSource",
        "failureStage",
        "failureCode",
        "secondaryFailureCodes",
        "timeoutObserved",
        "elapsedMs",
    ],
    executor_failure_progress: ["completedToolEvidenceCount", "inFlightToolCount", "inFlightToolNames"],
    planning_observer_started: ["triggerMs", "newEvidenceCount", "persistedToolEvidenceCount", "elapsedMs"],
    planning_observer_deferred: ["triggerMs", "reason", "elapsedMs"],
    planning_observer_skipped: ["triggerMs", "reason", "persistedToolEvidenceCount", "elapsedMs"],
    planning_observer_completed: [
        "triggerMs",
        "semanticReportGenerated",
        "evidenceRefCount",
        "invalidEvidenceReferenceCount",
        "elapsedMs",
    ],
    planning_observer_error: ["triggerMs", "failureCode", "invalidEvidenceReferenceCount", "error", "elapsedMs"],
    planning_observer_cancelled: ["triggerMs", "reason", "elapsedMs"],
    planning_observer_guidance_sent: ["triggerMs", "reminderNumber", "evidenceRefs", "elapsedMs"],
    planning_observer_guidance_skipped: ["triggerMs", "reason", "elapsedMs"],
    task_committed: ["taskId", "leaseId", "outcome", "resultSource", "frameRevision", "commitAccepted"],
    frame_updated: ["taskId", "frameRevision"],
    run_completed: [],
    run_blocked: [],
    run_paused: [],
    run_failed: [],
    run_cancelled: [],
    planning_failure: ["failureSource", "failureStage", "failureCode", "elapsedMs"],
    planning_presentation_start: ["runStatus", "flagCandidateCount", "verifyFlagAvailable", "elapsedMs"],
    verification_candidate_available: ["flagCandidateCount", "verifyFlagAvailable", "elapsedMs"],
    verification_tool_available: ["flagCandidateCount", "verifyFlagAvailable", "elapsedMs"],
    planning_presentation_tools: ["flagCandidateCount", "verifyFlagAvailable", "elapsedMs"],
    planning_presentation_triggered: ["flagCandidateCount", "verifyFlagAvailable", "elapsedMs"],
    planning_presentation_end: ["flagCandidateCount", "verifyFlagAvailable", "elapsedMs"],
    planning_presentation_error: ["failureCode", "acceptedByHost"],
    verification_attempted: ["toolName", "flagCandidateCount", "verifyFlagAvailable", "elapsedMs"],
    planning_terminal_evidence_observed: [
        "taskId",
        "leaseId",
        "evidenceId",
        "evidenceRefs",
        "verificationOutcome",
        "elapsedMs",
    ],
};
const PLANNING_TRACE_STRING_FIELDS = new Set([
    "attemptType",
    "decision",
    "executorPhase",
    "failureSource",
    "failureStage",
    "failureCode",
    "legacyPlanningMode",
    "mode",
    "outcome",
    "runStatus",
    "stopReason",
    "toolName",
    "toolCallId",
    "verificationOutcome",
    "evidenceId",
    "checkpointId",
    "resultSource",
    "source",
    "routingState",
    "replanReason",
    "diagnosticLayer",
    "diagnosticReason",
    "fieldName",
    "scopeDecision",
    "requestId",
    "sourceRunId",
    "sourceTaskId",
    "sourceLeaseId",
    "contentHash",
    "resultHash",
    "readState",
    "failureCategory",
    "contextRole",
    "taskId",
    "leaseId",
]);
const PLANNING_TRACE_STRING_OR_NUMBER_FIELDS = new Set(["attempt"]);
const PLANNING_TRACE_NUMBER_FIELDS = new Set([
    "revision",
    "elapsedMs",
    "originalOutputChars",
    "correctionInputChars",
    "outputChars",
    "taskCount",
    "capacity",
    "taskIdCount",
    "expiresAt",
    "toolElapsedMs",
    "frameRevision",
    "flagCandidateCount",
    "attemptNumber",
    "evidenceCount",
    "artifactCount",
    "checkpointSequence",
    "offset",
    "nextOffset",
    "totalBytes",
    "requestedMaxBytes",
    "returnedBytes",
    "contextBytes",
    "contextLimitBytes",
    "identityBlockBytes",
    "failureBlockBytes",
    "evidenceBlockBytes",
    "progressBlockBytes",
    "supplementalBlockBytes",
    "evidenceRefsCandidateCount",
    "evidenceRefsPresentedCount",
    "evidenceRefsSummaryPresentedCount",
    "evidenceRefsReferenceOnlyCount",
    "evidenceRefsOmittedCount",
    "checkpointRefsCandidateCount",
    "checkpointRefsPresentedCount",
    "checkpointRefsOmittedCount",
    "completedToolEvidenceCount",
    "inFlightToolCount",
]);
const PLANNING_TRACE_BOOLEAN_FIELDS = new Set([
    "planningEnabled",
    "truncated",
    "parseSucceeded",
    "validationSucceeded",
    "isError",
    "commitAccepted",
    "provided",
    "created",
    "verifyFlagAvailable",
    "inserted",
    "timeoutObserved",
    "replanAllowed",
    "replanStarted",
    "hasMore",
    "referenceListsTruncated",
    "acceptedByHost",
]);
const PLANNING_TRACE_ARRAY_FIELDS = new Set([
    "taskIds",
    "taskInputEvidenceRefs",
    "evidenceRefs",
    "artifactReferenceHashes",
    "evidenceRefsPresented",
    "evidenceRefsSummaryPresented",
    "evidenceRefsReferenceOnly",
    "evidenceRefsOmitted",
    "checkpointRefsPresented",
    "checkpointRefsOmitted",
    "inFlightToolNames",
    "secondaryFailureCodes",
]);
function planningRunIdFromMessage(message) {
    if (!isRecord(message) ||
        message.role !== "custom" ||
        !PLANNING_ASSOCIATED_CUSTOM_TYPES.has(String(message.customType))) {
        return undefined;
    }
    const details = isRecord(message.details) ? message.details : undefined;
    const runId = details?.runId;
    return typeof runId === "string" && /^planning_[A-Za-z0-9_.:-]{1,128}$/u.test(runId) ? runId : undefined;
}
function planningFailureMessage(message) {
    if (!isRecord(message) ||
        message.role !== "custom" ||
        !["progressive-planning-failure", "cairn-planning-failure", "hypothesis-planning-failure"].includes(String(message.customType))) {
        return undefined;
    }
    const details = isRecord(message.details) ? message.details : undefined;
    if (!details ||
        details.failureSource !== "planning" ||
        typeof details.failureStage !== "string" ||
        !details.failureStage ||
        typeof details.failureCode !== "string" ||
        !details.failureCode) {
        return undefined;
    }
    return {
        failureSource: "planning",
        failureStage: details.failureStage,
        failureCode: details.failureCode,
        ...(typeof details.runId === "string" ? { runId: details.runId } : {}),
    };
}
function jsonText(value) {
    try {
        return JSON.stringify(value);
    }
    catch {
        return JSON.stringify({ error: String(value) });
    }
}
function lifecycleText(value) {
    return typeof value === "string" ? value.trim().slice(0, 240) : "";
}
function contentText(value) {
    if (typeof value === "string")
        return value;
    if (!Array.isArray(value))
        return value === undefined ? "" : jsonText(value);
    return value
        .flatMap((part) => {
        if (isRecord(part) && part.type === "text" && typeof part.text === "string")
            return [part.text];
        return [];
    })
        .join("\n");
}
function extractThinking(value) {
    if (!Array.isArray(value))
        return { text: "", redacted: false };
    let redacted = false;
    const chunks = [];
    for (const part of value) {
        if (!isRecord(part) || part.type !== "thinking")
            continue;
        if (part.redacted === true)
            redacted = true;
        if (typeof part.thinking === "string")
            chunks.push(part.thinking);
    }
    return { text: chunks.join("\n"), redacted };
}
function safeThinkingFields(value) {
    const extracted = extractThinking(value);
    const fields = {};
    if (extracted.text)
        fields.thinking = runtimeTraceText(extracted.text);
    if (extracted.redacted)
        fields.thinkingRedacted = true;
    return fields;
}
function withTimeout(operation, timeoutMs, message) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        void operation.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
function isSocketPath(path) {
    try {
        return lstatSync(path).isSocket();
    }
    catch {
        return false;
    }
}
/**
 * 注册通常指向与 bridge 相同的状态目录。主机和容器分离运行时，注册文件也可能记录主机可见的绝对路径；
 * 只有该路径确实是当前会话的 socket 且正在监听时才使用它，并保留挂载状态目录下的派生路径作为 fallback。
 */
function managedSocketCandidates(registration, stateDir) {
    const derivedPath = sessionSocketPath(stateDir, registration.sessionId);
    const registeredPath = registration.socketPath.trim();
    const candidates = [];
    if (isAbsolute(registeredPath) &&
        basename(registeredPath) === basename(derivedPath) &&
        isSocketPath(registeredPath)) {
        candidates.push(registeredPath);
    }
    if (!candidates.includes(derivedPath))
        candidates.push(derivedPath);
    return candidates;
}
function isOfflineSelfTestArtifact(info) {
    const normalizedMessages = info.allMessagesText.replace(/\s+/gu, " ").trim();
    return (info.messageCount === 2 &&
        info.firstMessage.trim() === "self-test prompt" &&
        normalizedMessages === "self-test prompt self-test reply");
}
function orderedBridgeSessions(sessions) {
    return [...sessions].sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id));
}
function redactTraceText(value) {
    return value
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
        .replace(/(["']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|credential|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/giu, '$1"[REDACTED]"');
}
function sanitizeTraceValue(value, depth = 0, seen = new WeakSet()) {
    if (typeof value === "string")
        return redactTraceText(value);
    if (value === null || typeof value === "number" || typeof value === "boolean")
        return value;
    if (value === undefined)
        return null;
    if (typeof value !== "object")
        return redactTraceText(String(value));
    if (depth >= MAX_RUNTIME_TRACE_DEPTH)
        return "[Truncated]";
    if (seen.has(value))
        return "[Circular]";
    seen.add(value);
    let sanitized;
    if (Array.isArray(value)) {
        sanitized = value.map((item) => sanitizeTraceValue(item, depth + 1, seen));
    }
    else {
        sanitized = Object.fromEntries(Object.entries(value).map(([key, item]) => [
            key,
            SENSITIVE_TRACE_KEY.test(key) ? "[REDACTED]" : sanitizeTraceValue(item, depth + 1, seen),
        ]));
    }
    seen.delete(value);
    return sanitized;
}
function runtimeTraceText(value) {
    const sanitized = sanitizeTraceValue(value);
    const text = typeof sanitized === "string" ? sanitized : jsonText(sanitized);
    if (text.length <= MAX_RUNTIME_TRACE_TEXT)
        return text;
    return `${text.slice(0, MAX_RUNTIME_TRACE_TEXT)}\n[truncated]`;
}
export function sanitizePlanningTracePayload(type, payload) {
    const fields = PLANNING_TRACE_EVENT_FIELDS[type] ?? [];
    const sanitized = {};
    // Native host-role diagnostics are metadata, independent of older event-name allowlists.
    for (const key of [
        "runId",
        "requestId",
        "role",
        "provider",
        "model",
        "reason",
        "stopReason",
        "toolCallId",
        "toolName",
        "origin",
        "status",
        "failureCode",
        "errorStage",
        "errorCategory",
        "transportCode",
    ])
        if (typeof payload[key] === "string" && payload[key].length <= 160)
            sanitized[key] = payload[key];
    for (const key of [
        "inputTokens",
        "outputTokens",
        "contextWindow",
        "outputChars",
        "cost",
        "modelTurns",
        "allowance",
        "elapsedMs",
        "reviewTurns",
        "startedAt",
        "endedAt",
        "offset",
        "nextOffset",
        "returnedBytes",
        "totalBytes",
    ])
        if (typeof payload[key] === "number" && Number.isFinite(payload[key]))
            sanitized[key] = payload[key];
    for (const key of ["isError", "cacheHit", "requestSent", "modelCalled"])
        if (typeof payload[key] === "boolean")
            sanitized[key] = payload[key];
    for (const key of ["taskId", "leaseId"])
        if (typeof payload[key] === "string" && payload[key].length <= 160)
            sanitized[key] = payload[key];
    for (const key of [
        "toolElapsedMs",
        "waitElapsedMs",
        "delayMs",
        "rejections",
        "receivedOutputChars",
        "providerStatus",
    ])
        if (typeof payload[key] === "number" && Number.isFinite(payload[key]))
            sanitized[key] = payload[key];
    for (const key of ["isError", "protocolRecovery", "quotaExhausted", "toolSubmitted", "retryable"])
        if (typeof payload[key] === "boolean")
            sanitized[key] = payload[key];
    if ((type === "planning_submission_rejected" || type.endsWith("assistant_message_end")) &&
        typeof payload.error === "string")
        sanitized.error = redactTraceText(payload.error).slice(0, 2048);
    for (const field of fields) {
        let value = payload[field];
        if (field === "failureStage" && typeof value !== "string")
            value = payload.phase;
        if (field === "commitAccepted" && typeof value !== "boolean")
            value = payload.accepted;
        if (value === undefined || value === null)
            continue;
        if (PLANNING_TRACE_STRING_OR_NUMBER_FIELDS.has(field)) {
            if ((typeof value === "string" && value.length <= 160) ||
                (typeof value === "number" && Number.isFinite(value))) {
                sanitized[field] = value;
            }
            continue;
        }
        if (PLANNING_TRACE_STRING_FIELDS.has(field)) {
            if (typeof value === "string" && value.length <= 160)
                sanitized[field] = value;
            continue;
        }
        if (PLANNING_TRACE_NUMBER_FIELDS.has(field)) {
            if (typeof value === "number" && Number.isFinite(value))
                sanitized[field] = value;
            continue;
        }
        if (PLANNING_TRACE_BOOLEAN_FIELDS.has(field)) {
            if (typeof value === "boolean")
                sanitized[field] = value;
            continue;
        }
        if (PLANNING_TRACE_ARRAY_FIELDS.has(field)) {
            if (Array.isArray(value)) {
                const items = value
                    .filter((item) => typeof item === "string" && item.length <= 160)
                    .slice(0, 64);
                sanitized[field] = items;
            }
        }
    }
    return sanitized;
}
function legacyToolCalls(value) {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((part) => {
        if (!isRecord(part) || part.type !== "toolCall")
            return [];
        const id = typeof part.id === "string" ? part.id : typeof part.toolCallId === "string" ? part.toolCallId : "";
        const name = typeof part.name === "string" ? part.name : typeof part.toolName === "string" ? part.toolName : "tool";
        const args = part.arguments !== undefined ? part.arguments : part.input;
        return [
            {
                id,
                name,
                argsText: runtimeTraceText(args),
            },
        ];
    });
}
function runtimeMessageDetails(message) {
    if (!isRecord(message))
        return {};
    const details = {};
    for (const key of ["role", "provider", "model", "toolCallId", "toolName", "isError", "stopReason"]) {
        if (message[key] !== undefined)
            details[key] = message[key];
    }
    if (typeof message.timestamp === "number")
        details.messageTimestamp = message.timestamp / 1000;
    const content = contentText(message.content);
    if (content)
        details.contentText = runtimeTraceText(content);
    Object.assign(details, safeThinkingFields(message.content));
    if (details.thinking !== undefined) {
        details.thinkingText = details.thinking;
        delete details.thinking;
    }
    return details;
}
function runtimeEventDetails(source) {
    switch (source.type) {
        case "message_start":
        case "message_end":
            return runtimeMessageDetails(source.message);
        case "turn_end":
            return runtimeMessageDetails(source.message);
        case "tool_execution_start":
            return {
                toolCallId: source.toolCallId,
                toolName: source.toolName,
                argsText: runtimeTraceText(source.args),
            };
        case "tool_execution_end":
            return {
                toolCallId: source.toolCallId,
                toolName: source.toolName,
                resultText: runtimeTraceText(source.result),
                isError: source.isError,
            };
        default: {
            const record = source;
            if (!isRecord(record))
                return {};
            const details = {};
            for (const key of [
                "attempt",
                "maxAttempts",
                "delayMs",
                "errorMessage",
                "finalError",
                "reason",
                "aborted",
                "willRetry",
                "success",
                "level",
            ]) {
                const value = record[key];
                if (typeof value === "string")
                    details[key] = runtimeTraceText(value);
                else if (typeof value === "number" || typeof value === "boolean")
                    details[key] = value;
            }
            return details;
        }
    }
}
function lastAssistantError(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!isRecord(message) || message.role !== "assistant")
            continue;
        if (message.stopReason !== "error")
            return undefined;
        if (typeof message.errorMessage === "string" && message.errorMessage.trim())
            return message.errorMessage.trim();
        return contentText(message.content) || "Model request failed";
    }
    return undefined;
}
function lastAssistantText(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (isRecord(message) && message.role === "assistant")
            return contentText(message.content);
    }
    return "";
}
function timeoutSeconds(timeoutMs) {
    return Number.isInteger(timeoutMs / 1000) ? String(timeoutMs / 1000) : (timeoutMs / 1000).toFixed(1);
}
function terminalTimeoutMessage(error, resumed) {
    const seconds = timeoutSeconds(error.timeoutMs);
    if (error.kind === "first-output") {
        return (`模型首个输出超时：已等待 ${seconds} 秒仍没有收到任何内容。` +
            "网络可用时通常是 API 请求未返回、流式响应卡住、代理/API Base/模型配置异常，或服务端排队/限流。" +
            "请检查当前模型、API Base、Key、代理设置，或切换模型重试。");
    }
    if (error.kind === "tool-stalled") {
        return `工具执行卡住：已 ${seconds} 秒没有收到工具进展。会话已停止，未将模型 final 作为成功依据。`;
    }
    return resumed
        ? `模型输出中断：已 ${seconds} 秒没有收到新内容，且自动续作后再次中断。可能是流式连接中断、工具执行未返回或服务端响应卡住。已自动释放会话，你可以调整模型/代理后重试。`
        : `模型输出中断：已 ${seconds} 秒没有收到新内容。`;
}
function continuedAssistantText(prefix, suffix) {
    const left = prefix.trim();
    const right = suffix.trim();
    if (!left)
        return right;
    if (!right)
        return left;
    if (right.startsWith(left))
        return right;
    if (left.endsWith(right))
        return left;
    return `${left}\n${right}`;
}
function toLegacyMessage(message, id) {
    if (!isRecord(message))
        return { id, role: "assistant", content: contentText(message), ts: Date.now() / 1000 };
    const role = message.role === "custom" &&
        ["progressive-planning-goal", "cairn-planning-goal", "hypothesis-planning-goal"].includes(String(message.customType))
        ? "user"
        : message.role === "custom" && message.customType === "secheur-budget"
            ? "system"
            : message.role;
    const out = {
        id,
        role: typeof role === "string" ? role : "assistant",
        content: contentText(message.content),
        ts: typeof message.timestamp === "number" ? message.timestamp / 1000 : Date.now() / 1000,
    };
    Object.assign(out, safeThinkingFields(message.content));
    for (const key of ["toolName", "toolCallId", "isError", "stopReason", "errorMessage", "provider", "model"]) {
        if (message[key] !== undefined)
            out[key] = message[key];
    }
    const toolCalls = legacyToolCalls(message.content);
    if (toolCalls.length > 0)
        out.toolCalls = toolCalls;
    return out;
}
function projectPayload(root) {
    return { projectRoot: root, project_root: root };
}
function parseBody(request) {
    return new Promise((resolveBody, reject) => {
        let size = 0;
        let failed = false;
        const chunks = [];
        request.on("data", (chunk) => {
            if (failed)
                return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size > MAX_BODY_BYTES) {
                failed = true;
                reject(new BridgeHttpError(413, "request body too large"));
                return;
            }
            chunks.push(buffer);
        });
        request.on("end", () => {
            if (failed)
                return;
            if (chunks.length === 0) {
                resolveBody({});
                return;
            }
            try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (!isRecord(parsed))
                    throw new BridgeHttpError(400, "request body must be a JSON object");
                resolveBody(parsed);
            }
            catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
        request.on("error", reject);
    });
}
function apiEndpoint(base, path) {
    const normalized = base.trim().replace(/\/+$/u, "");
    if (!normalized || !/^https?:\/\//iu.test(normalized))
        throw new Error("API Base must be an HTTP URL");
    return normalized.endsWith(`/${path}`) ? normalized : `${normalized}/${path}`;
}
function apiSecret(config) {
    return typeof config.apikey === "string" ? config.apikey.trim() : "";
}
function apiRequestHeaders(config, json = false) {
    const key = apiSecret(config);
    const headers = { Accept: "application/json" };
    if (json)
        headers["Content-Type"] = "application/json";
    if (String(config.type ?? "native_oai") === "native_anthropic") {
        headers["x-api-key"] = key;
        headers["anthropic-version"] = "2023-06-01";
    }
    else {
        headers.Authorization = `Bearer ${key}`;
    }
    return headers;
}
function responsePreview(value) {
    return value.replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, "Bearer [redacted]").slice(0, 500);
}
async function readApiResponse(response) {
    const text = await response.text();
    if (!response.ok)
        throw new Error(`API request failed: HTTP ${response.status} ${responsePreview(text)}`);
    try {
        return text ? JSON.parse(text) : {};
    }
    catch (error) {
        throw new Error(`API response was not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function modelList(payload) {
    let value = payload;
    if (isRecord(value) && "data" in value)
        value = value.data;
    if (isRecord(value) && "models" in value)
        value = value.models;
    if (!Array.isArray(value))
        return [];
    const seen = new Set();
    return value.flatMap((item) => {
        if (!isRecord(item))
            return [];
        const id = typeof item.id === "string" ? item.id : typeof item.model === "string" ? item.model : "";
        if (!id || seen.has(id))
            return [];
        seen.add(id);
        return [{ id, name: typeof item.name === "string" ? item.name : id }];
    });
}
function responseText(payload) {
    if (typeof payload === "string")
        return payload.trim();
    if (Array.isArray(payload))
        return payload.map(responseText).filter(Boolean).join("\n");
    if (!isRecord(payload))
        return "";
    for (const key of ["output_text", "text", "content", "answer", "response", "result", "completion"]) {
        const text = responseText(payload[key]);
        if (text)
            return text;
    }
    if (Array.isArray(payload.choices))
        return responseText(payload.choices[0]);
    if (isRecord(payload.message))
        return responseText(payload.message.content ?? payload.message);
    return "";
}
async function fetchApiModels(root, input) {
    const config = resolveApiProfile(root, input, { requireName: false, requireModel: false });
    if (!apiSecret(config))
        throw new Error("API Key is required");
    const base = typeof config.apibase === "string" ? config.apibase : "";
    const response = await fetch(apiEndpoint(base, "models"), {
        headers: apiRequestHeaders(config),
        signal: AbortSignal.timeout(20_000),
    });
    const models = modelList(await readApiResponse(response));
    if (models.length === 0)
        throw new Error("API returned no models");
    return models;
}
async function testApiConfig(root, input) {
    const config = resolveApiProfile(root, input);
    if (!apiSecret(config))
        throw new Error("API Key is required");
    const base = typeof config.apibase === "string" ? config.apibase : "";
    const model = typeof config.model === "string" ? config.model : "";
    if (!model)
        throw new Error("Model is required");
    const isAnthropic = String(config.type ?? "native_oai") === "native_anthropic";
    const mode = String(config.api_mode ?? "chat_completions").toLowerCase();
    const useResponses = !isAnthropic && (mode === "responses" || mode === "response");
    const url = apiEndpoint(base, isAnthropic ? "messages" : useResponses ? "responses" : "chat/completions");
    const payload = isAnthropic
        ? { model, max_tokens: 64, messages: [{ role: "user", content: "Reply with OK." }] }
        : useResponses
            ? { model, input: "Reply with OK.", max_output_tokens: 64, stream: false }
            : { model, messages: [{ role: "user", content: "Reply with OK." }], stream: false, max_tokens: 64 };
    const started = Date.now();
    const response = await fetch(url, {
        method: "POST",
        headers: apiRequestHeaders(config, true),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
    });
    const parsed = await readApiResponse(response);
    return {
        ok: true,
        model: isRecord(parsed) && typeof parsed.model === "string" ? parsed.model : model,
        text: responseText(parsed).slice(0, 500),
        emptyText: !responseText(parsed),
        rawPreview: responsePreview(jsonText(parsed)),
        elapsedMs: Date.now() - started,
    };
}
function responseHeaders() {
    return {
        "Access-Control-Allow-Headers": "Content-Type, Authorization, Last-Event-ID",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Cache-Control": "no-store",
    };
}
function normalizedHostname(value) {
    return value
        .toLowerCase()
        .replace(/^\[|\]$/gu, "")
        .replace(/^::ffff:/u, "");
}
function isLoopbackHostname(value) {
    const hostname = normalizedHostname(value);
    return (hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        hostname === "::1" ||
        (isIP(hostname) === 4 && hostname.startsWith("127.")));
}
function isAllowedRequestOrigin(request) {
    const origin = request.headers.origin;
    if (!origin)
        return true;
    try {
        const hostname = new URL(origin).hostname;
        const localAddress = request.socket.localAddress;
        return (isLoopbackHostname(hostname) ||
            Boolean(localAddress && normalizedHostname(hostname) === normalizedHostname(localAddress)));
    }
    catch {
        return false;
    }
}
function sendJson(response, value, status = 200) {
    const body = jsonText(value);
    response.writeHead(status, { ...responseHeaders(), "Content-Type": "application/json; charset=utf-8" });
    response.end(body);
}
function safeStaticFile(root, requestPath) {
    let decoded;
    try {
        decoded = decodeURIComponent(requestPath);
    }
    catch {
        return undefined;
    }
    if (decoded.includes("\0"))
        return undefined;
    const target = resolve(root, decoded.replace(/^\/+/, ""));
    const targetRelative = relative(root, target);
    if (targetRelative === ".." || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative))
        return undefined;
    try {
        if (!statSync(target).isFile())
            return undefined;
        const realRoot = realpathSync(root);
        const realTarget = realpathSync(target);
        const realRelative = relative(realRoot, realTarget);
        if (realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative))
            return undefined;
        return realTarget;
    }
    catch {
        return undefined;
    }
}
function sendStaticFile(request, response, path) {
    const content = readFileSync(path);
    response.writeHead(200, {
        "Cache-Control": "no-cache",
        "Content-Length": content.length,
        "Content-Type": STATIC_MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : content);
}
function wsPacket(opcode, payload) {
    if (payload.length < 126)
        return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
    if (payload.length < 65536) {
        const header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
        return Buffer.concat([header, payload]);
    }
    const header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
    return Buffer.concat([header, payload]);
}
function wsFrame(value) {
    return wsPacket(0x1, Buffer.from(jsonText(value), "utf8"));
}
function queryInteger(url, names, fallback, minimum) {
    const raw = names.flatMap((name) => (url.searchParams.has(name) ? [url.searchParams.get(name)] : [])).at(0);
    if (raw === undefined || raw === null || raw === "")
        return fallback;
    if (!/^-?\d+$/u.test(raw))
        throw new BridgeHttpError(400, `invalid integer query parameter: ${names.join("/")}`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw new BridgeHttpError(400, `query parameter must be >= ${minimum}: ${names.join("/")}`);
    }
    return value;
}
function runtimeLogQuery(url) {
    const hasEventCursor = ["afterEventId", "eventAfter"].some((name) => url.searchParams.has(name));
    const hasMessageCursor = ["afterMessageId", "messageAfter"].some((name) => url.searchParams.has(name));
    const hasEpoch = url.searchParams.has("logEpoch");
    const explicitIncremental = ["1", "true", "yes"].includes((url.searchParams.get("incremental") ?? "").trim().toLowerCase());
    const incremental = hasEventCursor || hasMessageCursor || hasEpoch || explicitIncremental;
    const includeMessages = url.searchParams.get("includeMessages") !== "false";
    const logEpoch = url.searchParams.get("logEpoch")?.trim() || undefined;
    return {
        incremental,
        afterEventId: queryInteger(url, ["afterEventId", "eventAfter"], 0, 0),
        afterMessageId: queryInteger(url, ["afterMessageId", "messageAfter"], 0, 0),
        includeMessages,
        ...(logEpoch ? { logEpoch } : {}),
    };
}
function optionalModelIndex(input) {
    const raw = input.llmNo ?? input.llm_no;
    if (raw === undefined || raw === null || raw === "")
        return undefined;
    const value = typeof raw === "number"
        ? raw
        : typeof raw === "string" && /^\d+$/u.test(raw.trim())
            ? Number(raw.trim())
            : Number.NaN;
    if (!Number.isSafeInteger(value) || value < 0)
        throw new BridgeHttpError(400, "llmNo must be a non-negative integer");
    return value;
}
function pathInside(root, target) {
    const child = relative(root, target);
    return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}
function resolveOpenTarget(root, input) {
    const kind = typeof input.kind === "string" ? input.kind : "";
    let raw;
    if (kind === "mykeyTemplate")
        raw = "mykey_template.py";
    else if (kind)
        throw new BridgeHttpError(400, `unknown open target kind: ${kind}`);
    else
        raw = typeof input.path === "string" ? input.path : typeof input.target === "string" ? input.target : root;
    const target = resolve(root, raw);
    if (!pathInside(root, target))
        throw new BridgeHttpError(400, `path is outside project root: ${target}`);
    if (!existsSync(target))
        return target;
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(target);
    if (!pathInside(realRoot, realTarget))
        throw new BridgeHttpError(400, `path is outside project root: ${realTarget}`);
    return realTarget;
}
function launchPath(target) {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
    return new Promise((resolveLaunch, reject) => {
        const child = spawn(command, [target], { detached: true, stdio: "ignore", windowsHide: true });
        child.once("error", reject);
        child.once("spawn", () => {
            child.unref();
            resolveLaunch();
        });
    });
}
function runCapturedCommand(command, args) {
    return new Promise((resolveCommand, rejectCommand) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let stdout = "";
        let stderr = "";
        const append = (current, chunk) => `${current}${chunk.toString("utf8")}`.slice(-64 * 1024);
        child.stdout.on("data", (chunk) => {
            stdout = append(stdout, chunk);
        });
        child.stderr.on("data", (chunk) => {
            stderr = append(stderr, chunk);
        });
        child.once("error", rejectCommand);
        child.once("close", (code) => {
            if (code === 0)
                resolveCommand({ stdout, stderr });
            else
                rejectCommand(new Error(stderr.trim() || `${command} exited with code ${String(code)}`));
        });
    });
}
export class SecHeurBridge {
    projectRoot;
    host;
    port;
    staticRoot;
    benchmarkRoot;
    uploadRoot;
    env;
    openPath;
    sessions = new Map();
    managedOnly;
    loadPersistedSessions;
    managedRegistrations = new Map();
    managedConnectionPromises = new Map();
    wsClients = new Map();
    sseClients = new Set();
    bridgeEventHistory = [];
    pendingSessionEvents = new Map();
    sessionEventTimers = new Map();
    closedSessionIds = new Set();
    sessionPlanningEngines = new Map();
    sessionExecutionModes = new Map();
    sessionAcquisitionBarriers = new Set();
    scheduler;
    competitionSocketPath;
    worklistPromise;
    competitionPromise;
    competitionServerPromise;
    competitionClient;
    /** bridge 进程重启后更换，客户端游标随之失效。 */
    runtimeLogEpoch = randomUUID();
    server;
    closing = false;
    closePromise;
    pluginMutationTail = Promise.resolve();
    managedDiscoveryPromise;
    bridgeEventSeq = 0;
    activeSessionId;
    preferredSessionId;
    schedulerSessionId;
    mainWorkflow;
    constructor(options = {}) {
        this.mainWorkflow = options.mainWorkflow;
        this.projectRoot = resolve(options.projectRoot ?? process.cwd());
        this.env = options.env ?? process.env;
        this.openPath = options.openPath ?? launchPath;
        this.host = options.host ?? this.env.BRIDGE_HOST ?? "127.0.0.1";
        this.port = options.port ?? Number(this.env.BRIDGE_PORT ?? 14168);
        this.managedOnly = options.managedSessions === true;
        this.loadPersistedSessions = !["0", "false"].includes((this.env.SECHEUR_LOAD_PERSISTED_SESSIONS ?? "1").toLowerCase());
        const config = loadSecHeurConfig({ projectRoot: this.projectRoot, env: this.env });
        const bridgeEnv = this.env;
        this.staticRoot = join(config.legacyRoot, "frontends", "desktop", "static");
        this.benchmarkRoot = join(config.legacyRoot, "ctf-benchmark-dashboard");
        this.uploadRoot = join(config.stateDir, "uploads");
        if (options.schedulerBackend !== false) {
            const backend = options.schedulerBackend ?? new LegacySchedulerBackend(config, this.env);
            this.scheduler = new SchedulerPoller(backend, {
                isBusy: () => this.schedulerIsBusy(),
                submit: (task, onDone) => this.submitSchedulerPrompt(task, onDone),
            }, (error) => console.error(`Scheduler tick failed: ${error.message}`));
        }
        const competitionSocketPath = this.env.SECHEUR_COMPETITION_SOCKET?.trim() || deriveCompetitionSocketPath(config.stateDir);
        this.competitionSocketPath = competitionSocketPath;
        if (this.managedOnly) {
            this.competitionClient = new CompetitionBrokerClient({
                socketPath: competitionSocketPath,
                clientId: `bridge:${this.projectRoot}`,
            });
        }
        if (options.competition !== false && !this.managedOnly) {
            const competition = options.competition;
            const maxEnvironmentSlots = Number(this.env.COMPETITION_MAX_ENVIRONMENTS ?? this.env.WORKLIST_MAX_ENVIRONMENTS ?? 3);
            const initialConfig = competitionAdapterConfigFromEnvironment(this.env);
            const initialBuild = competition
                ? undefined
                : createCompetitionAdapter(initialConfig, {
                    config,
                    env: this.env,
                    maxEnvironmentSlots,
                });
            let currentConfig = initialBuild?.config ?? initialConfig;
            const reconfigureAdapter = async (patch) => {
                const nextConfig = resolveCompetitionAdapterConfig(patch, currentConfig, this.env);
                const nextBuild = createCompetitionAdapter(nextConfig, {
                    config,
                    env: this.env,
                    maxEnvironmentSlots,
                    slabApi: initialBuild?.attachmentApi,
                });
                currentConfig = nextBuild.config;
                return nextBuild;
            };
            this.competitionPromise = competition
                ? Promise.resolve(competition)
                : CompetitionBroker.open({
                    databasePath: this.env.SECHEUR_COMPETITION_DATABASE?.trim() || join(config.stateDir, "competition.sqlite"),
                    adapter: initialBuild?.adapter ??
                        (() => {
                            throw new Error("Competition adapter was not initialized");
                        })(),
                    ...(initialBuild?.summary ? { adapterSummary: initialBuild.summary } : {}),
                    reconfigureAdapter,
                    maxEnvironmentSlots,
                });
            this.competitionServerPromise = options.externalCompetitionServer ? undefined : this.competitionPromise.then((broker) => new CompetitionBrokerServer({ broker, socketPath: competitionSocketPath }));
        }
        if (options.worklist !== false && !this.managedOnly) {
            const worklist = options.worklist;
            this.worklistPromise = worklist
                ? Promise.resolve(worklist)
                : (async () => openWorklistOrchestrator({
                    config,
                    env: bridgeEnv,
                    competitionBroker: this.competitionPromise ? await this.competitionPromise : undefined,
                    competitionServer: this.competitionServerPromise ? await this.competitionServerPromise : undefined,
                    competitionSocketPath,
                    onUpdate: (snapshot) => this.broadcast({ type: "worklist-state", ...snapshot }),
                }))();
        }
        const bridgeState = readBridgeState(this.projectRoot);
        if (isRecord(bridgeState.sessionPlanningEngines)) {
            for (const [id, engine] of Object.entries(bridgeState.sessionPlanningEngines)) {
                if (isPlanningEngine(engine))
                    this.sessionPlanningEngines.set(id, engine);
            }
        }
        if (isRecord(bridgeState.sessionExecutionModes)) {
            for (const [id, value] of Object.entries(bridgeState.sessionExecutionModes)) {
                if (isRecord(value) &&
                    (value.mode === "direct" || value.mode === "plan_single" || value.mode === "plan_multi") &&
                    typeof value.capacity === "number" &&
                    Number.isSafeInteger(value.capacity) &&
                    value.capacity >= 1 &&
                    value.capacity <= 64) {
                    this.sessionExecutionModes.set(id, { mode: value.mode, capacity: value.capacity });
                }
            }
        }
        this.preferredSessionId =
            typeof bridgeState.activeSessionId === "string" ? bridgeState.activeSessionId : undefined;
        if (Array.isArray(bridgeState.closedSessionIds)) {
            for (const id of bridgeState.closedSessionIds) {
                if (typeof id === "string" && id)
                    this.closedSessionIds.add(id);
            }
        }
    }
    async getWorklist() {
        if (!this.worklistPromise)
            throw new BridgeHttpError(404, "worklist is disabled");
        try {
            return await this.worklistPromise;
        }
        catch (error) {
            throw new BridgeHttpError(503, `worklist is unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getCompetition() {
        if (!this.competitionPromise)
            throw new BridgeHttpError(404, "competition broker is disabled");
        try {
            return await this.competitionPromise;
        }
        catch (error) {
            throw new BridgeHttpError(503, `competition broker is unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async managedCompetitionRequest(operation, payload = {}) {
        if (!this.competitionClient)
            throw new BridgeHttpError(404, "competition broker is disabled");
        try {
            return await this.competitionClient.request(operation, payload);
        }
        catch (error) {
            throw new BridgeHttpError(503, `competition broker is unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async managedWorklistSummary() {
        await this.discoverManagedSessions();
        const solverSessions = new Map([...this.managedRegistrations.values()]
            .filter((registration) => registration.role === "solver" && registration.taskId)
            .map((registration) => [registration.taskId, registration]));
        const status = (await this.managedCompetitionRequest("status"));
        const rawTasks = Array.isArray(status.tasks) ? status.tasks : [];
        const items = rawTasks.flatMap((value) => {
            if (!isRecord(value) || !isRecord(value.challenge))
                return [];
            const challenge = value.challenge;
            const taskId = typeof value.taskId === "string" ? value.taskId : "";
            const solver = taskId ? solverSessions.get(taskId) : undefined;
            return [
                {
                    id: taskId || "task",
                    sessionId: solver?.sessionId,
                    exerciseId: challenge.exerciseId ?? value.taskId,
                    name: typeof challenge.name === "string" ? challenge.name : String(value.taskId ?? "task"),
                    category: typeof challenge.category === "string" ? challenge.category : undefined,
                    description: typeof challenge.description === "string" ? challenge.description : "",
                    status: managedWorklistStatus(value.status),
                    competitionStatus: value.status ?? "queued",
                    attemptBudget: value.attemptBudget ?? null,
                    priority: value.priority ?? 0,
                    requiresEnvironment: isRecord(challenge.environment) && challenge.environment.required === true,
                    workdir: "",
                    attempts: value.actualAttempts ?? 0,
                    failures: 0,
                    metadata: {
                        competitionTaskId: value.taskId ?? null,
                        attemptBudget: value.attemptBudget ?? null,
                        solverId: value.solverId ?? null,
                        tmuxTarget: solver?.tmuxTarget ?? null,
                    },
                    createdAt: value.createdAt ?? Date.now(),
                    updatedAt: value.updatedAt ?? Date.now(),
                },
            ];
        });
        const events = await this.managedCompetitionRequest("list_events", { limit: 500 });
        return {
            running: true,
            configured: true,
            managed: true,
            controller: "Main Agent",
            items,
            events: Array.isArray(events) ? events : [],
            activeEnvironmentCount: status.activeEnvironmentCount ?? 0,
            activeAttachmentCount: 0,
            maxEnvironmentCount: status.maxEnvironmentSlots ?? 0,
            maxFlagAttempts: Math.max(0, ...rawTasks.flatMap((task) => isRecord(task) && isRecord(task.submission) && typeof task.submission.maxAttempts === "number"
                ? [task.submission.maxAttempts]
                : [])),
            maxFailures: 0,
            competitionPlan: status.plan ?? undefined,
            updatedAt: Date.now(),
            tasks: rawTasks,
        };
    }
    persistBridgeState() {
        writeBridgeState(this.projectRoot, {
            activeSessionId: this.activeSessionId ?? null,
            closedSessionIds: [...this.closedSessionIds],
            sessionPlanningEngines: Object.fromEntries(this.sessionPlanningEngines),
            sessionExecutionModes: Object.fromEntries(this.sessionExecutionModes),
        });
    }
    beginSessionAcquisition() {
        if (this.closing)
            throw new BridgeHttpError(503, "SecHeur bridge is closing");
        let resolveBarrier = () => { };
        const barrier = new Promise((resolvePromise) => {
            resolveBarrier = resolvePromise;
        });
        this.sessionAcquisitionBarriers.add(barrier);
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            this.sessionAcquisitionBarriers.delete(barrier);
            resolveBarrier();
        };
    }
    broadcast(value) {
        const eventId = ++this.bridgeEventSeq;
        const payload = isRecord(value) ? { ...value, eventId } : value;
        this.bridgeEventHistory.push({ id: eventId, payload });
        if (this.bridgeEventHistory.length > MAX_BRIDGE_EVENT_HISTORY) {
            this.bridgeEventHistory.splice(0, this.bridgeEventHistory.length - MAX_BRIDGE_EVENT_HISTORY);
        }
        const frame = wsFrame(payload);
        for (const client of this.wsClients.values())
            this.enqueueWs(client, frame);
        const sseFrame = this.sseEventFrame(eventId, payload);
        for (const client of this.sseClients)
            this.enqueueSse(client, sseFrame);
    }
    enqueueWs(client, frame) {
        if (client.closed)
            return;
        if (client.socket.destroyed) {
            this.closeWsClient(client, true);
            return;
        }
        if (client.queue.length >= MAX_WS_QUEUE_EVENTS) {
            client.queue.length = 0;
            client.queue.push(wsFrame({
                type: "resync-required",
                eventId: this.bridgeEventSeq,
                reason: "event queue overflow",
            }));
            this.flushWs(client);
            this.closeWsClient(client);
            return;
        }
        client.queue.push(frame);
        this.flushWs(client);
    }
    flushWs(client) {
        if (client.closed || client.socket.destroyed || client.blocked)
            return;
        try {
            while (client.queue.length > 0) {
                const frame = client.queue.shift();
                if (!frame)
                    break;
                if (!client.socket.write(frame)) {
                    client.blocked = true;
                    client.socket.once("drain", () => {
                        client.blocked = false;
                        this.flushWs(client);
                    });
                    return;
                }
            }
        }
        catch {
            this.closeWsClient(client, true);
        }
    }
    closeWsClient(client, destroy = false) {
        if (client.closed)
            return;
        client.closed = true;
        clearInterval(client.heartbeat);
        this.wsClients.delete(client.socket);
        if (destroy)
            client.socket.destroy();
        else if (!client.socket.destroyed)
            client.socket.end();
    }
    sseEventFrame(eventId, payload) {
        return Buffer.from(`id: ${eventId}\nevent: bridge\ndata: ${jsonText(payload)}\n\n`, "utf8");
    }
    enqueueSse(client, frame) {
        if (client.closed)
            return;
        if (client.response.destroyed || client.response.writableEnded) {
            this.closeSseClient(client, false);
            return;
        }
        if (client.queue.length >= MAX_SSE_QUEUE_EVENTS) {
            this.closeSseClient(client, true);
            return;
        }
        client.queue.push(frame);
        this.flushSse(client);
    }
    flushSse(client) {
        if (client.closed || client.blocked || client.response.destroyed || client.response.writableEnded)
            return;
        try {
            while (client.queue.length > 0) {
                const frame = client.queue.shift();
                if (!frame)
                    break;
                if (!client.response.write(frame)) {
                    client.blocked = true;
                    client.response.once("drain", () => {
                        client.blocked = false;
                        this.flushSse(client);
                    });
                    return;
                }
            }
        }
        catch {
            this.closeSseClient(client, false);
        }
    }
    closeSseClient(client, notifyResync) {
        if (client.closed)
            return;
        client.closed = true;
        this.sseClients.delete(client);
        clearInterval(client.heartbeat);
        if (notifyResync && !client.response.destroyed) {
            try {
                client.response.write(this.sseEventFrame(this.bridgeEventSeq, {
                    type: "resync-required",
                    reason: "event queue overflow",
                }));
            }
            catch {
                // The response may already be closed; cleanup below is still required.
            }
        }
        if (!client.response.writableEnded)
            client.response.end();
    }
    handleSse(request, response, url) {
        const headerValue = request.headers["last-event-id"];
        const headerId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
        const rawSince = url.searchParams.get("since") ?? headerId ?? "0";
        const since = /^\d+$/u.test(rawSince) ? Number(rawSince) : 0;
        response.writeHead(200, {
            ...responseHeaders(),
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "Content-Type": "text/event-stream; charset=utf-8",
            "X-Accel-Buffering": "no",
        });
        response.write(`: connected ${this.bridgeEventSeq}\n\n`);
        const client = {
            response,
            queue: [],
            blocked: false,
            closed: false,
            heartbeat: setInterval(() => this.enqueueSse(client, Buffer.from(": heartbeat\n\n", "utf8")), SSE_HEARTBEAT_MS),
        };
        this.sseClients.add(client);
        const oldest = this.bridgeEventHistory.at(0)?.id;
        if (oldest !== undefined && since > 0 && since < oldest - 1) {
            this.enqueueSse(client, this.sseEventFrame(this.bridgeEventSeq, {
                type: "resync-required",
                reason: "event history expired",
            }));
        }
        else {
            for (const event of this.bridgeEventHistory) {
                if (event.id > since)
                    this.enqueueSse(client, this.sseEventFrame(event.id, event.payload));
            }
        }
        if (this.bridgeEventSeq === 0) {
            this.enqueueSse(client, this.sseEventFrame(0, { type: "bridge-ready", sequence: 0, projectRoot: this.projectRoot }));
        }
        else if (since >= this.bridgeEventSeq || this.bridgeEventHistory.length === 0) {
            this.enqueueSse(client, this.sseEventFrame(this.bridgeEventSeq, {
                type: "bridge-ready",
                sequence: this.bridgeEventSeq,
                projectRoot: this.projectRoot,
            }));
        }
        const cleanup = () => this.closeSseClient(client, false);
        request.once("aborted", cleanup);
        response.once("close", cleanup);
    }
    snapshot(session, includeMessages = true) {
        if (session.managed?.snapshot) {
            this.updateManagedSnapshot(session, session.managed.snapshot, includeMessages);
        }
        else if (includeMessages) {
            // Session summaries must stay cheap. Persisted transcripts are loaded only when
            // a caller explicitly requests message data for the selected session.
            this.loadSessionMessages(session);
        }
        const permissions = this.permissionSnapshot(session);
        const result = {
            sessionId: session.id,
            id: session.id,
            title: session.title,
            cwd: session.cwd,
            status: session.status,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            lastError: session.lastError,
            role: session.role ?? "local",
            managed: Boolean(session.managed) || this.managedRegistrations.has(session.id),
            taskId: session.taskId ?? null,
            category: session.category ?? null,
            parentMainSessionId: session.parentMainSessionId ?? null,
            tmuxTarget: session.tmuxTarget ?? null,
            // Unloaded persisted sessions have a metadata-only message count. Once the
            // transcript is materialized, nextMessageId is the authoritative cursor.
            msgSeq: session.messagesLoaded ? session.nextMessageId : session.messageCount,
            llmNo: session.modelIndex,
            permissionMode: session.runtime?.state.permissions.mode ?? session.permissionMode,
            memoryReferenceEnabled: session.memoryReferenceEnabled,
            knowledgeBaseEnabled: session.knowledgeBaseEnabled,
            permissionRequests: permissions,
            turnCount: session.runtime?.state.operationalGuard?.turnsUsed ??
                session.runtime?.state.getTurnCount() ??
                session.settledTurnCount ??
                0,
            toolCallCount: session.runtime?.state.operationalGuard?.toolCallsUsed ?? session.settledToolCallCount ?? null,
            judge: session.runtime?.state.getLastJudge(),
            judgeError: session.runtime?.state.getJudgeError?.(),
            budget: session.runtime?.getBudgetStatus?.() ?? null,
            runtimeReloadPending: Boolean(session.runtimeStaleReason),
            runtimeEventCount: session.runtimeEvents.length,
            sessionFile: session.sessionFile ?? null,
            persistent: Boolean(session.sessionFile),
            closed: this.closedSessionIds.has(session.id),
            taskKind: session.taskKind,
            trustedChallengeId: session.trustedTaskIdentity?.challengeId ?? null,
            trustedRunId: session.trustedTaskIdentity?.runId ?? null,
            requireTrustedChallengeId: session.requireTrustedChallengeId === true,
            interactionMode: session.interactionMode,
            terminalReason: session.terminalReason,
            failureSource: session.failureSource ?? null,
            failureStage: session.failureStage ?? null,
            failureCode: session.failureCode ?? null,
            verificationState: session.verificationState,
            trustedPlanningVerification: session.trustedPlanningVerification ?? null,
            cancelSource: session.cancelSource ?? null,
            cancelReason: session.cancelReason ?? null,
            cancelAt: session.cancelAt ?? null,
            preCancelStatus: session.preCancelStatus ?? null,
            pauseSource: session.pauseSource ?? null,
            pauseReason: session.pauseReason ?? null,
            pauseAt: session.pauseAt ?? null,
            prePauseStatus: session.prePauseStatus ?? null,
            watchdogPhase: session.watchdogPhase ?? null,
            watchdogLastActivityAt: session.watchdogLastActivityAt ?? null,
            modelContinuationCount: session.modelContinuationCount ?? 0,
            consecutiveNoToolTurns: session.ctfContinuation.consecutiveNoToolTurns,
            executionMode: session.executionMode ?? null,
            planningEngine: session.planningEngine ?? null,
            executionCapacity: session.executionCapacity ?? null,
            legacyPlanningMode: session.legacyPlanningMode ?? null,
            planningRunId: session.planningRunId,
            ...(includeMessages ? { blackboardGraph: buildSessionBlackboardGraph(session) } : {}),
        };
        if (includeMessages) {
            result.messages = session.messageRecords;
            result.partial = session.partial;
        }
        return result;
    }
    runtimeLogMessages(session, afterMessageId, includeMessages) {
        if (!includeMessages)
            return { messages: [], partial: null };
        if (session.managed?.snapshot) {
            const transcript = session.managed.snapshot.transcript;
            // managed transcript 使用 bridge 暴露的稳定一基索引作为消息 ID。
            const start = afterMessageId > 0 ? Math.max(0, afterMessageId - 1) : 0;
            const messages = transcript.slice(start).map((item, index) => {
                const record = {
                    id: start + index + 1,
                    role: item.role === "tool" ? "toolResult" : item.role,
                    content: contentText(item.content),
                    ts: item.timestamp / 1000,
                };
                Object.assign(record, safeThinkingFields(item.content));
                if (item.role === "assistant") {
                    record.status = item.status;
                    if (item.status !== "streaming")
                        record.stopReason = item.stopReason;
                    const toolCalls = legacyToolCalls(item.content);
                    if (toolCalls.length > 0)
                        record.toolCalls = toolCalls;
                }
                if (item.role === "tool") {
                    record.toolCallId = item.toolCallId;
                    record.toolName = item.toolName;
                    record.isError = item.isError;
                }
                return record;
            });
            const last = transcript.at(-1);
            const lastId = transcript.length;
            const partial = last?.role === "assistant" && last.status === "streaming" && lastId >= afterMessageId
                ? { ...messages.at(-1), partial: true }
                : null;
            return { messages, partial };
        }
        this.loadSessionMessages(session);
        const messages = session.messageRecords.filter((message) => Number(message.id) >= afterMessageId || afterMessageId === 0);
        const partialId = Number(session.partial?.id ?? 0);
        return {
            messages,
            partial: session.partial && (afterMessageId === 0 || partialId >= afterMessageId) ? session.partial : null,
        };
    }
    runtimeLogPayload(session, query) {
        // 常规轮询只返回元数据；本地 runtime 先按增量同步，managed snapshot 已保持最新。
        if (session.managed?.snapshot)
            this.updateManagedSnapshot(session, session.managed.snapshot, false);
        else if (session.runtime)
            this.syncRuntimeMessages(session);
        else if (query.includeMessages)
            this.loadSessionMessages(session);
        const currentMessageCursor = session.managed?.snapshot?.transcript.length ??
            (session.messagesLoaded ? session.nextMessageId : session.messageCount);
        const currentEventCursor = session.runtimeEventSeq;
        const firstRetainedEventId = session.runtimeEvents.length > 0 ? Number(session.runtimeEvents.at(0)?.id ?? 0) : undefined;
        const eventStartId = typeof firstRetainedEventId === "number" ? firstRetainedEventId : currentEventCursor + 1;
        const eventHistoryExpired = query.incremental && firstRetainedEventId !== undefined && query.afterEventId < firstRetainedEventId - 1;
        const cursorAhead = query.afterEventId > currentEventCursor || query.afterMessageId > currentMessageCursor;
        const epochMismatch = query.logEpoch !== undefined && query.logEpoch !== this.runtimeLogEpoch;
        const resetRequired = query.incremental && (epochMismatch || eventHistoryExpired || cursorAhead);
        const includeMessages = query.includeMessages || resetRequired;
        const messageData = this.runtimeLogMessages(session, resetRequired ? 0 : query.afterMessageId, includeMessages);
        const events = resetRequired || !query.incremental
            ? session.runtimeEvents
            : session.runtimeEvents.filter((event) => Number(event.id ?? 0) > query.afterEventId);
        return {
            ok: true,
            sessionId: session.id,
            session: this.snapshot(session, false),
            messages: messageData.messages,
            partial: messageData.partial,
            events,
            incremental: query.incremental,
            resetRequired,
            logEpoch: this.runtimeLogEpoch,
            messageCursor: currentMessageCursor,
            eventCursor: currentEventCursor,
            eventStartId,
            messagesIncluded: includeMessages,
        };
    }
    async planningTracePayload(session, url) {
        const config = loadSecHeurConfig({ projectRoot: this.projectRoot, env: this.env });
        const configuredPlanningMode = session.executionMode ?? config.executionMode.mode;
        const planningMode = configuredPlanningMode === "plan_single" ||
            session.legacyPlanningMode === "active" ||
            session.legacyPlanningMode === "shadow";
        const planningRunId = session.planningRunId;
        if (!planningRunId) {
            return {
                ok: true,
                sessionId: session.id,
                planningRunId: null,
                planningStatus: planningMode ? "not_started" : "not_applicable",
                events: [],
                eventCount: 0,
                pageEventCount: 0,
                traceComplete: !planningMode,
                nextCursor: null,
            };
        }
        const rawCursor = url.searchParams.get("cursor")?.trim() || undefined;
        if (rawCursor !== undefined && !/^\d+$/u.test(rawCursor)) {
            throw new BridgeHttpError(400, "cursor must be a non-negative integer");
        }
        const limit = Math.min(queryInteger(url, ["limit"], 100, 1), 200);
        if (planningRunId.startsWith("planning_cairn_")) {
            if (rawCursor && !Number.isSafeInteger(Number(rawCursor)))
                throw new BridgeHttpError(400, "cursor must be a safe integer");
            const directory = cairnRunDirectory(config.stateDir, planningRunId);
            if (!existsSync(join(directory, "host.sqlite")))
                throw new BridgeHttpError(503, "Cairn trace unavailable");
            const evidence = new CairnHostEvidence(join(directory, "host.sqlite"));
            try {
                const page = evidence.events(planningRunId, rawCursor ? Number(rawCursor) : 0, limit);
                const total = evidence.eventsCount(planningRunId);
                return {
                    ok: true,
                    sessionId: session.id,
                    planningRunId,
                    engine: "cairn",
                    planningStatus: evidence.runStatus(planningRunId),
                    events: page.events.map((event) => ({
                        ...event,
                        payload: sanitizeCairnTracePayload(event.payload),
                    })),
                    eventCount: total,
                    pageEventCount: page.events.length,
                    traceComplete: !page.hasMore,
                    nextCursor: page.hasMore ? String(page.nextCursor) : null,
                };
            }
            finally {
                evidence.close();
            }
        }
        const planningStorePath = join(config.stateDir, "planning.sqlite");
        if (!existsSync(planningStorePath))
            throw new BridgeHttpError(503, "planning trace unavailable");
        let store;
        try {
            store = await PlanningStore.open(planningStorePath);
            const run = store.getRun(planningRunId);
            if (!run)
                throw new BridgeHttpError(503, "planning run unavailable");
            const page = store.listLifecycleEvents(planningRunId, { cursor: rawCursor, limit });
            return {
                ok: true,
                sessionId: session.id,
                planningRunId,
                planningStatus: run.status,
                events: page.events.map((event) => ({
                    eventId: event.eventId,
                    runId: event.runId,
                    type: event.type,
                    createdAt: event.createdAt,
                    sequence: event.sequence,
                    payload: sanitizePlanningTracePayload(event.type, event.payload),
                })),
                eventCount: page.totalCount,
                pageEventCount: page.events.length,
                traceComplete: page.nextCursor === null,
                nextCursor: page.nextCursor,
            };
        }
        catch (error) {
            if (error instanceof BridgeHttpError)
                throw error;
            throw new BridgeHttpError(503, "planning trace unavailable");
        }
        finally {
            store?.close();
        }
    }
    /**
     * Keep a local runtime's streaming assistant overlay on the same record ID as
     * the authoritative runtime transcript.  The runtime stores the partial
     * assistant in its final message slot before emitting message events, so the
     * mapping is available after syncRuntimeMessages().
     */
    runtimePartialRecordId(session) {
        if (!session.runtime || !session.partial)
            return undefined;
        const runtimeMessages = session.runtime.session.messages;
        const lastIndex = runtimeMessages.length - 1;
        const lastMessage = runtimeMessages[lastIndex];
        if (!isRecord(lastMessage) || lastMessage.role !== "assistant")
            return undefined;
        const recordId = session.runtimeMessageRecordIds[lastIndex];
        if (recordId === undefined || !session.messageRecords.some((record) => Number(record.id) === recordId)) {
            return undefined;
        }
        return recordId;
    }
    normalizeRuntimePartialId(session) {
        const recordId = this.runtimePartialRecordId(session);
        if (recordId !== undefined && session.partial)
            session.partial.id = recordId;
    }
    setRuntimePartial(session, message) {
        this.syncRuntimeMessages(session);
        const recordId = this.runtimePartialRecordId(session) ?? session.nextMessageId + 1;
        session.partial = { ...toLegacyMessage(message, recordId), partial: true };
        this.normalizeRuntimePartialId(session);
    }
    appendRecord(session, record) {
        const message = { ...record, id: ++session.nextMessageId };
        session.messageRecords.push(message);
        session.messageCount = session.messageRecords.length;
        this.normalizeRuntimePartialId(session);
        if (session.partial &&
            this.runtimePartialRecordId(session) === undefined &&
            Number(session.partial.id ?? 0) <= session.nextMessageId) {
            session.partial.id = session.nextMessageId + 1;
            session.partial.ts = Date.now() / 1000;
        }
        return message;
    }
    appendMessage(session, message) {
        if (typeof message === "object" && message !== null) {
            session.seenRuntimeMessages.add(message);
        }
        const legacy = toLegacyMessage(message, 0);
        if (legacy.role === "user" && session.pendingRuntimeUsers.length > 0) {
            const recordId = session.pendingRuntimeUsers.shift();
            const record = session.messageRecords.find((item) => item.id === recordId);
            if (record?.queued_status === "queued")
                record.queued_status = "delivered";
            return recordId;
        }
        delete legacy.id;
        return Number(this.appendRecord(session, legacy).id);
    }
    updateRuntimeMessageRecord(session, recordId, message) {
        const record = session.messageRecords.find((item) => item.id === recordId);
        const legacy = toLegacyMessage(message, recordId);
        if (!record || legacy.role === "user")
            return;
        const queuedStatus = record.queued_status;
        for (const key of Object.keys(record)) {
            if (key !== "id" && key !== "queued_status")
                delete record[key];
        }
        Object.assign(record, legacy);
        if (queuedStatus !== undefined)
            record.queued_status = queuedStatus;
    }
    syncRuntimeMessages(session) {
        if (session.managed)
            return;
        if (!session.runtime)
            return;
        const runtimeMessages = session.runtime.session.messages;
        if (runtimeMessages.length < session.runtimeMessageRefs.length) {
            // Compaction or a runtime reset removed messages. Rebuild the local transcript
            // from the authoritative runtime state instead of leaving stale records.
            session.messageRecords = [];
            session.messageCount = 0;
            session.nextMessageId = 0;
            session.runtimeMessageRecordIds = [];
            session.runtimeMessageRefs = [];
            session.seenRuntimeMessages = new WeakSet();
            session.syncedRuntimeMessageCount = 0;
        }
        // During streaming only the final runtime slot changes. Process new slots in
        // bulk, then refresh the tail in O(1) time instead of rescanning the transcript
        // for every token. A changed first slot indicates a same-length runtime reset;
        // rebuild that uncommon case completely.
        const runtimeReset = session.runtimeMessageRefs.length > 0 &&
            runtimeMessages.length >= session.runtimeMessageRefs.length &&
            runtimeMessages[0] !== session.runtimeMessageRefs[0];
        if (runtimeReset) {
            session.messageRecords = [];
            session.messageCount = 0;
            session.nextMessageId = 0;
            session.runtimeMessageRecordIds = [];
            session.runtimeMessageRefs = [];
            session.seenRuntimeMessages = new WeakSet();
            session.syncedRuntimeMessageCount = 0;
        }
        const firstUnsyncedIndex = Math.min(session.syncedRuntimeMessageCount, runtimeMessages.length);
        for (let index = firstUnsyncedIndex; index < runtimeMessages.length; index += 1) {
            const message = runtimeMessages[index];
            const appendedId = this.appendMessage(session, message);
            if (appendedId !== undefined)
                session.runtimeMessageRecordIds[index] = appendedId;
            if (typeof message === "object" && message !== null)
                session.seenRuntimeMessages.add(message);
            session.runtimeMessageRefs[index] = typeof message === "object" && message !== null ? message : undefined;
        }
        if (runtimeMessages.length > 0 && runtimeMessages.length <= session.runtimeMessageRefs.length) {
            const lastIndex = runtimeMessages.length - 1;
            const lastMessage = runtimeMessages[lastIndex];
            const lastRecordId = session.runtimeMessageRecordIds[lastIndex];
            if (lastRecordId !== undefined) {
                // Refresh even when the object identity is stable; custom runtimes may mutate
                // a partial message in place rather than replacing the array slot.
                this.updateRuntimeMessageRecord(session, lastRecordId, lastMessage);
            }
            session.runtimeMessageRefs[lastIndex] =
                typeof lastMessage === "object" && lastMessage !== null ? lastMessage : undefined;
        }
        session.syncedRuntimeMessageCount = runtimeMessages.length;
        session.messagesLoaded = true;
        // A custom runtime may emit message_start before publishing the new
        // transcript slot. The mapping is only available after the loop above;
        // normalize once more so the overlay cannot remain on a synthetic ID.
        this.normalizeRuntimePartialId(session);
    }
    loadSessionMessages(session) {
        if (session.runtime) {
            this.syncRuntimeMessages(session);
            return;
        }
        if (session.messagesLoaded || !session.sessionFile)
            return;
        try {
            const manager = SessionManager.open(session.sessionFile, undefined, session.cwd);
            for (const message of manager.buildSessionContext().messages)
                this.appendMessage(session, message);
        }
        catch (error) {
            session.lastError = error instanceof Error ? error.message : String(error);
        }
        session.messagesLoaded = true;
    }
    attachRuntime(session, runtime) {
        runtime.state.permissions.restoreSessionGrants(session.permissionSessionGrants);
        runtime.setMemoryReferenceEnabled(session.memoryReferenceEnabled);
        runtime.setKnowledgeBaseEnabled(session.knowledgeBaseEnabled);
        runtime.setWebVerbsEnabled(session.webVerbsEnabled);
        session.runtime = runtime;
        session.sessionManager = runtime.session.sessionManager;
        session.sessionFile = runtime.session.sessionFile ?? session.sessionFile;
        session.permissionMode = runtime.state.permissions.mode;
        if (runtime.config?.executionMode) {
            session.executionMode = runtime.config.executionMode.mode;
            session.executionCapacity = runtime.config.executionMode.capacity;
            session.legacyPlanningMode = runtime.config.executionMode.legacyPlanningMode;
        }
        session.title = runtime.session.sessionName || session.title;
        session.seenRuntimeMessages = new WeakSet();
        session.runtimeMessageRecordIds = [];
        session.runtimeMessageRefs = [];
        const availableModels = runtime.session.modelRuntime.getAvailableSnapshot();
        const selectedModel = runtime.session.model;
        const selectedIndex = selectedModel
            ? availableModels.findIndex((model) => model.provider === selectedModel.provider && model.id === selectedModel.id)
            : -1;
        if (selectedIndex >= 0)
            session.modelIndex = selectedIndex;
        if (session.messagesLoaded) {
            let recordIndex = 0;
            for (let index = 0; index < runtime.session.messages.length; index += 1) {
                const message = runtime.session.messages[index];
                if (typeof message === "object" && message !== null)
                    session.seenRuntimeMessages.add(message);
                const role = toLegacyMessage(message, 0).role;
                let matchingRecordIndex = recordIndex;
                while (matchingRecordIndex < session.messageRecords.length &&
                    session.messageRecords[matchingRecordIndex]?.role !== role) {
                    matchingRecordIndex += 1;
                }
                const recordId = session.messageRecords[matchingRecordIndex]?.id;
                if (typeof recordId === "number") {
                    session.runtimeMessageRecordIds[index] = recordId;
                    recordIndex = matchingRecordIndex + 1;
                }
                session.runtimeMessageRefs[index] = typeof message === "object" && message !== null ? message : undefined;
            }
            session.syncedRuntimeMessageCount = runtime.session.messages.length;
        }
        else {
            session.syncedRuntimeMessageCount = 0;
            this.syncRuntimeMessages(session);
        }
        session.unsubscribe = runtime.subscribe((event) => {
            if ("message" in event) {
                const associatedPlanningRunId = planningRunIdFromMessage(event.message);
                if (associatedPlanningRunId)
                    session.planningRunId = associatedPlanningRunId;
            }
            if (event.type === "message_start" && event.message.role === "assistant") {
                this.setRuntimePartial(session, event.message);
            }
            else if (event.type === "message_update" && event.message.role === "assistant") {
                this.setRuntimePartial(session, event.message);
            }
            else if (event.type === "message_end") {
                this.syncRuntimeMessages(session);
                const planningFailure = planningFailureMessage(event.message);
                if (planningFailure) {
                    if (planningFailure.runId)
                        session.planningRunId = planningFailure.runId;
                    session.failureSource = planningFailure.failureSource;
                    session.failureStage = planningFailure.failureStage;
                    session.failureCode = planningFailure.failureCode;
                    session.status = "error";
                    session.terminalReason =
                        session.failureCode === "verifier_quota_exhausted"
                            ? "verification_budget_exhausted"
                            : "planning_failed";
                    session.lastError =
                        contentText(isRecord(event.message) ? event.message.content : "") || "Planning failed";
                }
                if (event.message.role === "assistant")
                    session.partial = null;
            }
            else if (event.type === "session_info_changed" && event.name) {
                session.title = event.name;
            }
            else if (session.taskKind === "ctf" &&
                event.type === "tool_execution_end" &&
                (event.toolName === "verify_flag" || event.toolName === "check_flag") &&
                isRecord(event.result) &&
                isRecord(event.result.details) &&
                isRecord(event.result.details.data) &&
                event.result.details.data.verificationOutcome === "infra_error") {
                const data = event.result.details.data;
                const category = typeof data.failureCategory === "string" ? data.failureCategory : "verifier";
                session.failureSource = "verifier";
                session.failureStage = "verification";
                session.failureCode = verifierFailureCode(category);
                session.ctfContinuation.verifierInfraError = `Flag verifier infrastructure failure (${category}): ${typeof data.message === "string" ? data.message : "verification unavailable"}`;
            }
            else if ((runtime.state.competition?.verifiedSubmission || session.taskKind === "ctf") &&
                event.type === "tool_execution_end" &&
                (runtime.state.competition?.verifiedSubmission || acceptedNativeFlagVerification(event.toolName, event.isError, event.result)) &&
                session.verificationState !== "accepted") {
                session.terminalReason = "verified_true";
                session.verificationState = "accepted";
                session.ctfContinuation.verificationState = "accepted";
            }
            this.emitSession(session, event.type, event);
        });
        session.unsubscribePermission = runtime.state.permissionBroker.subscribe((request) => {
            const choices = Array.isArray(request.input.candidates)
                ? request.input.candidates.filter((item) => typeof item === "string")
                : [];
            this.appendRecord(session, {
                role: "permission",
                requestId: request.id,
                request_id: request.id,
                toolName: request.toolName,
                tool_name: request.toolName,
                title: request.toolName === "ask_user" ? request.message : "需要权限确认",
                detail: request.toolName === "ask_user" ? "" : jsonText(request.input),
                content: request.message,
                choices,
                status: "pending",
                ts: request.createdAt / 1000,
            });
            this.emitSession(session, "permission");
        });
    }
    recordExecutionModeSelected(session, mode) {
        session.executionMode = mode.mode;
        session.executionCapacity = mode.capacity;
        session.legacyPlanningMode = mode.legacyPlanningMode;
        this.emitSession(session, "execution_mode_selected", undefined, true, {
            mode: mode.mode,
            planningEnabled: mode.planningEnabled,
            capacity: mode.capacity,
            legacyPlanningMode: mode.legacyPlanningMode,
        });
    }
    acceptPlanningVerification(session, verification, context) {
        const reject = (reasonCode) => {
            this.emitSession(session, "planning_verification_rejected", undefined, true, {
                reasonCode,
                ...(typeof verification?.planningRunId === "string" ? { runId: verification.planningRunId } : {}),
                ...(typeof verification?.taskId === "string" ? { taskId: verification.taskId } : {}),
                ...(typeof verification?.evidenceId === "string" ? { evidenceId: verification.evidenceId } : {}),
            });
            return false;
        };
        const generation = context.bridgeRunGeneration;
        if (typeof generation !== "number" ||
            !Number.isSafeInteger(generation) ||
            generation !== session.runGeneration ||
            context.signal.aborted ||
            session.status !== "running" ||
            !this.isCurrentRun(session, generation)) {
            return reject("stale_execution");
        }
        const idsValid = [
            verification.planningRunId,
            verification.taskId,
            verification.leaseId,
            verification.evidenceId,
        ].every((value) => typeof value === "string" && value.trim().length > 0);
        if (session.taskKind !== "ctf" ||
            verification.source !== "planning_verifier_evidence" ||
            verification.verificationOutcome !== "correct" ||
            !idsValid ||
            !Number.isFinite(verification.evidenceCreatedAt)) {
            return reject(session.taskKind === "ctf" ? "invalid_trusted_verification" : "non_ctf_session");
        }
        if (!session.planningRunId)
            return reject("planning_run_identity_missing");
        if (session.planningRunId !== verification.planningRunId) {
            return reject("planning_run_identity_mismatch");
        }
        const trustedChallengeId = session.trustedTaskIdentity?.challengeId;
        if (session.requireTrustedChallengeId && !trustedChallengeId)
            return reject("trusted_challenge_identity_missing");
        if (trustedChallengeId && verification.challengeId !== trustedChallengeId) {
            return reject("challenge_identity_mismatch");
        }
        const prior = session.trustedPlanningVerification;
        if (prior) {
            const duplicate = prior.planningRunId === verification.planningRunId &&
                prior.taskId === verification.taskId &&
                prior.leaseId === verification.leaseId &&
                prior.evidenceId === verification.evidenceId &&
                prior.evidenceCreatedAt === verification.evidenceCreatedAt &&
                prior.challengeId === verification.challengeId;
            return duplicate ? true : reject("conflicting_trusted_verification");
        }
        session.planningRunId = verification.planningRunId;
        session.trustedPlanningVerification = { ...verification };
        session.terminalReason = "verified_true";
        session.verificationState = "accepted";
        session.ctfContinuation.verificationState = "accepted";
        this.emitSession(session, "planning_verification_accepted", undefined, true, {
            runId: verification.planningRunId,
            taskId: verification.taskId,
            leaseId: verification.leaseId,
            evidenceId: verification.evidenceId,
            verificationOutcome: verification.verificationOutcome,
            source: verification.source,
        });
        return true;
    }
    emitSession(session, event, source, updateRecency = true, extraDetails = {}) {
        this.syncRuntimeMessages(session);
        const eventTimestamp = Date.now() / 1000;
        if (updateRecency)
            session.updatedAt = eventTimestamp;
        if (!OMITTED_RUNTIME_EVENTS.has(event)) {
            session.runtimeEvents.push({
                id: ++session.runtimeEventSeq,
                event,
                state: session.status,
                timestamp: eventTimestamp,
                messageCount: session.messageRecords.length,
                ...(source ? runtimeEventDetails(source) : {}),
                ...extraDetails,
            });
            if (session.runtimeEvents.length > MAX_RUNTIME_EVENTS) {
                session.runtimeEvents.splice(0, session.runtimeEvents.length - MAX_RUNTIME_EVENTS);
            }
        }
        const payload = {
            type: "session-state",
            sessionId: session.id,
            role: session.role ?? "local",
            title: session.title,
            taskId: session.taskId ?? null,
            category: session.category ?? null,
            state: session.status,
            event,
            seq: session.nextMessageId,
            updatedAt: session.updatedAt,
            permissionRequests: this.permissionSnapshot(session),
        };
        if (OMITTED_RUNTIME_EVENTS.has(event)) {
            this.pendingSessionEvents.set(session.id, payload);
            this.scheduleSessionEventFlush(session.id);
            return;
        }
        this.flushSessionEvent(session.id);
        this.broadcast(payload);
    }
    permissionSnapshot(session) {
        if (session.managed?.snapshot?.permissionRequests) {
            return session.managed.snapshot.permissionRequests.map((request) => ({
                ...request,
                createdAt: request.createdAt / 1000,
            }));
        }
        return (session.runtime?.state.permissionBroker.list() ?? []).map((request) => ({
            requestId: request.id,
            toolName: request.toolName,
            args: request.input,
            message: request.message,
            status: "pending",
            createdAt: request.createdAt / 1000,
            choices: Array.isArray(request.input.candidates)
                ? request.input.candidates.filter((choice) => typeof choice === "string")
                : [],
        }));
    }
    scheduleSessionEventFlush(sessionId) {
        if (this.sessionEventTimers.has(sessionId))
            return;
        const timer = setTimeout(() => {
            this.sessionEventTimers.delete(sessionId);
            this.flushSessionEvent(sessionId);
        }, SESSION_EVENT_FLUSH_MS);
        this.sessionEventTimers.set(sessionId, timer);
    }
    flushSessionEvent(sessionId) {
        const timer = this.sessionEventTimers.get(sessionId);
        if (timer)
            clearTimeout(timer);
        this.sessionEventTimers.delete(sessionId);
        const payload = this.pendingSessionEvents.get(sessionId);
        if (!payload)
            return;
        this.pendingSessionEvents.delete(sessionId);
        this.broadcast(payload);
    }
    cancelQueuedPrompts(session) {
        for (const prompt of session.queue) {
            const message = session.messageRecords.find((item) => item.id === prompt.userMessageId);
            if (message?.queued_status === "queued")
                message.queued_status = "cancelled";
        }
        session.queue.length = 0;
    }
    async selectRuntimeModel(session, modelIndex, runtime) {
        const activeRuntime = runtime ?? (await this.ensureRuntime(session));
        const models = activeRuntime.session.modelRuntime.getAvailableSnapshot();
        const model = models[modelIndex];
        if (!model)
            throw new BridgeHttpError(400, `model was not found: ${modelIndex}`);
        await activeRuntime.session.setModel(model);
        session.modelIndex = modelIndex;
        return { provider: model.provider, model: model.id };
    }
    async modelProfiles() {
        const activeSession = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
        let models;
        let selectedProvider = "";
        let selectedModel = "";
        if (activeSession?.runtime && !this.closedSessionIds.has(activeSession.id)) {
            models = activeSession.runtime.session.modelRuntime.getAvailableSnapshot();
            selectedProvider = activeSession.runtime.session.model?.provider ?? "";
            selectedModel = activeSession.runtime.session.model?.id ?? "";
        }
        else {
            const config = loadSecHeurConfig({ projectRoot: this.projectRoot, env: this.env });
            const runtime = await ModelRuntime.create({
                authPath: join(config.agentDir, "auth.json"),
                modelsPath: join(config.agentDir, "models.json"),
                allowModelNetwork: false,
            });
            models = runtime.getAvailableSnapshot();
        }
        return models.map((model, llmNo) => ({
            id: llmNo,
            llmNo,
            name: `${model.provider}/${model.id}`,
            provider: model.provider,
            model: model.id,
            active: model.provider === selectedProvider && model.id === selectedModel,
        }));
    }
    async createDesktopMainSession(input = {}) {
        if (!this.mainWorkflow) throw new Error("Main workflow unavailable");
        return this.createSession(input, true, "main");
    }
    async resumeDesktopMainSession(id) {
        if (!this.mainWorkflow) throw new Error("Main workflow unavailable");
        if (!this.sessions.get(id)) await this.discoverPersistedSessions();
        const session = this.sessions.get(id);
        if (!session) return undefined;
        session.internalKind = "main";
        session.desktopSolverBinding = undefined;
        session.title = "Main Agent";
        this.closedSessionIds.delete(id);
        this.activeSessionId = id;
        this.preferredSessionId = id;
        this.persistBridgeState();
        this.emitSession(session, "resumed");
        return session;
    }
    async createDesktopSolverSession(input, binding) {
        return this.createSessionInternal(input, false, "solver", undefined, binding);
    }
    async promptDesktopSession(id, text) {
        const session = await this.getSession(id);
        if (session.status === "running") throw new Error("Session is already running");
        const normalized = normalizePromptPayload({prompt:text,displayPrompt:text}, join(this.uploadRoot,id));
        const record = this.appendRecord(session,{role:"user",content:text,ts:Date.now()/1000});
        this.schedulePrompt(session,{...normalized,userMessageId:Number(record.id),webVerbsEnabled:false,queued:false,source:"user"});
    }
    async waitDesktopSession(id) {
        const session = await this.getSession(id);
        await session.runner;
        return {status:session.status,lastError:session.lastError};
    }
    async guideDesktopSession(id, message) {
        const session = await this.getSession(id);
        if (session.status === "running") await session.runtime?.session.steer(message);
        else await this.promptDesktopSession(id,message);
    }
    async abortDesktopSession(id) {
        const session = await this.getSession(id);
        await session.runtime?.abort("Stopped by Main Agent");
        await session.runner;
    }
    async desktopSessionState(id) {
        const session = await this.getSession(id);
        return {status:session.status,lastError:session.lastError};
    }
    async createSession(input, activate = true, internalKind, sessionManager) {
        const releaseAcquisition = this.beginSessionAcquisition();
        try {
            return await this.createSessionInternal(input, activate, internalKind, sessionManager);
        }
        finally {
            releaseAcquisition();
        }
    }
    async createSessionInternal(input, activate, internalKind, sessionManager, trustedBinding) {
        const requestedCwd = typeof input.cwd === "string" ? input.cwd : typeof input.path === "string" ? input.path : this.projectRoot;
        const cwd = resolve(requestedCwd);
        const desktopConfig = readDesktopConfig(this.projectRoot);
        const effectiveConfig = loadSecHeurConfig({ projectRoot: this.projectRoot, env: this.env });
        if (input.planningEngine !== undefined && !isPlanningEngine(input.planningEngine))
            throw new BridgeHttpError(400, "planningEngine must be progressive, cairn or hypothesis");
        const planningEngine = input.planningEngine ??
            (isPlanningEngine(desktopConfig.newSessionPlanningEngine)
                ? desktopConfig.newSessionPlanningEngine
                : (effectiveConfig.planning.engine ?? "progressive"));
        const requestedMode = input.permissionMode ?? input.permission_mode ?? desktopConfig.permissionMode;
        const mode = typeof requestedMode === "string" ? requestedMode : undefined;
        if (mode && !VALID_PERMISSION_MODES.has(mode))
            throw new BridgeHttpError(400, `invalid permission mode: ${mode}`);
        const requestedModelIndex = optionalModelIndex(input);
        const savedModelIndex = Number(desktopConfig.llmNo);
        const modelIndex = requestedModelIndex ??
            (Number.isSafeInteger(savedModelIndex) && savedModelIndex >= 0 ? savedModelIndex : undefined);
        const memorySetting = input.memoryReferenceEnabled ?? input.memory_reference_enabled;
        const memoryReferenceEnabled = typeof memorySetting === "boolean"
            ? memorySetting
            : typeof desktopConfig.memoryReferenceEnabled === "boolean"
                ? desktopConfig.memoryReferenceEnabled
                : true;
        const knowledgeBaseSetting = input.knowledgeBaseEnabled ?? input.knowledge_base_enabled;
        const knowledgeBaseEnabled = typeof knowledgeBaseSetting === "boolean" ? knowledgeBaseSetting : effectiveConfig.knowledgeBaseEnabled;
        const persist = sessionManager ? sessionManager.isPersisted() : input.persist !== false;
        const requestedTaskKind = typeof input.taskKind === "string"
            ? input.taskKind
            : typeof input.task_kind === "string"
                ? input.task_kind
                : null;
        const requestedTargetId = typeof input.targetId === "string"
            ? input.targetId.trim()
            : typeof input.target_id === "string"
                ? input.target_id.trim()
                : "";
        const requestedRunId = typeof input.runId === "string"
            ? input.runId.trim()
            : typeof input.run_id === "string"
                ? input.run_id.trim()
                : "";
        const trustedTaskIdentity = {
            ...(requestedTargetId ? { challengeId: requestedTargetId } : {}),
            ...(requestedRunId ? { runId: requestedRunId } : {}),
        };
        const requireTrustedChallengeId = requestedTaskKind === "ctf";
        const requestedInteractionMode = typeof input.interactionMode === "string"
            ? input.interactionMode
            : typeof input.interaction_mode === "string"
                ? input.interaction_mode
                : null;
        const requestedExecutionMode = typeof input.executionMode === "string"
            ? input.executionMode
            : typeof input.execution_mode === "string"
                ? input.execution_mode
                : undefined;
        const requestedExecutionCapacity = typeof input.executionCapacity === "number" && Number.isInteger(input.executionCapacity)
            ? input.executionCapacity
            : typeof input.execution_capacity === "number" && Number.isInteger(input.execution_capacity)
                ? input.execution_capacity
                : undefined;
        const requestedMaxTurns = typeof input.maxTurns === "number" && Number.isInteger(input.maxTurns)
            ? input.maxTurns
            : typeof input.max_turns === "number" && Number.isInteger(input.max_turns)
                ? input.max_turns
                : undefined;
        const ctfContinuation = {
            taskKind: requestedTaskKind,
            verificationState: "not_attempted",
            consecutiveNoToolTurns: 0,
        };
        let createdSession;
        const runtime = await createSecHeurRuntime({
            projectRoot: this.projectRoot,
            cwd,
            permissionMode: mode,
            mode: "print",
            persist,
            sessionManager,
            knowledgeBaseEnabled,
            env: this.env,
            ctfContinuation,
            mainWorkflow: internalKind === "main" ? this.mainWorkflow : undefined,
            competition: trustedBinding,
            ...(requestedTaskKind === "ctf"
                ? {
                    trustedTaskIdentity,
                    requireTrustedChallengeId,
                }
                : {}),
            executionMode: requestedExecutionMode,
            planningEngine,
            executionCapacity: requestedExecutionCapacity,
            onExecutionModeSelected: (mode) => {
                if (createdSession)
                    this.recordExecutionModeSelected(createdSession, mode);
            },
            getBridgeRunGeneration: () => createdSession?.runGeneration,
            onTrustedPlanningVerification: (verification, context) => createdSession ? this.acceptPlanningVerification(createdSession, verification, context) : false,
            ...(this.competitionPromise && (!this.mainWorkflow || internalKind === "main")
                ? {
                    competitionCoordinator: new CompetitionCoordinatorBinding({
                        socketPath: this.competitionSocketPath,
                        clientId: `bridge:${this.projectRoot}:${cwd}`,
                    }),
                }
                : {}),
        });
        try {
            const id = runtime.session.sessionId;
            const now = Date.now() / 1000;
            const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : "New chat";
            runtime.session.setSessionName(title);
            const session = {
                id,
                internalKind,
                desktopSolverBinding: trustedBinding,
                planningEngine,
                title,
                cwd,
                createdAt: now,
                updatedAt: now,
                status: "idle",
                lastError: "",
                runGeneration: 0,
                unsubscribe: () => { },
                unsubscribePermission: () => { },
                queue: [],
                pendingRuntimeUsers: [],
                messageCount: 0,
                messageRecords: [],
                messagesLoaded: false,
                nextMessageId: 0,
                seenRuntimeMessages: new WeakSet(),
                syncedRuntimeMessageCount: 0,
                runtimeMessageRecordIds: [],
                runtimeMessageRefs: [],
                partial: null,
                sessionFile: runtime.session.sessionFile,
                sessionManager: runtime.session.sessionManager,
                persist,
                permissionMode: runtime.state.permissions.mode,
                modelIndex: 0,
                memoryReferenceEnabled,
                knowledgeBaseEnabled,
                webVerbsEnabled: false,
                permissionSessionGrants: new Set(),
                runtimeEvents: [],
                runtimeEventSeq: 0,
                taskKind: requestedTaskKind,
                interactionMode: requestedInteractionMode,
                ...(runtime.config?.executionMode
                    ? {
                        executionMode: runtime.config.executionMode.mode,
                        executionCapacity: runtime.config.executionMode.capacity,
                        legacyPlanningMode: runtime.config.executionMode.legacyPlanningMode,
                        ...(requestedExecutionMode !== undefined
                            ? { executionModeOverride: runtime.config.executionMode.mode }
                            : {}),
                        ...(requestedExecutionCapacity !== undefined
                            ? { executionCapacityOverride: requestedExecutionCapacity }
                            : {}),
                    }
                    : {}),
                planningRunId: null,
                ...(requestedTaskKind === "ctf"
                    ? {
                        trustedTaskIdentity,
                        requireTrustedChallengeId,
                    }
                    : {}),
                terminalReason: null,
                verificationState: "not_attempted",
                cancelSource: null,
                cancelReason: null,
                cancelAt: null,
                preCancelStatus: null,
                pauseSource: null,
                pauseReason: null,
                pauseAt: null,
                prePauseStatus: null,
                watchdogPhase: null,
                watchdogLastActivityAt: null,
                modelContinuationCount: 0,
                ctfContinuation,
            };
            createdSession = session;
            const selectedMode = runtime.config?.executionMode ?? effectiveConfig.executionMode;
            session.executionModeOverride = selectedMode.mode;
            session.executionCapacityOverride = selectedMode.capacity;
            this.attachRuntime(session, runtime);
            if (requestedMaxTurns !== undefined && session.runtime)
                session.runtime.config.maxTurns = requestedMaxTurns;
            if (modelIndex !== undefined) {
                try {
                    await this.selectRuntimeModel(session, modelIndex, runtime);
                }
                catch (error) {
                    if (requestedModelIndex !== undefined)
                        throw error;
                }
            }
            this.sessions.set(id, session);
            this.sessionPlanningEngines.set(id, planningEngine);
            this.sessionExecutionModes.set(id, { mode: selectedMode.mode, capacity: selectedMode.capacity });
            this.closedSessionIds.delete(id);
            if (activate) {
                this.activeSessionId = id;
                this.preferredSessionId = id;
                this.persistBridgeState();
            }
            this.emitSession(session, "created");
            return session;
        }
        catch (error) {
            runtime.dispose();
            throw error;
        }
    }
    async discoverPersistedSessions() {
        const config = loadSecHeurConfig({ projectRoot: this.projectRoot, env: this.env });
        const root = join(config.agentDir, "sessions");
        const directories = [root];
        try {
            for (const entry of readdirSync(root, { withFileTypes: true })) {
                if (entry.isDirectory())
                    directories.push(join(root, entry.name));
            }
        }
        catch {
            return;
        }
        const infos = (await Promise.all(directories.map((directory) => SessionManager.listAll(directory))))
            .flat()
            .filter((info) => !isOfflineSelfTestArtifact(info));
        const desktopConfig = readDesktopConfig(this.projectRoot);
        const memoryReferenceEnabled = desktopConfig.memoryReferenceEnabled !== false;
        const knowledgeBaseEnabled = config.knowledgeBaseEnabled;
        infos.sort((left, right) => right.modified.getTime() - left.modified.getTime());
        const discoveredIds = new Set();
        for (const info of infos) {
            discoveredIds.add(info.id);
            const title = info.name || (info.firstMessage === "(no messages)" ? "New chat" : info.firstMessage.slice(0, 80));
            const existing = this.sessions.get(info.id);
            if (existing) {
                const modifiedAt = info.modified.getTime() / 1000;
                const persistedContentChanged = existing.sessionFile !== info.path ||
                    existing.persistedModifiedAt !== modifiedAt ||
                    existing.persistedMessageCount !== info.messageCount ||
                    existing.persistedName !== info.name;
                if (!existing.runtime && !existing.runtimePromise) {
                    existing.title = title;
                    existing.cwd = info.cwd || existing.cwd || this.projectRoot;
                    existing.createdAt = info.created.getTime() / 1000;
                    existing.updatedAt = Math.max(existing.updatedAt, modifiedAt);
                    existing.sessionFile = info.path;
                    if (persistedContentChanged) {
                        existing.sessionManager = undefined;
                        existing.messageCount = info.messageCount;
                        existing.messageRecords = [];
                        existing.messagesLoaded = false;
                        existing.nextMessageId = 0;
                        existing.seenRuntimeMessages = new WeakSet();
                        existing.syncedRuntimeMessageCount = 0;
                        existing.runtimeMessageRecordIds = [];
                        existing.runtimeMessageRefs = [];
                        existing.partial = null;
                        existing.lastError = "";
                    }
                }
                existing.persistedModifiedAt = modifiedAt;
                existing.persistedMessageCount = info.messageCount;
                existing.persistedName = info.name;
                continue;
            }
            this.sessions.set(info.id, this.sessionFromInfo(info, title, config.permissionMode, memoryReferenceEnabled, knowledgeBaseEnabled));
        }
        for (const id of this.closedSessionIds) {
            if (!discoveredIds.has(id) && !this.sessions.has(id))
                this.closedSessionIds.delete(id);
        }
        if (this.activeSessionId && this.sessions.get(this.activeSessionId)?.internalKind === "scheduler") {
            this.activeSessionId = undefined;
        }
        if (this.preferredSessionId &&
            this.sessions.has(this.preferredSessionId) &&
            !this.closedSessionIds.has(this.preferredSessionId) &&
            this.sessions.get(this.preferredSessionId)?.internalKind !== "scheduler") {
            this.activeSessionId = this.preferredSessionId;
        }
        else if (!this.activeSessionId) {
            this.activeSessionId = infos.find((info) => !this.closedSessionIds.has(info.id) && this.sessions.get(info.id)?.internalKind !== "scheduler")?.id;
        }
    }
    async discoverManagedSessions() {
        if (this.managedDiscoveryPromise)
            return this.managedDiscoveryPromise;
        const operation = this.refreshManagedSessions();
        this.managedDiscoveryPromise = operation;
        try {
            await operation;
        }
        finally {
            if (this.managedDiscoveryPromise === operation)
                this.managedDiscoveryPromise = undefined;
        }
    }
    async refreshManagedSessions() {
        const config = loadSecHeurConfig({ projectRoot: this.projectRoot, env: this.env });
        // Main and bridge may run in different PID namespaces, so process liveness cannot
        // be used to prune registrations here. Socket attachment is the authoritative check.
        const registrations = await listSessionRegistrations(config.stateDir, {
            pruneStale: true,
            verifyProcess: false,
        });
        const knownIds = new Set(registrations.map((registration) => registration.sessionId));
        for (const sessionId of this.managedRegistrations.keys()) {
            if (!knownIds.has(sessionId))
                this.managedRegistrations.delete(sessionId);
        }
        for (const registration of registrations) {
            this.managedRegistrations.set(registration.sessionId, registration);
            const existing = this.sessions.get(registration.sessionId);
            if (existing?.managed) {
                existing.role = registration.role;
                existing.title = registration.title;
                existing.taskId = registration.taskId;
                existing.category = registration.category;
                existing.parentMainSessionId = registration.parentMainSessionId;
                existing.tmuxTarget = registration.tmuxTarget;
                existing.knowledgeBaseEnabled = managedKnowledgeBaseEnabled(registration, config.knowledgeBaseEnabled);
                existing.managed.registration = registration;
                continue;
            }
            if (!existing) {
                this.sessions.set(registration.sessionId, this.managedSessionPlaceholder(registration, config.knowledgeBaseEnabled));
            }
            else {
                existing.role = registration.role;
                existing.title = registration.title;
                existing.taskId = registration.taskId;
                existing.category = registration.category;
                existing.parentMainSessionId = registration.parentMainSessionId;
                existing.tmuxTarget = registration.tmuxTarget;
                existing.knowledgeBaseEnabled = managedKnowledgeBaseEnabled(registration, config.knowledgeBaseEnabled);
                if (!existing.managed) {
                    existing.status =
                        registration.status === "running" ? "running" : registration.status === "error" ? "error" : "idle";
                    existing.updatedAt = registration.updatedAt / 1000;
                }
            }
        }
        for (const [sessionId, session] of this.sessions) {
            if (knownIds.has(sessionId))
                continue;
            if (session.managed) {
                await this.closeManagedSession(session);
                this.sessions.delete(sessionId);
                this.managedRegistrations.delete(sessionId);
            }
            else if (this.managedOnly && session.role) {
                this.sessions.delete(sessionId);
                this.managedRegistrations.delete(sessionId);
            }
        }
        if (this.managedOnly) {
            const activeSessionId = this.activeSessionId;
            const activeSession = activeSessionId ? this.sessions.get(activeSessionId) : undefined;
            if (!activeSession || this.closedSessionIds.has(activeSessionId ?? "")) {
                this.activeSessionId =
                    (this.preferredSessionId && knownIds.has(this.preferredSessionId)
                        ? this.preferredSessionId
                        : registrations.find((registration) => registration.role === "main" && knownIds.has(registration.sessionId))?.sessionId) ??
                        registrations.find((registration) => knownIds.has(registration.sessionId))?.sessionId;
            }
        }
    }
    async connectManagedSession(registration) {
        const pending = this.managedConnectionPromises.get(registration.sessionId);
        if (pending)
            return pending;
        const operation = this.connectManagedSessionNow(registration);
        this.managedConnectionPromises.set(registration.sessionId, operation);
        void operation.then(() => {
            if (this.managedConnectionPromises.get(registration.sessionId) === operation)
                this.managedConnectionPromises.delete(registration.sessionId);
        }, () => {
            if (this.managedConnectionPromises.get(registration.sessionId) === operation)
                this.managedConnectionPromises.delete(registration.sessionId);
        });
        return operation;
    }
    managedSessionPlaceholder(registration, fallbackKnowledgeBaseEnabled = loadSecHeurConfig({
        projectRoot: this.projectRoot,
        env: this.env,
    }).knowledgeBaseEnabled) {
        const status = registration.status === "running" ? "running" : registration.status === "error" ? "error" : "idle";
        return {
            id: registration.sessionId,
            role: registration.role,
            title: registration.title,
            cwd: registration.cwd,
            createdAt: registration.createdAt / 1000,
            updatedAt: registration.updatedAt / 1000,
            status,
            lastError: "",
            taskId: registration.taskId,
            category: registration.category,
            parentMainSessionId: registration.parentMainSessionId,
            tmuxTarget: registration.tmuxTarget,
            runGeneration: 0,
            unsubscribe: () => { },
            unsubscribePermission: () => { },
            queue: [],
            pendingRuntimeUsers: [],
            messageCount: 0,
            messageRecords: [],
            messagesLoaded: true,
            nextMessageId: 0,
            seenRuntimeMessages: new WeakSet(),
            syncedRuntimeMessageCount: 0,
            runtimeMessageRecordIds: [],
            runtimeMessageRefs: [],
            partial: null,
            persist: false,
            permissionMode: "default",
            modelIndex: 0,
            memoryReferenceEnabled: true,
            knowledgeBaseEnabled: managedKnowledgeBaseEnabled(registration, fallbackKnowledgeBaseEnabled),
            webVerbsEnabled: false,
            permissionSessionGrants: new Set(),
            runtimeEvents: [],
            runtimeEventSeq: 0,
            taskKind: null,
            interactionMode: null,
            planningRunId: null,
            terminalReason: null,
            verificationState: "not_attempted",
            cancelSource: null,
            cancelReason: null,
            cancelAt: null,
            preCancelStatus: null,
            pauseSource: null,
            pauseReason: null,
            pauseAt: null,
            prePauseStatus: null,
            watchdogPhase: null,
            watchdogLastActivityAt: null,
            modelContinuationCount: 0,
            ctfContinuation: {
                taskKind: null,
                verificationState: "not_attempted",
                consecutiveNoToolTurns: 0,
            },
        };
    }
    async connectManagedSessionNow(registration) {
        const existing = this.sessions.get(registration.sessionId);
        if (existing?.managed) {
            if (existing.managed.client.connected && existing.managed.lease.active)
                return existing;
            await this.closeManagedSession(existing);
        }
        const config = loadSecHeurConfig({ projectRoot: this.projectRoot, env: this.env });
        const knowledgeBaseEnabled = managedKnowledgeBaseEnabled(registration, config.knowledgeBaseEnabled);
        let lastError;
        for (const socketPath of managedSocketCandidates(registration, config.stateDir)) {
            let client;
            let lease;
            try {
                client = new PiClient({
                    transportFactory: createUnixTransportFactory({ path: socketPath }),
                });
                await withTimeout(client.connect(), MANAGED_SESSION_CONNECT_TIMEOUT_MS, `managed session connection timed out: ${registration.sessionId}`);
                lease = await withTimeout(client.attachSession(registration.sessionId), MANAGED_SESSION_CONNECT_TIMEOUT_MS, `managed session attach timed out: ${registration.sessionId}`);
                const initial = lease.snapshot;
                if (!initial)
                    throw new Error(`Managed session did not return a snapshot: ${registration.sessionId}`);
                const session = existing ?? {
                    id: registration.sessionId,
                    role: registration.role,
                    title: registration.title,
                    cwd: registration.cwd,
                    createdAt: registration.createdAt / 1000,
                    updatedAt: registration.updatedAt / 1000,
                    status: "idle",
                    lastError: "",
                    runGeneration: 0,
                    unsubscribe: () => { },
                    unsubscribePermission: () => { },
                    queue: [],
                    pendingRuntimeUsers: [],
                    messageCount: 0,
                    messageRecords: [],
                    messagesLoaded: true,
                    nextMessageId: 0,
                    seenRuntimeMessages: new WeakSet(),
                    syncedRuntimeMessageCount: 0,
                    runtimeMessageRecordIds: [],
                    runtimeMessageRefs: [],
                    partial: null,
                    persist: false,
                    permissionMode: "default",
                    modelIndex: 0,
                    memoryReferenceEnabled: true,
                    knowledgeBaseEnabled,
                    webVerbsEnabled: false,
                    permissionSessionGrants: new Set(),
                    runtimeEvents: [],
                    runtimeEventSeq: 0,
                    taskKind: null,
                    interactionMode: null,
                    planningRunId: null,
                    terminalReason: null,
                    verificationState: "not_attempted",
                    cancelSource: null,
                    cancelReason: null,
                    cancelAt: null,
                    preCancelStatus: null,
                    pauseSource: null,
                    pauseReason: null,
                    pauseAt: null,
                    prePauseStatus: null,
                    watchdogPhase: null,
                    watchdogLastActivityAt: null,
                    modelContinuationCount: 0,
                    ctfContinuation: {
                        taskKind: null,
                        verificationState: "not_attempted",
                        consecutiveNoToolTurns: 0,
                    },
                };
                session.role = registration.role;
                session.taskId = registration.taskId;
                session.category = registration.category;
                session.parentMainSessionId = registration.parentMainSessionId;
                session.tmuxTarget = registration.tmuxTarget;
                session.knowledgeBaseEnabled = knowledgeBaseEnabled;
                session.managed = {
                    client,
                    lease,
                    registration,
                    snapshot: initial,
                    unsubscribeSnapshot: () => { },
                    unsubscribeEvent: () => { },
                };
                session.managed.unsubscribeSnapshot = lease.subscribe((snapshot) => {
                    this.updateManagedSnapshot(session, snapshot, false);
                    this.emitSession(session, "remote-snapshot");
                });
                session.managed.unsubscribeEvent = lease.onEvent((event) => {
                    if (event.type === "session_progress") {
                        session.runtimeEvents.push({
                            id: ++session.runtimeEventSeq,
                            event: "remote-progress",
                            timestamp: Date.now() / 1000,
                            progress: event.progress,
                        });
                        if (session.runtimeEvents.length > MAX_RUNTIME_EVENTS)
                            session.runtimeEvents.splice(0, session.runtimeEvents.length - MAX_RUNTIME_EVENTS);
                        this.emitSession(session, "remote-progress");
                    }
                });
                this.sessions.set(session.id, session);
                this.updateManagedSnapshot(session, initial, false);
                return session;
            }
            catch (error) {
                lastError = error;
                // 候选路径可能已经完成握手或获取 lease，尝试下一个主机/挂载路径前必须全部释放。
                await lease?.dispose().catch(() => undefined);
                await client?.dispose().catch(() => undefined);
            }
        }
        const placeholder = this.sessions.get(registration.sessionId);
        if (placeholder && !placeholder.managed) {
            placeholder.status = "error";
            placeholder.lastError = lastError instanceof Error ? lastError.message : String(lastError);
        }
        return undefined;
    }
    updateManagedSnapshot(session, snapshot, includeMessages = true) {
        if (!session.managed)
            return;
        session.managed.snapshot = snapshot;
        session.title = session.managed.registration.title || snapshot.name || session.title;
        session.cwd = snapshot.cwd;
        session.createdAt = snapshot.createdAt / 1000;
        session.updatedAt = snapshot.updatedAt / 1000;
        session.status = snapshot.phase === "idle" ? "idle" : "running";
        session.lastError = "";
        // Keep summary cursors current without materializing the remote transcript for
        // background Solvers. The selected session can request the full page on demand.
        session.messageCount = snapshot.transcript.length;
        session.nextMessageId = snapshot.transcript.length;
        if (!includeMessages)
            return;
        session.messageRecords = snapshot.transcript.map((item, index) => {
            const record = {
                id: index + 1,
                role: item.role === "tool" ? "toolResult" : item.role,
                content: contentText(item.content),
                ts: item.timestamp / 1000,
            };
            Object.assign(record, safeThinkingFields(item.content));
            if (item.role === "assistant") {
                record.status = item.status;
                if (item.status !== "streaming")
                    record.stopReason = item.stopReason;
                const toolCalls = legacyToolCalls(item.content);
                if (toolCalls.length > 0)
                    record.toolCalls = toolCalls;
            }
            if (item.role === "tool") {
                record.toolCallId = item.toolCallId;
                record.toolName = item.toolName;
                record.isError = item.isError;
            }
            return record;
        });
        session.messageCount = session.messageRecords.length;
        session.nextMessageId = session.messageRecords.length;
        const streaming = snapshot.transcript.at(-1);
        session.partial =
            streaming?.role === "assistant" && streaming.status === "streaming"
                ? { ...session.messageRecords.at(-1), partial: true }
                : null;
        session.messagesLoaded = true;
    }
    async closeManagedSession(session) {
        const managed = session.managed;
        if (!managed)
            return;
        managed.unsubscribeSnapshot();
        managed.unsubscribeEvent();
        await managed.lease.dispose().catch(() => undefined);
        await managed.client.dispose().catch(() => undefined);
        session.managed = undefined;
    }
    async promptManagedSession(session, body) {
        const managed = session.managed;
        if (!managed)
            throw new BridgeHttpError(503, "managed session is disconnected");
        const normalized = normalizePromptPayload(body, join(this.uploadRoot, session.id));
        const text = normalized.displayPrompt.trim();
        if (!text)
            throw new BridgeHttpError(400, "prompt is required for a managed session");
        const force = body.force === true || body.interruptRunning === true;
        let snapshot = managed.lease.snapshot;
        const wasRunning = snapshot?.phase !== "idle";
        if (force && wasRunning)
            snapshot = await managed.lease.abort();
        const queued = !force && wasRunning;
        session.status = "running";
        this.emitSession(session, queued ? "remote-steer" : "remote-prompt");
        const operation = queued ? managed.lease.steer(text) : managed.lease.prompt(text);
        void operation
            .then((next) => {
            this.updateManagedSnapshot(session, next);
            this.emitSession(session, "remote-complete");
        })
            .catch((error) => {
            session.status = "error";
            session.lastError = error instanceof Error ? error.message : String(error);
            this.emitSession(session, "remote-error");
        });
        return {
            ok: true,
            accepted: true,
            queued,
            interrupted: force && wasRunning,
            sessionId: session.id,
            userMessageId: session.nextMessageId + 1,
            seq: session.nextMessageId,
        };
    }
    sessionFromInfo(info, title, permissionMode, memoryReferenceEnabled, knowledgeBaseEnabled) {
        return {
            id: info.id,
            planningEngine: this.sessionPlanningEngines.get(info.id),
            executionMode: this.sessionExecutionModes.get(info.id)?.mode,
            executionModeOverride: this.sessionExecutionModes.get(info.id)?.mode,
            executionCapacity: this.sessionExecutionModes.get(info.id)?.capacity,
            executionCapacityOverride: this.sessionExecutionModes.get(info.id)?.capacity,
            ...(title === "定时任务" ? { internalKind: "scheduler" } : {}),
            title,
            cwd: info.cwd || this.projectRoot,
            createdAt: info.created.getTime() / 1000,
            updatedAt: info.modified.getTime() / 1000,
            status: this.closedSessionIds.has(info.id) ? "closed" : "idle",
            lastError: "",
            runGeneration: 0,
            unsubscribe: () => { },
            unsubscribePermission: () => { },
            queue: [],
            pendingRuntimeUsers: [],
            messageCount: info.messageCount,
            messageRecords: [],
            messagesLoaded: false,
            nextMessageId: 0,
            seenRuntimeMessages: new WeakSet(),
            syncedRuntimeMessageCount: 0,
            runtimeMessageRecordIds: [],
            runtimeMessageRefs: [],
            partial: null,
            sessionFile: info.path,
            persistedModifiedAt: info.modified.getTime() / 1000,
            persistedMessageCount: info.messageCount,
            persistedName: info.name,
            persist: true,
            permissionMode,
            modelIndex: 0,
            memoryReferenceEnabled,
            knowledgeBaseEnabled,
            webVerbsEnabled: false,
            permissionSessionGrants: new Set(),
            runtimeEvents: [],
            runtimeEventSeq: 0,
            taskKind: null,
            interactionMode: null,
            planningRunId: null,
            terminalReason: null,
            verificationState: "not_attempted",
            cancelSource: null,
            cancelReason: null,
            cancelAt: null,
            preCancelStatus: null,
            pauseSource: null,
            pauseReason: null,
            pauseAt: null,
            prePauseStatus: null,
            watchdogPhase: null,
            watchdogLastActivityAt: null,
            modelContinuationCount: 0,
            ctfContinuation: {
                taskKind: null,
                verificationState: "not_attempted",
                consecutiveNoToolTurns: 0,
            },
        };
    }
    async getSession(id, includeClosed = false) {
        await this.discoverManagedSessions();
        const registration = this.managedRegistrations.get(id);
        if (registration) {
            const managedSession = await this.connectManagedSession(registration);
            if (!managedSession)
                throw new BridgeHttpError(503, `managed session is not reachable: ${id}`);
            if (!includeClosed && this.closedSessionIds.has(id)) {
                throw new BridgeHttpError(404, `session not found: ${id}`);
            }
            return managedSession;
        }
        if (this.managedOnly) {
            const managedSession = this.sessions.get(id);
            if (!managedSession) {
                throw new BridgeHttpError(404, `session not found: ${id}`);
            }
            if (!managedSession || (!includeClosed && this.closedSessionIds.has(id))) {
                throw new BridgeHttpError(404, `session not found: ${id}`);
            }
            return managedSession;
        }
        const known = this.sessions.get(id);
        if (this.loadPersistedSessions && (!known || !known.runtime))
            await this.discoverPersistedSessions();
        const session = this.sessions.get(id);
        if (!session || (!includeClosed && this.closedSessionIds.has(id))) {
            throw new BridgeHttpError(404, `session not found: ${id}`);
        }
        return session;
    }
    async ensureRuntime(session) {
        if (session.runtime)
            return session.runtime;
        if (session.runtimePromise)
            return session.runtimePromise;
        const operation = createSecHeurRuntime({
            projectRoot: this.projectRoot,
            cwd: session.cwd,
            sessionFile: session.sessionFile,
            sessionManager: session.sessionManager,
            permissionMode: session.permissionMode,
            mode: "print",
            persist: session.persist,
            knowledgeBaseEnabled: session.knowledgeBaseEnabled,
            env: this.env,
            ctfContinuation: session.ctfContinuation,
            mainWorkflow: session.internalKind === "main" ? this.mainWorkflow : undefined,
            competition: session.desktopSolverBinding,
            planningEngine: session.planningEngine,
            trustedTaskIdentity: session.trustedTaskIdentity,
            requireTrustedChallengeId: session.requireTrustedChallengeId,
            onExecutionModeSelected: (mode) => this.recordExecutionModeSelected(session, mode),
            getBridgeRunGeneration: () => session.runGeneration,
            onTrustedPlanningVerification: (verification, context) => this.acceptPlanningVerification(session, verification, context),
            ...(session.executionModeOverride ? { executionMode: session.executionModeOverride } : {}),
            ...(session.executionCapacityOverride !== undefined
                ? { executionCapacity: session.executionCapacityOverride }
                : {}),
            ...(this.competitionPromise && (!this.mainWorkflow || session.internalKind === "main")
                ? {
                    competitionCoordinator: new CompetitionCoordinatorBinding({
                        socketPath: this.competitionSocketPath,
                        clientId: `bridge:${this.projectRoot}:${session.id}`,
                    }),
                }
                : {}),
        }).then((runtime) => {
            try {
                if (session.runtimePromise !== operation || session.status === "cancelled" || session.status === "paused")
                    throw new Error("Runtime creation superseded or cancelled");
                this.attachRuntime(session, runtime);
                return runtime;
            }
            catch (error) {
                runtime.dispose();
                throw error;
            }
        });
        session.runtimePromise = operation;
        try {
            return await operation;
        }
        finally {
            if (session.runtimePromise === operation)
                session.runtimePromise = undefined;
        }
    }
    replaceSessionMessagesFromRuntime(session) {
        session.messageRecords = [];
        session.messageCount = 0;
        session.nextMessageId = 0;
        session.seenRuntimeMessages = new WeakSet();
        session.syncedRuntimeMessageCount = 0;
        session.runtimeMessageRecordIds = [];
        session.runtimeMessageRefs = [];
        session.partial = null;
        session.messagesLoaded = false;
        this.syncRuntimeMessages(session);
    }
    async runIdleSessionCommand(session, event, operation) {
        if (session.status === "running" || session.runner) {
            throw new BridgeHttpError(409, "session is already running");
        }
        const previousTransition = session.transition;
        const transition = (async () => {
            if (previousTransition)
                await previousTransition;
            if (session.status === "running" || session.runner) {
                throw new BridgeHttpError(409, "session is already running");
            }
            return operation(await this.ensureRuntime(session));
        })();
        session.transition = transition;
        try {
            const result = await transition;
            session.lastError = "";
            this.emitSession(session, event);
            return result;
        }
        catch (error) {
            session.lastError = error instanceof Error ? error.message : String(error);
            this.emitSession(session, `${event}-error`);
            throw error;
        }
        finally {
            if (session.transition === transition)
                session.transition = undefined;
        }
    }
    async createForkedSession(source, runtime, entryId, position) {
        const sourceManager = runtime.session.sessionManager;
        if (!sourceManager.isPersisted() || !runtime.session.sessionFile) {
            throw new BridgeHttpError(409, "session must be persisted before it can be forked");
        }
        if (!existsSync(runtime.session.sessionFile)) {
            throw new BridgeHttpError(409, "wait for the first assistant response before forking this session");
        }
        let targetLeafId = sourceManager.getLeafId();
        let editorText;
        if (entryId) {
            const selectedEntry = sourceManager.getEntry(entryId);
            if (!selectedEntry)
                throw new BridgeHttpError(400, `session entry not found: ${entryId}`);
            if (position === "before") {
                if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
                    throw new BridgeHttpError(400, "fork entry must be a user message");
                }
                targetLeafId = selectedEntry.parentId;
                editorText = contentText(selectedEntry.message.content);
            }
            else {
                targetLeafId = selectedEntry.id;
            }
        }
        let forkManager;
        if (targetLeafId) {
            forkManager = SessionManager.open(runtime.session.sessionFile, sourceManager.getSessionDir(), source.cwd);
            if (!forkManager.createBranchedSession(targetLeafId)) {
                throw new BridgeHttpError(500, "failed to create forked session");
            }
        }
        else {
            forkManager = SessionManager.create(source.cwd, sourceManager.getSessionDir());
            forkManager.newSession({ parentSession: runtime.session.sessionFile });
        }
        const created = await this.createSession({
            cwd: source.cwd,
            title: `${source.title}${position === "at" ? " (clone)" : " (fork)"}`,
            llmNo: source.modelIndex,
            permissionMode: source.permissionMode,
            memoryReferenceEnabled: source.memoryReferenceEnabled,
            knowledgeBaseEnabled: source.knowledgeBaseEnabled,
            planningEngine: source.planningEngine,
            ...(source.executionModeOverride ? { executionMode: source.executionModeOverride } : {}),
            ...(source.executionCapacityOverride !== undefined
                ? { executionCapacity: source.executionCapacityOverride }
                : {}),
        }, true, undefined, forkManager);
        return { session: created, ...(editorText ? { editorText } : {}) };
    }
    async releaseRuntime(session, reason, abort, abortGraceMs, abortReason) {
        abortGraceMs ??= ABORT_GRACE_MS;
        const abortDeadline = Date.now() + abortGraceMs;
        let runtime = session.runtime;
        if (!runtime && session.runtimePromise) {
            try {
                const pending = session.runtimePromise;
                if (!(await boundedAbort(pending, abortGraceMs))) {
                    session.runtimePromise = undefined;
                    return;
                }
                runtime = await pending;
            }
            catch {
                return;
            }
        }
        if (!runtime)
            return;
        abortGraceMs = Math.max(0, abortDeadline - Date.now());
        if (abort) {
            try {
                const abortOperation = runtime.abort(abortReason);
                if (abortGraceMs === undefined) {
                    await abortOperation;
                }
                else {
                    let timer;
                    try {
                        await Promise.race([
                            abortOperation,
                            new Promise((resolvePromise) => {
                                timer = setTimeout(resolvePromise, abortGraceMs);
                            }),
                        ]);
                    }
                    finally {
                        if (timer)
                            clearTimeout(timer);
                    }
                }
            }
            catch {
                // Runtime disposal below remains authoritative.
            }
        }
        this.syncRuntimeMessages(session);
        session.permissionMode = runtime.state.permissions.mode;
        for (const signature of runtime.state.permissions.sessionGrantSignatures) {
            session.permissionSessionGrants.add(signature);
        }
        runtime.state.permissionBroker.cancelAll(reason);
        // Preserve the shared ledger before cancellation disposes the runtime.
        session.settledTurnCount = runtime.state.operationalGuard?.turnsUsed ?? runtime.state.getTurnCount();
        session.settledToolCallCount = runtime.state.operationalGuard?.toolCallsUsed ?? session.settledToolCallCount;
        session.unsubscribe();
        session.unsubscribePermission();
        session.unsubscribe = () => { };
        session.unsubscribePermission = () => { };
        runtime.dispose();
        if (session.runtime === runtime)
            session.runtime = undefined;
        session.runtimePromise = undefined;
    }
    async invalidateRuntimes(reason) {
        const operations = [];
        for (const session of this.sessions.values()) {
            if (this.closedSessionIds.has(session.id) || (!session.runtime && !session.runtimePromise))
                continue;
            session.runtimeStaleReason = reason;
            if (session.status === "running" || session.runner)
                continue;
            const previous = session.transition;
            const operation = (async () => {
                if (previous) {
                    try {
                        await previous;
                    }
                    catch {
                        // 前一个 transition 会单独报告错误；配置刷新仍需继续。
                    }
                }
                if (session.status === "running" || session.runner)
                    return;
                const staleReason = session.runtimeStaleReason;
                if (!staleReason)
                    return;
                await this.releaseRuntime(session, staleReason, false);
                if (session.runtimeStaleReason === staleReason)
                    session.runtimeStaleReason = undefined;
            })();
            session.transition = operation;
            operations.push(operation.finally(() => {
                if (session.transition === operation)
                    session.transition = undefined;
            }));
        }
        await Promise.all(operations);
        return [...this.sessions.values()].filter((session) => Boolean(session.runtimeStaleReason)).length;
    }
    runPluginMutation(operation) {
        const result = this.pluginMutationTail.then(operation);
        this.pluginMutationTail = result.then(() => undefined, () => undefined);
        return result;
    }
    isCurrentRun(session, generation) {
        return (this.sessions.has(session.id) && !this.closedSessionIds.has(session.id) && session.runGeneration === generation);
    }
    schedulerIsBusy() {
        const active = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
        if (active?.status === "running")
            return true;
        const schedulerSession = this.schedulerSessionId ? this.sessions.get(this.schedulerSessionId) : undefined;
        return Boolean(schedulerSession &&
            (schedulerSession.status === "running" || schedulerSession.runner || schedulerSession.transition));
    }
    async submitSchedulerPrompt(task, onDone) {
        if (this.schedulerIsBusy())
            throw new Error("Scheduler session is busy");
        let session = this.schedulerSessionId ? this.sessions.get(this.schedulerSessionId) : undefined;
        if (!session || this.closedSessionIds.has(session.id)) {
            session = await this.createSession({ cwd: this.projectRoot, title: "定时任务", persist: true }, false, "scheduler");
            this.schedulerSessionId = session.id;
        }
        if (this.schedulerIsBusy())
            throw new Error("Scheduler session is busy");
        const normalized = normalizePromptPayload({ prompt: task, displayPrompt: task }, join(this.uploadRoot, session.id));
        const userMessage = this.appendRecord(session, {
            role: "user",
            content: normalized.displayPrompt,
            source: "scheduler",
            ts: Date.now() / 1000,
        });
        this.schedulePrompt(session, {
            ...normalized,
            userMessageId: Number(userMessage.id),
            webVerbsEnabled: false,
            queued: false,
            source: "scheduler",
            onDone,
        });
        return session.id;
    }
    schedulePrompt(session, prompt, preparation) {
        const previous = session.transition ?? session.runner;
        const generation = ++session.runGeneration;
        if (prompt.queued) {
            const message = session.messageRecords.find((item) => item.id === prompt.userMessageId);
            if (message?.queued_status === "queued")
                message.queued_status = "delivered";
        }
        session.status = "running";
        session.lastError = "";
        session.planningRunId = null;
        session.failureSource = null;
        session.failureStage = null;
        session.failureCode = null;
        session.watchdogPhase = "model-first-output";
        session.watchdogLastActivityAt = Date.now() / 1000;
        session.modelContinuationCount = 0;
        this.emitSession(session, "running");
        const operation = (async () => {
            let preparationError;
            if (preparation) {
                try {
                    await preparation;
                }
                catch (error) {
                    preparationError = error;
                }
            }
            if (previous) {
                try {
                    await previous;
                }
                catch (error) {
                    preparationError ??= error;
                }
            }
            if (!this.isCurrentRun(session, generation))
                return;
            if (preparationError) {
                session.status = "error";
                session.lastError = preparationError instanceof Error ? preparationError.message : String(preparationError);
                this.cancelQueuedPrompts(session);
                this.emitSession(session, "error");
                return;
            }
            await this.runPrompt(session, prompt, generation);
        })();
        session.runner = operation;
        const clearRunner = () => {
            if (session.runner === operation)
                session.runner = undefined;
        };
        void operation.then(clearRunner, clearRunner);
    }
    async runPrompt(session, prompt, generation) {
        let pendingUser = false;
        try {
            const staleReason = session.runtimeStaleReason;
            if (staleReason) {
                await this.releaseRuntime(session, staleReason, false);
                if (session.runtimeStaleReason === staleReason)
                    session.runtimeStaleReason = undefined;
            }
            let runtime = await this.ensureRuntime(session);
            if (!this.isCurrentRun(session, generation))
                return;
            if (prompt.modelIndex !== undefined && prompt.modelIndex !== session.modelIndex) {
                await this.selectRuntimeModel(session, prompt.modelIndex, runtime);
            }
            session.webVerbsEnabled = prompt.webVerbsEnabled;
            runtime.setMemoryReferenceEnabled(session.memoryReferenceEnabled);
            runtime.setKnowledgeBaseEnabled(session.knowledgeBaseEnabled);
            runtime.setWebVerbsEnabled(prompt.webVerbsEnabled);
            const config = loadSecHeurConfig({ projectRoot: this.projectRoot, env: this.env });
            let runtimePrompt = prompt.prompt;
            let runtimeImages = prompt.images;
            let resumedOutput = "";
            let resumed = false;
            for (;;) {
                const messageOffset = runtime.session.messages.length;
                const recordOffset = session.messageRecords.length;
                if (!session.pendingRuntimeUsers.includes(prompt.userMessageId)) {
                    session.pendingRuntimeUsers.push(prompt.userMessageId);
                }
                pendingUser = true;
                try {
                    await this.promptWithWatchdog(session, runtime, runtimePrompt, runtimeImages, config);
                }
                catch (error) {
                    if (runtime.state.competition?.verifiedSubmission) {
                        session.status = "idle";
                        session.lastError = "";
                        session.terminalReason = "verified_true";
                        session.verificationState = "accepted";
                        session.ctfContinuation.verificationState = "accepted";
                        break;
                    }
                    if (!(error instanceof BridgePromptTimeoutError))
                        throw error;
                    if (!this.isCurrentRun(session, generation))
                        return;
                    const streamedPartial = isRecord(session.partial) && typeof session.partial.content === "string"
                        ? session.partial.content
                        : "";
                    await this.releaseRuntime(session, "SecHeur model output timed out", true, TIMED_OUT_RUNTIME_ABORT_GRACE_MS, "host_watchdog");
                    if (!this.isCurrentRun(session, generation))
                        return;
                    const persistedPartial = lastAssistantText(runtime.session.messages.slice(messageOffset));
                    const partialText = persistedPartial.length >= streamedPartial.length ? persistedPartial : streamedPartial;
                    if (partialText &&
                        !session.messageRecords
                            .slice(recordOffset)
                            .some((message) => message.role === "assistant" && contentText(message.content).includes(partialText))) {
                        this.appendRecord(session, {
                            role: "assistant",
                            content: partialText,
                            stopReason: "aborted",
                            interrupted: true,
                            ts: Date.now() / 1000,
                        });
                    }
                    session.partial = null;
                    if (error.kind === "model-stream-idle" && session.modelContinuationCount < MAX_MODEL_CONTINUATIONS) {
                        resumed = true;
                        session.modelContinuationCount += 1;
                        resumedOutput = continuedAssistantText(resumedOutput, partialText);
                        this.emitSession(session, "output-timeout-retry");
                        runtime = await this.ensureRuntime(session);
                        if (!this.isCurrentRun(session, generation))
                            return;
                        runtime.setMemoryReferenceEnabled(session.memoryReferenceEnabled);
                        runtime.setKnowledgeBaseEnabled(session.knowledgeBaseEnabled);
                        runtime.setWebVerbsEnabled(prompt.webVerbsEnabled);
                        runtimePrompt =
                            "上一轮模型输出在中途停止，请继续完成原任务，不要重复已输出的内容。\n" +
                                `原始请求：\n${prompt.prompt}\n\n` +
                                `已输出的部分内容：\n${partialText}`;
                        runtimeImages = undefined;
                        continue;
                    }
                    const message = terminalTimeoutMessage(error, resumed);
                    session.status = "error";
                    session.lastError = message;
                    this.appendRecord(session, {
                        role: "error",
                        content: message,
                        source: prompt.source,
                        ts: Date.now() / 1000,
                    });
                    break;
                }
                this.syncRuntimeMessages(session);
                if (!this.isCurrentRun(session, generation))
                    return;
                const turnMessages = runtime.session.messages.slice(messageOffset);
                const promptError = lastAssistantError(turnMessages);
                if (runtime.state.competition?.verifiedSubmission) {
                    session.status = "idle";
                    session.lastError = "";
                    session.terminalReason = "verified_true";
                } else if (session.terminalReason === "planning_failed" && session.failureSource === "planning") {
                    session.status = "error";
                }
                else if (promptError) {
                    session.status = "error";
                    session.lastError = promptError;
                }
                else {
                    if (session.taskKind === "ctf") {
                        session.terminalReason =
                            session.verificationState === "accepted"
                                ? "verified_true"
                                : session.ctfContinuation.verificationAttemptsRemaining === 0
                                    ? "verification_budget_exhausted"
                                    : runtime.getBudgetStatus().reason === "maxTurns"
                                        ? "max_turns"
                                        : runtime.getBudgetStatus().reason === "maxCost"
                                            ? "max_cost"
                                            : "unverified_idle";
                    }
                    session.status = "idle";
                    if (prompt.onDone) {
                        try {
                            const answer = continuedAssistantText(resumedOutput, lastAssistantText(turnMessages));
                            await prompt.onDone(answer || "(completed)");
                        }
                        catch (error) {
                            this.appendRecord(session, {
                                role: "error",
                                content: `定时任务完成回调失败：${error instanceof Error ? error.message : String(error)}`,
                                source: prompt.source,
                                ts: Date.now() / 1000,
                            });
                        }
                    }
                }
                break;
            }
        }
        catch (error) {
            if (!this.isCurrentRun(session, generation))
                return;
            session.status = "error";
            session.lastError = error instanceof Error ? error.message : String(error);
            if (isPlanningFailureError(error)) {
                session.failureSource = error.source;
                session.failureStage = error.stage;
                session.failureCode = error.code;
                session.terminalReason =
                    session.failureCode === "verifier_quota_exhausted" ? "verification_budget_exhausted" : "planning_failed";
            }
            else if (session.runtime?.getBudgetStatus?.()?.stopped) {
                session.status = "idle";
                session.terminalReason = session.runtime.getBudgetStatus().reason === "maxCost" ? "max_cost" : "max_turns";
            }
        }
        finally {
            if (pendingUser) {
                const index = session.pendingRuntimeUsers.indexOf(prompt.userMessageId);
                if (index >= 0)
                    session.pendingRuntimeUsers.splice(index, 1);
            }
            if (this.isCurrentRun(session, generation)) {
                const staleReason = session.runtimeStaleReason;
                if (staleReason) {
                    try {
                        await this.releaseRuntime(session, staleReason, false);
                        if (session.runtimeStaleReason === staleReason)
                            session.runtimeStaleReason = undefined;
                    }
                    catch (error) {
                        session.status = "error";
                        session.lastError = error instanceof Error ? error.message : String(error);
                    }
                }
                this.emitSession(session, session.status);
                if (session.status === "idle") {
                    const next = session.queue.shift();
                    if (next)
                        this.schedulePrompt(session, next);
                }
                else {
                    this.cancelQueuedPrompts(session);
                }
            }
        }
    }
    async promptWithWatchdog(session, runtime, prompt, images, config) {
        let timer;
        let rejectTimeout = () => { };
        const timeout = new Promise((_resolve, reject) => {
            rejectTimeout = reject;
        });
        const arm = (kind, timeoutMs) => {
            if (timer)
                clearTimeout(timer);
            session.watchdogPhase =
                kind === "first-output"
                    ? "model-first-output"
                    : kind === "tool-stalled"
                        ? "tool-execution"
                        : "model-stream";
            session.watchdogLastActivityAt = Date.now() / 1000;
            timer = setTimeout(() => rejectTimeout(new BridgePromptTimeoutError(kind, timeoutMs)), timeoutMs);
        };
        const suspendForPlanning = () => {
            if (timer)
                clearTimeout(timer);
            timer = undefined;
            session.watchdogPhase = "planning";
            session.watchdogLastActivityAt = Date.now() / 1000;
        };
        const unsubscribe = runtime.subscribe((event) => {
            switch (event.type) {
                case "agent_settled":
                    if (runtime.state.commandTasks?.pendingCount) {
                        if (timer)
                            clearTimeout(timer);
                        timer = undefined;
                    }
                    break;
                case "agent_start":
                    arm("first-output", config.agentFirstOutputTimeoutMs);
                    break;
                case "tool_execution_start":
                case "tool_execution_update":
                case "bash_execution_update":
                    arm("tool-stalled", config.agentOutputIdleTimeoutMs);
                    break;
                case "tool_execution_end":
                    arm("model-stream-idle", config.agentOutputIdleTimeoutMs);
                    break;
                case "message_start":
                case "message_update":
                case "message_end":
                    if (event.message.role === "custom" &&
                        ["progressive-planning-goal", "cairn-planning-goal", "hypothesis-planning-goal"].includes(event.message.customType)) {
                        suspendForPlanning();
                    }
                    else if (event.message.role === "custom" &&
                        ["progressive-planning-result", "hypothesis-planning-result"].includes(event.message.customType)) {
                        arm("first-output", config.agentFirstOutputTimeoutMs);
                    }
                    else if (event.message.role === "assistant") {
                        arm("model-stream-idle", config.agentOutputIdleTimeoutMs);
                    }
                    break;
                case "auto_retry_start":
                case "auto_retry_end":
                case "compaction_start":
                case "compaction_end":
                case "summarization_retry_scheduled":
                case "summarization_retry_attempt_start":
                case "summarization_retry_finished":
                    arm("model-stream-idle", config.agentOutputIdleTimeoutMs);
                    break;
            }
        });
        arm("first-output", config.agentFirstOutputTimeoutMs);
        try {
            await Promise.race([runtime.prompt(prompt, { images }), timeout]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
            unsubscribe();
        }
    }
    async handleRequest(request, response) {
        if (this.closing) {
            sendJson(response, { error: "SecHeur bridge is closing" }, 503);
            return;
        }
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (!isAllowedRequestOrigin(request)) {
            sendJson(response, { error: "origin is not allowed" }, 403);
            return;
        }
        if (request.headers.origin) {
            response.setHeader("Access-Control-Allow-Origin", request.headers.origin);
            response.setHeader("Vary", "Origin");
        }
        if (request.method === "OPTIONS") {
            response.writeHead(204, responseHeaders());
            response.end();
            return;
        }
        const path = url.pathname;
        if (path === "/events" && request.method === "GET") {
            this.handleSse(request, response, url);
            return;
        }
        const body = request.method === "POST" ? await parseBody(request) : {};
        if (path === "/status" && request.method === "GET") {
            await this.discoverManagedSessions();
            sendJson(response, {
                ok: true,
                running: true,
                ready: true,
                ...projectPayload(this.projectRoot),
                managedSessions: this.managedOnly,
                sessionCount: this.sessions.size,
                activeSessionId: this.activeSessionId ?? null,
                ws: "/ws",
                events: "/events",
                transport: { http: true, wsEventsOnly: true, sse: true },
            });
            return;
        }
        if (path === "/competition" && request.method === "GET") {
            if (this.managedOnly) {
                sendJson(response, sanitizeTraceValue(await this.managedCompetitionRequest("status")));
                return;
            }
            const competition = await this.getCompetition();
            sendJson(response, sanitizeTraceValue(competition.status()));
            return;
        }
        if (path === "/competition/sync" && request.method === "POST") {
            if (this.managedOnly) {
                sendJson(response, sanitizeTraceValue(await this.managedCompetitionRequest("sync")));
                return;
            }
            const competition = await this.getCompetition();
            sendJson(response, sanitizeTraceValue(await competition.sync()));
            return;
        }
        if (path === "/competition/events" && request.method === "GET") {
            if (this.managedOnly) {
                const taskId = url.searchParams.get("taskId") ?? "";
                sendJson(response, sanitizeTraceValue(await this.managedCompetitionRequest("list_events", { taskId, limit: 500 })));
                return;
            }
            const competition = await this.getCompetition();
            const taskId = url.searchParams.get("taskId") ?? undefined;
            sendJson(response, sanitizeTraceValue(competition.store.listEvents(taskId)));
            return;
        }
        if (path === "/competition/tasks" && request.method === "GET") {
            if (this.managedOnly) {
                sendJson(response, sanitizeTraceValue(await this.managedCompetitionRequest("list_tasks")));
                return;
            }
            const competition = await this.getCompetition();
            sendJson(response, sanitizeTraceValue(competition.listTasks()));
            return;
        }
        if (path === "/competition/plan" && request.method === "GET") {
            if (this.managedOnly) {
                sendJson(response, sanitizeTraceValue(await this.managedCompetitionRequest("get_plan")));
                return;
            }
            const competition = await this.getCompetition();
            sendJson(response, sanitizeTraceValue({ plan: competition.getPlan() ?? null, tasks: competition.listTasks() }));
            return;
        }
        if (path === "/competition/plan" && request.method === "POST") {
            if (this.managedOnly) {
                const taskIds = Array.isArray(body.taskIds)
                    ? body.taskIds.filter((value) => typeof value === "string")
                    : [];
                const rationale = typeof body.rationale === "string" ? body.rationale : "";
                if (taskIds.length === 0 || !rationale.trim())
                    throw new BridgeHttpError(400, "taskIds and rationale are required");
                sendJson(response, sanitizeTraceValue(await this.managedCompetitionRequest("set_plan", {
                    taskIds,
                    rationale,
                    ...(typeof body.generatedBy === "string" ? { generatedBy: body.generatedBy } : {}),
                    ...(typeof body.expectedRevision === "number" ? { expectedRevision: body.expectedRevision } : {}),
                })));
                return;
            }
            const competition = await this.getCompetition();
            const taskIds = Array.isArray(body.taskIds)
                ? body.taskIds.filter((value) => typeof value === "string")
                : Array.isArray(body.task_ids)
                    ? body.task_ids.filter((value) => typeof value === "string")
                    : [];
            const rationale = typeof body.rationale === "string" ? body.rationale : "";
            if (taskIds.length === 0 || !rationale.trim())
                throw new BridgeHttpError(400, "taskIds and rationale are required");
            const result = competition.setPlan({
                taskIds,
                rationale,
                ...(typeof body.generatedBy === "string" ? { generatedBy: body.generatedBy } : {}),
                ...(typeof body.expectedRevision === "number" ? { expectedRevision: body.expectedRevision } : {}),
            });
            sendJson(response, sanitizeTraceValue(result));
            return;
        }
        if (path === "/competition/plan" && request.method === "DELETE") {
            if (this.managedOnly) {
                sendJson(response, sanitizeTraceValue(await this.managedCompetitionRequest("clear_plan")));
                return;
            }
            const competition = await this.getCompetition();
            sendJson(response, sanitizeTraceValue(competition.clearPlan()));
            return;
        }
        const competitionTask = path.match(/^\/competition\/tasks\/([^/]+)(?:\/(stop|requeue|release-environment))?$/u);
        if (competitionTask && request.method === "GET" && !competitionTask[2]) {
            if (this.managedOnly) {
                const task = await this.managedCompetitionRequest("get_task", {
                    taskId: decodeURIComponent(competitionTask[1]),
                });
                if (!task)
                    throw new BridgeHttpError(404, "competition task not found");
                sendJson(response, sanitizeTraceValue(task));
                return;
            }
            const competition = await this.getCompetition();
            const task = competition.getTask(decodeURIComponent(competitionTask[1]));
            if (!task)
                throw new BridgeHttpError(404, "competition task not found");
            sendJson(response, sanitizeTraceValue(task));
            return;
        }
        if (competitionTask && request.method === "POST" && competitionTask[2]) {
            if (this.managedOnly) {
                const taskId = decodeURIComponent(competitionTask[1]);
                if (competitionTask[2] === "stop") {
                    sendJson(response, sanitizeTraceValue(await this.managedCompetitionRequest("stop_task", {
                        taskId,
                        reason: typeof body.reason === "string" ? body.reason : "Stopped by operator",
                    })));
                    return;
                }
                if (competitionTask[2] === "requeue") {
                    sendJson(response, sanitizeTraceValue(await this.managedCompetitionRequest("requeue_tasks", {
                        taskIds: [taskId],
                        ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
                    })));
                    return;
                }
                const task = (await this.managedCompetitionRequest("get_task", { taskId }));
                const lease = task && typeof task.environmentLeaseId === "string" ? task.environmentLeaseId : "";
                if (!lease)
                    throw new BridgeHttpError(404, "task has no active environment lease");
                sendJson(response, sanitizeTraceValue(await this.managedCompetitionRequest("release_environment", { leaseId: lease })));
                return;
            }
            const competition = await this.getCompetition();
            const taskId = decodeURIComponent(competitionTask[1]);
            if (competitionTask[2] === "stop") {
                const result = await competition.handleRequest({
                    protocol: "secheur.competition/v1",
                    version: 1,
                    type: "command",
                    requestId: `bridge-${Date.now()}`,
                    operation: "stop_task",
                    payload: { taskId, reason: typeof body.reason === "string" ? body.reason : "Stopped by operator" },
                });
                if (!result.ok)
                    throw new BridgeHttpError(409, result.error?.message ?? "competition task could not be stopped");
                sendJson(response, sanitizeTraceValue(result.result));
                return;
            }
            if (competitionTask[2] === "requeue") {
                const result = await competition.handleRequest({
                    protocol: "secheur.competition/v1",
                    version: 1,
                    type: "command",
                    requestId: `bridge-${Date.now()}`,
                    operation: "requeue_tasks",
                    payload: {
                        taskIds: [taskId],
                        ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
                    },
                });
                if (!result.ok)
                    throw new BridgeHttpError(409, result.error?.message ?? "competition task could not be requeued");
                sendJson(response, sanitizeTraceValue(result.result));
                return;
            }
            const task = competition.getTask(taskId);
            if (!task?.environmentLeaseId)
                throw new BridgeHttpError(404, "task has no active environment lease");
            const result = await competition.handleRequest({
                protocol: "secheur.competition/v1",
                version: 1,
                type: "command",
                requestId: `bridge-${Date.now()}`,
                operation: "release_environment",
                payload: { leaseId: task.environmentLeaseId },
            });
            if (!result.ok)
                throw new BridgeHttpError(409, result.error?.message ?? "environment could not be released");
            sendJson(response, sanitizeTraceValue(result.result));
            return;
        }
        if (path === "/worklist" && request.method === "GET") {
            if (this.managedOnly) {
                sendJson(response, sanitizeTraceValue(await this.managedWorklistSummary()));
                return;
            }
            const worklist = await this.getWorklist();
            sendJson(response, worklist.publicSummary());
            return;
        }
        if (path === "/worklist/start" && request.method === "POST") {
            if (this.managedOnly) {
                sendJson(response, sanitizeTraceValue(await this.managedWorklistSummary()));
                return;
            }
            const worklist = await this.getWorklist();
            await worklist.start();
            sendJson(response, worklist.publicSummary());
            return;
        }
        if (path === "/worklist/stop" && request.method === "POST") {
            if (this.managedOnly) {
                sendJson(response, sanitizeTraceValue(await this.managedWorklistSummary()));
                return;
            }
            const worklist = await this.getWorklist();
            await worklist.stop();
            sendJson(response, worklist.publicSummary());
            return;
        }
        if (path === "/worklist/sync" && request.method === "POST") {
            if (this.managedOnly) {
                sendJson(response, sanitizeTraceValue(await this.managedCompetitionRequest("sync")));
                return;
            }
            const worklist = await this.getWorklist();
            await worklist.refresh();
            sendJson(response, worklist.publicSummary());
            return;
        }
        const worklistRetry = path.match(/^\/worklist\/([^/]+)\/retry$/u);
        if (worklistRetry && request.method === "POST") {
            if (this.managedOnly)
                throw new BridgeHttpError(409, "Dispatch retries through the Main Agent chat");
            const worklist = await this.getWorklist();
            await worklist.retry(decodeURIComponent(worklistRetry[1]));
            sendJson(response, worklist.publicSummary());
            return;
        }
        const worklistGuide = path.match(/^\/worklist\/([^/]+)\/guide$/u);
        if (worklistGuide && request.method === "POST") {
            if (this.managedOnly) {
                await this.discoverManagedSessions();
                const taskId = decodeURIComponent(worklistGuide[1]);
                const solver = [...this.sessions.values()].find((candidate) => candidate.taskId === taskId && candidate.managed);
                const message = typeof body.message === "string" ? body.message : typeof body.prompt === "string" ? body.prompt : "";
                if (!solver) {
                    sendJson(response, {
                        taskId,
                        delivered: false,
                        status: "pending",
                        ...(await this.managedWorklistSummary()),
                    });
                    return;
                }
                await this.promptManagedSession(solver, { prompt: message });
                sendJson(response, { taskId, delivered: true, ...(await this.managedWorklistSummary()) });
                return;
            }
            const worklist = await this.getWorklist();
            const message = typeof body.message === "string" ? body.message : typeof body.prompt === "string" ? body.prompt : "";
            await worklist.guideItem(decodeURIComponent(worklistGuide[1]), message);
            sendJson(response, worklist.publicSummary());
            return;
        }
        const worklistStop = path.match(/^\/worklist\/([^/]+)\/stop$/u);
        if (worklistStop && request.method === "POST") {
            if (this.managedOnly) {
                await this.discoverManagedSessions();
                const taskId = decodeURIComponent(worklistStop[1]);
                const solver = [...this.sessions.values()].find((candidate) => candidate.taskId === taskId && candidate.managed);
                if (solver?.managed) {
                    const snapshot = await solver.managed.lease.abort();
                    this.updateManagedSnapshot(solver, snapshot);
                    this.emitSession(solver, "cancelled");
                }
                const result = await this.managedCompetitionRequest("stop_task", {
                    taskId,
                    reason: typeof body.reason === "string" ? body.reason : "Stopped by operator",
                });
                sendJson(response, { task: result, ...(await this.managedWorklistSummary()) });
                return;
            }
            const worklist = await this.getWorklist();
            await worklist.stopItem(decodeURIComponent(worklistStop[1]));
            sendJson(response, worklist.publicSummary());
            return;
        }
        if (path === "/planning/capacity" && (request.method === "GET" || request.method === "POST")) {
            if (request.method === "POST") {
                throw new BridgeHttpError(409, "Global executor limit is disabled; configure capacity for the individual session");
            }
            sendJson(response, { ok: true, enabled: false, scope: "per_run", capacity: null, persistent: false });
            return;
        }
        if (path === "/planning/options" && (request.method === "GET" || request.method === "POST")) {
            if (this.managedOnly)
                throw new BridgeHttpError(409, "PLAN selection is controlled by the session owner");
            if (request.method === "POST") {
                if (!isPlanningEngine(body.engine))
                    throw new BridgeHttpError(400, "invalid PLAN engine");
                const saved = readDesktopConfig(this.projectRoot);
                writeDesktopConfig(this.projectRoot, { ...saved, newSessionPlanningEngine: body.engine });
            }
            const config = loadSecHeurConfig({ projectRoot: this.projectRoot, env: this.env });
            const preferred = readDesktopConfig(this.projectRoot).newSessionPlanningEngine;
            sendJson(response, {
                engine: isPlanningEngine(preferred) ? preferred : config.planning.engine,
                engines: PLANNING_ENGINES,
                newSessionsOnly: true,
            });
            return;
        }
        if (path === "/config" && request.method === "GET") {
            const config = readDesktopConfig(this.projectRoot);
            sendJson(response, { ...projectPayload(this.projectRoot), config });
            return;
        }
        if (path === "/config" && request.method === "POST") {
            const config = isRecord(body.config) ? body.config : body;
            writeDesktopConfig(this.projectRoot, config);
            const effectiveConfig = loadSecHeurConfig({ projectRoot: this.projectRoot, env: this.env });
            for (const session of this.sessions.values()) {
                if (typeof config.memoryReferenceEnabled === "boolean") {
                    session.memoryReferenceEnabled = config.memoryReferenceEnabled;
                    session.runtime?.setMemoryReferenceEnabled(config.memoryReferenceEnabled);
                }
                if (typeof config.knowledgeBaseEnabled === "boolean") {
                    const registration = session.managed?.registration ?? this.managedRegistrations.get(session.id);
                    const enabled = registration
                        ? managedKnowledgeBaseEnabled(registration, effectiveConfig.knowledgeBaseEnabled)
                        : effectiveConfig.knowledgeBaseEnabled;
                    session.knowledgeBaseEnabled = enabled;
                    session.runtime?.setKnowledgeBaseEnabled(enabled);
                }
                if (session.status !== "running" &&
                    typeof config.permissionMode === "string" &&
                    VALID_PERMISSION_MODES.has(config.permissionMode)) {
                    session.permissionMode = config.permissionMode;
                    session.runtime?.setPermissionMode(session.permissionMode);
                }
            }
            const runtimeConfigChanged = [
                "judge",
                "maxTurns",
                "maxCost",
                "thinkingMode",
                "thinkingBudget",
                "attemptDedupEnabled",
                "knowledgeBaseEnabled",
                "customSkillDirectories",
            ].some((key) => key in config);
            const runtimeReloadPending = runtimeConfigChanged
                ? await this.invalidateRuntimes("Desktop config changed")
                : 0;
            sendJson(response, { ok: true, ...projectPayload(this.projectRoot), config, runtimeReloadPending });
            return;
        }
        if (path === "/api-config" && request.method === "GET") {
            sendJson(response, readApiConfig(this.projectRoot));
            return;
        }
        if (path === "/api-config" && request.method === "POST") {
            const saved = saveApiConfig(this.projectRoot, body);
            const runtimeReloadPending = await this.invalidateRuntimes("API config changed");
            sendJson(response, { ok: true, ...saved, runtimeReloadPending });
            return;
        }
        const apiConfigDelete = path.match(/^\/api-config\/([^/]+)$/u);
        if (apiConfigDelete && request.method === "DELETE") {
            const deleted = deleteApiConfig(this.projectRoot, decodeURIComponent(apiConfigDelete[1]));
            const runtimeReloadPending = await this.invalidateRuntimes("API config changed");
            sendJson(response, { ok: true, ...deleted, runtimeReloadPending });
            return;
        }
        if (path === "/api-config/models" && request.method === "POST") {
            sendJson(response, { ok: true, models: await fetchApiModels(this.projectRoot, body) });
            return;
        }
        if (path === "/api-config/test" && request.method === "POST") {
            sendJson(response, await testApiConfig(this.projectRoot, body));
            return;
        }
        if (path === "/mcp-config" && request.method === "POST") {
            const saved = saveMcpServer(this.projectRoot, body);
            writeRegistryState(this.projectRoot, { mcpServers: { [String(saved.name)]: true } });
            const runtimeReloadPending = await this.invalidateRuntimes("MCP config changed");
            sendJson(response, { ok: true, saved, ...this.registry(), runtimeReloadPending });
            return;
        }
        const mcpConfigDelete = path.match(/^\/mcp-config\/([^/]+)$/u);
        if (mcpConfigDelete && request.method === "DELETE") {
            const deleted = deleteMcpServer(this.projectRoot, decodeURIComponent(mcpConfigDelete[1]));
            clearRegistryState(this.projectRoot, "mcpServers", String(deleted.name));
            const runtimeReloadPending = await this.invalidateRuntimes("MCP config changed");
            sendJson(response, { ok: true, deleted, ...this.registry(), runtimeReloadPending });
            return;
        }
        if (path === "/skill-config" && request.method === "POST") {
            const saved = saveProjectSkill(this.projectRoot, body);
            writeRegistryState(this.projectRoot, { skills: { [String(saved.name)]: true } });
            const runtimeReloadPending = await this.invalidateRuntimes("Skill config changed");
            sendJson(response, { ok: true, saved, ...this.registry(), runtimeReloadPending });
            return;
        }
        const skillConfigDelete = path.match(/^\/skill-config\/([^/]+)$/u);
        if (skillConfigDelete && request.method === "DELETE") {
            const deleted = deleteProjectSkill(this.projectRoot, decodeURIComponent(skillConfigDelete[1]));
            clearRegistryState(this.projectRoot, "skills", String(deleted.name));
            const runtimeReloadPending = await this.invalidateRuntimes("Skill config changed");
            sendJson(response, { ok: true, deleted, ...this.registry(), runtimeReloadPending });
            return;
        }
        if (path === "/plugins/catalog" && request.method === "GET") {
            await this.pluginMutationTail;
            const config = loadSecHeurConfig({ projectRoot: this.projectRoot, env: this.env });
            sendJson(response, { ok: true, ...(await listUnifiedPluginCatalog(config)) });
            return;
        }
        if (path === "/plugins/catalog/toggle" && request.method === "POST") {
            const kind = String(body.kind ?? "");
            if (kind === "pi") {
                const plugins = await this.runPluginMutation(async () => {
                    const config = loadSecHeurConfig({ projectRoot: this.projectRoot, env: this.env });
                    return setPiPluginEnabled(config, body.source ?? body.id, body.scope, body.enabled);
                });
                const runtimeReloadPending = await this.invalidateRuntimes("Pi plugin state changed");
                const config = loadSecHeurConfig({ projectRoot: this.projectRoot, env: this.env });
                sendJson(response, {
                    ok: true,
                    ...plugins,
                    ...(await listUnifiedPluginCatalog(config)),
                    runtimeReloadPending,
                });
                return;
            }
            const id = String(body.id ?? body.source ?? "");
            if (id !== "progressive-planning" && id !== "cairn-planning" && id !== "hypothesis-planning") {
                throw new BridgeHttpError(400, `builtin plugin is not mutable: ${id || "unknown"}`);
            }
            const config = loadSecHeurConfig({ projectRoot: this.projectRoot, env: this.env });
            setBuiltinPlanningEnabled(config, body.enabled === true, id === "hypothesis-planning" ? "hypothesis" : id === "cairn-planning" ? "cairn" : "progressive");
            const runtimeReloadPending = await this.invalidateRuntimes("Planning mode changed");
            const updated = loadSecHeurConfig({ projectRoot: this.projectRoot, env: this.env });
            sendJson(response, {
                ok: true,
                ...(await listUnifiedPluginCatalog(updated)),
                runtimeReloadPending,
            });
            return;
        }
        if (path === "/plugins" && request.method === "GET") {
            await this.pluginMutationTail;
            const config = loadSecHeurConfig({ projectRoot: this.projectRoot, env: this.env });
            sendJson(response, { ok: true, ...(await listPiPlugins(config)) });
            return;
        }
        if (path === "/plugins/ui" && request.method === "GET") {
            await this.pluginMutationTail;
            const config = loadSecHeurConfig({ projectRoot: this.projectRoot, env: this.env });
            sendJson(response, { ok: true, ...listDesktopUiPlugins(config) });
            return;
        }
        const desktopUiAsset = path.match(/^\/plugins\/ui-assets\/([a-f0-9]{24})\/(styles|scripts)\/(\d+)$/u);
        if (desktopUiAsset && (request.method === "GET" || request.method === "HEAD")) {
            await this.pluginMutationTail;
            const config = loadSecHeurConfig({ projectRoot: this.projectRoot, env: this.env });
            const assetPath = resolveDesktopUiPluginAsset(config, desktopUiAsset[1], desktopUiAsset[2], Number(desktopUiAsset[3]));
            if (assetPath) {
                sendStaticFile(request, response, assetPath);
                return;
            }
            sendJson(response, { error: "plugin UI asset not found" }, 404);
            return;
        }
        if (path === "/plugins/install" && request.method === "POST") {
            const plugins = await this.runPluginMutation(async () => {
                const config = loadSecHeurConfig({ projectRoot: this.projectRoot, env: this.env });
                return installPiPlugin(config, body.source, body.scope);
            });
            const runtimeReloadPending = await this.invalidateRuntimes("Pi plugin installed");
            sendJson(response, { ok: true, ...plugins, runtimeReloadPending });
            return;
        }
        if (path === "/plugins/toggle" && request.method === "POST") {
            const plugins = await this.runPluginMutation(async () => {
                const config = loadSecHeurConfig({ projectRoot: this.projectRoot, env: this.env });
                return setPiPluginEnabled(config, body.source, body.scope, body.enabled);
            });
            const runtimeReloadPending = await this.invalidateRuntimes("Pi plugin state changed");
            sendJson(response, { ok: true, ...plugins, runtimeReloadPending });
            return;
        }
        if (path === "/plugins/update" && request.method === "POST") {
            const plugins = await this.runPluginMutation(async () => {
                const config = loadSecHeurConfig({ projectRoot: this.projectRoot, env: this.env });
                return updatePiPlugin(config, body.source, body.scope);
            });
            const runtimeReloadPending = await this.invalidateRuntimes("Pi plugin updated");
            sendJson(response, { ok: true, ...plugins, runtimeReloadPending });
            return;
        }
        if (path === "/plugins/remove" && request.method === "POST") {
            const plugins = await this.runPluginMutation(async () => {
                const config = loadSecHeurConfig({ projectRoot: this.projectRoot, env: this.env });
                return removePiPlugin(config, body.source, body.scope);
            });
            const runtimeReloadPending = await this.invalidateRuntimes("Pi plugin removed");
            sendJson(response, { ok: true, ...plugins, runtimeReloadPending });
            return;
        }
        if (path === "/agent-config" && request.method === "POST") {
            const saved = saveProjectAgent(this.projectRoot, body);
            writeRegistryState(this.projectRoot, { agents: { [String(saved.name)]: true } });
            const runtimeReloadPending = await this.invalidateRuntimes("Agent config changed");
            sendJson(response, { ok: true, saved, ...this.registry(), runtimeReloadPending });
            return;
        }
        const agentConfigDelete = path.match(/^\/agent-config\/([^/]+)$/u);
        if (agentConfigDelete && request.method === "DELETE") {
            const deleted = deleteProjectAgent(this.projectRoot, decodeURIComponent(agentConfigDelete[1]));
            clearRegistryState(this.projectRoot, "agents", String(deleted.name));
            const runtimeReloadPending = await this.invalidateRuntimes("Agent config changed");
            sendJson(response, { ok: true, deleted, ...this.registry(), runtimeReloadPending });
            return;
        }
        if (path === "/registry" && request.method === "GET") {
            sendJson(response, { ok: true, ...this.registry() });
            return;
        }
        if (path === "/registry" && request.method === "POST") {
            for (const key of ["mcpServers", "skills", "tools", "agents"]) {
                if (key in body && !isRecord(body[key])) {
                    throw new BridgeHttpError(400, `invalid object field: ${key}`);
                }
            }
            writeRegistryState(this.projectRoot, body);
            const runtimeReloadPending = await this.invalidateRuntimes("Registry changed");
            sendJson(response, { ok: true, ...this.registry(), runtimeReloadPending });
            return;
        }
        if (path === "/model-profiles" && request.method === "GET") {
            sendJson(response, { profiles: await this.modelProfiles() });
            return;
        }
        if (path === "/sessions/continuable" && request.method === "GET") {
            await this.discoverManagedSessions();
            if (!this.managedOnly && this.loadPersistedSessions)
                await this.discoverPersistedSessions();
            const includeSolvers = url.searchParams.get("includeSolvers") !== "false";
            sendJson(response, {
                sessions: orderedBridgeSessions(this.sessions.values())
                    .filter((session) => Boolean(session.sessionFile) &&
                    this.closedSessionIds.has(session.id) &&
                    (includeSolvers || session.role !== "solver"))
                    .map((session) => this.snapshot(session, false)),
            });
            return;
        }
        if (path === "/sessions" && request.method === "GET") {
            await this.discoverManagedSessions();
            if (!this.managedOnly && this.loadPersistedSessions)
                await this.discoverPersistedSessions();
            const includeSolvers = url.searchParams.get("includeSolvers") !== "false";
            sendJson(response, {
                sessions: orderedBridgeSessions(this.sessions.values())
                    .filter((session) => !this.closedSessionIds.has(session.id) && (includeSolvers || session.role !== "solver"))
                    .map((session) => this.snapshot(session, false)),
                activeSessionId: this.activeSessionId ?? null,
            });
            return;
        }
        if (path === "/session/new" && request.method === "POST") {
            await this.discoverManagedSessions();
            const hasOpenSession = [...this.sessions.values()].some((session) => !this.closedSessionIds.has(session.id));
            if (this.managedOnly && !hasOpenSession) {
                throw new BridgeHttpError(409, "The attach-only bridge is connected to the Main Agent TUI; select the existing Main Agent session instead of creating a new agent loop");
            }
            const session = await this.createSession(body);
            sendJson(response, { ok: true, sessionId: session.id, session: this.snapshot(session) }, 201);
            return;
        }
        const sessionMatch = path.match(/^\/session\/([^/]+)(?:\/(.*))?$/);
        if (sessionMatch) {
            const suffix = sessionMatch[2] ?? "";
            const session = await this.getSession(decodeURIComponent(sessionMatch[1]), suffix === "restore");
            if (suffix === "tools" && request.method === "GET") {
                if (session.managed) {
                    const tools = session.managed.registration.tools ?? [];
                    const activeTools = session.managed.registration.activeTools ?? tools;
                    sendJson(response, {
                        sessionId: session.id,
                        tools,
                        activeTools,
                    });
                    return;
                }
                const runtime = await this.ensureRuntime(session);
                sendJson(response, {
                    sessionId: session.id,
                    tools: runtime.session.getAllTools().map((tool) => tool.name),
                    activeTools: runtime.session.getActiveToolNames(),
                });
                return;
            }
            if (suffix === "planning/trace" && request.method === "GET") {
                sendJson(response, await this.planningTracePayload(session, url));
                return;
            }
            if (!suffix && request.method === "GET") {
                const snapshot = this.snapshot(session);
                sendJson(response, {
                    sessionId: session.id,
                    session: snapshot,
                    messages: snapshot.messages,
                    partial: snapshot.partial,
                });
                return;
            }
            if (!suffix && request.method === "DELETE") {
                if (session.managed) {
                    await this.closeManagedSession(session);
                    this.sessions.delete(session.id);
                    if (this.activeSessionId === session.id)
                        this.activeSessionId = undefined;
                    sendJson(response, { ok: true, sessionId: session.id, status: "detached", persistent: false });
                    return;
                }
                const persistent = Boolean(session.sessionFile);
                const wasRunning = session.status === "running";
                session.runGeneration += 1;
                session.status = "closed";
                session.planningRunId = null;
                this.cancelQueuedPrompts(session);
                session.partial = null;
                if (persistent)
                    this.closedSessionIds.add(session.id);
                else
                    this.sessions.delete(session.id);
                if (this.activeSessionId === session.id) {
                    this.activeSessionId = orderedBridgeSessions(this.sessions.values()).find((candidate) => !this.closedSessionIds.has(candidate.id) && candidate.internalKind !== "scheduler")?.id;
                }
                this.preferredSessionId = this.activeSessionId;
                this.persistBridgeState();
                this.emitSession(session, "closed");
                await this.releaseRuntime(session, "SecHeur session closed", wasRunning);
                sendJson(response, { ok: true, sessionId: session.id, status: "closed", persistent });
                return;
            }
            if (suffix === "restore" && request.method === "POST") {
                if (!session.sessionFile)
                    throw new BridgeHttpError(400, "only persistent sessions can be restored");
                this.closedSessionIds.delete(session.id);
                session.status = "idle";
                session.lastError = "";
                if (session.internalKind !== "scheduler") {
                    this.activeSessionId = session.id;
                    this.preferredSessionId = session.id;
                }
                this.persistBridgeState();
                this.emitSession(session, "restored");
                sendJson(response, { ok: true, sessionId: session.id, session: this.snapshot(session) });
                return;
            }
            if (suffix === "activate" && request.method === "POST") {
                if (session.internalKind === "scheduler")
                    throw new BridgeHttpError(400, "scheduler session cannot be activated");
                this.activeSessionId = session.id;
                this.preferredSessionId = session.id;
                this.emitSession(session, "activated", undefined, false);
                this.persistBridgeState();
                sendJson(response, { ok: true, sessionId: session.id, session: this.snapshot(session, false) });
                return;
            }
            if (suffix === "prompt" && request.method === "POST") {
                if (session.managed) {
                    sendJson(response, await this.promptManagedSession(session, body));
                    return;
                }
                const modelIndex = optionalModelIndex(body);
                const normalized = normalizePromptPayload(body, join(this.uploadRoot, session.id));
                const displayPrompt = normalized.displayPrompt.trim() ||
                    normalized.fileAttachments
                        .map((file) => file.name)
                        .filter(Boolean)
                        .join(", ") ||
                    (normalized.imageIds.length > 0 ? "已上传附件" : "");
                // A persisted session may still be metadata-only after /sessions. Load its
                // transcript before allocating a new message id so incremental polling
                // cannot collide with historical records.
                this.loadSessionMessages(session);
                const userMessage = this.appendRecord(session, {
                    role: "user",
                    content: displayPrompt,
                    ...(normalized.imageIds.length > 0
                        ? { image_ids: normalized.imageIds, image_attachments: normalized.imageAttachments }
                        : {}),
                    ...(normalized.fileAttachments.length > 0 ? { file_attachments: normalized.fileAttachments } : {}),
                    ts: Date.now() / 1000,
                });
                if (session.title === "New chat" && displayPrompt.trim()) {
                    session.title = displayPrompt.trim().replace(/\s+/gu, " ").slice(0, 40);
                    session.runtime?.session.setSessionName(session.title);
                }
                const prompt = {
                    ...normalized,
                    userMessageId: Number(userMessage.id),
                    modelIndex,
                    webVerbsEnabled: body.webVerbsEnabled === true || body.web_verbs_enabled === true,
                    queued: false,
                    source: "user",
                };
                const force = body.force === true || body.interruptRunning === true;
                const interrupted = force && session.status === "running";
                if (session.status === "running" && !force) {
                    prompt.queued = true;
                    userMessage.queued_status = "queued";
                    session.queue.push(prompt);
                    this.emitSession(session, "queue");
                    sendJson(response, {
                        ok: true,
                        accepted: true,
                        queued: true,
                        interrupted: false,
                        sessionId: session.id,
                        userMessageId: userMessage.id,
                        seq: session.nextMessageId,
                        queuedCount: session.queue.length,
                    });
                    return;
                }
                if (force && session.status === "running") {
                    this.cancelQueuedPrompts(session);
                    const abort = (await this.ensureRuntime(session)).abort("SecHeur prompt interrupted");
                    session.partial = null;
                    this.schedulePrompt(session, prompt, abort);
                    await abort;
                }
                else {
                    this.schedulePrompt(session, prompt);
                }
                sendJson(response, {
                    ok: true,
                    accepted: true,
                    queued: false,
                    interrupted,
                    sessionId: session.id,
                    userMessageId: userMessage.id,
                    seq: session.nextMessageId,
                });
                return;
            }
            if (suffix === "messages" && request.method === "GET") {
                const after = queryInteger(url, ["after", "afterId"], 0, 0);
                const limit = queryInteger(url, ["limit"], 200, 0);
                const includeBlackboard = url.searchParams.get("includeBlackboard") !== "false";
                if (session.managed?.snapshot)
                    this.updateManagedSnapshot(session, session.managed.snapshot, true);
                else
                    this.loadSessionMessages(session);
                const availableMessages = session.messageRecords.filter((message) => Number(message.id) > after);
                const messages = limit > 0 ? availableMessages.slice(-limit) : availableMessages;
                sendJson(response, {
                    sessionId: session.id,
                    status: session.status,
                    runtimeReloadPending: Boolean(session.runtimeStaleReason),
                    messages,
                    partial: session.partial,
                    msgSeq: session.nextMessageId,
                    updatedAt: session.updatedAt,
                    lastError: session.lastError,
                    ...(includeBlackboard ? { blackboardGraph: buildSessionBlackboardGraph(session) } : {}),
                    after,
                    limit,
                    nextAfter: messages.at(-1)?.id ?? after,
                });
                return;
            }
            if (suffix === "commands" && request.method === "GET") {
                if (session.managed) {
                    sendJson(response, {
                        sessionId: session.id,
                        commands: [
                            { name: "stop", description: "Abort the active remote Pi turn", source: "managed" },
                            { name: "session", description: "Read the active remote Pi session", source: "managed" },
                        ],
                    });
                    return;
                }
                const runtime = await this.ensureRuntime(session);
                sendJson(response, {
                    sessionId: session.id,
                    commands: runtime.getCommands(),
                });
                return;
            }
            if (suffix === "command" && request.method === "POST") {
                const command = String(body.command ?? body.name ?? "")
                    .trim()
                    .replace(/^\/+/, "")
                    .toLowerCase();
                let argument = String(body.argument ?? body.args ?? "").trim();
                if (argument.length >= 2 &&
                    ((argument.startsWith('"') && argument.endsWith('"')) ||
                        (argument.startsWith("'") && argument.endsWith("'")))) {
                    argument = argument.slice(1, -1);
                }
                if (!command)
                    throw new BridgeHttpError(400, "command is required");
                switch (command) {
                    case "name": {
                        if (!argument)
                            throw new BridgeHttpError(400, "session name is required");
                        const title = argument.replace(/\s+/gu, " ").slice(0, 200);
                        await this.runIdleSessionCommand(session, "command-name", (runtime) => {
                            runtime.session.setSessionName(title);
                            session.title = title;
                        });
                        sendJson(response, { ok: true, command, sessionId: session.id, title });
                        return;
                    }
                    case "session": {
                        const stats = await this.runIdleSessionCommand(session, "command-session", (runtime) => runtime.session.getSessionStats());
                        sendJson(response, { ok: true, command, sessionId: session.id, stats });
                        return;
                    }
                    case "compact": {
                        const result = await this.runIdleSessionCommand(session, "command-compact", (runtime) => runtime.session.compact(argument || undefined));
                        sendJson(response, { ok: true, command, sessionId: session.id, result });
                        return;
                    }
                    case "reload": {
                        await this.runIdleSessionCommand(session, "command-reload", (runtime) => runtime.session.reload());
                        sendJson(response, { ok: true, command, sessionId: session.id });
                        return;
                    }
                    case "invoke": {
                        const target = String(body.target ?? body.slashCommand ?? "")
                            .trim()
                            .replace(/^\/+/, "");
                        if (!target)
                            throw new BridgeHttpError(400, "extension command name is required");
                        const notifications = await this.runIdleSessionCommand(session, "command-invoke", async (runtime) => {
                            const registered = runtime
                                .getCommands()
                                .find((item) => item.source === "extension" && item.name.toLowerCase() === target.toLowerCase());
                            if (!registered)
                                throw new BridgeHttpError(400, `extension command not found: ${target}`);
                            const notices = [];
                            const runner = runtime.session.extensionRunner;
                            const originalUi = runner.getUIContext();
                            const captureUi = {
                                ...originalUi,
                                select: async (title) => {
                                    notices.push({
                                        message: `${title}: interactive selection is unavailable in Web mode`,
                                        type: "warning",
                                    });
                                    return undefined;
                                },
                                confirm: async (title) => {
                                    notices.push({
                                        message: `${title}: interactive confirmation is unavailable in Web mode`,
                                        type: "warning",
                                    });
                                    return false;
                                },
                                input: async (title) => {
                                    notices.push({
                                        message: `${title}: interactive input is unavailable in Web mode`,
                                        type: "warning",
                                    });
                                    return undefined;
                                },
                                editor: async (title) => {
                                    notices.push({
                                        message: `${title}: interactive editor is unavailable in Web mode`,
                                        type: "warning",
                                    });
                                    return undefined;
                                },
                                notify: (message, type = "info") => {
                                    notices.push({ message, type });
                                },
                                setStatus: (_key, text) => {
                                    if (text)
                                        notices.push({ message: text, type: "info" });
                                },
                            };
                            runner.setUIContext(captureUi, "rpc");
                            try {
                                await runtime.session.prompt(`/${target}${argument ? ` ${argument}` : ""}`);
                            }
                            finally {
                                runner.setUIContext(originalUi, "print");
                            }
                            this.syncRuntimeMessages(session);
                            return notices;
                        });
                        sendJson(response, { ok: true, command, target, sessionId: session.id, notifications });
                        return;
                    }
                    case "tree": {
                        const result = await this.runIdleSessionCommand(session, "command-tree", async (runtime) => {
                            if (argument) {
                                const navigation = await runtime.session.navigateTree(argument, { summarize: false });
                                if (!navigation.cancelled)
                                    this.replaceSessionMessagesFromRuntime(session);
                                return { navigated: !navigation.cancelled, leafId: runtime.session.sessionManager.getLeafId() };
                            }
                            const manager = runtime.session.sessionManager;
                            return {
                                navigated: false,
                                leafId: manager.getLeafId(),
                                entries: manager.getEntries().map((entry) => ({
                                    id: entry.id,
                                    parentId: entry.parentId,
                                    type: entry.type,
                                    role: entry.type === "message" &&
                                        isRecord(entry.message) &&
                                        typeof entry.message.role === "string"
                                        ? entry.message.role
                                        : undefined,
                                    text: entry.type === "message" && isRecord(entry.message)
                                        ? contentText(entry.message.content)
                                        : isRecord(entry) && typeof entry.summary === "string"
                                            ? entry.summary
                                            : "",
                                })),
                            };
                        });
                        sendJson(response, { ok: true, command, sessionId: session.id, ...result });
                        return;
                    }
                    case "fork": {
                        const result = await this.runIdleSessionCommand(session, "command-fork", async (runtime) => {
                            if (!argument) {
                                return { messages: runtime.session.getUserMessagesForForking() };
                            }
                            const forked = await this.createForkedSession(session, runtime, argument, "before");
                            return {
                                createdSessionId: forked.session.id,
                                session: this.snapshot(forked.session),
                                editorText: forked.editorText ?? "",
                            };
                        });
                        sendJson(response, { ok: true, command, sessionId: session.id, ...result });
                        return;
                    }
                    case "clone": {
                        const result = await this.runIdleSessionCommand(session, "command-clone", async (runtime) => {
                            const cloned = await this.createForkedSession(session, runtime, undefined, "at");
                            return { createdSessionId: cloned.session.id, session: this.snapshot(cloned.session) };
                        });
                        sendJson(response, { ok: true, command, sessionId: session.id, ...result });
                        return;
                    }
                    case "import": {
                        if (!argument)
                            throw new BridgeHttpError(400, "JSONL path is required");
                        const inputPath = resolve(session.cwd, argument);
                        if (extname(inputPath).toLowerCase() !== ".jsonl") {
                            throw new BridgeHttpError(400, "import path must point to a .jsonl file");
                        }
                        if (!existsSync(inputPath) || !statSync(inputPath).isFile()) {
                            throw new BridgeHttpError(404, `import file not found: ${inputPath}`);
                        }
                        const result = await this.runIdleSessionCommand(session, "command-import", async (runtime) => {
                            const sourceManager = SessionManager.open(inputPath);
                            const importedManager = SessionManager.forkFrom(inputPath, session.cwd, runtime.session.sessionManager.getSessionDir());
                            const imported = await this.createSession({
                                cwd: session.cwd,
                                title: sourceManager.getSessionName() || basename(inputPath, extname(inputPath)),
                                llmNo: session.modelIndex,
                                permissionMode: session.permissionMode,
                                memoryReferenceEnabled: session.memoryReferenceEnabled,
                                knowledgeBaseEnabled: session.knowledgeBaseEnabled,
                                planningEngine: session.planningEngine,
                                ...(session.executionModeOverride ? { executionMode: session.executionModeOverride } : {}),
                                ...(session.executionCapacityOverride !== undefined
                                    ? { executionCapacity: session.executionCapacityOverride }
                                    : {}),
                            }, true, undefined, importedManager);
                            return { createdSessionId: imported.id, session: this.snapshot(imported) };
                        });
                        sendJson(response, { ok: true, command, sessionId: session.id, ...result });
                        return;
                    }
                    case "export": {
                        if (!argument)
                            throw new BridgeHttpError(400, "export path is required");
                        const outputPath = resolve(session.cwd, argument);
                        const exportedPath = await this.runIdleSessionCommand(session, "command-export", async (runtime) => extname(outputPath).toLowerCase() === ".jsonl"
                            ? runtime.session.exportToJsonl(outputPath)
                            : runtime.session.exportToHtml(outputPath));
                        sendJson(response, { ok: true, command, sessionId: session.id, path: exportedPath });
                        return;
                    }
                    case "share": {
                        const shareUrl = await this.runIdleSessionCommand(session, "command-share", async (runtime) => {
                            await runCapturedCommand("gh", ["auth", "status"]);
                            const temporaryDirectory = mkdtempSync(join(tmpdir(), "secheur-share-"));
                            try {
                                const outputPath = join(temporaryDirectory, "session.html");
                                await runtime.session.exportToHtml(outputPath);
                                const result = await runCapturedCommand("gh", ["gist", "create", "--public=false", outputPath]);
                                const url = result.stdout
                                    .trim()
                                    .split(/\s+/u)
                                    .find((value) => /^https:\/\//u.test(value));
                                if (!url)
                                    throw new Error("GitHub CLI did not return a gist URL");
                                return url;
                            }
                            finally {
                                rmSync(temporaryDirectory, { recursive: true, force: true });
                            }
                        });
                        sendJson(response, { ok: true, command, sessionId: session.id, url: shareUrl });
                        return;
                    }
                    case "trust": {
                        const result = await this.runIdleSessionCommand(session, "command-trust", (runtime) => {
                            const trustStore = new ProjectTrustStore(runtime.config.agentDir);
                            if (!argument) {
                                return { decision: trustStore.get(session.cwd), cwd: session.cwd, changed: false };
                            }
                            const normalized = argument.toLowerCase();
                            const trusted = ["yes", "y", "true", "trust", "trusted", "1"].includes(normalized)
                                ? true
                                : ["no", "n", "false", "untrust", "untrusted", "0"].includes(normalized)
                                    ? false
                                    : undefined;
                            if (trusted === undefined)
                                throw new BridgeHttpError(400, "trust argument must be yes or no");
                            trustStore.set(session.cwd, trusted);
                            return { decision: trusted, cwd: session.cwd, changed: true };
                        });
                        sendJson(response, { ok: true, command, sessionId: session.id, ...result });
                        return;
                    }
                    default:
                        throw new BridgeHttpError(400, `unsupported session command: ${command}`);
                }
            }
            if (suffix === "cancel" && request.method === "POST") {
                if (session.status === "closed") {
                    sendJson(response, {
                        ok: true,
                        sessionId: session.id,
                        cancelled: false,
                        status: session.status,
                    });
                    return;
                }
                if (session.managed) {
                    const managed = session.managed;
                    const snapshot = await managed.lease.abort();
                    this.updateManagedSnapshot(session, snapshot);
                    this.emitSession(session, "cancelled");
                    sendJson(response, { ok: true, sessionId: session.id, cancelled: true, status: session.status });
                    return;
                }
                const preCancelStatus = session.status;
                session.cancelSource = lifecycleText(body.source) || "api";
                session.cancelReason = lifecycleText(body.reason);
                session.cancelAt = Date.now() / 1000;
                session.preCancelStatus = preCancelStatus;
                this.cancelQueuedPrompts(session);
                session.partial = null;
                session.status = "cancelled";
                const wasRunning = preCancelStatus === "running";
                if (wasRunning)
                    session.runGeneration += 1;
                const runtime = session.runtime;
                runtime?.state.permissionBroker.cancelAll("SecHeur prompt cancelled");
                this.emitSession(session, "cancelled");
                if (wasRunning)
                    await this.releaseRuntime(session, "SecHeur prompt cancelled", true, ABORT_GRACE_MS, "user_cancelled");
                sendJson(response, {
                    ok: true,
                    sessionId: session.id,
                    cancelled: true,
                    status: session.status,
                    preCancelStatus,
                });
                return;
            }
            if (suffix === "pause" && request.method === "POST") {
                if (session.status === "closed" || session.status === "cancelled")
                    throw new BridgeHttpError(409, `cannot pause a ${session.status} session`);
                if (session.status === "paused") {
                    sendJson(response, { ok: true, sessionId: session.id, paused: true, status: session.status });
                    return;
                }
                const prePauseStatus = session.status;
                session.pauseSource = lifecycleText(body.source) || "api";
                session.pauseReason = lifecycleText(body.reason);
                session.pauseAt = Date.now() / 1000;
                session.prePauseStatus = prePauseStatus;
                this.cancelQueuedPrompts(session);
                session.partial = null;
                session.status = "paused";
                const wasRunning = prePauseStatus === "running";
                if (wasRunning)
                    session.runGeneration += 1;
                const runtime = session.runtime;
                runtime?.state.permissionBroker.cancelAll("SecHeur prompt paused");
                this.emitSession(session, "paused");
                if (wasRunning)
                    await this.releaseRuntime(session, "SecHeur prompt paused", true, ABORT_GRACE_MS, "user_paused");
                sendJson(response, {
                    ok: true,
                    sessionId: session.id,
                    paused: true,
                    status: session.status,
                    prePauseStatus,
                });
                return;
            }
            if (suffix === "resume" && request.method === "POST") {
                if (session.status !== "paused")
                    throw new BridgeHttpError(409, "only a paused session can be resumed");
                session.status = "idle";
                session.lastError = "";
                session.watchdogPhase = null;
                this.emitSession(session, "resumed");
                sendJson(response, { ok: true, sessionId: session.id, resumed: true, status: session.status });
                return;
            }
            if (suffix === "model" && request.method === "POST") {
                if (session.managed) {
                    const provider = typeof body.provider === "string" ? body.provider : "";
                    const modelId = typeof body.model === "string" ? body.model : "";
                    if (!provider || !modelId)
                        throw new BridgeHttpError(400, "provider and model are required");
                    const snapshot = await session.managed.lease.setModel({ provider, id: modelId });
                    this.updateManagedSnapshot(session, snapshot);
                    this.emitSession(session, "model");
                    sendJson(response, { ok: true, sessionId: session.id, provider, model: modelId });
                    return;
                }
                const index = optionalModelIndex(body);
                const provider = typeof body.provider === "string" ? body.provider : undefined;
                const modelId = typeof body.model === "string" ? body.model : undefined;
                const validationRuntime = await this.ensureRuntime(session);
                const models = validationRuntime.session.modelRuntime.getAvailableSnapshot();
                const directModel = provider && modelId ? validationRuntime.session.modelRuntime.getModel(provider, modelId) : undefined;
                const selectedIndex = directModel
                    ? models.findIndex((model) => model.provider === directModel.provider && model.id === directModel.id)
                    : index;
                if (selectedIndex === undefined || selectedIndex < 0) {
                    throw new BridgeHttpError(400, "model was not found");
                }
                const wasRunning = session.status === "running";
                const previousRunner = session.runner;
                const previousTransition = session.transition;
                const generation = ++session.runGeneration;
                if (wasRunning) {
                    this.cancelQueuedPrompts(session);
                    session.partial = null;
                    session.status = "idle";
                }
                const transition = (async () => {
                    if (previousTransition)
                        await previousTransition;
                    const runtime = await this.ensureRuntime(session);
                    if (wasRunning) {
                        runtime.state.permissionBroker.cancelAll("SecHeur model changed");
                        await runtime.abort("SecHeur model changed");
                    }
                    if (previousRunner)
                        await previousRunner;
                    return this.selectRuntimeModel(session, selectedIndex, await this.ensureRuntime(session));
                })();
                session.transition = transition;
                let selected;
                try {
                    selected = await transition;
                }
                catch (error) {
                    if (session.runGeneration === generation) {
                        session.status = "error";
                        session.lastError = error instanceof Error ? error.message : String(error);
                        this.emitSession(session, "model-error");
                    }
                    throw error;
                }
                finally {
                    if (session.transition === transition)
                        session.transition = undefined;
                }
                this.emitSession(session, "model");
                sendJson(response, {
                    ok: true,
                    sessionId: session.id,
                    llmNo: selectedIndex,
                    provider: selected.provider,
                    model: selected.model,
                    runtimeReset: wasRunning,
                    wasRunning,
                });
                return;
            }
            if (suffix === "runtime/reset" && request.method === "POST") {
                const wasRunning = session.status === "running";
                const hadAgent = Boolean(session.runtime ?? session.runtimePromise);
                const previousRunner = session.runner;
                const generation = ++session.runGeneration;
                this.cancelQueuedPrompts(session);
                session.partial = null;
                session.status = "idle";
                session.lastError = "";
                session.planningRunId = null;
                const transition = (async () => {
                    const runtime = session.runtime ?? (session.runtimePromise ? await session.runtimePromise : undefined);
                    if (runtime && previousRunner)
                        await runtime.abort("SecHeur runtime reset");
                    if (previousRunner)
                        await previousRunner;
                    await this.releaseRuntime(session, "SecHeur runtime reset", false);
                })();
                session.transition = transition;
                try {
                    await transition;
                }
                finally {
                    if (session.transition === transition)
                        session.transition = undefined;
                }
                if (session.runGeneration === generation)
                    session.status = "idle";
                this.emitSession(session, "runtime-reset");
                sendJson(response, {
                    ok: true,
                    sessionId: session.id,
                    runtimeReset: true,
                    hadAgent,
                    wasRunning,
                });
                return;
            }
            if (suffix === "runtime/log" && request.method === "GET") {
                const query = runtimeLogQuery(url);
                sendJson(response, this.runtimeLogPayload(session, query));
                return;
            }
            if (suffix === "export" && request.method === "GET") {
                const snapshot = this.snapshot(session, true);
                sendJson(response, {
                    ok: true,
                    sessionId: session.id,
                    exportedAt: Date.now() / 1000,
                    session: this.snapshot(session, false),
                    messages: snapshot.messages,
                    partial: snapshot.partial,
                    runtimeLog: session.runtimeEvents,
                    blackboardGraph: buildSessionBlackboardGraph(session),
                });
                return;
            }
            if (suffix === "planning/capacity" && (request.method === "GET" || request.method === "POST")) {
                const runtime = session.runtime;
                if (session.managed)
                    throw new BridgeHttpError(409, "Live Planning capacity is unavailable for managed sessions");
                if (!runtime || runtime.config.executionMode.mode !== "plan_multi")
                    throw new BridgeHttpError(409, "An attached PLAN_MULTI runtime is required");
                if (request.method === "POST") {
                    const capacity = body.executionCapacity;
                    if (typeof capacity !== "number" || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 64)
                        throw new BridgeHttpError(400, "executionCapacity must be an integer from 1 to 64");
                    if (!runtime.setExecutionCapacity)
                        throw new BridgeHttpError(409, "Runtime does not support live capacity");
                    session.executionCapacity = runtime.setExecutionCapacity(capacity);
                }
                sendJson(response, {
                    ok: true,
                    sessionId: session.id,
                    executionCapacity: runtime.config.executionMode.capacity,
                    global: { enabled: false, scope: "per_run", capacity: null },
                    persistent: false,
                });
                return;
            }
            if (suffix === "permission-mode" && request.method === "POST") {
                const mode = String(body.mode ?? body.permissionMode ?? "");
                if (!VALID_PERMISSION_MODES.has(mode)) {
                    sendJson(response, { error: `invalid permission mode: ${mode}` }, 400);
                    return;
                }
                if (session.status === "running") {
                    sendJson(response, { error: "session is already running" }, 409);
                    return;
                }
                session.permissionMode = mode;
                session.runtime?.setPermissionMode(mode);
                this.emitSession(session, "permission-mode");
                sendJson(response, { ok: true, sessionId: session.id, permissionMode: mode });
                return;
            }
            const permissionMatch = suffix.match(/^permission\/([^/]+)$/);
            if (permissionMatch && request.method === "POST") {
                const requestId = decodeURIComponent(permissionMatch[1]);
                const decision = String(body.decision ?? body.action ?? "deny");
                if (!VALID_PERMISSION_DECISIONS.has(decision)) {
                    sendJson(response, { error: `invalid permission decision: ${decision}` }, 400);
                    return;
                }
                if (session.managed) {
                    try {
                        await session.managed.lease.resolvePermission(requestId, decision, typeof body.answer === "string" ? body.answer : undefined);
                    }
                    catch (error) {
                        throw new BridgeHttpError(404, error instanceof Error ? error.message : String(error));
                    }
                    this.updateManagedSnapshot(session, session.managed.lease.snapshot ?? session.managed.snapshot, true);
                    this.emitSession(session, "permission-resolved");
                    sendJson(response, { ok: true, sessionId: session.id, requestId, decision });
                    return;
                }
                const runtime = session.runtime;
                const pending = runtime?.state.permissionBroker.list().find((item) => item.id === requestId);
                if (!runtime || !pending)
                    throw new BridgeHttpError(404, `permission request not found: ${requestId}`);
                if (decision === "answer" && pending.toolName !== "ask_user" && pending.toolName !== "exit_plan_mode") {
                    sendJson(response, { error: `permission request does not accept an answer: ${pending.toolName}` }, 400);
                    return;
                }
                const affirmative = /^(?:approve|approved|allow|ok|y|yes)$/iu.test(String(body.answer ?? "").trim());
                const allowed = decision === "allow_once" ||
                    decision === "allow_session" ||
                    (decision === "answer" && (pending?.toolName !== "exit_plan_mode" || affirmative));
                const answer = typeof body.answer === "string" ? body.answer : undefined;
                if (decision === "allow_session") {
                    const signature = runtime.state.permissions.allowForSession(pending.toolName, pending.input);
                    session.permissionSessionGrants.add(signature);
                }
                const resolved = runtime.state.permissionBroker.resolve(requestId, allowed, answer);
                const message = [...session.messageRecords]
                    .reverse()
                    .find((item) => item.role === "permission" && (item.requestId === requestId || item.request_id === requestId));
                if (message) {
                    message.status = "resolved";
                    message.decision = decision;
                    message.answer = answer ?? "";
                    message.decision_label =
                        answer ||
                            ({ allow_once: "已允许本次", allow_session: "本会话已允许", deny: "已拒绝" }[decision] ?? "已处理");
                }
                this.emitSession(session, "permission-resolved");
                sendJson(response, { ok: resolved, sessionId: session.id, requestId, decision, message });
                return;
            }
        }
        if (path === "/path/open" && request.method === "POST") {
            const target = resolveOpenTarget(this.projectRoot, body);
            if (!existsSync(target)) {
                sendJson(response, { ok: false, error: `File not found: ${target}` });
                return;
            }
            await this.openPath(target);
            sendJson(response, { ok: true, path: target });
            return;
        }
        if (path === "/api/ctf-oracle/summary" && request.method === "GET") {
            const limit = queryInteger(url, ["limit"], 30, 1);
            try {
                sendJson(response, await flagOracleSummary(this.env, Math.min(limit, 200)));
            }
            catch (error) {
                sendJson(response, {
                    ok: false,
                    status: "offline",
                    error: error instanceof Error ? error.message : String(error),
                    totals: {
                        challenges: 0,
                        solvedChallenges: 0,
                        attempts: 0,
                        correctAttempts: 0,
                        incorrectAttempts: 0,
                    },
                    challenges: [],
                    recentAttempts: [],
                }, 503);
            }
            return;
        }
        if (path === "/api/ctf-oracle/attempts" && request.method === "GET") {
            const limit = queryInteger(url, ["limit"], 50, 1);
            const challengeId = url.searchParams.get("challengeId") ??
                url.searchParams.get("challenge_id") ??
                url.searchParams.get("target_id") ??
                "";
            try {
                sendJson(response, await flagOracleAttempts(this.env, challengeId, Math.min(limit, 200)));
            }
            catch (error) {
                sendJson(response, {
                    ok: false,
                    status: "offline",
                    error: error instanceof Error ? error.message : String(error),
                    challengeId: challengeId || null,
                    totals: { attempts: 0, correctAttempts: 0, incorrectAttempts: 0, unknownAttempts: 0 },
                    attempts: [],
                }, 503);
            }
            return;
        }
        if (request.method === "GET" || request.method === "HEAD") {
            // 保留完整 legacy 桌面页作为默认入口；React 版只在 /webui/ 显式访问。
            const staticFile = path === "/"
                ? safeStaticFile(this.staticRoot, "/index.html")
                : path === "/webui" || path === "/webui/"
                    ? safeStaticFile(this.staticRoot, "/webui/index.html")
                    : path === "/benchmark-dashboard" || path === "/benchmark-dashboard/"
                        ? safeStaticFile(this.benchmarkRoot, "/index.html")
                        : safeStaticFile(this.staticRoot, path);
            if (staticFile) {
                sendStaticFile(request, response, staticFile);
                return;
            }
        }
        sendJson(response, { error: "not found" }, 404);
    }
    registry() {
        const config = loadSecHeurConfig({ projectRoot: this.projectRoot, env: this.env });
        return buildDesktopRegistry(this.projectRoot, config);
    }
    async closeSessions() {
        for (const session of this.sessions.values()) {
            if (session.managed) {
                await this.closeManagedSession(session);
                continue;
            }
            const hasActiveRunner = Boolean(session.runner) || session.status === "running";
            session.runGeneration += 1;
            this.cancelQueuedPrompts(session);
            session.partial = null;
            session.planningRunId = null;
            await this.releaseRuntime(session, "SecHeur bridge closed", hasActiveRunner);
        }
        this.sessions.clear();
        this.activeSessionId = undefined;
        for (const timer of this.sessionEventTimers.values())
            clearTimeout(timer);
        this.sessionEventTimers.clear();
        this.pendingSessionEvents.clear();
        for (const client of [...this.wsClients.values()])
            this.closeWsClient(client, true);
        for (const client of [...this.sseClients])
            this.closeSseClient(client, false);
    }
    async listen() {
        if (this.closing)
            throw new Error("SecHeur bridge is closed");
        if (this.server)
            return this.server;
        this.server = createServer((request, response) => {
            this.handleRequest(request, response).catch((error) => {
                if (response.headersSent) {
                    response.destroy(error instanceof Error ? error : undefined);
                    return;
                }
                const status = error instanceof BridgeHttpError ? error.status : 400;
                sendJson(response, { error: error instanceof Error ? error.message : String(error) }, status);
            });
        });
        this.server.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head));
        await new Promise((resolveListen, reject) => {
            this.server?.once("error", reject);
            this.server?.listen(this.port, this.host, () => resolveListen());
        });
        this.scheduler?.start();
        if (this.competitionServerPromise)
            await (await this.competitionServerPromise).start();
        if (this.worklistPromise) {
            const worklist = await this.getWorklist();
            await worklist.start();
        }
        return this.server;
    }
    handleUpgrade(request, socket, head) {
        if (!isAllowedRequestOrigin(request) || new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/ws") {
            socket.destroy();
            return;
        }
        const key = request.headers["sec-websocket-key"];
        if (typeof key !== "string") {
            socket.destroy();
            return;
        }
        const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        socket.write("HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
        const client = {
            socket,
            queue: [],
            blocked: false,
            closed: false,
            heartbeat: setInterval(() => this.enqueueWs(client, wsPacket(0x9, Buffer.alloc(0))), WS_HEARTBEAT_MS),
        };
        this.wsClients.set(socket, client);
        const cleanup = () => {
            if (client.closed) {
                this.wsClients.delete(socket);
                clearInterval(client.heartbeat);
                return;
            }
            client.closed = true;
            this.wsClients.delete(socket);
            clearInterval(client.heartbeat);
        };
        socket.on("close", cleanup);
        socket.on("error", cleanup);
        let buffered = (head.length > 0 ? Buffer.from(head) : Buffer.alloc(0));
        const consume = (chunk) => {
            buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
            while (buffered.length >= 2) {
                const opcode = buffered[0] & 0x0f;
                const masked = (buffered[1] & 0x80) !== 0;
                let offset = 2;
                let length = buffered[1] & 0x7f;
                if (length === 126) {
                    if (buffered.length < 4)
                        return;
                    length = buffered.readUInt16BE(2);
                    offset = 4;
                }
                else if (length === 127) {
                    if (buffered.length < 10)
                        return;
                    const wideLength = buffered.readBigUInt64BE(2);
                    if (wideLength > BigInt(MAX_WS_FRAME_BYTES)) {
                        socket.destroy();
                        return;
                    }
                    length = Number(wideLength);
                    offset = 10;
                }
                if (!masked || length > MAX_WS_FRAME_BYTES) {
                    socket.destroy();
                    return;
                }
                if (buffered.length < offset + 4 + length)
                    return;
                const mask = buffered.subarray(offset, offset + 4);
                offset += 4;
                const payload = Buffer.from(buffered.subarray(offset, offset + length));
                for (let index = 0; index < payload.length; index += 1)
                    payload[index] ^= mask[index % 4];
                buffered = buffered.subarray(offset + length);
                if (opcode === 0x8) {
                    socket.end(wsPacket(0x8, payload.subarray(0, 125)));
                    return;
                }
                if (opcode === 0x9)
                    this.enqueueWs(client, wsPacket(0xa, payload.subarray(0, 125)));
            }
        };
        socket.on("data", consume);
        this.enqueueWs(client, wsFrame({
            type: "bridge-ready",
            projectRoot: this.projectRoot,
            sequence: this.bridgeEventSeq,
            eventId: this.bridgeEventSeq,
        }));
        if (buffered.length > 0)
            consume(Buffer.alloc(0));
    }
    close() {
        this.closePromise ??= this.closeInternal();
        return this.closePromise;
    }
    async closeInternal() {
        this.closing = true;
        await this.scheduler?.stop();
        if (this.worklistPromise) {
            try {
                const worklist = await this.worklistPromise;
                if (typeof worklist.close === "function")
                    await worklist.close();
                else {
                    await worklist.stop();
                    worklist.store.close();
                }
            }
            catch {
                // Worklist initialization failure must not prevent the bridge from closing.
            }
        }
        if (this.competitionServerPromise) {
            try {
                await (await this.competitionServerPromise).close();
            }
            catch {
                // Competition broker socket shutdown must not prevent the bridge from closing.
            }
        }
        if (this.competitionPromise) {
            try {
                await (await this.competitionPromise).close();
            }
            catch {
                // Competition broker shutdown must not prevent the bridge from closing.
            }
        }
        this.competitionClient?.close();
        await Promise.allSettled([...this.sessionAcquisitionBarriers]);
        await this.closeSessions();
        if (!this.server)
            return;
        const server = this.server;
        await new Promise((resolveClose) => {
            server.close(() => resolveClose());
            server.closeIdleConnections();
        });
        this.server = undefined;
    }
    get address() {
        const address = this.server?.address();
        return { host: address?.address ?? this.host, port: address?.port ?? this.port };
    }
}
//# sourceMappingURL=bridge.js.map
