export class ArtexWake {
	private state = "";
	private pendingAt: number | undefined;
	private heartbeatAt: number;
	private readonly debounceMs: number;
	private readonly heartbeatMs: number;

	constructor(policy: { debounceMs: number; heartbeatMs: number }, now = Date.now()) {
		this.debounceMs = policy.debounceMs;
		this.heartbeatMs = policy.heartbeatMs;
		this.heartbeatAt = now + policy.heartbeatMs;
	}
	observe(state: string, now = Date.now()): void {
		if (state === this.state) return;
		this.state = state;
		this.pendingAt ??= now + this.debounceMs;
	}
	delay(now = Date.now()): number {
		return Math.max(0, Math.min(this.pendingAt ?? Infinity, this.heartbeatAt) - now);
	}
	reason(now = Date.now()): "changes" | "heartbeat" {
		return this.pendingAt !== undefined && this.pendingAt <= now ? "changes" : "heartbeat";
	}
	reviewed(state: string, now = Date.now()): void {
		this.state = state;
		this.pendingAt = undefined;
		this.heartbeatAt = now + this.heartbeatMs;
	}
	notify(now = Date.now()): void {
		this.pendingAt ??= now + this.debounceMs;
	}
}
