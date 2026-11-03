import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { BackgroundCommands, registerCommandTasks } from "../src/background-commands.ts";

it("retains a completion after enqueue failure and retries without acknowledging a queued message", async () => {
	const root = mkdtempSync(join(tmpdir(), "completion-delivery-"));
	const hooks = new Map<string, (...args: unknown[]) => unknown>();
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	const send = vi.fn().mockImplementationOnce(() => {
		throw new Error("queue unavailable");
	});
	const pi = {
		on: (name: string, handler: (...args: unknown[]) => unknown) => hooks.set(name, handler),
		registerTool: vi.fn(),
		sendMessage: send,
	} as unknown as ExtensionAPI;
	let notify = () => {};
	const tasks = new BackgroundCommands(root, () => notify());
	notify = registerCommandTasks(pi, tasks);
	try {
		await tasks.run("fixture", { run_in_background: true }, undefined, async () => ({
			content: [{ type: "text", text: "durable-completion" }],
			details: {},
		}));
		if (tasks.pendingCount) await tasks.waitForChange();
		expect(send).toHaveBeenCalledTimes(1);
		expect(tasks.completionBatch().ids).toHaveLength(1);
		hooks.get("turn_end")?.({}, {});
		expect(send).toHaveBeenCalledTimes(2);
		expect(tasks.completionBatch().ids).toEqual([]);
		expect(tasks.undeliveredCount).toBe(1);
		hooks.get("message_end")?.({ message: { role: "custom", ...send.mock.calls[1][0] } });
		expect(tasks.undeliveredCount).toBe(0);
		hooks.get("agent_settled")?.();
		expect(send).toHaveBeenCalledTimes(2);
	} finally {
		await tasks.close();
		warning.mockRestore();
		rmSync(root, { recursive: true, force: true });
	}
});
