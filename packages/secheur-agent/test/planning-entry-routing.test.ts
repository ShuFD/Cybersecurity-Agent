import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createNodeSqliteFactory } from "@earendil-works/pi-session-backend-sqlite-node";
import { describe, expect, it, vi } from "vitest";
import { loadSecHeurConfig } from "../src/config.ts";
import type { PlanningSnapshot, TrustedPlanningVerification } from "../src/planning/contracts.ts";
import type { ProgressivePlanningRequest, ProgressivePlanningResult } from "../src/planning/controller.ts";
import { planningRunId } from "../src/planning/controller.ts";
import { planningFailure } from "../src/planning/failures.ts";
import { attachProgressivePlanningController } from "../src/planning/session-controller.ts";
import type { PlanningStore } from "../src/planning/store.ts";

interface PresentationProbe {
	customTypes: string[];
	customDetails: Map<string, Record<string, unknown>>;
	directPrompts: string[];
	presentationTools: string[][];
	presentationPrompts: string[];
	traceTypes: string[];
	payloads: Map<string, Record<string, unknown>>;
	activeTools: string[];
	trustedVerifications: TrustedPlanningVerification[];
}

async function runPresentationProbe(
	initialTools: string[],
	flagCandidateCount: number,
	inventoryTools = initialTools,
	candidateVerifierStatus?: "incorrect" | "duplicate",
	trustedVerification?: TrustedPlanningVerification,
	options: {
		presentationError?: boolean;
		acceptTrustedVerification?: boolean;
		abortBeforeProof?: boolean;
		earlyEvidence?: number;
	} = {},
): Promise<PresentationProbe> {
	const root = await mkdtemp(join(tmpdir(), "secheur-planning-entry-"));
	const stateDir = join(root, "state");
	const legacyRoot = join(root, "legacy");
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(legacyRoot, { recursive: true });
	writeFileSync(join(stateDir, "desktop-config.json"), JSON.stringify({ planning: { mode: "active" } }));
	const directPrompts: string[] = [];
	const customTypes: string[] = [];
	const customDetails = new Map<string, Record<string, unknown>>();
	const presentationTools: string[][] = [];
	const presentationPrompts: string[] = [];
	const trustedVerifications: TrustedPlanningVerification[] = [];
	const allToolNames = [...inventoryTools];
	let activeTools = [...initialTools];
	const listeners = new Set<(event: { type: string; toolName?: string }) => void>();
	const session = {
		sessionId: "entry-session",
		model: undefined,
		thinkingLevel: "max",
		prompt: vi.fn(async (message: string) => {
			directPrompts.push(message);
		}),
		getActiveToolNames: () => [...activeTools],
		setActiveToolsByName: (names: string[]) => {
			activeTools = [...names];
		},
		getAllTools: () => allToolNames.map((name) => ({ name })),
		subscribe: (listener: (event: { type: string; toolName?: string }) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		sendCustomMessage: vi.fn(
			async (message: { customType: string; content?: string; details?: Record<string, unknown> }) => {
				customTypes.push(message.customType);
				if (message.details) customDetails.set(message.customType, message.details);
				if (message.customType === "progressive-planning-result" && message.details?.acceptedByHost !== true) {
					presentationTools.push([...activeTools]);
					presentationPrompts.push(message.content ?? "");
					if (options.presentationError) throw new Error("mock parent presentation failure");
				}
			},
		),
	} as unknown as AgentSession;
	let controllerStore: PlanningStore | undefined;
	let probeRunId = "";
	let abortBinding: ((reason?: unknown) => void) | undefined;
	const execute = vi.fn(async (request: ProgressivePlanningRequest) => {
		if (!controllerStore) throw new Error("test controller store was not initialized");
		probeRunId = planningRunId(`active:${request.outerTaskId}`, request.goal, "active");
		controllerStore.createRun(
			{
				runId: probeRunId,
				outerTaskId: request.outerTaskId,
				goal: request.goal,
				mode: "active",
			},
			1,
		);
		controllerStore.setRunStatus(probeRunId, "completed", "test", 1);
		const scopedTrustedVerification = trustedVerification
			? { ...trustedVerification, planningRunId: probeRunId }
			: undefined;
		if (options.abortBeforeProof) abortBinding?.(new Error("mock cancel before proof handoff"));
		return {
			mode: "active" as const,
			executionMode: "plan_single" as const,
			runId: probeRunId,
			snapshot: {
				run: {
					runId: probeRunId,
					outerTaskId: request.outerTaskId,
					goal: request.goal,
					mode: "active",
					status: "completed",
					revision: 1,
					createdAt: 1,
					updatedAt: 1,
				},
				tasks: [],
				evidence: [
					...Array.from({ length: options.earlyEvidence ?? 0 }, (_, index) => ({
						evidenceId: `old-error-${index}`,
						source: "bash",
						excerpt: "error ".repeat(300),
						metadata: {},
					})),
					...Array.from({ length: flagCandidateCount }, (_, index) => ({
						evidenceId: `candidate-${index}`,
						source: "planning-flag-candidate",
						metadata: { candidateHash: `candidate-hash-${index}` },
					})),
					...(candidateVerifierStatus && flagCandidateCount > 0
						? [
								{
									evidenceId: "verdict-0",
									source: "verify_flag",
									toolName: "verify_flag",
									metadata: {
										candidateHash: "candidate-hash-0",
										verificationOutcome: "incorrect",
										verifierStatus: candidateVerifierStatus,
									},
								},
							]
						: []),
				],
				executionFrame: {
					schemaVersion: 1,
					taskSummaries: [],
					facts: [],
					rejectedDirections: [],
					openQuestions: [],
					artifacts: [],
				},
			} as unknown as PlanningSnapshot,
			...(scopedTrustedVerification ? { trustedVerification: scopedTrustedVerification } : {}),
			direct: false,
		};
	});
	let closeBinding: (() => void) | undefined;
	try {
		const config = loadSecHeurConfig({ projectRoot: root, stateDir, legacyRoot, env: {} });
		const binding = attachProgressivePlanningController(session, {
			config,
			cwd: root,
			controllerFactory: (options) => {
				controllerStore = options.store;
				return { execute };
			},
			onTrustedPlanningVerification: (verification) => {
				trustedVerifications.push(verification);
				return options.acceptTrustedVerification !== false;
			},
		});
		closeBinding = binding.close;
		abortBinding = binding.abort;
		try {
			await session.prompt("solve the challenge");
		} catch (error) {
			if (!options.abortBeforeProof) throw error;
		}
		await session.prompt("/status");
		const db = await createNodeSqliteFactory().open(join(stateDir, "planning.sqlite"));
		try {
			const rows = db
				.prepare("SELECT type, payload_json FROM planning_events WHERE run_id = ? ORDER BY rowid")
				.all<{ type: string; payload_json: string }>(probeRunId);
			const traceTypes = rows
				.map((row) => row.type)
				.filter(
					(type) =>
						type.startsWith("planning_presentation_") ||
						type.startsWith("verification_") ||
						type === "planning_verified_completion",
				);
			const payloads = new Map(
				rows
					.filter((row) => traceTypes.includes(row.type))
					.map((row) => [row.type, JSON.parse(row.payload_json) as Record<string, unknown>]),
			);
			return {
				customTypes,
				customDetails,
				directPrompts,
				presentationTools,
				presentationPrompts,
				traceTypes,
				payloads,
				activeTools,
				trustedVerifications,
			};
		} finally {
			db.close();
		}
	} finally {
		closeBinding?.();
		await rm(root, { recursive: true, force: true });
	}
}

describe("progressive planning prompt entry", () => {
	it("hands active ordinary prompts to the Controller and bypasses slash commands", async () => {
		const probe = await runPresentationProbe(["bash", "read", "write", "verify_flag", "check_flag"], 1);
		const goalDetails = probe.customDetails.get("progressive-planning-goal");
		const resultDetails = probe.customDetails.get("progressive-planning-result");
		expect(probe.directPrompts).toEqual(["/status"]);
		expect(probe.customTypes).toEqual(["progressive-planning-goal", "progressive-planning-result"]);
		expect(goalDetails).toMatchObject({ mode: "active" });
		expect(goalDetails?.runId).toMatch(/^planning_[0-9a-f]{32}$/u);
		expect(resultDetails?.runId).toBe(goalDetails?.runId);
		expect(probe.activeTools).toEqual(["bash", "read", "write", "verify_flag", "check_flag"]);
		expect(probe.presentationTools).toEqual([["bash", "read", "write", "verify_flag", "check_flag"]]);
		expect(probe.presentationPrompts[0]).toContain("Use the available native verifier");
		expect(probe.traceTypes).toEqual([
			"planning_presentation_start",
			"verification_candidate_available",
			"verification_tool_available",
			"planning_presentation_tools",
			"planning_presentation_triggered",
			"planning_presentation_end",
		]);
		expect(probe.payloads.get("planning_presentation_start")).toMatchObject({
			runId: goalDetails?.runId,
			runStatus: "completed",
			flagCandidateCount: 1,
			verifyFlagAvailable: true,
			verifyFlagInInventory: true,
		});
		expect(probe.payloads.get("planning_presentation_tools")).toMatchObject({
			activeToolNames: ["bash", "read", "write", "verify_flag", "check_flag"],
			verifyFlagAvailable: true,
			verifyFlagInInventory: true,
		});
		expect(probe.traceTypes).not.toContain("verification_attempted");
	});

	it("does not enable verifier tools that were not active", async () => {
		const probe = await runPresentationProbe(["bash", "read"], 1, ["bash", "read", "verify_flag", "check_flag"]);
		expect(probe.presentationTools).toEqual([["bash", "read"]]);
		expect(probe.payloads.get("planning_presentation_tools")).toMatchObject({
			activeToolNames: ["bash", "read"],
			verifyFlagAvailable: false,
			verifyFlagInInventory: true,
		});
	});

	it("presents complete candidate-first JSON despite a large earlier evidence history", async () => {
		const probe = await runPresentationProbe(
			["verify_flag", "check_flag"],
			2,
			["verify_flag", "check_flag"],
			undefined,
			undefined,
			{ earlyEvidence: 100 },
		);
		const section = probe.presentationPrompts[0]?.split("Persisted evidence (complete JSON records; ")[1];
		const json = section?.slice(section.indexOf("\n") + 1);
		const evidence = JSON.parse(json ?? "") as Array<{ evidenceId: string }>;
		expect(evidence.slice(0, 2).map((item) => item.evidenceId)).toEqual(["candidate-0", "candidate-1"]);
		expect(Buffer.byteLength(json ?? "", "utf8")).toBeLessThanOrEqual(80_000);
		expect(probe.presentationTools).toEqual([["verify_flag", "check_flag"]]);
	});

	it("keeps a no-candidate presentation tool-free", async () => {
		const probe = await runPresentationProbe(["read", "verify_flag", "check_flag"], 0);
		expect(probe.presentationTools).toEqual([[]]);
		expect(probe.presentationPrompts[0]).toContain("No persisted flag candidate is available for verification");
		expect(probe.presentationPrompts[0]).toContain("Do not invent or submit a flag");
		expect(probe.traceTypes).not.toContain("verification_attempted");
		expect(probe.payloads.get("planning_presentation_tools")).toMatchObject({
			activeToolNames: [],
			verifyFlagAvailable: false,
			verifyFlagInInventory: true,
		});
		expect(probe.payloads.get("verification_candidate_available")).toMatchObject({ flagCandidateCount: 0 });
	});

	it("does not re-submit a persisted candidate already rejected by the verifier", async () => {
		const probe = await runPresentationProbe(
			["read", "verify_flag", "check_flag"],
			1,
			["read", "verify_flag", "check_flag"],
			"incorrect",
		);

		expect(probe.presentationTools).toEqual([[]]);
		expect(probe.presentationPrompts[0]).toContain("No persisted flag candidate is available for verification");
		expect(probe.presentationPrompts[0]).not.toContain('"evidenceId": "candidate-0"');
		expect(probe.payloads.get("planning_presentation_start")).toMatchObject({
			flagCandidateCount: 0,
			filteredIncorrectCandidateCount: 1,
		});
	});

	it("keeps the Bridge-accepted verifier result authoritative when final presentation fails", async () => {
		const probe = await runPresentationProbe(
			["read", "verify_flag", "check_flag"],
			1,
			["read", "verify_flag", "check_flag"],
			undefined,
			{
				source: "planning_verifier_evidence",
				verificationOutcome: "correct",
				planningRunId: "will-be-bound-to-this-run",
				taskId: "task-1",
				leaseId: "lease-1",
				evidenceId: "tool-verified",
				evidenceCreatedAt: 1,
				challengeId: "fixture/challenge",
			},
			{ presentationError: true },
		);

		expect(probe.customTypes).toEqual(["progressive-planning-goal", "progressive-planning-result"]);
		expect(probe.trustedVerifications).toMatchObject([
			{ source: "planning_verifier_evidence", verificationOutcome: "correct", evidenceId: "tool-verified" },
		]);
		expect(probe.presentationTools).toEqual([]);
		expect(probe.presentationPrompts).toEqual([]);
		expect(probe.traceTypes).toContain("planning_verified_completion");
		expect(probe.traceTypes).not.toContain("planning_presentation_error");
	});

	it("does not send trusted proof to the host if the Planning prompt was cancelled before handoff", async () => {
		const probe = await runPresentationProbe(
			["read", "verify_flag", "check_flag"],
			0,
			["read", "verify_flag", "check_flag"],
			undefined,
			{
				source: "planning_verifier_evidence",
				verificationOutcome: "correct",
				planningRunId: "will-be-bound-to-this-run",
				taskId: "task-cancelled",
				leaseId: "lease-cancelled",
				evidenceId: "tool-cancelled-proof",
				evidenceCreatedAt: 1,
				challengeId: "fixture/challenge",
			},
			{ abortBeforeProof: true },
		);

		expect(probe.trustedVerifications).toEqual([]);
		expect(probe.customTypes).toEqual(["progressive-planning-goal"]);
		expect(probe.presentationTools).toEqual([]);
	});

	it("propagates binding abort to the current Planning operation", async () => {
		const root = await mkdtemp(join(tmpdir(), "secheur-planning-abort-entry-"));
		const stateDir = join(root, "state");
		const legacyRoot = join(root, "legacy");
		mkdirSync(stateDir, { recursive: true });
		mkdirSync(legacyRoot, { recursive: true });
		writeFileSync(join(stateDir, "desktop-config.json"), JSON.stringify({ planning: { mode: "active" } }));
		let activeTools = ["read"];
		let entered!: () => void;
		let observedSignal: AbortSignal | undefined;
		const session = {
			sessionId: "abort-entry-session",
			model: undefined,
			thinkingLevel: "max",
			prompt: vi.fn(async () => undefined),
			getActiveToolNames: () => [...activeTools],
			setActiveToolsByName: (names: string[]) => {
				activeTools = [...names];
			},
			getAllTools: () => [{ name: "read" }],
			subscribe: () => () => undefined,
			sendCustomMessage: vi.fn(async () => undefined),
		} as unknown as AgentSession;
		const execute = vi.fn(async (request: ProgressivePlanningRequest): Promise<ProgressivePlanningResult> => {
			observedSignal = request.signal;
			entered();
			await new Promise<void>((_resolve, reject) => {
				request.signal?.addEventListener("abort", () => reject(request.signal?.reason ?? new Error("aborted")), {
					once: true,
				});
			});
			throw new Error("planning operation unexpectedly resolved");
		});
		let binding: ReturnType<typeof attachProgressivePlanningController> | undefined;
		try {
			const config = loadSecHeurConfig({ projectRoot: root, stateDir, legacyRoot, env: {} });
			binding = attachProgressivePlanningController(session, {
				config,
				cwd: root,
				controllerFactory: () => ({ execute }),
			});
			const enteredPromise = new Promise<void>((resolveEntered) => {
				entered = resolveEntered;
			});
			const prompt = session.prompt("long planning operation");
			await enteredPromise;
			binding.abort(new Error("operator cancelled"));
			await expect(prompt).rejects.toThrow("operator cancelled");
			expect(observedSignal?.aborted).toBe(true);
		} finally {
			binding?.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("propagates a typed Planning failure without triggering presentation", async () => {
		const root = await mkdtemp(join(tmpdir(), "secheur-planning-failure-entry-"));
		const stateDir = join(root, "state");
		const legacyRoot = join(root, "legacy");
		mkdirSync(stateDir, { recursive: true });
		mkdirSync(legacyRoot, { recursive: true });
		writeFileSync(join(stateDir, "desktop-config.json"), JSON.stringify({ planning: { mode: "active" } }));
		const messages: Array<{ customType: string; details?: Record<string, unknown> }> = [];
		const session = {
			sessionId: "planning-failure-entry-session",
			model: undefined,
			thinkingLevel: "max",
			prompt: vi.fn(async () => undefined),
			getActiveToolNames: () => ["read"],
			setActiveToolsByName: vi.fn(),
			getAllTools: () => [{ name: "read" }],
			subscribe: () => () => undefined,
			sendCustomMessage: vi.fn(async (message: { customType: string; details?: Record<string, unknown> }) => {
				messages.push(message);
			}),
		} as unknown as AgentSession;
		let binding: ReturnType<typeof attachProgressivePlanningController> | undefined;
		try {
			const config = loadSecHeurConfig({ projectRoot: root, stateDir, legacyRoot, env: {} });
			binding = attachProgressivePlanningController(session, {
				config,
				cwd: root,
				controllerFactory: () => ({
					execute: async () => {
						throw planningFailure(
							"supervisor_parse",
							"supervisor_parse_error",
							"Model response did not contain a valid JSON object",
						);
					},
				}),
			});
			await expect(session.prompt("planning failure")).rejects.toMatchObject({
				name: "PlanningFailureError",
				code: "supervisor_parse_error",
			});
			expect(messages.map((message) => message.customType)).toEqual([
				"progressive-planning-goal",
				"progressive-planning-failure",
			]);
			expect(messages[1]?.details).toMatchObject({
				failureSource: "planning",
				failureStage: "supervisor_parse",
				failureCode: "supervisor_parse_error",
			});
		} finally {
			binding?.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
