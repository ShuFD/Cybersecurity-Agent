import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { SecHeurBridge } from "../src/bridge.ts";
import { writeDesktopConfig } from "../src/desktop-config.ts";

const bridges: SecHeurBridge[] = [];
const roots: string[] = [];

afterEach(async () => {
	for (const bridge of bridges.splice(0)) await bridge.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function assistantMessage(text: string, timestamp: number) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
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
		stopReason: "stop" as const,
		timestamp,
	};
}

describe("persisted session refresh", () => {
	it("uses the environment knowledge-base override for discovered sessions", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-persisted-knowledge-env-test-"));
		roots.push(root);
		writeDesktopConfig(root, { knowledgeBaseEnabled: false });
		const manager = SessionManager.create(root, join(root, ".secheur-agent", "pi", "sessions", "fixture"));
		manager.appendMessage({ role: "user", content: "restore with attack knowledge", timestamp: Date.now() });
		// Pi persists a new session after its first assistant response.
		manager.appendMessage(assistantMessage("Synthetic persisted reply", Date.now()));

		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			schedulerBackend: false,
			env: { SECHEUR_KNOWLEDGE_BASE_ENABLED: "1" },
		});
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;

		const listed = (await fetch(`${base}/sessions`).then((response) => response.json())) as {
			sessions: Array<{ id: string; knowledgeBaseEnabled: boolean }>;
		};
		expect(listed.sessions).toEqual([
			expect.objectContaining({ id: manager.getSessionId(), knowledgeBaseEnabled: true }),
		]);
	});

	it("reloads metadata and messages appended by an independent TUI process", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-persisted-refresh-test-"));
		roots.push(root);
		const manager = SessionManager.create(root, join(root, ".secheur-agent", "pi", "sessions", "fixture"));
		const initialTimestamp = Date.now() - 1_000;
		manager.appendMessage({ role: "user", content: "first question", timestamp: initialTimestamp });
		manager.appendMessage(assistantMessage("first answer", initialTimestamp + 1));
		manager.appendSessionInfo("Initial title");

		const bridge = new SecHeurBridge({ projectRoot: root, port: 0, schedulerBackend: false });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const initial = (await fetch(`${base}/sessions`).then((response) => response.json())) as {
			sessions: Array<{ id: string; msgSeq: number; title: string; updatedAt: number }>;
		};
		expect(initial.sessions).toEqual([
			expect.objectContaining({ id: manager.getSessionId(), msgSeq: 2, title: "Initial title" }),
		]);

		const nextTimestamp = Date.now();
		manager.appendMessage({ role: "user", content: "second question", timestamp: nextTimestamp });
		manager.appendMessage(assistantMessage("second answer", nextTimestamp + 1));
		manager.appendSessionInfo("Updated title");

		const refreshed = (await fetch(`${base}/sessions`).then((response) => response.json())) as {
			sessions: Array<{ id: string; msgSeq: number; title: string; updatedAt: number }>;
		};
		expect(refreshed.sessions).toEqual([
			expect.objectContaining({ id: manager.getSessionId(), msgSeq: 4, title: "Updated title" }),
		]);
		expect(refreshed.sessions[0]!.updatedAt).toBeGreaterThan(initial.sessions[0]!.updatedAt);

		const messages = (await fetch(`${base}/session/${manager.getSessionId()}/messages?after=2`).then((response) =>
			response.json(),
		)) as { messages: Array<{ id: number; role: string; content: string }> };
		expect(messages.messages).toEqual([
			expect.objectContaining({ id: 3, role: "user", content: "second question" }),
			expect.objectContaining({ id: 4, role: "assistant", content: "second answer" }),
		]);
	});

	it("filters exact offline self-test artifacts but keeps sessions with later real activity", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-persisted-self-test-filter-"));
		roots.push(root);
		const sessionDir = join(root, ".secheur-agent", "pi", "sessions", "fixture");
		const timestamp = Date.now() - 10_000;

		const artifact = SessionManager.create(root, sessionDir);
		artifact.appendMessage({ role: "user", content: "self-test prompt", timestamp });
		artifact.appendMessage(assistantMessage("self-test reply", timestamp + 1));

		const continued = SessionManager.create(root, sessionDir);
		continued.appendMessage({ role: "user", content: "self-test prompt", timestamp: timestamp + 2 });
		continued.appendMessage(assistantMessage("self-test reply", timestamp + 3));
		continued.appendMessage({ role: "user", content: "real follow-up", timestamp: timestamp + 4 });

		const normal = SessionManager.create(root, sessionDir);
		normal.appendMessage({ role: "user", content: "normal session", timestamp: timestamp + 5 });
		normal.appendMessage(assistantMessage("normal reply", timestamp + 6));

		const bridge = new SecHeurBridge({ projectRoot: root, port: 0, schedulerBackend: false });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const listed = (await fetch(`${base}/sessions`).then((response) => response.json())) as {
			activeSessionId: string | null;
			sessions: Array<{ id: string }>;
		};
		const ids = listed.sessions.map((session) => session.id);

		expect(ids).not.toContain(artifact.getSessionId());
		expect(ids).toContain(continued.getSessionId());
		expect(ids).toContain(normal.getSessionId());
		expect(listed.activeSessionId).not.toBe(artifact.getSessionId());
	});

	it("orders sessions by recent activity without reordering on activation", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-persisted-recency-test-"));
		roots.push(root);
		const sessionDir = join(root, ".secheur-agent", "pi", "sessions", "fixture");
		const timestamp = Date.now() - 60_000;

		const older = SessionManager.create(root, sessionDir);
		older.appendMessage({ role: "user", content: "older", timestamp });
		older.appendMessage(assistantMessage("older reply", timestamp + 1));
		older.appendSessionInfo("Older session");
		const newer = SessionManager.create(root, sessionDir);
		newer.appendMessage({ role: "user", content: "newer", timestamp: timestamp + 10_000 });
		newer.appendMessage(assistantMessage("newer reply", timestamp + 10_001));
		newer.appendSessionInfo("Newer session");

		const bridge = new SecHeurBridge({ projectRoot: root, port: 0, schedulerBackend: false });
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const before = (await fetch(`${base}/sessions`).then((response) => response.json())) as {
			sessions: Array<{ id: string; updatedAt: number }>;
		};
		expect(before.sessions.map((session) => session.id)).toEqual([newer.getSessionId(), older.getSessionId()]);
		const olderBefore = before.sessions.find((session) => session.id === older.getSessionId())!.updatedAt;

		const activatedResponse = await fetch(`${base}/session/${older.getSessionId()}/activate`, { method: "POST" });
		expect(activatedResponse.status).toBe(200);
		const after = (await fetch(`${base}/sessions`).then((response) => response.json())) as {
			activeSessionId: string | null;
			sessions: Array<{ id: string; updatedAt: number }>;
		};

		expect(after.activeSessionId).toBe(older.getSessionId());
		expect(after.sessions.map((session) => session.id)).toEqual([newer.getSessionId(), older.getSessionId()]);
		expect(after.sessions.find((session) => session.id === older.getSessionId())!.updatedAt).toBe(olderBefore);
	});

	it.each(["0", "false"])("skips persisted session discovery when configured with %s", async (value) => {
		const root = mkdtempSync(join(tmpdir(), "secheur-persisted-disabled-test-"));
		roots.push(root);
		const manager = SessionManager.create(root, join(root, ".secheur-agent", "pi", "sessions", "fixture"));
		manager.appendMessage({ role: "user", content: "history must stay hidden", timestamp: Date.now() });

		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			schedulerBackend: false,
			env: { SECHEUR_LOAD_PERSISTED_SESSIONS: value },
		});
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;

		const listed = (await fetch(`${base}/sessions`).then((response) => response.json())) as {
			sessions: Array<{ id: string }>;
		};
		expect(listed.sessions).toEqual([]);

		const persisted = await fetch(`${base}/session/${manager.getSessionId()}`);
		expect(persisted.status).toBe(404);
	});
});
