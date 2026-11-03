import { describe, expect, it } from "vitest";
import { PlanningExecutorPool } from "../src/planning/execution-pool.ts";

describe("Planning Executor slot reservation", () => {
	it("does not enqueue rolling work when full, and releases exactly once", () => {
		const pool = new PlanningExecutorPool(1);
		const release = pool.tryAcquire();
		expect(release).toBeDefined();
		expect(pool.tryAcquire()).toBeUndefined();
		expect(pool.getStatus()).toEqual({ capacity: 1, active: 1, waiting: 0 });
		release?.();
		release?.();
		expect(pool.getStatus().active).toBe(0);
		pool.tryAcquire()?.();
		expect(pool.getStatus().active).toBe(0);
	});
	it("preserves FIFO callers when a rolling reservation releases its slot", async () => {
		const pool = new PlanningExecutorPool(1);
		const release = pool.tryAcquire();
		const waiting = pool.acquire();
		expect(pool.tryAcquire()).toBeUndefined();
		release?.();
		expect(pool.tryAcquire()).toBeUndefined();
		const releaseWaiting = await waiting;
		expect(pool.getStatus()).toEqual({ capacity: 1, active: 1, waiting: 0 });
		releaseWaiting();
		expect(pool.getStatus().active).toBe(0);
	});
	it("respects capacity shrink and cancellation of queued callers", async () => {
		const pool = new PlanningExecutorPool(2);
		const releaseA = pool.tryAcquire();
		const releaseB = pool.tryAcquire();
		pool.setCapacity(1);
		const controller = new AbortController();
		const waiting = pool.acquire(controller.signal).catch((error) => error);
		releaseA?.();
		expect(pool.tryAcquire()).toBeUndefined();
		controller.abort(new Error("cancel queued fixture"));
		expect(await waiting).toEqual(new Error("cancel queued fixture"));
		releaseB?.();
		expect(pool.getStatus()).toEqual({ capacity: 1, active: 0, waiting: 0 });
	});
});
