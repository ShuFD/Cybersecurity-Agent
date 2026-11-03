import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionMode } from "../src/config.ts";
import { PermissionController } from "../src/permissions.ts";
import { planningFailure } from "../src/planning/failures.ts";

const runtimeFactory = vi.hoisted(() => vi.fn());
vi.mock("../src/runtime.ts", () => ({
	createSecHeurRuntime: runtimeFactory,
}));

import { SecHeurBridge } from "../src/bridge.ts";

const bridges: SecHeurBridge[] = [];
const roots: string[] = [];

afterEach(async () => {
	for (const bridge of bridges.splice(0)) await bridge.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	runtimeFactory.mockReset();
});

describe("Bridge planning cancellation", () => {
	it.each([
		["maxTurns", "max_turns"],
		["maxCost", "max_cost"],
		["quota", "verification_budget_exhausted"],
	])("classifies %s across child cancellation using the outer terminal contract", async (reason, terminalReason) => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-budget-"));
		roots.push(root);
		const permissions = new PermissionController("default");
		runtimeFactory.mockResolvedValue({
			config: {},
			state: {
				permissions,
				permissionBroker: permissions.broker,
				getTurnCount: () => 0,
				operationalGuard: { turnsUsed: 37, toolCallsUsed: 81 },
				getLastJudge: () => undefined,
				close: () => {},
			},
			session: {
				messages: [],
				sessionId: "budget",
				setSessionName: () => {},
				modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
			},
			extensionsResult: {},
			subscribe: () => () => {},
			prompt: async () => {
				throw reason === "quota"
					? planningFailure("executor", "verifier_quota_exhausted", "quota")
					: new Error("outer budget");
			},
			getBudgetStatus: () => ({ stopped: reason !== "quota", reason }),
			setPermissionMode: (mode: PermissionMode) => permissions.setMode(mode),
			setMemoryReferenceEnabled: () => {},
			setKnowledgeBaseEnabled: () => {},
			setWebVerbsEnabled: () => {},
			dispose: () => {},
		} as never);
		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			schedulerBackend: false,
			competition: false,
			worklist: false,
		});
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false }),
		}).then((r) => r.json())) as { sessionId: string };
		await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "synthetic fixture" }),
		});
		await vi.waitFor(async () => {
			const snapshot = (await fetch(`${base}/session/${created.sessionId}`).then((r) => r.json())) as {
				session: { terminalReason?: string };
			};
			expect(snapshot.session.terminalReason).toBe(terminalReason);
		});
	});
	it("routes a running session cancel through runtime.abort", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-bridge-planning-cancel-"));
		roots.push(root);
		const permissions = new PermissionController("default");
		let resolvePrompt!: () => void;
		const prompt = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolvePrompt = resolve;
				}),
		);
		const abort = vi.fn(async () => undefined);
		const runtime = {
			config: {} as never,
			state: {
				permissions,
				permissionBroker: permissions.broker,
				getTurnCount: () => 0,
				operationalGuard: { turnsUsed: 37, toolCallsUsed: 81 },
				getLastJudge: () => undefined,
				close: () => undefined,
			},
			session: {
				messages: [],
				sessionId: "planning-cancel-session",
				sessionFile: undefined,
				sessionName: undefined,
				setSessionName: vi.fn(),
				modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
				abort: vi.fn(async () => undefined),
			},
			extensionsResult: {} as never,
			subscribe: () => () => undefined,
			prompt,
			abort,
			setPermissionMode: (mode: "default" | "acceptEdits" | "dontAsk" | "bypassPermissions" | "plan") =>
				permissions.setMode(mode),
			setMemoryReferenceEnabled: () => undefined,
			setKnowledgeBaseEnabled: () => undefined,
			setWebVerbsEnabled: () => undefined,
			dispose: vi.fn(),
		} as never;
		runtimeFactory.mockResolvedValue(runtime);
		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			schedulerBackend: false,
			competition: false,
			worklist: false,
		});
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false }),
		}).then((response) => response.json())) as { sessionId: string };

		await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "long planning operation" }),
		});
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());

		const cancelled = await fetch(`${base}/session/${created.sessionId}/cancel`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ source: "test", reason: "operator cancelled" }),
		}).then((response) => response.json());
		expect(cancelled).toMatchObject({ ok: true, cancelled: true, status: "cancelled" });
		expect(abort).toHaveBeenCalledWith("user_cancelled");

		resolvePrompt();
		await vi.waitFor(async () => {
			const snapshot = (await fetch(`${base}/session/${created.sessionId}`).then((response) => response.json())) as {
				session: { status: string; turnCount: number; toolCallCount: number };
			};
			expect(snapshot.session.status).toBe("cancelled");
			expect(snapshot.session.turnCount).toBe(37);
			expect(snapshot.session.toolCallCount).toBe(81);
		});
	});
});
