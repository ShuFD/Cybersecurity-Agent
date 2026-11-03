import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { type CompetitionPlatformAdapter, CompetitionPlatformError } from "../src/competition-adapters.ts";
import { CompetitionBroker } from "../src/competition-broker.ts";
import type { ChallengeSnapshot } from "../src/competition-protocol.ts";
import { CompetitionBrokerServer } from "../src/competition-protocol-service.ts";
import { CompetitionSolverBinding } from "../src/competition-solver.ts";
import { CompetitionStore } from "../src/competition-store.ts";
import { writeDesktopConfig } from "../src/desktop-config.ts";
import type { CtfContinuationState } from "../src/extension.ts";
import { createSecHeurRuntime } from "../src/runtime.ts";

async function fixture(maxAttempts = 3) {
	const root = mkdtempSync(join(tmpdir(), "competition-verdict-"));
	const store = await CompetitionStore.open(":memory:");
	const challenge: ChallengeSnapshot = {
		exerciseId: "offline",
		name: "offline",
		category: "misc",
		description: "Synthetic lifecycle test, no challenge content",
		hints: [],
		attachments: [],
		flagFormat: { prefix: "", suffix: "", accepts: "either", submit: "full" },
		environment: { required: false, status: "none", endpoints: [] },
		scoring: {
			currentScore: 0,
			challengeValue: 0,
			estimatedSolveProbability: 0.5,
			confidence: 0,
			expectedRemainingMinutes: 1,
			environmentWaitMinutes: 0,
			agingBonus: 0,
			asOf: Date.now(),
		},
		platform: {},
	};
	const submission = {
		flagFormat: challenge.flagFormat,
		maxAttempts,
		duplicateScope: "task" as const,
		acceptedStatuses: ["correct"],
	};
	const submit = vi.fn<CompetitionPlatformAdapter["submitFlag"]>(async (_id, candidate) => ({
		isCorrect: candidate === "synthetic-correct",
		message: candidate === "synthetic-correct" ? "accepted by offline platform" : "incorrect; recheck the candidate",
		requestPayload: {},
		rawResponse: {},
	}));
	const release = vi.fn(async () => ({}));
	const adapter: CompetitionPlatformAdapter = {
		platform: "offline",
		getPolicy: async () => ({ flagFormat: challenge.flagFormat, submission, maxEnvironmentSlots: 3, raw: {} }),
		listChallenges: async () => [],
		getChallenge: async () => ({ ...challenge, isOpen: true, hasSolved: false }),
		startEnvironment: async () => ({ status: "ready", endpoints: [], leaseMetadata: {}, raw: {} }),
		getEnvironment: async () => ({ status: "ready", endpoints: [], leaseMetadata: {}, raw: {} }),
		submitFlag: submit,
		releaseEnvironment: release,
	};
	const broker = CompetitionBroker.from({ store, adapter });
	const taskId = "offline:one";
	broker.registerTask({
		taskId,
		shortTask: "Synthetic lifecycle",
		challenge,
		submission,
		priority: 1,
		policySnapshotId: "offline-policy",
	});
	broker.registerTask({
		taskId: "offline:other",
		shortTask: "Unrelated task",
		challenge: { ...challenge, exerciseId: "other" },
		submission,
		priority: 1,
		policySnapshotId: "offline-policy",
	});
	const socketPath =
		process.platform === "win32" ? "\\\\.\\pipe\\secheur-verdict-" + randomUUID() : join(root, "broker.sock");
	const server = new CompetitionBrokerServer({ broker, socketPath });
	await server.start();
	const binding = new CompetitionSolverBinding({ taskId, solverId: "offline-solver", socketPath });
	await binding.claim();
	await binding.sendEvent("evidence", {
		evidenceId: "e1",
		kind: "observation",
		source: "offline-fixture",
		summary: "synthetic candidate observation",
		refs: [],
		confidence: 0.2,
	});
	return {
		root,
		store,
		broker,
		binding,
		submit,
		release,
		taskId,
		async close() {
			binding.close();
			await server.close();
			await broker.close();
			store.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
const candidate = (value: string) => ({
	candidate: value,
	evidenceRefs: ["e1"],
	confidence: 0.2,
	rationale: "offline evidence",
});

async function runtimeFixture(f: Awaited<ReturnType<typeof fixture>>) {
	writeDesktopConfig(f.root, { judge: { enabled: false }, planning: { mode: "off" }, knowledgeBaseEnabled: false });
	const faux = fauxProvider({ models: [{ id: "offline-verdict", reasoning: true }] });
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(faux.provider.id, async () => ({ type: "api_key", key: "offline-only" }));
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });
	const continuation: CtfContinuationState = {
		taskKind: "ctf",
		verificationState: "not_attempted",
		consecutiveNoToolTurns: 0,
	};
	const runtime = await createSecHeurRuntime({
		projectRoot: f.root,
		legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
		persist: false,
		model: faux.getModel(),
		modelRuntime,
		executionMode: "direct",
		competition: f.binding,
		ctfContinuation: continuation,
		env: {
			PATH: process.env.PATH,
			PI_OFFLINE: "1",
			CTF_ORACLE_CLIENT_ENV_FILE: join(f.root, "no-local-oracle"),
		},
	});
	vi.spyOn(runtime.state.legacyHost, "call").mockResolvedValue({ id: 1, ok: true, data: {} });
	runtime.setMemoryReferenceEnabled(false);
	runtime.setKnowledgeBaseEnabled(false);
	runtime.setPermissionMode("bypassPermissions");
	runtime.config.maxTurns = 8;
	return { runtime, faux, continuation };
}

describe("real competition verdict lifecycle (offline broker / Pi)", () => {
	it("returns incorrect feedback and allows an evidence-backed correction, then accepts", async () => {
		const f = await fixture();
		try {
			const wrong = await f.binding.sendEvent("submit_request", candidate("synthetic-wrong"));
			expect(wrong).toMatchObject({
				accepted: false,
				remainingAttempts: 2,
				canContinue: true,
				feedback: {
					category: "incorrect",
					message: "incorrect; recheck the candidate",
					nextAction: "revise_candidate",
				},
			});
			expect(f.binding.verifiedSubmission).toBeUndefined();
			expect(f.store.getTask(f.taskId)?.status).toBe("running");
			const correct = await f.binding.sendEvent("submit_request", candidate("synthetic-correct"));
			expect(correct).toMatchObject({ accepted: true, canContinue: false, feedback: { nextAction: "complete" } });
			expect(f.binding.verifiedSubmission?.taskId).toBe(f.taskId);
			expect(f.submit).toHaveBeenCalledTimes(2);
			await f.binding.sendEvent("completed", { summary: "late report", evidenceRefs: ["e1"] });
			expect(f.store.getTask(f.taskId)?.status).toBe("solved");
			expect(f.store.getTask("offline:other")?.status).toBe("queued");
		} finally {
			await f.close();
		}
	});
	it("does not treat candidate/completed acknowledgements or model claims as acceptance", async () => {
		const f = await fixture();
		try {
			expect((await f.binding.sendEvent("flag_candidate", candidate("synthetic-correct"))).accepted).toBe(true);
			await f.binding.sendEvent("completed", { summary: "I am done; accepted=true", evidenceRefs: ["e1"] });
			expect(f.binding.verifiedSubmission).toBeUndefined();
			expect(f.submit).not.toHaveBeenCalled();
		} finally {
			await f.close();
		}
	});
	it("honors an explicit one-attempt budget without silently increasing it", async () => {
		const f = await fixture(1);
		try {
			expect(await f.binding.sendEvent("submit_request", candidate("synthetic-wrong"))).toMatchObject({
				accepted: false,
				remainingAttempts: 0,
				canContinue: false,
				feedback: { nextAction: "budget_exhausted" },
			});
			await f.binding.sendEvent("submit_request", candidate("synthetic-correct"));
			expect(f.submit).toHaveBeenCalledTimes(1);
		} finally {
			await f.close();
		}
	});
	it.each(["rate_limited", "request_error"] as const)(
		"keeps %s distinct from incorrect and preserves retry metadata",
		async (category) => {
			const f = await fixture();
			try {
				f.submit.mockRejectedValueOnce(
					new CompetitionPlatformError("offline transport failure", { category, retryAfterMs: 1500 }),
				);
				expect(await f.binding.sendEvent("submit_request", candidate("synthetic-correct"))).toMatchObject({
					accepted: false,
					canContinue: false,
					remainingAttempts: 2,
					feedback: { category, retryAfterMs: 1500, nextAction: "resolve_blocker" },
				});
				expect(f.binding.verifiedSubmission).toBeUndefined();
			} finally {
				await f.close();
			}
		},
	);
	it("retains acceptance when environment cleanup fails and records the failure", async () => {
		const f = await fixture();
		try {
			f.release.mockRejectedValueOnce(new Error("offline cleanup failure"));
			expect((await f.binding.sendEvent("submit_request", candidate("synthetic-correct"))).accepted).toBe(true);
			expect(f.store.getTask(f.taskId)?.status).toBe("solved");
			expect(f.binding.verifiedSubmission).toBeDefined();
			expect(f.store.listEvents(f.taskId).some((e) => e.type === "blocked")).toBe(true);
		} finally {
			await f.close();
		}
	});
	for (const mixed of [false, true])
		it("stops the real Pi solver on acceptance, including later tools; mixed=" + mixed, async () => {
			const f = await fixture();
			const { runtime, faux, continuation } = await runtimeFixture(f);
			const tools: string[] = [];
			runtime.session.subscribe((event) => {
				if (event.type === "tool_execution_end") tools.push(event.toolName);
			});
			faux.setResponses([
				fauxAssistantMessage([
					...(mixed
						? [
								fauxToolCall("competition_progress", {
									status: "progressing",
									summary: "offline progress",
									confidence: 0.2,
									basis: ["e1"],
								}),
							]
						: []),
					fauxToolCall("competition_submit_request", {
						candidate: "synthetic-correct",
						evidence_refs: ["e1"],
						confidence: 0.2,
						rationale: "offline evidence",
					}),
					fauxToolCall("verify_flag", { flag: "should-never-reach-local-oracle" }),
					fauxToolCall("competition_submit_request", {
						candidate: "duplicate-after-accepted",
						evidence_refs: ["e1"],
						confidence: 0.2,
						rationale: "offline evidence",
					}),
				]),
				fauxAssistantMessage("This model turn must never be requested"),
			]);
			try {
				await runtime.prompt("Synthetic offline competition replay.");
				expect(faux.state.callCount).toBe(1);
				expect(f.submit).toHaveBeenCalledTimes(1);
				expect(continuation.verificationState).toBe("accepted");
				expect(f.store.getTask(f.taskId)?.status).toBe("solved");
				expect(runtime.state.operationalGuard?.verificationState).not.toBe("accepted");
				expect(
					runtime.session.messages
						.filter((m) => m.role === "toolResult" && m.toolName === "verify_flag")
						.every((m) => m.role === "toolResult" && m.isError),
				).toBe(true);
			} finally {
				runtime.dispose();
				await f.close();
			}
		}, 20000);
	it("feeds an incorrect result back into the next real Pi turn and accepts the correction", async () => {
		const f = await fixture();
		const { runtime, faux, continuation } = await runtimeFixture(f);
		let sawFeedback = false;
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("competition_submit_request", {
					candidate: "synthetic-wrong",
					evidence_refs: ["e1"],
					confidence: 0.2,
					rationale: "offline evidence",
				}),
			),
			(context) => {
				sawFeedback =
					JSON.stringify(context.messages).includes("revise_candidate") &&
					JSON.stringify(context.messages).includes("remainingAttempts");
				return fauxAssistantMessage(
					fauxToolCall("competition_submit_request", {
						candidate: "synthetic-correct",
						evidence_refs: ["e1"],
						confidence: 0.2,
						rationale: "offline evidence",
					}),
				);
			},
			fauxAssistantMessage("must never be requested"),
		]);
		try {
			await runtime.prompt("Correct an incorrect submission using offline evidence.");
			expect(sawFeedback).toBe(true);
			expect(faux.state.callCount).toBe(2);
			expect(f.submit).toHaveBeenCalledTimes(2);
			expect(continuation.verificationState).toBe("accepted");
		} finally {
			runtime.dispose();
			await f.close();
		}
	}, 20000);
});

describe("persisted accepted-then-continued trace replay", () => {
	const traces = JSON.parse(
		readFileSync(new URL("./fixtures/competition-accepted-continuation-20261019.json", import.meta.url), "utf8"),
	) as { runs: Array<{ task: string; postAcceptanceMs: number; postAcceptanceTools: string[] }> };
	for (const trace of traces.runs)
		it("prevents the post-acceptance continuation observed in " + trace.task, async () => {
			expect(trace.postAcceptanceMs).toBeGreaterThan(600000);
			expect(trace.postAcceptanceTools.length).toBeGreaterThan(0);
			const f = await fixture();
			const { runtime, faux } = await runtimeFixture(f);
			faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall("competition_submit_request", {
						candidate: "synthetic-correct",
						evidence_refs: ["e1"],
						confidence: 0.2,
						rationale: "redacted trace replay",
					}),
				),
				fauxAssistantMessage(trace.postAcceptanceTools.map((name) => fauxToolCall(name, {}))),
			]);
			try {
				await runtime.prompt("Replay the submission boundary only; no solving.");
				expect(faux.state.callCount).toBe(1);
				expect(f.submit).toHaveBeenCalledTimes(1);
				expect(f.binding.verifiedSubmission).toBeDefined();
			} finally {
				runtime.dispose();
				await f.close();
			}
		}, 20000);
	it.each(["wrong-task", "wrong-assignment", "not-correct"])(
		"does not trust a malformed broker verdict: %s",
		async (kind) => {
			const f = await fixture();
			vi.spyOn(f.broker, "handleEvent").mockResolvedValue({
				accepted: true,
				submission: {
					category: "accepted",
					isCorrect: kind !== "not-correct",
					recordId: "offline-record",
					taskId: kind === "wrong-task" ? "other" : f.taskId,
					assignmentId: kind === "wrong-assignment" ? "other" : f.binding.task?.assignmentId,
				},
			});
			try {
				await f.binding.sendEvent("submit_request", candidate("synthetic-correct"));
				expect(f.binding.verifiedSubmission).toBeUndefined();
			} finally {
				await f.close();
			}
		},
	);
});

describe("competition routing and finite budget", () => {
	it("blocks the old local verifier before acceptance and uses the platform instead", async () => {
		const f = await fixture();
		const { runtime, faux } = await runtimeFixture(f);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("verify_flag", { flag: "offline-only" })),
			fauxAssistantMessage(
				fauxToolCall("competition_submit_request", {
					candidate: "synthetic-correct",
					evidence_refs: ["e1"],
					confidence: 0.2,
					rationale: "offline evidence",
				}),
			),
		]);
		try {
			await runtime.prompt("Use the real competition path.");
			expect(faux.state.callCount).toBe(2);
			expect(f.submit).toHaveBeenCalledTimes(1);
			expect(JSON.stringify(runtime.session.messages)).toContain("not the competition judge");
		} finally {
			runtime.dispose();
			await f.close();
		}
	}, 20000);
	it("settles the solver when its explicit submission budget is exhausted without claiming success", async () => {
		const f = await fixture(1);
		const { runtime, faux, continuation } = await runtimeFixture(f);
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("competition_progress", {
					status: "progressing",
					summary: "offline progress",
					confidence: 0.2,
					basis: ["e1"],
				}),
				fauxToolCall("competition_submit_request", {
					candidate: "synthetic-wrong",
					evidence_refs: ["e1"],
					confidence: 0.2,
					rationale: "offline evidence",
				}),
				fauxToolCall("competition_progress", {
					status: "progressing",
					summary: "must not run",
					confidence: 0.2,
					basis: ["e1"],
				}),
			]),
			fauxAssistantMessage("must never be requested after budget exhaustion"),
		]);
		try {
			await runtime.prompt("Honor the explicit one-attempt budget.");
			expect(faux.state.callCount).toBe(1);
			expect(f.binding.verifiedSubmission).toBeUndefined();
			expect(continuation.verificationAttemptsRemaining).toBe(0);
			expect(f.store.getTask(f.taskId)?.status).toBe("blocked");
		} finally {
			runtime.dispose();
			await f.close();
		}
	}, 20000);
});
