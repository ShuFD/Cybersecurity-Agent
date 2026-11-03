import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Agent, fetch as privateFetch } from "undici";
import { CompetitionPlatformError } from "./competition-adapters.js";

const format = { prefix: "", suffix: "", accepts: "either", submit: "full", maxLength: 512 };
export class DesktopCompetitionAdapter {
    platform = "private";
    constructor(accessPath, stateDir, fetchImpl, options = {}) {
        this.access = JSON.parse(readFileSync(accessPath, "utf8"));
        this.base = new URL(this.access.baseUrl);
        if (this.base.protocol !== "https:") throw new Error("Private competition requires HTTPS");
        this.dispatcher = fetchImpl ? undefined : new Agent({ connect: { ca: readFileSync(this.access.caCertificate, "utf8") } });
        this.fetchImpl = fetchImpl ?? ((url, init) => privateFetch(url, { ...init, dispatcher: this.dispatcher }));
        this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
        this.pollAttempts = options.pollAttempts ?? 12;
        // Reuse the existing competition adapter default; an explicit operator
        // budget remains authoritative and must not be raised after a rejection.
        this.maxAttempts = options.maxAttempts ?? this.access.maxAttempts ?? 3;
        this.attemptLimitSource = options.maxAttempts !== undefined || this.access.maxAttempts !== undefined ? "operator-budget" : "existing-adapter-default";
        if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1)
            throw new Error("Competition maxAttempts must be a positive integer");
        this.ledgerPath = join(stateDir, "private-platform-instances.json");
        try { this.ledger = JSON.parse(readFileSync(this.ledgerPath, "utf8")); } catch (error) {
            if (error.code !== "ENOENT") throw error;
            this.ledger = {};
        }
    }
    save() {
        const temp = this.ledgerPath + ".tmp";
        writeFileSync(temp, JSON.stringify(this.ledger), { mode: 0o600 });
        renameSync(temp, this.ledgerPath);
    }
    async fetchAttachment(url, init = {}) {
        const parsed = new URL(url);
        if (parsed.origin !== this.base.origin || !/^\/api\/attachments\/att_[a-f0-9]{64}$/.test(parsed.pathname) || parsed.search || parsed.hash)
            throw new Error("Attachment URL is outside the private platform");
        return this.fetchImpl(parsed, { ...init, redirect: "error", headers: { Authorization: "Bearer " + this.access.token } });
    }
    async request(path, method = "GET", body, signal, idempotencyKey, timeoutMs = 60_000) {
        const headers = { Authorization: "Bearer " + this.access.token };
        if (body !== undefined) headers["Content-Type"] = "application/json";
        if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
        const response = await this.fetchImpl(new URL(path, this.base), {
            method, headers, redirect: "error",
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        if (!response.ok) {
            const detail = await response.text().catch(() => "");
            const error = new Error(`Private platform HTTP ${response.status}${detail ? ": " + detail.slice(0, 200) : ""}`);
            error.statusCode = response.status;
            throw error;
        }
        return response.json();
    }
    async getPolicy() {
        return { flagFormat: format, maxEnvironmentSlots: 3,
            submission: { flagFormat: format, maxAttempts: this.maxAttempts, duplicateScope: "task", acceptedStatuses: ["correct"] },
            raw: { submissionSupported: true, attemptLimitSource: this.attemptLimitSource } };
    }
    async listChallenges(signal) {
        const result = await this.request("/api/challenges", "GET", undefined, signal);
        return result.challenges.map(row => ({ exerciseId: row.challengeId, name: row.title,
            category: row.category, isOpen: true, hasSolved: false, score: 0, raw: {} }));
    }
    async getChallenge(id, signal) {
        if (!/^ch_[a-f0-9]{64}$/.test(String(id))) throw new Error("Invalid platform challenge ID");
        const row = await this.request("/api/challenges/" + id, "GET", undefined, signal);
        return { exerciseId: id, name: row.title, category: row.category, description: row.description,
            hints: [], isOpen: true, hasSolved: false, flagFormat: format,
            attachments: row.attachments.map(a => ({ artifactId: a.attachmentId, name: a.filename,
                url: new URL(a.downloadUrl, this.base).href, sizeBytes: a.bytes, sha256: a.sha256 })),
            environment: { required: row.online.supported, status: row.online.supported ? "pending" : "none", endpoints: [] },
            scoring: { currentScore: 0, challengeValue: 0, estimatedSolveProbability: .5, confidence: 0,
                expectedRemainingMinutes: 10, environmentWaitMinutes: 0, agingBonus: 0, asOf: Date.now() },
            platform: { submissionSupported: true } };
    }
    projection(row) {
        return { status: row.status === "running" ? "ready" : row.status === "starting" ? "pending" : "blocked",
            endpoints: row.status === "running" ? row.endpoints : [],
            leaseMetadata: { instanceId: row.instanceId }, raw: { status: row.status } };
    }
    async startEnvironment(id, signal) {
        let record = this.ledger[id];
        if (!record) { record = { key: "desktop-main-" + randomUUID() }; this.ledger[id] = record; this.save(); }
        let row;
        if (record.instanceId) {
            try {
                row = await this.request("/api/instances/" + record.instanceId, "GET", undefined, signal);
            } catch (error) {
                if (error.statusCode !== 404) throw error;
                record.instanceId = undefined;
                record.key = "desktop-main-" + randomUUID();
                this.save();
            }
        }
        if (!row) row = await this.request("/api/instances", "POST", { challengeId: id }, signal, record.key);
        record.instanceId = row.instanceId;
        this.save();
        return this.projection(row);
    }
    async getEnvironment(id, signal) {
        const record = this.ledger[id];
        if (!record?.instanceId) return this.startEnvironment(id, signal);
        return this.projection(await this.request("/api/instances/" + record.instanceId, "GET", undefined, signal));
    }
    async releaseEnvironment(id, signal) {
        let record = this.ledger[id];
        if (!record) return { released: true, created: false, status: "released" };
        if (!record.instanceId) { await this.startEnvironment(id, signal); record = this.ledger[id]; }
        let row;
        try {
            // Docker cleanup can legitimately take longer than a normal request.
            row = await this.request("/api/instances/" + record.instanceId, "DELETE", undefined, signal, undefined, 180_000);
        } catch (error) {
            if (error.statusCode === 404) {
                delete this.ledger[id]; this.save();
                return { released: true, status: "released" };
            }
            // A timed-out DELETE keeps running on the server. Confirm the final state
            // before deciding that the reservation is still held.
            row = await this.pollRelease(record.instanceId, signal);
            if (!row) throw new Error(`Private platform cleanup incomplete: ${error.message}`);
        }
        if (row.status === "quarantined") throw new Error("Private platform instance requires operator review");
        if (!["released", "expired", "failed"].includes(row.status))
            throw new Error(`Private platform cleanup incomplete: status ${row.status}`);
        delete this.ledger[id]; this.save();
        return { released: true, status: row.status };
    }
    async pollRelease(instanceId, signal) {
        for (let attempt = 0; attempt < this.pollAttempts; attempt += 1) {
            await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
            try {
                const row = await this.request("/api/instances/" + instanceId, "GET", undefined, signal, undefined, 20_000);
                if (["released", "expired", "failed", "quarantined"].includes(row.status)) return row;
            } catch (error) {
                if (error.statusCode === 404) return { status: "released" };
            }
        }
        return undefined;
    }
    async submitFlag(exerciseId, flag, context = {}, signal) {
        const id = String(exerciseId);
        if (!/^ch_[a-f0-9]{64}$/.test(id)) throw new Error("Invalid platform challenge ID");
        // The platform maps this public ID to the private target itself; the
        // adapter never learns the internal challenge identifier.
        const attempt = Number.isInteger(context.attemptNo) && context.attemptNo > 0 ? context.attemptNo : 1;
        const runId = `${context.taskId ?? "desktop-main"}:attempt-${attempt}`.slice(0, 200);
        const requestPayload = { challenge_id: id, agent_id: "desktop-main", run_id: runId };
        let body;
        try {
            body = await this.request("/api/v1/verify", "POST", { flag, ...requestPayload }, signal, undefined, 30_000);
        } catch (error) {
            if (!error.statusCode) throw error;
            throw new CompetitionPlatformError(`Private platform verification failed: HTTP ${error.statusCode}`,
                { httpStatus: error.statusCode, rawResponse: { status: "verification_unavailable" } });
        }
        const status = typeof body.status === "string" ? body.status : "unknown";
        if (status === "limit_exceeded" || status === "duplicate" || !["correct", "incorrect"].includes(status) ||
            (status === "correct" && body.verified !== true) || (status === "incorrect" && body.verified === true))
            throw new CompetitionPlatformError(`Private platform verification unavailable or inconsistent: ${status}`,
                { code: status, category: status === "limit_exceeded" ? "rate_limited" : "request_error",
                  rawResponse: { status } });
        return {
            isCorrect: body.verified === true && status === "correct",
            status,
            message: typeof body.message === "string" ? body.message.replaceAll(flag, "[candidate]").slice(0, 1000) :
                status === "incorrect" ? "Platform rejected this candidate; review the evidence and correct it" : "Platform accepted this candidate",
            httpStatus: 200,
            requestPayload,
            rawResponse: { ok: body.ok === true, verified: body.verified === true, status },
        };
    }
    async close() { await this.dispatcher?.close(); }
}
