import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BackgroundCommands, commandSeconds } from "../src/background-commands.ts";
import { createBoundedCtfBashTool } from "../src/command-budget.ts";

describe("background command lifecycle", () => {
	it("does not replay cancelled parent results into the next prompt", async () => {
		const root = mkdtempSync(join(tmpdir(), "async-parent-outbox-"));
		const tasks = new BackgroundCommands(root, vi.fn());
		try {
			await tasks.run("fixture", { run_in_background: true }, undefined, async () => ({
				content: [{ type: "text", text: "old-parent-result" }],
				details: {},
			}));
			if (tasks.pendingCount) await tasks.waitForChange();
			expect(tasks.completionBatch().ids).toHaveLength(1);
			await tasks.cancelAll();
			tasks.beginRun();
			tasks.retryUnacknowledged();
			expect(tasks.completionBatch().ids).toEqual([]);
			expect(tasks.undeliveredCount).toBe(0);
		} finally {
			await tasks.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("keeps completion delivery separate from execution and avoids repeating output with a cursor", async () => {
		const root = mkdtempSync(join(tmpdir(), "async-outbox-"));
		const tasks = new BackgroundCommands(root, vi.fn());
		try {
			const result = await tasks.run("fixture", { run_in_background: true }, undefined, async () => ({
				content: [{ type: "text", text: "cursor-result" }],
				details: {},
			}));
			const id = (result.details as { task_id: string }).task_id;
			if (tasks.pendingCount) await tasks.waitForChange();
			expect(tasks.completionBatch().ids).toEqual([id]);
			const output = tasks.output(id);
			expect(JSON.stringify(output)).toContain("cursor-result");
			const seq = (output.details as { next_seq: number }).next_seq;
			expect(JSON.stringify(tasks.output(id, seq))).not.toContain("cursor-result");
			tasks.markEnqueued([id]);
			expect(tasks.completionBatch().ids).toEqual([]);
			expect(tasks.undeliveredCount).toBe(1);
			tasks.retryUnacknowledged();
			expect(tasks.completionBatch().ids).toEqual([id]);
			tasks.markEnqueued([id]);
			tasks.acknowledge([id]);
			tasks.acknowledge([id]);
			tasks.retryUnacknowledged();
			expect(tasks.undeliveredCount).toBe(0);
			expect(tasks.completionBatch().ids).toEqual([]);
		} finally {
			await tasks.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("leaves no phantom task when initial storage creation fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "async-create-fail-"));
		writeFileSync(join(root, "command-tasks"), "blocked");
		const notify = vi.fn();
		const execute = vi.fn();
		const tasks = new BackgroundCommands(root, notify);
		try {
			for (const input of [{}, { run_in_background: true }]) {
				await expect(tasks.run("bash", input, undefined, execute)).rejects.toThrow();
				expect(tasks.pendingCount).toBe(0);
				expect(tasks.pendingContext()).toBe("");
			}
			expect(execute).not.toHaveBeenCalled();
			expect(notify).not.toHaveBeenCalled();
			await tasks.cancelAll();
			tasks.beginRun();
			rmSync(join(root, "command-tasks"));
			await tasks.run("bash", {}, undefined, async () => ({ content: [], details: {} }));
			expect(tasks.pendingCount).toBe(0);
		} finally {
			await tasks.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("settles and retains results when output writes and completion delivery fail", async () => {
		const root = mkdtempSync(join(tmpdir(), "async-save-fail-"));
		const notify = vi.fn((_content: string) => {
			throw new Error("delivery failed");
		});
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const tasks = new BackgroundCommands(root, notify);
		let finish = () => {};
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		try {
			const result = await tasks.run("bash", { run_in_background: true }, undefined, async (_signal, update) => {
				await gate;
				const output = { content: [{ type: "text" as const, text: "retained-result" }], details: {} };
				update(output);
				return output;
			});
			const details = result.details as { task_id: string; output_path: string };
			rmSync(details.output_path);
			mkdirSync(details.output_path);
			const changed = tasks.waitForChange();
			finish();
			await changed;
			expect(tasks.pendingCount).toBe(0);
			expect(JSON.stringify(tasks.output(details.task_id))).toContain("retained-result");
			expect((await tasks.stop(details.task_id)).details).toMatchObject({
				status: "completed",
				persistence_error: expect.any(String),
			});
			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify.mock.calls[0][0]).toContain("Output file unavailable");
		} finally {
			finish();
			await tasks.close();
			warning.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("runs from a read-only command cwd using separate writable storage", async () => {
		const root = mkdtempSync(join(tmpdir(), "async-readonly-cwd-"));
		const cwd = join(root, "workspace");
		mkdirSync(cwd);
		chmodSync(cwd, 0o555);
		const tasks = new BackgroundCommands(join(root, "state"), vi.fn());
		const tool = createBoundedCtfBashTool(cwd, tasks);
		try {
			const result = await tool.execute(
				"readonly",
				{ command: "printf writable-state" },
				undefined,
				undefined,
				undefined as unknown as Parameters<typeof tool.execute>[4],
			);
			expect(JSON.stringify(result)).toContain("writable-state");
			expect(tasks.pendingCount).toBe(0);
		} finally {
			await tasks.close();
			chmodSync(cwd, 0o755);
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("uses Claude Code time limits", () => {
		expect(commandSeconds(undefined)).toBe(120);
		expect(commandSeconds(900)).toBe(600);
		expect(commandSeconds(undefined, true)).toBe(1800);
		expect(commandSeconds(9000, true)).toBe(7200);
		for (const value of [0, -1, NaN, Infinity, null, "600"]) expect(() => commandSeconds(value)).toThrow();
	});
	it("moves a live shell to background, runs independent work, persists and notifies exactly once", async () => {
		const root = mkdtempSync(join(tmpdir(), "async-command-"));
		const notify = vi.fn();
		const tasks = new BackgroundCommands(root, notify);
		const tool = createBoundedCtfBashTool(root, tasks);
		const ctx = undefined as unknown as Parameters<typeof tool.execute>[4];
		try {
			const result = await tool.execute(
				"long",
				{ command: "sleep 0.3; printf finished", timeout: 0.02 },
				undefined,
				undefined,
				ctx,
			);
			expect(result.content).toEqual(
				expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("Processing") })]),
			);
			expect(tasks.pendingContext()).toContain("result is not available yet");
			const independent = await tool.execute("short", { command: "printf independent" }, undefined, undefined, ctx);
			expect(JSON.stringify(independent)).toContain("independent");
			expect(tasks.pendingCount).toBe(1);
			await tasks.waitForChange();
			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify.mock.calls[0][0]).toContain("finished");
			const details = result.details as { output_path: string };
			expect(readFileSync(details.output_path, "utf8")).toContain("finished");
			expect(tasks.pendingContext()).toBe("");
		} finally {
			await tasks.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("cancels only the requested task and suppresses wakeups when the parent ends", async () => {
		const root = mkdtempSync(join(tmpdir(), "async-cancel-"));
		const notify = vi.fn();
		const tasks = new BackgroundCommands(root, notify);
		const tool = createBoundedCtfBashTool(root, tasks);
		const ctx = undefined as unknown as Parameters<typeof tool.execute>[4];
		try {
			const first = await tool.execute(
				"a",
				{ command: "sleep 20", run_in_background: true },
				undefined,
				undefined,
				ctx,
			);
			await tool.execute("b", { command: "sleep 20", run_in_background: true }, undefined, undefined, ctx);
			const firstId = (first.details as { task_id: string }).task_id;
			const changed = tasks.waitForChange();
			expect((await tasks.stop(firstId)).details).toMatchObject({ status: "cancelled" });
			await changed;
			expect((await tasks.stop(firstId)).details).toMatchObject({ status: "cancelled" });
			expect(tasks.pendingCount).toBe(1);
			expect(notify).toHaveBeenCalledTimes(1);
			await tasks.cancelAll();
			expect(tasks.pendingCount).toBe(0);
			expect(notify).toHaveBeenCalledTimes(1);
		} finally {
			await tasks.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("enforces the explicit background execution deadline", async () => {
		const root = mkdtempSync(join(tmpdir(), "async-deadline-"));
		const notify = vi.fn();
		const tasks = new BackgroundCommands(root, notify);
		const tool = createBoundedCtfBashTool(root, tasks);
		try {
			await tool.execute(
				"deadline",
				{ command: "sleep 20", run_in_background: true, timeout: 0.05 },
				undefined,
				undefined,
				undefined as unknown as Parameters<typeof tool.execute>[4],
			);
			await tasks.waitForChange();
			expect(tasks.pendingCount).toBe(0);
			expect(notify.mock.calls[0][0]).toContain("cancelled");
		} finally {
			await tasks.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
