import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SlabExerciseDetails } from "../src/competition-api.ts";
import { loadSecHeurConfig } from "../src/config.ts";
import { openWorklistOrchestrator } from "../src/worklist.ts";
import { WorklistStore } from "../src/worklist-store.ts";

const exercise: SlabExerciseDetails = {
	id: 101,
	name: "test-web",
	isOpen: true,
	hasSolved: false,
	description: "test",
	isNeedInit: true,
	isNeedCheck: false,
	attachments: [],
	endpoints: [],
	raw: {},
};

describe("WorklistStore", () => {
	it("persists queue status, attempts, events, and Pi session links", async () => {
		const store = await WorklistStore.open(":memory:");
		try {
			const item = store.upsertExercise(exercise, "/tmp/worklist/101");
			expect(item.status).toBe("queued");
			expect(item.requiresEnvironment).toBe(true);
			store.attachSession(item.id, "solver-session", "coordinator-session");
			store.recordAttempt(item.id, "value");
			store.appendGuidance(item.id, "Use the local crash trace before trying another flag.");
			store.setStatus(item.id, "running", "solver started");
			const saved = store.get(item.id);
			expect(saved).toMatchObject({
				status: "running",
				sessionId: "solver-session",
				coordinatorSessionId: "coordinator-session",
				attempts: 1,
				lastFlag: "value",
			});
			expect(saved?.metadata.operatorGuidance).toEqual([
				{ message: "Use the local crash trace before trying another flag.", createdAt: expect.any(Number) },
			]);
			expect(store.events().map((event) => event.type)).toContain("running");
		} finally {
			store.close();
		}
	});

	it("stores operator guidance and stops a queued item without retrying it", async () => {
		const root = await mkdtemp(join(tmpdir(), "secheur-worklist-control-"));
		const store = await WorklistStore.open(":memory:");
		const config = loadSecHeurConfig({ projectRoot: root, stateDir: join(root, ".state"), env: {} });
		const orchestrator = await openWorklistOrchestrator({
			config,
			env: {},
			api: { isConfigured: () => false } as never,
			store,
			workRoot: join(root, "worklist"),
		});
		try {
			const item = store.upsertExercise(exercise, join(root, "worklist", "101"));
			await orchestrator.guideItem(item.id, "Inspect the crash trace before another flag attempt.");
			const guided = store.get(item.id);
			expect(guided?.metadata.operatorGuidance).toEqual([
				{ message: "Inspect the crash trace before another flag attempt.", createdAt: expect.any(Number) },
			]);
			const stopped = await orchestrator.stopItem(item.id);
			expect(stopped.items[0]).toMatchObject({ status: "blocked", attempts: 0 });
		} finally {
			store.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not count attachment-only exercises as environment work", async () => {
		const store = await WorklistStore.open(":memory:");
		try {
			const item = store.upsertExercise(
				{
					...exercise,
					isNeedInit: false,
					endpointType: "none",
					attachments: [{ name: "challenge.zip", url: "https://example.test/challenge.zip" }],
				},
				"/tmp/worklist/attachment-only",
			);
			expect(item.requiresEnvironment).toBe(false);
		} finally {
			store.close();
		}
	});

	it("orders unassigned work by priority while preserving assigned priority", async () => {
		const store = await WorklistStore.open(":memory:");
		try {
			const low = store.upsertExercise({ ...exercise, id: 201, name: "low" }, "/tmp/worklist/201", 1);
			const high = store.upsertExercise({ ...exercise, id: 202, name: "high" }, "/tmp/worklist/202", 5);
			expect(store.list("queued").map((item) => item.id)).toEqual([high.id, low.id]);
			store.setStatus(high.id, "running", "assigned");
			const updated = store.upsertExercise({ ...exercise, id: 202, name: "high-refresh" }, "/tmp/worklist/202", 0);
			expect(updated.priority).toBe(5);
		} finally {
			store.close();
		}
	});
});
