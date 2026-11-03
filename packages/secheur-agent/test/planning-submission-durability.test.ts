import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parsePlanningTaskResult } from "../src/planning/contracts.ts";
import { PlanningPersistenceError } from "../src/planning/failures.ts";
import { createPlanningCommitExtension } from "../src/planning/result-tool.ts";
import { PlanningStore } from "../src/planning/store.ts";

function commitTool(options: Parameters<typeof createPlanningCommitExtension>[0]) {
	const commit = createPlanningCommitExtension(options);
	let execute: (id: string, input: unknown) => Promise<unknown> = async () => {
		throw new Error("tool not registered");
	};
	const extension = commit.extension as unknown as {
		factory: (pi: { registerTool: (tool: { name: string; execute: typeof execute }) => void }) => void;
	};
	extension.factory({
		registerTool: (tool) => {
			if (tool.name === "planning_commit_result") execute = tool.execute;
		},
	});
	return { ...commit, execute: (id: string, input: unknown) => execute(id, input) };
}

describe("durable planning submission before local handoff", () => {
	it("does not acknowledge a submission when persistence fails", async () => {
		const error = new PlanningPersistenceError("synthetic storage failure");
		const onFailure = vi.fn();
		const tool = commitTool({
			leaseId: "lease",
			evidence: [],
			recordSubmission: () => {
				throw error;
			},
			onPersistenceFailure: onFailure,
		});
		await expect(tool.execute("report", { outcome: "blocked", summary: "local observation" })).rejects.toBe(error);
		expect(tool.getResult()).toBeUndefined();
		expect(onFailure).toHaveBeenCalledWith(error);
	});
	it("acknowledges one persisted submission and labels duplicates separately", async () => {
		const saved = vi.fn();
		const tool = commitTool({ leaseId: "lease", evidence: [], recordSubmission: saved });
		await expect(tool.execute("report", { outcome: "blocked", summary: "observation" })).resolves.toMatchObject({
			details: { accepted: true, duplicate: false },
		});
		await expect(
			tool.execute("again", { outcome: "done", summary: "must not replace accepted result" }),
		).resolves.toMatchObject({ details: { accepted: true, duplicate: true } });
		expect(saved).toHaveBeenCalledOnce();
		expect(tool.getResult()?.outcome).toBe("blocked");
	});
	it("recovers the persisted report after reopening without prematurely releasing the lease or proving the goal", async () => {
		const root = mkdtempSync(join(tmpdir(), "planning-submission-"));
		const path = join(root, "planning.sqlite");
		let store = await PlanningStore.open(path);
		try {
			store.createRun({ runId: "run", outerTaskId: "outer", goal: "unverified synthetic goal", mode: "active" });
			store.commitPlan({
				runId: "run",
				expectedRevision: 0,
				rationale: "fixture",
				idempotencyKey: "plan",
				tasks: [
					{
						taskId: "task",
						objective: "observe",
						doneWhen: "report",
						priority: 1,
						sequence: 0,
						dependsOnTaskIds: [],
					},
				],
			});
			const lease = store.leaseTask("run", "task", root, 30000);
			store.startLease(lease.leaseId);
			const result = parsePlanningTaskResult(
				JSON.stringify({ outcome: "blocked", summary: "durable partial observation" }),
				lease.leaseId,
			);
			store.recordResultSubmission(lease.leaseId, result);
			store.recordResultSubmission(lease.leaseId, result);
			store.close();
			store = await PlanningStore.open(path);
			const events = store.listLifecycleEvents("run").events.filter((e) => e.type === "task_result_submitted");
			expect(events).toHaveLength(1);
			expect(events[0]?.payload.result).toMatchObject({ summary: "durable partial observation" });
			expect(store.snapshot("run").run.status).not.toBe("completed");
			expect(store.snapshot("run").activeLease?.leaseId).toBe(lease.leaseId);
			expect(() => store.recordResultSubmission(lease.leaseId, { ...result, leaseId: "other" })).toThrow(
				/another lease/,
			);
			expect(() =>
				store.recordResultSubmission(lease.leaseId, { ...result, evidenceRefs: ["another-run-evidence"] }),
			).toThrow(/not in this run/);
		} finally {
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
