import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as serviceDelay, setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	isRetryableAssistantError,
	isTokenPlanQuotaExhausted,
	type Model,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentToolResult,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	type InlineExtension,
	type ModelRuntime,
	type PromptOptions,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type AgentDefinition, discoverAgentDefinitions } from "./agent-definitions.ts";
import { disabledRegistryNames, isRegistryResourceEnabled, type PermissionMode, type SecHeurConfig } from "./config.ts";
import { PlanningFailureError } from "./planning/failures.ts";
import { markModelQuotaUnavailable, modelQuotaUnavailable } from "./planning/model-availability.ts";
import { modelErrorMetadata } from "./planning/model-error-metadata.ts";

export interface PiSubAgentDetails {
	agent: string;
	source: "builtin" | "user" | "project";
	status: "running" | "success";
	sessionId?: string;
	allowedTools: string[];
	messageCount: number;
}

interface ChildExtensionBundle {
	extension: InlineExtension;
	close(): void;
}

export interface RunPiSubAgentOptions {
	config: SecHeurConfig;
	agentType: string;
	task: string;
	cwd?: string;
	permissionMode: PermissionMode;
	createChildExtension(permissionMode: PermissionMode): ChildExtensionBundle;
}

export interface RunPiCodingTaskOptions {
	role?: "planner" | "observer" | "executor";
	maxOutputTokens?: number;
	beforeModelRequest?: (signal?: AbortSignal) => Promise<void>;
	requestToolNames?: () => readonly string[] | undefined;
	executionIdentity?: { runId: string; taskId: string; leaseId: string };
	config: SecHeurConfig;
	task: string;
	cwd: string;
	model?: Model<Api>;
	modelRuntime?: ModelRuntime;
	thinkingLevel?: ThinkingLevel;
	systemPrompt?: string;
	allowedTools?: string[];
	excludedTools?: string[];
	extensionFactories?: InlineExtension[];
	/** Host roles load only explicitly supplied extensions, without project skills or prompts. */
	isolatedRoleResources?: boolean;
	images?: PromptOptions["images"];
	signal?: AbortSignal;
	onUpdate?: (messages: readonly unknown[]) => void;
	onModelTurn?: (cost: number, message?: AssistantMessage) => void;
	onLifecycleEvent?: (type: string, payload?: Record<string, unknown>) => void;
	onSteerReady?: (steer: (message: string) => Promise<void>) => void;
	requiredToolName?: string;
	requiredToolRecoveryAttempts?: number;
	/** Managed owners continue unfinished work until durable handoff or an outer boundary. */
	continueUntilRequiredTool?: boolean;
	/** Hand an explicitly submitted local task back to its owner at Pi's native tool-batch boundary. */
	handoffOnRequiredTool?: boolean;
	/** Optional durable completion predicate for alternate handoff protocols. */
	isRequiredToolComplete?: () => boolean;
	onToolExecution?: (execution: PiToolExecution) => void;
	propagateToolExecutionObserverErrors?: boolean;
	/** Keep cancelled tools' resources owned until Pi actually becomes idle. */
	onPendingSettlement?: (settlement: Promise<void>) => void;
	/** Opt-in owner for sequential Cairn intents; ordinary callers remain one-shot. */
	sessionOwner?: PiCodingSessionOwner;
	backgroundTasks?: {
		hasPending(): boolean;
		waitForSettlement(signal?: AbortSignal): Promise<void>;
		settledExecutions?(): PiToolExecution[];
	};
}

/** One Pi session, never shared by simultaneous attempts or different engines. */
export class PiCodingSessionOwner {
	session?: AgentSession;
	inUse = false;
	dispose(): void {
		if (this.inUse) throw new Error("Cannot dispose an active coding session");
		this.session?.dispose();
		this.session = undefined;
	}
}

export interface PiToolExecution {
	toolCallId: string;
	toolName: string;
	toolInput?: unknown;
	result: unknown;
	isError: boolean;
	backgroundCompletion?: boolean;
}

export interface VerifierInfrastructureFailureDetails {
	toolName: string;
	failureCategory: string;
	status?: string;
	message?: string;
}

/** A structured verifier failure must bypass protocol-only recovery. */
export class VerifierInfrastructureError extends Error {
	readonly source = "verifier" as const;
	readonly code = "verifier_infrastructure_error" as const;
	readonly toolName: string;
	readonly failureCategory: string;
	readonly status?: string;

	constructor(details: VerifierInfrastructureFailureDetails) {
		const failureCategory = details.failureCategory.trim() || "verifier";
		const message = details.message?.trim() || "verification unavailable";
		super(`Flag verifier infrastructure failure (${failureCategory}): ${message}`);
		this.name = "VerifierInfrastructureError";
		this.toolName = details.toolName;
		this.failureCategory = failureCategory;
		this.status = details.status;
	}
}

export interface PiCodingTaskResult {
	messages: readonly unknown[];
	finalText: string;
	toolExecutions: PiToolExecution[];
}

export function abortError(signal?: AbortSignal, fallback = "Operation aborted"): Error {
	const reason = signal?.reason;
	if (reason instanceof Error) return reason;
	const error = new Error(typeof reason === "string" && reason.trim() ? reason : fallback);
	error.name = "AbortError";
	return error;
}

export function throwIfAborted(signal?: AbortSignal, fallback = "Operation aborted"): void {
	if (signal?.aborted) throw abortError(signal, fallback);
}

export function discoverPiSubAgents(config: SecHeurConfig, includeDisabled = false): AgentDefinition[] {
	return discoverAgentDefinitions(config, includeDisabled);
}

function activeToolNames(allowedTools: string[] | undefined): string[] | undefined {
	if (!allowedTools) return undefined;
	const aliases: Record<string, string> = {
		code_run: "bash",
		file_patch: "edit",
		file_read: "read",
		file_write: "write",
	};
	return [...new Set(allowedTools.map((name) => aliases[name] ?? name))];
}

function childPermissionMode(mode: PermissionMode): PermissionMode {
	if (mode === "bypassPermissions" || mode === "plan" || mode === "dontAsk") return mode;
	return "dontAsk";
}

function lifecycleError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function verifierInfrastructureFailureFromExecution(
	execution: PiToolExecution,
): VerifierInfrastructureError | undefined {
	if (execution.toolName !== "verify_flag" && execution.toolName !== "check_flag") return undefined;
	if (!isRecord(execution.result)) return undefined;
	const details = isRecord(execution.result.details) ? execution.result.details : undefined;
	const data = details && isRecord(details.data) ? details.data : undefined;
	if (
		!data ||
		data.verificationOutcome === "correct" ||
		(data.verificationOutcome !== "infra_error" && data.failureCategory !== "quota_exhausted")
	)
		return undefined;
	return new VerifierInfrastructureError({
		toolName: execution.toolName,
		failureCategory: typeof data.failureCategory === "string" ? data.failureCategory : "verifier",
		...(typeof data.status === "string" ? { status: data.status } : {}),
		...(typeof data.message === "string" ? { message: data.message } : {}),
	});
}

export function finalAssistantText(messages: readonly unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "assistant")
			continue;
		if (!("content" in message) || !Array.isArray(message.content)) continue;
		const text = message.content
			.flatMap((part) =>
				typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part
					? [String(part.text)]
					: [],
			)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

function lastAssistantStopReason(messages: readonly unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "assistant")
			continue;
		return "stopReason" in message && typeof message.stopReason === "string" ? message.stopReason : undefined;
	}
	return undefined;
}

function lastAssistantServiceError(
	messages: readonly unknown[],
): { error: string; quotaExhausted: boolean; retryable: boolean } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") continue;
		if (!("stopReason" in message) || message.stopReason !== "error") return undefined;
		const error =
			"errorMessage" in message && typeof message.errorMessage === "string"
				? message.errorMessage
				: "Unknown model service error";
		return {
			error,
			quotaExhausted: isTokenPlanQuotaExhausted(error),
			retryable: isRetryableAssistantError(message as AssistantMessage),
		};
	}
	return undefined;
}

/** Keep the owned session alive after Pi finishes its retry policy; do not start protocol repair. */
async function waitForModelServiceBoundary(
	options: RunPiCodingTaskOptions,
	failure: { error: string; quotaExhausted: boolean },
): Promise<never> {
	throwIfAborted(options.signal, "Model service wait aborted");
	if (!options.signal) throw new Error(`Model service failed without an outer wait boundary: ${failure.error}`);
	const startedAt = Date.now();
	if (failure.quotaExhausted && options.modelRuntime && options.model)
		markModelQuotaUnavailable(options.modelRuntime, `${options.model.provider}:${options.model.id}`, failure.error);
	try {
		options.onLifecycleEvent?.("model_service_wait", {
			reason: failure.quotaExhausted ? "provider_quota_exhausted" : "model_request_failed",
			error: failure.error.slice(0, 2048),
			...modelErrorMetadata(failure.error),
			protocolRecovery: false,
			quotaExhausted: failure.quotaExhausted,
		});
	} catch {
		// Diagnostic listeners never change the execution boundary.
	}
	try {
		return await new Promise<never>((_resolve, reject) => {
			const signal = options.signal;
			if (!signal) return; // Narrowed before constructing the wait.
			const abort = () => reject(abortError(signal, "Model service wait aborted"));
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) {
				signal.removeEventListener("abort", abort);
				abort();
			}
		});
	} finally {
		try {
			options.onLifecycleEvent?.("model_service_wait_end", {
				reason: failure.quotaExhausted ? "provider_quota_exhausted" : "model_request_failed",
				quotaExhausted: failure.quotaExhausted,
				waitElapsedMs: Date.now() - startedAt,
				protocolRecovery: false,
			});
		} catch {
			/* Metadata only. */
		}
	}
}

/**
 * Settle a Pi prompt from the caller's cancellation signal instead of waiting
 * for a provider or tool that may not observe the signal. The underlying
 * prompt is still asked to abort by the caller. runPiCodingTask's cleanup owns
 * the official abort/idle settlement after this race has returned.
 */
function promptWithAbortSettlement(
	session: AgentSession,
	text: string,
	promptOptions: PromptOptions | undefined,
	signal: AbortSignal | undefined,
	requestAbort: () => void,
	fallback: string,
): Promise<void> {
	if (signal?.aborted) {
		requestAbort();
		return Promise.reject(abortError(signal, fallback));
	}
	const promptPromise = session.prompt(text, promptOptions);
	if (!signal) return promptPromise;

	let removeAbortListener: (() => void) | undefined;
	const abortPromise = new Promise<never>((_, reject) => {
		const onAbort = () => {
			try {
				requestAbort();
			} finally {
				reject(abortError(signal, fallback));
			}
		};
		signal.addEventListener("abort", onAbort, { once: true });
		removeAbortListener = () => signal.removeEventListener("abort", onAbort);
		if (signal.aborted) onAbort();
	});

	return Promise.race([promptPromise, abortPromise]).finally(() => removeAbortListener?.());
}

function requiredToolComplete(options: RunPiCodingTaskOptions, toolExecutions: readonly PiToolExecution[]): boolean {
	return (
		options.isRequiredToolComplete?.() ??
		toolExecutions.some((execution) => execution.toolName === options.requiredToolName && !execution.isError)
	);
}

async function recoverRequiredTool(
	session: AgentSession,
	toolExecutions: readonly PiToolExecution[],
	options: RunPiCodingTaskOptions,
	requestAbort: () => void,
	verifierFailure?: () => VerifierInfrastructureError | undefined,
	observerFailure?: () => unknown,
): Promise<void> {
	const requiredToolName = typeof options.requiredToolName === "string" ? options.requiredToolName : "";
	if (!requiredToolName) return;
	throwIfAborted(options.signal, "Required-tool recovery aborted");
	const throwIfVerifierFailed = (): void => {
		const failure = verifierFailure?.();
		if (failure) throw failure;
	};
	const throwIfObserverFailed = (): void => {
		const failure = observerFailure?.();
		if (failure) throw failure;
	};
	throwIfVerifierFailed();
	throwIfObserverFailed();
	if (requiredToolComplete(options, toolExecutions)) return;
	if (lastAssistantServiceError(session.messages)) return;
	const available = new Set(session.getAllTools().map((tool) => tool.name));
	const attempts = Math.max(1, Math.min(3, Math.trunc(options.requiredToolRecoveryAttempts ?? 1)));
	const emitLifecycle = (type: string, payload: Record<string, unknown> = {}): void => {
		try {
			options.onLifecycleEvent?.(type, payload);
		} catch {
			// Diagnostic observers must never change required-tool recovery semantics.
		}
	};
	emitLifecycle("required_tool_recovery_start", {
		requiredToolName,
		available: available.has(requiredToolName),
		attempts,
	});
	if (!available.has(requiredToolName)) {
		throwIfAborted(options.signal, "Required-tool recovery aborted");
		emitLifecycle("required_tool_recovery_end", {
			requiredToolName,
			attempts,
			attemptsUsed: 0,
			recovered: false,
			skipped: "required_tool_unavailable",
		});
		if (options.continueUntilRequiredTool) throw new Error(`Required result tool unavailable: ${requiredToolName}`);
		return;
	}
	const originalTools = session.getActiveToolNames();
	let attemptsUsed = 0;
	let recovered = false;
	let recoveryError: string | undefined;
	try {
		for (let attempt = 1; attempt <= attempts; attempt += 1) {
			throwIfAborted(options.signal, "Required-tool recovery aborted");
			throwIfVerifierFailed();
			throwIfObserverFailed();
			if (requiredToolComplete(options, toolExecutions)) {
				recovered = true;
				return;
			}
			attemptsUsed = attempt;
			emitLifecycle("required_tool_recovery_attempt_start", {
				requiredToolName,
				attempt,
				attempts,
			});
			try {
				throwIfAborted(options.signal, "Required-tool recovery aborted");
				const stopReason = lastAssistantStopReason(session.messages);
				// Pi.prompt owns a complete tool loop, not one provider request. Keep
				// working tools available if protocol repair needs another observation.
				session.setActiveToolsByName([...new Set([...originalTools, requiredToolName])]);
				throwIfAborted(options.signal, "Required-tool recovery aborted");
				await promptWithAbortSettlement(
					session,
					[
						"Protocol recovery: persist an honest structured report for the current owned task.",
						stopReason === "length"
							? "The previous model turn was truncated by the output length limit. Reuse saved observations; do not restart the work."
							: "The previous model turn did not submit an accepted structured result.",
						`Prefer ${requiredToolName} with the best grounded result from the work already performed.`,
						"Report partial work and uncertainty honestly. If another observation or request repair is needed, working tools remain available: continue the existing task and then report. Never invent success to satisfy the protocol.",
						`Recovery attempt ${attempt} of ${attempts}.`,
					].join("\n"),
					undefined,
					options.signal,
					requestAbort,
					"Required-tool recovery aborted",
				);
				throwIfAborted(options.signal, "Required-tool recovery aborted");
				throwIfVerifierFailed();
				throwIfObserverFailed();
				recovered = requiredToolComplete(options, toolExecutions);
				const serviceFailure = !recovered && lastAssistantServiceError(session.messages);
				emitLifecycle("required_tool_recovery_attempt_end", {
					requiredToolName,
					attempt,
					attempts,
					accepted: recovered,
					...(serviceFailure
						? { reason: "model_request_failed", stopReason: "error", error: serviceFailure.error }
						: {}),
				});
			} catch (error) {
				recoveryError = lifecycleError(error);
				emitLifecycle("required_tool_recovery_attempt_end", {
					requiredToolName,
					attempt,
					attempts,
					error: recoveryError,
				});
				throw error;
			}
			if (!recovered) {
				const serviceFailure = lastAssistantServiceError(session.messages);
				if (serviceFailure) return; // The existing owner loop routes service continuation.
			}
		}
	} finally {
		try {
			session.setActiveToolsByName(originalTools);
		} finally {
			emitLifecycle("required_tool_recovery_end", {
				requiredToolName,
				attempts,
				attemptsUsed,
				recovered,
				...(recoveryError ? { error: recoveryError } : {}),
			});
		}
	}
}

/** Run a candidate in an in-memory Pi session rooted at an isolated worktree. */
export async function runPiCodingTask(options: RunPiCodingTaskOptions): Promise<PiCodingTaskResult> {
	const owner = options.sessionOwner;
	if (owner?.inUse) throw new Error("Coding session already has an active task");
	if (owner) owner.inUse = true;
	let completed = false;
	let modelAdmissionFailure: unknown;
	const startedAt = Date.now();
	const emitLifecycle = (type: string, payload: Record<string, unknown> = {}): void => {
		try {
			options.onLifecycleEvent?.(type, {
				...modelErrorMetadata(payload.error),
				...payload,
				role: options.role ?? "executor",
				elapsedMs: Math.max(0, Date.now() - startedAt),
			});
		} catch {
			// Diagnostic observers must never change candidate execution semantics.
		}
	};
	emitLifecycle("coding_task_start", {
		provider: options.model?.provider,
		model: options.model?.id,
		contextWindow: options.model?.contextWindow,
		maxOutputTokens: options.maxOutputTokens ?? options.model?.maxTokens,
	});
	let session: AgentSession | undefined;
	let restoreHandoff: (() => void) | undefined;
	let restoreAdmission: (() => void) | undefined;
	let abortRequested = false;
	let acceptingEvents = true;
	let abortSettlement: Promise<void> | undefined;
	const abort = () => {
		if (abortRequested) return;
		abortRequested = true;
		emitLifecycle("signal_abort");
		const activeSession = session;
		abortSettlement = activeSession
			? Promise.resolve().then(async () => {
					try {
						await activeSession.abort(options.signal?.reason);
					} catch (error) {
						// A failed abort is not proof that tools stopped. Keep ownership
						// until Pi's idle barrier settles, then propagate the failure.
						await activeSession.waitForIdle();
						throw error;
					}
				})
			: undefined;
		if (abortSettlement) void abortSettlement.catch(() => undefined);
	};
	const checkAbort = (fallback: string): void => {
		if (!options.signal?.aborted) return;
		abort();
		throw abortError(options.signal, fallback);
	};
	const cwd = resolve(options.cwd);
	const toolExecutions: PiToolExecution[] = [];
	const toolInputs = new Map<string, unknown>();
	const toolStartedAt = new Map<string, number>();
	const captureTerminalResult = (execution: PiToolExecution): void => {
		if (options.signal?.aborted && options.executionIdentity) {
			const directory = join(options.config.stateDir, "planning", "inflight-settlements");
			mkdirSync(directory, { recursive: true });
			const scope = createHash("sha256").update(JSON.stringify(options.executionIdentity)).digest("hex");
			appendFileSync(
				join(directory, `${scope}.jsonl`),
				`${JSON.stringify({
					...options.executionIdentity,
					settledAt: Date.now(),
					afterTerminal: true,
					...execution,
				})}\n`,
				{ mode: 0o600 },
			);
			emitLifecycle("tool_settled_after_terminal", {
				...options.executionIdentity,
				toolCallId: execution.toolCallId,
				toolName: execution.toolName,
				isError: execution.isError,
			});
		}
	};
	let verifierInfrastructureFailure: VerifierInfrastructureError | undefined;
	let toolExecutionObserverFailure: unknown;
	// Retained Cairn sessions already persisted earlier Intent completions.
	const recordedBackground = new Set(options.backgroundTasks?.settledExecutions?.().map((item) => item.toolCallId));
	const captureBackground = (): void => {
		if (!acceptingEvents) return;
		for (const execution of options.backgroundTasks?.settledExecutions?.() ?? []) {
			if (recordedBackground.has(execution.toolCallId)) continue;
			try {
				if (!options.signal?.aborted) options.onToolExecution?.(execution);
				recordedBackground.add(execution.toolCallId);
				toolExecutions.push(execution);
				captureTerminalResult(execution);
			} catch (error) {
				if (options.propagateToolExecutionObserverErrors) {
					toolExecutionObserverFailure ??= error;
					abort();
				}
			}
		}
	};
	let unsubscribe = () => {};
	try {
		checkAbort("Candidate was aborted before it started");
		if (owner?.session) {
			session = owner.session;
		} else {
			const settingsManager = SettingsManager.create(cwd, options.config.agentDir);
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: options.config.agentDir,
				settingsManager,
				extensionFactories: options.extensionFactories ?? [],
				noExtensions: options.isolatedRoleResources === true,
				noSkills: options.isolatedRoleResources === true,
				noPromptTemplates: options.isolatedRoleResources === true,
				additionalSkillPaths: options.isolatedRoleResources ? [] : options.config.skillPaths,
				systemPrompt: options.isolatedRoleResources ? options.systemPrompt : options.config.systemPromptPath,
				appendSystemPrompt: options.systemPrompt && !options.isolatedRoleResources ? [options.systemPrompt] : [],
				skillsOverride: ({ skills, diagnostics }) => ({
					skills: skills.filter((skill) => isRegistryResourceEnabled(options.config, "skills", skill.name)),
					diagnostics,
				}),
			});
			emitLifecycle("resource_reload_start");
			try {
				await resourceLoader.reload();
				emitLifecycle("resource_reload_end");
			} catch (error) {
				emitLifecycle("resource_reload_end", { error: lifecycleError(error) });
				throw error;
			}
			checkAbort("Candidate was aborted while loading resources");

			emitLifecycle("session_create_start");
			let created: Awaited<ReturnType<typeof createAgentSession>>;
			try {
				created = await createAgentSession({
					cwd,
					agentDir: options.config.agentDir,
					settingsManager,
					resourceLoader,
					sessionManager: SessionManager.inMemory(cwd),
					model: options.model,
					modelRuntime: options.modelRuntime,
					thinkingLevel: options.thinkingLevel,
					excludeTools: [
						...new Set([...disabledRegistryNames(options.config, "tools"), ...(options.excludedTools ?? [])]),
					],
				});
			} catch (error) {
				emitLifecycle("session_create_end", { error: lifecycleError(error) });
				throw error;
			}
			session = created.session;
			const activeSession = session;
			options.onSteerReady?.((message) => activeSession.steer(message));
			emitLifecycle("session_create_end", { sessionId: activeSession.sessionId });
			checkAbort("Candidate was aborted while creating the session");

			emitLifecycle("extensions_bind_start");
			try {
				await activeSession.bindExtensions({ mode: "print" });
				emitLifecycle("extensions_bind_end");
			} catch (error) {
				emitLifecycle("extensions_bind_end", { error: lifecycleError(error) });
				throw error;
			}
			checkAbort("Candidate was aborted while binding extensions");
		}
		const activeSession = session;
		if (!activeSession) throw new Error("Coding session was not created");
		const serviceOptions = {
			...options,
			modelRuntime: options.modelRuntime ?? activeSession.modelRuntime,
			model: options.model ?? activeSession.model,
		};
		const streamFunction = activeSession.agent?.streamFunction;
		if (streamFunction) {
			activeSession.agent.streamFunction = async (model, context, streamOptions) => {
				const serviceFailure = lastAssistantServiceError(activeSession.messages);
				const key = `${model.provider}:${model.id}`;
				if (serviceFailure?.quotaExhausted)
					markModelQuotaUnavailable(serviceOptions.modelRuntime, key, serviceFailure.error);
				const quotaBlock = modelQuotaUnavailable(serviceOptions.modelRuntime, key);
				if (quotaBlock && !requiredToolComplete(options, toolExecutions))
					await waitForModelServiceBoundary(serviceOptions, quotaBlock);
				try {
					await options.beforeModelRequest?.(streamOptions?.signal ?? options.signal);
				} catch (error) {
					modelAdmissionFailure = error;
					throw error;
				}
				const requestedTools = options.requestToolNames?.();
				return streamFunction(
					model,
					requestedTools
						? { ...context, tools: context.tools?.filter((tool) => requestedTools.includes(tool.name)) }
						: context,
					{
						...streamOptions,
						...(options.maxOutputTokens === undefined ? {} : { maxTokens: options.maxOutputTokens }),
					},
				);
			};
			const admittedStream = activeSession.agent.streamFunction;
			restoreAdmission = () => {
				if (activeSession.agent.streamFunction === admittedStream)
					activeSession.agent.streamFunction = streamFunction;
			};
		}
		if (options.handoffOnRequiredTool && activeSession.agent) {
			const previous = activeSession.agent.shouldStopAfterTurn;
			activeSession.agent.shouldStopAfterTurn = async (context, signal) => {
				const inherited = (await previous?.(context, signal)) ?? false;
				if (
					!signal?.aborted &&
					!options.signal?.aborted &&
					options.requiredToolName &&
					requiredToolComplete(options, toolExecutions) &&
					!options.backgroundTasks?.hasPending()
				) {
					emitLifecycle("required_tool_handoff", { requiredToolName: options.requiredToolName });
					return true;
				}
				return inherited;
			};
			restoreHandoff = () => {
				activeSession.agent.shouldStopAfterTurn = previous;
			};
		}
		if (options.allowedTools) {
			const available = new Set(activeSession.getAllTools().map((tool) => tool.name));
			activeSession.setActiveToolsByName(options.allowedTools.filter((name) => available.has(name)));
		}
		unsubscribe = session.subscribe((event) => {
			if (!acceptingEvents || (options.signal?.aborted && event.type !== "tool_execution_end")) return;
			if (event.type === "auto_retry_start")
				emitLifecycle("auto_retry_start", {
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					error: event.errorMessage,
				});
			if (event.type === "auto_retry_end")
				emitLifecycle("auto_retry_end", {
					attempt: event.attempt,
					success: event.success,
					...(event.finalError ? { error: event.finalError } : {}),
				});
			if (
				event.type === "message_end" &&
				event.message.role === "custom" &&
				event.message.customType === "secheur-command-completion"
			)
				captureBackground();
			if (event.type === "turn_end" && event.message.role === "assistant" && modelAdmissionFailure === undefined) {
				options.onModelTurn?.(event.message.usage.cost.total, event.message);
				emitLifecycle("model_turn_completed", {
					cost: event.message.usage.cost.total,
					inputTokens: event.message.usage?.input,
					outputTokens: event.message.usage?.output,
					stopReason: event.message.stopReason,
					outputChars: (event.message.content ?? [])
						.filter((item) => item.type === "text")
						.map((item) => item.text)
						.join("").length,
					toolCalls: (event.message.content ?? [])
						.filter((item) => item.type === "toolCall")
						.map((item) => item.name),
				});
			}
			if (event.type === "tool_execution_start") {
				toolInputs.set(event.toolCallId, event.args);
				toolStartedAt.set(event.toolCallId, Date.now());
				// Forward only stable tool identity/timing metadata. Arguments and
				// results remain in the evidence path and never enter lifecycle events.
				emitLifecycle("tool_execution_start", {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
				});
			}
			if (event.type === "tool_execution_end") {
				const execution = {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					toolInput: toolInputs.get(event.toolCallId),
					result: event.result as unknown,
					isError: event.isError,
				};
				toolInputs.delete(event.toolCallId);
				toolExecutions.push(execution);
				captureTerminalResult(execution);
				if (options.signal?.aborted) return;
				if (options.role === "planner" || options.role === "observer")
					emitLifecycle("tool_execution_end", {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						isError: event.isError,
						toolElapsedMs: Math.max(0, Date.now() - (toolStartedAt.get(event.toolCallId) ?? Date.now())),
					});
				toolStartedAt.delete(event.toolCallId);
				verifierInfrastructureFailure ??= verifierInfrastructureFailureFromExecution(execution);
				try {
					options.onToolExecution?.(execution);
				} catch (error) {
					if (options.propagateToolExecutionObserverErrors) {
						toolExecutionObserverFailure ??= error;
						abort();
					} else {
						// Non-planning evidence observers must never break the Pi loop.
					}
				}
			}
			if (event.type === "message_start" && event.message.role === "assistant") {
				emitLifecycle("assistant_message_start");
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				emitLifecycle("assistant_message_end", {
					stopReason: event.message.stopReason,
					errorStage: event.message.stopReason === "error" ? "model_response" : undefined,
					outputChars: (event.message.content ?? [])
						.filter((item) => item.type === "text")
						.map((item) => item.text)
						.join("").length,
					inputTokens: event.message.usage?.input,
					outputTokens: event.message.usage?.output,
					...(event.message.errorMessage ? { error: event.message.errorMessage.slice(0, 1024) } : {}),
				});
				options.onUpdate?.(activeSession.messages);
			}
		});
		checkAbort("Candidate was aborted before prompting");
		options.signal?.addEventListener("abort", abort, { once: true });
		checkAbort("Candidate was aborted before prompting");
		// Reject outer-budget/verification admission before Pi synthesizes an
		// assistant error turn. A rejected request is not a consumed model call.
		await options.beforeModelRequest?.(options.signal);
		emitLifecycle("prompt_start");
		try {
			await promptWithAbortSettlement(
				activeSession,
				`Task:\n${options.task}`,
				options.images ? { images: options.images } : undefined,
				options.signal,
				abort,
				"Candidate prompt aborted",
			);
			// Pi owns any completion-triggered follow-up turns. Keep this attempt
			// alive while owned background jobs settle; no model polling or hard timeout.
			if (options.backgroundTasks) {
				do {
					await options.backgroundTasks.waitForSettlement(options.signal);
					captureBackground();
					await activeSession.waitForIdle();
					checkAbort("Candidate background work aborted");
				} while (options.backgroundTasks.hasPending());
			}
			captureBackground();
			if (modelAdmissionFailure !== undefined) throw modelAdmissionFailure;
			if (verifierInfrastructureFailure) throw verifierInfrastructureFailure;
			emitLifecycle("prompt_end");
		} catch (error) {
			const terminalError = verifierInfrastructureFailure ?? toolExecutionObserverFailure ?? error;
			emitLifecycle("prompt_end", { error: lifecycleError(terminalError) });
			throw terminalError;
		}
		throwIfAborted(options.signal, "Candidate was aborted after prompting");
		if (toolExecutionObserverFailure) throw toolExecutionObserverFailure;
		let serviceResumed = false;
		do {
			serviceResumed = false;
			const serviceFailure =
				!requiredToolComplete(options, toolExecutions) && lastAssistantServiceError(activeSession.messages);
			if (serviceFailure && options.requiredToolName) {
				const metadata = modelErrorMetadata(serviceFailure.error);
				if (!serviceFailure.retryable && metadata.errorCategory === "invalid_request") {
					emitLifecycle("model_request_rejected", { ...metadata, reason: "invalid_request" });
					throw new PlanningFailureError({
						source: "planning",
						stage: options.role === "planner" ? "supervisor" : "executor",
						code: "model_invalid_request",
						message: `Model provider rejected request parameters (HTTP ${metadata.providerStatus})`,
					});
				}
				const retry = activeSession.settingsManager.getRetrySettings();
				if (!options.signal || serviceFailure.quotaExhausted || !serviceFailure.retryable || !retry.enabled)
					await waitForModelServiceBoundary(serviceOptions, serviceFailure);
				// Continue the already-owned task, using Pi's configured final backoff.
				// This is the existing managed continuation loop, not protocol repair.
				const delayMs = retry.baseDelayMs * 2 ** Math.max(0, retry.maxRetries - 1);
				emitLifecycle("model_service_resume", { reason: "model_request_failed", delayMs, protocolRecovery: false });
				try {
					await serviceDelay(delayMs, undefined, { signal: options.signal });
				} catch (error) {
					throwIfAborted(options.signal, "Model service continuation aborted");
					throw error;
				}
				if (!requiredToolComplete(options, toolExecutions)) {
					serviceResumed = true;
					await promptWithAbortSettlement(
						activeSession,
						"Continue the current owned task from its saved observations. The previous model request failed; retain existing work and uncertainty. Do not restart the task or invent a result.",
						undefined,
						options.signal,
						abort,
						"Model service continuation aborted",
					);
				}
			} else {
				await recoverRequiredTool(
					activeSession,
					toolExecutions,
					options,
					abort,
					() => verifierInfrastructureFailure,
					() => toolExecutionObserverFailure ?? modelAdmissionFailure,
				);
			}
			if (modelAdmissionFailure !== undefined) throw modelAdmissionFailure;
			if (verifierInfrastructureFailure) throw verifierInfrastructureFailure;
			if (toolExecutionObserverFailure) throw toolExecutionObserverFailure;
			// Required-result recovery can itself start an owned background command.
			if (options.backgroundTasks) {
				do {
					await options.backgroundTasks.waitForSettlement(options.signal);
					captureBackground();
					await activeSession.waitForIdle();
					checkAbort("Candidate recovery background work aborted");
				} while (options.backgroundTasks.hasPending());
			}
			if (options.continueUntilRequiredTool && !requiredToolComplete(options, toolExecutions)) {
				// Yield even for immediately resolved provider adapters so outer
				// cancellation and completion events cannot be starved by retries.
				try {
					await yieldToEventLoop(undefined, { signal: options.signal });
				} catch (error) {
					throwIfAborted(options.signal, "Managed work continuation aborted");
					throw error;
				}
			}
		} while (
			(options.continueUntilRequiredTool ||
				serviceResumed ||
				lastAssistantServiceError(activeSession.messages) !== undefined) &&
			options.requiredToolName &&
			!requiredToolComplete(options, toolExecutions)
		);
		if (toolExecutionObserverFailure) throw toolExecutionObserverFailure;
		throwIfAborted(options.signal, "Candidate was aborted after required-tool recovery");
		completed = true;
		if (owner) owner.session = activeSession;
		return {
			messages: [...activeSession.messages],
			finalText: finalAssistantText(activeSession.messages),
			toolExecutions,
		};
	} catch (error) {
		emitLifecycle("coding_task_error", { error: lifecycleError(error) });
		throw error;
	} finally {
		restoreHandoff?.();
		if (owner && !completed) owner.session = undefined;
		options.signal?.removeEventListener("abort", abort);
		const finishEvents = () => {
			captureBackground();
			acceptingEvents = false;
			unsubscribe();
			restoreAdmission?.();
		};
		let settled = true;
		if (abortSettlement) {
			// Cleanup grace is not extra model execution time. A tool that ignores
			// cancellation must not hang the caller or have its slot reused.
			let timer: ReturnType<typeof setTimeout> | undefined;
			settled = await Promise.race([
				abortSettlement.then(
					() => true,
					() => false,
				),
				new Promise<boolean>((resolve) => {
					timer = setTimeout(() => resolve(false), 5_000);
				}),
			]);
			if (timer) clearTimeout(timer);
			if (!settled) {
				const activeSession = session;
				const pending = abortSettlement.finally(() => {
					finishEvents();
					activeSession?.dispose();
				});
				void pending.catch(() => undefined);
				options.onPendingSettlement?.(pending);
			}
		}
		try {
			if (settled) finishEvents();
			if (settled && !(owner && completed)) session?.dispose();
		} finally {
			if (owner) owner.inUse = false;
			emitLifecycle("coding_task_end", { settled });
		}
	}
}

export async function runPiSubAgent(
	options: RunPiSubAgentOptions,
	ctx: ExtensionContext,
	signal?: AbortSignal,
	onUpdate?: (result: AgentToolResult<PiSubAgentDetails>) => void,
): Promise<AgentToolResult<PiSubAgentDetails>> {
	if (signal?.aborted) throw new Error("Sub-agent aborted");
	const agent = discoverPiSubAgents(options.config).find((candidate) => candidate.name === options.agentType);
	if (!agent) {
		const available = discoverPiSubAgents(options.config)
			.map((candidate) => candidate.name)
			.join(", ");
		throw new Error(`Unknown sub-agent: ${options.agentType}. Available agents: ${available || "none"}`);
	}

	const cwd = resolve(options.cwd ?? ctx.cwd);
	const permissionMode = childPermissionMode(options.permissionMode);
	const child = options.createChildExtension(permissionMode);
	let session: AgentSession | undefined;
	let unsubscribe = () => {};
	let abort: (() => void) | undefined;
	try {
		const settingsManager = SettingsManager.create(cwd, options.config.agentDir);
		const instructions = agent.systemPrompt.replace(/\$TASK|\$\{TASK\}/g, options.task);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: options.config.agentDir,
			settingsManager,
			extensionFactories: [child.extension],
			additionalSkillPaths: options.config.skillPaths,
			systemPrompt: options.config.systemPromptPath,
			appendSystemPrompt: [
				`# SecHeur Sub-Agent: ${agent.name}`,
				agent.description,
				instructions,
				"Work only on the delegated task and return a concise evidence-backed result.",
			],
			skillsOverride: ({ skills, diagnostics }) => ({
				skills: skills.filter((skill) => isRegistryResourceEnabled(options.config, "skills", skill.name)),
				diagnostics,
			}),
		});
		await resourceLoader.reload();
		const created = await createAgentSession({
			cwd,
			agentDir: options.config.agentDir,
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			model: ctx.model,
			thinkingLevel: ctx.thinkingLevel,
			excludeTools: disabledRegistryNames(options.config, "tools"),
		});
		session = created.session;
		await session.bindExtensions({ mode: "print" });
		const allowedTools = activeToolNames(agent.allowedTools);
		if (allowedTools) session.setActiveToolsByName(allowedTools);

		const activeSession = session;
		const details = (status: PiSubAgentDetails["status"]): PiSubAgentDetails => ({
			agent: agent.name,
			source: agent.source,
			status,
			sessionId: activeSession.sessionId,
			allowedTools: allowedTools ?? activeSession.getActiveToolNames(),
			messageCount: activeSession.messages.length,
		});
		unsubscribe = activeSession.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			onUpdate?.({
				content: [{ type: "text", text: finalAssistantText(activeSession.messages) || "(running...)" }],
				details: details("running"),
			});
		});
		abort = () => void activeSession.abort();
		if (signal?.aborted) {
			abort();
			throw new Error("Sub-agent aborted");
		}
		signal?.addEventListener("abort", abort, { once: true });

		await activeSession.prompt(`Task:\n${options.task}`);
		return {
			content: [{ type: "text", text: finalAssistantText(activeSession.messages) || "Sub-agent returned no text." }],
			details: details("success"),
		};
	} finally {
		if (abort) signal?.removeEventListener("abort", abort);
		unsubscribe();
		session?.dispose();
		child.close();
	}
}
