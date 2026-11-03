import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadSecHeurConfig } from "../src/config.ts";
import { artexPlannerView, parseArtexProposal } from "../src/planning/artex-adapters.ts";
import {
	ARTEX_COLD_ROUNDS,
	ArtexInputError,
	artexGraphView,
	createArtexGraph,
	foldArtexGraph,
	validateArtexGraph,
} from "../src/planning/artex-graph.ts";
import type { ArtexObservation } from "../src/planning/artex-types.ts";
import { ArtexWake } from "../src/planning/artex-wake.ts";
import { compilePlanningProposal } from "../src/planning/compiler.ts";
import type { PlanningEvidenceInput, PlanningExecutionReport, PlanningTaskLease } from "../src/planning/contracts.ts";
import { type PlanningSupervisor, runPlanningHarness } from "../src/planning/harness.ts";
import { HypothesisInputError } from "../src/planning/hypothesis-graph.ts";
import { PlanningStore } from "../src/planning/store.ts";

const runId = "artex-synthetic";
async function fixture(path = ":memory:") {
	const store = await PlanningStore.open(path);
	store.createRun({ runId, outerTaskId: "artex:synthetic", goal: "Verify a synthetic record", mode: "active" });
	return store;
}
function proposal(keys = ["owner"]) {
	return {
		decision: "create_tasks",
		rationale: "Independent synthetic work",
		todo: "Preserve the owner until verification",
		tasks: keys.map((key) => ({
			key,
			objective: `Produce ${key} observation`,
			doneWhen: `Deliver ${key} record`,
			priority: 1,
		})),
	};
}
function commit(store: PlanningStore, value: unknown = proposal()) {
	const snapshot = store.snapshot(runId, true);
	const parsed = parseArtexProposal(value, snapshot);
	return store.commitPlan({
		runId,
		expectedRevision: snapshot.run.revision,
		rationale: parsed.rationale,
		artexUpdate: parsed.artexUpdate,
		tasks: compilePlanningProposal(runId, parsed, snapshot.tasks, 100),
		idempotencyKey: `round-${parsed.artexUpdate!.expectedRound}`,
		allowActiveLeases: true,
	});
}
function claim(store: PlanningStore, index = 0) {
	const task = store.snapshot(runId).tasks[index];
	const lease = store.leaseTask(runId, task.taskId, "/synthetic", 1_000_000, Date.now(), 2);
	store.startLease(lease.leaseId);
	return lease;
}
function evidence(evidenceId = "synthetic-evidence"): PlanningEvidenceInput {
	return {
		evidenceId,
		kind: "tool",
		source: "fixture_observe",
		toolName: "fixture_observe",
		summary: "A synthetic observation",
		contentHash: evidenceId,
		metadata: { isError: false },
	};
}
function observation(evidenceId = "synthetic-evidence"): ArtexObservation {
	return {
		key: evidenceId,
		kind: "fact",
		payload: "A supported synthetic fact",
		confidence: "observed",
		evidenceRefs: [evidenceId],
	};
}
function terminalEvidence(): PlanningEvidenceInput {
	return {
		evidenceId: "proof",
		kind: "tool",
		source: "verify_flag",
		toolName: "verify_flag",
		summary: "Synthetic accepted result",
		contentHash: "synthetic-proof",
		excerpt: JSON.stringify({ details: { data: { ok: true, status: "correct", verified: true } } }),
		metadata: { isError: false, toolCallId: "proof-call", evidenceId: "proof", verificationOutcome: "correct" },
	};
}
function report(lease: PlanningTaskLease): PlanningExecutionReport {
	return {
		commitSource: "planning_commit_result",
		result: {
			schemaVersion: 1,
			leaseId: lease.leaseId,
			outcome: "done",
			summary: "Synthetic work settled",
			suggestedTasks: [],
			flagCandidates: [],
		},
		evidence: [],
	};
}

describe("Artex exploration graph", () => {
	it("bounds the complete overview and terminates even when a tiny budget cannot fit the identity", async () => {
		const store = await fixture();
		try {
			const snapshot = commit(store);
			snapshot.artexGraph!.todo = "待办".repeat(4000);
			expect(Buffer.byteLength(JSON.stringify(artexPlannerView(snapshot, 1024)))).toBeLessThanOrEqual(1024);
			snapshot.artexGraph!.runId = "long".repeat(3000);
			expect(() => artexPlannerView(snapshot, 1024)).toThrow("context budget");
		} finally {
			store.close();
		}
	});
	it("preserves concurrent worker observations when committing an already-generated plan", async () => {
		const root = mkdtempSync(join(tmpdir(), "artex-concurrent-"));
		const file = join(root, "planning.sqlite");
		const store = await fixture(file);
		const other = await PlanningStore.open(file);
		try {
			commit(store);
			const lease = claim(store);
			const before = store.snapshot(runId, true);
			const planned = parseArtexProposal(proposal(["auxiliary"]), before);
			other.recordEvidence(lease.leaseId, [evidence()]);
			other.publishArtexObservation(lease.leaseId, observation());
			const merged = store.commitPlan({
				runId,
				expectedRevision: before.run.revision,
				rationale: planned.rationale,
				artexUpdate: planned.artexUpdate,
				allowActiveLeases: true,
				idempotencyKey: "concurrent-plan",
				tasks: compilePlanningProposal(runId, planned, before.tasks, 10),
			});
			expect(merged.artexGraph!.nodes.some((item) => item.payload === observation().payload)).toBe(true);
			expect(merged.tasks).toHaveLength(2);
			expect(merged.activeLeases).toHaveLength(1);
		} finally {
			other.close();
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("routes the fourth engine without changing the default", () => {
		const root = mkdtempSync(join(tmpdir(), "artex-config-"));
		try {
			expect(loadSecHeurConfig({ projectRoot: root, planningEngine: "artex" }).planning.engine).toBe("artex");
			expect(loadSecHeurConfig({ projectRoot: root }).planning.engine).toBe("progressive");
			expect(createArtexGraph("one", "goal").nodes[0].id).not.toBe(createArtexGraph("two", "goal").nodes[0].id);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("persists graph, assets, TODO and provenance across reopening", async () => {
		const root = mkdtempSync(join(tmpdir(), "artex-store-"));
		const file = join(root, "planning.sqlite");
		let store = await fixture(file);
		try {
			commit(store);
			const lease = claim(store);
			store.recordEvidence(lease.leaseId, [evidence()]);
			const next = store.publishArtexObservation(lease.leaseId, {
				...observation(),
				assets: [{ key: "input", type: "artifact", label: "Synthetic input" }],
				anchors: ["input"],
				assetEdges: [{ source: "input", target: "input", relation: "describes" }],
			});
			expect(next.nodes.at(-1)?.sourceLeaseId).toBe(lease.leaseId);
			store.close();
			store = await PlanningStore.open(file);
			const reopened = store.snapshot(runId, true).artexGraph!;
			expect(reopened.todo).toBe(proposal().todo);
			expect(reopened.assets).toHaveLength(1);
			expect(reopened.nodes.find((item) => item.kind === "intent")?.owner).toBe(lease.leaseId);
			expect(reopened.edges).toContainEqual(expect.objectContaining({ relation: "yields" }));
			expect(reopened.nodes.at(-1)?.evidenceRefs).toEqual(["synthetic-evidence"]);
		} finally {
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("keeps causal parents separate from execution dependencies and claims once", async () => {
		const store = await fixture();
		try {
			const raw = proposal(["first", "second"]);
			const snapshot = commit(store, { ...raw, tasks: [raw.tasks[0], { ...raw.tasks[1], parentIds: ["first"] }] });
			expect(snapshot.tasks.map((task) => task.status)).toEqual(["ready", "ready"]);
			expect(snapshot.tasks[1].dependsOnTaskIds).toEqual([]);
			claim(store);
			expect(() => store.leaseTask(runId, snapshot.tasks[0].taskId, "/synthetic", 30000, Date.now(), 2)).toThrow();
			claim(store, 1);
			expect(store.snapshot(runId, true).activeLeases).toHaveLength(2);
		} finally {
			store.close();
		}
	});
	it("merges two active workers and preserves append-only observations", async () => {
		const store = await fixture();
		try {
			commit(store, proposal(["one", "two"]));
			const first = claim(store);
			const second = claim(store, 1);
			store.recordEvidence(first.leaseId, [evidence("one")]);
			store.recordEvidence(second.leaseId, [evidence("two")]);
			const original = store.publishArtexObservation(first.leaseId, observation("one"));
			expect(store.publishArtexObservation(first.leaseId, observation("one")).version).toBe(original.version);
			const next = store.publishArtexObservation(second.leaseId, observation("two"));
			expect(next.nodes.filter((item) => item.origin === "worker")).toHaveLength(2);
			expect(() =>
				store.publishArtexObservation(first.leaseId, { ...observation("one"), payload: "Overwrite" }),
			).toThrow("already exists");
			expect(() => store.publishArtexObservation(first.leaseId, { ...observation("unknown") })).toThrow("evidence");
			expect(() =>
				store.publishArtexObservation(first.leaseId, {
					...observation("one"),
					key: "new",
					parentIds: ["other-run"],
				}),
			).toThrow("parent");
			expect(store.getArtexGraph(runId)!.version).toBe(next.version);
			store.cancelActiveLease(runId, "synthetic cancellation");
			expect(() => store.publishArtexObservation(first.leaseId, observation())).toThrow();
		} finally {
			store.close();
		}
	});
	it("rejects missing and failed evidence without treating a finding as success", async () => {
		const store = await fixture();
		try {
			commit(store);
			const lease = claim(store);
			store.recordEvidence(lease.leaseId, [{ ...evidence("error"), metadata: { isError: true } }, evidence()]);
			expect(() => store.publishArtexObservation(lease.leaseId, observation("error"))).toThrow();
			store.publishArtexObservation(lease.leaseId, { ...observation(), kind: "finding" });
			expect(store.snapshot(runId).artexGraph!.nodes.find((item) => item.kind === "goal")?.state).toBe("open");
			expect(() =>
				parseArtexProposal(
					{ decision: "finish_run", rationale: "claim only", todo: "", tasks: [] },
					store.snapshot(runId, true),
				),
			).toThrow("native verifier");
		} finally {
			store.close();
		}
	});
	it("requires live owners for zero-intent waiting", async () => {
		const store = await fixture();
		try {
			const snapshot = commit(store);
			const waiting = {
				decision: "blocked",
				rationale: "The current owner covers the goal",
				todo: "Wait",
				tasks: [],
				waitForTaskIds: [snapshot.tasks[0].taskId],
			};
			expect(() => parseArtexProposal(waiting, store.snapshot(runId, true))).toThrow("live owners");
			claim(store);
			expect(parseArtexProposal(waiting, store.snapshot(runId, true)).artexWaitingTaskIds).toEqual(
				waiting.waitForTaskIds,
			);
			commit(store, waiting);
			expect(store.snapshot(runId).artexGraph?.todo).toBe("Wait");
			expect(store.snapshot(runId).run.status).toBe("running");
		} finally {
			store.close();
		}
	});
	it("folds settled cold branches without deleting originals and unfolds newly reused ancestors", async () => {
		const store = await fixture();
		try {
			commit(store);
			const lease = claim(store);
			store.recordEvidence(lease.leaseId, [evidence()]);
			store.publishArtexObservation(lease.leaseId, observation());
			store.commitResult({
				leaseId: lease.leaseId,
				planRevision: lease.planRevision,
				result: report(lease).result,
				evidence: [],
			});
			const graph = store.snapshot(runId, true).artexGraph!;
			const originalIds = graph.nodes.map((item) => item.id);
			graph.round += ARTEX_COLD_ROUNDS;
			const folded = foldArtexGraph(graph);
			expect(folded.nodes.map((item) => item.id)).toEqual(expect.arrayContaining(originalIds));
			expect(folded.nodes.filter((item) => item.kind === "digest")).toHaveLength(1);
			expect(artexGraphView(folded).foldedNodeCount).toBe(2);
			expect(artexGraphView(folded).digests[0].memberIds).toHaveLength(2);
			expect(foldArtexGraph(folded).nodes).toEqual(folded.nodes);
			const intent = folded.nodes.find((item) => item.kind === "intent")!;
			intent.state = "running";
			expect(artexGraphView(folded).foldedNodeCount).toBe(0);
			const cyclic = structuredClone(folded);
			const fact = cyclic.nodes.find((item) => item.origin === "worker")!;
			cyclic.edges.push({ source: fact.id, target: intent.id, relation: "derived_from" });
			expect(() => validateArtexGraph(cyclic)).toThrow("cycle");
			expect(() => foldArtexGraph(cyclic)).not.toThrow();
		} finally {
			store.close();
		}
	});
	it("keeps all active ancestors hot and protects findings, goals, hints and origin facts", async () => {
		const store = await fixture();
		try {
			commit(store);
			const lease = claim(store);
			store.recordEvidence(lease.leaseId, [evidence()]);
			store.publishArtexObservation(lease.leaseId, { ...observation(), kind: "finding" });
			const graph = store.snapshot(runId, true).artexGraph!;
			graph.round += 20;
			expect(foldArtexGraph(graph).nodes).toHaveLength(graph.nodes.length);
		} finally {
			store.close();
		}
	});
	it("coalesces events without debounce starvation and uses the upstream heartbeat", () => {
		const wake = new ArtexWake({ debounceMs: 800, heartbeatMs: 600000 }, 0);
		wake.observe("first", 0);
		wake.observe("second", 790);
		expect(wake.delay(800)).toBe(0);
		wake.reviewed("second", 800);
		wake.observe("second", 900);
		expect(wake.delay(900)).toBe(599900);
		expect(wake.delay(600800)).toBe(0);
	});
	it("reviews evidence arriving during a full-slot plan without waking again for its own TODO and hints", async () => {
		const store = await fixture();
		commit(store, proposal(["first", "second"]));
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started: PlanningTaskLease[] = [];
		let reviews = 0;
		const propose = vi.fn<PlanningSupervisor["propose"]>(async ({ snapshot, changes }) => {
			reviews++;
			if (reviews === 1) store.recordEvidence(started[0].leaseId, [evidence("concurrent-original")]);
			else expect(changes?.evidenceIds).toEqual(["concurrent-original"]);
			return parseArtexProposal(
				{
					decision: "blocked",
					rationale: "Owners cover the next work",
					tasks: [],
					todo: `Review ${reviews}`,
					waitForTaskIds: snapshot.activeLeases!.map((lease) => lease.taskId),
					hints: [{ key: `hint-${reviews}`, payload: "Continue useful existing work" }],
				},
				snapshot,
			);
		});
		const stop = new AbortController();
		const timer = setTimeout(() => stop.abort(new Error("Synthetic timeout")), 5000);
		const running = runPlanningHarness(runId, {
			store,
			supervisor: { eventPolicy: { debounceMs: 5, heartbeatMs: 600000 }, propose },
			executor: {
				execute: async ({ lease, signal }) => {
					started.push(lease);
					if (started.length === 1) {
						await gate;
						return { ...report(lease), evidence: [terminalEvidence()] };
					}
					await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
					return report(lease);
				},
			},
			executionCapacity: 2,
			maximumSteps: 8,
			maximumTasks: 16,
			leaseTtlMs: 30000,
			maximumEvidenceBytes: 32768,
			allowedScope: "/synthetic",
			signal: stop.signal,
		});
		try {
			await vi.waitFor(() => expect(store.getArtexGraph(runId)?.todo).toBe("Review 2"));
			expect(propose).toHaveBeenCalledTimes(2);
			expect(started).toHaveLength(2);
			release();
			expect((await running).run.status).toBe("completed");
			expect(propose).toHaveBeenCalledTimes(2);
			const events = store.listLifecycleEvents(runId, { limit: 1000 }).events;
			expect(
				events
					.filter((event) => event.type === "planning_changes_presented")
					.map((event) => event.payload.evidenceIds),
			).toEqual([[], ["concurrent-original"]]);
		} finally {
			clearTimeout(timer);
			stop.abort();
			release();
			await running.catch(() => {});
			store.close();
		}
	});
	it.each([
		new ArtexInputError("artex_unknown_reference", "Correct the reference", ["parentIds"]),
		new HypothesisInputError("hypothesis_unknown_evidence", "Correct the reference", ["card.evidenceRefs"]),
	])(
		"keeps new input error categories in the existing recovery path without acknowledging failed review: $code",
		async (error) => {
			const store = await fixture();
			commit(store, proposal(["first", "second"]));
			let release = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let owner: PlanningTaskLease | undefined;
			let reviews = 0;
			const propose = vi.fn<PlanningSupervisor["propose"]>(async ({ snapshot, changes, recovery }) => {
				reviews++;
				if (reviews === 1) {
					store.recordEvidence(owner!.leaseId, [evidence("failed-review-original")]);
					throw error;
				}
				expect(recovery?.code).toBe(error.code);
				expect(changes).toMatchObject({ initial: true, evidenceIds: ["failed-review-original"] });
				return parseArtexProposal(
					{
						decision: "blocked",
						tasks: [],
						todo: "Accepted correction",
						rationale: "Owners cover the work",
						waitForTaskIds: snapshot.activeLeases!.map((lease) => lease.taskId),
					},
					snapshot,
				);
			});
			const stop = new AbortController();
			const timer = setTimeout(() => stop.abort(new Error("Synthetic timeout")), 8000);
			const running = runPlanningHarness(runId, {
				store,
				supervisor: { eventPolicy: { debounceMs: 5, heartbeatMs: 600000 }, propose },
				executor: {
					execute: async ({ lease, signal }) => {
						if (!owner) {
							owner = lease;
							await gate;
							return { ...report(lease), evidence: [terminalEvidence()] };
						}
						await new Promise<void>((resolve) =>
							signal!.addEventListener("abort", () => resolve(), { once: true }),
						);
						return report(lease);
					},
				},
				recoverPlanningFailures: true,
				executionCapacity: 2,
				maximumSteps: 8,
				maximumTasks: 16,
				leaseTtlMs: 30000,
				maximumEvidenceBytes: 32768,
				allowedScope: "/synthetic",
				signal: stop.signal,
			});
			try {
				await vi.waitFor(() => expect(store.getArtexGraph(runId)?.todo).toBe("Accepted correction"), {
					timeout: 5000,
				});
				expect(propose).toHaveBeenCalledTimes(2);
				release();
				expect((await running).run.status).toBe("completed");
				expect(
					store
						.listLifecycleEvents(runId, { limit: 1000 })
						.events.filter((event) => event.type === "planning_changes_reviewed"),
				).toHaveLength(1);
			} finally {
				clearTimeout(timer);
				stop.abort();
				release();
				await running.catch(() => {});
				store.close();
			}
		},
	);
	it("plans with full slots, persists waiting TODO, retains owners and stops on native proof", async () => {
		const store = await fixture();
		commit(store, proposal(["first", "second"]));
		let release = () => {};
		const gate = {
			promise: new Promise<void>((resolve) => {
				release = resolve;
			}),
			resolve: () => release(),
		};
		const started: PlanningTaskLease[] = [];
		const propose = vi.fn<PlanningSupervisor["propose"]>(async ({ snapshot }) =>
			parseArtexProposal(
				{
					decision: "blocked",
					rationale: "Both owners remain useful",
					todo: "Continue existing owners",
					tasks: [],
					waitForTaskIds: snapshot.activeLeases!.map((lease) => lease.taskId),
				},
				snapshot,
			),
		);
		let siblingStopped = false;
		const timeout = new AbortController();
		const timer = setTimeout(() => timeout.abort(new Error("Synthetic test timed out")), 5000);
		const running = runPlanningHarness(runId, {
			store,
			supervisor: { eventPolicy: { debounceMs: 5, heartbeatMs: 600000 }, propose },
			executor: {
				execute: async ({ lease, signal }) => {
					started.push(lease);
					if (started.length === 1) {
						await gate.promise;
						return { ...report(lease), evidence: [terminalEvidence()] };
					}
					await new Promise<void>((resolve) =>
						signal!.addEventListener(
							"abort",
							() => {
								siblingStopped = true;
								resolve();
							},
							{ once: true },
						),
					);
					return report(lease);
				},
			},
			executionCapacity: 2,
			maximumSteps: 8,
			maximumTasks: 16,
			leaseTtlMs: 30000,
			maximumEvidenceBytes: 32768,
			allowedScope: "/synthetic",
			signal: timeout.signal,
		});
		try {
			await vi.waitFor(() => expect(store.getArtexGraph(runId)?.todo).toBe("Continue existing owners"));
			expect(started).toHaveLength(2);
			expect(store.snapshot(runId, true).activeLeases).toHaveLength(2);
			gate.resolve();
			const result = await running;
			expect(result.run.status).toBe("completed");
			expect(siblingStopped).toBe(true);
			const graph = result.artexGraph!;
			expect(graph.nodes.find((item) => item.kind === "goal")?.state).toBe("met");
			expect(graph.edges.some((edge) => edge.relation === "proves")).toBe(true);
			validateArtexGraph(graph);
			expect(propose).toHaveBeenCalledTimes(1);
		} finally {
			clearTimeout(timer);
			timeout.abort();
			gate.resolve();
			await running.catch(() => undefined);
			store.close();
		}
	});
});
