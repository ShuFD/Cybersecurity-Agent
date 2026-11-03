import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	renderPlanningContext,
	renderPlanningContextWithSummary,
	renderSupervisorContext,
	renderSupervisorContextWithSummary,
} from "../src/planning/context.ts";
import { PLANNING_SCHEMA_VERSION, type PlanningSnapshot, type PlanningTaskLease } from "../src/planning/contracts.ts";
import { PlanningStore } from "../src/planning/store.ts";

function fixture(): { snapshot: PlanningSnapshot; lease: PlanningTaskLease } {
	const runId = "planning_context_priority";
	const taskId = "plan_context_task";
	const leaseId = "lease_context_task";
	const huge = "supplemental-".repeat(2_000);
	return {
		snapshot: {
			run: {
				runId,
				outerTaskId: "outer",
				goal: "continue a failed computation",
				mode: "active",
				status: "running",
				revision: 2,
				createdAt: 1,
				updatedAt: 2,
			},
			tasks: [
				{
					taskId,
					runId,
					objective: "continue computation",
					doneWhen: "a grounded result is committed",
					status: "running",
					priority: 1,
					sequence: 0,
					dependsOnTaskIds: [],
					inputEvidenceRefs: ["failed-attempt-checkpoint"],
					createdAt: 1,
					updatedAt: 2,
					lastError: "previous attempt reached the executor timeout",
				},
			],
			evidence: [
				{
					evidenceId: "failed-attempt-checkpoint",
					runId,
					taskId,
					leaseId,
					kind: "tool",
					source: "bash",
					toolName: "bash",
					summary: "partial computation checkpoint",
					excerpt: "iteration 10 completed",
					contentRef: null,
					contentHash: "checkpoint-hash",
					locator: {},
					contentBytes: 22,
					contentComplete: true,
					isTruncated: false,
					metadata: { attemptFailed: true },
					createdAt: 2,
				},
			],
			executionFrame: {
				runId,
				revision: 2,
				updatedAt: 2,
				frame: {
					schemaVersion: PLANNING_SCHEMA_VERSION,
					taskSummaries: [
						{
							taskId,
							objective: "continue computation",
							outcome: "failed",
							summary: "partial progress retained",
							evidenceRefs: ["failed-attempt-checkpoint"],
							suggestedTasks: [
								{
									objective: "narrow the query",
									doneWhen: "narrowed query is checked",
									inputEvidenceRefs: ["failed-attempt-checkpoint"],
								},
							],
						},
					],
					facts: [],
					rejectedDirections: [],
					openQuestions: [{ questionId: "oversized", text: huge, sourceTaskId: taskId }],
					artifacts: [],
				},
			},
			latestFailure: {
				runId,
				taskId,
				leaseId,
				attempt: 1,
				objective: "continue computation",
				doneWhen: "a grounded result is committed",
				source: "runtime_failure",
				stage: "executor",
				code: "executor_timeout",
				message: "timeout after the first query",
				evidenceRefs: ["failed-attempt-checkpoint"],
				completedItems: ["first query"],
				remainingItems: ["narrow the query"],
				rejectedDirections: [],
				suggestedNextSteps: [{ objective: "narrow the query", doneWhen: "narrowed query is checked" }],
				createdAt: 2,
			},
			latestCheckpoint: {
				schemaVersion: PLANNING_SCHEMA_VERSION,
				checkpointId: "checkpoint-1",
				runId,
				taskId,
				leaseId,
				checkpointSequence: 1,
				source: "executor",
				summary: "first query complete",
				evidenceRefs: ["failed-attempt-checkpoint"],
				completedItems: ["first query"],
				remainingItems: ["narrow the query"],
				rejectedDirections: [],
				artifacts: [
					{
						path: "C:\\work\\partial-artifact.txt",
						type: "text",
						description: "checkpoint-only artifact",
						sha256: "artifact-hash",
					},
				],
				suggestedNextSteps: [{ objective: "narrow the query", doneWhen: "narrowed query is checked" }],
				createdAt: 2,
			},
		},
		lease: {
			schemaVersion: PLANNING_SCHEMA_VERSION,
			leaseId,
			runId,
			taskId,
			planRevision: 2,
			objective: "continue computation",
			doneWhen: "a grounded result is committed",
			allowedScope: "/work",
			issuedAt: 2,
			expiresAt: 3,
		},
	};
}

function durableItems(context: string): Array<Record<string, unknown>> {
	const block = context
		.split(/\n\n(?=# )/u)
		.find((item) => item.startsWith("# Evidence map: raw observations and attributed claims\n"));
	if (!block) return [];
	const parsed = JSON.parse(block.slice(block.indexOf("\n") + 1)) as { items?: Array<Record<string, unknown>> };
	return parsed.items ?? [];
}

function contextEvidenceIds(context: string): Set<string> {
	const references = new Set<string>();
	const collect = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) collect(item);
			return;
		}
		if (typeof value !== "object" || value === null) return;
		for (const [key, item] of Object.entries(value)) {
			if (key === "evidenceId" && typeof item === "string") references.add(item);
			if ((key === "evidenceRefs" || key === "inputEvidenceRefs") && Array.isArray(item)) {
				for (const reference of item) if (typeof reference === "string") references.add(reference);
			}
			collect(item);
		}
	};
	for (const block of context.split(/\n\n(?=# )/u).filter(Boolean)) {
		const newline = block.indexOf("\n");
		if (newline < 0) continue;
		collect(JSON.parse(block.slice(newline + 1)) as unknown);
	}
	return references;
}

function legacyEvidencePrefixIds(snapshot: PlanningSnapshot, taskId: string, maximumBytes: number): string[] {
	// Mechanism-level replay of the prior chronological selection + fixed evidence-prefix budget;
	// this fixture does not claim to reconstruct a historical full prompt byte-for-byte.
	const references = new Set([
		...snapshot.executionFrame.frame.taskSummaries.flatMap((item) => item.evidenceRefs ?? []),
		...snapshot.executionFrame.frame.facts.flatMap((item) => item.evidenceRefs ?? []),
		...snapshot.executionFrame.frame.rejectedDirections.flatMap((item) => item.evidenceRefs ?? []),
		...snapshot.tasks.flatMap((item) => item.inputEvidenceRefs ?? []),
		...(snapshot.latestCheckpoint?.evidenceRefs ?? []),
		...(snapshot.latestFailure?.evidenceRefs ?? []),
	]);
	const selected = new Map<string, (typeof snapshot.evidence)[number]>();
	const add = (evidence: (typeof snapshot.evidence)[number]): void => {
		if (!selected.has(evidence.evidenceId)) selected.set(evidence.evidenceId, evidence);
	};
	for (const item of snapshot.evidence) if (references.has(item.evidenceId)) add(item);
	const dependencyIds = new Set(snapshot.tasks.find((item) => item.taskId === taskId)?.dependsOnTaskIds ?? []);
	for (const item of snapshot.evidence) if (dependencyIds.has(item.taskId)) add(item);
	for (const item of snapshot.evidence.slice(-8)) add(item);

	let remaining = Math.max(0, Math.trunc(maximumBytes * 0.55));
	const rows: Array<Record<string, unknown>> = [];
	for (const item of selected.values()) {
		const base = {
			evidenceId: item.evidenceId,
			taskId: item.taskId,
			kind: item.kind,
			source: item.source,
			summary: item.summary,
			contentHash: item.contentHash,
			contentRef: item.contentRef ?? null,
			locator: item.locator ?? {},
			contentBytes: item.contentBytes ?? 0,
			isTruncated: item.isTruncated === true,
			excerpt: "",
		};
		const baseBytes = Buffer.byteLength(JSON.stringify(base), "utf8");
		const excerptBudget = Math.min(1_024, Math.max(0, remaining - baseBytes - 2));
		const withExcerpt = { ...base, excerpt: item.excerpt.slice(0, excerptBudget) };
		if (Buffer.byteLength(JSON.stringify(withExcerpt), "utf8") <= remaining) {
			rows.push(withExcerpt);
			remaining -= Buffer.byteLength(JSON.stringify(withExcerpt), "utf8");
		} else if (references.has(item.evidenceId) && baseBytes <= remaining) {
			rows.push(base);
			remaining -= baseBytes;
		}
	}

	const jsonLimit =
		Math.trunc(maximumBytes * 0.18) -
		Buffer.byteLength("# Evidence map: raw observations and attributed claims\n", "utf8");
	const prefix: Array<Record<string, unknown>> = [];
	for (const row of rows) {
		if (Buffer.byteLength(JSON.stringify({ items: [...prefix, row] }), "utf8") > jsonLimit) break;
		prefix.push(row);
	}
	return prefix.map((item) => String(item.evidenceId));
}

function evidenceHandoffFixture(): { snapshot: PlanningSnapshot; lease: PlanningTaskLease } {
	const { snapshot, lease } = fixture();
	const sourceTaskId = "plan_source_attachments";
	const failedTaskId = "plan_failed_probe";
	const currentTaskId = "plan_retry_consumer";
	const sourceLeaseId = "lease_source_attachments";
	const failedLeaseId = "lease_failed_probe";
	const currentLeaseId = "lease_retry_consumer_current";
	const evidence = (
		evidenceId: string,
		taskId: string,
		leaseId: string,
		createdAt: number,
		summary: string,
		excerpt: string,
	) => ({
		evidenceId,
		runId: snapshot.run.runId,
		taskId,
		leaseId,
		kind: "tool" as const,
		source: "fixture-tool",
		toolName: "fixture-tool",
		summary,
		excerpt,
		contentRef: null,
		contentHash: `hash-${evidenceId}`,
		locator: {},
		contentBytes: excerpt.length,
		contentComplete: true,
		isTruncated: false,
		metadata: {},
		createdAt,
	});
	const errorRefs = ["error-from-old-attempt-a", "error-from-old-attempt-b"];
	const dependencyRefs = ["attachment-output-a", "attachment-output-b"];
	const currentRefs = ["current-retry-tool-output"];
	snapshot.evidence = [
		evidence(errorRefs[0]!, failedTaskId, failedLeaseId, 1, "prior command error", "E".repeat(180)),
		evidence(errorRefs[1]!, failedTaskId, failedLeaseId, 2, "prior command error", "F".repeat(180)),
		evidence(dependencyRefs[0]!, sourceTaskId, sourceLeaseId, 3, "persisted attachment result", "A".repeat(600)),
		evidence(dependencyRefs[1]!, sourceTaskId, sourceLeaseId, 4, "persisted attachment result", "B".repeat(600)),
		evidence(
			currentRefs[0]!,
			currentTaskId,
			currentLeaseId,
			5,
			"current retry observation",
			"current attempt output",
		),
	];
	snapshot.tasks = [
		{
			taskId: sourceTaskId,
			runId: snapshot.run.runId,
			objective: "persist the supplied attachments",
			doneWhen: "attachment evidence is available",
			status: "done",
			priority: 1,
			sequence: 0,
			dependsOnTaskIds: [],
			createdAt: 1,
			updatedAt: 2,
		},
		{
			taskId: failedTaskId,
			runId: snapshot.run.runId,
			objective: "run the initial probe",
			doneWhen: "the probe result is assessed",
			status: "failed",
			priority: 1,
			sequence: 1,
			dependsOnTaskIds: [sourceTaskId],
			createdAt: 2,
			updatedAt: 3,
			lastError: "prior executor attempt timed out",
		},
		{
			taskId: currentTaskId,
			runId: snapshot.run.runId,
			objective: "continue from the attachment results after the failed probe",
			doneWhen: "the saved input is checked and a result is committed",
			status: "running",
			priority: 1,
			sequence: 2,
			dependsOnTaskIds: [sourceTaskId],
			inputEvidenceRefs: [],
			createdAt: 3,
			updatedAt: 4,
			lastError: "prior executor attempt timed out",
		},
	];
	snapshot.executionFrame.frame.taskSummaries = [
		{
			taskId: sourceTaskId,
			objective: "persist the supplied attachments",
			outcome: "done",
			summary: "two attachment outputs were persisted",
			evidenceRefs: dependencyRefs,
		},
		{
			taskId: failedTaskId,
			objective: "run the initial probe",
			outcome: "failed",
			summary: "the probe timed out after producing two diagnostic results",
			evidenceRefs: errorRefs,
		},
	];
	snapshot.latestFailure = {
		runId: snapshot.run.runId,
		taskId: failedTaskId,
		leaseId: failedLeaseId,
		attempt: 1,
		objective: "run the initial probe",
		doneWhen: "the probe result is assessed",
		source: "runtime_failure",
		stage: "executor",
		code: "executor_timeout",
		message: "the earlier attempt timed out after its initial method failed",
		evidenceRefs: errorRefs,
		completedItems: ["collected the attachment evidence"],
		remainingItems: ["use the saved attachment output"],
		rejectedDirections: [],
		suggestedNextSteps: [],
		createdAt: 3,
	};
	snapshot.latestCheckpoint = undefined;
	return {
		snapshot,
		lease: {
			...lease,
			taskId: currentTaskId,
			leaseId: currentLeaseId,
			objective: "continue from the attachment results after the failed attempt",
			doneWhen: "the saved input is checked and a result is committed",
		},
	};
}

describe("planning context priority", () => {
	it("attributes Observer notes only to a durable result from the same lease", async () => {
		const store = await PlanningStore.open(":memory:");
		const runId = "observer-settlement-attribution-run";
		store.createRun({ runId, outerTaskId: "outer", goal: "inspect a task across retries", mode: "active" }, 1);
		store.commitPlan(
			{
				runId,
				expectedRevision: 0,
				rationale: "seed one retryable task",
				idempotencyKey: "observer-settlement-attribution-plan",
				tasks: [
					{
						taskId: "shared-observer-task",
						objective: "inspect a path",
						doneWhen: "report the result",
						priority: 1,
						sequence: 0,
						dependsOnTaskIds: [],
					},
				],
			},
			2,
		);
		try {
			const firstLease = store.leaseTask(runId, "shared-observer-task", "/work", 30_000, 3);
			store.startLease(firstLease.leaseId, 4);
			const firstNote = JSON.stringify({
				semanticReportGenerated: false,
				status: "first lease runtime handoff",
				failure: { stage: "executor", code: "executor_timeout", message: "the first attempt ended early" },
			});
			store.recordObservation(
				firstLease.leaseId,
				"planning_observer_runtime",
				firstNote,
				{ semanticReportGenerated: false, evidenceRefs: [] },
				5,
			);
			store.recoverActiveLease(runId, "the first attempt expired before it could commit", 6);

			const secondLease = store.leaseTask(runId, "shared-observer-task", "/work", 30_000, 7);
			store.startLease(secondLease.leaseId, 8);
			const secondNote = JSON.stringify({ semanticReportGenerated: false, status: "second lease runtime handoff" });
			store.recordObservation(
				secondLease.leaseId,
				"planning_observer_runtime",
				secondNote,
				{ semanticReportGenerated: false, evidenceRefs: [] },
				9,
			);
			const secondReport = JSON.stringify({
				semanticReportGenerated: true,
				observerJudgments: [{ text: "The second attempt inspected its path", evidenceIds: [] }],
			});
			store.recordObservation(
				secondLease.leaseId,
				"planning_observer_report",
				secondReport,
				{ semanticReportGenerated: true, evidenceRefs: [] },
				9.5,
			);
			const resultSummary = "The second lease committed the durable result";
			store.commitResult(
				{
					leaseId: secondLease.leaseId,
					planRevision: secondLease.planRevision,
					result: {
						schemaVersion: PLANNING_SCHEMA_VERSION,
						leaseId: secondLease.leaseId,
						outcome: "done",
						summary: resultSummary,
						suggestedTasks: [],
						flagCandidates: [],
					},
					evidence: [
						{
							evidenceId: "second-lease-successful-tool-evidence",
							kind: "tool",
							source: "bash",
							toolName: "bash",
							summary: "success: bash",
							contentHash: "tool-content-hash",
							metadata: { isError: false },
						},
						{
							evidenceId: "second-lease-durable-result-marker",
							kind: "observation",
							source: "planning-task-result",
							summary: resultSummary,
							contentHash: createHash("sha256").update(resultSummary).digest("hex"),
							metadata: { outcome: "done" },
						},
					],
				},
				10,
			);

			const context = renderSupervisorContext(store.snapshot(runId), 12_000);
			expect(context).toContain(firstLease.leaseId);
			expect(context).toContain(secondLease.leaseId);
			expect(context).toContain("task_level_durable_result_present_unattributed_to_attempt");
			expect(context).toContain("the first attempt ended early");
			expect(context).toContain("durable_task_result_present_for_same_attempt");
			expect(context).toContain(resultSummary);
		} finally {
			store.close();
		}
	});

	it("shows persisted Observer reports and their cited evidence to the next Supervisor", () => {
		const { snapshot } = fixture();
		const evidenceId = snapshot.evidence[0]?.evidenceId ?? "";
		const report = {
			attempted: ["inspect the input parser"],
			observedResults: [{ text: "The parser rejected the malformed input", evidenceIds: [evidenceId] }],
			supportedConclusions: [{ text: "The parser reached its validation branch", evidenceIds: [evidenceId] }],
			unverifiedHypotheses: ["A nearby branch may be reachable"],
			failuresOrStalls: ["The wider binary was not analyzed"],
			avoidRepeating: ["Do not rerun the same malformed input"],
			openQuestions: ["Is the accepted format documented elsewhere?"],
		};
		const summary = JSON.stringify(report);
		snapshot.evidence.push({
			evidenceId: "observer-report-evidence",
			runId: snapshot.run.runId,
			taskId: snapshot.tasks[0]?.taskId ?? "",
			leaseId: "observer-lease",
			kind: "observation",
			source: "planning_observer_report",
			toolName: "planning_observer_report",
			summary,
			excerpt: summary,
			contentRef: null,
			contentHash: "observer-report-hash",
			locator: {},
			contentBytes: Buffer.byteLength(summary, "utf8"),
			contentComplete: true,
			isTruncated: false,
			metadata: { semanticReportGenerated: true, evidenceRefs: [evidenceId] },
			createdAt: 3,
		});

		const context = renderSupervisorContext(snapshot, 8_192);
		expect(context).toContain("observerProgressNotes");
		expect(context).toContain("observer-report-evidence");
		expect(context).toContain("A nearby branch may be reachable");
		expect(context).toContain("observer_judgment");
		expect(context).toContain("same_run_readable_only");
		expect(context).toContain("not_performed");
		expect(context).toContain("observerJudgments");
		expect(context).not.toContain("supportedConclusions");
		expect(context).toContain("Observer judgment; readable references do not verify meaning.");
		expect(contextEvidenceIds(context)).toContain(evidenceId);
	});

	it("shows a short-attempt runtime fallback and its full evidence reference to the next Supervisor", () => {
		const { snapshot } = fixture();
		const evidenceId = "short-attempt-evidence-full-id-0123456789";
		const sourceEvidence = snapshot.evidence[0]!;
		const summary = JSON.stringify({
			semanticReportGenerated: false,
			status: "Observer semantic report not generated",
			runId: snapshot.run.runId,
			taskId: sourceEvidence.taskId,
			leaseId: sourceEvidence.leaseId,
			timeline: [{ type: "executor_tool_execution_end", toolName: "bash" }],
			toolEvidenceIds: [evidenceId],
			lastCheckpoint: null,
		});
		snapshot.evidence.push({
			...sourceEvidence,
			evidenceId: "short-attempt-observer-fallback",
			kind: "observation",
			source: "planning_observer_runtime",
			toolName: "planning_observer_runtime",
			summary,
			excerpt: summary,
			metadata: { semanticReportGenerated: false, evidenceRefs: [evidenceId] },
			createdAt: 4,
		});

		const context = renderSupervisorContext(snapshot, 8_192);
		expect(context).toContain("runtime_progress_fallback");
		expect(context).toContain(evidenceId);
		expect(context).toContain("Runtime handoff; not task settlement or proof.");
		expect(context).toContain("attempt_sealed_without_durable_task_result");
	});

	it("shows stored Executor results, attributed facts, rejected directions, and open questions to the Supervisor", () => {
		const { snapshot } = fixture();
		const taskId = snapshot.tasks[0]!.taskId;
		snapshot.executionFrame.frame.taskSummaries = [
			{
				taskId,
				objective: "test nonce reuse",
				outcome: "disproved",
				summary: "Two captures produced different nonce values.",
				evidenceRefs: ["failed-attempt-checkpoint"],
			},
		];
		snapshot.executionFrame.frame.facts = [
			{
				sourceTaskId: taskId,
				key: "nonce_reuse",
				value: "not observed in the two captures",
				evidenceRefs: ["failed-attempt-checkpoint"],
			},
		];
		snapshot.executionFrame.frame.rejectedDirections = [
			{
				sourceTaskId: taskId,
				direction: "assume the nonce is fixed",
				reason: "the two captured values differ",
				evidenceRefs: ["failed-attempt-checkpoint"],
			},
		];
		snapshot.executionFrame.frame.openQuestions = [
			{ sourceTaskId: taskId, questionId: "counter-reset", text: "Does the counter reset after restart?" },
		];

		const context = renderSupervisorContext(snapshot, 8_192);
		expect(context).toContain("storedExecutorResults");
		expect(context).toContain("Executor declaration stored by Planning Store; not a Verifier proof");
		expect(context).toContain("Two captures produced different nonce values.");
		expect(context).toContain(
			"Executor-declared fact; structurally stored, semantic truth not independently verified",
		);
		expect(context).toContain("Executor-declared rejected direction; check its cited raw tool evidence");
		expect(context).toContain("Executor-declared open question");
		expect(context).toContain("verifierProofMeaning");
		expect(context).not.toContain("supportedConclusions");
	});

	it("reproduces the chronological-prefix omission and presents empty-reference dependency evidence first", () => {
		const { snapshot, lease } = evidenceHandoffFixture();
		const maximumBytes = 8_192;
		const legacyIds = legacyEvidencePrefixIds(snapshot, lease.taskId, maximumBytes);
		expect(snapshot.tasks.find((task) => task.taskId === lease.taskId)?.inputEvidenceRefs).toEqual([]);
		expect(legacyIds).toContain("error-from-old-attempt-a");
		expect(legacyIds).toContain("error-from-old-attempt-b");
		expect(legacyIds).not.toContain("attachment-output-a");

		const executor = renderPlanningContextWithSummary(snapshot, lease, maximumBytes);
		const executorItems = durableItems(executor.text);
		const executorIds = executorItems.map((item) => String(item.evidenceId));
		expect(Buffer.byteLength(executor.text, "utf8")).toBeLessThanOrEqual(maximumBytes);
		expect(executorIds).toContain("attachment-output-a");
		expect(executorIds).toContain("attachment-output-b");
		expect(executorIds.indexOf("attachment-output-a")).toBeLessThan(executorIds.indexOf("error-from-old-attempt-a"));
		expect(executor.summary.evidenceRefsPresented).toContain("current-retry-tool-output");
		expect(new Set(executorIds).size).toBe(executorIds.length);
		expect(executor.text).toContain("executor_timeout");
		expect(executor.text).toContain("the earlier attempt timed out after its initial method failed");
		expect(executor.summary.evidenceRefsPresented).toContain("error-from-old-attempt-a");
		expect(executor.summary.evidenceRefsSummaryPresented).toEqual(
			executorItems
				.filter((item) => item.detailLevel === "summary")
				.map((item) => String(item.evidenceId))
				.sort(),
		);

		const supervisor = renderSupervisorContextWithSummary(snapshot, maximumBytes);
		const supervisorIds = durableItems(supervisor.text).map((item) => String(item.evidenceId));
		expect(supervisorIds.slice(0, 2)).toEqual(["error-from-old-attempt-a", "error-from-old-attempt-b"]);
		expect(supervisor.text).toContain("executor_timeout");
	});

	it("selects evidence from the exact active task lease as current-task evidence", () => {
		const { snapshot, lease } = evidenceHandoffFixture();
		snapshot.evidence = [snapshot.evidence.find((item) => item.evidenceId === "current-retry-tool-output")!];
		snapshot.latestFailure = undefined;
		snapshot.latestCheckpoint = undefined;
		snapshot.executionFrame.frame.taskSummaries = [];
		snapshot.executionFrame.frame.facts = [];
		snapshot.executionFrame.frame.rejectedDirections = [];
		snapshot.tasks.find((task) => task.taskId === lease.taskId)!.dependsOnTaskIds = [];

		const rows = durableItems(renderPlanningContext(snapshot, lease, 8_192));
		expect(rows).toEqual([
			expect.objectContaining({ evidenceId: "current-retry-tool-output", priority: "current_task_evidence" }),
		]);
	});

	it("does not render evidence bodies from another run even if a foreign ID is referenced", () => {
		const { snapshot, lease } = fixture();
		const foreignEvidenceId = "foreign-run-evidence";
		snapshot.tasks[0]!.inputEvidenceRefs = [foreignEvidenceId];
		snapshot.evidence.push({
			...snapshot.evidence[0]!,
			evidenceId: foreignEvidenceId,
			runId: "another-planning-run",
			summary: "foreign run summary must not leak",
			excerpt: "FOREIGN_RUN_BODY_MUST_NOT_APPEAR",
		});

		const rendered = renderPlanningContextWithSummary(snapshot, lease, 4_096);

		expect(durableItems(rendered.text).map((item) => item.evidenceId)).not.toContain(foreignEvidenceId);
		expect(rendered.text).not.toContain("FOREIGN_RUN_BODY_MUST_NOT_APPEAR");
		expect(rendered.summary.evidenceRefsOmitted).toContain(foreignEvidenceId);
	});

	it("keeps the higher-priority complete reference and degrades lower history to reference-only", () => {
		const { snapshot, lease } = fixture();
		const explicitId = "x".repeat(256);
		const recentId = "recent-history-evidence";
		snapshot.evidence = [
			{
				...snapshot.evidence[0]!,
				evidenceId: explicitId,
				summary: "explicit",
				excerpt: "explicit body",
				createdAt: 1,
			},
			{ ...snapshot.evidence[0]!, evidenceId: recentId, summary: "recent", excerpt: "recent body", createdAt: 2 },
		];
		snapshot.tasks[0]!.inputEvidenceRefs = [explicitId];

		const rendered = renderPlanningContextWithSummary(snapshot, lease, 4_096);
		const rows = durableItems(rendered.text);
		expect(rows.map((item) => item.evidenceId)).toContain(explicitId);
		expect(rendered.summary.evidenceRefsPresented).toContain(recentId);
		expect(rendered.summary.evidenceRefsPresented).toContain(explicitId);
		expect(rows.find((item) => item.evidenceId === recentId)?.detailLevel).toBe("summary");
	});

	it("selects all fitting compact input references before expanding optional metadata", () => {
		const { snapshot, lease } = fixture();
		const baseEvidence = snapshot.evidence[0];
		if (!baseEvidence) throw new Error("Fixture must contain an evidence row");
		const firstId = "explicit-evidence-first";
		const secondId = "explicit-evidence-second";
		const firstSummary = '"'.repeat(144);
		const first = {
			...baseEvidence,
			evidenceId: firstId,
			source: "fixture-source-that-uses-optional-bytes",
			summary: firstSummary,
			excerpt: "first evidence body",
			contentHash: "h".repeat(64),
			createdAt: 1,
		};
		const second = {
			...baseEvidence,
			evidenceId: secondId,
			source: "fixture-source-that-uses-optional-bytes",
			summary: "short second summary",
			excerpt: "second evidence body",
			contentHash: "i".repeat(64),
			createdAt: 2,
		};
		snapshot.evidence = [first, second];
		snapshot.tasks[0]!.inputEvidenceRefs = [firstId, secondId];
		snapshot.latestFailure = undefined;
		snapshot.latestCheckpoint = undefined;
		snapshot.executionFrame.frame.taskSummaries = [];
		snapshot.executionFrame.frame.facts = [];
		snapshot.executionFrame.frame.rejectedDirections = [];

		const compactRow = (item: typeof first | typeof second) => ({
			evidenceId: item.evidenceId,
			taskId: item.taskId,
			leaseId: item.leaseId,
			priority: "explicit_task_input",
			kind: item.kind,
			source: item.source.slice(0, 24),
			description: item.summary.slice(0, 48),
			detailLevel: "reference_only",
		});
		const fullFirstRow = {
			evidenceId: first.evidenceId,
			taskId: first.taskId,
			leaseId: first.leaseId,
			priority: "explicit_task_input",
			kind: first.kind,
			source: first.source.slice(0, 64),
			description: first.summary.slice(0, 144),
			contentHash: first.contentHash,
			contentBytes: first.contentBytes,
			isTruncated: false,
			detailLevel: "reference_only",
		};
		const evidenceJsonBudget =
			Math.trunc(4_096 * 0.3) -
			Buffer.byteLength("# Evidence map: raw observations and attributed claims\n", "utf8");
		expect(
			Buffer.byteLength(JSON.stringify({ items: [compactRow(first), compactRow(second)] }), "utf8"),
		).toBeLessThanOrEqual(evidenceJsonBudget);
		expect(
			Buffer.byteLength(JSON.stringify({ items: [fullFirstRow, compactRow(second)] }), "utf8"),
		).toBeLessThanOrEqual(evidenceJsonBudget);

		const rendered = renderPlanningContextWithSummary(snapshot, lease, 4_096);
		const visibleIds = durableItems(rendered.text).map((item) => item.evidenceId);
		expect(Buffer.byteLength(rendered.text, "utf8")).toBeLessThanOrEqual(4_096);
		expect(visibleIds).toEqual([firstId, secondId]);
		expect(rendered.summary.evidenceRefsPresented).toEqual([firstId, secondId]);
		expect(rendered.summary.evidenceRefsOmitted).not.toContain(secondId);
	});

	it("prioritizes explicit input refs, deduplicates repeated sources, and stabilizes equal-time dependencies", () => {
		const { snapshot, lease } = evidenceHandoffFixture();
		snapshot.evidence[2]!.createdAt = 9;
		snapshot.evidence[3]!.createdAt = 9;
		const task = snapshot.tasks.find((item) => item.taskId === lease.taskId)!;
		task.inputEvidenceRefs = ["error-from-old-attempt-a"];
		snapshot.latestCheckpoint = {
			schemaVersion: PLANNING_SCHEMA_VERSION,
			checkpointId: "checkpoint-repeat",
			runId: snapshot.run.runId,
			taskId: lease.taskId,
			leaseId: "lease-retry-consumer-current",
			checkpointSequence: 1,
			source: "executor",
			summary: "one evidence is repeated across durable fields",
			evidenceRefs: ["error-from-old-attempt-a", "attachment-output-a"],
			completedItems: [],
			remainingItems: [],
			rejectedDirections: [],
			artifacts: [],
			suggestedNextSteps: [],
			createdAt: 9,
		};
		const rendered = renderPlanningContextWithSummary(snapshot, lease, 8_192);
		const repeated = renderPlanningContextWithSummary(snapshot, lease, 8_192);
		const rows = durableItems(rendered.text);
		const ids = rows.map((item) => String(item.evidenceId));
		expect(repeated.text).toBe(rendered.text);
		expect(ids[0]).toBe("error-from-old-attempt-a");
		expect(ids.indexOf("attachment-output-a")).toBeLessThan(ids.indexOf("attachment-output-b"));
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("retains a complete reference without an excerpt when body text has no remaining budget", () => {
		const { snapshot, lease } = fixture();
		const referenceOnlyId = `evidence-${"id".repeat(72)}`;
		const summary = '"'.repeat(144);
		snapshot.evidence = [
			{
				...snapshot.evidence[0]!,
				evidenceId: referenceOnlyId,
				summary,
				excerpt: "persisted full body remains available by evidenceId ".repeat(40),
				source: "fixture-source",
				createdAt: 1,
			},
		];
		snapshot.tasks[0]!.inputEvidenceRefs = [referenceOnlyId];
		const minimalReference = {
			evidenceId: referenceOnlyId,
			taskId: snapshot.evidence[0]!.taskId,
			leaseId: snapshot.evidence[0]!.leaseId,
			priority: "explicit_task_input",
			kind: snapshot.evidence[0]!.kind,
			sourceRole: "raw_tool_observation",
			createdAt: snapshot.evidence[0]!.createdAt,
			detailLevel: "reference_only",
		};
		const evidenceJsonBytes = Buffer.byteLength(
			JSON.stringify({
				items: [minimalReference],
				listStatus: {
					candidateCount: 1,
					knownCount: 1,
					presentedCount: 1,
					omittedKnownCount: 0,
					unresolvedCount: 0,
					complete: true,
					note: "Priority subset only; omitted does not mean absent.",
				},
				sourceRoles: {
					rawTool: "tool observation",
					executor: "Executor claim",
					observer: "Observer judgment; interpretation unverified",
					verifier: "host proof",
				},
			}),
			"utf8",
		);
		const maximumBytes = Math.max(
			2_560,
			Math.ceil(
				(evidenceJsonBytes +
					Buffer.byteLength("# Evidence map: raw observations and attributed claims\n", "utf8")) /
					0.3,
			),
		);
		const rendered = renderPlanningContextWithSummary(snapshot, lease, maximumBytes);
		const row = durableItems(rendered.text).find((item) => item.evidenceId === referenceOnlyId);
		expect(Buffer.byteLength(rendered.text, "utf8")).toBeLessThanOrEqual(maximumBytes);
		expect(row).toMatchObject({ evidenceId: referenceOnlyId, detailLevel: "reference_only" });
		expect(row).not.toHaveProperty("excerpt");
		expect(snapshot.evidence[0]!.excerpt).toContain("persisted full body remains available");
		expect(rendered.summary.evidenceRefsReferenceOnly).toContain(referenceOnlyId);
		expect(rendered.summary.evidenceRefsSummaryPresented).not.toContain(referenceOnlyId);
	});

	it("marks a byte-limited multibyte excerpt instead of presenting an unlabeled fragment", () => {
		const { snapshot, lease } = fixture();
		const evidenceId = "multibyte-excerpt-evidence";
		snapshot.evidence = [
			{
				...snapshot.evidence[0]!,
				evidenceId,
				summary: "large fixture output",
				excerpt: '初始观察🙂\\路径"值'.repeat(600),
				contentBytes: 12_000,
				createdAt: 1,
			},
		];
		snapshot.tasks[0]!.inputEvidenceRefs = [evidenceId];
		const rendered = renderPlanningContextWithSummary(snapshot, lease, 4_096);
		const row = durableItems(rendered.text).find((item) => item.evidenceId === evidenceId);
		expect(Buffer.byteLength(rendered.text, "utf8")).toBeLessThanOrEqual(4_096);
		expect(row?.detailLevel).toBe("summary");
		expect(row?.excerpt).toContain("[context truncated]");
	});

	it("keeps failure, checkpoint, evidence and artifact references in near-budget nested multibyte contexts", () => {
		const { snapshot, lease } = fixture();
		const huge = "诊断🙂".repeat(2_000);
		snapshot.latestFailure!.message = huge;
		snapshot.latestFailure!.completedItems = Array.from({ length: 16 }, (_, index) => `${index}:${huge}`);
		snapshot.latestCheckpoint!.summary = huge;
		snapshot.latestCheckpoint!.artifacts[0]!.description = huge;
		snapshot.evidence[0]!.summary = huge;
		snapshot.evidence[0]!.locator = { nested: { values: [huge, { detail: huge }] } };
		const longObjective = "目标🙂".repeat(2_000);
		const contexts = [
			renderPlanningContext(snapshot, { ...lease, objective: longObjective, doneWhen: longObjective }, 4_096),
			renderSupervisorContext(
				{
					...snapshot,
					latestFailure: { ...snapshot.latestFailure!, objective: longObjective, doneWhen: longObjective },
				},
				4_096,
			),
		];
		for (const context of contexts) {
			const bytes = Buffer.byteLength(context, "utf8");
			expect(bytes).toBeLessThanOrEqual(4_096);
			expect(bytes).toBeGreaterThan(2_500);
			const blocks = context.split(/\n\n(?=# )/u);
			for (const block of blocks) {
				const value = JSON.parse(block.slice(block.indexOf("\n") + 1)) as Record<string, unknown>;
				expect(value).toBeTruthy();
			}
			const identity = JSON.parse(blocks[0]!.slice(blocks[0]!.indexOf("\n") + 1)) as Record<string, unknown>;
			expect(identity).toMatchObject({
				runId: "planning_context_priority",
				taskId: "plan_context_task",
				leaseId: "lease_context_task",
				revision: 2,
			});
			expect(String(identity.objective)).toContain("context truncated");
			expect(String(identity.doneWhen)).toContain("context truncated");
			expect(context).toContain("executor_timeout");
			expect(context).toContain("checkpoint-1");
			expect(context).toContain("failed-attempt-checkpoint");
			expect(context).toContain("partial-artifact.txt");
			expect(context).toContain("artifact-hash");
			const progressBlock = blocks.find((block) => block.startsWith("# Progress and proposed next steps\n"));
			expect(progressBlock).toBeDefined();
			const progress = JSON.parse(progressBlock!.slice(progressBlock!.indexOf("\n") + 1)) as Record<string, unknown>;
			expect(progress.remainingItems).toContain("narrow the query");
			expect(progress.suggestedNextSteps).toEqual(
				expect.arrayContaining([expect.objectContaining({ objective: "narrow the query" })]),
			);
		}
	});
	it("keeps current failure and failed-attempt evidence ahead of oversized supplemental state", () => {
		const { snapshot, lease } = fixture();
		const context = renderPlanningContext(snapshot, lease, 4_096);

		expect(Buffer.byteLength(context, "utf8")).toBeLessThanOrEqual(4_128);
		expect(context).toContain("timeout after the first query");
		expect(context).toContain("failed-attempt-checkpoint");
		expect(context).toContain("narrow the query");
		expect(context.indexOf("failed-attempt-checkpoint")).toBeLessThan(context.indexOf("Supplemental planning state"));
	});

	it("keeps evidence ids and task failure state in the bounded Supervisor context", () => {
		const { snapshot } = fixture();
		const context = renderSupervisorContext(snapshot, 4_096);

		expect(context).toContain("failed-attempt-checkpoint");
		expect(context).toContain("timeout after the first query");
		expect(context).toContain("plan_context_task");
		expect(context).toContain("executor_timeout");
		expect(context).toContain("narrow the query");
	});

	it("keeps bounded structured blocks and checkpoint artifacts under a multibyte budget", () => {
		const { snapshot, lease } = fixture();
		const longLease = {
			...lease,
			objective: "目标".repeat(2_000),
			doneWhen: "验收".repeat(2_000),
		};
		const maximumBytes = 4_096;
		const executorContext = renderPlanningContext(snapshot, longLease, maximumBytes);
		const supervisorContext = renderSupervisorContext(snapshot, maximumBytes);
		const encodedArtifactPath = "C:\\work\\partial-artifact.txt".replaceAll("\\", "\\\\");

		for (const context of [executorContext, supervisorContext]) {
			expect(Buffer.byteLength(context, "utf8")).toBeLessThanOrEqual(maximumBytes);
			const blocks = context.split(/\n\n(?=# )/u);
			expect(blocks.length).toBeGreaterThanOrEqual(3);
			for (const block of blocks) {
				const newline = block.indexOf("\n");
				expect(newline).toBeGreaterThan(0);
				expect(() => JSON.parse(block.slice(newline + 1))).not.toThrow();
			}
			expect(context).toContain("planning_context_priority");
			expect(context).toContain("plan_context_task");
			expect(context).toContain("lease_context_task");
			expect(context).toContain(encodedArtifactPath);
			expect(context).toContain("artifact-hash");
			expect(context).toContain("sourceCheckpointId");
		}

		const identityBlock = executorContext.split(/\n\n(?=# )/u)[0] ?? "";
		const identity = JSON.parse(identityBlock.slice(identityBlock.indexOf("\n") + 1)) as Record<string, unknown>;
		expect(identity.runId).toBe("planning_context_priority");
		expect(identity.taskId).toBe("plan_context_task");
		expect(identity.leaseId).toBe("lease_context_task");
		expect(String(identity.objective)).toContain("context truncated");
		expect(String(identity.doneWhen)).toContain("context truncated");
	});

	it("summarizes exactly which evidence and checkpoint references survive each rendered context budget", () => {
		const { snapshot, lease } = fixture();
		const extraEvidence = Array.from({ length: 80 }, (_, index) => ({
			...snapshot.evidence[0]!,
			evidenceId: `evidence-${index.toString().padStart(3, "0")}`,
			summary: `safe summary ${index}`,
			excerpt: `bounded excerpt ${index}`,
			contentHash: `hash-${index}`,
		}));
		snapshot.evidence = extraEvidence;
		snapshot.tasks[0]!.inputEvidenceRefs = extraEvidence.map((item) => item.evidenceId);
		snapshot.latestFailure!.evidenceRefs = extraEvidence.map((item) => item.evidenceId);
		snapshot.latestCheckpoint!.evidenceRefs = extraEvidence.map((item) => item.evidenceId);
		const maximumBytes = 8_192;
		const executor = renderPlanningContextWithSummary(snapshot, lease, maximumBytes);
		const supervisor = renderSupervisorContextWithSummary(snapshot, maximumBytes);

		for (const rendered of [executor, supervisor]) {
			const items = durableItems(rendered.text);
			const actualEvidenceIds = contextEvidenceIds(rendered.text);
			const summaryRefs = items
				.filter((item) => item.detailLevel === "summary")
				.map((item) => String(item.evidenceId))
				.sort();
			expect(Buffer.byteLength(rendered.text, "utf8")).toBeLessThanOrEqual(maximumBytes);
			expect(rendered.summary.contextBytes).toBe(Buffer.byteLength(rendered.text, "utf8"));
			expect(rendered.summary.contextLimitBytes).toBe(maximumBytes);
			expect(rendered.summary.evidenceRefsCandidateCount).toBeGreaterThan(64);
			expect(rendered.summary.evidenceRefsPresented.length).toBeGreaterThan(0);
			expect(rendered.summary.evidenceRefsReferenceOnlyCount).toBeGreaterThan(0);
			for (const id of rendered.summary.evidenceRefsPresented) expect(actualEvidenceIds.has(id)).toBe(true);
			for (const id of rendered.summary.evidenceRefsOmitted)
				expect(durableItems(rendered.text).some((item) => item.evidenceId === id)).toBe(false);
			expect(rendered.summary.evidenceRefsSummaryPresented).toEqual(summaryRefs);
			expect(rendered.summary.evidenceRefsSummaryPresentedCount).toBe(summaryRefs.length);
			expect(rendered.summary.evidenceRefsSummaryPresented.every((id) => summaryRefs.includes(id))).toBe(true);
			expect(rendered.summary.evidenceRefsReferenceOnly.every((id) => !summaryRefs.includes(id))).toBe(true);
			expect(
				rendered.summary.evidenceRefsSummaryPresentedCount + rendered.summary.evidenceRefsReferenceOnlyCount,
			).toBe(rendered.summary.evidenceRefsPresentedCount);
			expect(rendered.summary.evidenceRefsPresentedCount + rendered.summary.evidenceRefsOmittedCount).toBe(
				rendered.summary.evidenceRefsCandidateCount,
			);
			expect(rendered.summary.evidenceRefsOmittedCount).toBeGreaterThan(0);
			expect(rendered.summary.checkpointRefsPresented).toContain("checkpoint-1");
			expect(rendered.summary.identityBlockBytes).toBeGreaterThan(0);
			expect(rendered.summary.evidenceBlockBytes).toBeGreaterThan(0);
			expect(rendered.summary.supplementalBlockBytes).toBeGreaterThan(0);
			expect(rendered.summary.referenceListsTruncated).toBe(true);
		}
		expect(executor.summary.contextRole).toBe("executor");
		expect(supervisor.summary.contextRole).toBe("supervisor");
	});
});
