import type { LeaseTimer } from "./intent-lease-controller.ts";
import type { GraphService } from "./service.ts";

export interface IntentLeaseReaperOptions {
	intervalMs: number;
	service: {
		expireLeases(): ReturnType<GraphService["expireLeases"]> | Promise<ReturnType<GraphService["expireLeases"]>>;
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

export class IntentLeaseReaper {
	private timerHandle?: unknown;
	private running = false;
	private stopped = true;
	private epoch = 0;

	private readonly options: IntentLeaseReaperOptions;
	constructor(options: IntentLeaseReaperOptions) {
		this.options = options;
		if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
			throw new Error("intervalMs must be a positive integer");
		}
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.epoch += 1;
		void this.scan(this.epoch);
	}

	stop(): void {
		this.epoch += 1;
		this.stopped = true;
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
			await this.options.service.expireLeases();
		} catch (error) {
			this.options.onError?.(error);
		} finally {
			this.running = false;
		}
		this.schedule(epoch);
	}
}
