/** Regression tests ported from CairnPilot b015733 (Apache-2.0). */

import { describe, expect, test, vi } from "vitest";
import { cairnTestIO } from "./fixtures/cairn-test-io.ts";

const mock = vi.fn;

import type { LeaseTimer } from "../src/planning/cairn/intent-lease-controller.ts";
import { SchedulerWorker } from "../src/planning/cairn/scheduler-worker.ts";

class FakeTimer implements LeaseTimer {
	callbacks = new Map<number, () => void>();
	nextId = 1;
	set(callback: () => void): number {
		const id = this.nextId++;
		this.callbacks.set(id, callback);
		return id;
	}
	clear(handle: unknown): void {
		this.callbacks.delete(handle as number);
	}
	fire(): void {
		const callbacks = [...this.callbacks.values()];
		this.callbacks.clear();
		for (const callback of callbacks) callback();
	}
}

describe("SchedulerWorker", () => {
	test("scans deterministically without overlapping ticks", async () => {
		const timer = new FakeTimer();
		const order: string[] = [];
		let release!: () => void;
		const runChallengeOnce = mock(async (challengeId: string) => {
			order.push(challengeId);
			if (challengeId === "challenge-a")
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			return {} as never;
		});
		const worker = new SchedulerWorker({
			intervalMs: 1_000,
			timer,
			service: { listSchedulerWorkChallenges: () => ["challenge-a", "challenge-b"] },
			coordinator: { runChallengeOnce },
		});
		worker.start();
		await cairnTestIO.sleep(0);
		expect(order).toEqual(["challenge-a"]);
		expect(timer.callbacks.size).toBe(0);
		release();
		await cairnTestIO.sleep(0);
		expect(order).toEqual(["challenge-a", "challenge-b"]);
		expect(timer.callbacks.size).toBe(1);
		timer.fire();
		await cairnTestIO.sleep(0);
		expect(runChallengeOnce).toHaveBeenCalledTimes(3);
		worker.stop();
	});

	test("isolates Challenge errors and stops idempotently", async () => {
		const timer = new FakeTimer();
		const onError = mock((_error: unknown, _challengeId?: string) => {});
		const runChallengeOnce = mock(async (challengeId: string) => {
			if (challengeId === "challenge-a") throw new Error("failed-a");
			return {} as never;
		});
		const worker = new SchedulerWorker({
			intervalMs: 1_000,
			timer,
			service: { listSchedulerWorkChallenges: () => ["challenge-a", "challenge-b"] },
			coordinator: { runChallengeOnce },
			onError,
		});
		worker.start();
		await cairnTestIO.sleep(0);
		expect(runChallengeOnce).toHaveBeenCalledTimes(2);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0][1]).toBe("challenge-a");
		worker.stop();
		worker.stop();
		expect(timer.callbacks.size).toBe(0);
	});

	test("reports work-list failures without running a Challenge", async () => {
		const timer = new FakeTimer();
		const onError = mock((_error: unknown, _challengeId?: string) => {});
		const runChallengeOnce = mock(async () => ({}) as never);
		const worker = new SchedulerWorker({
			intervalMs: 1_000,
			timer,
			service: {
				listSchedulerWorkChallenges: () => {
					throw new Error("read failed");
				},
			},
			coordinator: { runChallengeOnce },
			onError,
		});
		worker.start();
		await cairnTestIO.sleep(0);
		expect(runChallengeOnce).not.toHaveBeenCalled();
		expect(onError.mock.calls[0][1]).toBeUndefined();
		worker.stop();
	});
});
