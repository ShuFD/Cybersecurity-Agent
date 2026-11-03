/**
 * Scoped Executor slots. Waiting owns no lease
 * and starts no Executor deadline. FIFO waiters are cancellable.
 */
function validCapacity(capacity: number): number {
	if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Executor capacity must be a positive integer");
	return capacity;
}

/** Mutable per-run limit; changing it wakes scheduling, never aborts a worker. */
export class PlanningCapacityControl {
	private capacity: number;
	private readonly listeners = new Set<() => void>();
	constructor(capacity: number) {
		this.capacity = validCapacity(capacity);
	}
	getCapacity(): number {
		return this.capacity;
	}
	setCapacity(capacity: number): void {
		this.capacity = validCapacity(capacity);
		for (const listener of this.listeners) listener();
	}
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
}

export class PlanningExecutorPool {
	private capacity: number;
	private active = 0;
	private readonly listeners = new Set<() => void>();
	private readonly waiters: Array<{
		signal?: AbortSignal;
		resolve: (release: () => void) => void;
		reject: (error: unknown) => void;
		abort: () => void;
	}> = [];

	constructor(capacity = 2) {
		this.capacity = validCapacity(capacity);
	}

	setCapacity(capacity: number): void {
		this.capacity = validCapacity(capacity);
		this.drain();
		for (const listener of this.listeners) listener();
	}

	getStatus(): { capacity: number; active: number; waiting: number } {
		return { capacity: this.capacity, active: this.active, waiting: this.waiters.length };
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	acquire(signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Executor slot wait cancelled"));
		return new Promise((resolve, reject) => {
			const waiter = {
				signal,
				resolve,
				reject,
				abort: () => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) this.waiters.splice(index, 1);
					reject(signal?.reason ?? new Error("Executor slot wait cancelled"));
				},
			};
			signal?.addEventListener("abort", waiter.abort, { once: true });
			this.waiters.push(waiter);
			this.drain();
		});
	}

	/** Rolling schedulers retry later instead of holding a lease in the FIFO queue. */
	tryAcquire(): (() => void) | undefined {
		if (this.active >= this.capacity || this.waiters.length > 0) return;
		return this.reserveSlot();
	}

	private reserveSlot(): () => void {
		this.active++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active--;
			this.drain();
			for (const listener of this.listeners) listener();
		};
	}

	private drain(): void {
		while (this.active < this.capacity && this.waiters.length > 0) {
			const waiter = this.waiters.shift();
			if (!waiter) return;
			waiter.signal?.removeEventListener("abort", waiter.abort);
			if (waiter.signal?.aborted) {
				waiter.reject(waiter.signal.reason ?? new Error("Executor slot wait cancelled"));
				continue;
			}
			waiter.resolve(this.reserveSlot());
		}
	}
}
