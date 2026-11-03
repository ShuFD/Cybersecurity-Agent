/** Regression tests ported from CairnPilot b015733 (Apache-2.0). */

import { afterEach, describe, expect, test, vi } from "vitest";
import { cairnTestIO } from "./fixtures/cairn-test-io.ts";

const mock = vi.fn;

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REASON_PROMPT_VERSION } from "../src/planning/cairn/reason-prompt.ts";
import { GraphReasoner } from "../src/planning/cairn/reasoner.ts";
import { recoverManagedProposal } from "../src/planning/cairn/recovery-proposal.ts";
import { GraphService } from "../src/planning/cairn/service.ts";
import { GraphStore } from "../src/planning/cairn/store.ts";
import type { ReasonModel, ReasonModelOutput } from "../src/planning/cairn/types.ts";
import { ProposalOutputError } from "../src/planning/proposal-json.ts";

const directories: string[] = [];
const timestamp = "2026-06-15T00:00:00.000Z";

function output(overrides: Record<string, unknown> = {}): ReasonModelOutput {
	return {
		model: "fake-model",
		provider: "fake-provider",
		text: JSON.stringify({
			rationaleSummary: "test the highest value route",
			proposedIntents: [
				{
					clientId: "route-a",
					objective: "verify the exposed route",
					successCriteria: ["obtain reproducible evidence"],
					rationale: "directly follows current evidence",
					fromFactIds: [],
					sourceHintIds: [],
					capabilityTags: ["web"],
					priority: 10,
					supersedesIntentIds: [],
				},
			],
			supersedeRecommendations: [],
			...overrides,
		}),
	};
}

async function setup(nowRef = { value: Date.parse(timestamp) }) {
	const directory = await mkdtemp(join(tmpdir(), "cairnpilot-reasoner-"));
	directories.push(directory);
	const path = join(directory, "graph.db");
	const store = new GraphStore(path);
	store.initialize();
	const service = new GraphService(store, {
		reasonerEnabled: true,
		leaseTokenSecret: "external-test-secret",
		clock: { now: () => new Date(nowRef.value) },
	});
	return { directory, path, store, service, nowRef };
}

function reasoner(service: GraphService, model: ReasonModel, runId = "run-a", timeoutMs = 1_000) {
	return new GraphReasoner({
		service,
		model,
		runIdFactory: () => runId,
		timeoutMs,
		clock: { now: () => new Date(timestamp) },
	});
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })),
	);
});

describe("GraphReasoner", () => {
	test("consumes routine covered work without another provider call or new intent", async () => {
		const { store, service } = await setup();
		service.ensureReasonTriggerForChallenge("covered-work");
		const generate = vi.fn(async () => output());
		const onPreservedWork = vi.fn();
		try {
			const worker = new GraphReasoner({
				service,
				model: { generate },
				reasonApplyEnabled: true,
				preserveDraft: () => ({
					rationaleSummary: "Live owners cover work",
					proposedIntents: [],
					supersedeRecommendations: [],
				}),
				onPreservedWork,
				clock: { now: () => new Date(timestamp) },
			});
			expect((await worker.runOnce("covered-work")).status).toBe("proposed");
			expect(generate).not.toHaveBeenCalled();
			expect(onPreservedWork).toHaveBeenCalledOnce();
			expect(store.readServiceGraph("covered-work").intents).toHaveLength(0);
			expect((await worker.runOnce("covered-work")).status).toBe("idle");
		} finally {
			store.close();
		}
	});
	test.each([false, true])(
		"keeps failed planning pending without inventing whole-goal tasks after two corrections (bad submission=%s)",
		async (badSubmission) => {
			const { store, service } = await setup();
			const actor = { id: "host", role: "host" as const, challengeId: "recovery-fixture" };
			const candidate = service.proposeFact({
				actor,
				idempotencyKey: "goal",
				createdAt: timestamp,
				kind: "goal",
				statement: "Complete a local fixture",
				confidence: 1,
			});
			service.confirmFact({ actor, idempotencyKey: "confirm", createdAt: timestamp, candidateId: candidate.id });
			const generate = vi.fn(async () => {
				const result = { ...output(), text: "broken JSON" };
				if (badSubmission) throw new ProposalOutputError("Expected exactly one data submission", result);
				return result;
			});
			const onCorrection = vi.fn();
			try {
				const worker = new GraphReasoner({
					service,
					model: { generate },
					correctionAttempts: 2,
					reasonApplyEnabled: true,
					recoverDraft: (context) => recoverManagedProposal(context, 2),
					onCorrection,
					clock: { now: () => new Date(timestamp) },
				});
				expect((await worker.runOnce(actor.challengeId)).status).toBe("failed");
				expect(generate).toHaveBeenCalledTimes(3);
				expect(store.readServiceGraph(actor.challengeId).intents).toHaveLength(0);
				expect(
					service.readReasonTriggers(actor.challengeId).every((trigger) => trigger.status === "completed"),
				).toBe(false);
				expect(onCorrection.mock.calls.some(([value]) => value.recovered === true)).toBe(false);
				expect((await worker.runOnce(actor.challengeId)).status).toBe("idle");
				expect(generate).toHaveBeenCalledTimes(3);
			} finally {
				store.close();
			}
		},
	);
	test("does not turn a provider failure into a fallback plan", async () => {
		const { store, service } = await setup();
		service.ensureReasonTriggerForChallenge("provider-fixture");
		const recovery = vi.fn();
		try {
			const result = await new GraphReasoner({
				service,
				model: {
					generate: async () => {
						throw new Error("HTTP 503");
					},
				},
				correctionAttempts: 2,
				recoverDraft: recovery,
			}).runOnce("provider-fixture");
			expect(result.status).toBe("failed");
			expect(recovery).not.toHaveBeenCalled();
			expect(store.readServiceGraph("provider-fixture").intents).toEqual([]);
		} finally {
			store.close();
		}
	});
	test("renews a managed model lease across its original expiry and clears heartbeat on settlement", async () => {
		const nowRef = { value: Date.parse(timestamp) };
		const { store, service } = await setup(nowRef);
		service.ensureReasonTriggerForChallenge("heartbeat-fixture");
		const heartbeat = vi.spyOn(service, "heartbeatReasonLease");
		let finish!: (value: ReasonModelOutput) => void;
		const pending = new Promise<ReasonModelOutput>((resolve) => {
			finish = resolve;
		});
		vi.useFakeTimers();
		try {
			const run = new GraphReasoner({
				service,
				model: { generate: async () => pending },
				timeoutMs: 0,
				clock: { now: () => new Date(nowRef.value) },
			}).runOnce("heartbeat-fixture");
			for (let i = 0; i < 4; i++) {
				nowRef.value += 40_000;
				await vi.advanceTimersByTimeAsync(40_000);
				service.expireReasonLeases();
			}
			expect(heartbeat).toHaveBeenCalledTimes(4);
			finish(output());
			expect((await run).status).toBe("proposed");
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
			heartbeat.mockRestore();
			store.close();
		}
	});
	test("does not acquire a lease or call the model when the outer signal was already cancelled", async () => {
		const { store, service } = await setup();
		const generate = vi.fn(async () => output());
		const control = new AbortController();
		const reason = new Error("Outer cancelled before reasoning");
		control.abort(reason);
		try {
			await expect(
				new GraphReasoner({ service, model: { generate } }).runOnce("cancelled-fixture", control.signal),
			).rejects.toBe(reason);
			expect(generate).not.toHaveBeenCalled();
		} finally {
			store.close();
		}
	});
	test("corrects unsupported scheduling requirements before any Intent is persisted", async () => {
		const { store, service } = await setup();
		service.ensureReasonTriggerForChallenge("tags-fixture");
		const fixed = JSON.parse(output().text) as { proposedIntents: Array<{ capabilityTags: string[] }> };
		fixed.proposedIntents[0].capabilityTags = [];
		const generate = vi
			.fn<ReasonModel["generate"]>()
			.mockResolvedValueOnce(output())
			.mockResolvedValueOnce({ ...output(), text: JSON.stringify(fixed) });
		try {
			const result = await new GraphReasoner({
				service,
				model: { generate },
				reasonApplyEnabled: true,
				correctionAttempts: 2,
				clock: { now: () => new Date(timestamp) },
				validateDraft: (draft) =>
					draft.proposedIntents.some((i) => i.capabilityTags.length)
						? ["no_compatible_profile: use capabilityTags: []"]
						: [],
			}).runOnce("tags-fixture");
			expect(result.status).toBe("proposed");
			expect(generate).toHaveBeenCalledTimes(2);
			expect(generate.mock.calls[1][0].prompt).toContain("no_compatible_profile");
			expect(store.readServiceGraph("tags-fixture").intents[0].capabilityTags).toEqual([]);
		} finally {
			store.close();
		}
	});
	test("accepts a no-op while existing Solvers work instead of forcing duplicate Intents", async () => {
		const { store, service } = await setup();
		service.ensureReasonTriggerForChallenge("noop-fixture");
		const generate = vi.fn(async () => output({ proposedIntents: [] }));
		try {
			const result = await new GraphReasoner({
				service,
				model: { generate },
				reasonApplyEnabled: true,
				correctionAttempts: 2,
				allowNoopProposal: () => true,
				clock: { now: () => new Date(timestamp) },
			}).runOnce("noop-fixture");
			expect(result.status).toBe("proposed");
			expect(generate).toHaveBeenCalledOnce();
			expect(store.readServiceGraph("noop-fixture").intents).toEqual([]);
		} finally {
			store.close();
		}
	});
	test("feeds parse errors back within the same lease and persists only the corrected proposal", async () => {
		const { store, service } = await setup();
		service.ensureReasonTriggerForChallenge("challenge-a");
		const generate = mock<ReasonModel["generate"]>(async () => output());
		generate.mockResolvedValueOnce({ ...output(), text: "not-json" });
		const result = await new GraphReasoner({
			service,
			model: { generate },
			correctionAttempts: 2,
			clock: { now: () => new Date(timestamp) },
		}).runOnce("challenge-a");
		expect(result.status).toBe("proposed");
		expect(generate).toHaveBeenCalledTimes(2);
		expect(generate.mock.calls[1][0].prompt).toContain("Validation error: model output is not valid JSON");
		expect(service.listReasonProposals("challenge-a")).toHaveLength(1);
		store.close();
	});
	test("accepts one complete fenced JSON proposal but never repairs an incomplete document", async () => {
		const { store, service } = await setup();
		service.ensureReasonTriggerForChallenge("challenge-a");
		const result = await reasoner(service, {
			generate: async () => ({ ...output(), text: "```json\n" + output().text + "\n```" }),
		}).runOnce("challenge-a");
		expect(result.status).toBe("proposed");
		store.close();
	});
	test("persists a valid Proposal, completes Trigger atomically, and restores it after reopen", async () => {
		const { path, store, service } = await setup();
		service.ensureReasonTriggerForChallenge("challenge-a");
		const model = { generate: mock(async () => output()) };
		const result = await reasoner(service, model).runOnce("challenge-a");
		expect(result.status).toBe("proposed");
		const proposal = service.listReasonProposals("challenge-a")[0];
		expect(proposal).toMatchObject({ status: "proposed", promptVersion: REASON_PROMPT_VERSION, model: "fake-model" });
		expect(service.readReasonTriggers("challenge-a")[0].status).toBe("completed");
		expect(service.getFocusedContext("challenge-a", 0).intents).toEqual([]);
		store.close();

		const reopened = new GraphStore(path);
		reopened.initialize();
		expect(reopened.readReasonProposal("challenge-a", proposal.id)).toEqual(proposal);
		reopened.close();
	});

	test("replays Proposal persistence idempotently and rejects a conflicting payload", async () => {
		const { path, store, service } = await setup();
		service.ensureReasonTriggerForChallenge("challenge-a");
		const actor = { id: "host", role: "host" as const, challengeId: "challenge-a" };
		const acquired = service.acquireReasonLease({
			actor,
			idempotencyKey: "proposal-lease",
			createdAt: timestamp,
			ownerId: "host",
			leaseDurationMs: 120_000,
		});
		const claimed = service.claimReasonTriggers({
			actor,
			idempotencyKey: "proposal-claim",
			createdAt: timestamp,
			ownerId: acquired.ownerId,
			generation: acquired.generation,
			token: acquired.token,
		});
		const context = service.getReasonContext({
			actor,
			ownerId: acquired.ownerId,
			generation: acquired.generation,
			token: acquired.token,
			triggerIds: claimed.map((trigger) => trigger.id),
		});
		const parsed = JSON.parse(output().text);
		const input = {
			actor,
			idempotencyKey: "proposal-create",
			createdAt: timestamp,
			ownerId: acquired.ownerId,
			generation: acquired.generation,
			token: acquired.token,
			sourceTriggerIds: claimed.map((trigger) => trigger.id),
			baseEventSequence: context.context.baseEventSequence,
			contextFingerprint: context.fingerprint,
			model: "fake-model",
			provider: "fake-provider",
			promptVersion: "reason-v1",
			...parsed,
		};
		const first = service.createReasonProposal(input);
		expect(service.createReasonProposal(input)).toEqual(first);
		expect(() => service.createReasonProposal({ ...input, rationaleSummary: "different" })).toThrow(
			"idempotency key conflict",
		);
		expect(service.listReasonProposals("challenge-a")).toHaveLength(1);
		const events = store.readEventsAfter("challenge-a", 0);
		expect(events.filter((event) => event.type === "reason_proposal_created")).toHaveLength(1);
		expect(JSON.stringify(events)).not.toContain(acquired.token);
		store.close();
		expect(Buffer.from(await cairnTestIO.file(path).arrayBuffer()).includes(Buffer.from(acquired.token))).toBe(false);
	});

	test("retries non-JSON, oversized, exceptional, and timed-out model output without Proposal", async () => {
		for (const [suffix, model, timeoutMs] of [
			["json", { generate: async () => ({ ...output(), text: "not-json" }) }, 1_000],
			["large", { generate: async () => ({ ...output(), text: "x".repeat(65_537) }) }, 1_000],
			[
				"error",
				{
					generate: async () => {
						throw new Error("provider failed");
					},
				},
				1_000,
			],
			[
				"timeout",
				{
					generate: async (_input: unknown, signal: AbortSignal) =>
						new Promise<ReasonModelOutput>((_, reject) => {
							signal.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")), {
								once: true,
							});
						}),
				},
				5,
			],
		] as const) {
			const { store, service } = await setup();
			service.ensureReasonTriggerForChallenge(`challenge-${suffix}`);
			const result = await reasoner(service, model as ReasonModel, `run-${suffix}`, timeoutMs).runOnce(
				`challenge-${suffix}`,
			);
			expect(result.status).toBe("failed");
			expect(service.listReasonProposals(`challenge-${suffix}`)).toEqual([]);
			expect(service.readReasonTriggers(`challenge-${suffix}`)[0]).toMatchObject({
				status: "pending",
				attemptCount: 1,
			});
			store.close();
		}
	});

	test("persists parsed domain-invalid output as rejected and does not create an Intent", async () => {
		const { store, service } = await setup();
		service.ensureReasonTriggerForChallenge("challenge-a");
		const invalid = output({
			proposedIntents: [
				{
					clientId: "duplicate",
					objective: "",
					successCriteria: [],
					rationale: "",
					fromFactIds: ["foreign-fact"],
					sourceHintIds: [],
					capabilityTags: [],
					priority: 1,
					supersedesIntentIds: [],
				},
				{
					clientId: "duplicate",
					objective: "second",
					successCriteria: [],
					rationale: "",
					fromFactIds: [],
					sourceHintIds: [],
					capabilityTags: [],
					priority: 1,
					supersedesIntentIds: [],
				},
			],
		});
		const result = await reasoner(service, { generate: async () => invalid }).runOnce("challenge-a");
		expect(result.status).toBe("rejected");
		const proposal = service.listReasonProposals("challenge-a")[0];
		expect(proposal.status).toBe("rejected");
		expect(proposal.validationErrors).toContain("clientId must be unique");
		expect(proposal.proposedIntents).toHaveLength(2);
		expect(service.readReasonTriggers("challenge-a")[0].status).toBe("completed");
		expect(service.getFocusedContext("challenge-a", 0).intents).toEqual([]);
		store.close();
	});

	test("rolls back Proposal when Trigger completion fails", async () => {
		const { store, service } = await setup();
		service.ensureReasonTriggerForChallenge("challenge-a");
		const original = store.completeReasonTriggerRows.bind(store);
		store.completeReasonTriggerRows = () => {
			throw new Error("completion failed");
		};
		const result = await reasoner(service, { generate: async () => output() }).runOnce("challenge-a");
		store.completeReasonTriggerRows = original;
		expect(result.status).toBe("failed");
		expect(service.listReasonProposals("challenge-a")).toEqual([]);
		expect(service.readReasonTriggers("challenge-a")[0].status).toBe("pending");
		store.close();
	});

	test("rejects late responses after Lease expiry or Challenge completion", async () => {
		for (const mode of ["expired", "completed"] as const) {
			const nowRef = { value: Date.parse(timestamp) };
			const { store, service } = await setup(nowRef);
			const challengeId = `challenge-${mode}`;
			service.ensureReasonTriggerForChallenge(challengeId);
			let resolve!: (value: ReasonModelOutput) => void;
			const pending = new Promise<ReasonModelOutput>((done) => {
				resolve = done;
			});
			const run = reasoner(service, { generate: async () => pending }, `run-${mode}`).runOnce(challengeId);
			await cairnTestIO.sleep(10);
			if (mode === "expired") {
				nowRef.value += 121_000;
				service.expireReasonLeases();
			} else {
				store.executeServiceTransaction(() =>
					store.markChallengeCompleted(challengeId, new Date(nowRef.value).toISOString()),
				);
			}
			resolve(output());
			expect((await run).status).toBe("failed");
			expect(service.listReasonProposals(challengeId)).toEqual([]);
			store.close();
		}
	});

	test("does not overlap one Challenge while allowing independent Challenges", async () => {
		const { store, service } = await setup();
		service.ensureReasonTriggerForChallenge("challenge-a");
		service.ensureReasonTriggerForChallenge("challenge-b");
		const resolves: Array<(value: ReasonModelOutput) => void> = [];
		const model = {
			generate: mock(async () => new Promise<ReasonModelOutput>((resolve) => resolves.push(resolve))),
		};
		let next = 0;
		const instance = new GraphReasoner({
			service,
			model,
			runIdFactory: () => `run-${++next}`,
			clock: { now: () => new Date(timestamp) },
		});
		const first = instance.runOnce("challenge-a");
		await cairnTestIO.sleep(5);
		expect(await instance.runOnce("challenge-a")).toEqual({ status: "busy" });
		const second = instance.runOnce("challenge-b");
		await cairnTestIO.sleep(5);
		expect(model.generate).toHaveBeenCalledTimes(2);
		for (const resolve of resolves) resolve(output());
		expect((await first).status).toBe("proposed");
		expect((await second).status).toBe("proposed");
		store.close();
	});

	test("abortAll prevents a pending model response from being persisted", async () => {
		const { store, service } = await setup();
		service.ensureReasonTriggerForChallenge("challenge-a");
		let resolve!: (value: ReasonModelOutput) => void;
		const pending = new Promise<ReasonModelOutput>((done) => {
			resolve = done;
		});
		const instance = reasoner(service, { generate: async () => pending });
		const run = instance.runOnce("challenge-a");
		await cairnTestIO.sleep(5);
		instance.abortAll();
		resolve(output());
		expect((await run).status).toBe("failed");
		expect(service.listReasonProposals("challenge-a")).toEqual([]);
		expect(service.readReasonTriggers("challenge-a")[0]).toMatchObject({ status: "pending", attemptCount: 0 });
		store.close();
	});
});
