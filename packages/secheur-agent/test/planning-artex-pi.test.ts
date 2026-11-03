import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { type ExtensionAPI, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { loadSecHeurConfig } from "../src/config.ts";
import { ArtexPlanningSupervisor, artexExecutorExtension, parseArtexProposal } from "../src/planning/artex-adapters.ts";
import { artexId } from "../src/planning/artex-graph.ts";
import { compilePlanningProposal } from "../src/planning/compiler.ts";
import { PlanningStore } from "../src/planning/store.ts";

it("uses a real offline Pi planner session, reads original graph IDs and corrects an invalid reference", async () => {
	const root = mkdtempSync(join(tmpdir(), "artex-pi-"));
	const store = await PlanningStore.open(":memory:");
	const runId = "synthetic-artex-pi";
	store.createRun({ runId, outerTaskId: "artex:fixture", goal: "Verify a synthetic record", mode: "active" });
	const faux = fauxProvider({ models: [{ id: "artex-fixture", reasoning: false }] });
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(faux.provider.id, async () => ({ type: "api_key", key: "fixture" }));
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });
	const config = loadSecHeurConfig({
		projectRoot: root,
		stateDir: join(root, "state"),
		legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
		planningEngine: "artex",
		env: { PI_OFFLINE: "1" },
	});
	config.skillPaths = [];
	config.systemPromptPath = "";
	const raw = {
		decision: "create_tasks",
		rationale: "Keep one owner",
		todo: "Observe and verify",
		tasks: [{ key: "owner", objective: "Produce the synthetic result", doneWhen: "Native synthetic verification" }],
	};
	faux.setResponses([
		(context) => {
			expect(context.tools?.map((tool) => tool.name)).toContain("planning_query_context");
			expect(context.tools?.map((tool) => tool.name)).not.toContain("bash");
			return fauxAssistantMessage(
				fauxToolCall(
					"planning_query_context",
					{ section: "nodes", id: artexId(runId, "goal", "goal") },
					{ id: "query" },
				),
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage(
			fauxToolCall(
				"submit_planning_proposal",
				{ ...raw, tasks: [{ ...raw.tasks[0], parentIds: ["foreign-run-node"] }] },
				{ id: "invalid" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(fauxToolCall("submit_planning_proposal", raw, { id: "valid" }), { stopReason: "toolUse" }),
	]);
	try {
		const supervisor = new ArtexPlanningSupervisor({
			config,
			cwd: root,
			model: faux.getModel(),
			modelRuntime: runtime,
			thinkingLevel: "off",
		});
		const proposal = await supervisor.propose({
			snapshot: store.snapshot(runId, true),
			scheduling: { capacity: 2, occupied: 0, available: 2 },
		});
		expect(proposal.artexUpdate?.intents).toHaveLength(1);
		expect(proposal.artexUpdate?.todo).toBe("Observe and verify");
		expect(faux.state.callCount).toBe(3);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it("injects a peer's graph finding on the next executor context and preserves original references", async () => {
	const store = await PlanningStore.open(":memory:");
	const runId = "artex-live-context";
	store.createRun({ runId, outerTaskId: "artex:fixture", goal: "Synthetic goal", mode: "active" });
	try {
		const snapshot = store.snapshot(runId, true);
		const proposal = parseArtexProposal(
			{
				decision: "create_tasks",
				rationale: "Two independent synthetic records",
				todo: "",
				tasks: ["one", "two"].map((key) => ({ key, objective: `Read ${key}`, doneWhen: `${key} recorded` })),
			},
			snapshot,
		);
		const planned = store.commitPlan({
			runId,
			expectedRevision: 0,
			rationale: proposal.rationale,
			artexUpdate: proposal.artexUpdate,
			tasks: compilePlanningProposal(runId, proposal, [], 8),
			idempotencyKey: "plan",
		});
		const leases = planned.tasks.map((task) => store.leaseTask(runId, task.taskId, "/fixture", 30000, Date.now(), 2));
		for (const lease of leases) store.startLease(lease.leaseId);
		const peer = leases[1];
		store.recordEvidence(peer.leaseId, [
			{
				evidenceId: "peer-evidence",
				kind: "tool",
				source: "fixture_observe",
				summary: "Synthetic peer observation",
				contentHash: "peer",
				metadata: { isError: false },
			},
		]);
		store.publishArtexObservation(peer.leaseId, {
			key: "partial",
			kind: "finding",
			payload: "Peer delivered a partial synthetic result",
			confidence: "observed",
			evidenceRefs: ["peer-evidence"],
		});
		let context: ((event: { messages: [] }) => { messages: { content: string }[] }) | undefined;
		const extension = artexExecutorExtension(store, {
			cwd: "/fixture",
			taskId: leases[0].taskId,
			leaseId: leases[0].leaseId,
		});
		if (typeof extension === "function") throw new Error("Expected named Artex extension");
		await extension.factory({
			registerTool: () => {},
			on: (name: string, handler: typeof context) => {
				if (name === "context") context = handler;
			},
		} as unknown as ExtensionAPI);
		expect(context).toBeDefined();
		const injected = context!({ messages: [] }).messages[0].content;
		expect(injected).toContain("Peer delivered a partial synthetic result");
		expect(injected).toContain("peer-evidence");
		expect(injected).toContain(peer.taskId);
	} finally {
		store.close();
	}
});
