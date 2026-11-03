import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { loadSecHeurConfig } from "../src/config.ts";
import { compilePlanningProposal } from "../src/planning/compiler.ts";
import {
	HypothesisPlanningSupervisor,
	hypothesisPlannerView,
	parseHypothesisProposal,
} from "../src/planning/hypothesis-adapters.ts";
import {
	applyHypothesisObservation,
	emptyHypothesisGraph,
	hypothesisTaskRunnable,
	validateHypothesisGraph,
} from "../src/planning/hypothesis-graph.ts";
import type { HypothesisGraph, HypothesisNode, HypothesisObservation } from "../src/planning/hypothesis-types.ts";
import { PlanningStore } from "../src/planning/store.ts";

function node(id: string, parents: string[] = [], status: HypothesisNode["status"] = "pending"): HypothesisNode {
	return {
		id,
		statement: `claim ${id}`,
		status,
		basisRefs: ["human:goal"],
		parentHypothesisIds: parents,
		verificationCriteria: "observable equality",
		refutationCriteria: "observable inequality",
		verificationEvidenceRefs: [],
		needsReview: false,
	};
}
async function setup() {
	const store = await PlanningStore.open(":memory:");
	store.createRun({
		runId: "dag-run",
		outerTaskId: "outer",
		goal: "Find and verify the expected result",
		mode: "active",
	});
	return store;
}
function raw() {
	return {
		decision: "create_tasks",
		rationale: "Test independently before extending the chain",
		newHypotheses: [
			{
				key: "A",
				statement: "The available record explains the result",
				basisRefs: ["human:goal"],
				parentHypothesisIds: [] as string[],
				verificationCriteria: "Reproduce the documented relation",
				refutationCriteria: "A reproducible contradiction",
			},
		],
		tasks: [
			{
				key: "test-A",
				objective: "Test the concrete relation and retain end-to-end result ownership",
				doneWhen: "Publish observation and verify the final result if available",
				hypothesisIds: ["A"],
				purpose: "test_hypothesis",
				dependsOn: [] as string[],
				requiredInputs: [] as { sourceTaskId: string; artifactPath?: string; evidenceId?: string }[],
			},
		],
	};
}
function commit(store: PlanningStore, value = raw()) {
	const snapshot = store.snapshot("dag-run", true);
	const proposal = parseHypothesisProposal(value, snapshot);
	return store.commitPlan({
		runId: "dag-run",
		expectedRevision: snapshot.run.revision,
		rationale: proposal.rationale,
		idempotencyKey: `p-${snapshot.run.revision}`,
		allowActiveLeases: true,
		hypothesisUpdate: proposal.hypothesisUpdate,
		tasks: compilePlanningProposal("dag-run", proposal, snapshot.tasks, 100),
	});
}
function observation(
	graph: HypothesisGraph,
	id: string,
	verdict: "verified" | "refuted" | "undetermined" = "verified",
): HypothesisObservation {
	return {
		expectedVersion: graph.version,
		card: {
			summary: "这条已保存的工具观察支持当前局部关系，仍需继续核实最终结果与边界条件。",
			keyValues: { count: 68 },
			scope: "current input",
			limitations: "does not verify the whole goal",
			evidenceRefs: ["ev-A"],
		},
		resolutions: [
			{
				hypothesisId: id,
				verdict,
				explanation: "The observed equality satisfies the specified criterion",
				evidenceRefs: ["ev-A"],
			},
		],
	};
}
function evidence(store: PlanningStore, leaseId: string, error = false) {
	store.recordEvidence(leaseId, [
		{
			evidenceId: "ev-A",
			kind: "tool",
			source: "fixture-tool",
			toolName: "fixture-tool",
			summary: "fixture observation",
			excerpt: "RAW_SECRET_TEST_SENTINEL",
			contentHash: "fixture-hash",
			metadata: { isError: error },
		},
	]);
}

describe("bounded hypothesis DAG", () => {
	it("treats human:goal as shared context without inventing a produced evidence dependency", async () => {
		const store = await setup();
		try {
			const value = {
				...raw(),
				tasks: raw().tasks.map((task) => ({
					...task,
					inputEvidenceRefs: ["human:goal"],
					requiredInputs: [{ evidenceId: "human:goal" }],
				})),
			};
			const parsed = parseHypothesisProposal(value, store.snapshot("dag-run", true));
			expect(parsed.tasks[0].inputEvidenceRefs ?? []).toEqual([]);
			expect(parsed.hypothesisUpdate!.newBindings[0].requiredInputs).toEqual([]);
			expect(parsed.hypothesisUpdate!.newNodes[0].basisRefs).toEqual(["human:goal"]);
			expect(value.tasks[0].inputEvidenceRefs).toEqual(["human:goal"]);
		} finally {
			store.close();
		}
	});

	it("infers a known evidence producer, while retaining real references and rejecting foreign ones", async () => {
		const store = await setup();
		try {
			const snapshot = commit(store);
			const lease = store.leaseTask("dag-run", snapshot.tasks[0].taskId, "/work", 30000);
			store.startLease(lease.leaseId);
			evidence(store, lease.leaseId);
			const value = {
				...raw(),
				newHypotheses: [],
				tasks: [
					{
						...raw().tasks[0],
						key: "consumer",
						hypothesisIds: [],
						purpose: "gather_evidence",
						inputEvidenceRefs: ["human:goal", "ev-A"],
						requiredInputs: [{ evidenceId: "ev-A" }],
					},
				],
			};
			const current = store.snapshot("dag-run", true);
			const parsed = parseHypothesisProposal(value, current);
			expect(parsed.tasks[0].inputEvidenceRefs).toEqual(["ev-A"]);
			expect(parsed.hypothesisUpdate!.newBindings[0].requiredInputs).toEqual([
				{ evidenceId: "ev-A", sourceTaskId: lease.taskId },
			]);
			value.tasks[0].inputEvidenceRefs = ["foreign-evidence"];
			expect(() => parseHypothesisProposal(value, current)).toThrow("unknown input evidence");
		} finally {
			store.close();
		}
	});

	it("revalidates an append-only plan after independent executor progress without discarding that progress", async () => {
		const store = await setup();
		try {
			const snapshot = commit(store);
			const id = snapshot.hypothesisGraph!.nodes[0].id;
			const value = raw();
			value.newHypotheses[0] = {
				...value.newHypotheses[0],
				key: "B",
				statement: "Another independently testable relation",
				parentHypothesisIds: [id],
			};
			value.tasks[0] = {
				...value.tasks[0],
				key: "test-B",
				objective: "Test a distinct next relation",
				hypothesisIds: ["B"],
			};
			const proposal = parseHypothesisProposal(value, snapshot);
			const lease = store.leaseTask("dag-run", snapshot.tasks[0].taskId, "/work", 30000, Date.now(), 2);
			store.startLease(lease.leaseId);
			evidence(store, lease.leaseId);
			store.publishHypothesisObservation(lease.leaseId, observation(store.getHypothesisGraph("dag-run")!, id));
			const next = store.commitPlan({
				runId: "dag-run",
				expectedRevision: snapshot.run.revision,
				rationale: proposal.rationale,
				idempotencyKey: "append-after-progress",
				allowActiveLeases: true,
				hypothesisUpdate: proposal.hypothesisUpdate,
				tasks: compilePlanningProposal("dag-run", proposal, snapshot.tasks, 100),
			});
			expect(next.hypothesisGraph?.cards).toHaveLength(1);
			expect(next.hypothesisGraph?.nodes[0].status).toBe("verified");
			expect(next.tasks).toHaveLength(2);
			expect(next.activeLeases).toHaveLength(1);
		} finally {
			store.close();
		}
	});
	it("rejects a newly refuted premise on fresh state while retaining the current owner", async () => {
		const store = await setup();
		try {
			const snapshot = commit(store);
			const id = snapshot.hypothesisGraph!.nodes[0].id;
			const value = raw();
			value.newHypotheses[0] = {
				...value.newHypotheses[0],
				key: "B",
				statement: "A claim based on A",
				parentHypothesisIds: [id],
			};
			value.tasks[0] = {
				...value.tasks[0],
				key: "test-B",
				objective: "Check the dependent claim",
				hypothesisIds: ["B"],
			};
			const proposal = parseHypothesisProposal(value, snapshot);
			const lease = store.leaseTask("dag-run", snapshot.tasks[0].taskId, "/work", 30000);
			store.startLease(lease.leaseId);
			evidence(store, lease.leaseId);
			store.publishHypothesisObservation(
				lease.leaseId,
				observation(store.getHypothesisGraph("dag-run")!, id, "refuted"),
			);
			expect(() =>
				store.commitPlan({
					runId: "dag-run",
					expectedRevision: 1,
					rationale: "stale premise",
					idempotencyKey: "bad-premise",
					allowActiveLeases: true,
					hypothesisUpdate: proposal.hypothesisUpdate,
					tasks: compilePlanningProposal("dag-run", proposal, snapshot.tasks, 100),
				}),
			).toThrow("Refuted");
			expect(store.snapshot("dag-run", true).activeLeases).toHaveLength(1);
			expect(store.snapshot("dag-run").tasks).toHaveLength(1);
		} finally {
			store.close();
		}
	});
	it("does not wait for a missing artifact from an already finished producer", async () => {
		const store = await setup();
		try {
			const snapshot = commit(store);
			const source = snapshot.tasks[0];
			const lease = store.leaseTask("dag-run", source.taskId, "/work", 30000);
			store.startLease(lease.leaseId);
			evidence(store, lease.leaseId);
			store.commitResult({
				leaseId: lease.leaseId,
				planRevision: lease.planRevision,
				result: {
					schemaVersion: 1,
					leaseId: lease.leaseId,
					outcome: "blocked",
					summary: "The requested artifact was not produced",
					suggestedTasks: [],
					flagCandidates: [],
					evidenceRefs: ["ev-A"],
				},
				evidence: [],
			});
			const value = raw();
			value.newHypotheses = [];
			value.tasks = [
				{
					...value.tasks[0],
					key: "consume-missing",
					objective: "Use the missing partial result",
					hypothesisIds: [snapshot.hypothesisGraph!.nodes[0].id],
					requiredInputs: [{ sourceTaskId: source.taskId, artifactPath: "/work/never-written" }] as never,
				},
			];
			expect(() => parseHypothesisProposal(value, store.snapshot("dag-run", true))).toThrow("producer has ended");
		} finally {
			store.close();
		}
	});
	it("loads a third engine without changing legacy defaults", () => {
		const root = mkdtempSync(join(tmpdir(), "hypothesis-config-"));
		const state = join(root, "state");
		mkdirSync(state);
		try {
			const initial = loadSecHeurConfig({ projectRoot: root, stateDir: state, env: { PI_OFFLINE: "1" } });
			expect(initial.planning.engine).toBe("progressive");
			writeFileSync(
				join(state, "desktop-config.json"),
				JSON.stringify({
					executionMode: "plan_multi",
					executionCapacity: 2,
					planning: { engine: "hypothesis", mode: "active" },
				}),
			);
			const config = loadSecHeurConfig({ projectRoot: root, stateDir: state, env: { PI_OFFLINE: "1" } });
			expect(config.planning.engine).toBe("hypothesis");
			expect(config.executionMode.capacity).toBe(2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("accepts verified A -> unresolved B -> C, rejects D", () => {
		const graph = {
			...emptyHypothesisGraph(),
			nodes: [node("A", [], "verified"), node("B", ["A"]), node("C", ["B"])],
		};
		expect(() => validateHypothesisGraph(graph)).not.toThrow();
		graph.nodes.push(node("D", ["C"]));
		expect(() => validateHypothesisGraph(graph)).toThrow("two unresolved");
	});
	it("counts unresolved nodes across a verified intermediate rather than resetting the path", () => {
		expect(() =>
			validateHypothesisGraph({
				...emptyHypothesisGraph(),
				nodes: [node("A"), node("B", ["A"], "verified"), node("C", ["B"]), node("D", ["C"])],
			}),
		).toThrow("two unresolved");
	});
	it("permits four parallel hypotheses but rejects five, including undetermined", () => {
		const graph = {
			...emptyHypothesisGraph(),
			nodes: [node("A"), node("B"), node("C"), node("D", [], "undetermined")],
		};
		expect(() => validateHypothesisGraph(graph)).not.toThrow();
		graph.nodes.push(node("E"));
		expect(() => validateHypothesisGraph(graph)).toThrow("four unresolved");
	});
	it("rejects cycles and unknown parents", () => {
		expect(() =>
			validateHypothesisGraph({ ...emptyHypothesisGraph(), nodes: [node("A", ["B"]), node("B", ["A"])] }),
		).toThrow("cycle");
		expect(() => validateHypothesisGraph({ ...emptyHypothesisGraph(), nodes: [node("A", ["missing"])] })).toThrow(
			"Unknown parent",
		);
	});
	it("persists the graph atomically with tasks and rolls back stale proposals", async () => {
		const store = await setup();
		try {
			const snapshot = commit(store);
			expect(snapshot.hypothesisGraph?.nodes).toHaveLength(1);
			const value = raw();
			value.newHypotheses[0].key = "B";
			value.newHypotheses[0].statement = "A distinct next claim";
			value.tasks[0].key = "test-B";
			value.tasks[0].objective = "Test a distinct result";
			value.tasks[0].hypothesisIds = ["B"];
			const proposal = parseHypothesisProposal(value, snapshot);
			proposal.hypothesisUpdate!.expectedVersion = 100;
			expect(() =>
				store.commitPlan({
					runId: "dag-run",
					expectedRevision: 1,
					rationale: "stale",
					idempotencyKey: "bad",
					allowActiveLeases: true,
					hypothesisUpdate: proposal.hypothesisUpdate,
					tasks: compilePlanningProposal("dag-run", proposal, snapshot.tasks, 100),
				}),
			).toThrow("Stale hypothesis");
			expect(store.snapshot("dag-run").tasks).toHaveLength(1);
			expect(store.getHypothesisGraph("dag-run")?.version).toBe(1);
		} finally {
			store.close();
		}
	});
	it("does not accept PLAN-supplied verdicts or missing references", async () => {
		const store = await setup();
		try {
			const value = raw();
			value.newHypotheses[0].basisRefs = ["foreign-evidence"];
			expect(() => parseHypothesisProposal(value, store.snapshot("dag-run"))).toThrow("basis");
		} finally {
			store.close();
		}
	});
	it("PLAN sees semantic cards, not raw excerpts or tool output", async () => {
		const store = await setup();
		try {
			const snapshot = commit(store);
			const lease = store.leaseTask("dag-run", snapshot.tasks[0].taskId, "/work", 30000);
			store.startLease(lease.leaseId);
			evidence(store, lease.leaseId);
			expect(JSON.stringify(hypothesisPlannerView(store.snapshot("dag-run", true)))).not.toContain(
				"RAW_SECRET_TEST_SENTINEL",
			);
		} finally {
			store.close();
		}
	});
	it("executor observations preserve precise values and hashes without declaring whole-goal success", async () => {
		const store = await setup();
		try {
			const snapshot = commit(store);
			const lease = store.leaseTask("dag-run", snapshot.tasks[0].taskId, "/work", 30000);
			store.startLease(lease.leaseId);
			evidence(store, lease.leaseId);
			const graph = store.getHypothesisGraph("dag-run")!;
			const next = store.publishHypothesisObservation(lease.leaseId, observation(graph, graph.nodes[0].id));
			expect(next.nodes[0].status).toBe("verified");
			expect(next.cards[0].keyValues.count).toBe(68);
			expect(next.cards[0].sourceHashes["ev-A"]).toBe("fixture-hash");
			expect(store.snapshot("dag-run").run.status).toBe("running");
		} finally {
			store.close();
		}
	});
	it("rejects stale observer/executor submissions and foreign-run evidence", async () => {
		const store = await setup();
		try {
			const snapshot = commit(store);
			const lease = store.leaseTask("dag-run", snapshot.tasks[0].taskId, "/work", 30000);
			store.startLease(lease.leaseId);
			evidence(store, lease.leaseId);
			const graph = store.getHypothesisGraph("dag-run")!;
			const value = observation(graph, graph.nodes[0].id);
			value.expectedVersion = 0;
			expect(() => store.publishHypothesisObservation(lease.leaseId, value)).toThrow("Stale");
			value.expectedVersion = graph.version;
			value.card.evidenceRefs = ["other-run"];
			expect(() => store.publishHypothesisObservation(lease.leaseId, value)).toThrow("same-run");
		} finally {
			store.close();
		}
	});
	it("tool failure can be undetermined but cannot disprove the route", async () => {
		const store = await setup();
		try {
			const snapshot = commit(store);
			const lease = store.leaseTask("dag-run", snapshot.tasks[0].taskId, "/work", 30000);
			store.startLease(lease.leaseId);
			evidence(store, lease.leaseId, true);
			const graph = store.getHypothesisGraph("dag-run")!;
			expect(() =>
				store.publishHypothesisObservation(lease.leaseId, observation(graph, graph.nodes[0].id, "refuted")),
			).toThrow("Tool execution failure");
			expect(
				store.publishHypothesisObservation(lease.leaseId, observation(graph, graph.nodes[0].id, "undetermined"))
					.nodes[0].status,
			).toBe("undetermined");
		} finally {
			store.close();
		}
	});
	it("refutation flags descendants for review without cancelling owners or declaring descendants false", async () => {
		const store = await setup();
		try {
			let snapshot = commit(store);
			const graph = snapshot.hypothesisGraph!;
			graph.nodes.push(node("child", [graph.nodes[0].id]));
			const lease = store.leaseTask("dag-run", snapshot.tasks[0].taskId, "/work", 30000);
			store.startLease(lease.leaseId);
			evidence(store, lease.leaseId);
			snapshot = store.snapshot("dag-run", true);
			const next = applyHypothesisObservation(
				graph,
				observation(graph, graph.nodes[0].id, "refuted"),
				snapshot,
				lease.taskId,
				lease.leaseId,
			);
			expect(next.nodes[1].status).toBe("pending");
			expect(next.nodes[1].needsReview).toBe(true);
			expect(store.snapshot("dag-run", true).activeLeases).toHaveLength(1);
		} finally {
			store.close();
		}
	});
	it("checkpoint inputs release downstream work before full report completion", async () => {
		const store = await setup();
		try {
			const value = raw();
			value.tasks.push({
				...value.tasks[0],
				key: "use-partial",
				objective: "Use the already published partial artifact",
				doneWhen: "Test the next local condition",
				requiredInputs: [{ sourceTaskId: "test-A", artifactPath: "/work/partial.json" }] as never,
			});
			const snapshot = commit(store, value);
			const source = snapshot.tasks[0];
			const downstream = snapshot.tasks[1];
			expect(downstream.status).toBe("proposed");
			const graph = snapshot.hypothesisGraph!;
			graph.checkpointArtifacts = [{ sourceTaskId: source.taskId, path: "/work/partial.json", sha256: "h" }];
			expect(hypothesisTaskRunnable(graph, snapshot, downstream.taskId)).toBe(true);
			expect(source.status).toBe("ready");
		} finally {
			store.close();
		}
	});
	it("does not convert a derivation edge into a completion dependency", async () => {
		const store = await setup();
		try {
			const value = raw();
			value.newHypotheses.push({
				...value.newHypotheses[0],
				key: "B",
				statement: "A different observable claim",
				parentHypothesisIds: ["A"],
			});
			value.tasks.push({
				...value.tasks[0],
				key: "test-B",
				objective: "Independently test B",
				hypothesisIds: ["B"],
			});
			const snapshot = commit(store, value);
			expect(snapshot.tasks.every((task) => task.status === "ready")).toBe(true);
		} finally {
			store.close();
		}
	});
	it("cannot wait on the historical stale owner or on no owner", async () => {
		const store = await setup();
		try {
			commit(store);
			expect(() =>
				parseHypothesisProposal(
					{ decision: "blocked", rationale: "old owner allegedly running", newHypotheses: [], tasks: [] },
					store.snapshot("dag-run", true),
				),
			).toThrow("live owner");
		} finally {
			store.close();
		}
	});
	it("persists partial checkpoint inputs and releases a downstream lease while the producer continues", async () => {
		const root = mkdtempSync(join(tmpdir(), "hypothesis-checkpoint-"));
		const file = join(root, "partial.json");
		writeFileSync(file, '{"observation":68}');
		const store = await setup();
		try {
			const value = raw();
			value.tasks.push({
				...value.tasks[0],
				key: "use-checkpoint",
				objective: "Use the published partial result",
				doneWhen: "Check the next precise condition",
				requiredInputs: [{ sourceTaskId: "test-A", artifactPath: file }] as never,
			});
			let snapshot = commit(store, value);
			const source = snapshot.tasks[0];
			const target = snapshot.tasks[1];
			const lease = store.leaseTask("dag-run", source.taskId, root, 30000, Date.now(), 2);
			store.startLease(lease.leaseId);
			evidence(store, lease.leaseId);
			store.recordCheckpoint(lease.leaseId, "partial-cp", {
				summary: "Partial artifact is available before the whole report",
				evidenceRefs: ["ev-A"],
				completedItems: ["artifact produced"],
				remainingItems: ["continue end-to-end solving"],
				rejectedDirections: [],
				artifacts: [{ path: file, type: "json", description: "partial result" }],
				suggestedNextSteps: [],
			});
			snapshot = store.snapshot("dag-run", true);
			expect(snapshot.tasks.find((task) => task.taskId === source.taskId)?.status).toBe("running");
			expect(snapshot.tasks.find((task) => task.taskId === target.taskId)?.status).toBe("ready");
			const child = store.leaseTask("dag-run", target.taskId, root, 30000, Date.now(), 2);
			expect(child.taskId).toBe(target.taskId);
			store.recordCheckpoint(lease.leaseId, "later-cp", {
				summary: "Another checkpoint does not erase the first artifact",
				evidenceRefs: ["ev-A"],
				completedItems: [],
				remainingItems: ["continue"],
				rejectedDirections: [],
				artifacts: [],
				suggestedNextSteps: [],
			});
			expect(store.getHypothesisGraph("dag-run")?.checkpointArtifacts).toEqual(
				expect.arrayContaining([expect.objectContaining({ path: file })]),
			);
		} finally {
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("detects cycles spanning partial-input edges and completion edges", async () => {
		const store = await setup();
		try {
			const value = raw();
			value.tasks[0].requiredInputs = [{ sourceTaskId: "test-B", artifactPath: "/work/partial" }] as never;
			value.tasks.push({
				...value.tasks[0],
				key: "test-B",
				objective: "A different delivery",
				dependsOn: ["test-A"],
				requiredInputs: [],
			});
			expect(() => parseHypothesisProposal(value, store.snapshot("dag-run"))).toThrow("dependency cycle");
		} finally {
			store.close();
		}
	});
	it("runs a real Pi proposal session with only structured submission, and corrects bad citations locally", async () => {
		const root = mkdtempSync(join(tmpdir(), "hypothesis-pi-"));
		const store = await setup();
		const faux = fauxProvider({ models: [{ id: "dag-fixture", reasoning: false }] });
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(faux.provider.id, async () => ({ type: "api_key", key: "fixture" }));
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		runtime.registerNativeProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false });
		const config = loadSecHeurConfig({
			projectRoot: root,
			stateDir: join(root, "state"),
			legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
			env: { PI_OFFLINE: "1" },
		});
		config.skillPaths = [];
		config.systemPromptPath = "";
		config.planning.engine = "hypothesis";
		const bad = raw();
		bad.newHypotheses[0].basisRefs = ["foreign-run"];
		faux.setResponses(
			[bad, raw()].map((args, index) => (context) => {
				expect(context.tools?.map((tool) => tool.name)).toEqual(["submit_planning_proposal"]);
				return fauxAssistantMessage(fauxToolCall("submit_planning_proposal", args, { id: `submit-${index}` }), {
					stopReason: "toolUse",
				});
			}),
		);
		try {
			const supervisor = new HypothesisPlanningSupervisor({
				config,
				cwd: root,
				model: faux.getModel(),
				modelRuntime: runtime,
				thinkingLevel: "off",
			});
			const proposal = await supervisor.propose({ snapshot: store.snapshot("dag-run", true) });
			expect(proposal.hypothesisUpdate?.newNodes).toHaveLength(1);
			expect(faux.state.callCount).toBe(2);
			expect(proposal.tasks).toHaveLength(1);
		} finally {
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("replays the historical 394-second gap input: a finished owner cannot justify waiting", async () => {
		const fixture = JSON.parse(
			readFileSync(resolve(import.meta.dirname, "fixtures/planning-hypothesis-history.json"), "utf8"),
		);
		const history = fixture.cases.find((item: { name: string }) => item.name === "stale_owner_gap");
		expect(history.gapSeconds).toBe(394.357);
		expect(history.blockedPlanEndSeconds).toBeGreaterThan(history.lastOwnerEndedSeconds);
		expect(history.events.some((event: { type: string }) => event.type === "task_committed")).toBe(true);
		const store = await setup();
		try {
			const snapshot = commit(store);
			const lease = store.leaseTask("dag-run", snapshot.tasks[0].taskId, "/work", 30000);
			store.startLease(lease.leaseId);
			evidence(store, lease.leaseId);
			store.commitResult({
				leaseId: lease.leaseId,
				planRevision: lease.planRevision,
				result: {
					schemaVersion: 1,
					leaseId: lease.leaseId,
					outcome: "blocked",
					summary: "Replay: local input was not available; previous owner has ended",
					suggestedTasks: [],
					flagCandidates: [],
					evidenceRefs: ["ev-A"],
				},
				evidence: [],
			});
			expect(() =>
				parseHypothesisProposal(
					{
						decision: "blocked",
						rationale: "A historical stale snapshot said this owner was running",
						newHypotheses: [],
						tasks: [],
					},
					store.snapshot("dag-run", true),
				),
			).toThrow("live owner");
		} finally {
			store.close();
		}
	});
	it("retains the historical dependency and provider-failure evidence without mislabelling it as planning success", () => {
		const fixture = JSON.parse(
			readFileSync(resolve(import.meta.dirname, "fixtures/planning-hypothesis-history.json"), "utf8"),
		);
		const wait = fixture.cases.find((item: { name: string }) => item.name === "completion_dependency_wait");
		expect(wait.dependencies.length).toBeGreaterThan(0);
		expect(wait.tasks.some((item: { outerTurnLimit: boolean }) => item.outerTurnLimit)).toBe(true);
		const provider = fixture.cases.find((item: { name: string }) => item.name === "shared_provider_failure");
		expect(provider.requestCount).toBe(342);
		expect(provider.http429Count).toBe(264);
	});
});
