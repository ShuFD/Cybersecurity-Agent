import { describe, expect, it, vi } from "vitest";
import { type SchedulerBackend, SchedulerPoller, type SchedulerTarget } from "../src/scheduler.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve = (_value: T) => {};
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function idleTarget(submit: SchedulerTarget["submit"] = async () => "scheduler-session"): SchedulerTarget {
	return { isBusy: () => false, submit };
}

describe("scheduler poller", () => {
	it("does not claim a task while the target is busy", async () => {
		const backend: SchedulerBackend = {
			check: vi.fn(async () => ({ available: true, task: "due", intervalSeconds: 60 })),
			done: vi.fn(async () => undefined),
			close: vi.fn(),
		};
		const target: SchedulerTarget = { isBusy: () => true, submit: vi.fn(async () => "unexpected") };
		const poller = new SchedulerPoller(backend, target);

		await expect(poller.tick()).resolves.toEqual({ submitted: false, reason: "busy" });
		expect(backend.check).not.toHaveBeenCalled();
		expect(target.submit).not.toHaveBeenCalled();
	});

	it("reports no task and clamps the scheduler interval to five seconds", async () => {
		const backend: SchedulerBackend = {
			check: vi.fn(async () => ({ available: true, intervalSeconds: 1 })),
			done: vi.fn(async () => undefined),
			close: vi.fn(),
		};
		const poller = new SchedulerPoller(backend, idleTarget());

		await expect(poller.tick()).resolves.toEqual({ submitted: false, reason: "no-task" });
		expect(poller.interval).toBe(5);
	});

	it("rejects an overlapping tick and forwards the completed report", async () => {
		const checked = deferred<{ available: true; task: string; intervalSeconds: number }>();
		const done = vi.fn(async () => undefined);
		const backend: SchedulerBackend = {
			check: vi.fn(() => checked.promise),
			done,
			close: vi.fn(),
		};
		let completion: ((result: string) => Promise<void>) | undefined;
		const submit = vi.fn(async (_task: string, onDone: (result: string) => Promise<void>) => {
			completion = onDone;
			return "scheduler-session";
		});
		const poller = new SchedulerPoller(backend, idleTarget(submit));

		const first = poller.tick();
		await expect(poller.tick()).resolves.toEqual({ submitted: false, reason: "already-running" });
		checked.resolve({ available: true, task: "run scheduled task", intervalSeconds: 30 });
		await expect(first).resolves.toEqual({ submitted: true, sessionId: "scheduler-session" });
		expect(submit).toHaveBeenCalledWith("run scheduled task", expect.any(Function));
		await completion?.("报告已完成");
		expect(done).toHaveBeenCalledWith("报告已完成");
	});
});
