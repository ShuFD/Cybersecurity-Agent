import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionMode } from "../src/config.ts";
import { writeDesktopConfig } from "../src/desktop-config.ts";
import { PermissionController } from "../src/permissions.ts";
import { cairnRunDirectory } from "../src/planning/cairn/engine.ts";
import { CairnHostEvidence } from "../src/planning/cairn/host-evidence.ts";
import type { TrustedPlanningVerification } from "../src/planning/contracts.ts";
import { PlanningStore } from "../src/planning/store.ts";
import type { CreateSecHeurRuntimeOptions } from "../src/runtime.ts";

const runtimeFactory = vi.hoisted(() => vi.fn());
vi.mock("../src/runtime.ts", () => ({
	createSecHeurRuntime: runtimeFactory,
}));

import { SecHeurBridge } from "../src/bridge.ts";

const bridges: SecHeurBridge[] = [];
const roots: string[] = [];

interface DeferredVerificationDelivery {
	ready?: () => void;
	deliver?: () => boolean | undefined;
	finishPrompt?: () => void;
}

function planningRuntime(
	options: CreateSecHeurRuntimeOptions,
	runId: string,
	sessionNumber: number,
	verification?: TrustedPlanningVerification,
	deferredDelivery?: DeferredVerificationDelivery,
) {
	const permissions = new PermissionController("default");
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const direct =
		String(options.executionMode ?? "")
			.toLowerCase()
			.replaceAll("-", "_") === "direct";
	const mode = direct ? "direct" : "plan_single";
	return {
		config: {
			executionMode: {
				mode,
				planningEnabled: !direct,
				capacity: 1,
				legacyPlanningMode: direct ? "off" : "active",
			},
		},
		state: {
			permissions,
			permissionBroker: permissions.broker,
			getTurnCount: () => 0,
			getLastJudge: () => undefined,
			close: () => undefined,
		},
		session: {
			messages: [],
			sessionId: `planning-trace-session-${sessionNumber}`,
			sessionFile: undefined,
			sessionName: undefined,
			model: undefined,
			thinkingLevel: "max",
			setSessionName: vi.fn(),
			modelRuntime: {
				getAvailableSnapshot: () => [],
				getModels: () => [],
				getModel: () => undefined,
			},
			getAllTools: () => [],
			getActiveToolNames: () => [],
			setActiveToolsByName: () => undefined,
			abort: async () => undefined,
		},
		extensionsResult: {} as never,
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		prompt: async () => {
			if (direct) return;
			for (const listener of listeners) {
				listener({
					type: "message_end",
					message: {
						role: "custom",
						customType: runId.startsWith("planning_cairn_") ? "cairn-planning-goal" : "progressive-planning-goal",
						content: "diagnostic goal",
						details: { mode: "active", runId },
						display: false,
						timestamp: Date.now(),
					},
				} as AgentSessionEvent);
			}
			if (verification) {
				const context = {
					signal: new AbortController().signal,
					bridgeRunGeneration: options.getBridgeRunGeneration?.(),
				};
				const deliver = () => options.onTrustedPlanningVerification?.(verification, context);
				if (deferredDelivery) {
					deferredDelivery.deliver = deliver;
					deferredDelivery.ready?.();
					await new Promise<void>((resolve) => {
						deferredDelivery.finishPrompt = resolve;
					});
				} else {
					deliver();
					deliver();
				}
			}
		},
		getBudgetStatus: () => ({ maxTurns: 10, turnsUsed: 1, cost: 0, stopped: false }),
		getCommands: () => [],
		abort: async () => deferredDelivery?.finishPrompt?.(),
		setPermissionMode: (permissionMode: PermissionMode) => permissions.setMode(permissionMode),
		setMemoryReferenceEnabled: () => undefined,
		setKnowledgeBaseEnabled: () => undefined,
		setWebVerbsEnabled: () => undefined,
		dispose: () => undefined,
	} as never;
}

afterEach(async () => {
	for (const bridge of bridges.splice(0)) await bridge.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	runtimeFactory.mockReset();
});

describe("Planning trace Bridge API", () => {
	it("exports Cairn orchestration through the existing trace endpoint without opening progressive state", async () => {
		const root = mkdtempSync(join(tmpdir(), "cairn-trace-api-"));
		roots.push(root);
		const runId = `planning_cairn_${"a".repeat(32)}`;
		writeDesktopConfig(root, { planning: { mode: "active", engine: "cairn" } });
		const host = new CairnHostEvidence(join(cairnRunDirectory(join(root, ".secheur-agent"), runId), "host.sqlite"));
		host.event(runId, "cairn_run_start", { capacity: 2 });
		host.event(runId, "cairn_executor_start", { taskId: "intent", content: "raw local observation" });
		host.event(runId, "cairn_run_end", { status: "idle" });
		host.close();
		runtimeFactory.mockImplementation(async (options: CreateSecHeurRuntimeOptions) =>
			planningRuntime(options, runId, 1),
		);
		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			schedulerBackend: false,
			worklist: false,
			competition: false,
		});
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false, executionMode: "plan_single" }),
		}).then((response) => response.json())) as { sessionId: string };
		await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "Local orchestration" }),
		});
		const first = (await fetch(`${base}/session/${created.sessionId}/planning/trace?limit=1`).then((response) =>
			response.json(),
		)) as { engine: string; planningStatus: string; events: unknown[]; nextCursor: string; traceComplete: boolean };
		expect(first).toMatchObject({ engine: "cairn", planningStatus: "idle", traceComplete: false });
		expect(first.events).toHaveLength(1);
		const next = (await fetch(
			`${base}/session/${created.sessionId}/planning/trace?limit=10&cursor=${first.nextCursor}`,
		).then((response) => response.json())) as {
			events: Array<{ payload: Record<string, unknown> }>;
			traceComplete: boolean;
		};
		expect(next.events).toHaveLength(2);
		expect(next.traceComplete).toBe(true);
		expect(JSON.stringify(next)).not.toContain("raw local observation");
		const invalid = await fetch(
			`${base}/session/${created.sessionId}/planning/trace?cursor=99999999999999999999999999`,
		);
		expect(invalid.status).toBe(400);
		for (const id of ["progressive-planning", "cairn-planning"]) {
			const toggled = (await fetch(`${base}/plugins/catalog/toggle`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ kind: "builtin", id, enabled: true }),
			}).then((response) => response.json())) as { plugins: Array<{ id: string; configuredEnabled: boolean }> };
			expect(toggled.plugins.find((plugin) => plugin.id === id)?.configuredEnabled).toBe(true);
			expect(
				toggled.plugins.find(
					(plugin) => plugin.id === (id === "cairn-planning" ? "progressive-planning" : "cairn-planning"),
				)?.configuredEnabled,
			).toBe(false);
		}
	});
	it("accepts nested Planning verifier evidence without a parent verifier tool event and exports the shared contract", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-planning-verification-bridge-"));
		roots.push(root);
		writeDesktopConfig(root, { planning: { mode: "active" } });
		const sharedFixture = JSON.parse(
			readFileSync(join(import.meta.dirname, "fixtures", "planning-trusted-verification-session.json"), "utf8"),
		) as {
			export: { session: { trustedPlanningVerification: TrustedPlanningVerification } };
		};
		const runId = "planning_fixture";
		const verification = sharedFixture.export.session.trustedPlanningVerification;
		let sessionNumber = 0;
		runtimeFactory.mockImplementation(async (options: CreateSecHeurRuntimeOptions) => {
			sessionNumber += 1;
			return planningRuntime(options, runId, sessionNumber, verification);
		});
		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			schedulerBackend: false,
			worklist: false,
			competition: false,
		});
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				cwd: root,
				persist: false,
				taskKind: "ctf",
				targetId: "challenge-fixture",
				runId: "field-run-fixture",
				executionMode: "plan_single",
			}),
		}).then((response) => response.json())) as { sessionId: string };
		await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "exercise nested Planning verifier propagation" }),
		});
		const exported = (await fetch(`${base}/session/${created.sessionId}/export`).then((response) =>
			response.json(),
		)) as { session: Record<string, unknown> };
		expect(exported.session).toMatchObject({
			taskKind: "ctf",
			status: "idle",
			terminalReason: "verified_true",
			verificationState: "accepted",
			planningRunId: runId,
			trustedPlanningVerification: verification,
		});
		const runtimeLog = (await fetch(`${base}/session/${created.sessionId}/runtime/log`).then((response) =>
			response.json(),
		)) as { events: Array<Record<string, unknown>> };
		expect(runtimeLog.events.filter((event) => event.event === "planning_verification_accepted")).toHaveLength(1);
		expect(
			runtimeLog.events.some((event) => event.event === "tool_execution_end" && event.toolName === "verify_flag"),
		).toBe(false);
		await fetch(`${base}/session/${created.sessionId}/cancel`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ source: "test", reason: "cancel after accepted proof" }),
		});
		const cancelledAfterAcceptance = (await fetch(`${base}/session/${created.sessionId}/export`).then((response) =>
			response.json(),
		)) as { session: Record<string, unknown> };
		expect(cancelledAfterAcceptance.session).toMatchObject({
			status: "cancelled",
			terminalReason: "verified_true",
			verificationState: "accepted",
			trustedPlanningVerification: verification,
		});
	});

	it("rejects a proof delivered after cancellation invalidates its Bridge run generation", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-planning-verification-late-proof-"));
		roots.push(root);
		writeDesktopConfig(root, { planning: { mode: "active" } });
		const fixture = JSON.parse(
			readFileSync(join(import.meta.dirname, "fixtures", "planning-trusted-verification-session.json"), "utf8"),
		) as { export: { session: { trustedPlanningVerification: TrustedPlanningVerification } } };
		const runId = "planning_fixture";
		const verification = fixture.export.session.trustedPlanningVerification;
		const deferredDelivery: DeferredVerificationDelivery = {};
		const proofReady = new Promise<void>((resolve) => {
			deferredDelivery.ready = resolve;
		});
		runtimeFactory.mockImplementation(async (options: CreateSecHeurRuntimeOptions) =>
			planningRuntime(options, runId, 1, verification, deferredDelivery),
		);
		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			schedulerBackend: false,
			worklist: false,
			competition: false,
		});
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				cwd: root,
				persist: false,
				taskKind: "ctf",
				targetId: "challenge-fixture",
				runId: "field-run-fixture",
				executionMode: "plan_single",
			}),
		}).then((response) => response.json())) as { sessionId: string };
		const promptRequest = fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "delay proof until after cancellation" }),
		});
		await proofReady;
		await fetch(`${base}/session/${created.sessionId}/cancel`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ source: "test", reason: "cancel before proof delivery" }),
		});
		const delivered = deferredDelivery.deliver?.();
		await promptRequest;
		const exported = (await fetch(`${base}/session/${created.sessionId}/export`).then((response) =>
			response.json(),
		)) as { session: Record<string, unknown>; runtimeLog: unknown };
		expect(delivered).toBe(false);
		expect(exported.session).toMatchObject({
			status: "cancelled",
			terminalReason: null,
			verificationState: "not_attempted",
			trustedPlanningVerification: null,
		});
		expect(JSON.stringify(exported.runtimeLog)).toContain("stale_execution");
	});

	it.each([
		{ mismatch: "run" as const, reasonCode: "planning_run_identity_mismatch" },
		{ mismatch: "challenge" as const, reasonCode: "challenge_identity_mismatch" },
	])("rejects nested Planning verification with a mismatched $mismatch identity", async ({ mismatch, reasonCode }) => {
		const root = mkdtempSync(join(tmpdir(), "secheur-planning-verification-identity-"));
		roots.push(root);
		writeDesktopConfig(root, { planning: { mode: "active" } });
		const fixture = JSON.parse(
			readFileSync(join(import.meta.dirname, "fixtures", "planning-trusted-verification-session.json"), "utf8"),
		) as { export: { session: { trustedPlanningVerification: TrustedPlanningVerification } } };
		const runId = "planning_fixture";
		const verification = {
			...fixture.export.session.trustedPlanningVerification,
			...(mismatch === "run" ? { planningRunId: "planning_foreign" } : { challengeId: "challenge-foreign" }),
		};
		let sessionNumber = 0;
		runtimeFactory.mockImplementation(async (options: CreateSecHeurRuntimeOptions) => {
			sessionNumber += 1;
			return planningRuntime(options, runId, sessionNumber, verification);
		});
		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			schedulerBackend: false,
			worklist: false,
			competition: false,
		});
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				cwd: root,
				persist: false,
				taskKind: "ctf",
				targetId: "challenge-fixture",
				runId: "field-run-fixture",
				executionMode: "plan_single",
			}),
		}).then((response) => response.json())) as { sessionId: string };
		await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "reject foreign nested proof" }),
		});
		const exported = (await fetch(`${base}/session/${created.sessionId}/export`).then((response) =>
			response.json(),
		)) as { session: Record<string, unknown>; runtimeLog: unknown };
		expect(exported.session).toMatchObject({
			status: "idle",
			terminalReason: "unverified_idle",
			verificationState: "not_attempted",
		});
		expect(exported.session.trustedPlanningVerification).toBeNull();
		expect(JSON.stringify(exported.runtimeLog)).toContain(reasonCode);
	});

	it("associates a PLAN_SINGLE session, paginates events, and applies a field whitelist", async () => {
		const root = mkdtempSync(join(tmpdir(), "secheur-planning-trace-bridge-"));
		roots.push(root);
		writeDesktopConfig(root, { planning: { mode: "active" } });
		const runId = `planning_${"a".repeat(32)}`;
		const store = await PlanningStore.open(join(root, ".secheur-agent", "planning.sqlite"));
		store.createRun({ runId, outerTaskId: "outer", goal: "goal", mode: "active" }, 1);
		store.recordLifecycleEvent(
			runId,
			"supervisor_propose_end",
			{
				runId,
				decision: "commit",
				outputChars: 42,
				modelReply: "do not export this",
				rationale: "do not export this",
			},
			2,
		);
		store.recordLifecycleEvent(
			runId,
			"executor_tool_execution_end",
			{ runId, toolName: "planning_read_evidence", toolElapsedMs: 17, rawOutput: "secret" },
			3,
		);
		store.recordLifecycleEvent(
			runId,
			"executor_error",
			{
				runId,
				phase: "coding_task",
				executorPhase: "coding_task",
				failureSource: "planning",
				failureStage: "executor",
				failureCode: "verifier_quota_exhausted",
				secondaryFailureCodes: ["planning_persistence_error"],
				timeoutObserved: true,
				elapsedMs: 25,
				error: "do not export this",
			},
			4,
		);
		store.recordLifecycleEvent(
			runId,
			"planning_checkpoint_rejected",
			{
				taskId: "task-1",
				leaseId: "lease-1",
				checkpointId: "checkpoint-1",
				failureCode: "planning_checkpoint_validation_error",
				diagnosticLayer: "store_validation",
				diagnosticReason: "artifact_scope_rejected",
				fieldName: "artifacts[0].path",
				scopeDecision: "rejected",
				artifactReferenceHashes: ["a".repeat(64)],
				error: "do not export this",
			},
			5,
		);
		store.recordLifecycleEvent(
			runId,
			"planning_evidence_read",
			{
				requestId: "read-call-1",
				evidenceId: "evidence-1",
				taskId: "task-2",
				leaseId: "lease-2",
				sourceRunId: runId,
				sourceTaskId: "task-1",
				sourceLeaseId: "lease-1",
				offset: 0,
				nextOffset: 32,
				totalBytes: 64,
				requestedMaxBytes: 32,
				returnedBytes: 32,
				contentHash: "b".repeat(64),
				resultHash: "c".repeat(64),
				hasMore: true,
				readState: "completed",
				scopeDecision: "accepted",
				content: "do not export this",
			},
			6,
		);
		store.recordLifecycleEvent(
			runId,
			"planning_context_rendered",
			{
				contextRole: "executor",
				taskId: "task-2",
				leaseId: "lease-2",
				contextBytes: 4096,
				contextLimitBytes: 4096,
				evidenceBlockBytes: 1200,
				evidenceRefsCandidateCount: 2,
				evidenceRefsPresented: ["evidence-1"],
				evidenceRefsSummaryPresentedCount: 1,
				evidenceRefsSummaryPresented: ["evidence-1"],
				evidenceRefsReferenceOnlyCount: 0,
				evidenceRefsReferenceOnly: [],
				evidenceRefsOmitted: ["evidence-2"],
				evidenceRefsOmittedCount: 1,
				checkpointRefsCandidateCount: 1,
				checkpointRefsPresented: ["checkpoint-1"],
				checkpointRefsOmitted: [],
				referenceListsTruncated: false,
				prompt: "do not export this",
			},
			7,
		);
		store.recordLifecycleEvent(
			runId,
			"planning_presentation_error",
			{ runId, failureCode: "presentation_error", acceptedByHost: true, rawError: "do not export this" },
			8,
		);
		store.recordLifecycleEvent(
			runId,
			"proposal_generation_start",
			{
				attempt: "primary",
				attemptType: "primary",
				elapsedMs: 10,
				prompt: "do not export this",
			},
			9,
		);
		store.recordLifecycleEvent(
			runId,
			"proposal_generation_end",
			{
				attempt: "primary",
				attemptType: "primary",
				elapsedMs: 15,
				stopReason: "length",
				outputChars: 42,
				isError: false,
				output: "do not export this",
			},
			10,
		);
		store.setRunStatus(runId, "failed", "private failure detail", 11);
		store.close();

		let sessionNumber = 0;
		runtimeFactory.mockImplementation(async (options: CreateSecHeurRuntimeOptions) => {
			sessionNumber += 1;
			return planningRuntime(options, runId, sessionNumber);
		});
		const bridge = new SecHeurBridge({
			projectRoot: root,
			port: 0,
			schedulerBackend: false,
			worklist: false,
			competition: false,
		});
		bridges.push(bridge);
		await bridge.listen();
		const base = `http://127.0.0.1:${bridge.address.port}`;
		const created = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false, executionMode: "plan_single" }),
		}).then((response) => response.json())) as { sessionId: string };
		await fetch(`${base}/session/${created.sessionId}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "diagnostic goal" }),
		});

		const first = (await fetch(`${base}/session/${created.sessionId}/planning/trace?limit=1`).then((response) =>
			response.json(),
		)) as Record<string, unknown>;
		expect(first).toMatchObject({
			ok: true,
			sessionId: created.sessionId,
			planningRunId: runId,
			planningStatus: "failed",
			eventCount: 11,
			pageEventCount: 1,
			traceComplete: false,
		});
		const firstEvent = (first.events as Array<Record<string, unknown>>)[0];
		expect(firstEvent).toMatchObject({ type: "run_created", runId, sequence: expect.any(Number) });
		expect(firstEvent.payload).toEqual({ mode: "active" });

		const exported: Array<Record<string, unknown>> = [...(first.events as Array<Record<string, unknown>>)];
		let cursor = String(first.nextCursor);
		while (cursor !== "null") {
			const page = (await fetch(
				`${base}/session/${created.sessionId}/planning/trace?limit=1&cursor=${encodeURIComponent(cursor)}`,
			).then((response) => response.json())) as Record<string, unknown>;
			exported.push(...(page.events as Array<Record<string, unknown>>));
			if (page.nextCursor === null) {
				expect(page.traceComplete).toBe(true);
				break;
			}
			cursor = String(page.nextCursor);
		}
		expect(exported.map((event) => event.type)).toEqual([
			"run_created",
			"supervisor_propose_end",
			"executor_tool_execution_end",
			"executor_error",
			"planning_checkpoint_rejected",
			"planning_evidence_read",
			"planning_context_rendered",
			"planning_presentation_error",
			"proposal_generation_start",
			"proposal_generation_end",
			"run_failed",
		]);
		expect(exported.map((event) => event.sequence)).toEqual(
			[...exported].map((event) => event.sequence).sort((left, right) => Number(left) - Number(right)),
		);
		const supervisorEvent = exported[1];
		expect(supervisorEvent.payload).toEqual({ runId, decision: "commit", outputChars: 42 });
		const executorError = exported[3];
		expect(executorError.payload).toEqual({
			runId,
			executorPhase: "coding_task",
			failureSource: "planning",
			failureStage: "executor",
			failureCode: "verifier_quota_exhausted",
			secondaryFailureCodes: ["planning_persistence_error"],
			timeoutObserved: true,
			elapsedMs: 25,
		});
		expect(executorError.payload).not.toHaveProperty("phase");
		expect(exported[4]?.payload).toMatchObject({
			diagnosticLayer: "store_validation",
			diagnosticReason: "artifact_scope_rejected",
			fieldName: "artifacts[0].path",
			scopeDecision: "rejected",
			artifactReferenceHashes: ["a".repeat(64)],
		});
		expect(exported[5]?.payload).toMatchObject({
			requestId: "read-call-1",
			evidenceId: "evidence-1",
			taskId: "task-2",
			leaseId: "lease-2",
			sourceTaskId: "task-1",
			sourceLeaseId: "lease-1",
			returnedBytes: 32,
			resultHash: "c".repeat(64),
			hasMore: true,
		});
		expect(exported[6]?.payload).toMatchObject({
			contextRole: "executor",
			contextBytes: 4096,
			evidenceRefsPresented: ["evidence-1"],
			evidenceRefsSummaryPresentedCount: 1,
			evidenceRefsSummaryPresented: ["evidence-1"],
			evidenceRefsReferenceOnlyCount: 0,
			evidenceRefsReferenceOnly: [],
			evidenceRefsOmitted: ["evidence-2"],
			checkpointRefsPresented: ["checkpoint-1"],
		});
		expect(exported[7]?.payload).toEqual({ runId, failureCode: "presentation_error", acceptedByHost: true });
		expect(exported[8]?.payload).toEqual({ attempt: "primary", attemptType: "primary", elapsedMs: 10 });
		expect(exported[9]?.payload).toEqual({
			attempt: "primary",
			attemptType: "primary",
			elapsedMs: 15,
			stopReason: "length",
			outputChars: 42,
			isError: false,
		});
		expect(JSON.stringify(exported)).not.toContain("do not export this");
		expect(JSON.stringify(exported)).not.toContain("secret");

		const direct = (await fetch(`${base}/session/new`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: root, persist: false, executionMode: "direct" }),
		}).then((response) => response.json())) as { sessionId: string };
		const directTrace = (await fetch(`${base}/session/${direct.sessionId}/planning/trace`).then((response) =>
			response.json(),
		)) as Record<string, unknown>;
		expect(directTrace).toMatchObject({
			ok: true,
			planningRunId: null,
			planningStatus: "not_applicable",
			events: [],
			eventCount: 0,
			traceComplete: true,
		});
	});
});
