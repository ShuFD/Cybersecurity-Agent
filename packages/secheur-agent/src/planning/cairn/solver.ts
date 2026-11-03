import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolResult, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PiCodingSessionOwner, runPiCodingTask, throwIfAborted } from "../../subagent.ts";
import { evidenceCardExtension } from "../evidence-tools.ts";
import { PlanningExecutorPool } from "../execution-pool.ts";
import { PlanningFailureError, PlanningPersistenceError } from "../failures.ts";
import { cairnHandoff, renderPlanningHandoff } from "../handoff-contract.ts";
import type { PiPlanningAdapterOptions, PiPlanningExtensionBundle } from "../pi-adapters.ts";
import { isVerifierInfrastructureFailure, verifierPlanningFailure } from "../pi-adapters.ts";
import { PlanningProgressFeedback } from "../progress-feedback.ts";
import { renderSharedTaskProgress, renderSharedVerificationHistory } from "../shared-feedback.ts";
import { createGraphHostBridgeHandler } from "./host-bridge-handler.ts";
import type { CairnHostEvidence } from "./host-evidence.ts";
import { IntentLeaseController } from "./intent-lease-controller.ts";
import { IntentSessionController } from "./intent-session-controller.ts";
import type { SchedulerSolverSnapshot } from "./scheduler.ts";
import { type GraphService, GraphServiceError } from "./service.ts";
import { createGraphTools } from "./solver-tools.ts";
import type { IntentLease, IntentSessionTag } from "./types.ts";

export const CAIRN_READ_INPUT_CODES = ["cairn_evidence_not_found", "cairn_record_not_found"] as const;

export interface CairnSolverOptions extends PiPlanningAdapterOptions {
	overallGoal?: string;
	executorPool?: PlanningExecutorPool;
	service: GraphService;
	evidence: CairnHostEvidence;
	runId: string;
	signal: AbortSignal;
	leaseDurationMs: number;
	onSettled(): void;
	onFailure(error: unknown): void;
	onVerified(): void;
}
interface Solver {
	id: string;
	profileId: string;
	profileFingerprint: string;
	status: SchedulerSolverSnapshot["status"];
	owner: PiCodingSessionOwner;
	cwd: string;
	lease: IntentLease;
	tag?: IntentSessionTag;
	leaseControl: IntentLeaseController;
	controller?: AbortController;
	operation?: Promise<void>;
	bundle?: PiPlanningExtensionBundle;
	releaseSlot: () => void;
	reusable: boolean;
	concluded: boolean;
	feedback: PlanningProgressFeedback;
	evidenceCursor: number;
	sharedEvidence: Array<{ evidenceId: string; intentId: string; toolName: string; isError: boolean }>;
	request?: (action: string, params: unknown, toolCallId: string) => Promise<unknown>;
}

/** Cairn lifecycle adapter, not another agent loop. Both engines call runPiCodingTask. */
export class CairnSolverAdapter {
	private readonly options: CairnSolverOptions;
	private readonly pool: PlanningExecutorPool;
	private readonly solvers = new Map<string, Solver>();
	private readonly sessions = new IntentSessionController();
	private stopped = false;
	constructor(options: CairnSolverOptions) {
		this.options = options;
		this.pool = options.executorPool ?? new PlanningExecutorPool(options.config.executionMode.capacity);
	}
	getExecutorPoolStatus(capacity: number): ReturnType<PlanningExecutorPool["getStatus"]> {
		if (!this.options.executorPool) this.pool.setCapacity(capacity);
		return this.pool.getStatus();
	}
	snapshots(): SchedulerSolverSnapshot[] {
		return [...this.solvers.values()].map((s) => ({
			id: s.id,
			challengeId: this.options.runId,
			profileId: s.profileId,
			profileFingerprint: s.profileFingerprint,
			status: s.status,
			...(s.operation ? { activeIntentId: s.lease.intentId } : {}),
			reuseReady: !s.operation && s.reusable && !!s.owner.session,
		}));
	}
	async launch(input: {
		solverId: string;
		profileId: string;
		profileFingerprint: string;
		lease: IntentLease;
		handoff: string;
	}): Promise<void> {
		this.assertRunning();
		const releaseSlot = this.pool.tryAcquire();
		if (!releaseSlot) throw new Error("Executor slots busy; retry scheduling later");
		let solver: Solver | undefined;
		try {
			this.assertRunning();
			const old = this.solvers.get(input.solverId);
			if (old && old.status !== "stopped" && old.status !== "error") throw new Error("Solver already exists");
			if (old) this.solvers.delete(input.solverId);
			const cwd = join(
				this.options.cwd,
				".planning-attempts",
				this.options.runId,
				createHash("sha256").update(input.solverId).digest("hex").slice(0, 24),
			);
			mkdirSync(cwd, { recursive: true });
			solver = {
				id: input.solverId,
				profileId: input.profileId,
				profileFingerprint: input.profileFingerprint,
				status: "starting",
				owner: new PiCodingSessionOwner(),
				cwd,
				lease: input.lease,
				releaseSlot,
				reusable: false,
				concluded: false,
				feedback: new PlanningProgressFeedback(),
				evidenceCursor: 0,
				sharedEvidence: [],
				leaseControl: new IntentLeaseController({
					leaseDurationMs: this.options.leaseDurationMs,
					heartbeatIntervalMs: Math.max(1_000, Math.floor(this.options.leaseDurationMs / 3)),
					heartbeat: async (lease) =>
						this.options.service.heartbeatIntent({
							actor: { id: lease.solverId, role: "solver", challengeId: lease.challengeId },
							idempotencyKey: "heartbeat:" + lease.solverId + ":" + Date.now(),
							intentId: lease.intentId,
							token: lease.token,
							generation: lease.generation,
							expectedVersion: lease.version,
							leaseDurationMs: this.options.leaseDurationMs,
						}),
					onRevoked: (_lease, error) => solver?.controller?.abort(error),
				}),
			};
			this.solvers.set(solver.id, solver);
			solver.bundle = this.options.createExtensionBundle?.({
				leaseId: input.solverId,
				taskId: input.lease.intentId,
				cwd,
			});
			this.bind(solver, input.lease);
			this.start(solver, input.handoff);
		} catch (error) {
			if (solver) {
				solver.leaseControl.stop();
				solver.bundle?.close();
				this.solvers.delete(solver.id);
			}
			releaseSlot();
			throw error;
		}
	}
	async reuse(input: {
		solverId: string;
		profileId: string;
		profileFingerprint: string;
		lease: IntentLease;
		context: string;
	}): Promise<void> {
		this.assertRunning();
		const solver = this.solvers.get(input.solverId);
		if (
			!solver ||
			solver.operation ||
			!solver.reusable ||
			!solver.owner.session ||
			solver.profileFingerprint !== input.profileFingerprint
		)
			throw new Error("Solver is not safely reusable");
		// A retained conversation is not a running Executor. Reacquire the common
		// slot only for the next Intent; idle Cairn sessions cannot starve progressive.
		const releaseSlot = this.pool.tryAcquire();
		if (!releaseSlot) throw new Error("Executor slots busy; retry scheduling later");
		try {
			this.assertRunning();
			const prepared = this.sessions.prepare(input.lease);
			solver.releaseSlot = releaseSlot;
			this.bind(solver, input.lease, prepared);
			this.start(solver, input.context);
		} catch (error) {
			releaseSlot();
			throw error;
		}
	}
	async bindExisting(solverId: string, lease: IntentLease): Promise<void> {
		const solver = this.solvers.get(solverId);
		if (!solver || solver.lease.intentId !== lease.intentId || solver.lease.generation !== lease.generation)
			throw new Error("Cannot rebind a different active Intent");
		solver.leaseControl.update(lease);
	}
	private bind(solver: Solver, lease: IntentLease, prepared?: IntentSessionTag): void {
		const acknowledged = this.options.service.acknowledgeIntent({
			actor: { id: solver.id, role: "solver", challengeId: lease.challengeId },
			idempotencyKey: "ack:" + lease.intentId + ":" + lease.generation,
			intentId: lease.intentId,
			token: lease.token,
			generation: lease.generation,
			expectedVersion: lease.version,
		});
		solver.lease = acknowledged;
		solver.tag = this.sessions.bind(acknowledged, prepared);
		solver.leaseControl.bind(acknowledged);
		solver.reusable = false;
		solver.concluded = false;
	}
	private assertRunning(): void {
		throwIfAborted(this.options.signal);
		if (this.stopped) throw new Error("Cairn runtime stopped");
	}
	private start(solver: Solver, context: string): void {
		solver.status = "running";
		const controller = new AbortController();
		solver.controller = controller;
		const hard =
			this.options.taskTimeoutMs === undefined ? undefined : AbortSignal.timeout(this.options.taskTimeoutMs);
		const signal = AbortSignal.any([this.options.signal, controller.signal, ...(hard ? [hard] : [])]);
		const lease = solver.lease;
		solver.feedback = new PlanningProgressFeedback();
		const tag = solver.tag;
		const handler = createGraphHostBridgeHandler(this.options.service, {
			leaseEnabled: true,
			intentSessionEnabled: true,
		});
		const emit = (type: string, payload: Record<string, unknown> = {}) =>
			this.options.evidence.event(this.options.runId, type, {
				...payload,
				taskId: solver.lease.intentId,
				leaseId: solver.lease.solverId + ":" + solver.lease.generation,
				solverId: solver.id,
			});
		const request = async (action: string, params: unknown, toolCallId: string): Promise<unknown> => {
			throwIfAborted(signal);
			const data = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
			try {
				const result = await handler.handle({
					action,
					params: ["fact_propose", "intent_propose", "fact_append_evidence", "artifact_register"].includes(action)
						? { ...data, createdAt: data.createdAt ?? new Date().toISOString() }
						: data,
					solverId: solver.id,
					requestId: toolCallId,
					toolCallId,
					intentSession: tag,
					getSolver: () => ({ id: solver.id, challengeId: this.options.runId }),
					getSolverEnvValue: () => this.options.runId,
					getSolverWorkspacePath: () => solver.cwd,
					getIntentLeaseBinding: () => solver.leaseControl.getActiveBinding(),
					updateIntentLeaseBinding: (next) => {
						solver.lease = next;
						solver.leaseControl.update(next);
					},
					isCurrentIntentSession: (current) => this.sessions.isCurrent(solver.id, current),
					stopIntentLease: () => solver.leaseControl.stop(),
					finishIntentSession: (reusable) => {
						this.sessions.finish(solver.id, reusable);
						solver.reusable = reusable;
						solver.concluded = true;
					},
				});
				if (!result.handled) throw new GraphServiceError("validation", "Unknown graph action");
				const delivery = result.data as {
					statement?: string;
					evidenceRefs?: string[];
					id?: string;
					resultFactIds?: string[];
				};
				if (action === "fact_propose" && delivery.statement)
					this.options.evidence.publishFactCard(solver.lease, {
						statement: delivery.statement,
						evidenceRefs: delivery.evidenceRefs ?? [],
						id: delivery.id,
					});
				if (action === "intent_checkpoint" || action === "intent_conclude" || action === "fact_append_evidence") {
					const graph = this.options.service.readSchedulerState(this.options.runId).graph;
					for (const fact of graph.facts.filter(
						(fact) => (delivery.resultFactIds ?? []).includes(fact.id) || fact.id === data.factId,
					))
						this.options.evidence.publishFactCard(solver.lease, fact);
				}
				if (action === "intent_conclude" || action === "intent_checkpoint")
					emit("cairn_submission_durable", { durable: true, partial: action === "intent_checkpoint" });
				return result.data;
			} catch (error) {
				if (error instanceof GraphServiceError && error.type !== "internal") throw error;
				const failure = new PlanningPersistenceError("Cairn durable handoff failed", error);
				controller.abort(failure);
				this.options.onFailure(failure);
				throw failure;
			}
		};
		solver.request = request;
		const tools = createGraphTools((action, params, callId) => {
			if (!solver.request) throw new Error("Solver has no current Intent");
			return solver.request(action, params, callId);
		});
		const evidenceTools: InlineExtension = {
			name: "cairn-evidence",
			hidden: true,
			factory: (pi) => {
				const response = (data: unknown): AgentToolResult<unknown> => ({
					content: [{ type: "text", text: JSON.stringify(data) }],
					details: data,
				});
				pi.on("tool_result", (event) => {
					if (!["graph_read_evidence", "graph_query_record"].includes(event.toolName)) return;
					const details = event.details as { reasonCode?: string } | undefined;
					if (CAIRN_READ_INPUT_CODES.some((code) => code === details?.reasonCode)) {
						emit("executor_tool_input_rejected", {
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							reasonCode: details?.reasonCode,
							fieldPaths: event.toolName === "graph_read_evidence" ? ["evidenceId"] : ["id"],
						});
						return { isError: true };
					}
				});
				pi.registerTool({
					name: "graph_list_evidence",
					label: "List evidence",
					description: "Page all host-saved tool evidence in this run, across intents.",
					parameters: Type.Object({
						cursor: Type.Optional(Type.Integer({ minimum: 0 })),
						limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
					}),
					execute: async (_id, args) =>
						response(this.options.evidence.list(this.options.runId, args.cursor, args.limit)),
				});
				pi.registerTool({
					name: "graph_read_evidence",
					label: "Read evidence",
					description: "Read exact host tool output in this run. Use nextOffset for large content.",
					parameters: Type.Object({
						evidenceId: Type.String(),
						offset: Type.Optional(Type.Integer({ minimum: 0 })),
						maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 65536 })),
					}),
					execute: async (_id, args) => {
						const evidence = this.options.evidence.read(this.options.runId, args.evidenceId);
						if (!evidence)
							return {
								...response({
									status: "not_found",
									reasonCode: "cairn_evidence_not_found",
									fieldPaths: ["evidenceId"],
									retryable: true,
									message: "Use a complete evidenceId returned by graph_list_evidence in this run.",
									validEvidenceIds: this.options.evidence
										.list(this.options.runId, 0, 10)
										.items.map((item) => item.evidenceId),
									nextTool: { name: "graph_list_evidence", arguments: { limit: 10 } },
								}),
							};
						const start = args.offset ?? 0,
							end = Math.min(evidence.content.length, start + (args.maxChars ?? 16000));
						return response({
							...evidence,
							content: evidence.content.slice(start, end),
							nextOffset: end,
							complete: end >= evidence.content.length,
						});
					},
				});
				pi.registerTool({
					name: "graph_query_record",
					label: "Read full graph record",
					description:
						"Read an original fact, hint or intent from this run without overview truncation. No arbitrary file access.",
					parameters: Type.Object({
						section: Type.Union([Type.Literal("facts"), Type.Literal("hints"), Type.Literal("intents")]),
						id: Type.String(),
						offset: Type.Optional(Type.Integer({ minimum: 0 })),
						limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 4096 })),
					}),
					execute: async (_id, args) => {
						const graph = this.options.service.readSchedulerState(this.options.runId).graph;
						const record = graph[args.section].find((item) => item.id === args.id);
						if (!record)
							return {
								...response({
									status: "not_found",
									reasonCode: "cairn_record_not_found",
									fieldPaths: ["id"],
									retryable: true,
									message: "Use a complete record ID from graph_get_context for the requested section.",
									section: args.section,
									validRecordIds: graph[args.section].slice(-10).map((item) => item.id),
									nextTool: { name: "graph_get_context", arguments: {} },
								}),
							};
						const text = JSON.stringify(record);
						const offset = args.offset ?? 0;
						return response({
							id: args.id,
							section: args.section,
							offset,
							totalChars: text.length,
							content: text.slice(offset, offset + (args.limit ?? 4096)),
						});
					},
				});
				pi.on("tool_call", () => {
					if (
						!this.sessions.isCurrent(solver.id, solver.tag) ||
						solver.controller?.signal.aborted ||
						this.options.signal.aborted
					)
						return { block: true, reason: "This Intent session has ended or was cancelled." };
				});
				pi.on("context", (event) => {
					// The extension survives session reuse: always read the current owner,
					// never the lease/feedback captured by its first Intent.
					const page = this.options.evidence.list(this.options.runId, solver.evidenceCursor, 64);
					solver.evidenceCursor = page.nextCursor;
					for (const item of page.items) {
						if (item.intentId !== solver.lease.intentId) solver.sharedEvidence.push(item);
					}
					solver.sharedEvidence = solver.sharedEvidence.slice(-16);
					const history = this.options.evidence.verificationHistory(this.options.runId);
					const taskProgress = renderSharedTaskProgress(
						this.options.evidence.cards(this.options.runId),
						solver.lease.intentId,
						this.options.config.planning.maxEvidenceBytes,
					);
					emit("planning_feedback_presented", {
						verificationHistoryCount: history.length,
						feedbackActive: Boolean(solver.feedback.context() || taskProgress),
					});
					const feedback = [
						solver.feedback.context(),
						taskProgress,
						renderSharedVerificationHistory(history),
						...(this.options.runObserver?.takeReminders(solver.id) ?? []),
						...(solver.sharedEvidence.length
							? [
									`[Shared host evidence references] ${JSON.stringify(solver.sharedEvidence)}. Read relevant saved results with graph_read_evidence before repeating work. These references are observations, not proof of goal completion.`,
								]
							: []),
					]
						.filter(Boolean)
						.join("\n");
					return feedback
						? {
								messages: [
									// Preserve the current task/tool-result position in Pi's
									// transcript, including after session reuse.
									{ role: "user" as const, content: feedback, timestamp: Date.now() },
									...event.messages,
								],
							}
						: undefined;
				});
			},
		};
		emit("cairn_executor_start");
		let pending: Promise<void> | undefined;
		// Scheduling starts another Solver without waiting for this model turn.
		solver.operation = (async () => {
			await this.options.beforeDispatch?.(signal);
			try {
				await runPiCodingTask({
					beforeModelRequest: this.options.beforeDispatch,
					executionIdentity: {
						runId: this.options.runId,
						taskId: solver.lease.intentId,
						leaseId: solver.lease.solverId + ":" + solver.lease.generation,
					},
					config: this.options.config,
					cwd: solver.cwd,
					model: this.options.model,
					modelRuntime: this.options.modelRuntime,
					onModelTurn: (cost, message) => {
						this.options.onModelTurn?.(cost);
						this.options.runObserver?.recordTurn(solver.id, {
							intentId: solver.lease.intentId,
							at: Date.now(),
							message,
							sharedEvidence: solver.sharedEvidence,
						});
					},
					thinkingLevel: this.options.thinkingLevel,
					images: this.options.images,
					signal,
					sessionOwner: solver.owner,
					backgroundTasks: solver.bundle?.backgroundTasks,
					task:
						(() => {
							const focused = this.options.service.getIntentFocusedContext(
								this.options.runId,
								solver.lease.intentId,
							);
							const intent = focused.intents.find((item) => item.id === solver.lease.intentId);
							return intent
								? renderPlanningHandoff(cairnHandoff(focused, intent, this.options.overallGoal)) +
										"\n\n" +
										context
								: context;
						})() +
						"\n\nShared challenge root: " +
						this.options.cwd +
						"\nUse graph_get_context for focused context, graph_list_evidence/graph_read_evidence for any same-run tool result." +
						(this.options.sourceBindings
							? "\nBind exact parameters, source versions and dynamic values using planning_bind_observation on the original evidence JSON pointer. Preserve bindingId, literal value and evidenceId when another intent inherits them. A tool execution error does not disprove the underlying hypothesis."
							: "") +
						"\nSave meaningful progress with checkpoint_intent. Finish with conclude_intent; intent success is not verified challenge success." +
						"\nCheckpoint before launching slow/background work, after an independently supported observation or repeated tool error, and when another executor can use your result. Keep working after a checkpoint. Tool errors require request repair, not repeated unchanged calls." +
						"\nFacts are Executor reports, not independently verified conclusions. Preserve uncertainty. Use planning_publish_evidence_card for useful findings with exact keyValues, scope, limitations and original evidenceRefs; aim for 30–50 character summaries and distinguish observed/inferred. Read shared cards with planning_list_evidence_cards.",
					excludedTools: [
						"plan_expand",
						"plan_revise",
						"plan_status",
						"competition_set_plan",
						"sub_agent",
						"competition_dispatch_solver",
						"planning_commit_result",
						"planning_checkpoint",
						"planning_list_evidence",
						"planning_read_evidence",
					],
					extensionFactories: [
						...(this.options.sourceBindings ? [this.options.sourceBindings.extension()] : []),
						...(solver.bundle?.extensionFactories ?? this.options.extensionFactories ?? []),
						tools,
						evidenceTools,
						evidenceCardExtension({
							publish: (card) => this.options.evidence.publishCard(solver.lease, card),
							list: (after, limit) => this.options.evidence.listCards(this.options.runId, after, limit),
						}),
					],
					requiredToolName: "conclude_intent",
					requiredToolRecoveryAttempts: 2,
					continueUntilRequiredTool: true,
					handoffOnRequiredTool: true,
					isRequiredToolComplete: () =>
						solver.concluded || this.options.evidence.proof(this.options.runId) !== undefined,
					propagateToolExecutionObserverErrors: true,
					onPendingSettlement: (settlement) => {
						pending = settlement;
					},
					onLifecycleEvent: (type, payload) => emit("cairn_" + type, payload),
					onToolExecution: (execution) => {
						if (
							[
								"planning_publish_evidence_card",
								"planning_list_evidence_cards",
								"graph_get_context",
								"graph_list_evidence",
								"graph_read_evidence",
								"graph_query_record",
								"fact_propose",
								"intent_propose",
								"fact_append_evidence",
								"artifact_register",
								"checkpoint_intent",
								"conclude_intent",
								"release_intent",
							].includes(execution.toolName)
						)
							return;
						try {
							const evidence = this.options.evidence.save(lease, execution);
							emit("cairn_evidence_saved", {
								evidenceId: evidence.evidenceId,
								toolName: execution.toolName,
								isError: execution.isError,
							});
							// Persist first, then derive success from the shared canonical native verifier gate.
							if (this.options.evidence.proof(this.options.runId)) this.options.onVerified();
							const resultRecord =
								typeof execution.result === "object" && execution.result !== null
									? (execution.result as Record<string, unknown>)
									: {};
							const details =
								typeof resultRecord.details === "object" && resultRecord.details !== null
									? (resultRecord.details as Record<string, unknown>)
									: {};
							const data =
								typeof details.data === "object" && details.data !== null
									? (details.data as Record<string, unknown>)
									: {};
							const feedback = solver.feedback.observe({
								...execution,
								evidenceId: evidence.evidenceId,
								...(typeof data.status === "string" ? { verifierStatus: data.status } : {}),
							});
							if (
								!signal.aborted &&
								!solver.concluded &&
								this.sessions.isCurrent(solver.id, solver.tag) &&
								feedback
							) {
								const binding = solver.leaseControl.getActiveBinding();
								if (binding) {
									const result = this.options.service.checkpointIntent({
										actor: { id: binding.solverId, role: "solver", challengeId: binding.challengeId },
										idempotencyKey: `host-progress:${execution.toolCallId}:${evidence.evidenceId}`,
										intentId: binding.intentId,
										token: binding.token,
										generation: binding.generation,
										expectedVersion: binding.version,
										facts: [
											{
												kind: feedback.rejectedDirections?.length ? "failure_boundary" : "evidence",
												statement:
													execution.toolName === "update_working_checkpoint"
														? "Executor checkpoint report (unverified): " +
															JSON.stringify(execution.toolInput ?? {}).slice(0, 2_000)
														: feedback.summary,
												evidenceRefs: [evidence.evidenceId],
											},
										],
									});
									solver.lease = { ...binding, version: result.version };
									solver.leaseControl.update(solver.lease);
									emit("cairn_submission_durable", {
										durable: true,
										partial: true,
										source: "host_progress",
										evidenceId: evidence.evidenceId,
									});
								}
							}
						} catch (error) {
							throw new PlanningPersistenceError("Cairn tool evidence persistence failed", error);
						}
					},
				});
				if (!solver.concluded && !this.options.evidence.proof(this.options.runId))
					throw new Error("Solver ended without durable Intent conclusion");
			} catch (error) {
				solver.reusable = false;
				const expectedCancellation =
					signal.aborted &&
					!(error instanceof PlanningPersistenceError) &&
					!isVerifierInfrastructureFailure(error);
				emit(expectedCancellation && !hard?.aborted ? "cairn_executor_cancelled" : "cairn_executor_error", {
					failureCode: this.options.signal.aborted
						? "cancelled"
						: hard?.aborted
							? "executor_timeout"
							: expectedCancellation
								? "cancelled"
								: "executor_error",
				});
				if (isVerifierInfrastructureFailure(error) && error.failureCategory === "quota_exhausted")
					this.options.onFailure(verifierPlanningFailure(error, this.options.runId));
				if (error instanceof PlanningPersistenceError) this.options.onFailure(error);
				if (error instanceof PlanningFailureError && error.code === "model_invalid_request")
					this.options.onFailure(error);
				if (!this.options.signal.aborted && !controller.signal.aborted && !solver.concluded) {
					const binding = solver.leaseControl.getActiveBinding();
					if (binding) {
						try {
							this.options.service.concludeIntent({
								actor: { id: solver.id, role: "solver", challengeId: binding.challengeId },
								idempotencyKey: "runtime-failure:" + binding.intentId + ":" + binding.generation,
								intentId: binding.intentId,
								token: binding.token,
								generation: binding.generation,
								expectedVersion: binding.version,
								outcome: "failure",
								facts: [
									{
										kind: "failure_boundary",
										statement: hard?.aborted
											? "Executor timed out; inspect saved tool evidence before repeating."
											: "Executor ended without a durable final report; inspect saved tool evidence.",
									},
								],
							});
							emit("cairn_submission_durable", { durable: true, partial: true, status: "runtime_failure" });
						} catch (failure) {
							if (!(failure instanceof GraphServiceError))
								this.options.onFailure(new PlanningPersistenceError("Cairn failure handoff failed", failure));
						}
					}
				}
			} finally {
				solver.leaseControl.stop();
				if (pending) {
					solver.status = "stopping";
					await pending.catch(() => undefined);
				}
				solver.operation = undefined;
				solver.releaseSlot();
				if (!solver.reusable || this.stopped || this.options.signal.aborted) this.dispose(solver);
				emit("cairn_executor_end");
				this.options.onSettled();
			}
		})();
		void solver.operation.catch((error) => this.options.onFailure(error));
	}
	private dispose(solver: Solver): void {
		solver.owner.dispose();
		solver.bundle?.close();
		solver.bundle = undefined;
		solver.status = "stopped";
		solver.reusable = false;
		solver.releaseSlot();
	}
	async stop(solverId: string): Promise<void> {
		const solver = this.solvers.get(solverId);
		if (!solver) return;
		solver.controller?.abort(new Error("Cairn Solver stopped"));
		if (solver.operation) await solver.operation;
		else this.dispose(solver);
	}
	async close(): Promise<void> {
		this.stopped = true;
		await Promise.all([...this.solvers.keys()].map((id) => this.stop(id)));
	}
	async trimIdle(capacity: number): Promise<void> {
		const active = this.snapshots().filter((s) => ["starting", "running", "stopping"].includes(s.status));
		let extra = Math.max(0, active.length - capacity);
		if (this.pool.getStatus().waiting > 0) extra = active.length;
		for (const solver of active) {
			if (extra <= 0) break;
			if (!solver.activeIntentId) {
				await this.stop(solver.id);
				extra--;
			}
		}
	}
}
