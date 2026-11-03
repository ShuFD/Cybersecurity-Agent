import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PlanningEvidence } from "../src/planning/contracts.ts";
import { captureEvidenceBlob } from "../src/planning/evidence-store.ts";
import {
	PlanningCheckpointValidationError,
	PlanningEvidenceListInputError,
	PlanningEvidenceNotFoundError,
	PlanningPersistenceError,
} from "../src/planning/failures.ts";
import { createPlanningCommitExtension } from "../src/planning/result-tool.ts";
import { PlanningStore } from "../src/planning/store.ts";

type RegisteredTool = {
	name: string;
	execute: (toolCallId: string, params: unknown) => Promise<unknown>;
	parameters?: { properties?: Record<string, { maxLength?: number }> };
};

describe("planning result extension", () => {
	it("binds a known sibling evidence ID without admitting unknown IDs or implicitly binding the entire run", async () => {
		const extension = createPlanningCommitExtension({
			leaseId: "lease-sibling",
			evidence: [{ evidenceId: "own-evidence", kind: "tool", source: "tool", summary: "own", contentHash: "own" }],
			availableEvidenceRefs: () => ["sibling-evidence", "unused-other-evidence"],
		});
		const tools: RegisteredTool[] = [];
		const factory = extension.extension as unknown as {
			factory: (pi: { registerTool: (tool: RegisteredTool) => void }) => void;
		};
		factory.factory({ registerTool: (tool) => tools.push(tool) });
		await tools
			.find((tool) => tool.name === "planning_commit_result")
			?.execute("commit-sibling", {
				outcome: "done",
				summary: "based on an attributed sibling result",
				evidenceRefs: ["sibling-evidence", "unknown-other-run"],
			});
		expect(extension.getResult()?.evidenceRefs).toEqual(["sibling-evidence"]);
	});

	it("keeps omitted result evidence scoped to this attempt even with a same-run catalog", async () => {
		const extension = createPlanningCommitExtension({
			leaseId: "lease-default",
			evidence: [{ evidenceId: "own-evidence", kind: "tool", source: "tool", summary: "own", contentHash: "own" }],
			availableEvidenceRefs: () => ["sibling-evidence"],
		});
		const tools: RegisteredTool[] = [];
		const factory = extension.extension as unknown as {
			factory: (pi: { registerTool: (tool: RegisteredTool) => void }) => void;
		};
		factory.factory({ registerTool: (tool) => tools.push(tool) });
		await tools
			.find((tool) => tool.name === "planning_commit_result")
			?.execute("commit-own", { outcome: "done", summary: "own result" });
		expect(extension.getResult()?.evidenceRefs).toEqual(["own-evidence"]);
	});

	it("registers the supplied evidence catalog and labels excerpt search as partial", async () => {
		const register = (extension: ReturnType<typeof createPlanningCommitExtension>): RegisteredTool[] => {
			const registered: RegisteredTool[] = [];
			const extensionFactory = extension.extension as unknown as {
				factory: (pi: { registerTool: (tool: RegisteredTool) => void }) => void;
			};
			extensionFactory.factory({ registerTool: (tool: RegisteredTool) => registered.push(tool) } as never);
			return registered;
		};
		const disabledTools = register(createPlanningCommitExtension({ leaseId: "lease-catalog-off", evidence: [] }));
		expect(disabledTools.map((tool) => tool.name)).not.toContain("planning_list_evidence");

		const evidence: PlanningEvidence = {
			evidenceId: "tool-evidence-full-id",
			runId: "catalog-run",
			taskId: "catalog-task",
			leaseId: "catalog-lease",
			kind: "tool",
			source: "shell",
			toolName: "shell",
			summary: "error: shell",
			excerpt: "stderr: short excerpt",
			contentRef: "blob-ref",
			contentHash: "content-hash",
			locator: {},
			contentBytes: 9_000,
			contentComplete: false,
			isTruncated: true,
			metadata: { isError: true },
			createdAt: 123,
		};
		const cursor = "opaque-evidence-page-cursor-".repeat(8);
		const listEvidence = vi.fn(() => ({ items: [evidence], totalCount: 53, hasMore: true, nextCursor: cursor }));
		const registered = register(
			createPlanningCommitExtension({ leaseId: "catalog-lease", evidence: [], listEvidence }),
		);
		const tool = registered.find((item) => item.name === "planning_list_evidence");
		expect(tool).toBeDefined();
		expect(tool?.parameters?.properties?.cursor?.maxLength).toBeGreaterThanOrEqual(cursor.length);
		const response = (await tool?.execute("catalog-call", { limit: 1, outcome: "error", keyword: "missing" })) as {
			content: Array<{ text: string }>;
		};
		expect(listEvidence).toHaveBeenCalledWith({ limit: 1, outcome: "error", keyword: "missing" });
		const payload = JSON.parse(response.content[0]?.text ?? "{}") as {
			items: Array<Record<string, unknown>>;
			totalCount: number;
			hasMore: boolean;
			nextCursor: string | null;
			keywordSearchIsFullText: boolean;
		};
		expect(payload).toMatchObject({
			totalCount: 53,
			hasMore: true,
			nextCursor: cursor,
			keywordSearchIsFullText: false,
		});
		await tool?.execute("catalog-next-page", { cursor, limit: 1 });
		expect(listEvidence).toHaveBeenLastCalledWith({ cursor, limit: 1 });
		expect(payload.items[0]).toMatchObject({
			evidenceId: "tool-evidence-full-id",
			taskId: "catalog-task",
			leaseId: "catalog-lease",
			source: "shell",
			toolName: "shell",
			createdAt: 123,
			outcome: "error",
			contentComplete: false,
		});
		expect(String(payload.items[0]?.description)).toContain("stderr: short excerpt");
		expect(String(payload.items[0]?.description)).not.toContain("verified");
	});

	it("returns a correctable catalog input error and allows restarting from page one", async () => {
		const evidence: PlanningEvidence = {
			evidenceId: "catalog-retry-evidence",
			runId: "catalog-retry-run",
			taskId: "catalog-retry-task",
			leaseId: "catalog-retry-lease",
			kind: "tool",
			source: "shell",
			toolName: "shell",
			summary: "success: shell",
			excerpt: "ok",
			contentRef: null,
			contentHash: "hash",
			locator: {},
			contentBytes: 2,
			contentComplete: true,
			isTruncated: false,
			metadata: { isError: false },
			createdAt: 1,
		};
		const listEvidence = vi.fn((query: { cursor?: string; limit?: number }) => {
			if (query.cursor) {
				throw new PlanningEvidenceListInputError("invalid_cursor");
			}
			return { items: [evidence], totalCount: 1, hasMore: false, nextCursor: null };
		});
		const onPersistenceFailure = vi.fn();
		const registered: RegisteredTool[] = [];
		const extension = createPlanningCommitExtension({
			leaseId: "catalog-retry-lease",
			evidence: [],
			listEvidence,
			onPersistenceFailure,
		});
		(
			extension.extension as unknown as { factory: (pi: { registerTool: (tool: RegisteredTool) => void }) => void }
		).factory({ registerTool: (tool: RegisteredTool) => registered.push(tool) } as never);
		const tool = registered.find((item) => item.name === "planning_list_evidence");
		const invalidCursor = "bad-cursor";
		let queryError: unknown;
		try {
			await tool?.execute("bad-page", { cursor: invalidCursor, limit: 1 });
		} catch (error) {
			queryError = error;
		}
		expect(queryError).toMatchObject({ code: "planning_evidence_list_input_error" });
		expect(String(queryError)).not.toContain("SQL");
		const retried = await tool?.execute("restart-page-one", { limit: 1 });
		expect(retried).toBeDefined();
		expect(listEvidence).toHaveBeenNthCalledWith(2, { limit: 1 });
		expect(onPersistenceFailure).not.toHaveBeenCalled();
	});

	it("preserves Store read failures as persistence failures", async () => {
		const storeFailure = new PlanningPersistenceError("Planning evidence catalog read failed");
		const onPersistenceFailure = vi.fn();
		const registered: RegisteredTool[] = [];
		const extension = createPlanningCommitExtension({
			leaseId: "catalog-store-failure-lease",
			evidence: [],
			listEvidence: () => {
				throw storeFailure;
			},
			onPersistenceFailure,
		});
		(
			extension.extension as unknown as { factory: (pi: { registerTool: (tool: RegisteredTool) => void }) => void }
		).factory({ registerTool: (tool: RegisteredTool) => registered.push(tool) } as never);
		const tool = registered.find((item) => item.name === "planning_list_evidence");
		await expect(tool?.execute("sqlite-read-failure", {})).rejects.toBe(storeFailure);
		expect(onPersistenceFailure).toHaveBeenCalledOnce();
		expect(onPersistenceFailure).toHaveBeenCalledWith(storeFailure);
	});

	it("discovers and reads full same-run evidence from a failed lease without creating new evidence", async () => {
		const root = mkdtempSync(join(tmpdir(), "planning-catalog-read-chain-"));
		const store = await PlanningStore.open(join(root, "planning.sqlite"));
		try {
			store.createRun({
				runId: "catalog-read-run",
				outerTaskId: "catalog-read-outer",
				goal: "find hidden evidence",
				mode: "active",
			});
			store.commitPlan({
				runId: "catalog-read-run",
				expectedRevision: 0,
				rationale: "create a prior failed attempt and a catalog reader",
				idempotencyKey: "catalog-read-plan",
				tasks: [
					{
						taskId: "catalog-source-task",
						objective: "collect hidden evidence",
						doneWhen: "save useful tool output",
						priority: 1,
						sequence: 0,
						dependsOnTaskIds: [],
					},
					{
						taskId: "catalog-reader-task",
						objective: "find the prior evidence",
						doneWhen: "read the original result",
						priority: 1,
						sequence: 1,
						dependsOnTaskIds: [],
					},
				],
			});
			const failedLease = store.leaseTask("catalog-read-run", "catalog-source-task", root, 30_000, 1);
			store.startLease(failedLease.leaseId, 2);
			const originalResult = { stdout: "HISTORICAL ORIGINAL OUTPUT: candidate aurora-493" };
			const captured = captureEvidenceBlob({
				stateDir: root,
				runId: failedLease.runId,
				evidenceId: "hidden-failed-attempt-evidence",
				toolCallId: "historical-tool-call",
				toolName: "bash",
				result: originalResult,
				isError: false,
			});
			store.recordEvidence(
				failedLease.leaseId,
				[
					{
						evidenceId: "hidden-failed-attempt-evidence",
						kind: "tool",
						source: "bash",
						toolName: "bash",
						summary: "success: bash",
						excerpt: "short initial excerpt",
						contentRef: captured.contentRef,
						contentHash: captured.contentHash,
						contentBytes: captured.contentBytes,
						contentComplete: captured.contentComplete,
						isTruncated: !captured.contentComplete,
						metadata: { isError: false },
					},
				],
				3,
			);
			store.sealActiveLease(
				{
					leaseId: failedLease.leaseId,
					source: "runtime_failure",
					stage: "executor",
					code: "executor_timeout",
					message: "the first attempt ended before commit",
				},
				4,
			);
			const activeLease = store.leaseTask("catalog-read-run", "catalog-reader-task", root, 30_000, 5);
			store.startLease(activeLease.leaseId, 6);
			store.createRun({
				runId: "foreign-run",
				outerTaskId: "foreign-outer",
				goal: "separate evidence",
				mode: "active",
			});
			store.commitPlan({
				runId: "foreign-run",
				expectedRevision: 0,
				rationale: "seed evidence outside the reader run",
				idempotencyKey: "foreign-plan",
				tasks: [
					{
						taskId: "foreign-task",
						objective: "collect",
						doneWhen: "saved",
						priority: 1,
						sequence: 0,
						dependsOnTaskIds: [],
					},
				],
			});
			const foreignLease = store.leaseTask("foreign-run", "foreign-task", root, 30_000);
			store.startLease(foreignLease.leaseId);
			store.recordEvidence(foreignLease.leaseId, [
				{
					evidenceId: "foreign-exact-evidence-id",
					kind: "tool",
					source: "fixture",
					summary: "outside this run",
					contentHash: "foreign-hash",
				},
			]);
			const evidenceBefore = store.snapshot("catalog-read-run").evidence.length;
			const extension = createPlanningCommitExtension({
				leaseId: activeLease.leaseId,
				evidence: [],
				listEvidence: (query) => store.listEvidence("catalog-read-run", query),
				readEvidence: (evidenceId, offset, maxBytes, requestId) =>
					store.readEvidence("catalog-read-run", evidenceId, {
						offset,
						maxBytes,
						requestId,
						taskId: activeLease.taskId,
						leaseId: activeLease.leaseId,
					}),
			});
			const registered: RegisteredTool[] = [];
			const extensionFactory = extension.extension as unknown as {
				factory: (pi: { registerTool: (tool: RegisteredTool) => void }) => void;
			};
			extensionFactory.factory({
				on: vi.fn(),
				registerTool: (tool: RegisteredTool) => registered.push(tool),
			} as never);
			const listTool = registered.find((tool) => tool.name === "planning_list_evidence");
			const readTool = registered.find((tool) => tool.name === "planning_read_evidence");
			const missingResponse = (await readTool?.execute("read-missing", {
				evidenceId: "graph-node-not-evidence",
			})) as { content: Array<{ text: string }>; isError: boolean; details: Record<string, unknown> };
			expect(missingResponse).toMatchObject({
				details: { reasonCode: "planning_evidence_not_found", fieldPaths: ["evidenceId"], retryable: true },
			});
			expect(JSON.parse(missingResponse.content[0]?.text ?? "{}")).toMatchObject({
				readState: "not_found",
				recovery: { toolName: "planning_list_evidence", arguments: { limit: 10 } },
			});
			const foreignResponse = (await readTool?.execute("read-foreign", {
				evidenceId: "foreign-exact-evidence-id",
			})) as { details: { retryable: boolean }; content: Array<{ text: string }> };
			expect(foreignResponse.details.retryable).toBe(true);
			expect(foreignResponse.content[0]?.text).not.toContain("outside this run");
			expect(store.listEvidence("catalog-read-run").items.map((item) => item.evidenceId)).not.toContain(
				"foreign-exact-evidence-id",
			);
			const listResponse = (await listTool?.execute("catalog-call", {
				taskId: "catalog-source-task",
				outcome: "success",
				keyword: "short initial excerpt",
			})) as { content: Array<{ text: string }> };
			const listed = JSON.parse(listResponse.content[0]?.text ?? "{}") as {
				items: Array<{
					evidenceId: string;
					taskId: string;
					leaseId: string;
					outcome: string;
					attemptFailed: boolean;
				}>;
			};
			expect(listed.items).toEqual([
				{
					evidenceId: "hidden-failed-attempt-evidence",
					taskId: "catalog-source-task",
					leaseId: failedLease.leaseId,
					source: "bash",
					toolName: "bash",
					createdAt: 3,
					outcome: "success",
					attemptFailed: true,
					description: "success: bash; excerpt: short initial excerpt",
					contentComplete: true,
				},
			]);
			const readResponse = (await readTool?.execute("read-call", {
				evidenceId: listed.items[0]?.evidenceId,
				maxBytes: 64 * 1024,
			})) as { content: Array<{ text: string }> };
			const original = JSON.parse(readResponse.content[0]?.text ?? "{}") as {
				content: string;
				contentComplete: boolean;
			};
			expect(original.content).toContain(originalResult.stdout);
			expect(original.contentComplete).toBe(true);
			expect(store.snapshot("catalog-read-run").evidence).toHaveLength(evidenceBefore);
			expect(
				store
					.listLifecycleEvents("catalog-read-run")
					.events.some((event) => event.type === "planning_evidence_read"),
			).toBe(true);
			expect(() => store.readEvidence("catalog-read-run", "evidence-from-another-run")).toThrow(/not found/u);
		} finally {
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("offers bounded exact IDs after a read miss when the catalog is disabled", async () => {
		const refs = Array.from({ length: 14 }, (_, index) => `tool-complete-evidence-id-${index}`);
		const onPersistenceFailure = vi.fn();
		const extension = createPlanningCommitExtension({
			leaseId: "catalog-off-reader",
			evidence: [],
			availableEvidenceRefs: () => refs,
			readEvidence: (evidenceId) => {
				throw new PlanningEvidenceNotFoundError(evidenceId);
			},
			onPersistenceFailure,
		});
		const registered: RegisteredTool[] = [];
		(
			extension.extension as unknown as { factory: (pi: { registerTool: (tool: RegisteredTool) => void }) => void }
		).factory({ on: vi.fn(), registerTool: (tool: RegisteredTool) => registered.push(tool) } as never);
		expect(registered.some((tool) => tool.name === "planning_list_evidence")).toBe(false);
		const response = (await registered
			.find((tool) => tool.name === "planning_read_evidence")
			?.execute("missing", {
				evidenceId: "short-or-invented",
			})) as { content: Array<{ text: string }>; details: { retryable: boolean } };
		expect(response.details.retryable).toBe(true);
		expect(JSON.parse(response.content[0]?.text ?? "{}").recovery).toEqual({
			availableEvidenceRefs: refs.slice(0, 10),
		});
		expect(onPersistenceFailure).not.toHaveBeenCalled();
	});

	it("does not classify an unrelated read failure by matching its message", async () => {
		const failure = new Error("Planning evidence not found: missing");
		const extension = createPlanningCommitExtension({
			leaseId: "unrelated-read-failure",
			evidence: [],
			readEvidence: () => {
				throw failure;
			},
		});
		const registered: RegisteredTool[] = [];
		(
			extension.extension as unknown as { factory: (pi: { registerTool: (tool: RegisteredTool) => void }) => void }
		).factory({ on: vi.fn(), registerTool: (tool: RegisteredTool) => registered.push(tool) } as never);
		await expect(
			registered
				.find((tool) => tool.name === "planning_read_evidence")
				?.execute("unrelated", { evidenceId: "missing" }),
		).rejects.toBe(failure);
	});

	it("persists a bounded checkpoint without accepting a task result", async () => {
		const recordCheckpoint = vi.fn(async (checkpointId, checkpoint) => ({
			schemaVersion: 1 as const,
			checkpointId,
			runId: "run-tool",
			taskId: "task-tool",
			leaseId: "lease-tool",
			checkpointSequence: 1,
			source: "executor" as const,
			createdAt: 10,
			...checkpoint,
		}));
		const registered: RegisteredTool[] = [];
		const extension = createPlanningCommitExtension({
			leaseId: "lease-tool",
			evidence: [],
			recordCheckpoint,
		});
		const extensionFactory = extension.extension as unknown as {
			factory: (pi: { registerTool: (tool: RegisteredTool) => void }) => void;
		};
		extensionFactory.factory({
			registerTool(tool: RegisteredTool) {
				registered.push(tool);
			},
		} as never);
		const checkpointTool = registered.find((tool) => tool.name === "planning_checkpoint");
		expect(checkpointTool).toBeDefined();
		const response = await checkpointTool?.execute("checkpoint-call-1", {
			summary: "first phase complete",
			evidenceRefs: [],
			completedItems: ["enumerated inputs"],
			remainingItems: ["validate the narrowed candidate"],
			rejectedDirections: [],
			artifacts: [],
			suggestedNextSteps: [
				{ objective: "validate the narrowed candidate", doneWhen: "candidate is checked", inputEvidenceRefs: [] },
			],
		});

		expect(recordCheckpoint).toHaveBeenCalledWith(
			"checkpoint-lease-tool-checkpoint-call-1",
			expect.objectContaining({
				summary: "first phase complete",
				completedItems: ["enumerated inputs"],
			}),
		);
		expect(response).toMatchObject({ details: { accepted: true, checkpointSequence: 1 } });
		expect(extension.getResult()).toBeUndefined();
	});

	it("does not hide checkpoint persistence failures", async () => {
		const failure = new Error("sqlite unavailable");
		const extension = createPlanningCommitExtension({
			leaseId: "lease-tool-failure",
			evidence: [],
			recordCheckpoint: () => {
				throw failure;
			},
		});
		const registered: RegisteredTool[] = [];
		const extensionFactory = extension.extension as unknown as {
			factory: (pi: { registerTool: (tool: RegisteredTool) => void }) => void;
		};
		extensionFactory.factory({
			registerTool(tool: RegisteredTool) {
				registered.push(tool);
			},
		} as never);
		const checkpointTool = registered.find((tool) => tool.name === "planning_checkpoint");
		await expect(
			checkpointTool?.execute("checkpoint-call-failure", {
				summary: "must not be reported as saved",
			}),
		).rejects.toBe(failure);
		expect(extension.getCheckpointFailure?.()).toBe(failure);
	});

	it("keeps a later durable failure visible after an earlier checkpoint validation error", async () => {
		const validationFailure = new PlanningCheckpointValidationError("invalid checkpoint evidence");
		const persistenceFailure = new Error("sqlite write failed after validation was fixed");
		let calls = 0;
		const onPersistenceFailure = vi.fn();
		const extension = createPlanningCommitExtension({
			leaseId: "lease-validation-then-persistence",
			evidence: [],
			recordCheckpoint: () => {
				calls += 1;
				if (calls === 1) throw validationFailure;
				throw persistenceFailure;
			},
			onPersistenceFailure,
		});
		const registered: RegisteredTool[] = [];
		const extensionFactory = extension.extension as unknown as {
			factory: (pi: { registerTool: (tool: RegisteredTool) => void }) => void;
		};
		extensionFactory.factory({ registerTool: (tool: RegisteredTool) => registered.push(tool) } as never);
		const checkpointTool = registered.find((tool) => tool.name === "planning_checkpoint");
		const params = {
			summary: "progress",
			completedItems: [],
			remainingItems: [],
			rejectedDirections: [],
			artifacts: [],
		};

		await expect(checkpointTool?.execute("validation-call", params)).rejects.toBe(validationFailure);
		await expect(checkpointTool?.execute("persistence-call", params)).rejects.toBe(persistenceFailure);
		expect(extension.getCheckpointFailure?.()).toBe(persistenceFailure);
		expect(onPersistenceFailure).toHaveBeenCalledOnce();
		expect(onPersistenceFailure).toHaveBeenCalledWith(persistenceFailure);
	});

	it("records bounded extension-input diagnostics without exposing invalid raw fields", async () => {
		const recordCheckpoint = vi.fn();
		const onCheckpointRejected = vi.fn();
		const extension = createPlanningCommitExtension({
			leaseId: "lease-extension-parse",
			evidence: [],
			recordCheckpoint,
			onCheckpointRejected,
		});
		const registered: RegisteredTool[] = [];
		const extensionFactory = extension.extension as unknown as {
			factory: (pi: { registerTool: (tool: RegisteredTool) => void }) => void;
		};
		extensionFactory.factory({ registerTool: (tool: RegisteredTool) => registered.push(tool) } as never);
		const checkpointTool = registered.find((tool) => tool.name === "planning_checkpoint");
		const privateArtifactPath = "C:\\private\\workspace\\not-for-trace.txt";

		await expect(
			checkpointTool?.execute("parse-call", {
				summary: 42,
				evidenceRefs: ["evidence-valid", { private: "not-an-id" }],
				artifacts: [{ path: privateArtifactPath }],
			}),
		).rejects.toBeInstanceOf(PlanningCheckpointValidationError);

		expect(recordCheckpoint).not.toHaveBeenCalled();
		expect(onCheckpointRejected).toHaveBeenCalledWith(
			"checkpoint-lease-extension-parse-parse-call",
			expect.objectContaining({
				diagnosticLayer: "extension_input",
				reason: "checkpoint_summary_invalid",
				fieldName: "summary",
				scopeDecision: "not_checked",
				evidenceRefs: ["evidence-valid"],
				artifactReferenceHashes: [expect.stringMatching(/^[a-f0-9]{64}$/u)],
			}),
		);
		expect(JSON.stringify(onCheckpointRejected.mock.calls)).not.toContain(privateArtifactPath);
	});

	it("returns an actionable structured correction for malformed evidence references without echoing paths", async () => {
		const recordCheckpoint = vi.fn();
		const onCheckpointRejected = vi.fn();
		const extension = createPlanningCommitExtension({
			leaseId: "lease-extension-evidence-parse",
			evidence: [],
			recordCheckpoint,
			onCheckpointRejected,
		});
		const registered: RegisteredTool[] = [];
		const extensionFactory = extension.extension as unknown as {
			factory: (pi: { registerTool: (tool: RegisteredTool) => void }) => void;
		};
		extensionFactory.factory({ registerTool: (tool: RegisteredTool) => registered.push(tool) } as never);
		const checkpointTool = registered.find((tool) => tool.name === "planning_checkpoint");
		const privatePath = "C:\\private\\workspace\\artifact.bin";
		let failure: unknown;
		try {
			await checkpointTool?.execute("bad-reference", {
				summary: "progress",
				evidenceRefs: [42],
				artifacts: [{ path: privatePath }],
			});
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(PlanningCheckpointValidationError);
		const toolError = JSON.parse((failure as Error).message) as Record<string, unknown>;
		expect(toolError).toMatchObject({
			errorCode: "planning_checkpoint_validation_error",
			reason: "checkpoint_evidence_refs_invalid",
			field: "evidenceRefs[0]",
			scopeDecision: "not_checked",
		});
		expect(toolError.correction).toContain("complete non-empty evidenceId string");
		expect((failure as Error).message).not.toContain(privatePath);
		expect(recordCheckpoint).not.toHaveBeenCalled();
		expect(onCheckpointRejected).toHaveBeenCalledWith(
			"checkpoint-lease-extension-evidence-parse-bad-reference",
			expect.objectContaining({
				diagnosticLayer: "extension_input",
				reason: "checkpoint_evidence_refs_invalid",
				fieldName: "evidenceRefs[0]",
			}),
		);
	});

	it("identifies the nested checkpoint evidence reference that needs correction", async () => {
		const recordCheckpoint = vi.fn();
		const onCheckpointRejected = vi.fn();
		const extension = createPlanningCommitExtension({
			leaseId: "lease-extension-nested-reference",
			evidence: [],
			recordCheckpoint,
			onCheckpointRejected,
		});
		const registered: RegisteredTool[] = [];
		const extensionFactory = extension.extension as unknown as {
			factory: (pi: { registerTool: (tool: RegisteredTool) => void }) => void;
		};
		extensionFactory.factory({ registerTool: (tool: RegisteredTool) => registered.push(tool) } as never);
		const checkpointTool = registered.find((tool) => tool.name === "planning_checkpoint");

		let failure: unknown;
		try {
			await checkpointTool?.execute("bad-nested-reference", {
				summary: "progress",
				suggestedNextSteps: [
					{
						objective: "continue from evidence",
						doneWhen: "the evidence is checked",
						inputEvidenceRefs: [" evidence-1"],
					},
				],
			});
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(PlanningCheckpointValidationError);
		const toolError = JSON.parse((failure as Error).message) as Record<string, unknown>;
		expect(toolError.correction).toContain("suggestedNextSteps[].inputEvidenceRefs");
		expect(toolError.correction).toContain("omit inputEvidenceRefs or use []");
		expect(onCheckpointRejected).toHaveBeenCalledWith(
			"checkpoint-lease-extension-nested-reference-bad-nested-reference",
			expect.objectContaining({
				reason: "checkpoint_evidence_refs_invalid",
				fieldName: "suggestedNextSteps[0].inputEvidenceRefs[0]",
			}),
		);
	});
});
