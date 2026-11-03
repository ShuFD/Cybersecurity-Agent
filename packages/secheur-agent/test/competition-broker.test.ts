import { encodeCbor } from "@earendil-works/pi-protocol";
import { describe, expect, it, vi } from "vitest";
import type {
	CompetitionChallenge,
	CompetitionPlatformAdapter,
	CompetitionPolicy,
	CompetitionSubmitResult,
} from "../src/competition-adapters.ts";
import { SlabAgentApi } from "../src/competition-api.ts";
import { CompetitionBroker } from "../src/competition-broker.ts";
import type { ChallengeSnapshot, CompetitionEvent, SubmissionPolicy } from "../src/competition-protocol.ts";
import { summarizeCompetitionTask } from "../src/competition-solver.ts";
import { CompetitionStore } from "../src/competition-store.ts";

function challenge(exerciseId: number, accepts: "full" | "inner" | "either" = "either"): ChallengeSnapshot {
	return {
		exerciseId,
		name: `challenge-${exerciseId}`,
		category: "web",
		description: "test challenge",
		hints: [],
		flagFormat: { prefix: "FLAG{", suffix: "}", accepts, submit: "full" },
		attachments: [],
		environment: { required: false, status: "none", endpoints: [] },
		scoring: {
			currentScore: 100,
			challengeValue: 100,
			estimatedSolveProbability: 0.4,
			confidence: 0,
			expectedRemainingMinutes: 10,
			environmentWaitMinutes: 0,
			agingBonus: 0,
			asOf: Date.now(),
		},
		platform: {},
	};
}

function environmentChallenge(exerciseId: number): ChallengeSnapshot {
	return {
		...challenge(exerciseId),
		environment: { required: true, status: "pending", endpoints: [] },
	};
}

function policy(flagFormat: ChallengeSnapshot["flagFormat"]): SubmissionPolicy {
	return { flagFormat, maxAttempts: 3, duplicateScope: "challenge", acceptedStatuses: ["correct"] };
}

function event(
	task: { taskId: string; assignmentId: string; solverId: string },
	type: CompetitionEvent["type"],
	payload: CompetitionEvent["payload"],
	eventId = `${type}-${Math.random()}`,
): CompetitionEvent {
	return {
		protocol: "secheur.competition/v1",
		version: 1,
		eventId,
		taskId: task.taskId,
		assignmentId: task.assignmentId,
		solverId: task.solverId,
		type,
		occurredAt: Date.now(),
		payload,
	};
}

describe("competition broker", () => {
	it("summarizes task metadata without returning solver payloads", () => {
		const task = {
			taskId: "fake:summary",
			assignmentId: "assignment",
			shortTask: "web summary",
			challenge: {
				...challenge(99),
				description: "A".repeat(1_000),
				attachments: [{ name: "challenge.zip", url: "http://example.test/challenge.zip?token=private" }],
			},
			submission: policy(challenge(99).flagFormat),
			policySnapshotId: "policy",
			status: "queued" as const,
			priority: 1,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			actualAttempts: 0,
		};
		const summary = summarizeCompetitionTask(task);
		expect(summary).toMatchObject({
			taskId: "fake:summary",
			name: "challenge-99",
			attachmentCount: 1,
			attachmentNames: ["challenge.zip"],
		});
		expect(summary.description).toHaveLength(194);
		expect(JSON.stringify(summary)).not.toContain("example.test");
	});

	it("switches adapters at runtime while preserving tasks and the active plan", async () => {
		const store = await CompetitionStore.open(":memory:");
		const makeAdapter = (platform: string): CompetitionPlatformAdapter => ({
			platform,
			getPolicy: async (): Promise<CompetitionPolicy> => ({
				flagFormat: challenge(1).flagFormat,
				submission: policy(challenge(1).flagFormat),
				maxEnvironmentSlots: 1,
				raw: {},
			}),
			listChallenges: async () => [],
			getChallenge: async (exerciseId): Promise<CompetitionChallenge> => ({
				...challenge(Number(exerciseId)),
				isOpen: true,
				hasSolved: false,
			}),
			startEnvironment: async () => ({ status: "ready", endpoints: [], leaseMetadata: {}, raw: {} }),
			getEnvironment: async () => ({ status: "ready", endpoints: [], leaseMetadata: {}, raw: {} }),
			submitFlag: async () => ({ isCorrect: false, requestPayload: {}, rawResponse: {} }),
			releaseEnvironment: async () => ({}),
		});
		const replacement = makeAdapter("ctfd");
		const broker = CompetitionBroker.from({
			store,
			adapter: makeAdapter("slab"),
			ownerId: "runtime-broker",
			reconfigureAdapter: async () => ({
				adapter: replacement,
				attachmentApi: new SlabAgentApi(),
				config: { platform: "ctfd", transport: "ctfd_api", baseUrl: "http://ctfd.test" },
				summary: {
					platform: "ctfd",
					transport: "ctfd_api",
					baseUrl: "http://ctfd.test",
					credentials: { accessKeyConfigured: false, apiTokenConfigured: true },
				},
			}),
		});
		try {
			broker.registerTask({
				taskId: "slab:1",
				shortTask: "preserved task",
				challenge: challenge(1),
				submission: policy(challenge(1).flagFormat),
				policySnapshotId: "policy",
				priority: 1,
			});
			broker.setPlan({ taskIds: ["slab:1"], rationale: "Keep the existing plan" });
			const configured = await broker.configureAdapter({ platform: "ctfd", transport: "ctfd_api" });
			expect(configured).toMatchObject({ changed: true, preservedTaskCount: 1, adapter: { platform: "ctfd" } });
			expect(broker.adapter.platform).toBe("ctfd");
			expect(broker.getPlan()?.orderedTaskIds).toEqual(["slab:1"]);
			expect(broker.listTasks()).toHaveLength(1);
			expect(broker.status()).toMatchObject({ platform: "ctfd", adapter: { transport: "ctfd_api" } });
		} finally {
			await broker.close();
			store.close();
		}
	});

	it("routes evidence-backed submissions, preserves idempotency, and blocks format errors locally", async () => {
		const store = await CompetitionStore.open(":memory:");
		const submitFlag = vi.fn(
			async (_exerciseId: string | number, flag: string): Promise<CompetitionSubmitResult> => ({
				isCorrect: flag === "FLAG{known}",
				status: flag === "FLAG{known}" ? "correct" : "incorrect",
				requestPayload: { challenge_id: _exerciseId, submission: flag },
				rawResponse: { status: flag === "FLAG{known}" ? "correct" : "incorrect" },
			}),
		);
		const releaseEnvironment = vi.fn(async () => ({}));
		const startEnvironment = vi.fn(async () => ({
			status: "ready" as const,
			endpoints: [{ host: "127.0.0.1", port: 31337 }],
			leaseMetadata: {},
			raw: {},
		}));
		const adapter: CompetitionPlatformAdapter = {
			platform: "fake",
			getPolicy: async (): Promise<CompetitionPolicy> => ({
				flagFormat: challenge(1).flagFormat,
				submission: policy(challenge(1).flagFormat),
				maxEnvironmentSlots: 1,
				raw: {},
			}),
			listChallenges: async () => [],
			getChallenge: async (exerciseId): Promise<CompetitionChallenge> => ({
				...challenge(Number(exerciseId)),
				isOpen: true,
				hasSolved: false,
			}),
			startEnvironment,
			getEnvironment: async () => ({ status: "ready", endpoints: [], leaseMetadata: {}, raw: {} }),
			submitFlag,
			releaseEnvironment,
		};
		const broker = CompetitionBroker.from({ store, adapter, ownerId: "broker-test" });
		try {
			broker.registerTask({
				taskId: "fake:1",
				shortTask: "web one",
				challenge: challenge(1),
				submission: policy(challenge(1).flagFormat),
				policySnapshotId: "policy",
				priority: 1,
			});
			broker.registerTask({
				taskId: "fake:claim",
				shortTask: "claim event",
				challenge: environmentChallenge(3),
				submission: policy(environmentChallenge(3).flagFormat),
				policySnapshotId: "policy",
				priority: 1,
			});
			const claimEvent: CompetitionEvent = {
				protocol: "secheur.competition/v1",
				version: 1,
				eventId: "claim-event-1",
				taskId: "fake:claim",
				assignmentId: "solver-provided-placeholder",
				solverId: "solver-event",
				type: "claim",
				occurredAt: Date.now(),
				payload: { taskId: "fake:claim" },
			};
			const eventClaim = await broker.handleEvent(claimEvent);
			expect(eventClaim.accepted).toBe(true);
			expect((eventClaim.task as { lease: { ownerId: string } }).lease.ownerId).toBe("solver-event");
			expect(startEnvironment).toHaveBeenCalledTimes(1);
			expect(store.getTask("fake:claim")?.challenge.environment.status).toBe("ready");
			const duplicateClaim = await broker.handleEvent(claimEvent);
			expect(duplicateClaim.duplicate).toBe(true);
			expect(startEnvironment).toHaveBeenCalledTimes(1);
			const claimed = await broker.claim("fake:1", "solver-1");
			const task = { taskId: claimed.taskId, assignmentId: claimed.assignmentId, solverId: "solver-1" };
			const evidence = event(task, "evidence", {
				evidenceId: "proof-1",
				kind: "local_exploit",
				summary: "The local exploit reproduces the controlled result.",
				source: "test-run",
				refs: ["test-run:1"],
				confidence: 0.8,
			});
			expect((await broker.handleEvent(evidence)).accepted).toBe(true);
			const accepted = await broker.handleEvent(
				event(task, "submit_request", {
					candidate: "FLAG{known}",
					evidenceRefs: ["proof-1"],
					confidence: 0.8,
					rationale: "The reproduced exploit returned the flag.",
				}),
			);
			expect(accepted.accepted).toBe(true);
			expect(submitFlag).toHaveBeenCalledTimes(1);
			expect(releaseEnvironment).toHaveBeenCalledTimes(1);
			expect(store.getTask("fake:1")?.status).toBe("solved");
			const staleBlocked = await broker.handleEvent(
				event(task, "blocked", { category: "solver", reason: "stale solver event" }),
			);
			expect(staleBlocked.accepted).toBe(true);
			expect(store.getTask("fake:1")?.status).toBe("solved");

			const duplicate = await broker.handleEvent(
				event(task, "submit_request", {
					candidate: "FLAG{known}",
					evidenceRefs: ["proof-1"],
					confidence: 0.8,
					rationale: "same candidate",
				}),
			);
			expect(submitFlag).toHaveBeenCalledTimes(1);
			expect((duplicate.result as { kind?: string } | undefined)?.kind).toBe("terminal");

			broker.registerTask({
				taskId: "fake:2",
				shortTask: "web two",
				challenge: challenge(2, "full"),
				submission: policy(challenge(2, "full").flagFormat),
				policySnapshotId: "policy",
				priority: 1,
			});
			const planResult = broker.setPlan({
				taskIds: ["fake:2", "fake:1"],
				rationale: "Solve the higher-confidence web primitive before the remaining challenge.",
				generatedBy: "main-agent",
			});
			expect(planResult.plan).toMatchObject({ revision: 1, orderedTaskIds: ["fake:2", "fake:1", "fake:claim"] });
			expect(broker.listTasks().find((task) => task.taskId === "fake:2")?.plan).toMatchObject({
				rank: 0,
				revision: 1,
			});
			const secondClaim = await broker.claim("fake:2", "solver-2");
			expect(secondClaim.plan).toMatchObject({ rank: 0, total: 3, revision: 1 });
			const secondTask = {
				taskId: secondClaim.taskId,
				assignmentId: secondClaim.assignmentId,
				solverId: "solver-2",
			};
			await broker.handleEvent(
				event(secondTask, "evidence", {
					evidenceId: "proof-2",
					kind: "observation",
					summary: "The candidate was read from a fixture.",
					source: "fixture",
					refs: ["fixture:1"],
				}),
			);
			const formatBlocked = await broker.handleEvent(
				event(secondTask, "submit_request", {
					candidate: "known",
					evidenceRefs: ["proof-2"],
					confidence: 0.2,
					rationale: "Fixture value",
				}),
			);
			expect(formatBlocked.accepted).toBe(false);
			expect(submitFlag).toHaveBeenCalledTimes(1);
			expect(store.listSubmissions("fake:2")[0]?.category).toBe("format_mismatch");
			const repeatedFormatBlocked = await broker.handleEvent(
				event(secondTask, "submit_request", {
					candidate: "known",
					evidenceRefs: ["proof-2"],
					confidence: 0.2,
					rationale: "same malformed candidate",
				}),
			);
			expect(repeatedFormatBlocked.accepted).toBe(false);
			expect(submitFlag).toHaveBeenCalledTimes(1);

			broker.registerTask({
				taskId: "fake:3",
				shortTask: "guessing guard",
				challenge: challenge(3),
				submission: policy(challenge(3).flagFormat),
				policySnapshotId: "policy",
				priority: 1,
			});
			const thirdClaim = await broker.claim("fake:3", "solver-3");
			const thirdTask = {
				taskId: thirdClaim.taskId,
				assignmentId: thirdClaim.assignmentId,
				solverId: "solver-3",
			};
			await broker.handleEvent(
				event(thirdTask, "evidence", {
					evidenceId: "proof-3",
					kind: "local_exploit",
					summary: "The wrong candidate is intentionally rejected by the fake platform.",
					source: "fixture",
					refs: ["fixture:3"],
					confidence: 0.8,
				}),
			);
			const firstIncorrect = await broker.handleEvent(
				event(thirdTask, "submit_request", {
					candidate: "FLAG{wrong}",
					evidenceRefs: ["proof-3"],
					confidence: 0.8,
					rationale: "First controlled rejection",
				}),
			);
			expect(firstIncorrect.accepted).toBe(false);
			const secondIncorrect = await broker.handleEvent(
				event(thirdTask, "submit_request", {
					candidate: "FLAG{wrong-two}",
					evidenceRefs: ["proof-3"],
					confidence: 0.8,
					rationale: "Different candidate without new evidence",
				}),
			);
			expect((secondIncorrect.audit as { verdict?: string }).verdict).toBe("guessing");
			expect(store.getTask("fake:3")?.status).toBe("blocked");
			expect(submitFlag).toHaveBeenCalledTimes(3);
			expect(() => encodeCbor(broker.status())).not.toThrow();
		} finally {
			await broker.close();
			store.close();
		}
	});

	it("preserves solved status reported by the challenge list when details omit it", async () => {
		const store = await CompetitionStore.open(":memory:");
		const getChallenge = vi.fn(async (exerciseId: string | number) => ({
			...challenge(Number(exerciseId)),
			isOpen: true,
			hasSolved: false,
		}));
		const adapter: CompetitionPlatformAdapter = {
			platform: "fake",
			getPolicy: async () => ({
				flagFormat: challenge(1).flagFormat,
				submission: policy(challenge(1).flagFormat),
				maxEnvironmentSlots: 1,
				raw: {},
			}),
			listChallenges: async () => [
				{ exerciseId: 1, name: "solved", category: "crypto", isOpen: true, hasSolved: true, score: 100, raw: {} },
				{ exerciseId: 2, name: "queued", category: "crypto", isOpen: true, hasSolved: false, score: 100, raw: {} },
			],
			getChallenge,
			startEnvironment: async () => ({ status: "pending", endpoints: [], leaseMetadata: {}, raw: {} }),
			getEnvironment: async () => ({ status: "pending", endpoints: [], leaseMetadata: {}, raw: {} }),
			submitFlag: async () => ({ isCorrect: false, requestPayload: {}, rawResponse: {} }),
			releaseEnvironment: async () => ({}),
		};
		const broker = CompetitionBroker.from({ store, adapter, ownerId: "sync-test" });
		try {
			await expect(broker.sync()).resolves.toMatchObject({ listed: 2, snapshotted: 2, failedDetails: [] });
			expect(getChallenge).toHaveBeenCalledTimes(2);
			expect(store.getTask("fake:1")?.status).toBe("solved");
			expect(store.getTask("fake:2")?.status).toBe("queued");
		} finally {
			await broker.close();
			store.close();
		}
	});
});
