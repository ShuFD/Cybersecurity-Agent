import { describe, expect, it } from "vitest";
import { resolveSolverDispatchIntervalMs, SerialDispatchQueue } from "../src/main-agent.ts";

describe("Main Agent solver dispatch queue", () => {
	it("clamps the configured interval to the recommended one-to-five second range", () => {
		expect(resolveSolverDispatchIntervalMs({ SECHEUR_SOLVER_DISPATCH_INTERVAL_MS: "500" })).toBe(1_000);
		expect(resolveSolverDispatchIntervalMs({ SECHEUR_SOLVER_DISPATCH_INTERVAL_MS: "9000" })).toBe(5_000);
		expect(resolveSolverDispatchIntervalMs({})).toBe(2_000);
	});

	it("serializes operations, spaces their start times, and recovers after failure", async () => {
		const queue = new SerialDispatchQueue<number>(10);
		const started: number[] = [];
		const first = queue.enqueue(async () => {
			started.push(Date.now());
			return 1;
		});
		const failed = queue.enqueue(async () => {
			started.push(Date.now());
			throw new Error("dispatch failed");
		});
		const recovered = queue.enqueue(async () => {
			started.push(Date.now());
			return 3;
		});

		expect(await first).toBe(1);
		await expect(failed).rejects.toThrow("dispatch failed");
		expect(await recovered).toBe(3);
		expect(started).toHaveLength(3);
		expect(started[1]! - started[0]!).toBeGreaterThanOrEqual(8);
		expect(started[2]! - started[1]!).toBeGreaterThanOrEqual(8);
	});
});
