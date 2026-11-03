import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PlanningSnapshot } from "../src/planning/contracts.ts";
import { artifactLogicalPath, registerPlanningArtifact } from "../src/planning/frame-reducer.ts";
import { emptyHypothesisGraph, resolveHypothesisArtifactInput } from "../src/planning/hypothesis-graph.ts";
import { PlanningStore } from "../src/planning/store.ts";

describe("host artifact registration boundaries", () => {
	it.each(["../notes/data.txt", "notes/../../data.txt", "C:notes/data.txt", "notes\0/data.txt"])(
		"does not turn an unsafe logical path %s into an alias",
		(path) => expect(artifactLogicalPath(path)).toBeUndefined(),
	);
	it("normalizes contained relative separators without accepting roots", () => {
		expect(artifactLogicalPath("./notes\\data.txt")).toBe("notes/data.txt");
		expect(artifactLogicalPath("/notes/data.txt")).toBeUndefined();
		expect(artifactLogicalPath("\\\\server\\notes\\data.txt")).toBeUndefined();
	});
	it("ignores model-supplied aliases and registers only the actual producer workspace", () => {
		const root = mkdtempSync(join(tmpdir(), "artifact-alias-"));
		try {
			const workspace = join(root, "attempt");
			mkdirSync(workspace);
			const path = join(workspace, "data.txt");
			writeFileSync(path, "synthetic");
			const supplied = {
				path,
				type: "text",
				description: "fixture",
				logicalPath: "forged.txt",
				sourceLeaseId: "forged",
			};
			expect(registerPlanningArtifact(supplied, root, "producer", "real-lease", workspace)).toMatchObject({
				path,
				sourceTaskId: "producer",
				logicalPath: "data.txt",
				sourceLeaseId: "real-lease",
			});
			expect(registerPlanningArtifact(supplied, root, "producer")).not.toHaveProperty("logicalPath");
			expect(
				registerPlanningArtifact(supplied, root, "producer", "real-lease", join(root, "missing")),
			).not.toHaveProperty("logicalPath");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("does not alias sibling workspace files or symlink targets outside the allowed scope", () => {
		const root = mkdtempSync(join(tmpdir(), "artifact-scope-"));
		try {
			const workspace = join(root, "allowed", "attempt");
			const sibling = join(root, "allowed", "sibling");
			const outside = join(root, "outside");
			for (const path of [workspace, sibling, outside]) mkdirSync(path, { recursive: true });
			const siblingFile = join(sibling, "data.txt");
			writeFileSync(siblingFile, "synthetic");
			writeFileSync(join(outside, "data.txt"), "synthetic");
			symlinkSync(outside, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
			expect(
				registerPlanningArtifact(
					{ path: siblingFile, type: "text", description: "fixture" },
					join(root, "allowed"),
					"producer",
					"lease",
					workspace,
				),
			).not.toHaveProperty("logicalPath");
			expect(
				registerPlanningArtifact(
					{ path: join(workspace, "escape", "data.txt"), type: "text", description: "fixture" },
					join(root, "allowed"),
					"producer",
					"lease",
					workspace,
				),
			).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("rejects ambiguous aliases, foreign run owners and aliases from an older active attempt", async () => {
		const store = await PlanningStore.open(":memory:");
		try {
			store.createRun({ runId: "alias-run", outerTaskId: "fixture", goal: "fixture", mode: "active" });
			store.commitPlan({
				runId: "alias-run",
				expectedRevision: 0,
				rationale: "fixture",
				idempotencyKey: "fixture",
				tasks: [
					{
						taskId: "producer",
						objective: "Produce fixture",
						doneWhen: "Fixture saved",
						priority: 0,
						sequence: 0,
						dependsOnTaskIds: [],
					},
				],
			});
			const snapshot: PlanningSnapshot = store.snapshot("alias-run", true);
			const graph = emptyHypothesisGraph();
			const input = { sourceTaskId: "producer", artifactPath: "notes/data.txt" };
			graph.checkpointArtifacts = [
				{
					sourceTaskId: "producer",
					sourceLeaseId: "lease-one",
					logicalPath: input.artifactPath,
					path: "/registered/one/notes/data.txt",
				},
				{
					sourceTaskId: "producer",
					sourceLeaseId: "lease-two",
					logicalPath: input.artifactPath,
					path: "/registered/two/notes/data.txt",
				},
			];
			expect(resolveHypothesisArtifactInput(graph, snapshot, input)).toEqual({ kind: "ambiguous" });
			graph.checkpointArtifacts.pop();
			expect(
				resolveHypothesisArtifactInput(
					graph,
					{ ...snapshot, tasks: snapshot.tasks.map((task) => ({ ...task, runId: "foreign" })) },
					input,
				),
			).toEqual({ kind: "missing" });
			snapshot.activeLeases = [
				{
					schemaVersion: 1,
					leaseId: "new-active-lease",
					runId: "alias-run",
					taskId: "producer",
					planRevision: 1,
					objective: "fixture",
					doneWhen: "fixture",
					allowedScope: "/registered",
					issuedAt: 1,
					expiresAt: 2,
				},
			];
			expect(resolveHypothesisArtifactInput(graph, snapshot, input)).toEqual({ kind: "missing" });
		} finally {
			store.close();
		}
	});
});
