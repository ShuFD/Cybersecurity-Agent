import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { boundedAbort } from "./operational-guard.ts";

// Claude Code tools-reference defaults; timeout controls waiting in foreground,
// and execution only when the caller explicitly selects background execution.
export const FOREGROUND_DEFAULT_SECONDS = 120;
export const FOREGROUND_MAX_SECONDS = 600;
export const BACKGROUND_DEFAULT_SECONDS = 1800;
export const BACKGROUND_MAX_SECONDS = 7200;
export type CommandResult = AgentToolResult<unknown>;
type Status = "running" | "completed" | "failed" | "cancelled";
interface Job {
	id: string;
	tool: string;
	status: Status;
	background: boolean;
	notificationEligible: boolean;
	controller: AbortController;
	result?: CommandResult;
	error?: unknown;
	persistenceError?: string;
	outputPath: string;
	startedAt: number;
	sequence: number;
	completedAt?: number;
	enqueuedAt?: number;
	deliveredAt?: number;
	done: Promise<void>;
	timer?: ReturnType<typeof setTimeout>;
}
export function commandSeconds(value: unknown, background = false): number {
	if (value === undefined) return background ? BACKGROUND_DEFAULT_SECONDS : FOREGROUND_DEFAULT_SECONDS;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
		throw new Error("timeout must be positive finite seconds");
	return Math.min(value, background ? BACKGROUND_MAX_SECONDS : FOREGROUND_MAX_SECONDS);
}

export class BackgroundCommands {
	private readonly jobs = new Map<string, Job>();
	private readonly listeners = new Set<() => void>();
	private readonly directory: string;
	private closed = false;
	private suppressNotifications = false;
	private readonly notify: (content: string) => void;
	// Storage is independent of the command cwd, which can be read-only to the agent.
	constructor(storageRoot: string, notify: (content: string) => void, scope?: string) {
		this.notify = notify;
		this.directory = join(
			storageRoot,
			"command-tasks",
			scope ? createHash("sha256").update(scope).digest("hex") : randomUUID(),
		);
		if (scope && existsSync(this.directory)) {
			for (const name of readdirSync(this.directory)) {
				if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
				const saved = JSON.parse(readFileSync(join(this.directory, name), "utf8"));
				if (
					`${saved.task_id}.json` !== name ||
					!["running", "completed", "failed", "cancelled"].includes(saved.status)
				)
					throw new Error("Invalid saved command task");
				const interrupted = saved.status === "running";
				const job: Job = {
					id: saved.task_id,
					tool: saved.tool ?? "bash",
					status: interrupted ? "failed" : saved.status,
					background: saved.background === true,
					notificationEligible:
						saved.notification_eligible === true ||
						(interrupted && saved.background === true && !saved.notifications_suppressed),
					controller: new AbortController(),
					outputPath: join(this.directory, name),
					startedAt: saved.started_at,
					sequence: (saved.next_seq ?? 0) + (interrupted ? 1 : 0),
					completedAt: interrupted ? Date.now() : saved.completed_at,
					deliveredAt: saved.delivered_at,
					done: Promise.resolve(),
					result: interrupted
						? {
								content: [
									{
										type: "text",
										text: "Command interrupted by runtime restart; it was not replayed. Inspect saved output before deciding the next action.",
									},
								],
								details: { status: "failed", interrupted: true, previousResult: saved.result },
							}
						: saved.result,
				};
				this.jobs.set(job.id, job);
				this.persist(job);
			}
		}
	}
	get pendingCount(): number {
		return [...this.jobs.values()].filter((job) => job.status === "running").length;
	}
	owns(id: string): boolean {
		return this.jobs.has(id);
	}
	get undeliveredCount(): number {
		if (this.closed || this.suppressNotifications) return 0;
		return [...this.jobs.values()].filter((job) => job.notificationEligible && !job.deliveredAt).length;
	}
	retryUnacknowledged(): void {
		for (const job of this.jobs.values()) {
			if (job.enqueuedAt && !job.deliveredAt) {
				job.enqueuedAt = undefined;
				this.persist(job);
			}
		}
	}
	completionBatch(): { ids: string[]; content: string } {
		const jobs = [...this.jobs.values()].filter(
			(job) => job.notificationEligible && !job.enqueuedAt && !job.deliveredAt,
		);
		if (this.closed || this.suppressNotifications) return { ids: [], content: "" };
		return {
			ids: jobs.map((job) => job.id),
			content: jobs.map((job) => this.completionText(job)).join("\n\n"),
		};
	}
	markEnqueued(ids: string[]): void {
		for (const id of ids) {
			const job = this.jobs.get(id);
			if (!job) continue;
			job.enqueuedAt = Date.now();
			this.persist(job);
		}
	}
	acknowledge(ids: string[]): void {
		for (const id of ids) {
			const job = this.jobs.get(id);
			if (!job || job.deliveredAt) continue;
			job.deliveredAt = Date.now();
			this.persist(job);
		}
	}
	private completionText(job: Job): string {
		return `Command task ${job.id} (${job.tool}) ${job.status}. ${job.persistenceError ? `Output file unavailable: ${job.persistenceError}` : `Output: ${job.outputPath}`}\n${
			job.result?.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.slice(0, 2000) ?? ""
		}`;
	}
	beginRun(): void {
		if (!this.closed) this.suppressNotifications = false;
	}
	pendingContext(): string {
		return [...this.jobs.values()]
			.filter((job) => job.status === "running" && job.background)
			.map(
				(job) =>
					`Task ${job.id} (${job.tool}) is processing for ${Math.floor((Date.now() - job.startedAt) / 1000)}s; result is not available yet. Output: ${job.outputPath}`,
			)
			.join("\n");
	}
	completedEvidence(): { tool: string; content: unknown; details: unknown }[] {
		return [...this.jobs.values()]
			.filter((job) => job.status === "completed" && job.result)
			.map((job) => ({ tool: job.tool, content: job.result?.content, details: job.result?.details }));
	}
	settledExecutions(): { toolCallId: string; toolName: string; result: unknown; isError: boolean; backgroundCompletion: true }[] {
		return [...this.jobs.values()].filter(job => job.background && job.status !== "running").map(job => ({
			toolCallId: `background-completion:${job.id}`,
			toolName: job.tool,
			result: job.result ?? { content: [{ type: "text", text: String(job.error ?? job.status) }], details: { task_id: job.id, status: job.status } },
			isError: job.status !== "completed",
			backgroundCompletion: true,
		}));
	}
	private changed(): void {
		for (const listener of this.listeners) listener();
		this.listeners.clear();
	}
	waitForChange(signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) { reject(signal.reason); return; }
			const changed = () => { signal?.removeEventListener("abort", aborted); this.listeners.delete(changed); resolve(); };
			const aborted = () => { this.listeners.delete(changed); signal?.removeEventListener("abort", aborted); reject(signal?.reason); };
			this.listeners.add(changed);
			signal?.addEventListener("abort", aborted, { once: true });
		});
	}
	async waitForSettlement(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		while (this.pendingCount > 0) await this.waitForChange(signal);
	}
	private save(job: Job): void {
		mkdirSync(this.directory, { recursive: true });
		writeFileSync(
			`${job.outputPath}.tmp`,
			JSON.stringify(
				{
					task_id: job.id,
					status: job.status,
					tool: job.tool,
					background: job.background,
					notification_eligible: job.notificationEligible,
					notifications_suppressed: this.suppressNotifications || this.closed,
					result: job.result,
					started_at: job.startedAt,
					completed_at: job.completedAt,
					enqueued_at: job.enqueuedAt,
					delivered_at: job.deliveredAt,
					next_seq: job.sequence,
				},
				null,
				2,
			),
		);
		renameSync(`${job.outputPath}.tmp`, job.outputPath);
	}
	private persist(job: Job): void {
		try {
			this.save(job);
			job.persistenceError = undefined;
		} catch (error) {
			// Disk failures must not strand an executing or terminal in-memory job.
			job.persistenceError = String(error);
		}
	}
	private snapshot(job: Job): CommandResult {
		return {
			content: [
				{
					type: "text",
					text: `Task ${job.id}: ${job.status}. ${job.persistenceError ? `Output file unavailable: ${job.persistenceError}. Result remains available through command_task_output.` : `Output: ${job.outputPath}.`} ${job.status === "running" ? "Processing; continue independent work. Completion will be delivered automatically. Do not repeatedly poll." : "Result is available through command_task_output."}`,
				},
			],
			details: {
				task_id: job.id,
				status: job.status,
				output_path: job.outputPath,
				...(job.persistenceError ? { persistence_error: job.persistenceError } : {}),
			},
		};
	}
	output(id: string, afterSeq?: number): CommandResult {
		const job = this.jobs.get(id);
		if (!job)
			throw new Error(
				`Unknown command task: ${id}. Session task IDs: ${[...this.jobs.keys()].join(", ") || "none"}`,
			);
		const result =
			afterSeq === job.sequence || job.status === "running"
				? this.snapshot(job)
				: (job.result ?? this.snapshot(job));
		return {
			...result,
			details: {
				result_details: result.details,
				task_id: job.id,
				status: job.status,
				output_path: job.outputPath,
				next_seq: job.sequence,
				unchanged: afterSeq === job.sequence,
			},
		};
	}
	async stop(id: string): Promise<CommandResult> {
		const job = this.jobs.get(id);
		if (!job)
			throw new Error(
				`Unknown command task: ${id}. Session task IDs: ${[...this.jobs.keys()].join(", ") || "none"}`,
			);
		if (job.status === "running") job.controller.abort(new Error("Command task cancelled"));
		if (!(await boundedAbort(job.done))) this.cancelUnresponsive(job);
		return this.snapshot(job);
	}
	async cancelAll(): Promise<void> {
		this.suppressNotifications = true;
		for (const job of this.jobs.values()) {
			job.notificationEligible = false;
			if (job.status === "running") job.controller.abort(new Error("Parent run ended"));
			this.persist(job);
		}
		if (!(await boundedAbort(Promise.all([...this.jobs.values()].map((job) => job.done))))) {
			for (const job of this.jobs.values()) if (job.status === "running") this.cancelUnresponsive(job);
		}
	}
	private cancelUnresponsive(job: Job): void {
		job.status = "cancelled";
		job.completedAt = Date.now();
		job.sequence += 1;
		job.result = {
			content: [{ type: "text", text: "Cancellation grace expired; runtime cleanup is required." }],
			details: { status: "cancelled", cleanupPending: true },
		};
		if (job.timer) clearTimeout(job.timer);
		this.persist(job);
		this.changed();
	}
	async close(): Promise<void> {
		this.closed = true;
		await this.cancelAll();
	}
	async run(
		tool: string,
		input: { timeout?: unknown; run_in_background?: unknown },
		signal: AbortSignal | undefined,
		execute: (signal: AbortSignal, update: (result: CommandResult) => void) => Promise<CommandResult>,
		onUpdate?: (result: CommandResult) => void,
	): Promise<CommandResult> {
		if (this.closed || this.suppressNotifications || signal?.aborted)
			throw new Error("Command session is closed or aborted");
		const explicit = input.run_in_background === true;
		const seconds = commandSeconds(input.timeout, explicit);
		const id = randomUUID();
		const job: Job = {
			id,
			tool,
			status: "running",
			background: explicit,
			notificationEligible: false,
			controller: new AbortController(),
			outputPath: join(this.directory, `${id}.json`),
			startedAt: Date.now(),
			sequence: 0,
			done: Promise.resolve(),
		};
		// Publish only after initial persistence succeeds. Failed creation has no live task.
		this.save(job);
		this.jobs.set(id, job);
		const abort = () => job.controller.abort(signal?.reason);
		signal?.addEventListener("abort", abort, { once: true });
		const background = (limit: number) => {
			job.background = true;
			job.timer = setTimeout(
				() => job.controller.abort(new Error("Background execution deadline exceeded")),
				limit * 1000,
			);
		};
		if (explicit) background(seconds);
		job.done = Promise.resolve()
			.then(() => {
				if (job.controller.signal.aborted) throw job.controller.signal.reason;
				return execute(job.controller.signal, (result) => {
					job.result = result;
					job.sequence += 1;
					this.persist(job);
					if (!job.background) onUpdate?.(result);
				});
			})
			.then(
				(result) => {
					job.result = result;
					job.status = job.controller.signal.aborted ? "cancelled" : "completed";
				},
				(error: unknown) => {
					job.error = error;
					job.status = job.controller.signal.aborted ? "cancelled" : "failed";
					job.result = { content: [{ type: "text", text: String(error) }], details: { status: job.status } };
				},
			)
			.finally(() => {
				job.completedAt = Date.now();
				job.notificationEligible = job.background && !this.closed && !this.suppressNotifications;
				job.sequence += 1;
				if (job.timer) clearTimeout(job.timer);
				signal?.removeEventListener("abort", abort);
				this.persist(job);
				try {
					if (job.background && !this.closed && !this.suppressNotifications) this.notify(this.completionText(job));
				} catch {
					console.warn("Command task completion notification failed");
				} finally {
					this.changed();
				}
			});
		if (explicit) return this.snapshot(job);
		let waitTimer: ReturnType<typeof setTimeout> | undefined;
		const heartbeat = setInterval(() => onUpdate?.(this.snapshot(job)), 5000);
		try {
			await Promise.race([
				job.done,
				new Promise<void>((resolve) => {
					waitTimer = setTimeout(resolve, seconds * 1000);
				}),
			]);
		} finally {
			if (waitTimer) clearTimeout(waitTimer);
			clearInterval(heartbeat);
		}
		if (job.status !== "running") {
			if (job.error) throw job.error;
			return job.result ?? this.snapshot(job);
		}
		background(BACKGROUND_DEFAULT_SECONDS);
		this.persist(job);
		return this.snapshot(job);
	}
}

export function registerCommandTasks(
	pi: ExtensionAPI,
	tasks: BackgroundCommands,
	allowDelivery: () => boolean = () => true,
	legacyControl?: (id: string, stop: boolean) => Promise<CommandResult>,
): () => void {
	let queued: { taskIds: string[]; content: { type: "text"; text: string }[] } | undefined;
	const flush = () => {
		if (!allowDelivery()) return;
		const batch = tasks.completionBatch();
		if (!batch.ids.length) return;
		// Mark before sending: idle send can synchronously emit message_end.
		tasks.markEnqueued(batch.ids);
		if (queued) {
			// Pi retains this queued message until the current tool batch finishes.
			queued.taskIds.push(...batch.ids);
			queued.content.push({ type: "text", text: batch.content });
			return;
		}
		queued = { taskIds: batch.ids, content: [{ type: "text", text: batch.content }] };
		try {
			pi.sendMessage(
				{
					customType: "secheur-command-completion",
					content: queued.content,
					display: false,
					details: { taskIds: queued.taskIds },
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
		} catch {
			queued = undefined;
			tasks.retryUnacknowledged();
			console.warn("Command task completion enqueue failed; result retained for retry");
		}
	};
	pi.on("turn_end", (_event, ctx) => {
		if (!ctx.signal?.aborted) flush();
	});
	pi.on("before_agent_start", () => {
		if (!allowDelivery()) return;
		const batch = tasks.completionBatch();
		if (!batch.ids.length) return;
		tasks.markEnqueued(batch.ids);
		// At preflight Pi has not entered its agent loop. Sending a triggering
		// message here would start a competing prompt; return an initial message.
		return {
			message: {
				customType: "secheur-command-completion",
				content: batch.content,
				display: false,
				details: { taskIds: batch.ids },
			},
		};
	});
	pi.on("agent_settled", () => {
		queued = undefined;
		tasks.retryUnacknowledged();
		flush();
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "custom" || event.message.customType !== "secheur-command-completion") return;
		const details = event.message.details as { taskIds?: unknown } | undefined;
		if (Array.isArray(details?.taskIds))
			tasks.acknowledge(details.taskIds.filter((id): id is string => typeof id === "string"));
		queued = undefined;
	});
	for (const name of ["command_task_output", "command_task_stop"] as const)
		pi.registerTool({
			name,
			label: name,
			description:
				name === "command_task_output"
					? "Read command task status/output without waiting; completion is delivered automatically."
					: "Cancel a command task owned by this session.",
			parameters: Type.Object({ task_id: Type.String(), after_seq: Type.Optional(Type.Integer({ minimum: 0 })) }),
			async execute(_id, input) {
				if (!tasks.owns(input.task_id) && legacyControl)
					return legacyControl(input.task_id, name === "command_task_stop");
				return name === "command_task_output"
					? tasks.output(input.task_id, input.after_seq)
					: tasks.stop(input.task_id);
			},
		});
	pi.on("context", (event) => {
		const pending = tasks.pendingContext();
		if (pending)
			return {
				messages: [
					...event.messages,
					{ role: "user" as const, content: `[Command tasks]\n${pending}`, timestamp: Date.now() },
				],
			};
	});
	return flush;
}
