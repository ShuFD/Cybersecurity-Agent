import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const runtimeDir = process.env.SECHEUR_TEST_RUNTIME_DIR;
if (!runtimeDir) throw new Error("Set SECHEUR_TEST_RUNTIME_DIR to the prepared agent dist directory");
const DIST = pathToFileURL(join(runtimeDir, "/")).href;
const manifest = JSON.parse(readFileSync(new URL("../runtime-manifest.json", import.meta.url), "utf8").replace(/^\uFEFF/, ""));
for (const row of manifest.files) {
    const hash = createHash("sha256").update(readFileSync(join(runtimeDir, row.file))).digest("hex");
    assert.equal(hash, row.sha256, `runtime differs from the published snapshot: ${row.file}`);
}
const { DesktopCompetitionAdapter } = await import(DIST + "desktop-main-platform.js");
const { DesktopSolverManager } = await import(DIST + "desktop-main-solvers.js");

function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "desktop-main-"));
    const accessPath = join(dir, "access.json");
    writeFileSync(accessPath, JSON.stringify({ baseUrl: "https://platform.test/", token: "secret-token" }));
    return { dir, accessPath };
}

function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// --- adapter -------------------------------------------------------------

test("adapter rejects attachment URLs outside the platform origin", async () => {
    const { dir, accessPath } = fixture();
    const adapter = new DesktopCompetitionAdapter(accessPath, dir, async () => jsonResponse(200, {}));
    await assert.rejects(() => adapter.fetchAttachment("https://evil.test/api/attachments/att_" + "a".repeat(64)), /outside the private platform/);
    await assert.rejects(() => adapter.fetchAttachment("https://platform.test/api/instances"), /outside the private platform/);
    const ok = await adapter.fetchAttachment("https://platform.test/api/attachments/att_" + "a".repeat(64));
    assert.equal(ok.status, 200);
});

test("adapter submits through the platform verifier and keeps flags out of result metadata", async () => {
    const { dir, accessPath } = fixture();
    const calls = [];
    const adapter = new DesktopCompetitionAdapter(accessPath, dir, async (url, init) => {
        calls.push({ path: new URL(url).pathname, method: init.method, body: JSON.parse(init.body) });
        return jsonResponse(200, { ok: true, verified: true, status: "correct" });
    });
    const id = "ch_" + "a".repeat(64);
    const result = await adapter.submitFlag(id, "synthetic-candidate", { taskId: "task-1", attemptNo: 1 });
    assert.equal(calls[0].path, "/api/v1/verify");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].body.challenge_id, id);
    assert.equal(calls[0].body.flag, "synthetic-candidate");
    assert.equal(result.isCorrect, true);
    assert.ok(!JSON.stringify(result).includes("synthetic-candidate"));
    const policy = await adapter.getPolicy();
    assert.equal(policy.raw.submissionSupported, true);
});

test("adapter requires both a positive verifier result and correct status", async () => {
    for (const verdict of [
        { verified: false, status: "correct" },
        { verified: true, status: "incorrect" },
    ]) {
        const { dir, accessPath } = fixture();
        const adapter = new DesktopCompetitionAdapter(accessPath, dir, async () => jsonResponse(200, verdict));
        await assert.rejects(() => adapter.submitFlag("ch_" + "a".repeat(64), "test"), /inconsistent/);
    }
});

test("adapter rejects malformed challenge IDs without submitting", async () => {
    const { dir, accessPath } = fixture();
    const adapter = new DesktopCompetitionAdapter(accessPath, dir, async () => { throw new Error("must not submit"); });
    await assert.rejects(() => adapter.submitFlag("invalid", "test"), /Invalid platform challenge ID/);
});

test("verifier HTTP errors are reported without leaking response content", async () => {
    const { dir, accessPath } = fixture();
    const adapter = new DesktopCompetitionAdapter(accessPath, dir, async () => jsonResponse(503, { detail: "private-response" }));
    await assert.rejects(() => adapter.submitFlag("ch_" + "a".repeat(64), "test"), error => {
        assert.match(error.message, /HTTP 503/);
        assert.ok(!JSON.stringify(error).includes("private-response"));
        return true;
    });
});

test("adapter recovers the ledger when the platform lost the instance (404)", async () => {
    const { dir, accessPath } = fixture();
    const calls = [];
    let created = 0;
    const fetchImpl = async (url, init) => {
        calls.push(init.method + " " + new URL(url).pathname);
        if (init.method === "POST") return jsonResponse(200, { instanceId: "i" + ++created, status: "starting" });
        return jsonResponse(404, { error: "not found" });
    };
    const adapter = new DesktopCompetitionAdapter(accessPath, dir, fetchImpl, { pollIntervalMs: 5, pollAttempts: 3 });
    const first = await adapter.startEnvironment("ch_" + "a".repeat(64));
    assert.equal(first.leaseMetadata.instanceId, "i1");
    const second = await adapter.startEnvironment("ch_" + "a".repeat(64));
    assert.equal(second.leaseMetadata.instanceId, "i2");
    assert.deepEqual(calls, ["POST /api/instances", "GET /api/instances/i1", "POST /api/instances"]);
    const ledger = JSON.parse(readFileSync(join(dir, "private-platform-instances.json"), "utf8"));
    assert.equal(ledger["ch_" + "a".repeat(64)].instanceId, "i2");
});

test("adapter turns a platform error body into a diagnosable error", async () => {
    const { dir, accessPath } = fixture();
    const adapter = new DesktopCompetitionAdapter(accessPath, dir, async () => jsonResponse(409, { error: "slot limit" }));
    await assert.rejects(() => adapter.startEnvironment("ch_" + "a".repeat(64)), (error) => {
        assert.match(error.message, /HTTP 409/);
        assert.match(error.message, /slot limit/);
        assert.equal(error.statusCode, 409);
        return true;
    });
});

test("adapter polls after a DELETE timeout and clears the ledger once released", async () => {
    const { dir, accessPath } = fixture();
    writeFileSync(join(dir, "private-platform-instances.json"), JSON.stringify({ ["ch_" + "b".repeat(64)]: { key: "k", instanceId: "i9" } }));
    let deletes = 0;
    const fetchImpl = async (url, init) => {
        if (init.method === "DELETE") { deletes += 1; throw new Error("The operation was aborted due to timeout"); }
        return jsonResponse(200, { instanceId: "i9", status: "released" });
    };
    const adapter = new DesktopCompetitionAdapter(accessPath, dir, fetchImpl, { pollIntervalMs: 5, pollAttempts: 3 });
    const result = await adapter.releaseEnvironment("ch_" + "b".repeat(64));
    assert.equal(result.released, true);
    assert.equal(result.status, "released");
    assert.equal(deletes, 1);
    assert.equal(existsSync(join(dir, "private-platform-instances.json")), true);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "private-platform-instances.json"), "utf8")), {});
});

test("adapter reports an incomplete cleanup when the instance never exits", async () => {
    const { dir, accessPath } = fixture();
    writeFileSync(join(dir, "private-platform-instances.json"), JSON.stringify({ ["ch_" + "c".repeat(64)]: { key: "k", instanceId: "i9" } }));
    const fetchImpl = async (url, init) => {
        if (init.method === "DELETE") throw new Error("The operation was aborted due to timeout");
        return jsonResponse(200, { instanceId: "i9", status: "stopping" });
    };
    const adapter = new DesktopCompetitionAdapter(accessPath, dir, fetchImpl, { pollIntervalMs: 5, pollAttempts: 3 });
    await assert.rejects(() => adapter.releaseEnvironment("ch_" + "c".repeat(64)), /cleanup incomplete/);
    const ledger = JSON.parse(readFileSync(join(dir, "private-platform-instances.json"), "utf8"));
    assert.equal(ledger["ch_" + "c".repeat(64)].instanceId, "i9", "unreleased lease must stay in the ledger");
});

test("adapter surfaces quarantined instances as operator errors", async () => {
    const { dir, accessPath } = fixture();
    writeFileSync(join(dir, "private-platform-instances.json"), JSON.stringify({ ["ch_" + "d".repeat(64)]: { key: "k", instanceId: "i9" } }));
    const adapter = new DesktopCompetitionAdapter(accessPath, dir, async () => jsonResponse(200, { instanceId: "i9", status: "quarantined" }));
    await assert.rejects(() => adapter.releaseEnvironment("ch_" + "d".repeat(64)), /requires operator review/);
});

test("adapter treats a missing ledger record as already released", async () => {
    const { dir, accessPath } = fixture();
    const adapter = new DesktopCompetitionAdapter(accessPath, dir, async () => {
        throw new Error("must not call the platform");
    });
    assert.deepEqual(await adapter.releaseEnvironment("ch_" + "e".repeat(64)), { released: true, created: false, status: "released" });
});

// --- solver manager ------------------------------------------------------

function managerFixture({ tasks, stopResult, releaseResult }) {
    const released = [];
    const controller = {
        listTasks: async () => tasks,
        coordinator: {
            stopTask: async (taskId, reason) => (typeof stopResult === "function" ? stopResult(taskId, reason) : stopResult),
            releaseEnvironment: async (leaseId) => {
                released.push(leaseId);
                if (typeof releaseResult === "function") return releaseResult(leaseId);
                return releaseResult;
            },
        },
    };
    const bridge = {};
    return { manager: new DesktopSolverManager(controller, bridge, "main-1"), released };
}

test("manager retries the environment release the broker left behind", async () => {
    const task = { taskId: "t1", status: "stopped", environmentLeaseId: "lease-1" };
    const { manager, released } = managerFixture({
        tasks: [task],
        stopResult: { task, environmentRelease: { error: "DELETE timed out" } },
        releaseResult: { released: true, platform: { released: true, status: "released" } },
    });
    const result = await manager.finalizeTask("t1", "solver finished");
    assert.deepEqual(released, ["lease-1"]);
    assert.equal(result.release.released, true);
});

test("manager reports incomplete cleanup instead of a clean stop", async () => {
    const task = { taskId: "t2", status: "stopped", environmentLeaseId: "lease-2" };
    const { manager, released } = managerFixture({
        tasks: [task],
        stopResult: { task, environmentRelease: { error: "DELETE timed out" } },
        releaseResult: { released: false },
    });
    await assert.rejects(() => manager.finalizeTask("t2", "solver finished"), /Environment release failed/);
    assert.deepEqual(released, ["lease-2"]);
});

test("manager does not retry release when the broker freed the slot", async () => {
    const task = { taskId: "t3", status: "stopped" };
    const { manager, released } = managerFixture({
        tasks: [task],
        stopResult: { task, environmentRelease: { released: true, status: "released" } },
        releaseResult: { released: true },
    });
    await manager.finalizeTask("t3", "ok");
    assert.deepEqual(released, []);
});

test("manager can retry a stuck lease after its solver entry is gone", async () => {
    const task = { taskId: "t4", status: "stopped", environmentLeaseId: "lease-4" };
    const { manager, released } = managerFixture({
        tasks: [task],
        stopResult: { task, environmentRelease: { released: true, status: "released" } },
        releaseResult: { released: true },
    });
    const result = await manager.stop("t4");
    assert.equal(result.stopped, true);
    assert.equal(result.recovered, true);
});

test("manager leaves tasks without a lease alone when there is no solver entry", async () => {
    const { manager, released } = managerFixture({
        tasks: [{ taskId: "t5", status: "stopped" }],
        stopResult: { task: { taskId: "t5", status: "stopped" } },
        releaseResult: { released: true },
    });
    assert.deepEqual(await manager.stop("t5"), { taskId: "t5", stopped: false });
    assert.deepEqual(released, []);
});

test("manager refuses to dispatch a task that is neither queued nor environment_blocked", async () => {
    const { manager } = managerFixture({
        tasks: [{ taskId: "t6", status: "stopped" }],
        stopResult: { task: {} },
        releaseResult: { released: true },
    });
    await assert.rejects(() => manager.dispatch({ taskId: "t6", prompt: "go" }), /not dispatchable/);
});

test("manager refuses a second live solver for the same task", async () => {
    const { manager } = managerFixture({ tasks: [], stopResult: {}, releaseResult: { released: true } });
    manager.entries.set("t7", { taskId: "t7", running: true });
    await assert.rejects(() => manager.dispatch({ taskId: "t7", prompt: "go" }), /already has a live desktop solver/);
});


test("adapter makes the attempt budget configurable instead of forcing one try", async () => {
 const { dir, accessPath } = fixture();
 assert.equal((await new DesktopCompetitionAdapter(accessPath, dir, async () => jsonResponse(200, {})).getPolicy()).submission.maxAttempts, 3);
 assert.equal((await new DesktopCompetitionAdapter(accessPath, dir, async () => jsonResponse(200, {}), { maxAttempts: 1 }).getPolicy()).submission.maxAttempts, 1);
 assert.throws(() => new DesktopCompetitionAdapter(accessPath, dir, async () => jsonResponse(200, {}), { maxAttempts: 0 }));
});
test("adapter returns incorrect feedback and distinguishes limit/unavailable responses", async () => {
 const { dir, accessPath } = fixture();
 const id = "ch_" + "a".repeat(64);
 const adapter = new DesktopCompetitionAdapter(accessPath, dir, async () => jsonResponse(200, { verified: false, status: "incorrect", message: "Correct the candidate" }));
 assert.equal((await adapter.submitFlag(id, "synthetic")).message, "Correct the candidate");
 for (const status of ["limit_exceeded", "duplicate", "unknown"]) {
  const blocked = new DesktopCompetitionAdapter(accessPath, dir, async () => jsonResponse(200, { verified: false, status }));
  await assert.rejects(() => blocked.submitFlag(id, "synthetic"), error => error.category === (status === "limit_exceeded" ? "rate_limited" : "request_error"));
 }
});
test("manager cleans an accepted task lease while retaining solved and leaving Main alone", async () => {
 const task = { taskId: "accepted-task", status: "solved", environmentLeaseId: "accepted-lease" };
 const { manager, released } = managerFixture({ tasks: [task], stopResult: {}, releaseResult: { released: true } });
 assert.equal((await manager.finalizeTask(task.taskId, "accepted")).solved, true);
 assert.equal(task.status, "solved"); assert.deepEqual(released, ["accepted-lease"]);
});
test("manager surfaces cleanup failure for accepted tasks without undoing success", async () => {
 const task = { taskId: "accepted-task", status: "solved", environmentLeaseId: "accepted-lease" };
 const { manager } = managerFixture({ tasks: [task], stopResult: {}, releaseResult: { released: false, error: "release failed" } });
 await assert.rejects(() => manager.finalizeTask(task.taskId, "accepted"), /cleanup failed/); assert.equal(task.status, "solved");
});
