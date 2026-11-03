import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { SecHeurBridge } from "../src/bridge.ts";

const bridges: SecHeurBridge[] = [];
const roots: string[] = [];

afterEach(async () => {
	for (const bridge of bridges.splice(0)) await bridge.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("planning user display", () => {
	it("restores planning goals as users without reclassifying controller messages", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-planning-user-display-"));
		roots.push(root);
		const manager = SessionManager.create(root, join(root, ".secheur-agent", "pi", "sessions", "fixture"));
		for (const [customType, content] of [
			["progressive-planning-goal", "actual user question"],
			["progressive-planning-result", "controller result"],
			["progressive-planning-failure", "controller failure"],
			["secheur-budget", "budget notice"],
		] as const) {
			manager.appendCustomMessageEntry(customType, content, false);
		}
		manager.appendMessage({ role: "user", content: "direct follow-up", timestamp: Date.now() });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "answer" }],
			api: "openai-completions",
			provider: "fixture",
			model: "fixture",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const bridge = new SecHeurBridge({ projectRoot: root, port: 0, schedulerBackend: false });
		bridges.push(bridge);
		await bridge.listen();
		const listed = (await fetch(`http://127.0.0.1:${bridge.address.port}/sessions`).then((response) =>
			response.json(),
		)) as { sessions: Array<{ id: string }> };
		expect(listed.sessions).toEqual([expect.objectContaining({ id: manager.getSessionId() })]);
		const response = await fetch(
			`http://127.0.0.1:${bridge.address.port}/session/${manager.getSessionId()}/messages?after=0&limit=0`,
		);
		expect(response.status).toBe(200);
		const result = (await response.json()) as { messages: Array<{ role: string; content: string }> };
		expect(result.messages.map(({ role, content }) => ({ role, content }))).toEqual([
			{ role: "user", content: "actual user question" },
			{ role: "custom", content: "controller result" },
			{ role: "custom", content: "controller failure" },
			{ role: "system", content: "budget notice" },
			{ role: "user", content: "direct follow-up" },
			{ role: "assistant", content: "answer" },
		]);
	});

	it("deduplicates an accepted planning prompt and preserves its display text", () => {
		const bridge = Object.create(SecHeurBridge.prototype) as {
			appendMessage(session: unknown, message: unknown): number;
			updateRuntimeMessageRecord(session: unknown, id: number, message: unknown): void;
		};
		const record = { id: 1, role: "user", content: "display prompt", queued_status: "queued" };
		const session = {
			seenRuntimeMessages: new WeakSet(),
			pendingRuntimeUsers: [1],
			messageRecords: [record],
		};
		const message = {
			role: "custom",
			customType: "progressive-planning-goal",
			content: "full runtime prompt",
		};
		expect(bridge.appendMessage(session, message)).toBe(1);
		expect(session.pendingRuntimeUsers).toEqual([]);
		expect(session.messageRecords).toHaveLength(1);
		expect(record.queued_status).toBe("delivered");
		bridge.updateRuntimeMessageRecord(session, 1, message);
		expect(record.content).toBe("display prompt");
		expect(record.role).toBe("user");
	});
});
