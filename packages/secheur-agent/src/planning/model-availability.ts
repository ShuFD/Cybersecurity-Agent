import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PlanningFailureError } from "./failures.ts";

// OpenCode bounds provider-requested retry delays to fifteen minutes.
export const MAX_PROVIDER_RETRY_AFTER_MS = 900_000;
const cooldowns = new WeakMap<ModelRuntime, Map<string, number>>();

export function providerPlanningFailure(error: unknown, runId?: string): PlanningFailureError | undefined {
	if (error instanceof PlanningFailureError) return error;
	const message = error instanceof Error ? error.message : String(error);
	const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
	const status = record.status ?? record.statusCode;
	const rateLimited = status === 429 || /\b429\b|rate.?limit|too many requests/i.test(message);
	const unavailable = /\b50[0234]\b|overloaded|fetch failed|connection|socket|network|timed? out/i.test(message);
	const quota = /insufficient_quota|quota exceeded|billing|usage limit|out of budget/i.test(message);
	if (!rateLimited && !unavailable && !quota) return undefined;
	let retryAfterMs: number | undefined;
	const headers = record.headers;
	if (headers instanceof Headers) {
		const rawMs = headers.get("retry-after-ms");
		const raw = headers.get("retry-after");
		if (rawMs) retryAfterMs = Number(rawMs);
		else if (raw) retryAfterMs = Number.isFinite(Number(raw)) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
	}
	const match = /(?:retry[-_ ]after|retry in)[:=\s]+(\d+(?:\.\d+)?)\s*(ms|milliseconds|s|seconds)?/i.exec(message);
	if (retryAfterMs === undefined && match) retryAfterMs = Number(match[1]) * (match[2]?.startsWith("m") ? 1 : 1000);
	if (retryAfterMs !== undefined)
		retryAfterMs =
			Number.isFinite(retryAfterMs) && retryAfterMs >= 0
				? Math.min(retryAfterMs, MAX_PROVIDER_RETRY_AFTER_MS)
				: undefined;
	return new PlanningFailureError({
		source: "planning",
		stage: "model_provider",
		code: quota ? "model_quota_unavailable" : rateLimited ? "model_rate_limited" : "model_transport_error",
		message: quota
			? "Model account quota unavailable; preserve task progress while awaiting availability."
			: rateLimited
				? "Model provider rate limited the request; preserve running work and honor retry timing."
				: "Model provider transport unavailable; preserve task progress and retry the request.",
		cause: error,
		runId,
		retryAfterMs,
	});
}

export function deferModelAvailability(runtime: ModelRuntime, key: string, delayMs: number): void {
	let values = cooldowns.get(runtime);
	if (!values) {
		values = new Map();
		cooldowns.set(runtime, values);
	}
	values.set(
		key,
		Math.max(values.get(key) ?? 0, Date.now() + Math.min(Math.max(0, delayMs), MAX_PROVIDER_RETRY_AFTER_MS)),
	);
}

export async function awaitModelAvailability(runtime: ModelRuntime, key: string, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	while (true) {
		const delay = Math.max(0, (cooldowns.get(runtime)?.get(key) ?? 0) - Date.now());
		if (delay === 0) break;
		await new Promise<void>((resolve, reject) => {
			const onAbort = (): void => {
				clearTimeout(timer);
				reject(signal?.reason);
			};
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, delay);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
		});
	}
	signal?.throwIfAborted();
}

export interface ModelQuotaBlock {
	error: string;
	quotaExhausted: true;
}
// The runtime owns one run's configured credentials. Never share this state by model name alone.
const quotaBlocks = new WeakMap<ModelRuntime, Map<string, ModelQuotaBlock>>();
export function markModelQuotaUnavailable(runtime: ModelRuntime, key: string, error: string): void {
	let blocks = quotaBlocks.get(runtime);
	if (!blocks) {
		blocks = new Map();
		quotaBlocks.set(runtime, blocks);
	}
	blocks.set(key, { error, quotaExhausted: true });
}
export function modelQuotaUnavailable(runtime: ModelRuntime, key: string): ModelQuotaBlock | undefined {
	return quotaBlocks.get(runtime)?.get(key);
}
