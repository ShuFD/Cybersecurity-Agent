/** Adapted from sxd-git1/cairnpilot b015733fa117aa35f2406b8b31fd1bbf84d3ec6e.
 * Apache-2.0; see vendor/cairnpilot/LICENSE and NOTICE.md. */
import type { LeaseTimer } from "./intent-lease-controller.ts";
import type { GraphReasoner } from "./reasoner.ts";
import type { GraphService } from "./service.ts";

export interface ReasonWorkerOptions {
	intervalMs: number;
	service: Pick<GraphService, "listReasonWorkChallenges">;
	reasoner: Pick<GraphReasoner, "runOnce" | "abortAll">;
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

export class ReasonWorker {
	private timerHandle?: unknown;
	private stopped = true;
	private running = false;
	private epoch = 0;
	private scanPromise?: Promise<void>;

	async waitForIdle(): Promise<void> {
		await this.scanPromise;
	}
	private scanController?: AbortController;

	private readonly options: ReasonWorkerOptions;
	constructor(options: ReasonWorkerOptions) {
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
		this.scanController?.abort();
		this.options.reasoner.abortAll();
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
		const controller = new AbortController();
		this.scanController = controller;
		try {
			const challengeIds = this.options.service.listReasonWorkChallenges();
			await Promise.all(
				challengeIds.map((challengeId) => this.options.reasoner.runOnce(challengeId, controller.signal)),
			);
		} catch (error) {
			this.options.onError?.(error);
		} finally {
			if (this.scanController === controller) this.scanController = undefined;
			this.running = false;
		}
		this.schedule(epoch);
	}
}
