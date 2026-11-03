import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import type { BackgroundCommands, CommandResult } from "./background-commands.ts";
import { COMMAND_BUDGET_GUIDANCE } from "./command-budget.ts";
import type { PermissionMode, SecHeurConfig } from "./config.ts";
import { ABORT_GRACE_MS } from "./operational-guard.ts";
import { formatLegacyEnvironmentReport, inspectLegacyEnvironment } from "./python-runtime.ts";

interface LegacyToolSchema {
	name: string;
	description: string;
	parameters: TSchema;
}

interface LegacyToolResponse {
	id: number;
	ok: boolean;
	content?: string;
	data?: unknown;
	nextPrompt?: string;
	shouldExit?: boolean;
	diagnostics?: string;
	error?: string;
}

interface PendingRequest {
	resolve: (response: LegacyToolResponse) => void;
	reject: (error: Error) => void;
	cleanup: () => void;
}

const SPECIAL_TOOLS = new Set(["ask_user", "tool_search", "skill", "sub_agent", "mcp_refresh", "exit_plan_mode"]);
const FALLBACK_PARAMETERS = Type.Object({}, { additionalProperties: true });
const DEFAULT_TOOL_TIMEOUT_MS = 20 * 60 * 1000;

function terminateChild(child: ChildProcessWithoutNullStreams): void {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	const forceKill = setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}, ABORT_GRACE_MS);
	forceKill.unref();
	child.once("exit", () => clearTimeout(forceKill));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadLegacyToolSchemas(path: string): LegacyToolSchema[] {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!Array.isArray(parsed)) throw new Error(`Legacy tool schema must be an array: ${path}`);
	return parsed.flatMap((entry) => {
		if (!isRecord(entry) || !isRecord(entry.function)) return [];
		const name = typeof entry.function.name === "string" ? entry.function.name : "";
		if (!name || SPECIAL_TOOLS.has(name)) return [];
		const description = typeof entry.function.description === "string" ? entry.function.description : name;
		const parameters = isRecord(entry.function.parameters)
			? (entry.function.parameters as TSchema)
			: FALLBACK_PARAMETERS;
		return [{ name, description, parameters }];
	});
}

export class LegacyToolHost {
	private readonly config: SecHeurConfig;
	private readonly getPermissionMode: () => PermissionMode;
	private readonly environment: NodeJS.ProcessEnv;
	private readonly pending = new Map<number, PendingRequest>();
	private nextId = 1;
	private child?: ChildProcessWithoutNullStreams;
	private lines?: ReadlineInterface;
	private environmentReady = false;
	private stderr = "";
	private memoryReferenceEnabled = true;
	private knowledgeBaseEnabled: boolean;
	private webVerbsEnabled = true;

	constructor(
		config: SecHeurConfig,
		getPermissionMode: () => PermissionMode = () => config.permissionMode,
		environment: NodeJS.ProcessEnv = process.env,
	) {
		this.config = config;
		this.getPermissionMode = getPermissionMode;
		this.environment = {
			...environment,
			SECHEUR_COMMAND_TASK_OUTPUT_DIR: join(config.stateDir, "command-tasks", "legacy", randomUUID()),
		};
		this.knowledgeBaseEnabled = config.knowledgeBaseEnabled;
	}

	setMemoryReferenceEnabled(enabled: boolean): void {
		this.memoryReferenceEnabled = enabled;
	}

	setKnowledgeBaseEnabled(enabled: boolean): void {
		this.knowledgeBaseEnabled = enabled;
	}

	setWebVerbsEnabled(enabled: boolean): void {
		this.webVerbsEnabled = enabled;
	}

	private ensureStarted(): ChildProcessWithoutNullStreams {
		if (this.child) {
			if (
				!this.child.killed &&
				this.child.exitCode === null &&
				this.child.signalCode === null &&
				!this.child.stdin.destroyed &&
				!this.child.stdin.writableEnded
			) return this.child;
			this.handleChildFailure(this.child, new Error("Legacy tool host is no longer writable"));
		}
		if (!this.environmentReady) {
			const diagnostic = inspectLegacyEnvironment(this.config);
			if (!diagnostic.ready) throw new Error(formatLegacyEnvironmentReport(diagnostic));
			this.environmentReady = true;
		}
		const child = spawn(
			this.config.pythonExecutable,
			["-u", join(this.config.legacyRoot, "secheur_pi_bridge.py"), "--cwd", this.config.projectRoot],
			{
				cwd: this.config.legacyRoot,
				env: { ...this.environment, SECHEUR_PERMISSION_MODE: this.getPermissionMode() },
				stdio: "pipe",
			},
		);
		this.child = child;
		this.stderr = "";
		// Stream failures are asynchronous EventEmitter errors, not exceptions caught by write().
		// Keep listeners on old streams too: late errors must not crash the bridge or affect a newer child.
		for (const stream of [child.stdin, child.stdout, child.stderr]) {
			stream.on("error", (error: Error) => this.handleChildFailure(child, error));
		}
		this.lines = createInterface({ input: child.stdout });
		this.lines.on("line", (line) => this.handleLine(line));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.stderr = `${this.stderr}${chunk}`.slice(-8000);
		});
		child.once("error", (error) => this.handleChildFailure(child, error));
		child.once("exit", (code, signal) => {
			if (this.child !== child) return;
			const detail = this.stderr.trim();
			this.handleChildFailure(
				child,
				new Error(
					`Legacy tool host exited: code=${code ?? "none"} signal=${signal ?? "none"}${detail ? `\n${detail}` : ""}`,
				),
			);
		});
		return child;
	}

	private handleChildFailure(child: ChildProcessWithoutNullStreams, error: Error): void {
		if (this.child !== child) return;
		this.lines?.close();
		this.lines = undefined;
		this.child = undefined;
		this.stderr = "";
		this.rejectAll(error);
		terminateChild(child);
	}

	private stopChild(error: Error): void {
		const child = this.child;
		this.lines?.close();
		this.lines = undefined;
		this.child = undefined;
		this.stderr = "";
		this.rejectAll(error);
		if (child) terminateChild(child);
	}

	private handleLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(parsed) || typeof parsed.id !== "number" || typeof parsed.ok !== "boolean") return;
		const pending = this.pending.get(parsed.id);
		if (!pending) return;
		this.pending.delete(parsed.id);
		pending.cleanup();
		pending.resolve(parsed as unknown as LegacyToolResponse);
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.cleanup();
			pending.reject(error);
		}
		this.pending.clear();
	}

	async call(
		tool: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		timeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
	): Promise<LegacyToolResponse> {
		if (signal?.aborted) throw new Error(`Legacy tool aborted: ${tool}`);
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`Invalid Legacy tool timeout: ${timeoutMs}`);
		const child = this.ensureStarted();
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				if (!this.pending.has(id)) return;
				this.stopChild(new Error(`Legacy tool aborted: ${tool}`));
			};
			const timer = setTimeout(() => {
				if (!this.pending.has(id)) return;
				this.stopChild(new Error(`Legacy tool timed out: ${tool}`));
			}, timeoutMs);
			timer.unref();
			this.pending.set(id, {
				resolve,
				reject,
				cleanup: () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
				},
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				child.stdin.write(
					`${JSON.stringify({
						id,
						tool,
						args,
						permissionMode: this.getPermissionMode(),
						memoryReferenceEnabled: this.memoryReferenceEnabled,
						knowledgeBaseEnabled: this.knowledgeBaseEnabled,
						webVerbsEnabled: this.webVerbsEnabled,
					})}\n`,
					(error) => {
						if (error && this.pending.has(id)) this.stopChild(error);
					},
				);
			} catch (error) {
				this.stopChild(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	close(): void {
		this.stopChild(new Error("Legacy tool host closed"));
	}
}

export function registerLegacyTools(
	pi: ExtensionAPI,
	config: SecHeurConfig,
	host: LegacyToolHost,
	options: { skipNames?: ReadonlySet<string>; boundedCommands?: boolean; commandTasks?: BackgroundCommands } = {},
): void {
	for (const tool of loadLegacyToolSchemas(join(config.legacyRoot, "assets", "tools_schema.json"))) {
		if (options.skipNames?.has(tool.name)) continue;
		const properties = isRecord(tool.parameters) ? tool.parameters.properties : undefined;
		pi.registerTool({
			name: tool.name,
			label: tool.name,
			description:
				options.boundedCommands && tool.name === "code_run"
					? `${tool.description} ${COMMAND_BUDGET_GUIDANCE}`
					: tool.description,
			parameters:
				options.boundedCommands && tool.name === "code_run" && isRecord(properties)
					? {
							...tool.parameters,
							properties: {
								...properties,
								timeout: Type.Optional(
									Type.Number({
										description:
											"Foreground wait seconds: default 120/max 600. Explicit background execution seconds: default 1800/max 7200.",
									}),
								),
							},
						}
					: tool.parameters,
			executionMode: "sequential",
			async execute(_toolCallId, params, signal, onUpdate) {
				const input = isRecord(params) ? params : {};
				if (
					(tool.name === "task_output" || tool.name === "task_stop") &&
					typeof input.task_id === "string" &&
					options.commandTasks?.owns(input.task_id)
				) {
					return tool.name === "task_output"
						? options.commandTasks.output(
								input.task_id,
								typeof input.after_seq === "number" ? input.after_seq : undefined,
							)
						: options.commandTasks.stop(input.task_id);
				}
				const bounded = options.boundedCommands && tool.name === "code_run";
				if (bounded && options.commandTasks && input.inline_eval !== true) {
					return options.commandTasks.run(
						"code_run",
						input,
						signal,
						async (jobSignal): Promise<CommandResult> => {
							// Start in the existing Python background runner, keeping its IPC host responsive.
							const response = await host.call(
								"code_run",
								{ ...input, timeout: undefined, run_in_background: true },
								undefined,
								30000,
							);
							if (!response.ok) throw new Error(response.error ?? "code_run failed");
							const taskId = isRecord(response.data) ? response.data.task_id : undefined;
							if (typeof taskId !== "string")
								throw new Error(response.content || "Legacy background runner returned no task_id");
							try {
								while (!jobSignal.aborted) {
									const result = await host.call(
										"task_output",
										{ task_id: taskId, max_chars: 30000 },
										undefined,
										30000,
									);
									if (!result.ok) throw new Error(result.error ?? "task_output failed");
									if (isRecord(result.data) && result.data.status !== "running") {
										if (result.data.status === "failed")
											throw new Error(result.content ?? JSON.stringify(result.data));
										return {
											content: [
												{
													type: "text",
													text: `[Task] ${taskId} status=${String(result.data.status)}\n${typeof result.data.stdout === "string" ? result.data.stdout : (result.content ?? JSON.stringify(result.data))}`,
												},
											],
											details: result.data,
										};
									}
									await new Promise<void>((resolve) => {
										const finish = () => {
											clearTimeout(timer);
											jobSignal.removeEventListener("abort", finish);
											resolve();
										};
										const timer = setTimeout(finish, 1000);
										jobSignal.addEventListener("abort", finish, { once: true });
										if (jobSignal.aborted) finish();
									});
								}
								throw new Error("Legacy command task cancelled");
							} finally {
								// Cancelling a job must not kill the shared Python IPC host.
								if (jobSignal.aborted)
									await host.call("__command_task_stop", { task_id: taskId }, undefined, ABORT_GRACE_MS);
							}
						},
						onUpdate,
					);
				}
				const response = await host.call(tool.name, input, signal, undefined);
				if (!response.ok) throw new Error(response.error ?? `Legacy tool failed: ${tool.name}`);
				if (
					(tool.name === "task_output" || tool.name === "task_stop") &&
					isRecord(response.data) &&
					response.data.status === "not_found"
				)
					throw new Error(
						`Unknown background task: ${String(input.task_id)}. Use the task ID returned by launch.`,
					);
				const text = [response.content, response.nextPrompt].filter(Boolean).join("\n\n");
				return {
					content: [{ type: "text", text: text || JSON.stringify(response.data ?? null) }],
					details: {
						data: response.data,
						shouldExit: response.shouldExit,
						diagnostics: response.diagnostics,
					},
				};
			},
		});
	}
	pi.on("session_shutdown", async () => {
		await options.commandTasks?.close();
		host.close();
	});
}
