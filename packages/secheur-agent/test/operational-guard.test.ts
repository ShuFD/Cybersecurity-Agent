import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundCommands } from "../src/background-commands.ts";
import { boundedAbort, OperationalGuard } from "../src/operational-guard.ts";

const roots: string[] = [];
function root(): string {
	const path = mkdtempSync(join(tmpdir(), "operational-"));
	roots.push(path);
	return path;
}
function observe(guard: OperationalGuard, text: string): void {
	guard.observe("bash", {}, [{ type: "text", text }], false);
}
afterEach(() => {
	vi.useRealTimers();
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
describe("durable operational controls", () => {
	it("honors a native remote quota response without fabricating local attempt counts", () => {
		const path = root();
		const guard = new OperationalGuard(path, "remote-quota");
		observe(guard, "proof");
		guard.reserveVerification("candidate");
		guard.settleVerification("candidate", "unavailable", true);
		expect(guard.remainingAttempts).toBe(0);
		expect(guard.verificationState).toBe("quota_exhausted");
		expect(new OperationalGuard(path, "remote-quota").verificationState).toBe("quota_exhausted");
	});
	it("waits for concurrent reservations before declaring quota exhausted and preserves late success", async () => {
		const path = root();
		const guard = new OperationalGuard(path, "concurrent");
		for (let i = 0; i < 3; i++) {
			observe(guard, `proof-${i}`);
			guard.reserveVerification(`c-${i}`);
		}
		expect(guard.verificationState).toBe("pending");
		let resolved = false;
		const waiting = guard.waitForVerificationSettlement().then(() => {
			resolved = true;
		});
		guard.settleVerification("c-2", "incorrect");
		guard.settleVerification("c-1", "unavailable");
		await Promise.resolve();
		expect(resolved).toBe(false);
		guard.settleVerification("c-0", "correct");
		await waiting;
		expect(guard.verificationState).toBe("accepted");
		expect(new OperationalGuard(path, "concurrent").verificationState).toBe("accepted");
	});
	it("records exhausted failure only after all in-flight verification results settle", async () => {
		const path = root();
		const guard = new OperationalGuard(path, "failed");
		for (let i = 0; i < 3; i++) {
			observe(guard, `proof-${i}`);
			guard.reserveVerification(`c-${i}`);
		}
		guard.settleVerification("c-2", "incorrect");
		expect(guard.verificationState).toBe("pending");
		guard.settleVerification("c-0", "incorrect");
		guard.settleVerification("c-1", "incorrect");
		expect(guard.verificationState).toBe("quota_exhausted");
		expect(new OperationalGuard(path, "failed").verificationState).toBe("quota_exhausted");
		expect(() => guard.settleVerification("unknown", "correct")).toThrow("reservation");
		expect(() => guard.settleVerification("c-1", "correct")).toThrow("Conflicting");
	});
	it("honors cancellation while dispatch waits for in-flight verification", async () => {
		const guard = new OperationalGuard(root(), "cancel");
		for (let i = 0; i < 3; i++) {
			observe(guard, `proof-${i}`);
			guard.reserveVerification(`c-${i}`);
		}
		const controller = new AbortController();
		const waiting = guard.waitForVerificationSettlement(controller.signal);
		controller.abort(new Error("cancelled"));
		await expect(waiting).rejects.toThrow("cancelled");
		guard.settleVerification("c-0", "incorrect");
		expect(guard.remainingAttempts).toBe(0);
	});
	it("allows corrections from existing evidence and preserves shared quota across restarts", () => {
		const path = root();
		let guard = new OperationalGuard(path, "run-a");
		expect(guard.reserveVerification("test-one")).toBe("allowed");
		expect(guard.reserveVerification("test-one")).toBe("duplicate");
		guard = new OperationalGuard(path, "run-a");
		expect(guard.remainingAttempts).toBe(2);
		observe(guard, "evidence1");
		expect(guard.reserveVerification("test-two")).toBe("allowed");
		expect(guard.reserveVerification("test-three")).toBe("allowed");
		expect(guard.reserveVerification("test-four")).toBe("quota_exhausted");
		expect(new OperationalGuard(path, "run-b").remainingAttempts).toBe(3);
	});
	it("keeps checkpoints available without making verification depend on observation freshness", () => {
		const guard = new OperationalGuard(root(), "run-a");
		guard.observe("bash", {}, "failure", true);
		guard.observe("bash", {}, "processing", false, { status: "running" });
		guard.observe("task_output", {}, "completed", false);
		guard.observe("update_working_checkpoint", { note: "next step" }, "saved", false);
		expect(guard.reserveVerification("one")).toBe("allowed");
		expect(guard.context()).toContain("next step");
		expect(guard.context("", { includeCheckpoint: false })).not.toContain("next step");
	});
	it("atomically reserves the final shared attempt when two executors submit concurrently", async () => {
		const guard = new OperationalGuard(root(), "last-slot");
		guard.reserveVerification("a");
		guard.reserveVerification("b");
		const results = await Promise.all(["c", "d"].map(async (value) => guard.reserveVerification(value)));
		expect(results).toEqual(["allowed", "quota_exhausted"]);
		expect(guard.remainingAttempts).toBe(0);
	});
	it("allows repeated recovery across restarts and quota exhaustion without resetting parent budgets", () => {
		const path = root();
		const guard = new OperationalGuard(path, "run-a");
		guard.setTurnsUsed(12);
		guard.setCostUsed(0.25);
		expect(guard.takeRecovery()).toBe(true);
		const restored = new OperationalGuard(path, "run-a");
		expect(restored.takeRecovery()).toBe(true);
		observe(restored, "new progress");
		expect(restored.takeRecovery()).toBe(true);
		for (let i = 0; i < 3; i++) {
			observe(restored, `quota-proof-${i}`);
			restored.reserveVerification(`candidate-${i}`);
		}
		expect(restored.remainingAttempts).toBe(0);
		expect(restored.takeRecovery()).toBe(true);
		expect(restored.turnsUsed).toBe(12);
		expect(restored.costUsed).toBe(0.25);
	});
	it("blocks the third identical call, permits changed actions and fresh output", () => {
		const guard = new OperationalGuard(root(), "run-a");
		expect(guard.repeatedCall("bash", { command: "echo test" })).toBe(false);
		expect(guard.repeatedCall("bash", { command: "echo test" })).toBe(false);
		expect(guard.repeatedCall("bash", { command: "echo test" })).toBe(true);
		observe(guard, "new output");
		expect(guard.repeatedCall("bash", { command: "echo test" })).toBe(false);
	});
	it("fails closed on corrupt ledger instead of granting fresh quota", () => {
		const path = root();
		const guard = new OperationalGuard(path, "run-a");
		guard.setTurnsUsed(1);
		const directory = join(path, "operational-runs");
		writeFileSync(join(directory, readdirSync(directory)[0]), "{}");
		expect(() => new OperationalGuard(path, "run-a")).toThrow("Invalid operational ledger");
	});
	it("bounds uncooperative abort and handles rejected operations", async () => {
		expect(await boundedAbort(Promise.reject(new Error("abort failed")), 10)).toBe(true);
		expect(await boundedAbort(new Promise(() => {}), 10)).toBe(false);
	});
	it("restores undelivered completion once and preserves query aliases", async () => {
		const path = root();
		const tasks = new BackgroundCommands(path, () => {}, "run-a");
		const result = await tasks.run("bash", { run_in_background: true }, undefined, async () => ({
			content: [{ type: "text", text: "synthetic output" }],
			details: {},
		}));
		const id = (result.details as { task_id: string }).task_id;
		await vi.waitFor(() => expect(tasks.pendingCount).toBe(0));
		tasks.markEnqueued([id]);
		const restored = new BackgroundCommands(path, () => {}, "run-a");
		expect(restored.owns(id)).toBe(true);
		expect(restored.completionBatch().ids).toEqual([id]);
		restored.acknowledge([id]);
		expect(new BackgroundCommands(path, () => {}, "run-a").completionBatch().ids).toEqual([]);
		expect(new BackgroundCommands(path, () => {}, "run-b").owns(id)).toBe(false);
		await tasks.close();
		await restored.close();
	});
	it("marks running commands interrupted on restart without executing them again", async () => {
		const path = root();
		const tasks = new BackgroundCommands(path, () => {}, "run-a");
		const result = await tasks.run(
			"bash",
			{ run_in_background: true },
			undefined,
			async (signal) =>
				new Promise((resolve) =>
					signal.addEventListener("abort", () => resolve({ content: [], details: {} }), { once: true }),
				),
		);
		const id = (result.details as { task_id: string }).task_id;
		const restored = new BackgroundCommands(path, () => {}, "run-a");
		expect((restored.output(id).details as { status: string }).status).toBe("failed");
		expect(restored.completionBatch().ids).toEqual([id]);
		expect(JSON.stringify(restored.output(id))).toContain("not replayed");
		await tasks.close();
		await restored.close();
	});
	it("does not resurrect notifications after a parent cancellation and restart", async () => {
		const path = root();
		const tasks = new BackgroundCommands(path, () => {}, "cancelled-run");
		await tasks.run("bash", { run_in_background: true }, undefined, async () => ({
			content: [{ type: "text", text: "completed output" }],
			details: {},
		}));
		await vi.waitFor(() => expect(tasks.pendingCount).toBe(0));
		await tasks.cancelAll();
		const restored = new BackgroundCommands(path, () => {}, "cancelled-run");
		expect(restored.completionBatch().ids).toEqual([]);
		await restored.close();
	});
});
