import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundCommands } from "../src/background-commands.ts";
import {
	awaitModelAvailability,
	deferModelAvailability,
	providerPlanningFailure,
} from "../src/planning/model-availability.ts";
import { ToolProgressFeedback } from "../src/tool-progress-feedback.ts";

afterEach(() => vi.useRealTimers());
describe("planning orchestration recovery boundaries", () => {
	it("remembers one tool's errors across successful unrelated calls and keeps feedback in context", () => {
		const feedback = new ToolProgressFeedback();
		for (let i = 0; i < 2; i++) {
			expect(feedback.observe(true, "verify_flag", "Invalid input")).toBeUndefined();
			feedback.observe(false, "read", `new output ${i}`);
		}
		expect(feedback.observe(true, "verify_flag", "Invalid input")).toContain("same error 3 times");
		expect(feedback.context()).toContain("verify_flag: 3");
		feedback.observe(false, "verify_flag", "Canonical result");
		expect(feedback.context()).toBe("");
	});
	it("resets repeated-call feedback only when a new successful output appears", () => {
		const feedback = new ToolProgressFeedback();
		feedback.repeatedCall("read", {});
		feedback.observe(false, "read", "old");
		feedback.repeatedCall("read", {});
		feedback.observe(false, "read", "old");
		feedback.repeatedCall("read", {});
		feedback.observe(false, "read", "old");
		expect(feedback.repeatedCall("read", {})).toBe(true);
		feedback.observe(false, "read", "new");
		expect(feedback.repeatedCall("read", {})).toBe(false);
	});
	it("keeps repeated-call and failure feedback local to each sibling", () => {
		const a = new ToolProgressFeedback();
		const b = new ToolProgressFeedback();
		expect(a.repeatedCall("read", { path: "fixture" })).toBe(false);
		expect(a.repeatedCall("read", { path: "fixture" })).toBe(false);
		expect(b.repeatedCall("read", { path: "fixture" })).toBe(false);
		expect(a.repeatedCall("read", { path: "fixture" })).toBe(true);
		expect(a.observe(true)).toBeUndefined();
		expect(a.observe(true)).toBeUndefined();
		expect(a.observe(true)).toContain("Continue the task");
		expect(a.observe(true)).toBeUndefined();
		expect(b.observe(true)).toBeUndefined();
		a.observe(false);
		a.observe(true);
		a.observe(true);
		expect(a.observe(true)).toBeDefined();
	});
	it("distinguishes provider rate limits from quota and keeps server retry timing", () => {
		const error = Object.assign(new Error("HTTP 429"), {
			status: 429,
			headers: new Headers({ "retry-after": "75" }),
		});
		expect(providerPlanningFailure(error)).toMatchObject({
			code: "model_rate_limited",
			stage: "model_provider",
			retryAfterMs: 75000,
		});
		expect(providerPlanningFailure(new Error("429 insufficient_quota"))).toMatchObject({
			code: "model_quota_unavailable",
		});
		expect(providerPlanningFailure(new Error("502 connection unavailable"))).toMatchObject({
			code: "model_transport_error",
		});
		expect(providerPlanningFailure(new Error("invalid task JSON"))).toBeUndefined();
		expect(
			providerPlanningFailure(Object.assign(new Error("429"), { headers: new Headers({ "retry-after": "999999" }) }))
				?.retryAfterMs,
		).toBe(900000);
	});
	it("waits on shared model availability without a model call and preserves cancellation", async () => {
		vi.useFakeTimers();
		const runtime = {} as ModelRuntime;
		deferModelAvailability(runtime, "fixture", 75000);
		const controller = new AbortController();
		const reason = new Error("outer cancellation");
		const waiting = awaitModelAvailability(runtime, "fixture", controller.signal);
		const rejected = expect(waiting).rejects.toBe(reason);
		controller.abort(reason);
		await rejected;
		let ready = false;
		const resumed = awaitModelAvailability(runtime, "fixture").then(() => {
			ready = true;
		});
		await vi.advanceTimersByTimeAsync(74999);
		expect(ready).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await resumed;
		expect(ready).toBe(true);
	});
	it("honors a sibling extending a cooldown while a request is already waiting", async () => {
		vi.useFakeTimers();
		const runtime = {} as ModelRuntime;
		deferModelAvailability(runtime, "shared", 100);
		let ready = false;
		const waiting = awaitModelAvailability(runtime, "shared").then(() => {
			ready = true;
		});
		await vi.advanceTimersByTimeAsync(50);
		deferModelAvailability(runtime, "shared", 100);
		await vi.advanceTimersByTimeAsync(50);
		expect(ready).toBe(false);
		await vi.advanceTimersByTimeAsync(50);
		await waiting;
		expect(ready).toBe(true);
	});
	it("retains background work across an idle turn and settles by completion event", async () => {
		const root = mkdtempSync(join(tmpdir(), "planning-command-owner-"));
		const notify = vi.fn();
		const tasks = new BackgroundCommands(root, notify, "lease-a");
		let finish = () => {};
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		try {
			await tasks.run("bash", { run_in_background: true }, undefined, async () => {
				await gate;
				return { content: [{ type: "text", text: "fixture completed" }], details: {} };
			});
			let settled = false;
			const waiting = tasks.waitForSettlement().then(() => {
				settled = true;
			});
			await Promise.resolve();
			expect(settled).toBe(false);
			expect(tasks.pendingContext()).toContain("processing");
			finish();
			await waiting;
			expect(settled).toBe(true);
			expect(notify).toHaveBeenCalledOnce();
		} finally {
			await tasks.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("cancels only the settlement waiter without terminating a live command", async () => {
		const root = mkdtempSync(join(tmpdir(), "planning-command-owner-"));
		const tasks = new BackgroundCommands(root, () => {});
		let finish = () => {};
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		try {
			await tasks.run("bash", { run_in_background: true }, undefined, async () => {
				await gate;
				return { content: [], details: {} };
			});
			const signal = new AbortController();
			const reason = new Error("wait cancelled");
			const waiting = expect(tasks.waitForSettlement(signal.signal)).rejects.toBe(reason);
			signal.abort(reason);
			await waiting;
			expect(tasks.pendingCount).toBe(1);
			finish();
			await tasks.waitForSettlement();
		} finally {
			await tasks.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
