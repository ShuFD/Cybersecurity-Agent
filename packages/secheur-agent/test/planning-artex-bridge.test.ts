import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { loadSecHeurConfig } from "../src/config.ts";
import { PermissionController } from "../src/permissions.ts";
import { parseArtexProposal } from "../src/planning/artex-adapters.ts";
import { compilePlanningProposal } from "../src/planning/compiler.ts";
import { PlanningStore } from "../src/planning/store.ts";
import type { CreateSecHeurRuntimeOptions } from "../src/runtime.ts";

const factory = vi.hoisted(() => vi.fn());
vi.mock("../src/runtime.ts", () => ({ createSecHeurRuntime: factory }));

import { SecHeurBridge } from "../src/bridge.ts";

it("serves only the active session's Artex graph and original node details", async () => {
	const root = mkdtempSync(join(tmpdir(), "artex-bridge-"));
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const messages: unknown[] = [];
	const permissions = new PermissionController("default");
	factory.mockImplementation(async (options: CreateSecHeurRuntimeOptions) => ({
		config: loadSecHeurConfig(options),
		state: {
			permissions,
			permissionBroker: permissions.broker,
			getTurnCount: () => 0,
			getLastJudge: () => undefined,
			close: () => undefined,
		},
		session: {
			sessionId: "artex-http-session",
			messages,
			setSessionName: () => undefined,
			modelRuntime: { getAvailableSnapshot: () => [], getModels: () => [], getModel: () => undefined },
			abort: async () => undefined,
		},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		prompt: async () => {
			const message = {
				role: "custom",
				customType: "artex-planning-goal",
				content: "Synthetic goal",
				display: false,
				timestamp: Date.now(),
				details: { runId: "planning_artex-http-run" },
			};
			messages.push(message);
			for (const listener of listeners)
				listener({
					type: "message_end",
					message,
				} as AgentSessionEvent);
		},
		setPermissionMode: () => undefined,
		setMemoryReferenceEnabled: () => undefined,
		setKnowledgeBaseEnabled: () => undefined,
		setWebVerbsEnabled: () => undefined,
		dispose: () => undefined,
	}));
	const config = loadSecHeurConfig({ projectRoot: root });
	const store = await PlanningStore.open(join(config.stateDir, "planning.sqlite"));
	const runId = "planning_artex-http-run";
	store.createRun({ runId, outerTaskId: "fixture", goal: "Synthetic goal", mode: "active" });
	const snapshot = store.snapshot(runId);
	const proposal = parseArtexProposal(
		{
			decision: "create_tasks",
			rationale: "Synthetic test",
			todo: "Observe",
			tasks: [{ key: "owner", objective: "Read synthetic record", doneWhen: "Synthetic verification" }],
		},
		snapshot,
	);
	const planned = store.commitPlan({
		runId,
		expectedRevision: 0,
		rationale: proposal.rationale,
		artexUpdate: proposal.artexUpdate,
		tasks: compilePlanningProposal(runId, proposal, [], 8),
		idempotencyKey: "seed",
	});
	const bridge = new SecHeurBridge({
		projectRoot: root,
		port: 0,
		competition: false,
		schedulerBackend: false,
		worklist: false,
	});
	try {
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const post = (path: string, body: unknown) =>
			fetch(base + path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		const created = (await post("/session/new", {
			planningEngine: "artex",
			executionMode: "plan_multi",
			persist: false,
		}).then((response) => response.json())) as { sessionId: string };
		const path = `/session/${created.sessionId}/planning/graph`;
		expect((await fetch(base + path)).status).toBe(404);
		expect(
			await post(`/session/${created.sessionId}/prompt`, { prompt: "Synthetic graph test" }).then((response) =>
				response.json(),
			),
		).toMatchObject({ ok: true });
		await vi.waitFor(async () => {
			const state = (await fetch(`${base}/session/${created.sessionId}`).then((response) => response.json())) as {
				session: { lastError: string; planningRunId: string | null };
			};
			expect(state.session.lastError).toBeFalsy();
			expect(state.session.planningRunId).toBe(runId);
		});
		await vi.waitFor(async () =>
			expect(await fetch(base + path).then((response) => response.json())).toMatchObject({ ok: true }),
		);
		const payload = (await fetch(base + path).then((response) => response.json())) as {
			graph: { runId: string; nodes: unknown[] };
		};
		expect(payload.graph.runId).toBe(runId);
		expect(payload.graph.nodes).toHaveLength(3);
		const nodeId = planned.artexGraph!.nodes[0].id;
		const node = (await fetch(`${base}${path}?node=${nodeId}`).then((response) => response.json())) as {
			node: { id: string };
		};
		expect(node.node.id).toBe(nodeId);
		expect((await fetch(`${base}${path}?node=foreign-run-node`)).status).toBe(404);
		expect((await fetch(`${base}/session/foreign-session/planning/graph`)).status).toBe(404);
	} finally {
		await bridge.close();
		store.close();
		factory.mockReset();
		rmSync(root, { recursive: true, force: true });
	}
});
