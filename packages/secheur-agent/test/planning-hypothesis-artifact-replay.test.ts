import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PlanningSnapshot, PlanningTaskLease } from "../src/planning/contracts.ts";
import { hypothesisExecutorContext } from "../src/planning/hypothesis-adapters.ts";
import { hypothesisTaskRunnable, resolveHypothesisArtifactInput } from "../src/planning/hypothesis-graph.ts";
import type { HypothesisGraphUpdate, HypothesisNode } from "../src/planning/hypothesis-types.ts";
import { type CompiledPlanningTask, PlanningStore } from "../src/planning/store.ts";

// Structural metadata only, transcribed from raw-metadata.json. File contents,
// hypotheses, observations and model output are synthetic throughout this replay.
const RUN = "artifact-dependency-replay";
const SOURCE_IDS = ["plan_fac8f85fe5ce1b49c414f923", "plan_785e42a324cddfce281fc55f"] as const;
const CONSUMER = "plan_4761fb28b233f12f8a357bcd";
const ATTEMPTS = ["179130f0859dc987542ef2a7315805bd", "32e826c637de3be0664f7c030d616b69"] as const;
const RELATIVE_PATHS = ["notes/protocol_transcript.md", "notes/probe_matrix.md"] as const;
const HYPOTHESES = [
	"hyp_6a1223b41e091e5794f26d74",
	"hyp_ca5a3a502a1ef411ee12e194",
	"hyp_5a40c83cc89993fc63707b04",
	"hyp_a3f544b37424830f2f9d568c",
] as const;

function node(id: string, index: number): HypothesisNode {
	return {
		id,
		statement: `Synthetic dependency claim ${index}`,
		status: "pending",
		basisRefs: ["human:goal"],
		parentHypothesisIds: index === 0 ? [] : [HYPOTHESES[0]],
		verificationCriteria: "Synthetic observation equals the fixture value",
		refutationCriteria: "Synthetic observation differs from the fixture value",
		verificationEvidenceRefs: [],
		needsReview: false,
	};
}

interface FixtureOptions {
	absoluteInputs?: boolean;
	wrongSource?: boolean;
	explicitDependencies?: boolean;
	deferConsumer?: boolean;
}

async function fixture(options: FixtureOptions = {}) {
	const root = mkdtempSync(join(tmpdir(), "hypothesis-artifact-replay-"));
	const database = join(root, "state", "planning.sqlite");
	const scopes = ATTEMPTS.map((id) => join(root, ".planning-attempts", id));
	const files = scopes.map((scope, index) => join(scope, RELATIVE_PATHS[index]));
	for (const file of files) {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, "Synthetic dependency fixture; no challenge content.\n");
	}
	let store = await PlanningStore.open(database);
	store.createRun({
		runId: RUN,
		outerTaskId: "fixture-outer",
		goal: "Exercise artifact handoff only",
		mode: "active",
	});
	const requirements = RELATIVE_PATHS.map((path, index) => ({
		sourceTaskId: options.wrongSource && index === 0 ? SOURCE_IDS[1] : SOURCE_IDS[index],
		artifactPath: options.absoluteInputs ? files[index] : path,
	}));
	const consumerTask: CompiledPlanningTask = {
		taskId: CONSUMER,
		objective: "Consume both registered fixture artifacts",
		doneWhen: "Read the two fixture artifacts through their registered locations",
		priority: 0,
		sequence: 2,
		dependsOnTaskIds: options.explicitDependencies === false ? [] : [...SOURCE_IDS],
	};
	const consumerBinding: HypothesisGraphUpdate["newBindings"][number] = {
		taskId: CONSUMER,
		hypothesisIds: [...HYPOTHESES.slice(1)],
		purpose: "test_hypothesis",
		requiredInputs: requirements,
	};
	store.commitPlan({
		runId: RUN,
		expectedRevision: 0,
		rationale: "Replay the production dependency shape with synthetic observations",
		idempotencyKey: "fixture-initial-plan",
		hypothesisUpdate: {
			expectedVersion: 0,
			newNodes: HYPOTHESES.map(node),
			newBindings: [
				...SOURCE_IDS.map((taskId, index) => ({
					taskId,
					hypothesisIds: index === 0 ? [HYPOTHESES[0]] : [...HYPOTHESES.slice(1)],
					purpose: "gather_evidence" as const,
					requiredInputs: [],
				})),
				...(options.deferConsumer ? [] : [consumerBinding]),
			],
		},
		tasks: [
			...SOURCE_IDS.map((taskId, index) => ({
				taskId,
				objective: `Produce synthetic fixture artifact ${index}`,
				doneWhen: `Register synthetic fixture artifact ${index}`,
				priority: 0,
				sequence: index,
				dependsOnTaskIds: [],
			})),
			...(options.deferConsumer ? [] : [consumerTask]),
		],
	});
	const leases = new Map<number, PlanningTaskLease>();
	function start(index: number) {
		let lease = leases.get(index);
		if (lease) return lease;
		lease = store.leaseTask(RUN, SOURCE_IDS[index], scopes[index], 300_000, Date.now(), 2);
		store.startLease(lease.leaseId);
		store.recordEvidence(lease.leaseId, [
			{
				evidenceId: `fixture-evidence-${index}`,
				kind: "tool",
				source: "fixture-tool",
				toolName: "fixture-tool",
				summary: "Synthetic successful observation",
				excerpt: "Synthetic observation only",
				contentHash: `fixture-hash-${index}`,
				metadata: { isError: false },
			},
		]);
		leases.set(index, lease);
		return lease;
	}
	return {
		get store() {
			return store;
		},
		files,
		scopes,
		requirements,
		start,
		finish(index: number, includeArtifact = true, registerWorkspace = true) {
			const lease = start(index);
			return store.commitResult({
				leaseId: lease.leaseId,
				planRevision: lease.planRevision,
				...(registerWorkspace ? { artifactWorkspace: scopes[index] } : {}),
				result: {
					schemaVersion: 1,
					leaseId: lease.leaseId,
					outcome: "done",
					summary: `Synthetic producer ${index} completed`,
					suggestedTasks: [],
					flagCandidates: [],
					evidenceRefs: [`fixture-evidence-${index}`],
					artifacts: includeArtifact
						? [{ path: files[index], type: "markdown", description: "Synthetic fixture artifact" }]
						: [],
				},
				evidence: [],
			});
		},
		checkpoint(index: number, includeArtifact = true) {
			const lease = start(index);
			return store.recordCheckpoint(
				lease.leaseId,
				`fixture-checkpoint-${index}`,
				{
					summary: `Synthetic partial artifact ${index}`,
					evidenceRefs: [`fixture-evidence-${index}`],
					completedItems: ["Fixture observation recorded"],
					remainingItems: ["Producer continues its independent work"],
					rejectedDirections: [],
					artifacts: includeArtifact
						? [{ path: files[index], type: "markdown", description: "Synthetic partial artifact" }]
						: [],
					suggestedNextSteps: [],
				},
				Date.now(),
				undefined,
				scopes[index],
			);
		},
		appendConsumer() {
			const snapshot = store.snapshot(RUN, true);
			return store.commitPlan({
				runId: RUN,
				expectedRevision: snapshot.run.revision,
				rationale: "Use already completed registered producers",
				idempotencyKey: "fixture-late-consumer",
				hypothesisUpdate: {
					expectedVersion: snapshot.hypothesisGraph!.version,
					newNodes: [],
					newBindings: [consumerBinding],
				},
				tasks: [consumerTask],
			});
		},
		async reopen() {
			store.close();
			store = await PlanningStore.open(database);
		},
		close() {
			store.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function status(snapshot: PlanningSnapshot, taskId = CONSUMER) {
	return snapshot.tasks.find((task) => task.taskId === taskId)?.status;
}

describe("hypothesis artifact dependency replay", () => {
	it("releases the real two-producer dependency shape and presents canonical paths to the consumer", async () => {
		const f = await fixture();
		try {
			expect(status(f.store.snapshot(RUN, true))).toBe("proposed");
			expect(status(f.finish(0))).toBe("proposed");
			const snapshot = f.finish(1);
			expect(SOURCE_IDS.map((id) => status(snapshot, id))).toEqual(["done", "done"]);
			expect(status(snapshot)).toBe("ready");
			for (const [index, input] of f.requirements.entries())
				expect(resolveHypothesisArtifactInput(snapshot.hypothesisGraph!, snapshot, input)).toEqual({
					kind: "resolved",
					artifactPath: f.files[index],
				});
			const original = JSON.stringify(snapshot.hypothesisGraph!.taskBindings);
			const view = hypothesisExecutorContext(snapshot, CONSUMER);
			for (const file of f.files) expect(view).toContain(JSON.stringify(file));
			expect(JSON.stringify(snapshot.hypothesisGraph!.taskBindings)).toBe(original);
			expect(
				snapshot.hypothesisGraph!.taskBindings.find((binding) => binding.taskId === CONSUMER)?.requiredInputs,
			).toEqual(f.requirements);
			const consumer = f.store.leaseTask(RUN, CONSUMER, f.scopes[0], 300_000, Date.now(), 2);
			expect(consumer.taskId).toBe(CONSUMER);
		} finally {
			f.close();
		}
	});

	it("retains legacy exact absolute-path inputs without requiring an alias migration", async () => {
		const f = await fixture({ absoluteInputs: true });
		try {
			f.finish(0, true, false);
			const snapshot = f.finish(1, true, false);
			expect(status(snapshot)).toBe("ready");
			for (const [index, input] of f.requirements.entries())
				expect(resolveHypothesisArtifactInput(snapshot.hypothesisGraph!, snapshot, input)).toEqual({
					kind: "resolved",
					artifactPath: f.files[index],
				});
		} finally {
			f.close();
		}
	});

	it("does not infer aliases for unregistered legacy relative inputs", async () => {
		const f = await fixture();
		try {
			f.finish(0, true, false);
			const snapshot = f.finish(1, true, false);
			expect(status(snapshot)).toBe("proposed");
			expect(resolveHypothesisArtifactInput(snapshot.hypothesisGraph!, snapshot, f.requirements[0])).toEqual({
				kind: "missing",
			});
		} finally {
			f.close();
		}
	});

	it("does not use a matching filename or alias owned by the wrong producer", async () => {
		const f = await fixture({ wrongSource: true });
		try {
			f.finish(0);
			const snapshot = f.finish(1);
			expect(status(snapshot)).toBe("proposed");
			expect(resolveHypothesisArtifactInput(snapshot.hypothesisGraph!, snapshot, f.requirements[0])).toEqual({
				kind: "missing",
			});
		} finally {
			f.close();
		}
	});

	it("does not release a consumer merely because both producers ended without registering all inputs", async () => {
		const f = await fixture();
		try {
			f.finish(0, false);
			const snapshot = f.finish(1);
			expect(SOURCE_IDS.map((id) => status(snapshot, id))).toEqual(["done", "done"]);
			expect(status(snapshot)).toBe("proposed");
		} finally {
			f.close();
		}
	});

	it("persists the source-owned aliases across database reopen before the second producer completes", async () => {
		const f = await fixture();
		try {
			f.finish(0);
			await f.reopen();
			expect(status(f.store.snapshot(RUN, true))).toBe("proposed");
			const snapshot = f.finish(1);
			expect(status(snapshot)).toBe("ready");
			await f.reopen();
			const reloaded = f.store.snapshot(RUN, true);
			expect(status(reloaded)).toBe("ready");
			for (const [index, input] of f.requirements.entries())
				expect(resolveHypothesisArtifactInput(reloaded.hypothesisGraph!, reloaded, input)).toEqual({
					kind: "resolved",
					artifactPath: f.files[index],
				});
		} finally {
			f.close();
		}
	});

	it("validates a newly proposed relative input against an already completed registered producer", async () => {
		const f = await fixture({ deferConsumer: true });
		try {
			f.finish(0);
			f.finish(1);
			expect(status(f.appendConsumer())).toBe("ready");
		} finally {
			f.close();
		}
	});

	it("releases a partial-input consumer while both source leases continue, and retains aliases after a later checkpoint", async () => {
		const f = await fixture({ explicitDependencies: false });
		try {
			f.checkpoint(0);
			expect(status(f.store.snapshot(RUN, true))).toBe("proposed");
			f.checkpoint(1);
			let snapshot = f.store.snapshot(RUN, true);
			expect(SOURCE_IDS.map((id) => status(snapshot, id))).toEqual(["running", "running"]);
			expect(status(snapshot)).toBe("ready");
			const lease = f.start(0);
			f.store.recordCheckpoint(lease.leaseId, "later-no-artifact", {
				summary: "Synthetic later progress without a replacement artifact",
				evidenceRefs: ["fixture-evidence-0"],
				completedItems: [],
				remainingItems: ["Continue synthetic work"],
				rejectedDirections: [],
				artifacts: [],
				suggestedNextSteps: [],
			});
			snapshot = f.store.snapshot(RUN, true);
			expect(hypothesisTaskRunnable(snapshot.hypothesisGraph!, snapshot, CONSUMER)).toBe(true);
			await f.reopen();
			expect(status(f.store.snapshot(RUN, true))).toBe("ready");
		} finally {
			f.close();
		}
	});

	it.each(["refuted", "needsReview"] as const)(
		"keeps %s hypotheses blocking even when every artifact resolves",
		async (mode) => {
			const f = await fixture();
			try {
				const lease = f.start(0);
				f.start(1);
				const resolveRoot = (verdict: "verified" | "refuted") => {
					const graph = f.store.getHypothesisGraph(RUN)!;
					return f.store.publishHypothesisObservation(lease.leaseId, {
						expectedVersion: graph.version,
						card: {
							summary: "Synthetic observation for hypothesis dependency gating only",
							keyValues: { mode },
							scope: "fixture observation",
							limitations: "No challenge content or overall-goal verdict",
							evidenceRefs: ["fixture-evidence-0"],
						},
						resolutions: [
							{
								hypothesisId: HYPOTHESES[0],
								verdict,
								explanation: "Synthetic criterion result",
								evidenceRefs: ["fixture-evidence-0"],
							},
						],
					});
				};
				if (mode === "needsReview") resolveRoot("verified");
				resolveRoot("refuted");
				f.finish(0);
				const snapshot = f.finish(1);
				for (const input of f.requirements)
					expect(resolveHypothesisArtifactInput(snapshot.hypothesisGraph!, snapshot, input).kind).toBe("resolved");
				expect(hypothesisTaskRunnable(snapshot.hypothesisGraph!, snapshot, CONSUMER)).toBe(false);
				expect(status(snapshot)).toBe("proposed");
			} finally {
				f.close();
			}
		},
	);
});
