import type { IntentLease } from "./types.ts";

export interface LeaseTimer {
	set(callback: () => void, delayMs: number): unknown;
	clear(handle: unknown): void;
}

export interface IntentLeaseControllerOptions {
	heartbeatIntervalMs: number;
	leaseDurationMs: number;
	heartbeat: (lease: IntentLease, leaseDurationMs: number) => Promise<IntentLease>;
	timer?: LeaseTimer;
	onRevoked?: (lease: IntentLease, error: unknown) => void;
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

export class IntentLeaseController {
	private lease?: IntentLease;
	private timerHandle?: unknown;
	private heartbeatEpoch?: number;
	private revoked = false;
	private stopped = true;
	private epoch = 0;

	private readonly options: IntentLeaseControllerOptions;
	constructor(options: IntentLeaseControllerOptions) {
		this.options = options;
		if (!Number.isSafeInteger(options.heartbeatIntervalMs) || options.heartbeatIntervalMs <= 0) {
			throw new Error("heartbeatIntervalMs must be a positive integer");
		}
	}

	bind(lease: IntentLease): void {
		this.stop();
		this.epoch += 1;
		this.lease = { ...lease };
		this.revoked = false;
		this.stopped = false;
		this.schedule();
	}

	getBinding(): IntentLease | undefined {
		return this.getActiveBinding();
	}

	getActiveBinding(): IntentLease | undefined {
		if (!this.lease || this.stopped || this.revoked) return;
		return { ...this.lease };
	}

	update(lease: IntentLease): void {
		this.assertActive();
		this.lease = { ...lease };
	}

	assertActive(): IntentLease {
		if (!this.lease || this.stopped || this.revoked) throw new Error("intent Lease is not active");
		return { ...this.lease };
	}

	revoke(error: unknown = new Error("intent Lease was revoked")): void {
		const lease = this.getActiveBinding();
		this.epoch += 1;
		this.revoked = true;
		this.stopped = true;
		this.clearTimer();
		this.lease = undefined;
		if (lease) this.options.onRevoked?.(lease, error);
	}

	stop(): void {
		this.epoch += 1;
		this.stopped = true;
		this.revoked = false;
		this.clearTimer();
		this.lease = undefined;
	}

	private schedule(): void {
		if (this.stopped || this.revoked || !this.lease || this.timerHandle !== undefined) return;
		this.timerHandle = (this.options.timer ?? defaultTimer).set(() => {
			this.timerHandle = undefined;
			void this.tick();
		}, this.options.heartbeatIntervalMs);
	}

	private async tick(): Promise<void> {
		if (this.stopped || this.revoked || !this.lease) return;
		if (this.heartbeatEpoch === this.epoch) {
			this.schedule();
			return;
		}
		const epoch = this.epoch;
		const lease = { ...this.lease };
		this.heartbeatEpoch = epoch;
		try {
			const updated = await this.options.heartbeat(lease, this.options.leaseDurationMs);
			if (!this.matches(epoch, lease)) return;
			this.lease = { ...updated };
		} catch (error) {
			if (this.matches(epoch, lease)) this.revoke(error);
			return;
		} finally {
			if (this.heartbeatEpoch === epoch) this.heartbeatEpoch = undefined;
		}
		if (this.matches(epoch, lease, false)) this.schedule();
	}

	private matches(epoch: number, lease: IntentLease, includeVersion = true): boolean {
		const current = this.lease;
		return (
			epoch === this.epoch &&
			!this.stopped &&
			!this.revoked &&
			current !== undefined &&
			current.challengeId === lease.challengeId &&
			current.intentId === lease.intentId &&
			current.solverId === lease.solverId &&
			current.token === lease.token &&
			current.generation === lease.generation &&
			(!includeVersion || current.version === lease.version)
		);
	}

	private clearTimer(): void {
		if (this.timerHandle === undefined) return;
		(this.options.timer ?? defaultTimer).clear(this.timerHandle);
		this.timerHandle = undefined;
	}
}
