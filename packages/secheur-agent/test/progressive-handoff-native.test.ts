import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { type InlineExtension, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { loadSecHeurConfig } from "../src/config.ts";
import { PiPlanningExecutor } from "../src/planning/pi-adapters.ts";
import { PlanningEvidenceNotFoundError } from "../src/planning/failures.ts";
import { createPlanningCommitExtension } from "../src/planning/result-tool.ts";
import { PiCodingSessionOwner, runPiCodingTask } from "../src/subagent.ts";

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "progressive-handoff-"));
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
	config.executionMode = { ...config.executionMode, mode: "plan_multi" };
	return {
		root,
		faux,
		model,
		modelRuntime,
		config,
		close: () => {
			faux.unregister();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

describe("Progressive local handoff on native Pi", () => {
	it("recovers from an unknown evidence ID in one Pi session with a visible error result", async () => {
		const f = await fixture();
		const fullId = "tool-synthetic-evidence-complete-id";
		const commit = createPlanningCommitExtension({
			leaseId: "synthetic-reader-lease",
			evidence: [],
			listEvidence: () => ({
				items: [
					{
						evidenceId: fullId,
						runId: "synthetic-run",
						taskId: "synthetic-task",
						leaseId: "synthetic-reader-lease",
						kind: "tool",
						source: "fixture",
						summary: "synthetic catalog item",
						excerpt: "fixture",
						contentRef: null,
						contentHash: "synthetic",
						locator: {},
						contentBytes: 7,
						contentComplete: true,
						isTruncated: false,
						metadata: { isError: false },
						createdAt: 1,
					},
				],
				totalCount: 1,
				hasMore: false,
				nextCursor: null,
			}),
			readEvidence: (id) => {
				if (id !== fullId) throw new PlanningEvidenceNotFoundError(id);
				return {
					contentRef: "synthetic-fixture",
					contentHash: "synthetic",
					offset: 0,
					nextOffset: 7,
					totalBytes: 7,
					hasMore: false,
					content: "fixture",
					contentComplete: true,
				};
			},
		});
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("planning_read_evidence", { evidenceId: "invented-id" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("planning_list_evidence", { limit: 10 }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("planning_read_evidence", { evidenceId: fullId }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				fauxToolCall("planning_commit_result", { outcome: "done", summary: "Read corrected synthetic evidence" }),
				{ stopReason: "toolUse" },
			),
		]);
		try {
			const report = await runPiCodingTask({
				config: f.config,
				cwd: f.root,
				model: f.model,
				modelRuntime: f.modelRuntime,
				task: "Synthetic exact-ID correction",
				extensionFactories: [commit.extension],
				requiredToolName: "planning_commit_result",
				isRequiredToolComplete: () => Boolean(commit.getResult()),
				handoffOnRequiredTool: true,
				signal: AbortSignal.timeout(10_000),
			});
			expect(report.toolExecutions.map((item) => item.toolName)).toEqual([
				"planning_read_evidence",
				"planning_list_evidence",
				"planning_read_evidence",
				"planning_commit_result",
			]);
			expect(report.toolExecutions.map((item) => item.isError)).toEqual([true, false, false, false]);
			expect(report.toolExecutions[0]?.result).toMatchObject({
				details: { reasonCode: "planning_evidence_not_found", fieldPaths: ["evidenceId"] },
			});
			expect(commit.getResult()?.outcome).toBe("done");
		} finally {
			f.close();
		}
	}, 15_000);

	it("keeps inherited budget hooks and restores them after a local handoff", async () => {
		const f = await fixture();
		const owner = new PiCodingSessionOwner();
		let submitted = false;
		const extension: InlineExtension = (pi) => {
			pi.registerTool({
				name: "required_result",
				label: "Local report",
				description: "Synthetic report",
				parameters: Type.Object({}),
				execute: async () => {
					submitted = true;
					return { content: [{ type: "text", text: "accepted" }], details: { accepted: true } };
				},
			});
		};
		const base = {
			config: f.config,
			cwd: f.root,
			model: f.model,
			modelRuntime: f.modelRuntime,
			sessionOwner: owner,
			extensionFactories: [extension],
			signal: AbortSignal.timeout(10000),
		};
		try {
			f.faux.setResponses([fauxAssistantMessage("Initialize reusable fixture")]);
			await runPiCodingTask({ ...base, task: "Initialize" });
			if (!owner.session) throw new Error("Native session missing");
			const inherited = vi.fn(() => false);
			owner.session.agent.shouldStopAfterTurn = inherited;
			f.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("required_result", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("Must not need another model call"),
			]);
			await runPiCodingTask({
				...base,
				task: "Submit local report",
				requiredToolName: "required_result",
				isRequiredToolComplete: () => submitted,
				handoffOnRequiredTool: true,
			});
			expect(inherited).toHaveBeenCalledOnce();
			expect(owner.session.agent.shouldStopAfterTurn).toBe(inherited);
		} finally {
			owner.dispose();
			f.close();
		}
	}, 15000);
	it.each([false, true])(
		"settles one submitted local objective without duplicate report loops (repair=%s)",
		async (repair) => {
			const f = await fixture();
			let work = 0;
			const submitted = vi.fn();
			const events: string[] = [];
			const extension: InlineExtension = (pi) => {
				pi.registerTool({
					name: "work_step",
					label: "Local work",
					description: "Synthetic observation",
					parameters: Type.Object({}),
					execute: async () => {
						work++;
						return { content: [{ type: "text", text: "local observation" }], details: {} };
					},
				});
			};
			f.faux.setResponses([
				...(repair ? [fauxAssistantMessage("Need another local observation.")] : []),
				(context) => {
					expect(context.tools?.some((t) => t.name === "work_step")).toBe(true);
					return fauxAssistantMessage(fauxToolCall("work_step", {}), { stopReason: "toolUse" });
				},
				...Array.from({ length: 100 }, () =>
					fauxAssistantMessage(
						fauxToolCall("planning_commit_result", {
							outcome: "blocked",
							summary: "Local observation complete; overall goal is still unverified.",
						}),
						{ stopReason: "toolUse" },
					),
				),
			]);
			try {
				const executor = new PiPlanningExecutor({
					config: f.config,
					cwd: f.root,
					model: f.model,
					modelRuntime: f.modelRuntime,
					thinkingLevel: "off",
					createExtensionBundle: () => ({ extensionFactories: [extension], close: () => {} }),
					onLifecycleEvent: (type) => events.push(type),
				});
				const report = await executor.execute({
					lease: {
						schemaVersion: 1,
						leaseId: "lease",
						taskId: "task",
						runId: "run",
						planRevision: 1,
						objective: "Make one synthetic observation",
						doneWhen: "Observation reported",
						allowedScope: f.root,
						issuedAt: Date.now(),
						expiresAt: Date.now() + 10000,
					},
					context: "Synthetic harness fixture",
					recordSubmission: submitted,
					signal: AbortSignal.timeout(10000),
				});
				expect(work).toBe(1);
				expect(submitted).toHaveBeenCalledOnce();
				expect(report.result.outcome).toBe("blocked");
				expect(report.evidence.some((e) => e.toolName === "work_step")).toBe(true);
				expect(events.filter((e) => e === "planning_commit_observed")).toHaveLength(1);
				expect(events).toContain("required_tool_handoff");
				expect(events).not.toContain("executor_cancelled");
			} finally {
				f.close();
			}
		},
		15000,
	);

	it("keeps owned pending work available and refuses a premature local submission", async () => {
		const f = await fixture();
		let pending = true;
		const submitted = vi.fn();
		const commit = createPlanningCommitExtension({
			leaseId: "lease",
			evidence: [],
			canSubmit: () => !pending,
			recordSubmission: submitted,
		});
		const extension: InlineExtension = (pi) => {
			pi.registerTool({
				name: "work_step",
				label: "Consume completion",
				description: "Synthetic completion",
				parameters: Type.Object({}),
				execute: async () => {
					pending = false;
					return { content: [{ type: "text", text: "owned work completed" }], details: {} };
				},
			});
		};
		const report = () =>
			fauxAssistantMessage(fauxToolCall("planning_commit_result", { outcome: "blocked", summary: "Local report" }), {
				stopReason: "toolUse",
			});
		f.faux.setResponses([
			report(),
			fauxAssistantMessage(fauxToolCall("work_step", {}), { stopReason: "toolUse" }),
			report(),
			report(),
		]);
		try {
			const result = await runPiCodingTask({
				config: f.config,
				cwd: f.root,
				model: f.model,
				modelRuntime: f.modelRuntime,
				task: "Synthetic background boundary",
				extensionFactories: [extension, commit.extension],
				requiredToolName: "planning_commit_result",
				isRequiredToolComplete: () => Boolean(commit.getResult()),
				handoffOnRequiredTool: true,
				backgroundTasks: {
					hasPending: () => pending,
					waitForSettlement: async () => {
						expect(pending).toBe(false);
					},
				},
				signal: AbortSignal.timeout(10000),
			});
			expect(submitted).toHaveBeenCalledOnce();
			expect(result.toolExecutions.filter((e) => e.toolName === "planning_commit_result")).toHaveLength(2);
			expect(result.toolExecutions[0]?.isError).toBe(true);
			expect(result.toolExecutions.at(-1)?.isError).toBe(false);
		} finally {
			f.close();
		}
	}, 15000);
});
