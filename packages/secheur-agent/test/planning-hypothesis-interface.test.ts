import { createHash } from "node:crypto";
import type { AgentToolResult, ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { compilePlanningProposal } from "../src/planning/compiler.ts";
import { evidenceCardId } from "../src/planning/evidence-cards.ts";
import {
	hypothesisExecutorExtension,
	hypothesisObservationSchema,
	parseHypothesisProposal,
} from "../src/planning/hypothesis-adapters.ts";
import { HypothesisInputError } from "../src/planning/hypothesis-graph.ts";
import { PlanningStore } from "../src/planning/store.ts";

interface TestTool {
	name: string;
	parameters: TSchema;
	execute(id: string, args: unknown): Promise<AgentToolResult<unknown>>;
}

async function fixture(evidenceCatalogEnabled = true) {
	const store = await PlanningStore.open(":memory:");
	store.createRun({ runId: "run", outerTaskId: "outer", goal: "Synthetic record validation", mode: "active" });
	const snapshot = store.snapshot("run", true);
	const proposal = parseHypothesisProposal(
		{
			decision: "create_tasks",
			rationale: "Inspect a synthetic observation",
			newHypotheses: [
				{
					key: "one",
					statement: "Record is consistent",
					basisRefs: ["human:goal"],
					parentHypothesisIds: [],
					verificationCriteria: "Observed match",
					refutationCriteria: "Observed mismatch",
				},
			],
			tasks: [
				{
					key: "check",
					objective: "Inspect the record",
					doneWhen: "Observation is retained",
					hypothesisIds: ["one"],
					purpose: "test_hypothesis",
				},
			],
		},
		snapshot,
	);
	const planned = store.commitPlan({
		runId: "run",
		expectedRevision: snapshot.run.revision,
		rationale: proposal.rationale,
		idempotencyKey: "plan",
		hypothesisUpdate: proposal.hypothesisUpdate,
		tasks: compilePlanningProposal("run", proposal, [], 100),
	});
	const taskId = planned.tasks[0].taskId;
	const lease = store.leaseTask("run", taskId, "/fixture", 30_000);
	store.startLease(lease.leaseId);
	store.recordEvidence(lease.leaseId, [
		{
			evidenceId: "tool-full-fixture-id",
			kind: "tool",
			source: "fixture",
			summary: "Recorded observation",
			contentHash: "fixture-hash",
			metadata: {},
		},
	]);
	const tools = new Map<string, TestTool>();
	const handlers: Array<(event: ToolResultEvent) => { isError?: boolean } | undefined> = [];
	const progress = vi.fn();
	const extension = hypothesisExecutorExtension(
		store,
		{
			leaseId: lease.leaseId,
			taskId,
			cwd: "/fixture",
			onProgress: progress,
		},
		evidenceCatalogEnabled,
	);
	if (typeof extension === "function") throw new Error("Expected extension factory");
	await extension.factory({
		registerTool: (tool: TestTool) => tools.set(tool.name, tool),
		on: (name: string, handler: (event: ToolResultEvent) => { isError?: boolean } | undefined) => {
			if (name === "tool_result") handlers.push(handler);
		},
	} as unknown as ExtensionAPI);
	const publish = async (args: unknown) => {
		const result = await tools.get("hypothesis_publish_observation")!.execute("call", args);
		const event = {
			type: "tool_result",
			toolCallId: "call",
			toolName: "hypothesis_publish_observation",
			input: args,
			...result,
			isError: false,
		} as ToolResultEvent;
		return { ...result, isError: handlers.some((handler) => handler(event)?.isError === true) };
	};
	return { store, lease, taskId, progress, publish };
}

const card = {
	summary: "Synthetic observed relation",
	keyValues: { count: 3 },
	scope: "fixture",
	limitations: "local observation only",
	evidenceRefs: ["tool-full-fixture-id"],
};

it("points to the available board when the optional evidence catalog is disabled", async () => {
	const f = await fixture(false);
	try {
		const result = await f.publish({ card: { ...card, evidenceRefs: ["missing"] } });
		expect(result).toMatchObject({
			isError: true,
			details: { reasonCode: "hypothesis_unknown_evidence", nextTool: { name: "hypothesis_read_board" } },
		});
	} finally {
		f.store.close();
	}
});

describe("Hypothesis graph interface correction", () => {
	it("fills omitted mechanical fields and returns exact persisted card and evidence IDs", async () => {
		const f = await fixture();
		try {
			expect(Value.Check(hypothesisObservationSchema, { card })).toBe(true);
			const result = await f.publish({ card });
			const expectedId = `card_${createHash("sha256")
				.update(`${f.lease.leaseId}\0${JSON.stringify(card)}`)
				.digest("hex")
				.slice(0, 24)}`;
			expect(evidenceCardId(f.lease.leaseId, card)).toBe(expectedId);
			expect(result).toMatchObject({
				isError: false,
				details: {
					status: "persisted",
					cardId: expectedId,
					evidenceRefs: card.evidenceRefs,
					hypothesisIds: [],
					goalVerified: false,
				},
			});
			const retry = await f.publish({ card });
			expect(retry.details).toMatchObject({ cardId: expectedId });
			expect(f.store.getHypothesisGraph("run")!.cards).toHaveLength(1);
			expect(f.store.getHypothesisGraph("run")!.nodes[0].status).toBe("pending");
			expect(f.store.snapshot("run").run.status).toBe("running");
		} finally {
			f.store.close();
		}
	});

	it("returns a recoverable fixed diagnosis then accepts corrected exact references on the same lease", async () => {
		const f = await fixture();
		try {
			const before = f.store.getHypothesisGraph("run")!.version;
			const invalid = await f.publish({ card: { ...card, evidenceRefs: ["invented-id"] } });
			expect(invalid).toMatchObject({
				isError: true,
				details: {
					status: "rejected",
					reasonCode: "hypothesis_unknown_evidence",
					fieldPaths: ["card.evidenceRefs", "resolutions[].evidenceRefs"],
					retryable: true,
					nextTool: { name: "planning_list_evidence" },
				},
			});
			expect(f.progress).not.toHaveBeenCalled();
			expect(f.store.getHypothesisGraph("run")!.version).toBe(before);
			expect(await f.publish({ card })).toMatchObject({ isError: false, details: { status: "persisted" } });
			expect(f.store.getHypothesisGraphForLease(f.lease.leaseId).cards).toHaveLength(1);
		} finally {
			f.store.close();
		}
	});

	it("preserves explicitly supplied stale versions and classifies existing bounded-input rejection", async () => {
		const f = await fixture();
		try {
			expect(await f.publish({ expectedVersion: 0, card })).toMatchObject({
				isError: true,
				details: { reasonCode: "hypothesis_version_stale", fieldPaths: ["expectedVersion"] },
			});
			expect(await f.publish({ card: { ...card, keyValues: { text: "x".repeat(20_000) } } })).toMatchObject({
				isError: true,
				details: { reasonCode: "hypothesis_card_invalid" },
			});
			expect(await f.publish({ card })).toMatchObject({ isError: false });
		} finally {
			f.store.close();
		}
	});

	it("does not turn invalid leases or persistence failures into correctable model-input results", async () => {
		const f = await fixture();
		try {
			const failure = new Error("synthetic database unavailable");
			vi.spyOn(f.store, "publishHypothesisObservation").mockImplementationOnce(() => {
				throw failure;
			});
			await expect(f.publish({ card })).rejects.toBe(failure);
			await expect(f.publish({ card, expectedVersion: 1, resolutions: [] })).resolves.toMatchObject({
				isError: false,
			});
			const invalidLease = hypothesisExecutorExtension(f.store, {
				leaseId: "absent",
				taskId: f.taskId,
				cwd: "/fixture",
			});
			if (typeof invalidLease === "function") throw new Error("Expected extension factory");
			let invalidTool: TestTool | undefined;
			await invalidLease.factory({
				registerTool: (tool: TestTool) => {
					if (tool.name === "hypothesis_publish_observation") invalidTool = tool;
				},
				on: () => {},
			} as unknown as ExtensionAPI);
			await expect(invalidTool!.execute("invalid", { card })).rejects.not.toBeInstanceOf(HypothesisInputError);
		} finally {
			f.store.close();
		}
	});

	it("classifies existing planner shape and waiting errors without introducing new limits", async () => {
		const f = await fixture();
		try {
			const snapshot = f.store.snapshot("run", true);
			expect(() =>
				parseHypothesisProposal(
					{
						decision: "blocked",
						rationale: "Wait",
						tasks: [],
						newHypotheses: [],
						waitForTaskIds: ["absent-owner"],
					},
					snapshot,
				),
			).toThrow(HypothesisInputError);
			try {
				parseHypothesisProposal(
					{
						decision: "blocked",
						rationale: "Wait",
						tasks: [],
						newHypotheses: [],
						waitForTaskIds: ["absent-owner"],
					},
					snapshot,
				);
			} catch (error) {
				expect(error).toMatchObject({ code: "hypothesis_wait_invalid", fieldPaths: ["waitForTaskIds"] });
			}
		} finally {
			f.store.close();
		}
	});
});
