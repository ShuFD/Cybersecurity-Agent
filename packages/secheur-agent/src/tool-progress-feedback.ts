import { operationalDigest, REPEAT_CALL_THRESHOLD } from "./operational-guard.ts";

/** Session-local feedback; shared budgets must not mix siblings' interaction state. */
export class ToolProgressFeedback {
	private lastCall = "";
	private repeats = 0;
	private failures = 0;
	private failureNotice = false;
	private readonly toolFailures = new Map<string, { count: number; signature: string }>();
	private readonly successfulOutputs = new Map<string, string>();
	repeatedCall(name: string, input: unknown): boolean {
		const signature = operationalDigest([name, input]);
		this.repeats = signature === this.lastCall ? this.repeats + 1 : 1;
		this.lastCall = signature;
		return this.repeats >= REPEAT_CALL_THRESHOLD;
	}
	observe(isError: boolean, toolName?: string, content?: unknown, details?: unknown): string | undefined {
		if (toolName) {
			if (!isError) {
				this.toolFailures.delete(toolName);
				const signature = operationalDigest([content, details]);
				const status =
					details && typeof details === "object" ? String((details as Record<string, unknown>).status) : "";
				if (
					signature !== this.successfulOutputs.get(toolName) &&
					!["running", "blocked", "error", "failed"].includes(status)
				) {
					this.successfulOutputs.set(toolName, signature);
					this.repeats = 0;
				}
			} else {
				const signature = operationalDigest([content, details]);
				const prior = this.toolFailures.get(toolName);
				const count = prior?.signature === signature ? prior.count + 1 : 1;
				this.toolFailures.set(toolName, { count, signature });
				if (count % REPEAT_CALL_THRESHOLD === 0) {
					return `Tool ${toolName} has returned the same error ${count} times, even if other calls succeeded. Repair its arguments or prerequisites using the error already in context; do not resubmit unchanged. Save a checkpoint and continue other useful work. A verifier tool error without a canonical status is not an incorrect-answer result or trusted success.`;
				}
			}
		}
		if (!isError) {
			this.failures = 0;
			this.failureNotice = false;
			return undefined;
		}
		this.failures++;
		if (this.failures < REPEAT_CALL_THRESHOLD || this.failureNotice) return undefined;
		this.failureNotice = true;
		return "Several consecutive tool results failed. Check the error and saved evidence, change the next action when needed, and use the available checkpoint tool (planning_checkpoint or checkpoint_intent) to record rejected directions or useful next steps. Continue the task; this is feedback, not a stop or a request to restart completed work.";
	}
	context(): string {
		if (!this.toolFailures.size) return "";
		return (
			"[Local tool failures] " +
			[...this.toolFailures]
				.slice(-4)
				.map(([name, state]) => `${name}: ${state.count} occurrences of its latest error`)
				.join("; ") +
			". Inspect the corresponding tool error, fix the request/prerequisites, and checkpoint useful findings before retrying. Continue working; this feedback does not stop the agent."
		);
	}
}
