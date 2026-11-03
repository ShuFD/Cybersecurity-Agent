import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BackgroundCommands } from "../src/background-commands.ts";

const result = { content: [{ type: "text" as const, text: "generic-result" }], details: {} };

describe("background command boundaries", () => {
	it("rejects pre-aborted and closed sessions without executing or registering work", async () => {
		const root = mkdtempSync(join(tmpdir(), "command-boundary-"));
		const tasks = new BackgroundCommands(root, vi.fn());
		const execute = vi.fn(async () => result);
		const controller = new AbortController();
		controller.abort();
		try {
			await expect(tasks.run("bash", {}, controller.signal, execute)).rejects.toThrow();
			await tasks.close();
			await expect(tasks.run("bash", {}, undefined, execute)).rejects.toThrow();
			expect(execute).not.toHaveBeenCalled();
			expect(tasks.pendingCount).toBe(0);
		} finally {
			await tasks.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("settles immediate completion once even when stop follows immediately", async () => {
		const root = mkdtempSync(join(tmpdir(), "command-boundary-"));
		const notify = vi.fn();
		const tasks = new BackgroundCommands(root, notify);
		try {
			const started = await tasks.run("bash", { run_in_background: true }, undefined, async () => result);
			const id = (started.details as { task_id: string }).task_id;
			const first = await tasks.stop(id);
			expect((first.details as { status: string }).status).toMatch(/^(completed|cancelled)$/);
			expect((await tasks.stop(id)).details).toEqual(first.details);
			expect(tasks.pendingCount).toBe(0);
			expect(notify).toHaveBeenCalledTimes(1);
		} finally {
			await tasks.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("settles concurrent completion and cancellation without duplicate notifications or waiters", async () => {
		const root = mkdtempSync(join(tmpdir(), "command-boundary-"));
		const notify = vi.fn();
		const tasks = new BackgroundCommands(root, notify);
		let finish = () => {};
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		try {
			const jobs = await Promise.all(
				Array.from({ length: 8 }, () =>
					tasks.run("bash", { run_in_background: true }, undefined, async () => {
						await gate;
						return result;
					}),
				),
			);
			expect(tasks.pendingCount).toBe(8);
			const changed = tasks.waitForChange();
			finish();
			const terminal = await Promise.all(
				jobs.map((job) => tasks.stop((job.details as { task_id: string }).task_id)),
			);
			await changed;
			expect(tasks.pendingCount).toBe(0);
			expect(tasks.pendingContext()).toBe("");
			expect(notify).toHaveBeenCalledTimes(8);
			for (const job of terminal) {
				const details = job.details as { task_id: string; status: string; output_path: string };
				expect(details.status).toMatch(/^(completed|cancelled)$/);
				expect(JSON.parse(readFileSync(details.output_path, "utf8")).status).toBe(details.status);
			}
		} finally {
			finish();
			await tasks.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("does not expose another session's task and rejects unknown IDs", async () => {
		const root = mkdtempSync(join(tmpdir(), "command-boundary-"));
		const first = new BackgroundCommands(root, vi.fn());
		const second = new BackgroundCommands(root, vi.fn());
		try {
			const started = await first.run("bash", { run_in_background: true }, undefined, async () => result);
			const id = (started.details as { task_id: string }).task_id;
			expect(() => second.output(id)).toThrow("Unknown command task");
			await expect(second.stop(id)).rejects.toThrow("Unknown command task");
			expect(() => first.output("missing")).toThrow("Unknown command task");
			await first.stop(id);
		} finally {
			await first.close();
			await second.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("makes execution failure terminal and permits subsequent commands", async () => {
		const root = mkdtempSync(join(tmpdir(), "command-boundary-"));
		const tasks = new BackgroundCommands(root, vi.fn());
		try {
			await expect(
				tasks.run("bash", {}, undefined, async () => {
					throw new Error("generic-execution-failure");
				}),
			).rejects.toThrow("generic-execution-failure");
			expect(tasks.pendingCount).toBe(0);
			expect(await tasks.run("bash", {}, undefined, async () => result)).toEqual(result);
		} finally {
			await tasks.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
