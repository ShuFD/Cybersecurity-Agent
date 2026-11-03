/** Regression tests ported from CairnPilot b015733 (Apache-2.0). */
import { describe, expect, test, vi } from "vitest";

const mock = vi.fn;

import type { LeaseTimer } from "../src/planning/cairn/intent-lease-controller.ts";
import { ReasonLeaseReaper } from "../src/planning/cairn/reason-reaper.ts";

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

describe("ReasonLeaseReaper", () => {
	test("scans immediately and periodically without overlap, then stops cleanly", async () => {
		const timer = new FakeTimer();
		let resolve = (_value: { expired: number; recovered: number }) => {};
		const expireReasonLeases = mock(
			() =>
				new Promise<{ expired: number; recovered: number }>((resolvePromise) => {
					resolve = resolvePromise;
				}),
		);
		const reaper = new ReasonLeaseReaper({ intervalMs: 1_000, service: { expireReasonLeases }, timer });
		reaper.start();
		await Promise.resolve();
		expect(expireReasonLeases).toHaveBeenCalledTimes(1);
		timer.fire();
		expect(expireReasonLeases).toHaveBeenCalledTimes(1);
		resolve({ expired: 0, recovered: 0 });
		await Promise.resolve();
		await Promise.resolve();
		expect(timer.callbacks.size).toBe(1);
		timer.fire();
		await Promise.resolve();
		expect(expireReasonLeases).toHaveBeenCalledTimes(2);
		reaper.stop();
		resolve({ expired: 0, recovered: 0 });
		await Promise.resolve();
		expect(timer.callbacks.size).toBe(0);
	});
});
