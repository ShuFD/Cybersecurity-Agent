/** A run-local wake-up policy. It never terminates or manufactures executor work. */
export class OpportunityReview {
	private fingerprint = "";
	private dueAt = 0;
	private interval = 120_000;
	update(state: string, occupied: number, capacity: number, now = Date.now()): void {
		if (state !== this.fingerprint) {
			this.fingerprint = state;
			this.interval = 120_000;
			this.dueAt = occupied === 0 ? now : now + this.interval;
		}
		if (occupied >= capacity || capacity < 2) this.dueAt = Number.POSITIVE_INFINITY;
		else if (!Number.isFinite(this.dueAt)) this.dueAt = occupied === 0 ? now : now + this.interval;
	}
	due(now = Date.now()): boolean {
		return now >= this.dueAt;
	}
	reviewed(now = Date.now(), timed = true): void {
		if (timed) this.interval = Math.min(480_000, this.interval * 2);
		this.dueAt = now + this.interval;
	}
	delay(now = Date.now()): number {
		return Math.max(1, Math.min(480_000, this.dueAt - now));
	}
	wait(signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const aborted = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", aborted);
				reject(signal.reason);
			};
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", aborted);
				resolve();
			}, this.delay());
			signal.addEventListener("abort", aborted, { once: true });
			if (signal.aborted) aborted();
		});
	}
}
