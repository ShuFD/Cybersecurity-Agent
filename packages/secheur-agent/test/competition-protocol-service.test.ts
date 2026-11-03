import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
	CompetitionChallenge,
	CompetitionPlatformAdapter,
	CompetitionPolicy,
} from "../src/competition-adapters.ts";
import { CompetitionBroker } from "../src/competition-broker.ts";
import type { ChallengeSnapshot } from "../src/competition-protocol.ts";
import { CompetitionBrokerClient, CompetitionBrokerServer } from "../src/competition-protocol-service.ts";
import { CompetitionCoordinatorBinding, CompetitionSolverBinding } from "../src/competition-solver.ts";
import { CompetitionStore } from "../src/competition-store.ts";

const challenge: ChallengeSnapshot = {
	exerciseId: 1,
	name: "socket-test",
	category: "misc",
	description: "socket test",
	hints: [],
	flagFormat: { prefix: "", suffix: "", accepts: "either", submit: "full" },
	attachments: [],
	environment: { required: false, status: "none", endpoints: [] },
	scoring: {
		currentScore: 1,
		challengeValue: 1,
		estimatedSolveProbability: 0.2,
		confidence: 0,
		expectedRemainingMinutes: 1,
		environmentWaitMinutes: 0,
		agingBonus: 0,
		asOf: Date.now(),
	},
	platform: {},
};

describe("competition Unix broker", () => {
	it("performs the handshake, correlates requests, and reconnects", async () => {
		const root = await mkdtemp(join(tmpdir(), "secheur-competition-socket-"));
		const store = await CompetitionStore.open(join(root, "competition.sqlite"));
		const adapter: CompetitionPlatformAdapter = {
			platform: "socket-test",
			getPolicy: async (): Promise<CompetitionPolicy> => ({
				flagFormat: challenge.flagFormat,
				submission: {
					flagFormat: challenge.flagFormat,
					maxAttempts: 1,
					duplicateScope: "task",
					acceptedStatuses: ["correct"],
				},
				maxEnvironmentSlots: 1,
				raw: {},
			}),
			listChallenges: async () => [],
			getChallenge: async (): Promise<CompetitionChallenge> => ({ ...challenge, isOpen: true, hasSolved: false }),
			startEnvironment: async () => ({ status: "ready", endpoints: [], leaseMetadata: {}, raw: {} }),
			getEnvironment: async () => ({ status: "ready", endpoints: [], leaseMetadata: {}, raw: {} }),
			submitFlag: async () => ({ isCorrect: true, requestPayload: {}, rawResponse: {} }),
			releaseEnvironment: async () => ({}),
		};
		const broker = CompetitionBroker.from({ store, adapter, ownerId: "socket-broker" });
		const server = new CompetitionBrokerServer({ broker, socketPath: join(root, "competition.sock") });
		const client = new CompetitionBrokerClient({
			socketPath: join(root, "competition.sock"),
			clientId: "socket-client",
		});
		try {
			await server.start();
			if (process.platform !== "win32") expect(statSync(join(root, "competition.sock")).mode & 0o777).toBe(0o660);
			// The bridge issues status, task, and plan requests concurrently during
			// startup. All of them must wait for the same hello handshake.
			const [status, tasks, plan] = await Promise.all([
				client.request("status"),
				client.request("list_tasks"),
				client.request("get_plan"),
			]);
			expect(status).toMatchObject({ ok: true, platform: "socket-test" });
			expect(tasks).toEqual([]);
			expect(plan).toMatchObject({ plan: null, tasks: [] });
			client.close();
			await client.connect();
			expect(await client.request("list_tasks")).toEqual([]);
		} finally {
			client.close();
			await server.close();
			await broker.close();
			store.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("lets the coordinator persist a plan that the solver receives over CBOR", async () => {
		const root = await mkdtemp(join(tmpdir(), "secheur-competition-plan-"));
		const store = await CompetitionStore.open(join(root, "competition.sqlite"));
		const adapter: CompetitionPlatformAdapter = {
			platform: "plan-test",
			getPolicy: async (): Promise<CompetitionPolicy> => ({
				flagFormat: challenge.flagFormat,
				submission: {
					flagFormat: challenge.flagFormat,
					maxAttempts: 1,
					duplicateScope: "task",
					acceptedStatuses: ["correct"],
				},
				maxEnvironmentSlots: 1,
				raw: {},
			}),
			listChallenges: async () => [],
			getChallenge: async (): Promise<CompetitionChallenge> => ({ ...challenge, isOpen: true, hasSolved: false }),
			startEnvironment: async () => ({ status: "ready", endpoints: [], leaseMetadata: {}, raw: {} }),
			getEnvironment: async () => ({ status: "ready", endpoints: [], leaseMetadata: {}, raw: {} }),
			submitFlag: async () => ({ isCorrect: true, requestPayload: {}, rawResponse: {} }),
			releaseEnvironment: async () => ({}),
		};
		const broker = CompetitionBroker.from({ store, adapter, ownerId: "plan-broker" });
		broker.registerTask({
			taskId: "plan-test:1",
			shortTask: "first",
			challenge: { ...challenge, exerciseId: 1 },
			submission: {
				flagFormat: challenge.flagFormat,
				maxAttempts: 1,
				duplicateScope: "task",
				acceptedStatuses: ["correct"],
			},
			policySnapshotId: "policy",
			priority: 1,
		});
		broker.registerTask({
			taskId: "plan-test:2",
			shortTask: "second",
			challenge: { ...challenge, exerciseId: 2 },
			submission: {
				flagFormat: challenge.flagFormat,
				maxAttempts: 1,
				duplicateScope: "task",
				acceptedStatuses: ["correct"],
			},
			policySnapshotId: "policy",
			priority: 1,
		});
		const server = new CompetitionBrokerServer({ broker, socketPath: join(root, "competition.sock") });
		const coordinator = new CompetitionCoordinatorBinding({
			socketPath: join(root, "competition.sock"),
			clientId: "test-coordinator",
		});
		const solver = new CompetitionSolverBinding({
			socketPath: join(root, "competition.sock"),
			taskId: "plan-test:2",
			solverId: "solver-2",
		});
		try {
			await server.start();
			const planned = await coordinator.setPlan({
				taskIds: ["plan-test:2", "plan-test:1"],
				rationale: "Run the second challenge first.",
			});
			expect(planned.plan.revision).toBe(1);
			store.setTaskStatus("plan-test:1", "stopped", "previous solver stopped");
			const requeued = await coordinator.requeueTasks(["plan-test:1"], "resume from coordinator");
			expect(requeued.previousStatuses).toEqual({ "plan-test:1": "stopped" });
			expect(requeued.tasks[0]).toMatchObject({ taskId: "plan-test:1", status: "queued" });
			const envelope = await solver.claim();
			expect(envelope).toMatchObject({
				taskId: "plan-test:2",
				plan: { rank: 0, total: 2, revision: 1 },
			});
			expect(
				(
					await solver.sendEvent("evidence", {
						evidenceId: "socket-proof",
						kind: "local_exploit",
						summary: "The solver reproduced the challenge result through the protocol.",
						source: "socket-test",
						refs: ["socket-test:proof"],
						confidence: 0.8,
					})
				).accepted,
			).toBe(true);
			const submitted = await solver.sendEvent("submit_request", {
				candidate: "socket-flag",
				evidenceRefs: ["socket-proof"],
				confidence: 0.8,
				rationale: "The protocol evidence supports this candidate.",
			});
			expect(submitted.accepted).toBe(true);
			expect(store.getTask("plan-test:2")?.status).toBe("solved");
		} finally {
			solver.close();
			coordinator.close();
			await server.close();
			await broker.close();
			store.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
