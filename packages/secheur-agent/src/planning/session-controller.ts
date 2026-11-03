import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { AgentSession, InlineExtension, PromptOptions } from "@earendil-works/pi-coding-agent";
import type { SecHeurConfig } from "../config.ts";
import type { ExecutionModeSpec } from "../execution-mode.ts";
import { ArtexPlanningSupervisor, artexExecutorExtension } from "./artex-adapters.ts";
import { CairnPlanningEngine, cairnRunDirectory } from "./cairn/engine.ts";
import { CairnHostEvidence } from "./cairn/host-evidence.ts";
import type {
	PlanningEvidence,
	PlanningSnapshot,
	TrustedPlanningVerification,
	TrustedPlanningVerificationContext,
} from "./contracts.ts";
import {
	ProgressivePlanningController,
	type ProgressivePlanningControllerOptions,
	type ProgressivePlanningRequest,
	type ProgressivePlanningResult,
	planningRunIdForExecution,
} from "./controller.ts";
import { readCompleteEvidenceBlob } from "./evidence-store.ts";
import { PlanningCapacityControl } from "./execution-pool.ts";
import { ensurePlanningFailure, planningFailure } from "./failures.ts";
import { HypothesisPlanningSupervisor, hypothesisExecutorExtension } from "./hypothesis-adapters.ts";
import { createPlanRunObserver } from "./observer-model.ts";
import {
	type PiPlanningAdapterOptions,
	PiPlanningExecutor,
	type PiPlanningExtensionBundle,
	PiPlanningSupervisor,
} from "./pi-adapters.ts";
import type { PlanRunObserver } from "./run-observer.ts";
import { PlanningSourceBindings } from "./source-bindings.ts";
import { PlanningStore } from "./store.ts";
import { trustedPlanningVerificationFromSnapshot } from "./terminal-verification.ts";

export interface ProgressivePlanningControllerLike {
	execute(request: ProgressivePlanningRequest): Promise<ProgressivePlanningResult>;
}

export type ProgressivePlanningControllerFactory = (
	options: ProgressivePlanningControllerOptions,
) => ProgressivePlanningControllerLike;
export interface ProgressivePlanningPromptOptions {
	beforeDispatch?: PiPlanningAdapterOptions["beforeDispatch"];
	config: SecHeurConfig;
	cwd: string;
	outerTaskId?: string;
	createExtensionBundle?: PiPlanningAdapterOptions["createExtensionBundle"];
	controllerFactory?: ProgressivePlanningControllerFactory;
	onExecutionModeSelected?: (mode: ExecutionModeSpec) => void;
	onTrustedPlanningVerification?: (
		verification: TrustedPlanningVerification,
		context: TrustedPlanningVerificationContext,
	) => boolean | undefined;
	getBridgeRunGeneration?: () => number | undefined;
	onPresentationEvidence?: (snapshot: PlanningSnapshot) => void;
	onModelTurn?: (cost: number) => { stopped: boolean; message?: string; reason?: string };
}

export interface ProgressivePlanningPromptBinding {
	readonly mode: SecHeurConfig["planning"]["mode"];
	readonly executionMode: ExecutionModeSpec;
	setExecutionCapacity(capacity: number): number;
	abort(reason?: unknown): void;
	close(): void;
}

interface InstalledBinding {
	binding: ProgressivePlanningPromptBinding;
}

const INSTALLED = new WeakMap<AgentSession, InstalledBinding>();

function promptOuterTaskId(session: AgentSession, configured: string | undefined, goal: string): string {
	const prefix = configured?.trim() || `session:${session.sessionId}`;
	const goalHash = createHash("sha256").update(goal).digest("hex").slice(0, 24);
	return `${prefix}:goal:${goalHash}`;
}

function candidateHash(evidence: PlanningEvidence): string | undefined {
	return typeof evidence.metadata.candidateHash === "string" ? evidence.metadata.candidateHash : undefined;
}

function selectPresentationEvidence(snapshot: PlanningSnapshot | undefined): {
	evidence: PlanningEvidence[];
	flagCandidateCount: number;
	filteredIncorrectCandidateCount: number;
} {
	const evidence = snapshot?.evidence ?? [];
	const rejectedHashes = new Set(
		evidence
			.filter(
				(item) =>
					(item.toolName === "verify_flag" || item.toolName === "check_flag") &&
					(item.metadata.verificationOutcome === "incorrect" ||
						item.metadata.verifierStatus === "incorrect" ||
						item.metadata.verifierStatus === "duplicate"),
			)
			.flatMap((item) => {
				const hash = candidateHash(item);
				return hash ? [hash] : [];
			}),
	);
	let filteredIncorrectCandidateCount = 0;
	const filtered = evidence.filter((item) => {
		if (item.source !== "planning-flag-candidate") return true;
		const hash = candidateHash(item);
		if (!hash || !rejectedHashes.has(hash)) return true;
		filteredIncorrectCandidateCount += 1;
		return false;
	});
	return {
		evidence: filtered,
		flagCandidateCount: filtered.filter((item) => item.source === "planning-flag-candidate").length,
		filteredIncorrectCandidateCount,
	};
}

const PRESENTATION_EVIDENCE_LIMIT_BYTES = 80_000;

function boundedPresentationEvidence(evidence: PlanningEvidence[]): PlanningEvidence[] {
	const prioritized = [
		...evidence.filter((item) => item.source === "planning-flag-candidate"),
		...evidence.filter((item) => item.source !== "planning-flag-candidate"),
	];
	const selected: PlanningEvidence[] = [];
	let bytes = Buffer.byteLength("[]", "utf8");
	for (const item of prioritized) {
		const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + (selected.length ? 1 : 0);
		if (bytes + itemBytes > PRESENTATION_EVIDENCE_LIMIT_BYTES) continue;
		selected.push(item);
		bytes += itemBytes;
	}
	return selected;
}

function presentationPrompt(
	goal: string,
	result: ProgressivePlanningResult,
	visibleEvidence: PlanningEvidence[],
	flagCandidateCount: number,
): string {
	const snapshot = result.snapshot;
	const verificationInstructions = result.trustedVerification
		? [
				"The Planning run already has a persisted, trusted native verifier result accepted as correct.",
				"Do not call a verifier again or invent another candidate.",
				"Summarize the persisted result and task history without exposing any candidate value.",
			].join("\n")
		: flagCandidateCount > 0
			? [
					"Persisted evidence contains one or more flag candidates.",
					"Use the available native verifier after grounding the persisted candidate.",
					"Verify persisted candidates before claiming success.",
					"If verification needs fresh evidence, use the available investigation tools to obtain it; a local gate is not a rejection.",
					"Do not invent a new candidate.",
					"Treat a flag as solved only after verifier acceptance.",
				].join("\n")
			: [
					"No persisted flag candidate is available for verification.",
					"Do not invent or submit a flag.",
					"Do not claim verified success.",
					"Summarize the persisted Planning result only.",
					"Do not restart investigation or run tools.",
				].join("\n");
	return [
		"# Progressive Planning Controller completion",
		"The outer controller, not this parent session, executed the task through isolated leased Pi sessions.",
		"Produce the final user-facing answer from the persisted task summaries and evidence below.",
		verificationInstructions,
		"Do not expose internal JSON schemas.",
		`Original goal:\n${goal}`,
		`Controller mode: ${result.mode}`,
		`Run status: ${snapshot?.run.status ?? "unknown"}`,
		`Run error: ${snapshot?.run.lastError ?? "none"}`,
		`Completed task summaries:\n${JSON.stringify(
			snapshot?.tasks.map((task) => ({
				objective: task.objective,
				status: task.status,
				lastError: task.lastError ?? null,
			})) ?? [],
			null,
			2,
		)}`,
		`Persisted evidence (complete JSON records; ${visibleEvidence.length} shown):\n${JSON.stringify(visibleEvidence)}`,
	].join("\n\n");
}

type PlanningPresentationLifecycleEvent = (type: string, payload: Record<string, unknown>) => void;

function isVerificationToolName(name: string): boolean {
	return name === "verify_flag" || name === "check_flag";
}

function abortError(signal?: AbortSignal): Error {
	const reason = signal?.reason;
	if (reason instanceof Error) return reason;
	const error = new Error(typeof reason === "string" && reason.trim() ? reason : "Planning operation aborted");
	error.name = "AbortError";
	return error;
}

function planningBudgetFailure(budget: { message?: string; reason?: string }): Error {
	return budget.reason === "verifier_quota_exhausted"
		? planningFailure("controller", "verifier_quota_exhausted", budget.message ?? "Verification quota exhausted")
		: new Error(budget.message ?? "Outer planning budget exhausted");
}

async function presentPlanningResult(
	session: AgentSession,
	goal: string,
	result: ProgressivePlanningResult,
	signal?: AbortSignal,
	recordLifecycleEvent?: PlanningPresentationLifecycleEvent,
	onPresentationEvidence?: (snapshot: PlanningSnapshot) => void,
): Promise<void> {
	if (signal?.aborted) throw abortError(signal);
	const startedAt = Date.now();
	const runId = result.runId ?? result.snapshot?.run.runId;
	const runStatus = result.snapshot?.run.status ?? "unknown";
	if (result.snapshot) onPresentationEvidence?.(result.snapshot);
	const candidateState = selectPresentationEvidence(result.snapshot);
	const presentedEvidence = boundedPresentationEvidence(candidateState.evidence);
	const flagCandidateCount = presentedEvidence.filter((item) => item.source === "planning-flag-candidate").length;
	const allToolNames = session.getAllTools().map((tool) => tool.name);
	const activeTools = session.getActiveToolNames();
	const presentationTools = !result.trustedVerification && flagCandidateCount > 0 ? activeTools : [];
	const emitLifecycle = (type: string, payload: Record<string, unknown> = {}): void => {
		if (!runId) return;
		try {
			recordLifecycleEvent?.(type, {
				runId,
				runStatus,
				flagCandidateCount,
				filteredIncorrectCandidateCount: candidateState.filteredIncorrectCandidateCount,
				activeToolNames: session.getActiveToolNames(),
				verifyFlagAvailable: session.getActiveToolNames().some(isVerificationToolName),
				verifyFlagInInventory: allToolNames.some(isVerificationToolName),
				elapsedMs: Math.max(0, Date.now() - startedAt),
				...payload,
			});
		} catch {
			// Diagnostic observers must never change presentation semantics.
		}
	};
	emitLifecycle("planning_presentation_start");
	emitLifecycle("verification_candidate_available");
	emitLifecycle("verification_tool_available");
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_start" && isVerificationToolName(event.toolName)) {
			emitLifecycle("verification_attempted", { toolName: event.toolName });
		}
	});
	try {
		if (signal?.aborted) throw abortError(signal);
		session.setActiveToolsByName(presentationTools);
		emitLifecycle("planning_presentation_tools");
		if (signal?.aborted) throw abortError(signal);
		const presentationTurn = session.sendCustomMessage(
			{
				customType: result.snapshot?.artexGraph
					? "artex-planning-result"
					: result.snapshot?.hypothesisGraph
						? "hypothesis-planning-result"
						: "progressive-planning-result",
				content: presentationPrompt(goal, result, presentedEvidence, flagCandidateCount),
				display: false,
				details: { mode: result.mode, runId: result.runId, status: result.snapshot?.run.status },
			},
			{ triggerTurn: true },
		);
		emitLifecycle("planning_presentation_triggered");
		await presentationTurn;
		if (signal?.aborted) throw abortError(signal);
	} finally {
		unsubscribe();
		session.setActiveToolsByName(activeTools);
		emitLifecycle("planning_presentation_end");
	}
}

function shouldBypassPlanning(message: string): boolean {
	const normalized = message.trim();
	return !normalized || normalized.startsWith("/");
}

export function attachProgressivePlanningController(
	session: AgentSession,
	options: ProgressivePlanningPromptOptions,
): ProgressivePlanningPromptBinding {
	const installed = INSTALLED.get(session);
	if (installed) return installed.binding;

	const rawPrompt = session.prompt.bind(session);
	let closed = false;
	let tail: Promise<void> = Promise.resolve();
	let currentOperationController: AbortController | undefined;
	const operationControllers = new Set<AbortController>();
	const executionMode = options.config.executionMode;
	const planningEngine = options.config.planning.engine ?? "progressive";
	const capacityControl = new PlanningCapacityControl(executionMode.capacity);
	const notifyExecutionModeSelected = (): void => {
		try {
			options.onExecutionModeSelected?.(executionMode);
		} catch {
			// Mode diagnostics must never change execution semantics.
		}
	};
	const routedPrompt = async (message: string, promptOptions?: PromptOptions): Promise<void> => {
		const operationController = new AbortController();
		const bridgeRunGeneration = options.getBridgeRunGeneration?.();
		operationControllers.add(operationController);
		const operation = tail.then(async () => {
			currentOperationController = operationController;
			try {
				if (closed) return;
				if (shouldBypassPlanning(message)) {
					await rawPrompt(message, promptOptions);
					return;
				}
				notifyExecutionModeSelected();
				if (executionMode.mode === "direct") {
					await rawPrompt(message, promptOptions);
					return;
				}

				const cwd = resolve(options.cwd);
				// Historical shadow remains the original non-executing Planning preview.
				if (planningEngine === "cairn" && executionMode.legacyPlanningMode === "active") {
					let cairnRunId: string | undefined;
					let cairnEvidence: CairnHostEvidence | undefined;
					const controller = new CairnPlanningEngine({
						beforeDispatch: options.beforeDispatch,
						requireTrustedCompletion: options.onTrustedPlanningVerification !== undefined,
						onModelTurn: (cost) => {
							const budget = options.onModelTurn?.(cost);
							if (budget?.stopped && !(cairnRunId && cairnEvidence?.proof(cairnRunId)))
								operationController.abort(planningBudgetFailure(budget));
						},
						config: options.config,
						cwd,
						model: session.model,
						modelRuntime: session.modelRuntime,
						thinkingLevel: session.thinkingLevel,
						images: promptOptions?.images,
						createExtensionBundle: options.createExtensionBundle,
						capacityControl,
						onRunStarted: async (runId) => {
							cairnRunId = runId;
							cairnEvidence = new CairnHostEvidence(
								join(cairnRunDirectory(options.config.stateDir, runId), "host.sqlite"),
							);
							await session.sendCustomMessage(
								{
									customType: "cairn-planning-goal",
									content: message,
									display: false,
									details: { runId, engine: "cairn" },
								},
								{ triggerTurn: false },
							);
						},
					});
					try {
						const result = await controller.execute({
							outerTaskId: promptOuterTaskId(session, options.outerTaskId, message),
							goal: message,
							signal: operationController.signal,
						});
						if (operationController.signal.aborted) throw abortError(operationController.signal);
						const acceptedByHost = result.trustedVerification
							? options.onTrustedPlanningVerification?.(result.trustedVerification, {
									signal: operationController.signal,
									bridgeRunGeneration,
								})
							: undefined;
						if (acceptedByHost) {
							try {
								await session.sendCustomMessage(
									{
										customType: "cairn-planning-result",
										content: "Trusted verification accepted.",
										display: true,
										details: {
											runId: result.runId,
											engine: "cairn",
											status: result.status,
											acceptedByHost: true,
										},
									},
									{ triggerTurn: false },
								);
							} catch {
								/* Persisted proof remains authoritative if notification fails. */
							}
							return;
						}
						await session.sendCustomMessage(
							{
								customType: "cairn-planning-result",
								content: JSON.stringify({
									status: result.status,
									graph: result.graph,
									acceptedByHost,
									lastReasonFailure: result.lastReasonFailure,
								}),
								display: true,
								details: { runId: result.runId, engine: "cairn", status: result.status },
							},
							{ triggerTurn: false },
						);
						if (operationController.signal.aborted) throw abortError(operationController.signal);
						return;
					} catch (error) {
						if (operationController.signal.aborted) throw error;
						const failure = ensurePlanningFailure(error, {
							stage: "controller",
							code: "planning_internal_error",
							runId: cairnRunId,
						});
						try {
							await session.sendCustomMessage(
								{
									customType: "cairn-planning-failure",
									content: failure.message,
									display: false,
									details: {
										runId: cairnRunId,
										engine: "cairn",
										failureSource: failure.source,
										failureStage: failure.stage,
										failureCode: failure.code,
									},
								},
								{ triggerTurn: false },
							);
						} catch {
							/* Keep the original failure. */
						}
						throw failure;
					} finally {
						cairnEvidence?.close();
					}
				}
				const store = await PlanningStore.open(join(options.config.stateDir, "planning.sqlite"));
				const rawOuterTaskId = promptOuterTaskId(session, options.outerTaskId, message);
				const outerTaskId = ["hypothesis", "artex"].includes(planningEngine)
					? `${planningEngine}:${rawOuterTaskId}`
					: rawOuterTaskId;
				const runId = planningRunIdForExecution(executionMode, outerTaskId, message);
				if (!runId) throw new Error("Planning run id is unavailable for the selected execution mode");
				let runObserver: PlanRunObserver | undefined;
				const sourceBindings = new PlanningSourceBindings(options.config.stateDir, runId, (evidenceId) => {
					const record = store
						.snapshot(runId, true)
						.evidence.find(
							(item) => item.evidenceId === evidenceId && item.runId === runId && item.kind === "tool",
						);
					if (!record?.contentRef || !record.contentComplete)
						throw new Error("Original complete tool observation not found in this run");
					const value = readCompleteEvidenceBlob({
						stateDir: options.config.stateDir,
						contentRef: record.contentRef,
						contentHash: record.contentHash,
						runId,
						evidenceId,
					});
					return {
						runId,
						evidenceId,
						value,
						sourceHash: record.contentHash,
						outcome: value.isError === true ? "tool_error" : "observation",
					};
				});
				try {
					const recordPlanningLifecycleEvent = (type: string, payload: Record<string, unknown>): void => {
						const runId = typeof payload.runId === "string" ? payload.runId : undefined;
						if (!runId) return;
						store.recordLifecycleEvent(runId, type, payload);
					};
					const adapterBase = {
						sourceBindings,
						beforeDispatch: options.beforeDispatch,
						onModelTurn: (cost: number) => {
							const budget = options.onModelTurn?.(cost);
							if (budget?.stopped && !trustedPlanningVerificationFromSnapshot(store.snapshot(runId, true)))
								operationController.abort(planningBudgetFailure(budget));
						},
						config: options.config,
						cwd,
						model: session.model,
						modelRuntime: session.modelRuntime,
						thinkingLevel: session.thinkingLevel,
						taskTimeoutMs: options.onTrustedPlanningVerification
							? undefined
							: options.config.planning.taskTimeoutMs,
					};
					if (options.config.planning.observerMode !== "off") {
						runObserver = createPlanRunObserver(
							{ ...adapterBase, onLifecycleEvent: recordPlanningLifecycleEvent },
							{
								runId,
								mode: options.config.planning.observerMode,
								signal: operationController.signal,
								beforeDispatch: options.beforeDispatch,
								readEvidence: (id, offset, limit) => store.readEvidence(runId, id, { offset, maxBytes: limit }),
								onEvent: recordPlanningLifecycleEvent,
								snapshot: () => {
									const snapshot = store.snapshot(runId, true);
									const context = {
										run: snapshot.run,
										tasks: snapshot.tasks,
										evidence: snapshot.evidence,
										executionFrame: snapshot.executionFrame,
										sourceBindings: sourceBindings.list(),
									};
									return {
										runId,
										version: Number.parseInt(
											createHash("sha256").update(JSON.stringify(context)).digest("hex").slice(0, 13),
											16,
										),
										evidenceIds: snapshot.evidence.map((item) => item.evidenceId),
										context,
									};
								},
							},
						);
					}
					const controller = (
						options.controllerFactory ??
						((controllerOptions) => new ProgressivePlanningController(controllerOptions))
					)({
						executionMode,
						capacityControl,
						store,
						supervisor: new (planningEngine === "artex"
							? ArtexPlanningSupervisor
							: planningEngine === "hypothesis"
								? HypothesisPlanningSupervisor
								: PiPlanningSupervisor)({
							...adapterBase,
							runObserver,
							onLifecycleEvent: recordPlanningLifecycleEvent,
						}),
						executor: new PiPlanningExecutor({
							...adapterBase,
							runObserver,
							images: promptOptions?.images,
							createExtensionBundle:
								planningEngine === "hypothesis" || planningEngine === "artex"
									? (scope) => {
											const bundle = options.createExtensionBundle?.(scope);
											return {
												extensionFactories: [
													...(bundle?.extensionFactories ?? []),
													...(scope
														? [
																planningEngine === "artex"
																	? artexExecutorExtension(
																			store,
																			scope,
																			options.config.planning.maxEvidenceBytes,
																		)
																	: hypothesisExecutorExtension(
																			store,
																			scope,
																			options.config.planning.evidenceCatalogEnabled,
																		),
															]
														: []),
												],
												close: () => bundle?.close(),
												backgroundTasks: bundle?.backgroundTasks,
											};
										}
									: options.createExtensionBundle,
							onLifecycleEvent: recordPlanningLifecycleEvent,
						}),
						requireTrustedCompletion: options.onTrustedPlanningVerification !== undefined,
						recoverPlanningFailures: true,
						maximumSteps: options.config.planning.maxSteps,
						maximumTasks: options.config.planning.maxTasks,
						leaseTtlMs: options.config.planning.leaseTtlMs,
						maximumEvidenceBytes: options.config.planning.maxEvidenceBytes,
						maximumExecutorContextBytes: options.config.planning.executorContextBytes,
						allowedScope: cwd,
					});
					if (executionMode.legacyPlanningMode === "active") {
						if (operationController.signal.aborted) throw abortError(operationController.signal);
						await session.sendCustomMessage({
							customType: `${planningEngine}-planning-goal`,
							content: message,
							display: false,
							details: { mode: "active", runId },
						});
						if (operationController.signal.aborted) throw abortError(operationController.signal);
					}
					const result = await controller.execute({
						outerTaskId,
						goal: message,
						executeDirect: () => rawPrompt(message, promptOptions),
						signal: operationController.signal,
					});
					let presentationResult = result;
					let trustedVerificationAcceptedByHost = false;
					if (result.trustedVerification) {
						if (operationController.signal.aborted) throw abortError(operationController.signal);
						const acceptedByHost = options.onTrustedPlanningVerification?.(result.trustedVerification, {
							signal: operationController.signal,
							bridgeRunGeneration,
						});
						trustedVerificationAcceptedByHost = acceptedByHost === true;
						if (acceptedByHost === false) {
							presentationResult = { ...result };
							delete presentationResult.trustedVerification;
						}
					}
					if (trustedVerificationAcceptedByHost) {
						recordPlanningLifecycleEvent("planning_verified_completion", { runId, acceptedByHost: true });
						try {
							if (!operationController.signal.aborted)
								await session.sendCustomMessage(
									{
										customType: `${planningEngine}-planning-result`,
										content: "Verified completion accepted.",
										display: false,
										details: { runId, status: "completed", acceptedByHost: true },
									},
									{ triggerTurn: false },
								);
						} catch {
							/* Notification cannot revoke accepted completion. */
						}
					}
					if (result.executionMode !== "direct" && !result.direct && !trustedVerificationAcceptedByHost) {
						if (operationController.signal.aborted) throw abortError(operationController.signal);
						await presentPlanningResult(
							session,
							message,
							presentationResult,
							operationController.signal,
							recordPlanningLifecycleEvent,
							options.onPresentationEvidence,
						);
					}
				} catch (error) {
					if (operationController.signal.aborted) throw error;
					const failure = ensurePlanningFailure(error, {
						stage: "controller",
						code: "planning_internal_error",
						runId,
					});
					try {
						await session.sendCustomMessage(
							{
								customType: `${planningEngine}-planning-failure`,
								content: failure.message,
								display: false,
								details: {
									runId: failure.runId ?? runId,
									failureSource: failure.source,
									failureStage: failure.stage,
									failureCode: failure.code,
								},
							},
							{ triggerTurn: false },
						);
					} catch {
						// Do not replace the original typed failure if parent notification fails.
					}
					throw failure;
				} finally {
					runObserver?.close();
					store.close();
				}
			} finally {
				if (currentOperationController === operationController) currentOperationController = undefined;
				operationControllers.delete(operationController);
			}
		});
		tail = operation.catch(() => undefined);
		await operation;
	};
	const originalPrompt = session.prompt;
	session.prompt = routedPrompt;
	const binding: ProgressivePlanningPromptBinding = {
		mode: options.config.planning.mode,
		executionMode,
		setExecutionCapacity(capacity) {
			if (executionMode.mode !== "plan_multi") throw new Error("Live capacity changes require PLAN_MULTI");
			capacityControl.setCapacity(capacity);
			executionMode.capacity = capacityControl.getCapacity();
			notifyExecutionModeSelected();
			return executionMode.capacity;
		},
		abort(reason) {
			currentOperationController?.abort(reason);
		},
		close() {
			if (closed) return;
			currentOperationController?.abort(new Error("Progressive planning binding closed"));
			for (const controller of operationControllers)
				controller.abort(new Error("Progressive planning binding closed"));
			closed = true;
			if (session.prompt === routedPrompt) session.prompt = originalPrompt;
			INSTALLED.delete(session);
		},
	};
	INSTALLED.set(session, { binding });
	return binding;
}

export function planningExecutorExtensionBundle(
	extension: InlineExtension,
	close: () => void,
	additionalExtensions: InlineExtension[] = [],
): PiPlanningExtensionBundle {
	return { extensionFactories: [extension, ...additionalExtensions], close };
}
