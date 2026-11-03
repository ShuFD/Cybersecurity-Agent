import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { type ExtensionAPI, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { loadSecHeurConfig } from "../src/config.ts";
import { artexExecutorExtension, parseArtexProposal } from "../src/planning/artex-adapters.ts";
import { ArtexInputError } from "../src/planning/artex-graph.ts";
import { compilePlanningProposal } from "../src/planning/compiler.ts";
import { PlanningStore } from "../src/planning/store.ts";
import { runPiCodingTask } from "../src/subagent.ts";

interface RegisteredTool {
	name: string;
	parameters: TSchema;
	execute(
		callId: string,
		args: unknown,
	): Promise<{
		isError?: boolean;
		content: { type: string; text?: string }[];
		details: Record<string, unknown>;
	}>;
}

async function fixture(cwd = "/synthetic") {
	const store = await PlanningStore.open(":memory:");
	const runId = "artex-tool-contract";
	store.createRun({ runId, outerTaskId: "artex:synthetic", goal: "Record a synthetic observation", mode: "active" });
	const snapshot = store.snapshot(runId, true);
	const parsed = parseArtexProposal(
		{
			decision: "create_tasks",
			rationale: "Preserve the observation provenance",
			todo: "Record the result",
			tasks: [{ key: "owner", objective: "Read the synthetic input", doneWhen: "Observation persisted" }],
			hints: [{ key: "context", payload: "Synthetic context" }],
		},
		snapshot,
	);
	const planned = store.commitPlan({
		runId,
		expectedRevision: snapshot.run.revision,
		rationale: parsed.rationale,
		artexUpdate: parsed.artexUpdate,
		tasks: compilePlanningProposal(runId, parsed, [], 8),
		idempotencyKey: "plan",
	});
	const lease = store.leaseTask(runId, planned.tasks[0].taskId, cwd, 30000);
	store.startLease(lease.leaseId);
	store.recordEvidence(
		lease.leaseId,
		["tool-first", "tool-second", "tool-failed"].map((evidenceId) => ({
			evidenceId,
			kind: "tool" as const,
			source: "fixture_observe",
			summary: "Synthetic observation",
			contentHash: evidenceId,
			metadata: { isError: evidenceId === "tool-failed" },
		})),
	);
	const extension = artexExecutorExtension(store, { cwd, taskId: lease.taskId, leaseId: lease.leaseId });
	if (typeof extension === "function") throw new Error("Expected named Artex extension");
	const tools: RegisteredTool[] = [];
	await extension.factory({
		registerTool: (tool: RegisteredTool) => tools.push(tool),
		on: () => {},
	} as unknown as ExtensionAPI);
	return { store, runId, lease, extension, publish: tools.find((tool) => tool.name === "artex_publish_observation")! };
}

describe("Artex observation tool contract", () => {
	it("defaults only mechanical fields and returns stable IDs, full references and idempotent retries", async () => {
		const { store, runId, lease, publish } = await fixture();
		try {
			const args = { payload: "A synthetic inference", evidenceRefs: ["tool-second", "tool-first"] };
			expect(Value.Check(publish.parameters, args)).toBe(true);
			expect(Value.Check(publish.parameters, { evidenceRefs: args.evidenceRefs })).toBe(false);
			expect(Value.Check(publish.parameters, { payload: args.payload })).toBe(false);
			expect(Value.Check(publish.parameters, { ...args, evidenceRefs: [] })).toBe(false);
			const first = await publish.execute("first", args);
			expect(first.details).toMatchObject({
				status: "persisted",
				evidenceRefs: ["tool-first", "tool-second"],
				goalVerified: false,
			});
			const node = store.getArtexGraph(runId)!.nodes.find((item) => item.id === first.details.nodeId)!;
			expect(node).toMatchObject({
				kind: "fact",
				confidence: "inferred",
				sourceTaskId: lease.taskId,
				sourceLeaseId: lease.leaseId,
			});
			const retry = await publish.execute("retry", {
				...args,
				kind: "fact",
				confidence: "inferred",
				evidenceRefs: ["tool-first", "tool-second", "tool-first"],
				parentIds: [],
			});
			expect(retry.details).toEqual({ ...first.details, status: "duplicate" });
			expect(store.getArtexGraph(runId)!.nodes.filter((item) => item.id === node.id)).toHaveLength(1);
		} finally {
			store.close();
		}
	});

	it("returns fixed input reasons while preserving existing evidence and scope requirements", async () => {
		const { store, runId, publish } = await fixture();
		try {
			for (const evidenceRefs of [["foreign-run-reference"], ["tool-failed"]]) {
				const rejected = await publish.execute("invalid", { payload: "Synthetic claim", evidenceRefs });
				expect(rejected).toMatchObject({
					details: { reasonCode: "artex_unknown_reference", fieldPaths: ["evidenceRefs"], retryable: true },
				});
			}
			const valid = { key: "explicit", payload: "Synthetic supported claim", evidenceRefs: ["tool-first"] };
			const persisted = await publish.execute("valid", valid);
			expect(persisted.details.status).toBe("persisted");
			const conflict = await publish.execute("conflict", { ...valid, payload: "A different synthetic claim" });
			expect(conflict).toMatchObject({
				details: { reasonCode: "artex_observation_key_conflict", fieldPaths: ["key"], retryable: true },
			});
			const corrected = await publish.execute("corrected", { ...valid, key: "explicit-version-two" });
			expect(corrected.details.status).toBe("persisted");
			expect(store.getArtexGraph(runId)!.nodes.find((item) => item.kind === "goal")?.state).toBe("open");
		} finally {
			store.close();
		}
	});

	it("does not convert storage outages or inactive leases into correctable model input", async () => {
		const { store, runId, publish } = await fixture();
		try {
			const outage = new Error("Synthetic durable store unavailable");
			const spy = vi.spyOn(store, "publishArtexObservation").mockImplementationOnce(() => {
				throw outage;
			});
			const args = { payload: "Synthetic claim", evidenceRefs: ["tool-first"] };
			await expect(publish.execute("outage", args)).rejects.toBe(outage);
			spy.mockRestore();
			store.cancelActiveLease(runId, "Synthetic cancellation");
			await expect(publish.execute("inactive", args)).rejects.not.toBeInstanceOf(ArtexInputError);
		} finally {
			store.close();
		}
	});

	it("labels existing proposal errors and accepts omitted hint reference arrays", async () => {
		const { store, runId } = await fixture();
		try {
			expect(store.getArtexGraph(runId)!.nodes.find((item) => item.kind === "hint")?.evidenceRefs).toEqual([]);
			expect(() =>
				parseArtexProposal(
					{ decision: "blocked", rationale: "Wait", todo: "", tasks: [] },
					store.snapshot(runId, true),
				),
			).toThrow(expect.objectContaining({ code: "artex_owner_required", fieldPaths: ["waitForTaskIds"] }));
		} finally {
			store.close();
		}
	});

	it("corrects missing graph and observation references in the same real offline Pi session", async () => {
		const root = mkdtempSync(join(tmpdir(), "artex-tool-pi-"));
		const { store, runId, extension } = await fixture(root);
		const faux = fauxProvider({ models: [{ id: "artex-tools-fixture", reasoning: false }] });
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
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("artex_read_graph", { id: "missing-graph-node" }, { id: "missing-node" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("artex_read_graph", {}, { id: "graph-overview" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				fauxToolCall(
					"artex_publish_observation",
					{ payload: "Synthetic claim", evidenceRefs: ["missing"] },
					{ id: "bad" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall(
					"artex_publish_observation",
					{ payload: "Synthetic claim", evidenceRefs: ["tool-first"] },
					{ id: "good" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Synthetic observation recorded."),
		]);
		try {
			const result = await runPiCodingTask({
				config,
				cwd: root,
				task: "Record the synthetic observation using its persisted evidence ID",
				model: faux.getModel(),
				modelRuntime: runtime,
				thinkingLevel: "off",
				isolatedRoleResources: true,
				extensionFactories: [extension],
				allowedTools: ["artex_publish_observation", "artex_read_graph"],
			});
			expect(faux.state.callCount).toBe(5);
			expect(result.toolExecutions.map((item) => item.isError)).toEqual([true, false, true, false]);
			expect(result.toolExecutions[0].result).toMatchObject({
				details: { reasonCode: "artex_graph_reference_not_found", fieldPaths: ["id"], retryable: true },
			});
			expect(result.finalText).toBe("Synthetic observation recorded.");
			expect(store.getArtexGraph(runId)!.nodes.filter((item) => item.origin === "worker")).toHaveLength(1);
		} finally {
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
