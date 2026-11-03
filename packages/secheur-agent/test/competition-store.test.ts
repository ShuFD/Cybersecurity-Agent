import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChallengeSnapshot, SubmissionPolicy } from "../src/competition-protocol.ts";
import { CompetitionStore } from "../src/competition-store.ts";

const challenge = (exerciseId: number): ChallengeSnapshot => ({
	exerciseId,
	name: `challenge-${exerciseId}`,
	category: "pwn",
	description: "A test challenge",
	hints: [],
	flagFormat: { prefix: "FLAG{", suffix: "}", accepts: "either", submit: "full" },
	attachments: [],
	environment: { required: true, status: "pending", endpoints: [] },
	scoring: {
		currentScore: 100,
		challengeValue: 100,
		estimatedSolveProbability: 0.2,
		confidence: 0,
		expectedRemainingMinutes: 10,
		environmentWaitMinutes: 1,
		agingBonus: 0,
		asOf: Date.now(),
	},
	platform: {},
});

const submission: SubmissionPolicy = {
	flagFormat: challenge(1).flagFormat,
	maxAttempts: 2,
	duplicateScope: "challenge",
	acceptedStatuses: ["correct"],
};

describe("competition store", () => {
	it("coordinates environment leases and single-flight builds across store instances", async () => {
		const root = await mkdtemp(join(tmpdir(), "secheur-competition-store-"));
		const path = join(root, "competition.sqlite");
		const first = await CompetitionStore.open(path);
		const second = await CompetitionStore.open(path);
		try {
			first.upsertTask({
				taskId: "task-1",
				shortTask: "pwn one",
				challenge: challenge(1),
				submission,
				policySnapshotId: "policy",
				priority: 10,
			});
			first.upsertTask({
				taskId: "task-2",
				shortTask: "pwn two",
				challenge: challenge(2),
				submission,
				policySnapshotId: "policy",
				priority: 9,
			});
			const firstLease = first.claimEnvironmentLease(1, "task-1", "broker-a", 1, 60_000, 1_000);
			const secondLease = second.claimEnvironmentLease(2, "task-2", "broker-b", 1, 60_000, 1_000);
			expect(firstLease.granted).toBe(true);
			expect(secondLease).toMatchObject({ granted: false, reason: "capacity" });

			const build = first.beginEnvironmentBuild(1, "broker-a", 0, 1_000);
			const duplicateBuild = second.beginEnvironmentBuild(1, "broker-b", 0, 1_000);
			expect(build.state).toBe("acquired");
			expect(duplicateBuild.state).toBe("in_progress");
			first.completeEnvironmentBuild(1, build.token, { endpoint: 31337 }, 1_001);
			expect(second.beginEnvironmentBuild(1, "broker-b", 0, 1_002).state).toBe("ready");

			const event = {
				protocol: "secheur.competition/v1" as const,
				version: 1 as const,
				eventId: "event-1",
				taskId: "task-1",
				assignmentId: "assignment-1",
				solverId: "solver-1",
				type: "evidence" as const,
				occurredAt: 1_000,
				payload: {
					evidenceId: "evidence-1",
					kind: "observation" as const,
					summary: "observed",
					source: "test",
					refs: ["test:1"],
				},
			};
			expect(first.appendEvent(event).inserted).toBe(true);
			expect(second.appendEvent(event).inserted).toBe(false);
		} finally {
			first.close();
			second.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("increments attempts only for real calls and deduplicates candidates", async () => {
		const store = await CompetitionStore.open(":memory:");
		try {
			store.upsertTask({
				taskId: "task-1",
				shortTask: "submit",
				challenge: challenge(1),
				submission,
				policySnapshotId: "policy",
				priority: 1,
			});
			const started = store.beginSubmission({
				taskId: "task-1",
				assignmentId: "assignment-1",
				rawCandidateHash: "raw-1",
				normalizedCandidateHash: "normalized-1",
				maxAttempts: 2,
				evidenceRefs: ["evidence-1"],
				requestPayload: { flag: "FLAG{one}" },
			});
			expect(started.kind).toBe("started");
			expect(store.getTask("task-1")?.actualAttempts).toBe(1);
			expect(
				store.beginSubmission({
					taskId: "task-1",
					assignmentId: "assignment-1",
					rawCandidateHash: "raw-duplicate",
					normalizedCandidateHash: "normalized-1",
					maxAttempts: 2,
					evidenceRefs: ["evidence-1"],
					requestPayload: { flag: "FLAG{one}" },
				}).kind,
			).toBe("duplicate");
			if (started.kind === "started")
				store.finishSubmission(started.submission.recordId, {
					category: "incorrect",
					isCorrect: false,
					response: { status: "incorrect" },
				});
			const second = store.beginSubmission({
				taskId: "task-1",
				assignmentId: "assignment-1",
				rawCandidateHash: "raw-2",
				normalizedCandidateHash: "normalized-2",
				maxAttempts: 2,
				evidenceRefs: ["evidence-2"],
				requestPayload: { flag: "FLAG{two}" },
			});
			expect(second.kind).toBe("started");
			expect(store.getTask("task-1")?.actualAttempts).toBe(2);
			expect(
				store.beginSubmission({
					taskId: "task-1",
					assignmentId: "assignment-1",
					rawCandidateHash: "raw-3",
					normalizedCandidateHash: "normalized-3",
					maxAttempts: 2,
					evidenceRefs: ["evidence-3"],
					requestPayload: { flag: "FLAG{three}" },
				}).kind,
			).toBe("attempt_limit");
		} finally {
			store.close();
		}
	});

	it("persists explicit attempt budgets separately from the platform maximum", async () => {
		const store = await CompetitionStore.open(":memory:");
		try {
			store.upsertTask({
				taskId: "budget-task",
				shortTask: "budget",
				challenge: challenge(2),
				submission,
				policySnapshotId: "policy",
				priority: 1,
			});
			const result = store.setAttemptBudgets([{ taskId: "budget-task", budget: 1 }]);
			expect(result).toHaveLength(1);
			expect(result[0]?.attemptBudget).toBe(1);
			expect(result[0]?.submission.maxAttempts).toBe(2);
		} finally {
			store.close();
		}
	});

	it("requeues stopped tasks and clears stale solver leases", async () => {
		const store = await CompetitionStore.open(":memory:");
		try {
			store.upsertTask({
				taskId: "stopped-task",
				shortTask: "recoverable task",
				challenge: challenge(3),
				submission,
				policySnapshotId: "policy",
				priority: 1,
			});
			const claim = store.claimTask("stopped-task", "old-solver", 60_000);
			expect(claim.granted).toBe(true);
			store.setTaskStatus("stopped-task", "stopped", "Stopped by an earlier run");
			expect(store.getTask("stopped-task")).toMatchObject({ status: "stopped", solverId: "old-solver" });

			const queued = store.requeueTask("stopped-task");
			expect(queued).toMatchObject({ status: "queued", actualAttempts: 0 });
			expect(queued?.solverId).toBeUndefined();
			expect(queued?.lease).toBeUndefined();
			expect(queued?.lastError).toBeUndefined();
		} finally {
			store.close();
		}
	});

	it("does not requeue an actively leased task", async () => {
		const store = await CompetitionStore.open(":memory:");
		try {
			store.upsertTask({
				taskId: "active-task",
				shortTask: "active task",
				challenge: challenge(4),
				submission,
				policySnapshotId: "policy",
				priority: 1,
			});
			store.claimTask("active-task", "active-solver", 60_000);
			expect(() => store.requeueTask("active-task")).toThrow(/active solver lease/iu);
		} finally {
			store.close();
		}
	});

	it("clears solver ownership when stopping a task", async () => {
		const store = await CompetitionStore.open(":memory:");
		try {
			store.upsertTask({
				taskId: "stop-task",
				shortTask: "stop task",
				challenge: challenge(5),
				submission,
				policySnapshotId: "policy",
				priority: 1,
			});
			store.claimTask("stop-task", "solver-to-stop", 60_000);
			const stopped = store.stopTask("stop-task", "operator stop", true);
			expect(stopped).toMatchObject({ status: "stopped", lastError: "operator stop" });
			expect(stopped?.solverId).toBeUndefined();
			expect(stopped?.lease).toBeUndefined();
		} finally {
			store.close();
		}
	});

	it("persists the ordered competition plan across store reopen", async () => {
		const root = await mkdtemp(join(tmpdir(), "secheur-competition-plan-store-"));
		const path = join(root, "competition.sqlite");
		const first = await CompetitionStore.open(path);
		try {
			for (const exerciseId of [1, 2])
				first.upsertTask({
					taskId: `task-${exerciseId}`,
					shortTask: `pwn ${exerciseId}`,
					challenge: challenge(exerciseId),
					submission,
					policySnapshotId: "policy",
					priority: exerciseId,
				});
			const plan = first.setPlan({
				orderedTaskIds: ["task-2", "task-1"],
				rationale: "The second task has the better expected value.",
				generatedBy: "test-coordinator",
			});
			expect(plan).toMatchObject({ revision: 1, orderedTaskIds: ["task-2", "task-1"] });
			expect(first.getTask("task-2")?.plan).toMatchObject({ planId: plan.planId, revision: 1, rank: 0 });
		} finally {
			first.close();
		}
		const second = await CompetitionStore.open(path);
		try {
			expect(second.getPlan()).toMatchObject({
				planId: expect.any(String),
				revision: 1,
				orderedTaskIds: ["task-2", "task-1"],
				generatedBy: "test-coordinator",
			});
			expect(second.listTasks({ unassignedOnly: true }).map((task) => task.taskId)).toEqual(["task-2", "task-1"]);
			expect(second.getTask("task-1")?.plan).toMatchObject({ revision: 1, rank: 1 });
		} finally {
			second.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
