import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SecHeurConfig } from "./config.ts";
import { LegacyToolHost } from "./legacy-host.ts";

const DEFAULT_INTERVAL_SECONDS = 60;
const MIN_INTERVAL_SECONDS = 5;
const SCHEDULER_CALL_TIMEOUT_MS = 30_000;

interface SchedulerHostResponse {
	ok: boolean;
	data?: unknown;
	error?: string;
}

interface SchedulerHost {
	call(
		tool: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<SchedulerHostResponse>;
	close(): void;
}

export interface SchedulerCheckResult {
	available: boolean;
	task?: string;
	intervalSeconds: number;
}

export interface SchedulerBackend {
	check(signal?: AbortSignal): Promise<SchedulerCheckResult>;
	done(result: string, signal?: AbortSignal): Promise<void>;
	close(): void;
}

export interface SchedulerTarget {
	isBusy(): boolean;
	submit(task: string, onDone: (result: string) => Promise<void>): Promise<string>;
}

export type SchedulerTickResult =
	| { submitted: true; sessionId: string }
	| { submitted: false; reason: "already-running" | "busy" | "error" | "no-task" | "stopped" | "unavailable" };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedInterval(value: unknown, fallback = DEFAULT_INTERVAL_SECONDS): number {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? Math.max(MIN_INTERVAL_SECONDS, Math.trunc(parsed)) : fallback;
}

export class LegacySchedulerBackend implements SchedulerBackend {
	private readonly config: SecHeurConfig;
	private readonly host: SchedulerHost;
	private intervalSeconds = DEFAULT_INTERVAL_SECONDS;

	constructor(config: SecHeurConfig, env: NodeJS.ProcessEnv = process.env, host?: SchedulerHost) {
		this.config = config;
		this.host = host ?? new LegacyToolHost(config, () => config.permissionMode, env);
	}

	private schedulerSourceExists(): boolean {
		return (
			existsSync(join(this.config.projectRoot, "reflect", "scheduler.py")) ||
			existsSync(join(this.config.legacyRoot, "reflect", "scheduler.py"))
		);
	}

	private hasTaskDefinitions(): boolean {
		try {
			return readdirSync(join(this.config.projectRoot, "sche_tasks"), { withFileTypes: true }).some(
				(entry) => entry.isFile() && entry.name.endsWith(".json"),
			);
		} catch {
			return false;
		}
	}

	async check(signal?: AbortSignal): Promise<SchedulerCheckResult> {
		if (!this.schedulerSourceExists()) {
			return { available: false, intervalSeconds: this.intervalSeconds };
		}
		if (!this.hasTaskDefinitions()) {
			return { available: true, intervalSeconds: this.intervalSeconds };
		}
		const response = await this.host.call("__scheduler_check", {}, signal, SCHEDULER_CALL_TIMEOUT_MS);
		if (!response.ok) throw new Error(response.error ?? "Scheduler check failed");
		if (!isRecord(response.data)) throw new Error("Scheduler check returned invalid data");
		this.intervalSeconds = normalizedInterval(response.data.interval, this.intervalSeconds);
		const task = typeof response.data.task === "string" ? response.data.task.trim() : "";
		return {
			available: response.data.available !== false,
			...(task ? { task } : {}),
			intervalSeconds: this.intervalSeconds,
		};
	}

	async done(result: string, signal?: AbortSignal): Promise<void> {
		const response = await this.host.call("__scheduler_done", { result }, signal, SCHEDULER_CALL_TIMEOUT_MS);
		if (!response.ok) throw new Error(response.error ?? "Scheduler completion callback failed");
	}

	close(): void {
		this.host.close();
	}
}

export class SchedulerPoller {
	private readonly backend: SchedulerBackend;
	private readonly target: SchedulerTarget;
	private readonly reportError: (error: Error) => void;
	private intervalSeconds = DEFAULT_INTERVAL_SECONDS;
	private inFlight?: Promise<SchedulerTickResult>;
	private loop?: Promise<void>;
	private controller?: AbortController;

	constructor(
		backend: SchedulerBackend,
		target: SchedulerTarget,
		reportError = (error: Error) => console.error(error),
	) {
		this.backend = backend;
		this.target = target;
		this.reportError = reportError;
	}

	get interval(): number {
		return this.intervalSeconds;
	}

	async tick(signal?: AbortSignal): Promise<SchedulerTickResult> {
		if (this.inFlight) return { submitted: false, reason: "already-running" };
		const operation = this.runTick(signal);
		this.inFlight = operation;
		try {
			return await operation;
		} finally {
			if (this.inFlight === operation) this.inFlight = undefined;
		}
	}

	private async runTick(signal?: AbortSignal): Promise<SchedulerTickResult> {
		if (signal?.aborted) return { submitted: false, reason: "stopped" };
		try {
			if (this.target.isBusy()) return { submitted: false, reason: "busy" };
			const checked = await this.backend.check(signal);
			this.intervalSeconds = normalizedInterval(checked.intervalSeconds, this.intervalSeconds);
			if (signal?.aborted) return { submitted: false, reason: "stopped" };
			if (!checked.available) return { submitted: false, reason: "unavailable" };
			if (!checked.task) return { submitted: false, reason: "no-task" };
			if (this.target.isBusy()) return { submitted: false, reason: "busy" };
			const sessionId = await this.target.submit(checked.task, (result) => this.backend.done(result));
			return { submitted: true, sessionId };
		} catch (error) {
			if (signal?.aborted) return { submitted: false, reason: "stopped" };
			const normalized = error instanceof Error ? error : new Error(String(error));
			this.reportError(normalized);
			return { submitted: false, reason: "error" };
		}
	}

	start(): void {
		if (this.loop) return;
		const controller = new AbortController();
		this.controller = controller;
		const operation = (async () => {
			while (!controller.signal.aborted) {
				await this.tick(controller.signal);
				if (controller.signal.aborted) break;
				await new Promise<void>((resolveWait) => {
					const stopWaiting = () => {
						clearTimeout(timer);
						controller.signal.removeEventListener("abort", stopWaiting);
						resolveWait();
					};
					const timer = setTimeout(stopWaiting, this.intervalSeconds * 1000);
					timer.unref();
					controller.signal.addEventListener("abort", stopWaiting, { once: true });
					if (controller.signal.aborted) stopWaiting();
				});
			}
		})();
		this.loop = operation;
		const clearLoop = () => {
			if (this.loop === operation) this.loop = undefined;
			if (this.controller === controller) this.controller = undefined;
		};
		void operation.then(clearLoop, (error: unknown) => {
			clearLoop();
			try {
				this.reportError(error instanceof Error ? error : new Error(String(error)));
			} catch {
				// 错误上报本身不能造成未处理的 Scheduler rejection。
			}
		});
	}

	async stop(): Promise<void> {
		this.controller?.abort();
		this.backend.close();
		const pending: Promise<unknown>[] = [];
		if (this.loop) pending.push(this.loop);
		if (this.inFlight) pending.push(this.inFlight);
		if (pending.length > 0) await Promise.allSettled(pending);
	}
}
