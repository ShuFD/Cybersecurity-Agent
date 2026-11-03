/** Adapted from sxd-git1/cairnpilot b015733fa117aa35f2406b8b31fd1bbf84d3ec6e.
 * Apache-2.0; see vendor/cairnpilot/LICENSE and NOTICE.md. */
import type { LeaseTimer } from "./intent-lease-controller.ts";
import type { GraphService } from "./service.ts";

export interface ReasonLeaseReaperOptions {
	intervalMs: number;
	service: {
		expireReasonLeases():
			| ReturnType<GraphService["expireReasonLeases"]>
			| Promise<ReturnType<GraphService["expireReasonLeases"]>>;
	};
	timer?: LeaseTimer;
	onError?: (error: unknown) => void;
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

export class ReasonLeaseReaper {
	private timerHandle?: unknown;
	private running = false;
	private stopped = true;
	private epoch = 0;

	private readonly options: ReasonLeaseReaperOptions;
	constructor(options: ReasonLeaseReaperOptions) {
		this.options = options;
		if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
			throw new Error("intervalMs must be a positive integer");
		}
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		const epoch = ++this.epoch;
		void this.scan(epoch);
	}

	stop(): void {
		this.stopped = true;
		this.epoch += 1;
		if (this.timerHandle === undefined) return;
		(this.options.timer ?? defaultTimer).clear(this.timerHandle);
		this.timerHandle = undefined;
	}

	private schedule(epoch: number): void {
		if (this.stopped || epoch !== this.epoch || this.timerHandle !== undefined) return;
		this.timerHandle = (this.options.timer ?? defaultTimer).set(() => {
			this.timerHandle = undefined;
			void this.scan(epoch);
		}, this.options.intervalMs);
	}

	private async scan(epoch: number): Promise<void> {
		if (this.stopped || epoch !== this.epoch || this.running) return;
		this.running = true;
		try {
			await this.options.service.expireReasonLeases();
		} catch (error) {
			this.options.onError?.(error);
		} finally {
			this.running = false;
		}
		this.schedule(epoch);
	}
}
