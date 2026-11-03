/** Adapted from sxd-git1/cairnpilot b015733fa117aa35f2406b8b31fd1bbf84d3ec6e.
 * Apache-2.0; see vendor/cairnpilot/LICENSE and NOTICE.md. */
import type { LeaseTimer } from "./intent-lease-controller.ts";
import type { SchedulerCoordinator } from "./scheduler-coordinator.ts";
import type { GraphService } from "./service.ts";

export interface SchedulerWorkerOptions {
	intervalMs: number;
	service: Pick<GraphService, "listSchedulerWorkChallenges">;
	coordinator: Pick<SchedulerCoordinator, "runChallengeOnce">;
	timer?: LeaseTimer;
	onError?: (error: unknown, challengeId?: string) => void;
}

const defaultTimer: LeaseTimer = {
	set(callback, delayMs) {
		const handle = setTimeout(callback, delayMs);
		handle.unref?.();
		return handle;
	},
	clear(handle) {
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	},
};

export class SchedulerWorker {
	private timerHandle?: unknown;
	private stopped = true;
	private running = false;
	private epoch = 0;
	private scanPromise?: Promise<void>;

	async waitForIdle(): Promise<void> {
		await this.scanPromise;
	}

	private readonly options: SchedulerWorkerOptions;
	constructor(options: SchedulerWorkerOptions) {
		this.options = options;
		if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
			throw new Error("intervalMs must be a positive integer");
		}
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		const epoch = ++this.epoch;
		this.scanPromise = this.scan(epoch);
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.epoch += 1;
		if (this.timerHandle !== undefined) {
			(this.options.timer ?? defaultTimer).clear(this.timerHandle);
			this.timerHandle = undefined;
		}
	}

	private schedule(epoch: number): void {
		if (this.stopped || epoch !== this.epoch || this.timerHandle !== undefined) return;
		this.timerHandle = (this.options.timer ?? defaultTimer).set(() => {
			this.timerHandle = undefined;
			this.scanPromise = this.scan(epoch);
		}, this.options.intervalMs);
	}

	private async scan(epoch: number): Promise<void> {
		if (this.stopped || epoch !== this.epoch || this.running) return;
		this.running = true;
		try {
			const challengeIds = this.options.service.listSchedulerWorkChallenges();
			for (const challengeId of challengeIds) {
				if (this.stopped || epoch !== this.epoch) break;
				try {
					await this.options.coordinator.runChallengeOnce(challengeId);
				} catch (error) {
					this.options.onError?.(error, challengeId);
				}
			}
		} catch (error) {
			this.options.onError?.(error);
		} finally {
			this.running = false;
		}
		this.schedule(epoch);
	}
}
