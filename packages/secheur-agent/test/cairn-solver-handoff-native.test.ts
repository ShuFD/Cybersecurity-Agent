import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { type InlineExtension, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { loadSecHeurConfig } from "../src/config.ts";
import { CairnHostEvidence } from "../src/planning/cairn/host-evidence.ts";
import { GraphService } from "../src/planning/cairn/service.ts";
import { CairnSolverAdapter } from "../src/planning/cairn/solver.ts";
import { GraphStore } from "../src/planning/cairn/store.ts";
import { PlanningExecutorPool } from "../src/planning/execution-pool.ts";
import type { PiPlanningExtensionBundle } from "../src/planning/pi-adapters.ts";
import type { PiToolExecution } from "../src/subagent.ts";

async function fixture(bundle: PiPlanningExtensionBundle) {
	const root = mkdtempSync(join(tmpdir(), "cairn-solver-handoff-"));
	const faux = registerFauxProvider({ tokenSize: { min: 100, max: 100 } });
	const model = faux.getModel();
	const credentials = AuthStorage.inMemory();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "offline-fixture" }));
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
	const config = loadSecHeurConfig({
		projectRoot: root,
		stateDir: join(root, "state"),
		legacyRoot: resolve(import.meta.dirname, "../../../legacy"),
		env: {},
	});
	config.agentDir = join(root, "pi");
	config.skillPaths = [];
	config.systemPromptPath = "";
	config.knowledgeBaseEnabled = false;
	const store = new GraphStore(":memory:");
	store.initialize();
	const service = new GraphService(store);
	const evidence = new CairnHostEvidence(join(root, "host.sqlite"));
	const pool = new PlanningExecutorPool(1);
	const settled = vi.fn();
	const failed = vi.fn();
	const verified = vi.fn();
	const adapter = new CairnSolverAdapter({
		config,
		cwd: root,
		model,
		modelRuntime,
		thinkingLevel: "off",
		service,
		evidence,
		executorPool: pool,
		runId: "run",
		signal: AbortSignal.timeout(10_000),
		leaseDurationMs: 30_000,
		createExtensionBundle: () => bundle,
		onSettled: settled,
		onFailure: failed,
		onVerified: verified,
	});
	return {
		adapter,
		faux,
		evidence,
		pool,
		settled,
		failed,
		verified,
		claim: (key: string) => {
			const candidate = service.proposeIntent({
				actor: { id: "source", role: "solver", challengeId: "run" },
				idempotencyKey: `propose:${key}`,
				createdAt: new Date().toISOString(),
				objective: `Synthetic observation ${key}`,
				scope: "Local fixture",
				confidence: 0.5,
			});
			const intent = service.confirmIntent({
				actor: { id: "host", role: "host", challengeId: "run" },
				idempotencyKey: `confirm:${key}`,
				createdAt: new Date().toISOString(),
				candidateId: candidate.id,
			});
			return service.claimIntent({
				actor: { id: "host", role: "host", challengeId: "run" },
				idempotencyKey: `claim:${key}`,
				intentId: intent.id,
				solverId: "solver",
				expectedVersion: intent.version,
				leaseDurationMs: 30_000,
			});
		},
		close: async () => {
			await adapter.close();
			evidence.close();
			store.close();
			faux.unregister();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

describe("Cairn local handoff on native Pi", () => {
	it("ends a concluded turn immediately, preserves stale-tool guards, and labels reused-session feedback correctly", async () => {
		const verify = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "unexpected verification" }],
			details: {},
		}));
		const extension: InlineExtension = (pi) => {
			pi.registerTool({
				name: "verify_flag",
				label: "Synthetic verifier",
				description: "Must not run after conclusion",
				parameters: Type.Object({}),
				execute: verify,
			});
		};
		const f = await fixture({ extensionFactories: [extension], close: () => {} });
		const unexpectedTurn = () => {
			throw new Error("A concluded Intent requested another model turn");
		};
		try {
			const first = f.claim("first");
			f.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("conclude_intent", { outcome: "success" }), { stopReason: "toolUse" }),
				unexpectedTurn,
			]);
			await f.adapter.launch({
				solverId: "solver",
				profileId: "fixture",
				profileFingerprint: "fixture",
				lease: first,
				handoff: "First observation",
			});
			await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
			expect(f.faux.state.callCount).toBe(1);
			expect(f.adapter.snapshots()[0].reuseReady).toBe(true);
			expect(f.pool.getStatus().active).toBe(0);
			expect(f.evidence.proof("run")).toBeUndefined();
			expect(f.verified).not.toHaveBeenCalled();

			const second = f.claim("second");
			f.faux.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("conclude_intent", { outcome: "inconclusive" }), fauxToolCall("verify_flag", {})],
					{ stopReason: "toolUse" },
				),
				unexpectedTurn,
			]);
			await f.adapter.reuse({
				solverId: "solver",
				profileId: "fixture",
				profileFingerprint: "fixture",
				lease: second,
				context: "Second observation",
			});
			await vi.waitFor(() => expect(f.settled).toHaveBeenCalledTimes(2));
			expect(f.faux.state.callCount).toBe(2);
			expect(verify).not.toHaveBeenCalled();
			expect(f.failed).not.toHaveBeenCalled();
			expect(f.evidence.proof("run")).toBeUndefined();
			const events = f.evidence.events("run", 0, 1000).events;
			expect(events.filter((event) => event.type === "cairn_required_tool_handoff")).toHaveLength(2);
			const feedback = events.filter((event) => event.type === "planning_feedback_presented");
			expect(feedback.map((event) => event.payload.taskId)).toEqual([first.intentId, second.intentId]);
			expect(f.evidence.listAll("run").map((item) => f.evidence.read("run", item.evidenceId))).toContainEqual(
				expect.objectContaining({ toolName: "verify_flag", isError: true, intentId: second.intentId }),
			);
		} finally {
			await f.close();
		}
	}, 15_000);

	it("keeps concluded owned background work and its executor slot until settlement is saved", async () => {
		let pending = false;
		let release = () => {};
		let reachedSettlement = () => {};
		const held = new Promise<void>((resolvePromise) => {
			release = resolvePromise;
		});
		const settling = new Promise<void>((resolvePromise) => {
			reachedSettlement = resolvePromise;
		});
		const completed: PiToolExecution[] = [];
		const closed = vi.fn();
		const extension: InlineExtension = (pi) => {
			pi.registerTool({
				name: "owned_fixture",
				label: "Synthetic background observation",
				description: "Start owned local work",
				parameters: Type.Object({}),
				execute: async () => {
					pending = true;
					return { content: [{ type: "text", text: "owned work started" }], details: {} };
				},
			});
		};
		const f = await fixture({
			extensionFactories: [extension],
			close: closed,
			backgroundTasks: {
				hasPending: () => pending,
				settledExecutions: () => completed,
				waitForSettlement: async () => {
					reachedSettlement();
					await held;
				},
			},
		});
		try {
			f.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("owned_fixture", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("conclude_intent", { outcome: "partial" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Owned work is still settling."),
			]);
			const lease = f.claim("background");
			await f.adapter.launch({
				solverId: "solver",
				profileId: "fixture",
				profileFingerprint: "fixture",
				lease,
				handoff: "Observe owned background work",
			});
			await settling;
			expect(f.faux.state.callCount).toBeGreaterThanOrEqual(2);
			expect(f.evidence.events("run").events).toContainEqual(
				expect.objectContaining({
					type: "cairn_submission_durable",
					payload: expect.objectContaining({ durable: true, partial: false }),
				}),
			);
			expect(f.evidence.events("run").events.some((event) => event.type === "cairn_required_tool_handoff")).toBe(
				false,
			);
			expect(f.settled).not.toHaveBeenCalled();
			expect(f.pool.getStatus().active).toBe(1);
			expect(f.adapter.snapshots()[0].reuseReady).toBe(false);
			expect(closed).not.toHaveBeenCalled();
			completed.push({
				toolCallId: "background-completion",
				toolName: "owned_fixture",
				result: { content: [{ type: "text", text: "owned work settled" }], details: {} },
				isError: false,
				backgroundCompletion: true,
			});
			pending = false;
			release();
			await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce());
			expect(f.failed).not.toHaveBeenCalled();
			expect(f.pool.getStatus().active).toBe(0);
			expect(f.adapter.snapshots()[0].reuseReady).toBe(true);
			expect(f.evidence.listAll("run").map((item) => f.evidence.read("run", item.evidenceId))).toContainEqual(
				expect.objectContaining({ toolCallId: "background-completion", intentId: lease.intentId }),
			);
			expect(f.evidence.proof("run")).toBeUndefined();
			expect(f.verified).not.toHaveBeenCalled();
		} finally {
			release();
			await f.close();
		}
	}, 15_000);
});
