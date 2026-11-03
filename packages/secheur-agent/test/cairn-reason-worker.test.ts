/** Regression tests ported from CairnPilot b015733 (Apache-2.0). */

import { describe, expect, test, vi } from "vitest";
import { cairnTestIO } from "./fixtures/cairn-test-io.ts";

const mock = vi.fn;

import type { LeaseTimer } from "../src/planning/cairn/intent-lease-controller.ts";
import { ReasonWorker } from "../src/planning/cairn/reason-worker.ts";

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

describe("ReasonWorker", () => {
	test("does not call Reasoner without work and scans without overlap", async () => {
		const timer = new FakeTimer();
		const runOnce = mock(async () => ({ status: "idle" as const }));
		const listReasonWorkChallenges = mock(() => [] as string[]);
		const worker = new ReasonWorker({
			intervalMs: 1_000,
			timer,
			service: { listReasonWorkChallenges },
			reasoner: { runOnce, abortAll: mock(() => {}) },
		});
		worker.start();
		await cairnTestIO.sleep(0);
		expect(runOnce).not.toHaveBeenCalled();
		expect(timer.callbacks.size).toBe(1);
		timer.fire();
		await cairnTestIO.sleep(0);
		expect(listReasonWorkChallenges).toHaveBeenCalledTimes(2);
		worker.stop();
		expect(timer.callbacks.size).toBe(0);
	});

	test("stop aborts pending work and prevents rescheduling", async () => {
		const timer = new FakeTimer();
		let resolve!: () => void;
		const runOnce = mock(
			async () =>
				new Promise<{ status: "idle" }>((done) => {
					resolve = () => done({ status: "idle" });
				}),
		);
		const abortAll = mock(() => {});
		const worker = new ReasonWorker({
			intervalMs: 1_000,
			timer,
			service: { listReasonWorkChallenges: () => ["challenge-a"] },
			reasoner: { runOnce, abortAll },
		});
		worker.start();
		await cairnTestIO.sleep(0);
		worker.stop();
		worker.stop();
		expect(abortAll).toHaveBeenCalledTimes(1);
		resolve();
		await cairnTestIO.sleep(0);
		expect(timer.callbacks.size).toBe(0);
	});
});
