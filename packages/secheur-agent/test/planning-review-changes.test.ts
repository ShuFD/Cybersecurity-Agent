import { expect, it } from "vitest";
import { parseArtexProposal } from "../src/planning/artex-adapters.ts";
import { ArtexWake } from "../src/planning/artex-wake.ts";
import { compilePlanningProposal } from "../src/planning/compiler.ts";
import {
	capturePlanningReview,
	planningChangesOverview,
	PlanningReviewChanges,
} from "../src/planning/review-changes.ts";
import { PlanningStore } from "../src/planning/store.ts";

async function fixture() {
	const store = await PlanningStore.open(":memory:");
	const runId = "review-synthetic";
	store.createRun({ runId, outerTaskId: "outer", goal: "Synthetic goal", mode: "active" });
	const initial = store.snapshot(runId, true);
	const proposal = parseArtexProposal(
		{
			decision: "create_tasks",
			rationale: "Start an owner",
			todo: "Collect an observation",
			tasks: [{ key: "owner", objective: "Synthetic observation", doneWhen: "Record a finding" }],
		},
		initial,
	);
	store.commitPlan({
		runId,
		expectedRevision: 0,
		rationale: proposal.rationale,
		artexUpdate: proposal.artexUpdate,
		tasks: compilePlanningProposal(runId, proposal, [], 10),
		idempotencyKey: "initial",
	});
	return { store, runId };
}

it("ignores planner bookkeeping and lease acquisition, while evidence and completed work remain wake reasons", async () => {
	const { store, runId } = await fixture();
	try {
		const review = new PlanningReviewChanges();
		const initial = capturePlanningReview(store.snapshot(runId, true));
		review.acknowledge(initial);
		const lease = store.leaseTask(runId, Object.keys(initial.tasks)[0], "/synthetic", 30000);
		store.startLease(lease.leaseId);
		const active = store.snapshot(runId, true);
		active.run.revision += 10;
		active.artexGraph!.version += 10;
		active.artexGraph!.todo = "PRIVATE_PLANNER_NOTE";
		expect(review.wakeState(capturePlanningReview(active))).toBe(review.wakeState(initial));
		expect(review.changes(capturePlanningReview(active)).tasks).toEqual([
			{ taskId: lease.taskId, status: "running" },
		]);
		store.recordEvidence(lease.leaseId, [
			{
				evidenceId: "exact-original",
				kind: "tool",
				source: "fixture",
				summary: "PRIVATE_OUTPUT",
				contentHash: "hash",
			},
		]);
		const changed = capturePlanningReview(store.snapshot(runId, true));
		expect(review.wakeState(changed)).not.toBe(review.wakeState(initial));
		expect(review.changes(changed).evidenceIds).toEqual(["exact-original"]);
		expect(JSON.stringify(changed)).not.toContain("PRIVATE_OUTPUT");
		changed.tasks[lease.taskId] = "done";
		expect(review.wakeState(changed)).not.toBe(review.wakeState(capturePlanningReview(active)));
	} finally {
		store.close();
	}
});

it("acknowledges only accepted input and own edits, retaining concurrent worker arrivals", async () => {
	const { store, runId } = await fixture();
	try {
		const review = new PlanningReviewChanges();
		const snapshot = store.snapshot(runId, true);
		const lease = store.leaseTask(runId, snapshot.tasks[0].taskId, "/synthetic", 30000);
		store.startLease(lease.leaseId);
		const input = capturePlanningReview(store.snapshot(runId, true));
		store.recordEvidence(lease.leaseId, [
			{
				evidenceId: "arrived-during-request",
				kind: "tool",
				source: "fixture",
				summary: "Observation",
				contentHash: "hash",
			},
		]);
		const before = store.snapshot(runId, true);
		const proposal = parseArtexProposal(
			{
				decision: "blocked",
				rationale: "Current owner covers the next step",
				todo: "Continue current work",
				tasks: [],
				waitForTaskIds: [lease.taskId],
				hints: [{ key: "own-hint", payload: "Planner suggestion" }],
			},
			before,
		);
		const after = store.commitPlan({
			runId,
			expectedRevision: before.run.revision,
			rationale: proposal.rationale,
			artexUpdate: proposal.artexUpdate,
			tasks: [],
			idempotencyKey: "waiting",
			allowActiveLeases: true,
		});
		expect(review.changes(input).initial).toBe(true); // Failed/unaccepted calls have not acknowledged anything.
		review.acknowledge(input, capturePlanningReview(before), capturePlanningReview(after));
		const pending = review.changes(capturePlanningReview(after));
		expect(pending.initial).toBe(false);
		expect(pending.evidenceIds).toEqual(["arrived-during-request"]);
		expect(pending.artexNodeIds).toEqual([]);
		const wake = new ArtexWake({ debounceMs: 800, heartbeatMs: 600000 }, 0);
		wake.reviewed(review.wakeState(), 100);
		wake.observe(review.wakeState(capturePlanningReview(after)), 100);
		expect(wake.delay(900)).toBe(0);
		expect(wake.reason(900)).toBe("changes");
		review.acknowledge(capturePlanningReview(after));
		wake.reviewed(review.wakeState(), 900);
		wake.observe(review.wakeState(capturePlanningReview(after)), 901);
		expect(wake.delay(901)).toBe(599999);
		expect(wake.reason(600900)).toBe("heartbeat");
	} finally {
		store.close();
	}
});

it("bounds presented changes without shortening canonical IDs or removing the underlying records", () => {
	const evidenceIds = Array.from({ length: 30 }, (_, index) => `exact-evidence-${index}-with-complete-suffix`);
	const changes = {
		initial: false,
		tasks: [],
		evidenceIds,
		evidenceCardIds: [],
		artexNodeIds: [],
		hypothesisNodeIds: [],
	};
	const overview = planningChangesOverview(changes);
	expect(overview.evidenceIds).toEqual(evidenceIds.slice(-16));
	expect(overview.evidenceIdsOmitted).toBe(14);
	expect(changes.evidenceIds).toHaveLength(30);
});
